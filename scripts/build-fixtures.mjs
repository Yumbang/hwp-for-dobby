#!/usr/bin/env node
// Build the section/heading/inline test fixtures.
//
//   node scripts/build-fixtures.mjs                 # write into samples/
//   node scripts/build-fixtures.mjs --out-dir DIR   # write somewhere else
//   node scripts/build-fixtures.mjs --check         # rebuild + compare, no write
//
// WHY GENERATED, AND WHY STILL COMMITTED. These documents have to be authored
// (no real .hwp in hand has a table-caption false positive sitting next to the
// heading it mimics), and the generator has to live somewhere. But `scripts/`
// is deliberately NOT in the delivery allowlist (scripts/_payload.mjs), so a
// generator-only fixture would be missing from every installed copy of the
// skill. So: generate here, commit the .hwp, and let --check prove the two
// agree. The comparison is SEMANTIC, never byte-for-byte — an engine bump
// changes serialization details constantly, and a fixture test that goes red
// on every bump is a fixture test everyone learns to ignore.
//
// WHAT THE FIXTURES ARE FOR
//
// fixture-headings.hwp   Korean outline structure with its false positives
//                        deliberately adjacent to the real thing. The load-
//                        bearing pair is "1. 사업 개요\t 2" (a table-of-
//                        contents line, NOT a heading) three paragraphs above
//                        "1. 사업 개요" (a heading). Any detector that keys on
//                        the leading number alone gets exactly one of them
//                        wrong. Depth is carried by marker glyph (□ → ○ → -)
//                        plus marginLeft, because that is how real Korean
//                        documents encode it: headType/paraLevel/numberingId
//                        are None/0/0 on effectively every paragraph.
//
// fixture-clause.hwp     제N장 / 제N조 with INLINE bodies ("제1조(목적) 이
//                        규정은 …"), where the heading and its text share one
//                        paragraph, plus a cross-reference to 제3조 that must
//                        not be mistaken for a heading.
//
// fixture-table-only.hwp Every body paragraph empty, all content inside a
//                        merged-header table — the ~22% of real documents that
//                        have no body paragraphs at all.
//
// fixture-inline.hwp     One paragraph carrying two equations and a footnote
//                        at offsets 11/20/31, so inline splicing, the
//                        getEquationProperties(-1,-1) trap and the invisible
//                        SectionDef/ColumnDef controls are all covered by one
//                        document.
//
// The paragraph-only fixtures are built by spawning src/core/create.mjs with a
// plan, so the generator exercises the real create path (including the
// apply_para_format op) instead of a private shortcut. The other two need
// merged cells / equations / footnotes, which create.mjs has no ops for, so
// they drive the engine directly.

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadDocument, loadDocumentFromBytes, emptyDocument } from "../src/lib/_bootstrap.mjs";
import { classifyParagraphControls, controlOffsets, paragraphText } from "../src/lib/doc_walk.mjs";
import { extractTables } from "../src/lib/tables.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SAMPLES = join(ROOT, "samples");

// Left indent in HWPUNIT (1/7200 inch). One "level" of Korean outline
// indentation is conventionally two spaces at 10pt ≈ 2000 HWPUNIT.
const INDENT = (level) => level * 2000;

// ── fixture-headings.hwp ───────────────────────────────────────────────────
// Each entry is [text, indentLevel]. The comments mark what each line is FOR;
// test/spec/headings.test.mjs asserts the classification, not this file.
const HEADING_LINES = [
  ["사업 추진 계획", 0], //  0  document title
  ["", 0], //  1
  ["1. 사업 개요\t 2", 0], //  2  ✗ table of contents (tab + page number)
  ["2. 추진 체계\t 5", 0], //  3  ✗ table of contents
  ["3. 기대 효과\t 9", 0], //  4  ✗ table of contents
  ["", 0], //  5
  ["1953. 10. 20. 제정", 0], //  6  ✗ date line (제정)
  ["2024. 3. 15. 전부개정", 0], //  7  ✗ date line (개정)
  ["", 0], //  8
  ["1. 사업 개요", 0], //  9  ✓ heading — the twin of paragraph 2
  ["□ 추진 배경", 0], // 10  ✓ heading
  ["○ 국내 현황", 1], // 11  ✓ heading
  ["- 시장 규모는 연 12% 성장하고 있다.", 2], // 12  ✓ heading
  ["○ 해외 현황", 1], // 13  ✓ heading
  ["<표 1-1> 연도별 시장 규모", 1], // 14  ✗ table caption
  ["□ 추진 목표", 0], // 15  ✓ heading
  ["본 사업은 제3조에 따라 추진하며, 세부 사항은 1. 항목을 참고한다.", 1], // 16  ✗ cross-reference (inline, mid-sentence)
  ["2. 추진 체계", 0], // 17  ✓ heading
  ["□ 조직 구성", 0], // 18  ✓ heading
  ["○ 총괄 부서", 1], // 19  ✓ heading
  ["3. 기대 효과", 0], // 20  ✓ heading
  ["* 각주 성격의 보충 설명이며 항목이 아니다.", 0], // 21  ✗ footnote-style marker
  ["※ 유의사항: 본 계획은 변경될 수 있음.", 0], // 22  ✗ ※ note marker
];

// ── fixture-clause.hwp ─────────────────────────────────────────────────────
const CLAUSE_LINES = [
  ["학교 운영 규정", 0],
  ["", 0],
  ["제1장 총칙", 0],
  ["제1조(목적) 이 규정은 학교의 운영에 관한 사항을 정함을 목적으로 한다.", 0],
  ["제2조(적용범위) 이 규정은 학교의 모든 구성원에게 적용한다.", 0],
  ["제2장 조직", 0],
  ["제3조(부서) 학교에 다음 각 호의 부서를 둔다.", 0],
  ["1. 교무처", 1],
  ["2. 학생처", 1],
  ["제4조(위원회) 제3조에 따른 부서에 각각 위원회를 둘 수 있다.", 0],
  ["부칙", 0],
  ["이 규정은 2024. 3. 1.부터 시행한다.", 0],
];

// ── fixture-inline.hwp ─────────────────────────────────────────────────────
const INLINE_TEXT = "수식 예시: 앞의 식과 뒤의 식을 비교하면 결과가 같다는 것을 알 수 있다.";
const INLINE_EQ1 = "x^2 + y^2 = z^2";
const INLINE_EQ2 = "sqrt {a over b}";
const INLINE_OFFSETS = { eq1: 11, eq2: 20, footnote: 31 };
const INLINE_FOOTNOTE_TEXT = "각주 본문입니다.";

// ── fixture-table-only.hwp ─────────────────────────────────────────────────
const TABLE_ONLY_HEADER = "연도별 실적";
const TABLE_ONLY_ROWS = [
  ["구분", "2023", "2024"],
  ["매출", "1,200", "1,450"],
  ["영업이익", "180", "２３０"], // full-width digits: a real Korean-form quirk
];

// ── builders ───────────────────────────────────────────────────────────────

// Build a paragraph-only document through src/core/create.mjs, so the real
// create path (and its apply_para_format op) is what produces the fixture.
function buildParagraphFixture(lines, outPath) {
  const steps = [];
  lines.forEach(([text, level], i) => {
    if (i > 0) steps.push({ op: "insert_paragraph", section: 0, para: i });
    if (text) steps.push({ op: "insert_text", section: 0, para: i, char: 0, text });
    // Format EVERY paragraph, including level 0. insertParagraph inherits the
    // preceding paragraph's shape, so formatting only the indented ones lets
    // an indent bleed forward into every paragraph after it — which would make
    // the fixture claim a nesting depth its text does not have.
    steps.push({
      op: "apply_para_format",
      section: 0,
      para: i,
      props: { marginLeft: INDENT(level), indent: 0 },
    });
  });
  const planPath = join(mkdtempSync(join(tmpdir(), "hwp-fixture-")), "plan.json");
  writeFileSync(planPath, JSON.stringify({ steps }, null, 2));
  const r = spawnSync(
    process.execPath,
    [join(ROOT, "src", "core", "create.mjs"), "--plan", planPath, "--output", outPath],
    { cwd: ROOT, encoding: "utf8" },
  );
  rmSync(dirname(planPath), { recursive: true, force: true });
  if (r.status !== 0) {
    throw new Error(`create.mjs failed (exit ${r.status}):\n${r.stderr}\n${r.stdout}`);
  }
}

// Equations and footnotes have no create.mjs ops, so this one drives the
// engine. Offsets are ASSERTED, not assumed: insertEquation clamps an
// out-of-range offset to the end of the paragraph, which would quietly turn
// three distinct splice positions into a pile at the same offset.
async function buildInlineFixture(outPath) {
  const doc = await emptyDocument();
  doc.insertText(0, 0, 0, INLINE_TEXT);
  // Insert LAST position first: an earlier insert does not move later text
  // (controls are zero-width), but inserting in descending order keeps the
  // intent obvious and is robust either way.
  doc.insertFootnote(0, 0, INLINE_OFFSETS.footnote);
  doc.insertEquation(0, 0, INLINE_OFFSETS.eq2, INLINE_EQ2, 10, 0);
  doc.insertEquation(0, 0, INLINE_OFFSETS.eq1, INLINE_EQ1, 10, 0);

  // Footnote body text. The control index shifts as equations are inserted, so
  // find it by classification rather than by a remembered number.
  const fn = classifyParagraphControls(doc, 0, 0).find((c) => c.kind === "footnote");
  if (!fn) throw new Error("footnote control vanished");
  doc.insertTextInFootnote(0, 0, fn.index, 0, 0, INLINE_FOOTNOTE_TEXT);

  const offsets = controlOffsets(doc, 0, 0);
  const wanted = [INLINE_OFFSETS.eq1, INLINE_OFFSETS.eq2, INLINE_OFFSETS.footnote];
  for (const w of wanted) {
    if (!offsets.includes(w)) {
      throw new Error(`expected a control at offset ${w}, got ${JSON.stringify(offsets)}`);
    }
  }
  if (new Set(wanted).size !== 3) throw new Error("inline offsets must be distinct");
  writeFileSync(outPath, Buffer.from(doc.exportHwp()));
}

// A document whose body paragraphs are all empty and whose only content is a
// table with a merged header row.
async function buildTableOnlyFixture(outPath) {
  const doc = await emptyDocument();
  const rows = TABLE_ONLY_ROWS.length + 1; // +1 for the merged title row
  const cols = TABLE_ONLY_ROWS[0].length;
  // createTable reports WHERE it landed. Do not assume control index 0:
  // paragraph 0 of every section already carries the invisible
  // SectionDef/ColumnDef controls, so the table is never index 0 there.
  const placed = JSON.parse(doc.createTable(0, 0, 0, rows, cols));
  const para = placed.paraIdx;
  const ctrl = placed.controlIdx;
  doc.mergeTableCells(0, para, ctrl, 0, 0, 0, cols - 1);

  // After the merge, cell indices are origin-order: cell 0 is the merged title
  // row, then the remaining rows left-to-right.
  doc.insertTextInCell(0, para, ctrl, 0, 0, 0, TABLE_ONLY_HEADER);
  let k = 1;
  for (const row of TABLE_ONLY_ROWS) {
    for (const cell of row) {
      doc.insertTextInCell(0, para, ctrl, k, 0, 0, cell);
      k++;
    }
  }
  writeFileSync(outPath, Buffer.from(doc.exportHwp()));
}

export const FIXTURES = {
  "fixture-headings.hwp": (out) => buildParagraphFixture(HEADING_LINES, out),
  "fixture-clause.hwp": (out) => buildParagraphFixture(CLAUSE_LINES, out),
  "fixture-table-only.hwp": (out) => buildTableOnlyFixture(out),
  "fixture-inline.hwp": (out) => buildInlineFixture(out),
};

export const FIXTURE_DATA = {
  HEADING_LINES,
  CLAUSE_LINES,
  INLINE_TEXT,
  INLINE_EQ1,
  INLINE_EQ2,
  INLINE_OFFSETS,
  INLINE_FOOTNOTE_TEXT,
  TABLE_ONLY_HEADER,
  TABLE_ONLY_ROWS,
  INDENT,
};

// ── semantic digest ────────────────────────────────────────────────────────

// What a fixture MEANS, as opposed to how it happens to serialize: paragraph
// text, left indent, the kind and offset of every control, and every table's
// dimensions and cell text. This is what --check compares, and what makes the
// comparison survive an engine bump that changes byte layout.
export async function semanticDigest(path) {
  const doc = await loadDocument(path);
  const paragraphs = [];
  for (let s = 0; s < doc.getSectionCount(); s++) {
    for (let p = 0; p < doc.getParagraphCount(s); p++) {
      let marginLeft = 0;
      try {
        marginLeft = JSON.parse(doc.getParaPropertiesAt(s, p)).marginLeft ?? 0;
      } catch {
        marginLeft = 0;
      }
      const controls = classifyParagraphControls(doc, s, p).map((c) => ({
        kind: c.kind,
        offset: c.offset,
        ...(c.kind === "equation" ? { script: c.script } : {}),
        ...(c.kind === "footnote" ? { number: c.number, texts: c.texts } : {}),
        ...(c.kind === "table" ? { dims: c.dims } : {}),
      }));
      paragraphs.push({ s, p, text: paragraphText(doc, s, p), marginLeft, controls });
    }
  }
  const tables = extractTables(doc).map((t) => ({
    rowCount: t.rowCount,
    colCount: t.colCount,
    cellCount: t.cellCount,
    cells: t.grid.flat().map((c) => (c && c.origin ? c.text : null)),
  }));
  return { sourceFormat: doc.getSourceFormat(), paragraphs, tables };
}

// ── CLI ────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const argIdx = process.argv.indexOf("--out-dir");
  const check = process.argv.includes("--check");
  const outDir = check
    ? mkdtempSync(join(tmpdir(), "hwp-fixture-check-"))
    : argIdx >= 0
      ? process.argv[argIdx + 1]
      : SAMPLES;
  mkdirSync(outDir, { recursive: true });

  let failed = 0;
  for (const [name, build] of Object.entries(FIXTURES)) {
    const out = join(outDir, name);
    await build(out);
    const bytes = readFileSync(out);
    const sha = createHash("sha256").update(bytes).digest("hex");
    if (check) {
      const committed = join(SAMPLES, name);
      const a = JSON.stringify(await semanticDigest(committed));
      const b = JSON.stringify(await semanticDigest(out));
      const ok = a === b;
      if (!ok) failed++;
      process.stdout.write(`${ok ? "ok  " : "FAIL"} ${name} (semantic)\n`);
      if (!ok) {
        process.stdout.write(`  committed: ${a.slice(0, 400)}\n  rebuilt  : ${b.slice(0, 400)}\n`);
      }
    } else {
      process.stdout.write(`wrote ${name}  ${bytes.length} bytes  sha256:${sha}\n`);
    }
  }
  if (check) {
    rmSync(outDir, { recursive: true, force: true });
    process.exit(failed ? 1 : 0);
  }
}
