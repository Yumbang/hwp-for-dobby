// The palette — and the line it must not cross.
//
// A palette describes what a document IS. The whole risk is that it gets read
// as what the document SHOULD be: a draft whose level-2 items drifted across
// ○, -, ◦ and * has four shapes and three mistakes, and a report that called
// all four "the document's style" would turn the mess into a standard that N
// agents then reproduce faithfully. So `shapes` describes, `observations`
// gives evidence with reasons, and nothing normalises.
//
// Two signals were tried and REMOVED for pointing the wrong way, and there are
// tests below for both, because the failure they cause is invisible — a
// confident, plausible, wrong recommendation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadDocument } from "../../src/lib/_bootstrap.mjs";
import { buildPalette, markerInventory, shapeKey } from "../../src/lib/palette.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const FIX = join(ROOT, "samples", "fixture-headings.hwp");

let TMP;
test.before(() => {
  TMP = mkdtempSync(join(tmpdir(), "hwp-palette-"));
});
test.after(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
});

const run = (args) =>
  spawnSync(process.execPath, [join("src", "core", "format.mjs"), ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });

// A document whose level-2 markers drifted — the case this was built for.
async function messyDoc() {
  const { emptyDocument } = await import("../../src/lib/_bootstrap.mjs");
  const { writeFileSync } = await import("node:fs");
  const LINES = [
    "사업 계획",
    "□ 추진 배경",
    "  ○ 첫 번째 항목입니다",
    "- 두 번째 항목입니다",
    "□ 사업 목표",
    "◦ 세 번째 항목입니다",
    "○ 네 번째 항목입니다",
  ];
  const d = await emptyDocument();
  for (let i = 0; i < LINES.length; i++) {
    if (i > 0) d.insertParagraph(0, i);
    d.insertText(0, i, 0, LINES[i]);
  }
  const path = join(TMP, "messy.hwp");
  writeFileSync(path, Buffer.from(d.exportHwp()));
  return path;
}

// ── description ───────────────────────────────────────────────────────────

test("palette: groups paragraphs by shape and describes them in WRITABLE keys", async () => {
  const doc = await loadDocument(FIX);
  const pal = buildPalette(doc);
  assert.ok(pal.shapes.length > 0);
  // Every key reported must be one --props accepts, or the report describes a
  // contract nobody can honour.
  const { CHAR_PROPS, PARA_PROPS } = await import("../../src/lib/format_props.mjs");
  for (const sh of pal.shapes) {
    for (const k of Object.keys(sh.charProps)) {
      assert.ok(k in CHAR_PROPS, `char key "${k}" must be writable via --op char`);
    }
    for (const k of Object.keys(sh.paraProps)) {
      assert.ok(k in PARA_PROPS, `para key "${k}" must be writable via --op para`);
    }
  }
});

test("palette: the font is carried as READ-ONLY, never as a writable key", async () => {
  // Reporting fontFamily among the writable props would invite an edit that
  // silently does nothing — applyCharFormat cannot set a font (spec rule 60).
  const doc = await loadDocument(FIX);
  const pal = buildPalette(doc);
  for (const sh of pal.shapes) {
    assert.equal(sh.charProps.fontFamily, undefined, "fontFamily is not a writable prop");
    assert.ok("fontFamily" in sh.readOnly, "but it IS reported, under readOnly");
  }
});

test("palette: shapes are distinguished by marker glyph, not only geometry", async () => {
  // Two paragraphs with identical geometry and different glyphs are not
  // interchangeable in a 개조식 list, so they must not collapse into one shape.
  const a = { paraProps: { alignment: "justify" }, charProps: {}, marker: { glyph: "○", indentChars: 0 } };
  const b = { paraProps: { alignment: "justify" }, charProps: {}, marker: { glyph: "-", indentChars: 0 } };
  assert.notEqual(shapeKey(a), shapeKey(b));
  const c = { paraProps: { alignment: "justify" }, charProps: {}, marker: { glyph: "○", indentChars: 2 } };
  assert.notEqual(shapeKey(a), shapeKey(c), "depth is part of the shape too");
});

// ── the signals, and the two that were removed ────────────────────────────

test("palette: a glyph used at two depths is flagged — it cannot be both", async () => {
  const path = await messyDoc();
  const doc = await loadDocument(path);
  const pal = buildPalette(doc);
  const mixed = pal.observations.filter((o) => o.kind === "glyph-at-mixed-depths");
  assert.equal(mixed.length, 1, "only ○ is used at two depths here");
  assert.equal(mixed[0].glyph, "○");
  assert.deepEqual(
    mixed[0].depths.map((d) => d.indentChars).sort(),
    [0, 2],
    "and the depths are reported so the caller can pick",
  );
});

test("palette: does NOT claim the minority glyphs are slips of the majority", async () => {
  // THE REMOVED SIGNAL. "Different glyphs at the same leading-space depth"
  // reads like the right test and is not: half of all real marker paragraphs
  // carry no indent, so at depth 0 it puts a legitimate top-level □ next to
  // level-2 items that merely lost their indent, then names □ the majority.
  // Acting on that pushes the strays UP a level instead of fixing them.
  const path = await messyDoc();
  const doc = await loadDocument(path);
  const pal = buildPalette(doc);

  assert.equal(
    pal.observations.some((o) => o.kind === "competing-glyphs"),
    false,
    "the competing-glyphs signal must stay removed",
  );
  // And its replacement must not creep back in through near-duplicate: a
  // pairing that differs ONLY by glyph points the same wrong direction.
  for (const o of pal.observations.filter((x) => x.kind === "near-duplicate")) {
    assert.notDeepEqual(o.differsIn, ["marker.glyph"], "glyph-only pairings must not be reported");
  }
  // The facts are still available — just without the false implication.
  const inv = markerInventory(pal.shapes);
  const glyphs = inv.map((m) => m.glyph);
  for (const g of ["□", "○", "-", "◦"]) assert.ok(glyphs.includes(g), `${g} is in the inventory`);
});

test("palette: every observation carries its reasoning, so it can be overruled", async () => {
  const path = await messyDoc();
  const doc = await loadDocument(path);
  const pal = buildPalette(doc);
  assert.ok(pal.observations.length > 0);
  for (const o of pal.observations) {
    assert.equal(typeof o.why, "string");
    assert.ok(o.why.length > 40, `${o.kind} must explain itself, not just assert`);
    // No observation may be phrased as an instruction.
    assert.doesNotMatch(o.why, /\b(fix|correct|should be|must be) \b/i, `${o.kind} must not prescribe`);
  }
});

test("palette: a clean document produces no inconsistency observations", async () => {
  const { emptyDocument } = await import("../../src/lib/_bootstrap.mjs");
  const { writeFileSync } = await import("node:fs");
  const LINES = ["□ 첫째 항목", "□ 둘째 항목", "  ○ 하위 항목 하나", "  ○ 하위 항목 둘"];
  const d = await emptyDocument();
  for (let i = 0; i < LINES.length; i++) {
    if (i > 0) d.insertParagraph(0, i);
    d.insertText(0, i, 0, LINES[i]);
  }
  const path = join(TMP, "clean.hwp");
  writeFileSync(path, Buffer.from(d.exportHwp()));
  const pal = buildPalette(await loadDocument(path));
  assert.equal(
    pal.observations.filter((o) => o.kind !== "singleton").length,
    0,
    "a consistent document must not be told it is inconsistent",
  );
});

// ── the command ───────────────────────────────────────────────────────────

test("format --op list: read-only, and says so when handed --output", () => {
  const r = run([FIX, "--op", "list", "--output", join(TMP, "nope.hwp")]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /read-only and writes no document/);
});

test("format --op list: json carries shapes, markers and observations", () => {
  const r = run([FIX, "--op", "list", "--format", "json"]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  for (const k of ["shapes", "markers", "observations", "paragraphCount"]) {
    assert.ok(k in j, `json must carry ${k}`);
  }
  for (const sh of j.shapes) {
    assert.equal(typeof sh.id, "string");
    assert.equal(typeof sh.count, "number");
    assert.ok(Array.isArray(sh.paragraphs), "a shape names the paragraphs that use it");
  }
});

test("format --op list: the text report states that it decides nothing", () => {
  const r = run([FIX, "--op", "list"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /READ-ONLY, applyCharFormat cannot set a font/);
  assert.match(r.stdout, /fact, not judgement/);
});
