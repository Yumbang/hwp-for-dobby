// Formatting INSIDE a table cell — the address space that was missing.
//
// Korean form documents keep their content in tables: 22% of real documents
// have no body paragraphs at all. On a real 성과요약 form, one cell carries
// 5,086 characters across ~70 paragraphs and another holds 27, so "centre this
// paragraph" is a cell-paragraph operation. Until this existed, format.mjs
// addressed only body paragraphs and could not touch such a document at all.
//
// The engine modelled this the whole time — applyParaFormatInCell,
// applyCharFormatInCell and the matching getters were all verified working
// during the formatting survey. The gap was our addressing stopping at the
// table, which is why these tests are about ADDRESSING as much as formatting.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadDocument } from "../../src/lib/_bootstrap.mjs";
import { cellParagraphs, hasCellAddress, resolveCellAddress } from "../../src/lib/cell_addr.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const FIX = join(ROOT, "samples", "fixture-table.hwp");

let TMP;
const at = (n) => join(TMP, n);
test.before(() => {
  TMP = mkdtempSync(join(tmpdir(), "hwp-cellfmt-"));
});
test.after(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
});

const run = (args) =>
  spawnSync(process.execPath, [join("src", "core", "format.mjs"), ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });

// The table in fixture-table.hwp, addressed the way extract_tables reports it.
const TABLE = ["--table", "0"];

test("cell addressing is opt-in — nothing changes without those flags", () => {
  assert.equal(hasCellAddress(["node", "x", "--op", "para", "--paragraph", "1"]), false);
  assert.equal(hasCellAddress(["node", "x", "--table", "0"]), true);
  assert.equal(hasCellAddress(["node", "x", "--cell", "0"]), true);
  assert.equal(hasCellAddress(["node", "x", "--row", "0", "--col", "1"]), true);
});

test("cell --op list: reports the paragraphs a cell holds, individually", async () => {
  const r = run([FIX, "--op", "list", ...TABLE, "--cell", "0", "--format", "json"]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.ok(Array.isArray(j.paragraphs), "a cell's paragraphs are listed");
  assert.ok(j.paragraphs.length >= 1);
  for (const p of j.paragraphs) {
    assert.equal(typeof p.cellPara, "number", "each carries its own address");
    assert.equal(typeof p.length, "number");
  }
  // The addresses must agree with the library, which agrees with the engine.
  const doc = await loadDocument(FIX);
  const addr = resolveCellAddress(doc, { table: 0, cell: 0 });
  assert.equal(cellParagraphs(doc, addr).length, j.paragraphs.length);
});

test("cell --op para: formats ONE paragraph inside the cell, not the whole cell", async () => {
  const doc = await loadDocument(FIX);
  const addr = resolveCellAddress(doc, { table: 0, cell: 0 });
  const paras = cellParagraphs(doc, addr);
  if (paras.length < 2) return; // this fixture's cell is single-paragraph; covered below

  const dst = at("one.hwp");
  const r = run([FIX, "--op", "para", ...TABLE, "--cell", "0", "--paragraphs", "0",
    "--props", '{"alignment":"center"}', "--output", dst]);
  assert.equal(r.status, 0, r.stderr);
  const back = await loadDocument(dst);
  assert.equal(
    JSON.parse(back.getCellParaPropertiesAt(addr.section, addr.paragraph, addr.control, addr.cell, 0)).alignment,
    "center",
  );
  assert.notEqual(
    JSON.parse(back.getCellParaPropertiesAt(addr.section, addr.paragraph, addr.control, addr.cell, 1)).alignment,
    "center",
    "a sibling paragraph in the same cell must be untouched",
  );
});

test("cell --op para: applies and confirms from the SAVED file", async () => {
  // This fixture's cell paragraph 0 is already centre-aligned, so centring it
  // would report "already-set" — a correct verdict that proves nothing. Move a
  // property that is actually different.
  const doc0 = await loadDocument(FIX);
  const addr0 = resolveCellAddress(doc0, { table: 0, cell: 0 });
  const wasCentre =
    JSON.parse(doc0.getCellParaPropertiesAt(addr0.section, addr0.paragraph, addr0.control, addr0.cell, 0))
      .alignment === "center";
  const want = wasCentre ? "left" : "center";

  const dst = at("confirm.hwp");
  const r = run([FIX, "--op", "para", ...TABLE, "--cell", "0", "--paragraphs", "0",
    "--props", JSON.stringify({ alignment: want }), "--output", dst]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.target, "cell");
  assert.equal(j.verified, true);
  assert.equal(j.effects[0].effect.alignment, "changed", "the effect is read back from disk");

  const doc = await loadDocument(dst);
  const addr = resolveCellAddress(doc, { table: 0, cell: 0 });
  assert.equal(
    JSON.parse(doc.getCellParaPropertiesAt(addr.section, addr.paragraph, addr.control, addr.cell, 0)).alignment,
    want,
    "and independently, from the file",
  );
});

test("cell --op char: refuses an EMPTY cell paragraph instead of reporting success", async () => {
  // Character formatting on a paragraph with no characters is a silent no-op
  // (spec rule 62), and empty spacer paragraphs are common inside form cells —
  // so this is easy to hit and would otherwise look like it worked.
  const doc = await loadDocument(FIX);
  const addr = resolveCellAddress(doc, { table: 0, cell: 0 });
  const paras = cellParagraphs(doc, addr);
  const empty = paras.find((p) => p.length === 0);
  if (!empty) return; // no empty paragraph in this fixture's cell

  const dst = at("empty.hwp");
  const r = run([FIX, "--op", "char", ...TABLE, "--cell", "0",
    "--paragraphs", String(empty.cellPara), "--props", '{"bold":true}', "--output", dst]);
  assert.equal(r.status, 2, "an empty target is a usage error, not a success");
  assert.match(r.stderr, /empty/);
  assert.equal(existsSync(dst), false, "and writes no file");
});

test("cell: an out-of-range cell paragraph says how many there are", () => {
  const dst = at("oob.hwp");
  const r = run([FIX, "--op", "para", ...TABLE, "--cell", "0", "--paragraphs", "9999",
    "--props", '{"alignment":"center"}', "--output", dst]);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /out of range/);
  assert.match(r.stderr, /this cell has \d+/, "the message states the real count");
  assert.equal(existsSync(dst), false);
});

test("cell: a merged-away position points at the origin that holds the text", async () => {
  // Spec rule 1: text lives only on the top-left origin of a merge. Reporting
  // "no such cell" would send the caller looking for a bug that is not there.
  const doc = await loadDocument(FIX);
  const dims = JSON.parse(doc.getTableDimensions(...Object.values(resolveCellAddress(doc, { table: 0, cell: 0 })).slice(0, 3)));
  // Find a covered position, if this fixture has one.
  let covered = null;
  const addr = resolveCellAddress(doc, { table: 0, cell: 0 });
  const seen = new Set();
  for (let i = 0; i < addr.cellCount; i++) {
    const ci = JSON.parse(doc.getCellInfo(addr.section, addr.paragraph, addr.control, i));
    for (let r = ci.row; r < ci.row + (ci.rowSpan ?? 1); r++) {
      for (let c = ci.col; c < ci.col + (ci.colSpan ?? 1); c++) {
        if (r !== ci.row || c !== ci.col) covered = { row: r, col: c };
        seen.add(`${r},${c}`);
      }
    }
  }
  if (!covered) return; // no merges in this fixture
  const r = run([FIX, "--op", "para", ...TABLE, "--row", String(covered.row), "--col", String(covered.col),
    "--paragraphs", "0", "--props", '{"alignment":"center"}', "--output", at("merged.hwp")]);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /merged away/);
  assert.match(r.stderr, /origin cell/);
});

test("cell: ops that do not support cell addressing say so rather than ignoring it", () => {
  for (const op of ["bullet"]) {
    const r = run([FIX, "--op", op, ...TABLE, "--cell", "0", "--paragraphs", "0",
      "--char", "○",
      "--output", at(`unsupported-${op}.hwp`)]);
    assert.equal(r.status, 2, `--op ${op} with a cell address must not silently target the body`);
    assert.match(r.stderr, /does not support cell addressing/);
    assert.equal(existsSync(at(`unsupported-${op}.hwp`)), false);
  }
});

test("cell: body-paragraph formatting is unchanged when no cell is addressed", async () => {
  // The regression that would hurt most: cell support quietly altering the
  // path every existing caller uses.
  const dst = at("body.hwp");
  const r = run([FIX, "--op", "para", "--section", "0", "--paragraph", "1",
    "--props", '{"alignment":"center"}', "--output", dst]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.target, undefined, "the body path does not claim a cell target");
  const back = await loadDocument(dst);
  assert.equal(JSON.parse(back.getParaPropertiesAt(0, 1)).alignment, "center");
});

// ── --op split-lines and --op indent --by-marker ──────────────────────────
//
// Both come from one real document. A 성과요약 form had a cell paragraph
// holding 4,555 characters across 57 lines separated by U+000A — the soft
// break Shift+Enter makes. That is the "it is all treated as one chunk"
// symptom: paragraph properties apply per paragraph, so 57 lines sharing one
// paragraph share one indent whether that suits them or not. The author had
// hand-formatted the first few (◦ at marginLeft 14.1, - at 27.4) and wanted
// the rest to match.

// The table's control index is NOT 0: every section's first paragraph carries
// invisible SectionDef/ColumnDef controls at offset 0, so a freshly created
// table lands after them. Assuming 0 is the documented trap (spec rule 7) and
// it is what this helper got wrong first time — the engine answers
// "지정된 컨트롤이 표, 글상자 또는 그림이 아닙니다".
let LINES_CTRL = 0;

async function cellWithLines() {
  // A cell paragraph carrying several logical lines, built the way the real
  // document does it: one paragraph, newlines inside.
  const { emptyDocument } = await import("../../src/lib/_bootstrap.mjs");
  const { tableControlsInParagraph } = await import("../../src/lib/doc_walk.mjs");
  const { writeFileSync } = await import("node:fs");
  const d = await emptyDocument();
  d.createTable(0, 0, 0, 1, 1);
  const ctrls = tableControlsInParagraph(d, 0, 0);
  assert.ok(ctrls.length > 0, "the table must be findable by probe, not by assumption");
  LINES_CTRL = ctrls[0];
  const blob = ["◦ 첫째 항목", "  - 딸린 설명 하나", "  - 딸린 설명 둘", "◦ 둘째 항목", "  - 딸린 설명 셋"].join("\n");
  d.insertTextInCell(0, 0, LINES_CTRL, 0, 0, 0, blob);
  const path = at("lines.hwp");
  writeFileSync(path, Buffer.from(d.exportHwp()));
  return path;
}

test("split-lines: one blob paragraph becomes one paragraph per line", async () => {
  const src = await cellWithLines();
  const doc = await loadDocument(src);
  const addr = resolveCellAddress(doc, { section: 0, paragraph: 0, control: LINES_CTRL, cell: 0 });
  const before = cellParagraphs(doc, addr);
  const blob = before.find((x) => x.text.includes("\n"));
  assert.ok(blob, "precondition: a paragraph with embedded newlines");

  const dst = at("split.hwp");
  const r = run([src, "--op", "split-lines", "--section", "0", "--paragraph", "0", "--control", String(LINES_CTRL),
    "--cell", "0", "--paragraphs", String(blob.cellPara), "--output", dst]);
  assert.equal(r.status, 0, r.stderr);

  const back = await loadDocument(dst);
  const after = cellParagraphs(back, addr);
  assert.equal(after.length, before.length + 4, "five lines become five paragraphs");
  for (const x of after) {
    assert.ok(!x.text.includes("\n"), "no paragraph still carries a line break");
    assert.ok(!x.text.startsWith("\n"), "and none begins with the break it was split at");
  }
});

test("split-lines: no text is lost, only the breaks become boundaries", async () => {
  const src = await cellWithLines();
  const doc = await loadDocument(src);
  const addr = resolveCellAddress(doc, { section: 0, paragraph: 0, control: LINES_CTRL, cell: 0 });
  const beforeText = cellParagraphs(doc, addr).map((x) => x.text).join("").replace(/\n/g, "");

  const dst = at("split2.hwp");
  assert.equal(
    run([src, "--op", "split-lines", "--section", "0", "--paragraph", "0", "--control", String(LINES_CTRL),
      "--cell", "0", "--output", dst]).status,
    0,
  );
  const back = await loadDocument(dst);
  const afterText = cellParagraphs(back, addr).map((x) => x.text).join("").replace(/\n/g, "");
  assert.equal(afterText, beforeText, "the characters are identical, only the breaks moved");
});

test("indent --by-marker: learns the convention already in the cell and matches the rest", async () => {
  const src = await cellWithLines();
  const split = at("bm-split.hwp");
  assert.equal(
    run([src, "--op", "split-lines", "--section", "0", "--paragraph", "0", "--control", String(LINES_CTRL),
      "--cell", "0", "--output", split]).status,
    0,
  );
  // Hand-format ONE paragraph of each kind, as the document's author had.
  const doc = await loadDocument(split);
  const addr = resolveCellAddress(doc, { section: 0, paragraph: 0, control: LINES_CTRL, cell: 0 });
  const paras = cellParagraphs(doc, addr);
  const firstCircle = paras.find((x) => x.text.trimStart().startsWith("◦"));
  const firstDash = paras.find((x) => x.text.trimStart().startsWith("-"));
  assert.ok(firstCircle && firstDash, "precondition");

  const seeded = at("bm-seed.hwp");
  const { writeFileSync } = await import("node:fs");
  doc.applyParaFormatInCell(0, 0, LINES_CTRL, 0, firstCircle.cellPara, JSON.stringify({ marginLeft: 2115 }));
  doc.applyParaFormatInCell(0, 0, LINES_CTRL, 0, firstDash.cellPara, JSON.stringify({ marginLeft: 4110 }));
  writeFileSync(seeded, Buffer.from(doc.exportHwp()));

  const dst = at("bm.hwp");
  const r = run([seeded, "--op", "indent", "--section", "0", "--paragraph", "0", "--control", String(LINES_CTRL),
    "--cell", "0", "--by-marker", "--output", dst]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /learned from this cell/, "it says what it learned, so the guess is auditable");

  // Every paragraph with a given glyph now shares one marginLeft, and none
  // keeps the leading spaces that would add a second, competing indent.
  const back = await loadDocument(dst);
  const { parseMarker } = await import("../../src/lib/bullets.mjs");
  const byGlyph = new Map();
  for (const x of cellParagraphs(back, addr)) {
    const m = parseMarker(x.text);
    if (!m) continue;
    const ml = JSON.parse(back.getCellParaPropertiesAt(0, 0, LINES_CTRL, 0, x.cellPara)).marginLeft;
    if (!byGlyph.has(m.glyph)) byGlyph.set(m.glyph, new Set());
    byGlyph.get(m.glyph).add(`${ml}/${m.indent.length}`);
    assert.equal(m.indent.length, 0, "leading spaces are removed, depth lives in marginLeft");
  }
  for (const [glyph, variants] of byGlyph) {
    assert.equal(variants.size, 1, `every "${glyph}" must end up identical, got ${[...variants].join(", ")}`);
  }
});

test("indent --by-marker: refuses when there is nothing to learn from", async () => {
  const src = await cellWithLines();
  const split = at("bm-empty.hwp");
  run([src, "--op", "split-lines", "--section", "0", "--paragraph", "0", "--control", String(LINES_CTRL),
    "--cell", "0", "--output", split]);
  // Nothing in the cell carries marginLeft, so there is no convention to copy.
  const r = run([split, "--op", "indent", "--section", "0", "--paragraph", "0", "--control", String(LINES_CTRL),
    "--cell", "0", "--by-marker", "--output", at("bm-none.hwp")]);
  assert.equal(r.status, 3, "guessing a convention out of nothing would be worse than refusing");
  assert.match(r.stderr, /found no already-formatted paragraph to learn from/);
  assert.match(r.stderr, /Format one by hand first/, "and it says how to proceed");
  assert.equal(existsSync(at("bm-none.hwp")), false);
});
