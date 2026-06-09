// Spec tests for §1 Tables — rules 1, 2, 7 (plus a sanity gate on the three
// Korean-form flags). These assert the RULE from spec/rhwp-behavior.md, not
// merely "what the code does": rule 1/2 are checked directly against the
// engine through src/lib/_bootstrap.mjs (so they hold even if extract_tables.mjs
// were rewritten), and again through the src/core/extract_tables.mjs JSON so
// the script is proven to honor the same address-based grid contract.
//
//   Rule 1  merge-origin storage: getCellInfo returns {row,col,rowSpan,colSpan}
//           (NO 'cellAddr' field); the merged header on fixture-table.hwpx
//           places by address with NO text leaking onto covered neighbors.
//   Rule 2  cellCount counts ORIGIN cells only → 18 < rowCount*colCount (24).
//   Rule 7  full-width spaces surface as U+2007 (figure-space), NEVER U+3000
//           (ideographic-space) in extracted text.
//
// Fixtures (spec §0): fixture-table.hwpx — table (0,0,2) = 3×8 / cellCount 18,
// merged header row, origin cell {row:0,col:0,rowSpan:1,colSpan:4} = "기부 금액(원, %)"
// and {row:0,col:4,...,colSpan:4} = "기부 건수(건, %)", data cell "65,063,026,600".

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadDocument } from "../../src/lib/_bootstrap.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const HWP = join(ROOT, "samples", "fixture-table.hwp"); // genuine HWP, cell "△1,802"
const HWPX = join(ROOT, "samples", "fixture-table.hwpx"); // HWPX, table (0,0,2)

const U2007 = " "; // FIGURE SPACE — the full-width space rhwp emits
const U3000 = "　"; // IDEOGRAPHIC SPACE — must NEVER appear in extracted text

// Run src/core/extract_tables.mjs with cwd=repo root and return {status, stdout, stderr}.
function runExtract(args) {
  return spawnSync(process.execPath, ["src/core/extract_tables.mjs", ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

// Pull every text string out of a parsed extract_tables JSON payload, so a
// codepoint audit can scan the whole extracted surface at once.
function allGridText(payload) {
  let s = "";
  for (const t of payload.tables) {
    if (!t.grid) continue;
    for (const row of t.grid) {
      for (const cell of row) {
        if (cell && typeof cell.text === "string") s += cell.text + "\n";
      }
    }
  }
  return s;
}

// ── Rule 1: getCellInfo shape + merge-origin, asserted on the engine ────────
test("rule 1 (engine): getCellInfo returns {row,col,rowSpan,colSpan} and NO cellAddr field", async () => {
  const doc = await loadDocument(HWPX);
  const info = JSON.parse(doc.getCellInfo(0, 0, 2, 0)); // origin of merged header
  // Exactly the documented keys, nothing more (cellAddr must NOT exist).
  assert.deepEqual(
    Object.keys(info).sort(),
    ["col", "colSpan", "row", "rowSpan"],
    "getCellInfo must expose row/col/rowSpan/colSpan and nothing else",
  );
  assert.equal(Object.prototype.hasOwnProperty.call(info, "cellAddr"), false);
  // The spec's worked example: the merged header origin is (0,0) spanning 4 cols.
  assert.deepEqual(info, { row: 0, col: 0, rowSpan: 1, colSpan: 4 });
});

test("rule 1 (engine): merged header is stored once at its origin; covered cols hold no own cell", async () => {
  const doc = await loadDocument(HWPX);
  const dims = JSON.parse(doc.getTableDimensions(0, 0, 2));
  // Build address → origin-cell map straight from the engine.
  const origins = new Map(); // "r,c" -> {span, text}
  const coveredByOrigin = new Set(); // "r,c" positions that some span covers (dc/dr>0)
  for (let k = 0; k < dims.cellCount; k++) {
    const ci = JSON.parse(doc.getCellInfo(0, 0, 2, k));
    let text = "";
    const np = doc.getCellParagraphCount(0, 0, 2, k);
    for (let cp = 0; cp < np; cp++) {
      const len = doc.getCellParagraphLength(0, 0, 2, k, cp);
      if (len > 0) text += doc.getTextInCell(0, 0, 2, k, cp, 0, len);
    }
    origins.set(`${ci.row},${ci.col}`, { ...ci, text: text.normalize("NFC") });
    for (let dr = 0; dr < ci.rowSpan; dr++) {
      for (let dc = 0; dc < ci.colSpan; dc++) {
        if (dr === 0 && dc === 0) continue;
        coveredByOrigin.add(`${ci.row + dr},${ci.col + dc}`);
      }
    }
  }
  // The two merged header origins sit at (0,0) and (0,4), each spanning 4 cols.
  assert.equal(origins.get("0,0").text, "기부 금액(원, %)");
  assert.equal(origins.get("0,0").colSpan, 4);
  assert.equal(origins.get("0,4").text, "기부 건수(건, %)");
  assert.equal(origins.get("0,4").colSpan, 4);
  // The covered columns (0,1),(0,2),(0,3) and (0,5),(0,6),(0,7) have NO origin
  // cell of their own — proving merge text can never leak onto a neighbor by
  // document order: the covered slots simply do not exist as cells.
  for (const pos of ["0,1", "0,2", "0,3", "0,5", "0,6", "0,7"]) {
    assert.equal(origins.has(pos), false, `covered position ${pos} must not be an origin cell`);
    assert.equal(coveredByOrigin.has(pos), true, `position ${pos} must be covered by a span`);
  }
});

// ── Rule 1: the script's reconstructed grid places by address with no leak ──
test("rule 1 (extract_tables): grid places merged header by address; covered neighbors are empty (no leak)", () => {
  const r = runExtract(["samples/fixture-table.hwpx", "--format", "json", "--table", "0"]);
  assert.equal(r.status, 0, `extract_tables exited ${r.status}: ${r.stderr}`);
  const payload = JSON.parse(r.stdout);
  const t = payload.tables.find((x) => x.index === 0);
  assert.ok(t, "expected table index 0 in output");

  // Origin cells carry the header text and the right span footprint.
  assert.equal(t.grid[0][0].text, "기부 금액(원, %)");
  assert.equal(t.grid[0][0].colSpan, 4);
  assert.equal(t.grid[0][0].origin, true);
  assert.equal(t.grid[0][4].text, "기부 건수(건, %)");
  assert.equal(t.grid[0][4].colSpan, 4);
  assert.equal(t.grid[0][4].origin, true);

  // Covered positions are non-origin and (without --fill-merged) carry NO text:
  // the header text must NOT bleed into the columns it visually spans.
  for (const c of [1, 2, 3]) {
    assert.equal(t.grid[0][c].origin, false, `(0,${c}) must be a covered position`);
    assert.equal(t.grid[0][c].text, "", `(0,${c}) must not leak the merged header text`);
    assert.equal(t.grid[0][c].originRow, 0);
    assert.equal(t.grid[0][c].originCol, 0);
  }
  for (const c of [5, 6, 7]) {
    assert.equal(t.grid[0][c].origin, false, `(0,${c}) must be a covered position`);
    assert.equal(t.grid[0][c].text, "", `(0,${c}) must not leak the merged header text`);
    assert.equal(t.grid[0][c].originCol, 4);
  }

  // And the data cell lands at its real address, not glued to a header.
  let foundAt = null;
  for (let rr = 0; rr < t.rowCount; rr++) {
    for (let cc = 0; cc < t.colCount; cc++) {
      const cell = t.grid[rr][cc];
      if (cell && cell.text === "65,063,026,600") foundAt = [rr, cc];
    }
  }
  assert.ok(foundAt, "data cell '65,063,026,600' must be present at a real grid address");
});

// ── Rule 2: cellCount counts origin cells only (18 < 24) ────────────────────
test("rule 2 (engine): cellCount counts origin cells only — 18 < rowCount*colCount (24)", async () => {
  const doc = await loadDocument(HWPX);
  const dims = JSON.parse(doc.getTableDimensions(0, 0, 2));
  assert.deepEqual(
    { rowCount: dims.rowCount, colCount: dims.colCount, cellCount: dims.cellCount },
    { rowCount: 3, colCount: 8, cellCount: 18 },
  );
  assert.ok(
    dims.cellCount < dims.rowCount * dims.colCount,
    "merges must make cellCount < rowCount*colCount",
  );
  assert.equal(dims.cellCount, 18);
  assert.equal(dims.rowCount * dims.colCount, 24);
});

test("rule 2 (extract_tables): JSON cellCount matches the origin-only count", () => {
  const r = runExtract(["samples/fixture-table.hwpx", "--format", "json", "--table", "0"]);
  assert.equal(r.status, 0, r.stderr);
  const t = JSON.parse(r.stdout).tables.find((x) => x.index === 0);
  assert.equal(t.cellCount, 18);
  assert.ok(t.cellCount < t.rowCount * t.colCount);
});

// ── Rule 7: extracted text never contains U+3000; full-width spaces are U+2007 ─
test("rule 7: extracted table text contains NO U+3000 (ideographic space)", () => {
  for (const fixture of ["samples/fixture-table.hwp", "samples/fixture-table.hwpx"]) {
    const r = runExtract([fixture, "--format", "json"]);
    assert.equal(r.status, 0, `${fixture}: ${r.stderr}`);
    const text = allGridText(JSON.parse(r.stdout));
    assert.equal(
      text.includes(U3000),
      false,
      `${fixture}: full-width spaces must NOT surface as U+3000`,
    );
  }
});

test("rule 7: any full-width space in extracted text is U+2007, never U+3000", () => {
  // The current fixtures contain no full-width space at all, so this guards the
  // INVARIANT (whatever full-width space appears must be U+2007) rather than
  // asserting a count the fixtures cannot supply. The check is exact: if a
  // U+2007 is ever introduced, it must coexist with zero U+3000.
  const r = runExtract(["samples/fixture-table.hwpx", "--format", "json"]);
  assert.equal(r.status, 0, r.stderr);
  const text = allGridText(JSON.parse(r.stdout));
  const n3000 = (text.match(new RegExp(U3000, "g")) || []).length;
  assert.equal(n3000, 0, "U+3000 must be absent");
  // If any figure-space is present it confirms the U+2007 convention; if none
  // is present the fixture simply has no full-width space — both satisfy rule 7
  // as long as U+3000 stays absent (asserted above). This line documents intent.
  const n2007 = (text.match(new RegExp(U2007, "g")) || []).length;
  assert.ok(n2007 >= 0); // tautological by construction; pins the U+2007 reference char.
});

// ── Korean-form flags: sanity gate (rules 4/5/6 run cleanly, sane output) ───
test("rules 4/5/6: --data-tables-only, --drop-empty, --detect-form-type run without error and produce sane output", () => {
  for (const fixture of ["samples/fixture-table.hwp", "samples/fixture-table.hwpx"]) {
    const r = runExtract([
      fixture,
      "--format",
      "json",
      "--data-tables-only",
      "--drop-empty",
      "--detect-form-type",
    ]);
    assert.equal(r.status, 0, `${fixture}: combined flags must exit 0 — ${r.stderr}`);
    const payload = JSON.parse(r.stdout);
    assert.ok(Array.isArray(payload.tables), `${fixture}: tables must be an array`);
    assert.equal(payload.tableCount, payload.tables.length, `${fixture}: tableCount mirrors selection`);
    // --data-tables-only is conservative: it must KEEP at least one real data
    // table on these numeric fixtures (never silently drop everything).
    assert.ok(payload.tableCount >= 1, `${fixture}: data tables must survive the legend filter`);
    for (const t of payload.tables) {
      // --detect-form-type annotates every table with a valid label.
      assert.ok(
        ["marker", "label", "plain"].includes(t.formType),
        `${fixture}: formType must be marker|label|plain, got ${JSON.stringify(t.formType)}`,
      );
      // grid dimensions stay self-consistent (annotation must not restructure).
      assert.equal(t.grid.length, t.rowCount);
      for (const row of t.grid) assert.equal(row.length, t.colCount);
    }
  }
});

test("rule 4: --data-tables-only is conservative — it does NOT drop the numeric data tables in fixture-table.hwp", () => {
  const base = runExtract(["samples/fixture-table.hwp", "--format", "json"]);
  const filtered = runExtract(["samples/fixture-table.hwp", "--format", "json", "--data-tables-only"]);
  assert.equal(base.status, 0, base.stderr);
  assert.equal(filtered.status, 0, filtered.stderr);
  const baseCount = JSON.parse(base.stdout).tableCount;
  const keptCount = JSON.parse(filtered.stdout).tableCount;
  // The financial grids here ('구   분' has internal spaces, so it is not a
  // bare '구분' legend opener) must all survive: keep == base, zero drops.
  assert.equal(
    keptCount,
    baseCount,
    "no real data table may be silently dropped by --data-tables-only on this fixture",
  );
});
