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
  for (const op of ["bullet", "indent"]) {
    const r = run([FIX, "--op", op, ...TABLE, "--cell", "0", "--paragraphs", "0",
      ...(op === "bullet" ? ["--char", "○"] : ["--level", "1"]),
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
