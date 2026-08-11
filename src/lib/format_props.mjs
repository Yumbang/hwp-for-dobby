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
  lineSpacing: INT("percent — 200 is double spacing"),
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
const INEFFECTIVE = Object.freeze({
  fontFamily:
    "the engine accepts it but does not apply it — a font must be registered " +
    "through its font-id API first, which applyCharFormat does not do",
  lineSpacingType: "the engine accepts it but does not apply it; lineSpacing alone works",
  charSpacing: "not applied by applyCharFormat on this engine version",
  charWidth: "not applied by applyCharFormat on this engine version",
  bgColor: "not applied by applyCharFormat on this engine version",
  underlineType: "not applied by applyCharFormat on this engine version; `underline` works",
  shadow: "not applied by applyCharFormat on this engine version",
  outline: "not applied by applyCharFormat on this engine version",
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
