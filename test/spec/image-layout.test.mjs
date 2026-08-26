// lib/image_layout — the sizing arithmetic for an inserted picture.
//
// This exists because of a measured failure: an agent asked to put an image in
// a Korean report destroyed the layout, and the cause was that
// insertPicture's width/height are HWPUNIT (1/7200 inch), not pixels. The two
// natural moves are both wrong and both report success, so the two numbers
// from that bug report — 1600 (raw pixels) and 120000 (px→HWPUNIT at 96 dpi,
// unchecked) — are pinned here by name.
//
// Everything is pure: no engine, no document, no filesystem. That is the point
// of the module taking a parsed pageDef instead of a document.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_DPI,
  HWPUNIT_PER_INCH,
  describeFit,
  fitToWidth,
  formatMm,
  hwpUnitToMm,
  pxToHwpUnit,
  usableWidth,
} from "../../src/lib/image_layout.mjs";

// The real A4 report the bug was measured on: getPageDef(0) reported these.
const A4 = { width: 59528, marginLeft: 8504, marginRight: 8504 };
const COLUMN = 42520; // 59528 − 8504 − 8504, and what usableWidth must return

// Aspect ratio is checked on the DIMENSION, not on the ratio: at an extreme
// ratio (10000x1) a single unit of rounding in the height moves the ratio by
// thousands, which says nothing about whether the picture is distorted. What
// matters is that the height is the correct height for the chosen width to
// within the one rounding HWPUNIT allows.
function assertAspect(res, wpx, hpx) {
  const exact = (res.width * hpx) / wpx;
  assert.ok(
    Math.abs(res.height - exact) <= 1,
    `height ${res.height} is not ${exact} (±1) for ${wpx}x${hpx} px at width ${res.width}`,
  );
}

function assertUsableNumbers(res) {
  assert.ok(Number.isInteger(res.width), `width ${res.width} must be an integer HWPUNIT`);
  assert.ok(Number.isInteger(res.height), `height ${res.height} must be an integer HWPUNIT`);
  assert.ok(res.width >= 1 && res.height >= 1, "a sized picture must have both dimensions");
  assert.ok(Number.isFinite(res.scale) && res.scale > 0, "scale must be a positive number");
  assert.equal(res.error, null);
  assert.ok(res.reason.length > 0, "an ok result still owes stderr an explanation");
}

// ── units ──────────────────────────────────────────────────────────────────

test("units: the constants are the ones HWP actually uses", () => {
  assert.equal(HWPUNIT_PER_INCH, 7200); // 1 HWPUNIT = 1/7200 inch
  assert.equal(DEFAULT_DPI, 96);
});

test("pxToHwpUnit: the conversion from the bug report, and the default dpi", () => {
  // The number that made the image 2.8x too wide. It is arithmetically right —
  // it is the missing comparison against the page that was wrong.
  assert.equal(pxToHwpUnit(1600, 96), 120000);
  assert.equal(pxToHwpUnit(1600), 120000, "96 dpi is the default");
  assert.equal(pxToHwpUnit(96), HWPUNIT_PER_INCH, "96 px at 96 dpi is one inch");
  assert.equal(pxToHwpUnit(1600, 300), 38400, "the same image at 300 dpi is much smaller");
  assert.equal(pxToHwpUnit(0), 0);
});

test("pxToHwpUnit: rounds to an integer, and returns NaN rather than throwing", () => {
  assert.equal(pxToHwpUnit(1.5, 96), 113); // 112.5 → 113
  assert.ok(Number.isInteger(pxToHwpUnit(1234, 96)));
  for (const bad of [NaN, Infinity, "1600", null, undefined, {}]) {
    assert.ok(Number.isNaN(pxToHwpUnit(bad)), `${String(bad)} must give NaN`);
  }
  assert.ok(Number.isNaN(pxToHwpUnit(1600, 0)), "a zero dpi would divide by zero");
  assert.ok(Number.isNaN(pxToHwpUnit(1600, -96)));
});

test("hwpUnitToMm: the numbers a human can check against a ruler", () => {
  assert.equal(hwpUnitToMm(HWPUNIT_PER_INCH), 25.4);
  assert.equal(hwpUnitToMm(A4.width), 210, "A4 is 210 mm wide");
  assert.equal(hwpUnitToMm(A4.marginLeft), 30, "a 30 mm margin");
  assert.equal(hwpUnitToMm(COLUMN), 150, "210 − 30 − 30");
  assert.equal(hwpUnitToMm(1600), 5.6, "raw pixels as HWPUNIT: a postage stamp");
  assert.equal(hwpUnitToMm(120000), 423.3, "the naive conversion is wider than the paper");
  assert.ok(Number.isNaN(hwpUnitToMm("42520")));
  assert.equal(formatMm(COLUMN), "150.0 mm");
});

test("hwpUnitToMm returns a Number — image.mjs calls .toFixed(1) on it", () => {
  // The seam with src/core/image.mjs: it reports widthMm as
  // Number(hwpUnitToMm(w).toFixed(1)). A string here would still "work" and
  // then produce "150.0150.0" style nonsense somewhere downstream.
  assert.equal(typeof hwpUnitToMm(COLUMN), "number");
  assert.equal(hwpUnitToMm(COLUMN).toFixed(1), "150.0");
});

// ── usableWidth ────────────────────────────────────────────────────────────

test("usableWidth: the measured A4 geometry gives exactly 42520", () => {
  assert.equal(usableWidth(A4), COLUMN);
  assert.equal(usableWidth({ ...A4, extra: "ignored" }), COLUMN);
});

test("usableWidth: a missing field is NaN, never a margin quietly treated as 0", () => {
  // Defaulting a missing margin to 0 would report a column 30 mm too wide and
  // every picture sized against it would overhang — silently, which is the
  // exact failure this module exists to stop.
  assert.ok(Number.isNaN(usableWidth({ width: 59528, marginLeft: 8504 })));
  assert.ok(Number.isNaN(usableWidth({ width: 59528, marginRight: 8504 })));
  assert.ok(Number.isNaN(usableWidth({ marginLeft: 8504, marginRight: 8504 })));
  assert.ok(Number.isNaN(usableWidth({ ...A4, marginLeft: "8504" })), "a string is not a margin");
  assert.ok(Number.isNaN(usableWidth({ ...A4, width: NaN })));
  for (const bad of [null, undefined, 42520, "A4", []]) {
    assert.ok(Number.isNaN(usableWidth(bad)), `${String(bad)} is not a pageDef`);
  }
});

test("usableWidth: margins wider than the paper give a non-positive column", () => {
  // Not clamped to 0 here — the number is reported honestly and fitToWidth is
  // the one place that refuses it, with a message.
  assert.equal(usableWidth({ width: 10000, marginLeft: 8504, marginRight: 8504 }), -7008);
  const res = fitToWidth({ naturalWidthPx: 100, naturalHeightPx: 100, maxWidth: -7008 });
  assert.equal(res.ok, false);
  assert.match(res.error, /maxWidth/);
});

// ── the two failure modes from the bug report ──────────────────────────────

test("bug report #1: raw pixels (1600) would be a 5.6 mm postage stamp", () => {
  // Passing the pixel width straight through is a legal call that produces a
  // picture 3.7% of the column. The module's answer for the same image is the
  // full column instead.
  assert.equal(hwpUnitToMm(1600), 5.6);
  const res = fitToWidth({ naturalWidthPx: 1600, naturalHeightPx: 1200, maxWidth: COLUMN });
  assert.equal(res.ok, true);
  assert.notEqual(res.width, 1600, "the pixel count is not a width");
  assert.equal(res.width, COLUMN);
  assert.equal(res.height, 31890);
  assertUsableNumbers(res);
});

test("bug report #2: the naive 96-dpi conversion (120000) is 2.82x the column", () => {
  const naive = pxToHwpUnit(1600, 96);
  assert.equal(naive, 120000);
  assert.ok(naive > COLUMN * 2.8, "2.82x the usable width — it runs off the page");
  assert.ok(naive > A4.width, "and wider than the sheet of paper itself");

  const res = fitToWidth({ naturalWidthPx: 1600, naturalHeightPx: 1200, maxWidth: COLUMN });
  assert.equal(res.ok, true);
  assert.equal(res.fitted, true, "it had to shrink, and says so");
  assert.equal(res.width, COLUMN, "and the result FITS: exactly the text column");
  assert.ok(res.width <= COLUMN);
  assert.equal(res.height, 31890); // 42520 × 1200/1600
  assert.equal(res.scale, 0.354333); // 42520/120000, float noise rounded off
  assertAspect(res, 1600, 1200);
  assertUsableNumbers(res);
});

test("bug report: the reason line carries both units and the shrink factor", () => {
  const res = fitToWidth({ naturalWidthPx: 1600, naturalHeightPx: 1200, maxWidth: COLUMN });
  assert.match(res.reason, /1600x1200 px at 96 dpi/);
  assert.match(res.reason, /120000x90000 HWPUNIT/, "names the number that was too big");
  assert.match(res.reason, /2\.82x/);
  assert.match(res.reason, /42520/);
  assert.match(res.reason, /150\.0 mm/, "mm, because that is how the page is discussed");
});

// ── the fit policy ─────────────────────────────────────────────────────────

test("policy: aspect ratio survives every path, to within one HWPUNIT", () => {
  const cases = [
    { w: 1600, h: 1200, max: COLUMN }, // shrunk
    { w: 1600, h: 1200, max: COLUMN, req: 20000 }, // requested
    { w: 200, h: 150, max: COLUMN }, // natural
    { w: 1601, h: 1201, max: COLUMN }, // odd numbers, worst case for rounding
    { w: 3, h: 7919, max: COLUMN }, // tall and prime
    { w: 4032, h: 3024, max: 1000 }, // a phone photo into a table cell
  ];
  for (const c of cases) {
    const res = fitToWidth({
      naturalWidthPx: c.w,
      naturalHeightPx: c.h,
      maxWidth: c.max,
      requestedWidth: c.req ?? null,
    });
    assert.equal(res.ok, true, `${c.w}x${c.h} should size: ${res.error}`);
    assertAspect(res, c.w, c.h);
    assertUsableNumbers(res);
    assert.ok(res.width <= Math.max(c.max, c.req ?? 0), "never wider than allowed");
  }
});

test("policy: a requested width UNDER the column is honoured exactly, not re-fitted", () => {
  const res = fitToWidth({
    naturalWidthPx: 1600,
    naturalHeightPx: 1200,
    maxWidth: COLUMN,
    requestedWidth: 20000,
  });
  assert.equal(res.ok, true);
  assert.equal(res.width, 20000, "exactly what was asked for, not nudged to fit better");
  assert.equal(res.height, 15000);
  assert.equal(res.fitted, false, "fitted means WE shrank it; this was the caller's number");
  assert.equal(res.scale, 0.166667);
  assertAspect(res, 1600, 1200);
});

test("policy: a requested width EQUAL to the column is honoured (the boundary is inclusive)", () => {
  const res = fitToWidth({
    naturalWidthPx: 1600,
    naturalHeightPx: 1200,
    maxWidth: COLUMN,
    requestedWidth: COLUMN,
  });
  assert.equal(res.ok, true, "filling the column exactly is the recommended value, so it must work");
  assert.equal(res.width, COLUMN);
  assert.equal(res.height, 31890);
});

test("policy: a requested width OVER the column is refused, not clamped", () => {
  const res = fitToWidth({
    naturalWidthPx: 1600,
    naturalHeightPx: 1200,
    maxWidth: COLUMN,
    requestedWidth: 50000,
  });
  assert.equal(res.ok, false, "silently substituting a different size is the bug, not the fix");
  assert.equal(res.width, null, "and no dimensions come back to be used by accident");
  assert.equal(res.height, null);
  assert.equal(res.fitted, false);

  // The message has to carry every number needed to fix it without re-deriving
  // anything: what was asked, what fits, both in HWPUNIT and in mm.
  assert.match(res.error, /50000 HWPUNIT/);
  assert.match(res.error, /176\.4 mm/);
  assert.match(res.error, /42520 HWPUNIT/);
  assert.match(res.error, /150\.0 mm/);
  assert.match(res.error, /Ask for 42520/, "and suggests the value that would fit");
  assert.doesNotMatch(res.error, /\n/, "image.mjs indents it as one line");
});

test("policy: a small image is never enlarged to fill the column", () => {
  // A 200 px logo asked for as a logo must not come back as a full-width
  // banner: nobody requested that, and upscaled raster prints visibly soft.
  const res = fitToWidth({ naturalWidthPx: 200, naturalHeightPx: 150, maxWidth: COLUMN });
  assert.equal(res.ok, true);
  assert.equal(res.width, 15000, "200 px at 96 dpi, unchanged");
  assert.equal(res.height, 11250);
  assert.equal(res.scale, 1);
  assert.equal(res.fitted, false);
  assert.match(res.reason, /natural size/);
});

test("policy: an image exactly as wide as the column is not 'fitted'", () => {
  const res = fitToWidth({ naturalWidthPx: 1600, naturalHeightPx: 1200, maxWidth: 120000 });
  assert.equal(res.ok, true);
  assert.equal(res.width, 120000);
  assert.equal(res.height, 90000, "at natural size the height is converted, not re-derived");
  assert.equal(res.fitted, false);
  assert.equal(res.scale, 1);
});

test("policy: an explicit width LARGER than the image is honoured, and says so", () => {
  // Enlargement is refused when nobody asked; it is allowed when someone did,
  // because that is a decision, not a silent substitution.
  const res = fitToWidth({
    naturalWidthPx: 200,
    naturalHeightPx: 150,
    maxWidth: COLUMN,
    requestedWidth: 40000,
  });
  assert.equal(res.ok, true);
  assert.equal(res.width, 40000);
  assert.equal(res.height, 30000);
  assert.ok(res.scale > 1);
  assert.match(res.reason, /larger than the image's natural size/);
});

test("policy: dpi changes the answer — the same 1600 px fits at 300 dpi", () => {
  const at96 = fitToWidth({ naturalWidthPx: 1600, naturalHeightPx: 1200, maxWidth: COLUMN });
  const at300 = fitToWidth({
    naturalWidthPx: 1600,
    naturalHeightPx: 1200,
    maxWidth: COLUMN,
    dpi: 300,
  });
  assert.equal(at96.fitted, true, "at 96 dpi it must be shrunk");
  assert.equal(at300.fitted, false, "at 300 dpi the same pixels are 38400 HWPUNIT and fit");
  assert.equal(at300.width, 38400);
  assert.equal(at300.height, 28800);
  assert.match(at300.reason, /at 300 dpi/);
});

// ── degenerate input: refuse, never throw, never NaN ───────────────────────

test("degenerate: a zero natural dimension is refused", () => {
  for (const args of [
    { naturalWidthPx: 0, naturalHeightPx: 1200 },
    { naturalWidthPx: 1600, naturalHeightPx: 0 },
    { naturalWidthPx: 0, naturalHeightPx: 0 },
  ]) {
    const res = fitToWidth({ ...args, maxWidth: COLUMN });
    assert.equal(res.ok, false);
    assert.match(res.error, /naturalWidthPx and naturalHeightPx/);
    assert.equal(res.width, null);
  }
});

test("degenerate: a negative natural dimension is refused", () => {
  const res = fitToWidth({ naturalWidthPx: -1600, naturalHeightPx: 1200, maxWidth: COLUMN });
  assert.equal(res.ok, false);
  assert.match(res.error, /-1600/, "the refused value is named back");
});

test("degenerate: NaN natural dimensions are refused and named as NaN", () => {
  const res = fitToWidth({ naturalWidthPx: NaN, naturalHeightPx: NaN, maxWidth: COLUMN });
  assert.equal(res.ok, false);
  // JSON.stringify would render NaN as "null", which is a lie about the input.
  assert.match(res.error, /NaN/);
  assert.doesNotMatch(res.error, /nullxnull/);
});

test("degenerate: missing / wrong-typed natural dimensions are refused", () => {
  const missing = fitToWidth({ maxWidth: COLUMN });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /undefined/);

  const stringy = fitToWidth({ naturalWidthPx: "1600", naturalHeightPx: "1200", maxWidth: COLUMN });
  assert.equal(stringy.ok, false, '"1600" is not a pixel count, even though it multiplies');
});

test("degenerate: a zero or negative maxWidth is refused", () => {
  for (const maxWidth of [0, -1, -42520]) {
    const res = fitToWidth({ naturalWidthPx: 1600, naturalHeightPx: 1200, maxWidth });
    assert.equal(res.ok, false);
    // 0 is what image.mjs' pageUsable() returns when getPageDef throws, so the
    // message has to explain that case and not just "must be positive".
    assert.match(res.error, /maxWidth must be a positive width in HWPUNIT/);
    assert.match(res.error, /page definition/);
  }
});

test("degenerate: a NaN maxWidth (the usableWidth failure) is refused with the reason", () => {
  const res = fitToWidth({
    naturalWidthPx: 1600,
    naturalHeightPx: 1200,
    maxWidth: usableWidth({ width: 59528 }), // NaN: no margins in the pageDef
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /NaN/);
  assert.match(res.error, /usableWidth\(\)/, "points at where the NaN came from");
});

test("degenerate: requestedWidth 0 is refused — 0 is not 'auto'", () => {
  const res = fitToWidth({
    naturalWidthPx: 1600,
    naturalHeightPx: 1200,
    maxWidth: COLUMN,
    requestedWidth: 0,
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /0 does not mean "auto"/);
  assert.match(res.error, /null/, "and says what to pass instead");
});

test("degenerate: a negative or NaN requestedWidth is refused", () => {
  for (const requestedWidth of [-1, NaN, Infinity, "20000", {}]) {
    const res = fitToWidth({
      naturalWidthPx: 1600,
      naturalHeightPx: 1200,
      maxWidth: COLUMN,
      requestedWidth,
    });
    assert.equal(res.ok, false, `${String(requestedWidth)} must be refused`);
    assert.match(res.error, /requestedWidth/);
  }
});

test("degenerate: requestedWidth undefined is treated as null, not as an error", () => {
  const res = fitToWidth({
    naturalWidthPx: 1600,
    naturalHeightPx: 1200,
    maxWidth: COLUMN,
    requestedWidth: undefined,
  });
  assert.equal(res.ok, true, "an absent flag arrives as undefined from argv parsing");
  assert.equal(res.width, COLUMN);
});

test("degenerate: a bad dpi is refused rather than dividing by zero", () => {
  for (const dpi of [0, -96, NaN, "96", null]) {
    const res = fitToWidth({
      naturalWidthPx: 1600,
      naturalHeightPx: 1200,
      maxWidth: COLUMN,
      dpi,
    });
    assert.equal(res.ok, false, `dpi ${String(dpi)} must be refused`);
    assert.match(res.error, /dpi/);
  }
});

test("degenerate: an absurd aspect ratio still sizes, if the height survives", () => {
  // 10000x1 px is a hairline rule. Natural size is 750000x75 HWPUNIT; fitted
  // to the column it is 42520x4 — extreme, but 4 HWPUNIT is a real height.
  const res = fitToWidth({ naturalWidthPx: 10000, naturalHeightPx: 1, maxWidth: COLUMN });
  assert.equal(res.ok, true);
  assert.equal(res.width, COLUMN);
  assert.equal(res.height, 4);
  assert.equal(res.fitted, true);
  assertAspect(res, 10000, 1);
  assertUsableNumbers(res);
});

test("degenerate: an aspect ratio whose fitted height rounds to 0 is refused", () => {
  // 200000x1 px: natural height is a legal 75 HWPUNIT, but scaled to the
  // column the height is 0.21 → 0. A zero-height picture is one the engine
  // accepts and nobody can see, so this is refused instead of rounded away.
  const res = fitToWidth({ naturalWidthPx: 200000, naturalHeightPx: 1, maxWidth: COLUMN });
  assert.equal(res.ok, false);
  assert.match(res.error, /height/);
  assert.match(res.error, /1\/7200 inch/);
  assert.equal(res.height, null);
});

test("degenerate: a natural size below one HWPUNIT is refused", () => {
  // Sub-pixel dimensions are positive and finite, so they pass every type
  // check and then round to nothing.
  const res = fitToWidth({ naturalWidthPx: 0.001, naturalHeightPx: 0.001, maxWidth: COLUMN });
  assert.equal(res.ok, false);
  assert.match(res.error, /smallest size HWPUNIT can express/);
});

test("degenerate: nothing throws, whatever it is handed", () => {
  for (const arg of [undefined, null, 42520, "wide", [], () => {}, { requestedWidth: [] }]) {
    let res;
    assert.doesNotThrow(() => {
      res = fitToWidth(arg);
    }, `fitToWidth(${String(arg)}) must not throw`);
    assert.equal(res.ok, false);
    assert.equal(typeof res.error, "string");
    assert.ok(res.error.length > 0);
    // The whole point of refusing is that no unusable number escapes.
    assert.ok(!Number.isNaN(res.width) && !Number.isNaN(res.height));
    assert.equal(res.width, null);
    assert.equal(res.height, null);
  }
});

// ── describeFit ────────────────────────────────────────────────────────────

test("describeFit: one line for a success, one line for a refusal", () => {
  const okRes = fitToWidth({ naturalWidthPx: 1600, naturalHeightPx: 1200, maxWidth: COLUMN });
  const line = describeFit(okRes);
  assert.doesNotMatch(line, /\n/, "image.mjs appends its own newline");
  assert.match(line, /^image-fit: /);
  assert.match(line, /42520/);

  const bad = fitToWidth({
    naturalWidthPx: 1600,
    naturalHeightPx: 1200,
    maxWidth: COLUMN,
    requestedWidth: 50000,
  });
  const badLine = describeFit(bad);
  assert.doesNotMatch(badLine, /\n/);
  assert.match(badLine, /REFUSED/, "a refusal must not read like a size report");
  assert.match(badLine, /50000/);
});

test("describeFit: never throws, whatever it is given", () => {
  for (const arg of [undefined, null, "", 5, { ok: true }, { ok: false }]) {
    let out;
    assert.doesNotThrow(() => {
      out = describeFit(arg);
    });
    assert.equal(typeof out, "string");
    assert.ok(out.length > 0);
    assert.doesNotMatch(out, /\n/);
  }
});
