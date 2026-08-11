// The block stream (lib/blocks.mjs) and HWP equation scripts (lib/eqn.mjs).
//
// Three properties are pinned here because getting any of them wrong is silent
// — the output still looks like a document, it is just a different one:
//
//   1. INLINE POSITIONS. Controls are zero-width and their offsets share
//      getTextRange's coordinate system, so a spliced equation belongs at an
//      EXACT character index. These tests assert indices, not `.includes()`:
//      "the equation is in there somewhere" passes for an equation spliced into
//      the wrong sentence.
//   2. THE (-1,-1) EQUATION TRAP. Probing a body equation with cell indices
//      (0,0) throws "지정된 컨트롤이 표가 아닙니다" — the same message the table
//      probe uses to mean "not a table, skip". A renderer that ports the table
//      probe's error handling loses every equation in every document and
//      reports nothing. So: assert the equations ARE rendered, and assert
//      separately that the wrong call still throws the misleading message.
//   3. THE CALL BUDGET. The lazy layering is a design requirement, not an
//      optimization someone can quietly undo. If `props()` becomes eager the
//      counter moves, and these tests fail.
//
// And for eqn.mjs, the honesty rule: a formula it cannot fully translate must
// come back `complete: false` with the tokens named, never as plausible LaTeX.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { emptyDocument, loadDocument } from "../../src/lib/_bootstrap.mjs";
import { buildBlocks } from "../../src/lib/blocks.mjs";
import { BODY_EQUATION_CELL, isNotTableError, isNotEquationError } from "../../src/lib/doc_walk.mjs";
import { equationToLatex, normalizeEquationScript } from "../../src/lib/eqn.mjs";
import { FIXTURE_DATA } from "../../scripts/build-fixtures.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const sample = (f) => join(ROOT, "samples", f);

const inlineModel = async () => buildBlocks(await loadDocument(sample("fixture-inline.hwp")));

// Two equations clamped past the end of a short paragraph, so both controls
// land on the SAME offset. Built rather than committed because the point is the
// collision, and a fixture cannot promise the engine keeps clamping the same
// way — if it stops, this doc stops colliding and the test says so.
async function tiedDoc() {
  const doc = await emptyDocument();
  doc.insertText(0, 0, 0, "짧은 문장");
  doc.insertEquation(0, 0, 999, "a over b", 10, 0);
  doc.insertEquation(0, 0, 999, "c over d", 10, 0);
  return doc;
}

// ── inline splicing lands on exact character positions ─────────────────────

test("splice: equations and the footnote land at their exact offsets", async () => {
  const model = await inlineModel();
  const rendered = model.renderSpan(0, 0, { footnoteBodies: false });
  const text = FIXTURE_DATA.INLINE_TEXT;
  const { eq1, eq2, footnote } = FIXTURE_DATA.INLINE_OFFSETS;

  // The text BEFORE each control is untouched, so each control's rendering
  // starts exactly where the original text's prefix ends. That is the property
  // zero-width controls buy, and the one an approximate splice loses.
  const eq1Rendered = `$${FIXTURE_DATA.INLINE_EQ1}$`;
  const eq2Rendered = `$${FIXTURE_DATA.INLINE_EQ2}$`;
  const noteRendered = "[^1]";

  assert.equal(rendered.indexOf(eq1Rendered), eq1, "equation 1 is not at its offset");
  assert.equal(
    rendered.indexOf(eq2Rendered),
    eq2 + eq1Rendered.length,
    "equation 2 must sit at its own offset shifted only by what precedes it",
  );
  assert.equal(
    rendered.indexOf(noteRendered),
    footnote + eq1Rendered.length + eq2Rendered.length,
    "the footnote marker must sit at its own offset shifted only by what precedes it",
  );

  // Reassembling the pieces reproduces the paragraph exactly: nothing was
  // dropped, duplicated or reordered.
  const stripped = rendered
    .replace(eq1Rendered, "")
    .replace(eq2Rendered, "")
    .replace(noteRendered, "");
  assert.equal(stripped, text, "the body text must survive the splice unchanged");

  // And the rendered order is document order.
  assert.ok(
    rendered.indexOf(eq1Rendered) < rendered.indexOf(eq2Rendered) &&
      rendered.indexOf(eq2Rendered) < rendered.indexOf(noteRendered),
  );
});

test("splice: descending order means an earlier splice never shifts a later offset", async () => {
  // The same assertion stated as arithmetic: the total length is the text plus
  // exactly what was inserted, so nothing overlapped or was clipped.
  const model = await inlineModel();
  const rendered = model.renderSpan(0, 0, { footnoteBodies: false });
  const inserted =
    `$${FIXTURE_DATA.INLINE_EQ1}$`.length + `$${FIXTURE_DATA.INLINE_EQ2}$`.length + "[^1]".length;
  assert.equal(rendered.length, FIXTURE_DATA.INLINE_TEXT.length + inserted);
});

// ── the (-1,-1) equation trap ──────────────────────────────────────────────

test("trap: the renderer FINDS the body equations (a (0,0) probe would lose them)", async () => {
  const model = await inlineModel();
  const kinds = model.controls(0).map((c) => c.kind);
  assert.deepEqual(kinds, ["other", "other", "equation", "equation", "footnote"]);
  assert.equal(model.stats.equations, 2, "both equations must be discovered, not skipped");

  const rendered = model.renderSpan(0, 0);
  assert.ok(rendered.includes(FIXTURE_DATA.INLINE_EQ1), "equation 1 vanished from the output");
  assert.ok(rendered.includes(FIXTURE_DATA.INLINE_EQ2), "equation 2 vanished from the output");
});

test("trap: getEquationProperties with cell (0,0) still reports 'not a table'", async () => {
  const doc = await loadDocument(sample("fixture-inline.hwp"));
  const model = await buildBlocks(doc);
  const eq = model.controls(0).find((c) => c.kind === "equation");
  assert.ok(eq, "the fixture must contain an equation");

  let trapped;
  try {
    doc.getEquationProperties(0, 0, eq.index, 0, 0);
  } catch (e) {
    trapped = e;
  }
  assert.ok(trapped, "(0,0) must throw on a body equation");
  assert.ok(
    isNotTableError(trapped),
    `the trap message changed: ${trapped?.message ?? trapped}`,
  );
  assert.equal(
    isNotEquationError(trapped),
    false,
    "the trap is precisely that this does NOT say 'not an equation'",
  );

  // The right call, for contrast.
  const props = JSON.parse(
    doc.getEquationProperties(0, 0, eq.index, BODY_EQUATION_CELL, BODY_EQUATION_CELL),
  );
  assert.equal(props.script, FIXTURE_DATA.INLINE_EQ1);
});

// ── the invisible SectionDef/ColumnDef pair renders nothing ────────────────

test("invisible controls: a section's first block renders exactly its own text", async () => {
  // Every section opens with SectionDef/ColumnDef controls at offset 0. If they
  // rendered, every section would gain a phantom marker at position 0 — and on
  // an empty first paragraph (very common) that marker would be the ONLY
  // output, which is how it goes unnoticed.
  for (const f of ["fixture-headings.hwp", "fixture-clause.hwp", "fixture-form.hwp"]) {
    const model = await buildBlocks(await loadDocument(sample(f)));
    const first = model.blocks[0];
    const kinds = model.controls(0).map((c) => c.kind);
    assert.ok(kinds.length >= 2, `${f}: expected the invisible pair at (0,0)`);
    assert.deepEqual(kinds.slice(0, 2), ["other", "other"], `${f}: the pair must classify as other`);
    assert.equal(
      model.renderSpan(0, 0),
      first.text,
      `${f}: the invisible controls must contribute nothing`,
    );
  }
});

test("invisible controls: 'other' controls stay invisible even next to a real one", async () => {
  // fixture-table.hwp's paragraph 0 carries the invisible pair AND a table.
  // Rendering must produce the table and nothing else.
  const model = await buildBlocks(await loadDocument(sample("fixture-table.hwp")));
  assert.deepEqual(model.controls(0).map((c) => c.kind), ["other", "other", "table"]);
  const rendered = model.renderSpan(0, 0);
  assert.ok(rendered.startsWith("|"), `expected a markdown table, got ${JSON.stringify(rendered.slice(0, 40))}`);
});

// ── footnotes ──────────────────────────────────────────────────────────────

test("footnote: the body is recovered including its two trailing spaces", async () => {
  const model = await inlineModel();
  const note = model.controls(0).find((c) => c.kind === "footnote");
  assert.ok(note, "the fixture must contain a footnote");

  // getFootnoteInfo's 5-key shape, and the quirk: a footnote's text comes back
  // with two trailing spaces. Preserved rather than trimmed — the extracted
  // text should match the document, not a tidied version of it.
  assert.equal(note.paraCount, 1);
  assert.deepEqual(note.texts, [`${FIXTURE_DATA.INLINE_FOOTNOTE_TEXT}  `]);
  assert.equal(note.number, 1);

  const rendered = model.renderSpan(0, 0);
  assert.ok(
    rendered.endsWith(`[^1]: ${FIXTURE_DATA.INLINE_FOOTNOTE_TEXT}  `),
    `the trailing spaces were lost: ${JSON.stringify(rendered.slice(-30))}`,
  );

  // trimFootnotes is the opt-out for callers who want prose.
  const trimmed = model.renderSpan(0, 0, { trimFootnotes: true });
  assert.ok(trimmed.endsWith(`[^1]: ${FIXTURE_DATA.INLINE_FOOTNOTE_TEXT}`));
  assert.equal(trimmed.endsWith("  "), false);
});

test("footnote: bodies follow the span, markers stay inline", async () => {
  const model = await inlineModel();
  const rendered = model.renderSpan(0, 0);
  const markerAt = rendered.indexOf("[^1]");
  const bodyAt = rendered.indexOf("[^1]:");
  assert.ok(markerAt >= 0 && bodyAt > markerAt, "the body must come after the marker");
  assert.equal(model.renderSpan(0, 0, { footnotes: false }).includes("[^1]"), false);
});

// ── tables splice as real grids ────────────────────────────────────────────

test("table: a table splices in as a markdown grid at its control's position", async () => {
  const model = await buildBlocks(await loadDocument(sample("fixture-table-only.hwp")));
  const i = model.blocks.findIndex((b) => b.hasTable);
  assert.ok(i >= 0, "fixture-table-only.hwp must contain a table");

  const rendered = model.renderSpan(i, i);
  const rows = rendered.trimEnd().split("\n");
  // Header row, separator, then one row per data row of the fixture.
  assert.equal(rows.length, 1 + 1 + FIXTURE_DATA.TABLE_ONLY_ROWS.length);
  assert.ok(rows.every((r) => r.startsWith("|")), "every line must be a grid row");
  assert.match(rows[1], /^\|( --- \|)+$/, "row 2 must be the markdown separator");
  assert.ok(rows[0].includes(FIXTURE_DATA.TABLE_ONLY_HEADER), "the merged title row is missing");
  for (const cell of FIXTURE_DATA.TABLE_ONLY_ROWS.flat()) {
    assert.ok(rendered.includes(cell), `cell ${JSON.stringify(cell)} is missing from the grid`);
  }
});

test("table: tableMode 'cells' emits a placeholder and reads no cells", async () => {
  const doc = await loadDocument(sample("fixture-table.hwp"));
  const model = await buildBlocks(doc, { tableMode: "cells" });
  const i = model.blocks.findIndex((b) => b.hasTable && b.p === 4);
  const before = model.stats.engineCalls;
  const rendered = model.renderSpan(i, i);
  assert.equal(rendered, "[table 9×8: section 0, paragraph 4, control 0]");
  // The dims come from the classification probe that already ran; a placeholder
  // must not pay for the ~275 calls that reading the cells costs.
  assert.ok(
    model.stats.engineCalls - before < 20,
    `a placeholder cost ${model.stats.engineCalls - before} engine calls`,
  );
});

test("table: 'body' mode renders the same table as a full grid", async () => {
  const model = await buildBlocks(await loadDocument(sample("fixture-table.hwp")));
  const i = model.blocks.findIndex((b) => b.hasTable && b.p === 4);
  const rendered = model.renderSpan(i, i);
  assert.ok(rendered.startsWith("| 구   분 |"), rendered.slice(0, 60));
  assert.equal(rendered.trimEnd().split("\n").length, 9 + 1, "9 rows plus the separator");
});

// ── ties ───────────────────────────────────────────────────────────────────

test("ties: two controls at one offset render deterministically, in document order", async () => {
  const doc = await tiedDoc();
  const offsets = JSON.parse(doc.getControlTextPositions(0, 0));
  assert.deepEqual(offsets, [0, 0, 5, 5], `the clamp no longer collides: ${JSON.stringify(offsets)}`);

  const model = await buildBlocks(doc);
  const first = model.renderSpan(0, 0);
  const second = model.renderSpan(0, 0);
  assert.equal(first, second, "the same span must render identically twice");

  // A fresh document, fresh model: the ordering is a property of the comparator,
  // not of one model's memoized state.
  const model2 = await buildBlocks(await tiedDoc());
  assert.equal(model2.renderSpan(0, 0), first);

  // Lower control index first — that is document order at a shared offset.
  assert.equal(first, "짧은 문장$a over b$$c over d$");
});

// ── the call budget ────────────────────────────────────────────────────────

test("perf: building the model costs about 2 engine calls per paragraph", async () => {
  const doc = await loadDocument(sample("fixture-table.hwp"));
  const model = await buildBlocks(doc);

  assert.equal(model.stats.paragraphs, 87, "fixture-table.hwp is the 87-paragraph case");
  assert.equal(model.stats.blocks, 87);
  assert.equal(model.stats.tables, 12);

  // Pass 1 is getTextRange + getControlTextPositions per paragraph plus one
  // cheap table probe per control. Anything materially above 3/paragraph means
  // a per-paragraph property read crept back in.
  assert.ok(
    model.stats.engineCalls <= 3 * model.stats.paragraphs,
    `${model.stats.engineCalls} calls for ${model.stats.paragraphs} paragraphs ` +
      `(${(model.stats.engineCalls / model.stats.paragraphs).toFixed(2)}/paragraph)`,
  );
});

test("perf: touching no props() keeps the count flat, and each props() costs 3", async () => {
  const doc = await loadDocument(sample("fixture-table.hwp"));
  const model = await buildBlocks(doc);
  const afterBuild = model.stats.engineCalls;

  // Reading the eagerly-known fields of every block spends nothing.
  let chars = 0;
  for (const b of model.blocks) chars += b.text.length + b.tableIndices.length + (b.hasTable ? 1 : 0);
  assert.ok(chars > 0);
  assert.equal(model.stats.engineCalls, afterBuild, "reading block data must be free");

  // One props() is one memoized set of three reads: para properties, style,
  // character properties.
  model.blocks[1].props();
  assert.equal(model.stats.engineCalls, afterBuild + 3);
  model.blocks[1].props();
  assert.equal(model.stats.engineCalls, afterBuild + 3, "props() must memoize");
});

test("perf: a second buildBlocks(doc) is free (WeakMap memoization)", async () => {
  const doc = await loadDocument(sample("fixture-table.hwp"));
  const first = await buildBlocks(doc);
  const spent = first.stats.engineCalls;

  const second = await buildBlocks(doc);
  assert.equal(second, first, "the same options must return the same model object");
  assert.equal(first.stats.engineCalls, spent, "a cache hit must add zero engine calls");

  // Different options are a different walk, not a silent cache hit on someone
  // else's settings.
  const other = await buildBlocks(doc, { tableMode: "cells" });
  assert.notEqual(other, first);
  assert.equal(other.stats.paragraphs, first.stats.paragraphs);
});

test("perf: nested-table probing is off by default and costs when turned on", async () => {
  const doc = await loadDocument(sample("fixture-table.hwp"));
  const flat = await buildBlocks(doc, { maxDepth: 1 });
  const deep = await buildBlocks(doc, { maxDepth: 3 });
  const i = flat.blocks.findIndex((b) => b.hasTable && b.p === 4);

  const flatBefore = flat.stats.engineCalls;
  flat.renderSpan(i, i);
  const flatCost = flat.stats.engineCalls - flatBefore;

  const deepBefore = deep.stats.engineCalls;
  deep.renderSpan(i, i);
  const deepCost = deep.stats.engineCalls - deepBefore;

  assert.ok(
    deepCost > flatCost * 2,
    `nested probing should cost multiples of the flat read: ${flatCost} vs ${deepCost}`,
  );
  // Same grid either way — the extra calls buy discovery, not content.
  assert.equal(deep.renderSpan(i, i), flat.renderSpan(i, i));
});

test("stats: equations/footnotes count what has been classified, classifyAll finishes it", async () => {
  const model = await inlineModel();
  assert.equal(model.stats.classifiedBlocks, 0);
  assert.equal(model.stats.equations, 0, "nothing is classified until something asks");

  const stats = model.classifyAll();
  assert.equal(stats.classifiedBlocks, stats.blocks);
  assert.equal(stats.equations, 2);
  assert.equal(stats.footnotes, 1);
});

// ── span handling ──────────────────────────────────────────────────────────

test("renderSpan: ranges are inclusive, clamped, and empty when inverted", async () => {
  const model = await buildBlocks(await loadDocument(sample("fixture-clause.hwp")));
  const n = model.blocks.length;

  const two = model.renderSpan(2, 3);
  assert.equal(two, `${model.blocks[2].text}\n${model.blocks[3].text}`);
  assert.equal(model.renderSpan(0, 9999), model.renderSpan(0, n - 1), "out of range clamps");
  assert.equal(model.renderSpan(5, 4), "", "an inverted range renders nothing");
  assert.equal(model.renderSpan(-5, 0), model.renderSpan(0, 0), "negative clamps to 0");
});

test("blockAt: every block is addressable by (section, paragraph)", async () => {
  const model = await buildBlocks(await loadDocument(sample("fixture-headings.hwp")));
  for (const b of model.blocks) assert.equal(model.blockAt(b.s, b.p), b);
  assert.equal(model.blockAt(0, 9999), undefined);
});

// ── eqn.mjs: normalization ─────────────────────────────────────────────────

test("eqn: normalization is idempotent", () => {
  const cases = [
    "x^2 + y^2 = z^2",
    "  {{ x^2 }}  ",
    "sqrt {a over b}",
    "{a} over {b}",
    "a\tover\n b",
    "",
    "{unbalanced",
  ];
  for (const c of cases) {
    const once = normalizeEquationScript(c);
    assert.equal(normalizeEquationScript(once), once, `not idempotent for ${JSON.stringify(c)}`);
  }
});

test("eqn: normalization collapses whitespace and peels redundant wrappers", () => {
  assert.equal(normalizeEquationScript("  {{ x^2 }}  "), "x^2");
  assert.equal(normalizeEquationScript("a\t\tover\n\nb"), "a over b");
  // `{a} over {b}` is NOT wrapped — its first brace closes at index 2 — so the
  // peel must leave it exactly alone.
  assert.equal(normalizeEquationScript("{a} over {b}"), "{a} over {b}");
});

test("eqn: normalization never throws, whatever it is handed", () => {
  for (const bad of [null, undefined, 0, false, {}, [], Symbol.iterator]) {
    assert.equal(typeof normalizeEquationScript(bad), "string", `threw or returned non-string for ${String(bad)}`);
  }
  assert.equal(normalizeEquationScript(null), "");
  assert.equal(normalizeEquationScript(undefined), "");
});

// ── eqn.mjs: LaTeX, and its honesty ────────────────────────────────────────

test("eqn: the fixture's equations translate completely", () => {
  const a = equationToLatex(FIXTURE_DATA.INLINE_EQ1);
  assert.deepEqual(a, { latex: "x^{2} + y^{2} = z^{2}", complete: true, unmapped: [] });

  const b = equationToLatex(FIXTURE_DATA.INLINE_EQ2);
  assert.deepEqual(b, { latex: "\\sqrt{\\frac{a}{b}}", complete: true, unmapped: [] });
});

test("eqn: the common HWP operators map", () => {
  const ok = (script, latex) => {
    const r = equationToLatex(script);
    assert.equal(r.latex, latex, `${script} → ${r.latex}`);
    assert.equal(r.complete, true, `${script} reported unmapped ${JSON.stringify(r.unmapped)}`);
  };
  ok("a over b", "\\frac{a}{b}");
  ok("sqrt x", "\\sqrt{x}");
  ok("a <= b", "a \\leq b");
  ok("a >= b", "a \\geq b");
  ok("a times b", "a \\times b");
  ok("alpha + beta", "\\alpha + \\beta");
  ok("GAMMA", "\\Gamma");
  ok("rm{d}", "\\mathrm{d}");
  ok("it{v}", "\\mathit{v}");
  ok("sum from{i=1} to{n} i", "\\sum_{i = 1}^{n} i");
  ok("int from 0 to 1 f", "\\int_{0}^{1} f");
  // LEFT/RIGHT open a scope, so `over` inside cannot escape the delimiters.
  ok("LEFT ( x over y RIGHT )", "\\left( \\frac{x}{y} \\right)");
});

test("eqn: what it cannot map comes back complete:false with the tokens named", () => {
  const bad = equationToLatex("matrix{a # b}");
  assert.equal(bad.complete, false);
  assert.deepEqual(bad.unmapped, ["matrix", "#"]);

  const root = equationToLatex("root 3 of x");
  assert.equal(root.complete, false);
  assert.deepEqual(root.unmapped, ["root", "of"]);

  // A multi-letter latin word that is not a known keyword is reported rather
  // than assumed to be a variable: guessing wrong on `matrix` corrupts the
  // formula, guessing wrong on `dx` costs one fallback.
  const dx = equationToLatex("f dx");
  assert.equal(dx.complete, false);
  assert.deepEqual(dx.unmapped, ["dx"]);

  // Korean inside a formula is reported as whole words, not per character.
  const kr = equationToLatex("한글 수식");
  assert.equal(kr.complete, false);
  assert.deepEqual(kr.unmapped, ["한글", "수식"]);

  // An unclosed group is malformed, not translatable.
  const open = equationToLatex("{unbalanced");
  assert.equal(open.complete, false);
  assert.ok(open.unmapped.includes("{"));
});

test("eqn: equationToLatex always returns a result and never throws", () => {
  for (const bad of [null, undefined, 0, {}, [], "}{", "^", "over", "LEFT", "sqrt"]) {
    let r;
    assert.doesNotThrow(() => {
      r = equationToLatex(bad);
    }, `threw on ${JSON.stringify(String(bad))}`);
    assert.equal(typeof r.latex, "string");
    assert.equal(typeof r.complete, "boolean");
    assert.ok(Array.isArray(r.unmapped));
  }
});

test("eqn: LaTeX is opt-in, and an incomplete translation falls back to the script", async () => {
  const doc = await emptyDocument();
  doc.insertText(0, 0, 0, "식: ");
  doc.insertEquation(0, 0, 3, "matrix{a # b}", 10, 0);
  const model = await buildBlocks(doc);

  // Default: the normalized HWP script, untranslated.
  assert.equal(model.renderSpan(0, 0), "식: $matrix{a # b}$");

  // Asked for LaTeX, but the translation was incomplete — so the raw script is
  // what comes out. A half-translated formula presented as finished is the
  // failure this rule exists to prevent.
  assert.equal(model.renderSpan(0, 0, { latex: true }), "식: $matrix{a # b}$");

  // A translatable one does switch.
  const doc2 = await emptyDocument();
  doc2.insertText(0, 0, 0, "식: ");
  doc2.insertEquation(0, 0, 3, "a over b", 10, 0);
  const model2 = await buildBlocks(doc2);
  assert.equal(model2.renderSpan(0, 0), "식: $a over b$");
  assert.equal(model2.renderSpan(0, 0, { latex: true }), "식: $\\frac{a}{b}$");
});

test("renderSpan: equations and tables can each be switched off", async () => {
  const model = await inlineModel();
  const none = model.renderSpan(0, 0, { equations: false, footnotes: false });
  assert.equal(none, FIXTURE_DATA.INLINE_TEXT, "with everything off, the text is untouched");

  const custom = model.renderSpan(0, 0, {
    equationOpen: "[eq: ",
    equationClose: "]",
    footnotes: false,
  });
  assert.ok(custom.includes(`[eq: ${FIXTURE_DATA.INLINE_EQ1}]`));
});
