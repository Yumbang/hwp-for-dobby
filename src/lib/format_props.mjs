// What `format.mjs --props` may contain, and why it has to be checked here.
//
// THE PROBLEM. applyCharFormat / applyParaFormat are completely permissive:
// every one of these returns {"ok":true} and changes nothing at all —
//
//   {"boldd": true}          a typo'd key
//   {"BOLD": true}           the right key, wrong case
//   {"fontFamily": "굴림"}    a real key the engine does not act on (see below)
//   {"alignment": "banana"}  a real key, invalid enum value
//   {"bold": "yes"}          a real key, wrong type
//   {"fontSize": "big"}      a real key, wrong type
//
// So the engine cannot be asked whether a request made sense. Without a check
// on our side, `format.mjs` reported `ok:true, verified:true` for a document it
// had not changed in any way — the caller's formatting silently did not happen,
// and every signal said it did. That is the same class of failure as the memo
// guard and the equation probe: not a crash, an untrue success.
//
// THE CHECK. Every key below was verified empirically on the pinned engine
// (0.7.19) by applying it alone to a blank document and reading the value back
// through getCharPropertiesAt / getParaPropertiesAt after an export→reload.
// A key is listed ONLY if that round trip actually moved the value.
//
// KEYS THAT LOOK SUPPORTED AND ARE NOT. `fontFamily` is the trap: it is a real
// field in the getter's output, it is accepted with ok:true, and it does
// nothing — a font has to be registered through the engine's font-id APIs
// first, which applyCharFormat does not do. The previous version of this file's
// documentation listed fontFamily as supported. It is called out by name below
// so the error explains the situation instead of just saying "unknown key".
//
// 2026-08-27 CORRECTION. The INEFFECTIVE list below was wrong in six of seven
// entries, and the two mistakes had opposite shapes:
//
//   (a) WRONG KEY NAME, not an unsupported feature. charSpacing / charWidth /
//       bgColor / shadow / outline are not keys the engine has at all. The
//       real names are `spacings` / `ratios` / `shadeColor` / `shadowType` /
//       `outlineType`, and every one of those DOES move the value through an
//       export→reload. They are named in the redirect table below so the error
//       points at the working key instead of calling the feature unsupported.
//       They are deliberately NOT in the tables yet — adding them is an
//       expansion, and this pass is a correction.
//
//   (b) FLATLY MISJUDGED. `lineSpacingType` and `underlineType` work. They were
//       tested with values the engine does not accept ("Solid", "AtLeast"),
//       which it ignores silently, and the no-op was read as "not supported".
//       Both are now in the tables with their real enums. This mattered:
//       format.mjs was refusing two working properties with a USAGE error.
//
// Only the `fontFamily` entry was correct — and even that is narrower than it
// read. applyCharFormat cannot set a font, but `applyStyle` carries the font of
// the style it applies, so a font CAN be changed by adopting a style the
// document already has. See spec rule 60.
//
// ESCAPE HATCH. The engine is a moving third-party target and a later version
// will support keys this table does not know. `--allow-unknown-props` passes
// anything through with a warning, so this list can never become a ceiling.

// Value kinds. `enum` carries its own allowed values; `color` is strictly
// #RRGGBB (verified: "FF0000", "#F00" and "red" are all silently ignored);
// `int` accepts negatives, because a hanging indent is a negative indent and
// real Korean documents use them.
const BOOL = { type: "boolean" };
const INT = (unit) => ({ type: "integer", unit });
const COLOR = { type: "color" };

export const CHAR_PROPS = Object.freeze({
  bold: BOOL,
  italic: BOOL,
  underline: BOOL,
  // Verified: "Bottom" and "Top" persist; "None" clears. Anything else —
  // "Solid", "Single", "Center" — is silently ignored and reads back "None",
  // which is how this key was previously mistaken for unsupported.
  underlineType: {
    type: "enum",
    values: ["None", "Bottom", "Top"],
  },
  strikethrough: BOOL,
  superscript: BOOL,
  subscript: BOOL,
  emboss: BOOL,
  engrave: BOOL,
  fontSize: INT("HWPUNIT, 100 = 1pt — 1400 is 14pt"),
  textColor: COLOR,
});

export const PARA_PROPS = Object.freeze({
  alignment: {
    type: "enum",
    values: ["left", "center", "right", "justify", "distribute"],
  },
  // THE UNIT DEPENDS ON lineSpacingType, which is why they sit together.
  //   Percent (the default, and the only value seen in 6,918 real paragraphs):
  //     a percentage — 200 is double spacing.
  //   Fixed: HWPUNIT — 2400 reads back as 16pt.
  // Sending lineSpacing alone keeps whatever type the paragraph already has.
  lineSpacing: INT("percent under lineSpacingType 'Percent' (default), HWPUNIT under 'Fixed'"),
  // Verified: "Fixed" and "Percent" persist. "AtLeast" and "BetweenLines" are
  // accepted and silently fall back to "Percent" — testing with those is how
  // this key was previously mistaken for unsupported.
  lineSpacingType: {
    type: "enum",
    values: ["Percent", "Fixed"],
  },
  marginLeft: INT("HWPUNIT, 1/7200 inch"),
  marginRight: INT("HWPUNIT, 1/7200 inch"),
  indent: INT("HWPUNIT — negative for a hanging indent"),
  spacingBefore: INT("HWPUNIT"),
  spacingAfter: INT("HWPUNIT"),
  keepWithNext: BOOL,
  pageBreakBefore: BOOL,
  widowOrphan: BOOL,
  keepLines: BOOL,
});

// Keys the engine accepts and ignores. Naming them turns a baffling silent
// no-op into an explanation.
//
// Kept deliberately SHORT. A key belongs here only if the engine really does
// nothing with it under any spelling — see the 2026-08-27 correction above for
// the six entries that were removed because the feature works under a
// different name or a different value vocabulary.
const INEFFECTIVE = Object.freeze({
  fontFamily:
    "applyCharFormat cannot set a font — registering it with the font-id API " +
    "first does not help, and neither does createStyle. A font CAN be changed " +
    "by applying a style the document already carries (`applyStyle`), which is " +
    "the only working route",
  fontFamilies: "same as fontFamily — applyCharFormat does not set fonts",
  charShapeId: "read-only in practice; setCharShapeId is a no-op at every id",
  paraShapeId: "not settable through applyParaFormat; use setParaShapeId",
});

// Keys that name a real FEATURE under the wrong NAME. The feature works; the
// spelling does not. Redirecting is far more useful than "unknown key", and
// these were all in INEFFECTIVE until 2026-08-27 mislabelled as unsupported.
//
// The targets are not in CHAR_PROPS/PARA_PROPS yet — documenting them is an
// expansion, and this table is the correction. --allow-unknown-props sends
// them through in the meantime, which is why the message says so.
const RENAMED = Object.freeze({
  charSpacing: ["spacings", "an array of 7 per-language values (한글/라틴/한자/일어/기타/기호/사용자)"],
  charWidth: ["ratios", "an array of 7 per-language values"],
  bgColor: ["shadeColor", 'a "#RRGGBB" color'],
  shadow: ["shadowType", "an integer (0 = none)"],
  outline: ["outlineType", "an integer (0 = none)"],
});

export function propsFor(op) {
  return op === "char" ? CHAR_PROPS : PARA_PROPS;
}

// Levenshtein, small and bounded — only ever run over a handful of short keys.
function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n];
}

// The nearest known key, when one is close enough to be worth suggesting.
// Case-insensitive first, because "BOLD" and "Bold" are the commonest slip and
// their edit distance from "bold" is large relative to the word.
export function suggestKey(key, known) {
  const lower = String(key).toLowerCase();
  const ci = known.find((k) => k.toLowerCase() === lower);
  if (ci) return ci;
  let best = null;
  let bestD = Infinity;
  for (const k of known) {
    const d = editDistance(lower, k.toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  // Only suggest a genuinely close match; an unrelated word is noise.
  return bestD <= Math.max(2, Math.floor(key.length / 3)) ? best : null;
}

const isInt = (v) => typeof v === "number" && Number.isInteger(v);
const isColor = (v) => typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);

// Validate a --props object against the table for `op`.
// Returns { errors: string[], warnings: string[] } and never throws or exits —
// the caller decides the exit code, which is what makes this unit-testable.
export function validateProps(op, props, { allowUnknown = false } = {}) {
  const errors = [];
  const warnings = [];
  const spec = propsFor(op);
  const known = Object.keys(spec);

  const keys = Object.keys(props);
  if (keys.length === 0) {
    errors.push(
      `--props is empty; nothing would be applied. Pass at least one key, e.g. ` +
        (op === "char" ? `'{"bold":true}'` : `'{"alignment":"center"}'`),
    );
  }

  for (const key of keys) {
    const s = spec[key];

    if (!s) {
      // Is it a key the OTHER op supports? That is a common and confusing slip.
      const otherOp = op === "char" ? "para" : "char";
      const inOther = Object.prototype.hasOwnProperty.call(propsFor(otherOp), key);
      if (inOther) {
        errors.push(
          `"${key}" is a --op ${otherOp} property, not --op ${op}. ` +
            `Re-run with --op ${otherOp}.`,
        );
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(INEFFECTIVE, key)) {
        errors.push(
          `"${key}" has NO EFFECT on engine 0.7.19 — ${INEFFECTIVE[key]}. ` +
            `The engine would still report success. Remove it, or pass ` +
            `--allow-unknown-props to send it anyway.`,
        );
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(RENAMED, key)) {
        const [real, shape] = RENAMED[key];
        errors.push(
          `"${key}" is not a key this engine has — the working key is ` +
            `"${real}" (${shape}). It is not validated here yet, so send it ` +
            `with --allow-unknown-props and check the result.`,
        );
        continue;
      }
      if (allowUnknown) {
        warnings.push(
          `"${key}" is not a known --op ${op} property; sending it anyway ` +
            `(--allow-unknown-props). The engine reports success for unknown keys, ` +
            `so check the result yourself.`,
        );
        continue;
      }
      const hint = suggestKey(key, known);
      errors.push(
        `unknown --op ${op} property "${key}"${hint ? ` — did you mean "${hint}"?` : ""}\n` +
          `       valid keys: ${known.join(", ")}\n` +
          `       (the engine silently accepts unknown keys and applies nothing, ` +
          `which is why this is refused here. Override: --allow-unknown-props)`,
      );
      continue;
    }

    const v = props[key];
    if (s.type === "boolean" && typeof v !== "boolean") {
      errors.push(
        `"${key}" must be true or false, got ${JSON.stringify(v)}. ` +
          `The engine ignores a non-boolean here and still reports success.`,
      );
    } else if (s.type === "integer" && !isInt(v)) {
      errors.push(
        `"${key}" must be an integer (${s.unit}), got ${JSON.stringify(v)}. ` +
          `The engine ignores a non-integer here and still reports success.`,
      );
    } else if (s.type === "color" && !isColor(v)) {
      errors.push(
        `"${key}" must be a "#RRGGBB" color, got ${JSON.stringify(v)}. ` +
          `Short forms ("#F00"), names ("red") and missing "#" are silently ignored ` +
          `by the engine.`,
      );
    } else if (s.type === "enum" && !s.values.includes(v)) {
      const hint = typeof v === "string" ? suggestKey(v, s.values) : null;
      errors.push(
        `"${key}" must be one of ${s.values.map((x) => `"${x}"`).join(", ")}, ` +
          `got ${JSON.stringify(v)}${hint ? ` — did you mean "${hint}"?` : ""}. ` +
          `Values are case-sensitive, and the engine ignores an invalid one.`,
      );
    }
  }

  return { errors, warnings };
}

// After the edit is saved and reloaded: did each requested key actually take?
// `before` / `after` are the shape-getter objects from before the apply and
// after the reload. Returns one verdict per key:
//
//   "changed"     the value moved — applied, beyond doubt
//   "already-set" it did not move, but it already equals what was asked for
//   "no-effect"   it did not move and does not match the request
//
// Numeric values are reported as "unverifiable" rather than "no-effect" when
// unchanged, because the engine converts units on the way in (marginLeft 2000
// HWPUNIT reads back as 13.3pt), so re-applying a value a paragraph already has
// is indistinguishable from a value that was ignored. Booleans, colors and
// enums round-trip comparably and get a real verdict.
export function classifyEffect(key, requested, before, after) {
  const b = before?.[key];
  const a = after?.[key];
  if (a === undefined) return "unexposed"; // getter does not surface this key
  if (JSON.stringify(b) !== JSON.stringify(a)) return "changed";

  if (typeof requested === "boolean") return requested === a ? "already-set" : "no-effect";
  if (typeof requested === "string" && typeof a === "string") {
    return requested.toLowerCase() === a.toLowerCase() ? "already-set" : "no-effect";
  }
  if (typeof requested === "number") {
    return requested === a ? "already-set" : "unverifiable";
  }
  return "unverifiable";
}
