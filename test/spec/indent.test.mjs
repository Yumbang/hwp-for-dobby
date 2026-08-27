// Indent depth — and the two things that make it not what it looks like.
//
// FIRST: adjusting an indent level looks like moving marginLeft, and real
// documents mostly do not. Across 1,328 marker paragraphs in 52 documents,
// leading SPACES beat marginLeft 37% to 12%, marginLeft is 0 in 85% of marker
// paragraphs, and half carry no indent signal at all. So there are two schemes
// and `auto` follows the document.
//
// SECOND: leading spaces and a hanging indent are a PAIR, not alternatives.
// 91% of space-indented paragraphs long enough to wrap also set a hang, because
// the spaces push the marker right and the hang pulls the wrapped lines back
// under the text. Spaces without the hang is a visible layout break.
//
// The unit test at the bottom pins the conversion that this file got wrong
// once: marginLeft/indent go in as HWPUNIT and come back divided by 150.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadDocument } from "../../src/lib/_bootstrap.mjs";
import {
  GETTER_UNIT_HWPUNIT,
  HANG_BASE_EM,
  HANG_PER_SPACE_EM,
  hangingIndentFor,
  marginForLevel,
  reindentText,
} from "../../src/lib/indent.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const FIX = join(ROOT, "samples", "fixture-headings.hwp");

let TMP;
const out = (n) => join(TMP, n);
test.before(() => {
  TMP = mkdtempSync(join(tmpdir(), "hwp-indent-"));
});
test.after(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
});

const run = (args) =>
  spawnSync(process.execPath, [join("src", "core", "format.mjs"), ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });

function indentOk(args, label) {
  const r = run(args);
  assert.equal(r.status, 0, `${label}: exit ${r.status}\n${r.stderr}`);
  const j = JSON.parse(r.stdout);
  assert.equal(j.verified, true, `${label}: not verified`);
  return j;
}

async function para(path, p) {
  const d = await loadDocument(path);
  const len = d.getParagraphLength(0, p);
  return {
    text: len > 0 ? d.getTextRange(0, p, 0, len) : "",
    props: JSON.parse(d.getParaPropertiesAt(0, p)),
  };
}

// ── the unit trap ─────────────────────────────────────────────────────────

test("engine: marginLeft/indent go in as HWPUNIT and come back divided by 150", async () => {
  // HWPUNIT is 1/7200 inch, so the getter's unit is 1/48 inch — 1.5 POINTS, not
  // one. Documentation in this repo called it "pt", and a formula derived from
  // getter output and sent back without the 1.5 produced hanging indents two
  // thirds of the intended size. Pinned so it cannot drift back.
  const doc = await loadDocument(FIX);
  const dst = out("unit.hwp");
  doc.applyParaFormat(0, 6, JSON.stringify({ marginLeft: 4650, indent: -4650 }));
  writeFileSync(dst, Buffer.from(doc.exportHwp()));
  const { props } = await para(dst, 6);
  assert.equal(props.marginLeft, 31, "4650 HWPUNIT reads back as 31 (4650/150)");
  assert.equal(props.indent, -31);
  assert.equal(GETTER_UNIT_HWPUNIT, 150);
  // 4650 HWPUNIT is really 46.5pt, not 31pt — the getter is not reporting points.
  assert.equal(4650 / 100, 46.5, "the true point value, for contrast");
});

test("hangingIndentFor: reproduces the corpus medians", () => {
  // Corpus: median getter reading per leading-space count, at the median font
  // size for that count. Within a few units, which is well inside the spread.
  const cases = [
    { level: 0, fontSize: 1400, corpus: 29.3 },
    { level: 1, fontSize: 1400, corpus: 38.1 },
    { level: 5, fontSize: 1300, corpus: 61.4 },
  ];
  for (const { level, fontSize, corpus } of cases) {
    const reading = -hangingIndentFor(level, fontSize) / GETTER_UNIT_HWPUNIT;
    assert.ok(
      Math.abs(reading - corpus) < 6,
      `level ${level}: got ${reading.toFixed(1)}, corpus median ${corpus}`,
    );
  }
  assert.ok(hangingIndentFor(2, 1000) < hangingIndentFor(1, 1000), "deeper level hangs further");
  assert.ok(HANG_BASE_EM > 3 && HANG_PER_SPACE_EM > 0.5, "constants are true ems, not getter units");
});

test("marginForLevel: lands on values the corpus actually uses", () => {
  // The engine rounds its getter output to one decimal, so compare there: a
  // level-1 indent reads 13.3 and level-2 reads 26.7, and both of those are
  // among the commonest marginLeft values in the corpus.
  const reading = (hwpunit) => Math.round((hwpunit / GETTER_UNIT_HWPUNIT) * 10) / 10;
  assert.equal(marginForLevel(0, 1000), 0);
  assert.equal(reading(marginForLevel(1, 1000)), 13.3);
  assert.equal(reading(marginForLevel(2, 1000)), 26.7);
});

test("reindentText: preserves the marker glyph, only moves it", () => {
  assert.deepEqual(reindentText("□ 추진 배경", 2), {
    text: "  □ 추진 배경", dropped: 2, hasMarker: true,
  });
  // Re-indenting must never change WHICH glyph the line uses.
  assert.equal(reindentText("  ○ 국내 현황", 0).text, "○ 국내 현황");
  assert.equal(reindentText("평범한 문단", 1).text, " 평범한 문단");
  assert.equal(reindentText("평범한 문단", 1).hasMarker, false);
});

// ── end to end ────────────────────────────────────────────────────────────

test("indent space scheme: sets spaces AND the matching hanging indent", async () => {
  const dst = out("space.hwp");
  const j = indentOk(
    [FIX, "--op", "indent", "--section", "0", "--paragraphs", "10-12",
     "--level", "2", "--scheme", "space", "--output", dst],
    "space scheme",
  );
  assert.equal(j.scheme, "space");
  for (const p of [10, 11, 12]) {
    const { text, props } = await para(dst, p);
    assert.match(text, /^ {2}[^\s]/, `p${p} starts with exactly two spaces`);
    assert.ok(props.indent < 0, `p${p} has a hanging indent, not just spaces`);
  }
  // The glyphs are preserved, not rewritten.
  assert.equal((await para(dst, 10)).text, "  □ 추진 배경");
  assert.equal((await para(dst, 11)).text, "  ○ 국내 현황");
});

test("indent space scheme: no hanging indent on a paragraph with no marker", async () => {
  // A hang on ordinary prose is just a broken first line.
  const dst = out("space-prose.hwp");
  indentOk(
    [FIX, "--op", "indent", "--section", "0", "--paragraphs", "13",
     "--level", "2", "--scheme", "space", "--output", dst],
    "prose",
  );
  const { text, props } = await para(dst, 13);
  assert.match(text, /^ {2}국내/);
  assert.equal(props.indent, 0, "prose gets spaces but no hang");
});

test("indent --no-hanging: opts out of the pairing, explicitly", async () => {
  const dst = out("nohang.hwp");
  indentOk(
    [FIX, "--op", "indent", "--section", "0", "--paragraphs", "10",
     "--level", "2", "--scheme", "space", "--no-hanging", "--output", dst],
    "no-hanging",
  );
  const { text, props } = await para(dst, 10);
  assert.equal(text, "  □ 추진 배경");
  assert.equal(props.indent, 0);
});

test("indent margin scheme: moves marginLeft and leaves the text alone", async () => {
  const before = await para(FIX, 10);
  const dst = out("margin.hwp");
  const j = indentOk(
    [FIX, "--op", "indent", "--section", "0", "--paragraphs", "10",
     "--level", "2", "--scheme", "margin", "--output", dst],
    "margin scheme",
  );
  assert.equal(j.scheme, "margin");
  const { text, props } = await para(dst, 10);
  assert.equal(text, before.text, "margin scheme must not touch the text");
  assert.equal(props.marginLeft, 26.7, "level 2 at 10pt — a value the corpus uses");
});

test("indent auto: follows the document's own convention", async () => {
  // fixture-headings indents with marginLeft, so auto must pick margin and
  // leave the text untouched — imposing spaces would mix two conventions.
  const j = indentOk(
    [FIX, "--op", "indent", "--section", "0", "--paragraphs", "10",
     "--level", "1", "--output", out("auto.hwp")],
    "auto",
  );
  assert.equal(j.schemeSource, "auto");
  assert.equal(j.scheme, "margin", "this fixture uses marginLeft");
  assert.ok(j.detected.margined > j.detected.spaced, "and the detector says why");
  assert.equal((await para(out("auto.hwp"), 10)).text, (await para(FIX, 10)).text);
});

test("indent: level 0 removes the indent rather than doing nothing", async () => {
  const two = out("lvl2.hwp");
  indentOk([FIX, "--op", "indent", "--section", "0", "--paragraphs", "10",
    "--level", "2", "--scheme", "space", "--output", two], "set level 2");
  const zero = out("lvl0.hwp");
  indentOk([two, "--op", "indent", "--section", "0", "--paragraphs", "10",
    "--level", "0", "--scheme", "space", "--output", zero], "back to level 0");
  assert.equal((await para(zero, 10)).text, "□ 추진 배경", "the spaces are gone");
});

test("indent: bad arguments are refused before the document is touched", () => {
  for (const [extra, expected] of [
    [["--paragraphs", "10"], /requires --level/],
    [["--paragraphs", "10", "--level", "-1"], /--level must be a non-negative integer/],
    [["--paragraphs", "10", "--level", "1", "--scheme", "nope"], /--scheme must be auto\|space\|margin/],
    [["--paragraphs", "10", "--level", "1", "--props", '{"bold":true}'], /does not take --props/],
    [["--paragraphs", "9-6", "--level", "1"], /descending/],
    [["--paragraphs", "9999", "--level", "1"], /out of range/],
  ]) {
    const dst = out("bad-indent.hwp");
    const r = run([FIX, "--op", "indent", "--section", "0", ...extra, "--output", dst]);
    assert.notEqual(r.status, 0, `${JSON.stringify(extra)} must not succeed`);
    assert.match(r.stderr, expected);
    assert.equal(existsSync(dst), false, "a refused edit writes no file");
  }
});
