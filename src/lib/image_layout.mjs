// Sizing a picture for the page it is going on — the arithmetic nobody gets
// right by hand.
//
// THE PROBLEM. `insertPicture(..., width, height, ...)` takes HWPUNIT
// (1/7200 inch), and nothing in the call says so. Both obvious moves are
// wrong, and both come back ok:true:
//
//   insertPicture(..., 1600, 1200, ...)     the image's pixel size, passed raw
//   insertPicture(..., 120000, 90000, ...)  px → HWPUNIT at 96 dpi, unchecked
//
// Measured on a real A4 report: getPageDef(0) gives width 59528 with margins
// of 8504 on each side, so the text column is 59528 − 8504 − 8504 = 42520
// HWPUNIT (150.0 mm). Against that column, for a 1600×1200 image:
//
//   1600 HWPUNIT        = 5.6 mm wide. A postage stamp, ~3.7% of the column.
//   1600 / 96 × 7200    = 120000 HWPUNIT = 423 mm = 2.82× the text column,
//                         and twice the width of the paper itself. The picture
//                         runs off the page and drags the layout with it.
//
// Neither one throws. The document just comes back wrong — the same class of
// failure as the memo guard and the format-props table: not a crash, an untrue
// success. So the arithmetic lives here once, and no call site repeats it.
//
// PURE ON PURPOSE. No engine, no filesystem, no printing, no process.exit.
// `usableWidth` takes an already-parsed pageDef object rather than a document,
// which is the whole reason every rule below can be unit-tested without one.
//
// REFUSE, DON'T CLAMP. When the caller names a width that does not fit, this
// returns ok:false instead of quietly shrinking it. Clamping is the same bug
// pointing the other way: the caller asked for 50000, silently got 42520, was
// told ok — and every measurement they built around the number they asked for
// is now wrong, with no signal anywhere. A caller who actually wants the fit
// is one argument away from asking for it (drop the width, or pass the usable
// width); a caller who would not notice the substitution never needed the
// specific width. The refusal names both numbers, in HWPUNIT and in mm, and
// the value that would have fit, so the fix is a copy-paste.
//
// NEVER SILENTLY ENLARGE. With no requested width, an image smaller than the
// column is used at its natural size. Nobody asked for a 200 px logo to become
// a full-column banner, and upscaled raster art prints visibly soft. An
// explicit `requestedWidth` larger than natural IS honoured — that one was
// asked for out loud — and the reason line says what it did.

export const HWPUNIT_PER_INCH = 7200;
export const DEFAULT_DPI = 96;

const MM_PER_INCH = 25.4;

const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);
const isPositive = (v) => isFiniteNumber(v) && v > 0;

// For error messages. JSON.stringify turns NaN, Infinity and undefined all
// into "null", which is exactly the wrong thing to tell someone whose input
// was NaN — the report has to name the value they actually passed.
function show(v) {
  if (typeof v === "number") return Number.isNaN(v) ? "NaN" : String(v);
  if (v === undefined) return "undefined";
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// px → HWPUNIT. Returns NaN rather than throwing on unusable input; every
// caller in this file checks its arguments first, so a NaN can only escape to
// someone who bypassed fitToWidth, and NaN is louder there than a plausible 0.
export function pxToHwpUnit(px, dpi = DEFAULT_DPI) {
  if (!isFiniteNumber(px) || !isPositive(dpi)) return NaN;
  return Math.round((px * HWPUNIT_PER_INCH) / dpi);
}

// HWPUNIT → mm, ROUNDED TO ONE DECIMAL. This is for talking to humans: mm is
// the unit Korean page layout is actually discussed in (A4 is 210 mm wide,
// margins are set as 30 mm), and 150.00000000000003 helps nobody. Do not round
// -trip through it — it is lossy by design; keep HWPUNIT for arithmetic.
export function hwpUnitToMm(hu) {
  if (!isFiniteNumber(hu)) return NaN;
  return Math.round((hu / HWPUNIT_PER_INCH) * MM_PER_INCH * 10) / 10;
}

// The same number, ready to drop into a sentence.
export function formatMm(hu) {
  const mm = hwpUnitToMm(hu);
  return Number.isFinite(mm) ? `${mm.toFixed(1)} mm` : "unknown mm";
}

// The width of the text column, in HWPUNIT, from a parsed getPageDef object.
//
// A missing or non-numeric field returns NaN, deliberately — NOT a margin
// defaulted to 0. Defaulting would hand back a usable width wider than the
// text column and every picture sized against it would overhang, which is the
// silent breakage this module exists to prevent. NaN reaches fitToWidth as a
// refusal with a message, and `NaN > 0` is false so a `usable > 0` guard at a
// call site also does the right thing.
export function usableWidth(pageDef) {
  if (!pageDef || typeof pageDef !== "object") return NaN;
  const { width, marginLeft, marginRight } = pageDef;
  if (!isFiniteNumber(width) || !isFiniteNumber(marginLeft) || !isFiniteNumber(marginRight)) {
    return NaN;
  }
  // May legitimately come out ≤ 0 (margins wider than the paper). That is a
  // page with no text column, and fitToWidth refuses it by name rather than
  // pretending some size would work.
  return Math.round(width - marginLeft - marginRight);
}

// The failure shape. width/height are null, not 0: a caller who ignores `ok`
// and passes these to the engine gets a visible failure instead of a
// zero-sized picture nobody can see in the saved document.
function refuse(error) {
  return { ok: false, width: null, height: null, scale: null, fitted: false, reason: "", error };
}

// Work out the picture's size in HWPUNIT, preserving its aspect ratio.
//
//   naturalWidthPx / naturalHeightPx  the image's real pixel size, read from
//                                     the file — never guessed
//   maxWidth                          usable width in HWPUNIT (usableWidth())
//   requestedWidth                    HWPUNIT, when the caller named one
//   dpi                               px → HWPUNIT conversion basis
//
// Returns { ok, width, height, scale, fitted, reason, error }. `fitted` is
// true only when this shrank the image to make it fit — honouring a smaller
// `requestedWidth` is not fitting, it is doing what was asked.
export function fitToWidth(options = {}) {
  // Destructured inside rather than in the signature, because a default
  // parameter only covers `undefined` — `fitToWidth(null)` would throw on the
  // destructuring itself, and this module does not throw.
  if (options === null || typeof options !== "object") {
    return refuse(
      `fitToWidth expects an options object ` +
        `({naturalWidthPx, naturalHeightPx, maxWidth, ...}), got ${show(options)}.`,
    );
  }
  const {
    naturalWidthPx,
    naturalHeightPx,
    maxWidth,
    requestedWidth = null,
    dpi = DEFAULT_DPI,
  } = options;

  // ── inputs ──────────────────────────────────────────────────────────────
  const problems = [];

  if (!isPositive(maxWidth)) {
    problems.push(
      `maxWidth must be a positive width in HWPUNIT, got ${show(maxWidth)}; ` +
        `usableWidth() returns NaN when the pageDef has no numeric ` +
        `width/marginLeft/marginRight, a caller that could not read the page ` +
        `definition at all usually passes 0, and a page whose margins are wider ` +
        `than its paper has no text column to fit anything into.`,
    );
  }

  if (!isPositive(naturalWidthPx) || !isPositive(naturalHeightPx)) {
    problems.push(
      `naturalWidthPx and naturalHeightPx must both be positive pixel counts, got ` +
        `${show(naturalWidthPx)}x${show(naturalHeightPx)}; read them from the image ` +
        `header rather than assuming, because a wrong natural size produces a ` +
        `perfectly successful call that distorts the picture.`,
    );
  }

  if (!isPositive(dpi)) {
    problems.push(`dpi must be a positive number, got ${show(dpi)} (default ${DEFAULT_DPI}).`);
  }

  // undefined is treated as null: "the caller did not name a width". Anything
  // else non-positive is a mistake, including 0 — see below.
  const hasRequest = requestedWidth !== null && requestedWidth !== undefined;
  if (hasRequest && !isPositive(requestedWidth)) {
    problems.push(
      `requestedWidth must be a positive width in HWPUNIT or null, got ` +
        `${show(requestedWidth)}; 0 does not mean "auto" — omit the width (null) ` +
        `to have the image sized automatically, since a picture 0 HWPUNIT wide is ` +
        `one the engine will accept and nobody will ever see.`,
    );
  }

  if (problems.length > 0) return refuse(problems.join(" "));

  // ── the refusal that this module exists for ─────────────────────────────
  if (hasRequest && requestedWidth > maxWidth) {
    const want = Math.round(requestedWidth);
    const room = Math.round(maxWidth);
    return refuse(
      `requested width ${want} HWPUNIT (${formatMm(want)}) exceeds the usable width ` +
        `${room} HWPUNIT (${formatMm(room)}) — the picture would run past the text ` +
        `column by ${want - room} HWPUNIT (${formatMm(want - room)}). Refused rather ` +
        `than quietly clamped: getting a different size than the one you asked for, ` +
        `with a success reported, is how a page layout breaks with nothing to show ` +
        `for it. Ask for ${room} HWPUNIT (${formatMm(room)}) to fill the column ` +
        `exactly, or omit the width to have it scaled to fit.`,
    );
  }

  // ── natural size ────────────────────────────────────────────────────────
  const naturalWidth = pxToHwpUnit(naturalWidthPx, dpi);
  const naturalHeight = pxToHwpUnit(naturalHeightPx, dpi);

  // HWPUNIT is integral, so 1/7200 inch (0.0035 mm) is the smallest size that
  // exists. An image whose natural size rounds below that has no size we can
  // express, and reporting 0 would hand the engine an invisible picture.
  if (!(naturalWidth >= 1) || !(naturalHeight >= 1)) {
    return refuse(
      `${show(naturalWidthPx)}x${show(naturalHeightPx)} px at ${dpi} dpi is ` +
        `${show(naturalWidth)}x${show(naturalHeight)} HWPUNIT, below the 1/7200 inch ` +
        `that is the smallest size HWPUNIT can express. Check the pixel size and the ` +
        `dpi — one of them is not what you think it is.`,
    );
  }

  // ── the policy ──────────────────────────────────────────────────────────
  let width;
  let fitted;
  if (hasRequest) {
    // It fits (the refusal above already ran), so honour it EXACTLY. Not
    // re-fitted, not nudged: the caller named a number and gets that number.
    width = Math.round(requestedWidth);
    fitted = false;
  } else if (naturalWidth > maxWidth) {
    width = Math.round(maxWidth);
    fitted = true;
  } else {
    // Fits as it is. Never enlarged to fill the column — see the header.
    width = naturalWidth;
    fitted = false;
  }

  // Height from the FINAL width and the ORIGINAL pixel ratio, so the aspect
  // ratio survives with exactly one rounding rather than a scale factor
  // rounded and then re-applied to an already-rounded height. At natural size
  // the converted height is exact, so use it directly.
  const height =
    width === naturalWidth
      ? naturalHeight
      : Math.round((width * naturalHeightPx) / naturalWidthPx);

  // An extreme aspect ratio can survive its natural size and still lose the
  // height once scaled down: 200000x1 px is 15000000x75 HWPUNIT naturally, but
  // fitted to a 42520 column the height is 0.21 → 0. Refuse; a picture with a
  // zero dimension is one the engine takes and nobody can see. (Infinity is
  // caught here too, from pixel counts near the float ceiling.)
  if (!Number.isFinite(height) || height < 1) {
    return refuse(
      `at ${width} HWPUNIT wide, the ${naturalWidthPx}x${naturalHeightPx} px aspect ` +
        `ratio puts the height at ${show(height)} HWPUNIT — below the 1/7200 inch ` +
        `minimum, so the picture would have no height at all. Crop or reshape the ` +
        `image before inserting it, or place it somewhere with a wider text column.`,
    );
  }

  // Rounded off the float noise (42520/120000 is 0.35433333333333333) because
  // this goes straight into JSON output. It is a report, not an input.
  const scale = Math.round((width / naturalWidth) * 1e6) / 1e6;
  const pct = `${(scale * 100).toFixed(1)}%`;

  const natural =
    `${naturalWidthPx}x${naturalHeightPx} px at ${dpi} dpi = ` +
    `${naturalWidth}x${naturalHeight} HWPUNIT (${formatMm(naturalWidth)} wide)`;
  const column = `${Math.round(maxWidth)} HWPUNIT (${formatMm(maxWidth)}) text column`;
  const result = `${width}x${height} HWPUNIT (${formatMm(width)} x ${formatMm(height)})`;

  let reason;
  if (fitted) {
    const times = (naturalWidth / maxWidth).toFixed(2);
    reason =
      `${natural} is ${times}x the ${column}; scaled to ${pct}, aspect ratio kept ` +
      `→ ${result}`;
  } else if (hasRequest) {
    const note =
      width > naturalWidth
        ? ` — larger than the image's natural size, as requested; it will print soft`
        : "";
    reason = `${natural}; using the requested width → ${result}, ${pct} of natural size, fits the ${column}${note}`;
  } else {
    reason = `${natural} fits the ${column}; inserted at natural size → ${result}`;
  }

  return { ok: true, width, height, scale, fitted, reason, error: null };
}

// One stderr-ready line for any result, success or refusal — so a caller has
// exactly one thing to print and never has to branch on `ok` just to report.
// Whitespace is collapsed: callers append their own newline, and a message
// that wraps mid-sentence in a log is a message people stop reading.
export function describeFit(result) {
  if (!result || typeof result !== "object") return "image-fit: no result";
  const line = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  if (!result.ok) return `image-fit: REFUSED — ${line(result.error) || "no reason given"}`;
  return `image-fit: ${line(result.reason) || "sized"}`;
}
