// Engine facts the shared walk/classify layer depends on (spec §6, rules 30-33)
// plus the strict argv contract.
//
// Three of these are refutations — behaviors that LOOK available and are not.
// They are pinned as tests because the cost of re-learning them is silent data
// loss: a dropped table, or every equation in the document vanishing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { emptyDocument, loadDocument } from "../../src/lib/_bootstrap.mjs";
import {
  BODY_EQUATION_CELL,
  classifyControl,
  classifyParagraphControls,
  controlOffsets,
  documentHasTable,
  isNotEquationError,
  isNotTableError,
  isOutOfRangeError,
  tableControlsInParagraph,
} from "../../src/lib/doc_walk.mjs";
import { flag, intArg, strArg } from "../../src/lib/argv.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const sample = (f) => join(ROOT, "samples", f);

// A paragraph carrying: plain text, two equations and one footnote.
async function inlineDoc() {
  const doc = await emptyDocument();
  doc.insertText(0, 0, 0, "앞부분 텍스트 XX 중간 YY 끝부분");
  doc.insertEquation(0, 0, 11, "x^2 + y^2 = z^2", 10, 0);
  doc.insertEquation(0, 0, 18, "sqrt {a over b}", 10, 0);
  doc.insertFootnote(0, 0, 20);
  return doc;
}

// ── rule 30: controls are zero-width, in getTextRange coordinates ──────────

test("rule 30: inline controls take no space in the paragraph's text", async () => {
  const doc = await emptyDocument();
  doc.insertText(0, 0, 0, "앞부분 텍스트 XX 중간 YY 끝부분");
  const before = doc.getTextRange(0, 0, 0, 0x7fffffff);
  doc.insertEquation(0, 0, 11, "x^2 + y^2 = z^2", 10, 0);
  doc.insertFootnote(0, 0, 18);
  const after = doc.getTextRange(0, 0, 0, 0x7fffffff);
  assert.equal(
    after,
    before,
    "inserting an equation and a footnote must not change the paragraph text — " +
      "inline splicing depends on controls being zero-width",
  );
});

test("rule 30: control offsets are inside the paragraph's text range", async () => {
  const doc = await inlineDoc();
  const text = doc.getTextRange(0, 0, 0, 0x7fffffff);
  const offsets = controlOffsets(doc, 0, 0);
  assert.ok(offsets.length >= 3, `expected the inserted controls, got ${JSON.stringify(offsets)}`);
  for (const off of offsets) {
    assert.ok(
      Number.isInteger(off) && off >= 0 && off <= text.length,
      `control offset ${off} is outside 0..${text.length}`,
    );
  }
});

test("rule 30: a section's first paragraph carries invisible controls at offset 0", async () => {
  // Every section opens with SectionDef/ColumnDef controls. Rendering every
  // control as an object would print phantom markers at position 0 of every
  // section, so they must classify as 'other'.
  for (const f of ["fixture-table.hwp", "fixture-table.hwpx", "fixture-form.hwp"]) {
    const doc = await loadDocument(sample(f));
    const kinds = classifyParagraphControls(doc, 0, 0);
    assert.ok(kinds.length >= 2, `${f}: expected invisible controls at (0,0)`);
    assert.equal(kinds[0].kind, "other", `${f}: control 0 of paragraph 0 should be invisible`);
    assert.equal(kinds[0].offset, 0, `${f}: invisible controls sit at offset 0`);
    assert.equal(kinds[1].kind, "other", `${f}: control 1 of paragraph 0 should be invisible`);
  }
});

// ── rule 31: findNearestControlForward is NOT an enumerator ────────────────

test("rule 31: findNearestControlForward SKIPS controls (never enumerate with it)", async () => {
  // fixture-form.hwp holds field controls in paragraphs 2/4/6/8/10. A forward
  // chain from (0,0,0) reports one of them. If a future engine version makes
  // this complete, this test fails — and that is the signal to reconsider it,
  // not a reason to trust it silently.
  const doc = await loadDocument(sample("fixture-form.hwp"));
  const seen = [];
  let s = 0;
  let p = 0;
  let off = 0;
  for (let guard = 0; guard < 50; guard++) {
    let o;
    try {
      o = JSON.parse(doc.findNearestControlForward(s, p, off));
    } catch {
      break;
    }
    if (!o || o.sec == null) break;
    seen.push(`${o.sec}/${o.para}/${o.ci}`);
    s = o.sec;
    p = o.para;
    off = (o.charPos ?? 0) + 1;
  }

  let actual = 0;
  for (let pp = 0; pp < doc.getParagraphCount(0); pp++) actual += controlOffsets(doc, 0, pp).length;

  assert.ok(actual > seen.length, `sweep saw ${seen.length}, document has ${actual} controls`);
});

test("rule 31: a forward sweep can miss a table that getControlTextPositions finds", async () => {
  // fixture-table.hwpx's only table is control 2 of paragraph 0. A forward
  // sweep from (0,0,0) finds nothing at all.
  const doc = await loadDocument(sample("fixture-table.hwpx"));
  const fwd = JSON.parse(doc.findNearestControlForward(0, 0, 0));
  assert.equal(fwd.type, "none", "forward sweep unexpectedly saw the table");
  assert.deepEqual(
    tableControlsInParagraph(doc, 0, 0),
    [2],
    "the enumerate-and-probe path must still find the table",
  );
  assert.equal(documentHasTable(doc), true);
});

// ── rules 32-33: the equation probe trap ───────────────────────────────────

test("rule 32: getEquationProperties with cell (0,0) reports 'not a table' — the trap", async () => {
  const doc = await inlineDoc();
  const eqIdx = classifyParagraphControls(doc, 0, 0).find((c) => c.kind === "equation")?.index;
  assert.notEqual(eqIdx, undefined, "the fixture must contain an equation");

  // The wrong call: cell indices (0,0) route into the table lookup, and the
  // engine answers with the SAME message the table probe uses for "skip this".
  let trapped;
  try {
    doc.getEquationProperties(0, 0, eqIdx, 0, 0);
    trapped = null;
  } catch (e) {
    trapped = e;
  }
  assert.ok(trapped, "(0,0) must throw on a body equation");
  assert.ok(
    isNotTableError(trapped),
    `expected the 'not a table' message, got: ${trapped?.message ?? trapped}`,
  );
  assert.equal(
    isNotEquationError(trapped),
    false,
    "the trap is precisely that this does NOT say 'not an equation'",
  );
});

test("rule 33: getEquationProperties with (-1,-1) returns the body equation's script", async () => {
  const doc = await inlineDoc();
  const props = JSON.parse(
    doc.getEquationProperties(0, 0, 2, BODY_EQUATION_CELL, BODY_EQUATION_CELL),
  );
  assert.equal(props.script, "x^2 + y^2 = z^2");
  assert.equal(BODY_EQUATION_CELL, -1);
});

test("rule 33: the engine's error messages discriminate kind from out-of-range", async () => {
  const doc = await inlineDoc();
  let wrongKind;
  try {
    doc.getEquationProperties(0, 0, 0, BODY_EQUATION_CELL, BODY_EQUATION_CELL);
  } catch (e) {
    wrongKind = e;
  }
  assert.ok(isNotEquationError(wrongKind), `wrong-kind message changed: ${wrongKind?.message}`);
  assert.equal(isOutOfRangeError(wrongKind), false);

  let oob;
  try {
    doc.getEquationProperties(0, 0, 99, BODY_EQUATION_CELL, BODY_EQUATION_CELL);
  } catch (e) {
    oob = e;
  }
  assert.ok(isOutOfRangeError(oob), `out-of-range message changed: ${oob?.message}`);
  assert.equal(isNotEquationError(oob), false);
});

test("classifyControl: table / equation / footnote / other are all distinguished", async () => {
  const doc = await inlineDoc();
  const kinds = classifyParagraphControls(doc, 0, 0).map((c) => c.kind);
  assert.deepEqual(kinds, ["other", "other", "equation", "equation", "footnote"]);

  const fn = classifyParagraphControls(doc, 0, 0).find((c) => c.kind === "footnote");
  // getFootnoteInfo's 5-key shape; a fresh footnote's body is two spaces.
  assert.equal(fn.number, 1);
  assert.ok(Array.isArray(fn.texts));
  assert.equal(fn.paraCount, 1);
  assert.equal(typeof fn.totalTextLen, "number");

  const tableDoc = await loadDocument(sample("fixture-table.hwpx"));
  assert.equal(classifyControl(tableDoc, 0, 0, 2).kind, "table");
  assert.deepEqual(classifyControl(tableDoc, 0, 0, 2).dims, {
    rowCount: 3,
    colCount: 8,
    cellCount: 18,
  });
});

// ── strict argv ────────────────────────────────────────────────────────────

test("argv: a flag consumed as another flag's value is a usage error, not a value", () => {
  const argv = ["node", "s.mjs", "in.hwp", "--table", "--format", "markdown"];
  // strArg/intArg exit the process on failure, so assert the accept path here
  // and let the golden cases (tables/table-index-missing-value) pin the exit.
  assert.equal(strArg("--format", "json", argv), "markdown");
  assert.equal(strArg("--missing", "dflt", argv), "dflt");
  assert.equal(flag("--table", argv), true);
  assert.equal(flag("--nope", argv), false);
});

test("argv: intArg accepts clean non-negative integers only", () => {
  assert.equal(intArg("--n", 3, ["node", "s", "--n", "0"]), 0);
  assert.equal(intArg("--n", 3, ["node", "s", "--n", "42"]), 42);
  assert.equal(intArg("--n", 3, ["node", "s"]), 3);
});
