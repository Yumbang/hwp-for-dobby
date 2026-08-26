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
// fixture-image.hwp      Three pictures in three deliberately DIFFERENT
//                        states, because every interesting bug in image
//                        editing is about state and not about pixels: one left
//                        in the engine's layout-destroying default (floating,
//                        anchored to the paper), one pinned inline, and one
//                        carrying a caption with real text. Body paragraphs
//                        sit between them so "did the edit disturb the body?"
//                        is a question the fixture can answer.
//
// The paragraph-only fixtures are built by spawning src/core/create.mjs with a
// plan, so the generator exercises the real create path (including the
// apply_para_format op) instead of a private shortcut. The other three need
// merged cells / equations / footnotes / pictures, which create.mjs has no ops
// for, so they drive the engine directly.

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
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
  ["- 시장 규모 연 12% 성장", 2], // 12  ✓ heading (third marker level)
  ["국내 시장 규모는 연 12% 성장하고 있다.", 2], // 13  ✗ body text under it
  ["- 주요 사업자 현황", 2], // 14  ✓ heading (same class, so DASH has support)
  ["○ 해외 현황", 1], // 15  ✓ heading
  ["<표 1-1> 연도별 시장 규모", 1], // 16  ✗ table caption
  ["□ 추진 목표", 0], // 17  ✓ heading
  ["본 사업은 제3조에 따라 추진하며, 세부 사항은 1. 항목을 참고한다.", 1], // 18  ✗ cross-reference (inline, mid-sentence)
  ["2. 추진 체계", 0], // 19  ✓ heading
  ["□ 조직 구성", 0], // 20  ✓ heading
  ["○ 총괄 부서", 1], // 21  ✓ heading
  ["3. 기대 효과", 0], // 22  ✓ heading
  ["* 각주 성격의 보충 설명이며 항목이 아니다.", 0], // 23  ✗ footnote-style marker
  ["※ 유의사항: 본 계획은 변경될 수 있음.", 0], // 24  ✗ ※ note marker
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

// ── fixture-image.hwp ──────────────────────────────────────────────────────
//
// The image fixture exists to make PICTURE STATE assertable. A picture that is
// merely present is not interesting; what breaks real documents is the state
// the engine leaves a picture in, so this fixture holds one of each:
//
//   para 2  the engine's DEFAULT after insertPicture — treatAsChar:false,
//           vertRelTo/horzRelTo "Paper". That is a picture anchored to the
//           PAGE rather than to the text: it does not move when the text above
//           it grows, so it slides over paragraphs and destroys the layout.
//           This is the state the image feature exists to detect and fix, so
//           the fixture must contain one for the detector to have something to
//           find.
//   para 4  treatAsChar:true — the safe, inline state. The picture is a
//           character in the text run and reflows with it.
//   para 6  a caption carrying real text, addressed through the cell-by-path
//           API (see buildImageFixture for the trap that guards).
//
// Every picture gets its OWN natural pixel size and its OWN description, so a
// `list` command's output can be pinned to a specific picture rather than to
// "the first one" — an assertion that survives the pictures being reordered.
//
// Sizes are HWPUNIT (1/7200 inch); A4 usable width is 42520, so all three fit
// on the page at their declared size and none of them triggers the engine's
// shrink-to-fit path.
const IMAGE_LINES = [
  "이미지 편집 테스트 문서", // 0  title
  "아래 그림은 삽입 직후의 기본 상태 그대로 두었다.", // 1  body
  "", // 2  ← picture A (default/floating) is the only thing in this paragraph
  "아래 그림은 글자처럼 취급으로 고정한 안전한 상태다.", // 3  body
  "", // 4  ← picture B (treatAsChar)
  "아래 그림에는 캡션이 달려 있다.", // 5  body
  "", // 6  ← picture C (captioned)
  "본문 마지막 문단이며, 그림을 편집해도 그대로 남아 있어야 한다.", // 7  body
];

// Real caption prose, not the engine's auto-generated placeholder. The engine
// creates a caption as the literal text "그림  " when hasCaption is turned on;
// a fixture that kept that would be asserting the engine's default back at
// itself instead of proving the caption can be written and read.
const IMAGE_CAPTION_TEXT = "그림 1. 분기별 매출 추이";

const IMAGE_PICTURES = [
  {
    para: 2,
    description: "기본 상태 그림",
    px: [1600, 1200], // natural pixels — the largest of the three
    size: [24000, 18000], // HWPUNIT, 4:3
    rgb: [0x2f, 0x6f, 0xdf], // blue
    treatAsChar: false, // ← left at the engine default ON PURPOSE
    caption: null,
  },
  {
    para: 4,
    description: "글자처럼 취급 그림",
    px: [400, 300], // smallest, so a size-based assertion cannot confuse it
    size: [9600, 7200],
    rgb: [0x3a, 0xa8, 0x5c], // green
    treatAsChar: true,
    caption: null,
  },
  {
    para: 6,
    description: "캡션 있는 그림",
    px: [800, 600],
    size: [18000, 13500],
    rgb: [0xd9, 0x53, 0x3a], // red
    treatAsChar: false,
    caption: IMAGE_CAPTION_TEXT,
  },
];

// ── a PNG encoder, because the fixture cannot download one ─────────────────
//
// The image bytes have to come from somewhere, and the two obvious sources are
// both wrong: downloading makes the build need a network, and a dependency for
// three solid rectangles is a dependency the delivered skill would carry
// forever. zlib is in Node's standard library and PNG's container is four
// chunks, so the encoder is thirty lines and the fixture stays self-contained.
//
// Solid colors deflate to almost nothing (1600x1200 → ~7.5 kB), which matters
// because these bytes get COMMITTED inside samples/fixture-image.hwp.

const PNG_CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function pngCrc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = PNG_CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// length | type | data | crc32(type+data) — the PNG chunk framing.
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(pngCrc32(typed), 0);
  return Buffer.concat([len, typed, crc]);
}

// A w×h solid-color 8-bit truecolor PNG. Deterministic: deflateSync at a fixed
// level is a pure function of its input, which is what lets the whole fixture
// be sha256-pinned.
export function solidPng(w, h, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type 2 = truecolor RGB
  // 10/11/12 = compression, filter, interlace — all 0, the only values PNG defines.
  const stride = w * 3 + 1; // +1 for the per-scanline filter byte
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const o = y * stride;
    raw[o] = 0; // filter type 0 (None)
    for (let x = 0; x < w; x++) {
      raw[o + 1 + x * 3] = r;
      raw[o + 2 + x * 3] = g;
      raw[o + 3 + x * 3] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // signature
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

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

// ── addressing a picture, and its caption ──────────────────────────────────

// Indices of the picture controls in paragraph (s,p). Probed, never assumed:
// paragraph 0 of every section also carries the invisible SectionDef/ColumnDef
// pair, so "the picture is control 0" is wrong exactly where it matters most.
// getPictureProperties is the probe — it throws "지정된 컨트롤이 그림이
// 아닙니다" for anything that is not a picture.
export function pictureControlsInParagraph(doc, s, p) {
  const out = [];
  for (let c = 0; c < controlOffsets(doc, s, p).length; c++) {
    try {
      doc.getPictureProperties(s, p, c);
      out.push(c);
    } catch {
      /* not a picture */
    }
  }
  return out;
}

// A picture's caption is addressed as if it were a single-cell table hanging
// off the picture control. This one-liner is the whole reason the caption is
// reachable at all, so it lives in one place and both the builder and the
// digest go through it.
const captionPath = (ctrl) =>
  JSON.stringify([{ controlIndex: ctrl, cellIndex: 0, cellParaIndex: 0 }]);

// Caption text of picture control c, or null when it has none.
//
// NOTE the trailing space. The engine appends one U+0020 to a caption when the
// document is saved: a caption written as 15 characters reads back as 16 after
// export→reload. It is added ONCE and does not compound over further
// round-trips (verified to three), and since both sides of a --check are read
// from a saved file they agree — but a caller comparing against the text it
// wrote must expect it.
export function readCaption(doc, s, p, c) {
  try {
    return String(doc.getTextInCellByPath(s, p, captionPath(c), 0, 0x7fffffff) ?? "").normalize("NFC");
  } catch {
    return null;
  }
}

// Pictures have no create.mjs op either, so this fixture drives the engine.
//
// Two engine behaviours make the obvious version of this function wrong, and
// both are ASSERTED here rather than assumed, because both fail silently:
//
//  1. insertPicture IGNORES its char_offset for a body-inline insert. Asking
//     for offset 0 of a 16-character paragraph still parks the picture at
//     offset 16, the end. Measured on 0.7.19 — offsets 0, 5 and 9 all landed
//     at 16. Hence one picture per paragraph, with the paragraph empty: it is
//     the only placement the engine actually honours, so it is the only one
//     the fixture is allowed to claim.
//
//  2. CAPTION TEXT IS NOT BODY TEXT, and the API that looks like it writes a
//     caption writes into the body instead. setPictureProperties returns a
//     `captionCharOffset`, and insertText(s, p, thatOffset, "…") silently
//     appends to the surrounding BODY paragraph — the caption is addressed
//     like a table cell hanging off the picture control, through the ByPath
//     family. The verification pass at the end of this function re-reads every
//     body paragraph for exactly that reason.
async function buildImageFixture(outPath) {
  const doc = await emptyDocument();
  IMAGE_LINES.forEach((text, i) => {
    if (i > 0) doc.insertParagraph(0, i);
    if (text) doc.insertText(0, i, 0, text);
  });

  for (const spec of IMAGE_PICTURES) {
    const png = solidPng(spec.px[0], spec.px[1], spec.rgb);
    // insertPicture reports WHERE it landed; trust the report, not the request.
    const placed = JSON.parse(
      doc.insertPicture(
        0,
        spec.para,
        0,
        "", // empty cell path = body insert, not into a table cell
        new Uint8Array(png),
        spec.size[0],
        spec.size[1],
        spec.px[0],
        spec.px[1],
        "png",
        spec.description,
        null, // paper offsets: let the engine default them
        null,
      ),
    );
    if (!placed.ok || placed.paraIdx !== spec.para) {
      throw new Error(`insertPicture landed wrong: ${JSON.stringify(placed)} (wanted para ${spec.para})`);
    }
    const ctrl = placed.controlIdx;

    if (spec.treatAsChar) {
      // vertRelTo/horzRelTo are set EXPLICITLY, not left to the side effect of
      // treatAsChar. In memory, {treatAsChar:true} alone does flip both to
      // "Para" — but that flip does NOT survive export→reload on 0.7.19: the
      // reloaded picture comes back treatAsChar:true with vertRelTo "Paper".
      // Naming all three is what makes the saved fixture actually inline.
      doc.setPictureProperties(
        0,
        spec.para,
        ctrl,
        JSON.stringify({ treatAsChar: true, vertRelTo: "Para", horzRelTo: "Para" }),
      );
    }

    if (spec.caption) {
      doc.setPictureProperties(
        0,
        spec.para,
        ctrl,
        JSON.stringify({ hasCaption: true, captionDirection: "Bottom", captionWidth: spec.size[0] }),
      );
      // Turning the caption on auto-creates the placeholder text "그림  ", so
      // the real text has to REPLACE it — appending would leave the engine's
      // default glued to the front of ours.
      const path = captionPath(ctrl);
      const had = doc.getCellParagraphLengthByPath(0, spec.para, path);
      if (had > 0) doc.deleteTextInCellByPath(0, spec.para, path, 0, had);
      doc.insertTextInCellByPath(0, spec.para, path, 0, spec.caption);
    }
  }

  // ── verification, before a single byte is written ────────────────────────
  // Everything above returns {"ok":true} whether or not it did anything, so
  // the fixture is only as trustworthy as what can be read back out of it.
  for (const spec of IMAGE_PICTURES) {
    const found = pictureControlsInParagraph(doc, 0, spec.para);
    if (found.length !== 1) {
      throw new Error(`paragraph ${spec.para} should hold exactly one picture, found ${found.length}`);
    }
    const props = JSON.parse(doc.getPictureProperties(0, spec.para, found[0]));
    if (props.treatAsChar !== spec.treatAsChar) {
      throw new Error(`picture in para ${spec.para}: treatAsChar ${props.treatAsChar} != ${spec.treatAsChar}`);
    }
    if (props.description !== spec.description) {
      throw new Error(`picture in para ${spec.para}: description ${JSON.stringify(props.description)}`);
    }
    if (props.hasCaption !== Boolean(spec.caption)) {
      throw new Error(`picture in para ${spec.para}: hasCaption ${props.hasCaption}`);
    }
    if (spec.caption && readCaption(doc, 0, spec.para, found[0]) !== spec.caption) {
      throw new Error(
        `caption text not written: ${JSON.stringify(readCaption(doc, 0, spec.para, found[0]))}`,
      );
    }
  }
  // The caption-writes-into-the-body trap, caught at build time: if the ByPath
  // call ever regresses into an insertText, one of these paragraphs grows.
  IMAGE_LINES.forEach((text, i) => {
    const got = paragraphText(doc, 0, i);
    if (got !== text) {
      throw new Error(`body paragraph ${i} was disturbed: ${JSON.stringify(got)} != ${JSON.stringify(text)}`);
    }
  });

  writeFileSync(outPath, Buffer.from(doc.exportHwp()));
}

export const FIXTURES = {
  "fixture-headings.hwp": (out) => buildParagraphFixture(HEADING_LINES, out),
  "fixture-clause.hwp": (out) => buildParagraphFixture(CLAUSE_LINES, out),
  "fixture-table-only.hwp": (out) => buildTableOnlyFixture(out),
  "fixture-inline.hwp": (out) => buildInlineFixture(out),
  "fixture-image.hwp": (out) => buildImageFixture(out),
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
  IMAGE_LINES,
  IMAGE_PICTURES,
  IMAGE_CAPTION_TEXT,
  INDENT,
};

// ── semantic digest ────────────────────────────────────────────────────────

// Picture state for the digest, or null when control c is not a picture —
// which is also how the invisible SectionDef/ColumnDef pair gets skipped.
//
// doc_walk classifies a picture as kind "other" (it has no picture probe), so
// WITHOUT this the digest would say nothing whatsoever about the image
// fixture's images: a rebuild that dropped every treatAsChar flag, blanked
// every description and lost the caption would still compare equal, and
// --check would report "ok". The state below is precisely the state the
// fixture exists to pin.
//
// Deliberately NOT captured: brightness/contrast/effect/crop/padding and the
// rest of the sixty-odd fields getPictureProperties returns. They are engine
// defaults nobody set, and pinning them would make an engine bump red for a
// reason that has nothing to do with the fixture — the same mistake as
// comparing bytes.
function pictureDigest(doc, s, p, c) {
  let props;
  try {
    props = JSON.parse(doc.getPictureProperties(s, p, c));
  } catch {
    return null;
  }
  const out = {
    width: props.width,
    height: props.height,
    // The three that decide whether the picture flows with the text or floats
    // over it — the whole point of the image fixture.
    treatAsChar: props.treatAsChar,
    vertRelTo: props.vertRelTo,
    horzRelTo: props.horzRelTo,
    description: props.description,
    hasCaption: props.hasCaption,
  };
  if (props.hasCaption) {
    out.captionDirection = props.captionDirection;
    out.caption = readCaption(doc, s, p, c);
  }
  return out;
}

// What a fixture MEANS, as opposed to how it happens to serialize: paragraph
// text, left indent, the kind and offset of every control, every picture's
// layout state and caption, and every table's dimensions and cell text. This
// is what --check compares, and what makes the comparison survive an engine
// bump that changes byte layout.
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
      const controls = classifyParagraphControls(doc, s, p).map((c) => {
        // A picture always classifies as "other", so the picture probe only
        // ever has to run on that branch.
        const picture = c.kind === "other" ? pictureDigest(doc, s, p, c.index) : null;
        return {
          kind: c.kind,
          offset: c.offset,
          ...(c.kind === "equation" ? { script: c.script } : {}),
          ...(c.kind === "footnote" ? { number: c.number, texts: c.texts } : {}),
          ...(c.kind === "table" ? { dims: c.dims } : {}),
          ...(picture ? { picture } : {}),
        };
      });
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
