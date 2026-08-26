// What a picture-property edit may contain, and why it has to be checked here.
//
// THE PROBLEM, and it is the one `format_props.mjs` already solved for text.
// setPictureProperties is completely permissive: every one of these returns
// {"ok":true} and changes nothing at all —
//
//   {"widht": 12000}              a typo'd key
//   {"WIDTH": 12000}              the right key, wrong case
//   {"originalWidth": 15000}      a real key the engine does not act on
//   {"textWrap": "banana"}        a real key, invalid enum value
//   {"treatAsChar": "true"}       a real key, wrong type
//   {"borderColor": "#FF0000"}    the color spelling the CHAR table taught you
//   {"captionDirection": "Top"}   a real key, applied only in the right company
//   {}                            nothing at all
//
// So the engine cannot be asked whether a request made sense. Without a check
// on our side an image edit reports `ok:true, verified:true` for a document it
// did not touch — the caller's layout fix silently did not happen and every
// signal said it did.
//
// Pictures make that worse than text does, because the DEFAULT is wrong. A
// freshly inserted picture is floating, `vertRelTo`/`horzRelTo` = "Paper",
// offsets 0 — pinned to the paper corner, on top of whatever is there. The
// whole point of this table is the edit that repairs that, so an edit that
// quietly does nothing leaves the document broken in the exact way the caller
// was trying to fix.
//
// THE CHECK. Every key below was verified empirically on the pinned engine
// (0.7.19): applied ALONE to a document holding one inserted picture, then read
// back through getPictureProperties after an export→reload. A key is listed
// ONLY if that round trip actually moved the value. In-memory agreement was not
// enough — see `textWrap` below, where it lies.
//
// FIVE TRAPS THIS TABLE EXISTS TO NAME.
//
//  1. `borderColor` is an INTEGER here, not "#RRGGBB". The char table taught
//     "#RRGGBB" (textColor) and this is the same word "color" behaving the
//     opposite way: "#FF0000" and "255" are both accepted-and-ignored, and the
//     number is written into the file verbatim as HWP's color word.
//  2. `textWrap: "Tight"` and `"Through"` are accepted, read back correctly in
//     memory, and are SILENTLY DOWNGRADED TO "Square" by the .hwp save. That is
//     rule 1 of CLAUDE.md in miniature, and it is why the vocabulary below is
//     the post-round-trip vocabulary, not the one the engine's enum accepts.
//  3. An invalid `effect` value does not get ignored — it RESETS the property
//     to "RealPic". So `{"effect":"grayScale"}` (wrong case) does not leave a
//     grayscale picture alone; it turns grayscale off.
//  4. The caption sub-keys only apply in a call that ALSO carries
//     `hasCaption: true`. The engine builds the caption block on that call and
//     ignores caption keys on every other one, ok:true throughout. Setting the
//     caption up and then adjusting its direction in a second call — the
//     obvious way to write it — changes nothing.
//  5. `brightness`/`contrast` live in a signed byte and WRAP (500 → -12);
//     `transparency` is a clamped percent (255 → 100). Both mean the picture
//     ends up with a value nobody asked for, so their ranges are enforced.
//
// ESCAPE HATCH. The engine is a moving third-party target and a later version
// will support keys this table does not know. `--allow-unknown-props` passes
// anything through with a warning, so this list can never become a ceiling.

// The nearest-match search is shared with the char/para table on purpose: two
// property tables that suggest corrections differently would be two things to
// learn instead of one.
import { suggestKey } from "./format_props.mjs";

// Value kinds. `color` is an INTEGER color word (trap 1); `int` accepts
// negatives, because offsets and rotation legitimately go both ways — the keys
// that genuinely cannot take a negative carry a range instead.
const BOOL = { type: "boolean" };
const INT = (unit) => ({ type: "integer", unit });
// MEASURED: `{"borderColor": 0x123456}` lands in the section stream as the
// bytes 56 34 12 00 — the number is the file's color word, untouched. The
// 0x00BBGGRR reading of that word is HWP5's documented convention, not
// something this repo has rendered and looked at.
const COLOR = {
  type: "color",
  unit: "integer color word — 0 is black, 255 is red (HWP stores 0x00BBGGRR)",
};
const STR = (unit) => ({ type: "string", unit });
const ENUM = (values, unit) => ({ type: "enum", values, unit });

const HU = "HWPUNIT, 1/7200 inch";

export const PICTURE_PROPS = Object.freeze({
  // ── layout: the reason this module exists ────────────────────────────────
  treatAsChar: BOOL, // true = inline with the text; false = floating
  vertRelTo: ENUM(["Paper", "Page", "Para"], "what vertOffset is measured from"),
  horzRelTo: ENUM(["Paper", "Page", "Column", "Para"], "what horzOffset is measured from"),
  vertAlign: ENUM(["Top", "Center", "Bottom"]),
  horzAlign: ENUM(["Left", "Center", "Right"]),
  vertOffset: INT(`${HU} — may be negative`),
  horzOffset: INT(`${HU} — may be negative`),
  textWrap: ENUM(
    ["Square", "TopAndBottom", "BehindText", "InFrontOfText"],
    '"Tight" and "Through" are accepted in memory and lost on save',
  ),
  restrictInPage: BOOL,
  allowOverlap: BOOL,
  sizeProtect: BOOL,

  // ── size, crop, spacing ──────────────────────────────────────────────────
  // Sent and read back in the SAME unit: 12000 in, 12000 out. Nothing here is
  // unit-converted the way paragraph margins are (marginLeft 2000 → 13.3).
  width: { type: "integer", unit: `${HU} — NOT pixels; must be >= 0` },
  height: { type: "integer", unit: `${HU} — NOT pixels; must be >= 0` },
  cropLeft: INT(HU),
  cropTop: INT(HU),
  cropRight: INT(HU),
  cropBottom: INT(HU),
  paddingLeft: INT(`${HU} — inside the picture frame`),
  paddingTop: INT(`${HU} — inside the picture frame`),
  paddingRight: INT(`${HU} — inside the picture frame`),
  paddingBottom: INT(`${HU} — inside the picture frame`),
  outerMarginLeft: INT(`${HU} — outside the picture frame`),
  outerMarginTop: INT(`${HU} — outside the picture frame`),
  outerMarginRight: INT(`${HU} — outside the picture frame`),
  outerMarginBottom: INT(`${HU} — outside the picture frame`),

  // ── appearance ───────────────────────────────────────────────────────────
  brightness: INT("-128..127 — the engine WRAPS out-of-range values"),
  contrast: INT("-128..127 — the engine WRAPS out-of-range values"),
  transparency: INT("percent, 0..100 — the engine CLAMPS out-of-range values"),
  effect: ENUM(
    ["RealPic", "GrayScale", "BlackWhite", "Pattern8x8"],
    "an invalid value RESETS this to RealPic instead of being ignored",
  ),
  horzFlip: BOOL,
  vertFlip: BOOL,
  rotationAngle: INT(
    "degrees, -32768..32767 — ALSO rewrites width/height/vertOffset/horzOffset, " +
      "last, whatever the key order (the engine recomputes the rotated bounding box)",
  ),
  borderColor: COLOR,
  borderWidth: INT(`${HU} — 0 is no border`),
  description: STR("그림 설명 / alt text"),

  // ── caption ──────────────────────────────────────────────────────────────
  // Everything below hasCaption is applied ONLY in a call that also sets
  // hasCaption: true (trap 4). validatePictureProps enforces that, so the
  // inert path is unreachable from the CLI.
  hasCaption: BOOL,
  captionDirection: ENUM(["Left", "Right", "Top", "Bottom"], "which side of the picture"),
  captionVertAlign: ENUM(["Top", "Center", "Bottom"]),
  captionWidth: INT(HU),
  captionSpacing: INT(`${HU} — gap between picture and caption`),
  captionIncludeMargin: BOOL,
});

// The keys that need `hasCaption: true` in the same object to have any effect.
// Exported because the caller reporting per-key effects needs to know that a
// "no-effect" verdict here means "you forgot the companion key", not "the
// engine is broken".
export const CAPTION_PROPS = Object.freeze([
  "captionDirection",
  "captionVertAlign",
  "captionWidth",
  "captionSpacing",
  "captionIncludeMargin",
]);

// Keys the engine accepts and ignores. Naming them turns a baffling silent
// no-op into an explanation — the picture equivalent of `fontFamily`.
export const INEFFECTIVE_PICTURE_PROPS = Object.freeze({
  originalWidth:
    "the engine reports it but never applies it — it is fixed at insert time by " +
    "insertPicture's width argument, and `width` is the key that resizes a picture",
  originalHeight:
    "the engine reports it but never applies it — it is fixed at insert time by " +
    "insertPicture's height argument, and `height` is the key that resizes a picture",
  captionMaxWidth:
    "the engine derives it from the picture width and ignores what you send " +
    "(set `width` and it follows)",
});

// Enum values the engine's parser accepts, which the .hwp save then throws
// away. Refusing them with the real reason beats "must be one of …", because
// the caller has almost certainly read them off Hancom's own UI.
const LOST_ON_SAVE = Object.freeze({
  textWrap: {
    Tight: "the .hwp save downgrades it to Square",
    Through: "the .hwp save downgrades it to Square",
  },
});

// Ranges are only enforced where going outside one CORRUPTS the value instead
// of being ignored — a wrap or a clamp hands the picture a number the caller
// never asked for and reports success. Everything else is left unbounded on
// purpose: the engine stores it verbatim, and a range invented here would
// refuse edits that work.
const RANGES = Object.freeze({
  brightness: { min: -128, max: 127, how: "wraps (500 becomes -12)" },
  contrast: { min: -128, max: 127, how: "wraps (500 becomes -12)" },
  transparency: { min: 0, max: 100, how: "clamps (255 becomes 100)" },
  rotationAngle: { min: -32768, max: 32767, how: "wraps (32768 becomes -32768)" },
  width: { min: 0, max: null, how: "ignores a negative value entirely" },
  height: { min: 0, max: null, how: "ignores a negative value entirely" },
  // borderColor's bounds live in isColorValue — the `color` branch rejects an
  // out-of-range number before this map is ever consulted.
});

const isInt = (v) => typeof v === "number" && Number.isInteger(v);

// Validate a picture --props object against the table.
// Returns { errors: string[], warnings: string[] } and never throws or exits —
// the caller maps a non-empty `errors` to exit 2, which is what makes this
// unit-testable without spawning anything.
export function validatePictureProps(props, { allowUnknown = false } = {}) {
  const errors = [];
  const warnings = [];
  const known = Object.keys(PICTURE_PROPS);

  // The CLI hands us whatever JSON.parse returned. An array or a bare number
  // would make Object.keys lie (or throw), and this function must never throw.
  if (props === null || typeof props !== "object" || Array.isArray(props)) {
    errors.push(
      `--props must be a JSON object, got ${Array.isArray(props) ? "an array" : JSON.stringify(props)}. ` +
        `Example: '{"treatAsChar":true}'`,
    );
    return { errors, warnings };
  }

  const keys = Object.keys(props);
  if (keys.length === 0) {
    errors.push(
      `--props is empty; nothing would be applied. Pass at least one key, e.g. ` +
        `'{"treatAsChar":true}' to pull a floating picture back into the text flow.`,
    );
  }

  for (const key of keys) {
    const s = PICTURE_PROPS[key];

    if (!s) {
      if (Object.prototype.hasOwnProperty.call(INEFFECTIVE_PICTURE_PROPS, key)) {
        errors.push(
          `"${key}" has NO EFFECT on engine 0.7.19 — ${INEFFECTIVE_PICTURE_PROPS[key]}. ` +
            `The engine would still report success. Remove it, or pass ` +
            `--allow-unknown-props to send it anyway.`,
        );
        continue;
      }
      if (allowUnknown) {
        warnings.push(
          `"${key}" is not a known picture property; sending it anyway ` +
            `(--allow-unknown-props). The engine reports success for unknown keys, ` +
            `so check the result yourself.`,
        );
        continue;
      }
      const hint = suggestKey(key, known);
      errors.push(
        `unknown picture property "${key}"${hint ? ` — did you mean "${hint}"?` : ""}\n` +
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
    } else if (s.type === "string" && typeof v !== "string") {
      errors.push(
        `"${key}" must be a string (${s.unit}), got ${JSON.stringify(v)}. ` +
          `The engine ignores a non-string here and still reports success.`,
      );
    } else if (s.type === "color" && !isColorValue(v)) {
      errors.push(
        `"${key}" must be an integer color word 0..16777215 (${s.unit}), got ${JSON.stringify(v)}. ` +
          `Unlike the char table's "textColor", "#RRGGBB" strings are NOT accepted here — ` +
          `"#FF0000", "255" and a negative number are all silently ignored by the engine. ` +
          `Red is 255, blue is 16711680.`,
      );
    } else if (s.type === "integer" && !isInt(v)) {
      errors.push(
        `"${key}" must be an integer (${s.unit}), got ${JSON.stringify(v)}. ` +
          `The engine ignores a non-numeric value here, and TRUNCATES a fraction ` +
          `(12000.9 becomes 12000), reporting success either way.`,
      );
    } else if (s.type === "enum" && !s.values.includes(v)) {
      const lost = LOST_ON_SAVE[key]?.[v];
      if (lost) {
        errors.push(
          `"${key}": "${v}" does not survive a save — ${lost}. The engine accepts it, ` +
            `getPictureProperties reads it back correctly IN MEMORY, and the value is ` +
            `gone once the .hwp is written. Use one of ${quoteAll(s.values)}.`,
        );
      } else {
        const hint = typeof v === "string" ? suggestKey(v, s.values) : null;
        errors.push(
          `"${key}" must be one of ${quoteAll(s.values)}, ` +
            `got ${JSON.stringify(v)}${hint ? ` — did you mean "${hint}"?` : ""}. ` +
            `Values are case-sensitive` +
            (key === "effect"
              ? `, and an invalid "effect" RESETS the picture to "RealPic" rather than ` +
                `being ignored — so this would turn an existing effect OFF.`
              : `, and the engine ignores an invalid one.`),
        );
      }
    } else if (s.type === "integer") {
      // Range last: only reachable once the value is a well-formed integer.
      const r = RANGES[key];
      if (r && isInt(v) && (v < r.min || (r.max !== null && v > r.max))) {
        errors.push(
          `"${key}" must be ${r.max === null ? `>= ${r.min}` : `between ${r.min} and ${r.max}`}` +
            ` (${s.unit}), got ${v}. Out of range the engine ${r.how} and reports success, ` +
            `so the picture ends up with a value you did not ask for.`,
        );
      }
    }
  }

  // Cross-key rules. These are the failures no per-key check can see: every
  // value is individually valid and the edit still does nothing.
  const capturingCaption = props.hasCaption === true;
  for (const key of CAPTION_PROPS) {
    if (!Object.prototype.hasOwnProperty.call(props, key) || capturingCaption) continue;
    errors.push(
      `"${key}" is only applied when the SAME --props object also sets ` +
        `"hasCaption": true — the engine writes the caption block on that call and ` +
        `ignores caption keys on every other one, reporting ok:true throughout. ` +
        `Setting the caption up first and adjusting it in a second call does nothing. ` +
        `Add "hasCaption": true` +
        (props.hasCaption === false
          ? ` (this object sets it to false, which removes the caption).`
          : `.`),
    );
  }

  if (
    isInt(props.rotationAngle) &&
    props.rotationAngle !== 0 &&
    ["width", "height", "vertOffset", "horzOffset"].some((k) =>
      Object.prototype.hasOwnProperty.call(props, k),
    )
  ) {
    warnings.push(
      `"rotationAngle" is applied LAST regardless of key order and recomputes ` +
        `width, height, vertOffset and horzOffset from the rotated bounding box. ` +
        `The size and offset in this same call will not be what you read back ` +
        `(12000×9000 rotated 90° reads back as 9000×12000). Rotate in one call and ` +
        `size in a second one if you need both.`,
    );
  }

  return { errors, warnings };
}

const quoteAll = (values) => values.map((x) => `"${x}"`).join(", ");

// A color here is the raw integer the engine writes into the file. 24 bits:
// anything wider is not a color, and a negative is discarded by the engine.
function isColorValue(v) {
  return isInt(v) && v >= 0 && v <= 0xffffff;
}

// After the edit is saved and reloaded: did each requested key actually take?
// `before` / `after` are getPictureProperties objects from before the apply and
// after the reload. Returns one verdict per key:
//
//   "changed"      the value moved — applied, beyond doubt
//   "already-set"  it did not move, but it already equals what was asked for
//   "no-effect"    it did not move and does not match the request
//   "unverifiable" it did not move and the two cannot be compared honestly
//   "unexposed"    the getter does not surface this key at all
//
// Deliberately identical to format_props' classifier, including the numeric
// "unverifiable" branch. Picture numbers are NOT unit-converted the way
// marginLeft is (12000 HWPUNIT reads back as 12000), but the same ambiguity
// arrives by another road: transparency clamps, brightness and contrast wrap,
// and rotationAngle rewrites width/height behind the caller's back. In every
// one of those cases a requested number that does not equal the stored one is
// not evidence of a no-op, and reporting "no-effect" would fail a correct edit.
// Booleans, strings and enums round-trip comparably and get a real verdict.
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
