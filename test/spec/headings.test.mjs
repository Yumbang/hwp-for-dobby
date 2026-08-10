// The heading detector: what it must find, and — mostly — what it must refuse.
//
// src/lib/headings.mjs is a PURE module over an array of blocks, so every case
// here is a hand-built block array rather than a document. That is the point of
// the shape: the interesting inputs (a table-of-contents line sitting three
// paragraphs above the heading it mimics, a 학칙 with 155 date-shaped "1."
// lines) are ones nobody has a real .hwp for, and a detector you can only test
// through the engine is a detector nobody dares change.
//
// The two fixture-derived cases read their text from scripts/build-fixtures.mjs
// (FIXTURE_DATA.HEADING_LINES / CLAUSE_LINES, each entry a [text, indentLevel]
// pair), so samples/fixture-headings.hwp and samples/fixture-clause.hwp and
// these assertions can never drift apart — fixtures.test.mjs pins the committed
// documents against the same source.

import { test } from "node:test";
import assert from "node:assert/strict";
import { detectHeadings, _internals } from "../../src/lib/headings.mjs";
import { FIXTURE_DATA } from "../../scripts/build-fixtures.mjs";

// ── block builders ─────────────────────────────────────────────────────────

// A block array plus a counter that ticks on EVERY props() call. The block
// contract promises props() is memoized on the producer's side; this one
// deliberately is not, so the counter measures what the detector actually asks
// for rather than what a cache happens to absorb.
function build(lines, common = {}) {
  const counter = { calls: 0 };
  const blocks = lines.map((entry, i) => {
    const [text, level = 0, over = {}] = Array.isArray(entry) ? entry : [entry, 0, {}];
    return {
      s: 0,
      p: i,
      index: i,
      text,
      hasTable: over.hasTable ?? false,
      tableIndices: over.tableIndices ?? [],
      ...(over.cell ? { cell: true } : {}),
      props() {
        counter.calls += 1;
        return {
          marginLeft: FIXTURE_DATA.INDENT(level),
          indent: 0,
          alignment: "justify",
          styleName: over.styleName ?? common.styleName ?? "바탕글",
          styleId: 0,
          fontSize: 10,
          bold: false,
          headType: "None",
          paraLevel: 0,
          numberingId: 0,
        };
      },
    };
  });
  return { blocks, counter };
}

const run = (lines, opts, common) => detectHeadings(build(lines, common).blocks, opts);
const titles = (res) => res.nodes.map((n) => n.title);
const ids = (res) => res.nodes.map((n) => `${n.id} ${n.title}`);
const filterCount = (res, id) => res.detection.filters.find((f) => f.id === id).rejected;
const rejectedBy = (res, id) => res.detection.rejected.filter((r) => r.filter === id);

const headingFixture = () => build(FIXTURE_DATA.HEADING_LINES);
const clauseFixture = () => build(FIXTURE_DATA.CLAUSE_LINES);

// A 학칙: three clause headings, two □ items that WOULD give the marker
// strategy a tree, and the amendment history that destroys one.
const HAKCHIK = [
  ["학교 학칙", 0],
  ["제1장 총칙", 0],
  ["제1조(목적) 이 학칙은 학교의 운영에 관한 사항을 규정함을 목적으로 한다.", 0],
  ["제2조(정의) 이 학칙에서 사용하는 용어의 뜻은 다음과 같다.", 0],
  ["제2장 학사", 0],
  ["제3조(학년도) 학년도는 3월 1일부터 다음 해 2월 말일까지로 한다.", 0],
  ["□ 참고 사항", 0],
  ["□ 유의 사항", 0],
  ["부칙", 0],
  ["1. 2015. 5. 1. 일부개정", 0],
  ["2. 2018. 3. 1. 일부개정", 0],
  ["3. 2020. 9. 1. 전부개정", 0],
  ["4. 2024. 3. 1. 일부개정", 0],
];

// ── the twin pair ──────────────────────────────────────────────────────────

test("the TOC twin is rejected and the heading twin survives, in the same document", () => {
  // "1. 사업 개요\t 2" (paragraph 2) and "1. 사업 개요" (paragraph 9). Any
  // detector keying on the leading number gets exactly one of them right; this
  // is the single assertion the whole module exists to pass.
  const res = detectHeadings(headingFixture().blocks);

  const heading = res.nodes.filter((n) => n.title === "1. 사업 개요");
  assert.equal(heading.length, 1, "the heading twin must be found exactly once");
  assert.equal(heading[0].blockIndex, 9, "…and it must be the one at paragraph 9, not paragraph 2");
  assert.ok(
    !res.nodes.some((n) => n.blockIndex === 2),
    "paragraph 2 is a table-of-contents line and must never be a heading",
  );
  assert.equal(filterCount(res, "F2"), 3, "all three TOC lines are rejected");
});

test("fixture-headings: marker depth builds an ordinal tree", () => {
  const res = detectHeadings(headingFixture().blocks);
  assert.equal(res.strategy, "marker");
  assert.deepEqual(res.detection.levels, { NUM1: 1, BOX: 2, CIRCLE: 3 });
  assert.deepEqual(ids(res), [
    "1 1. 사업 개요",
    "1.1 □ 추진 배경",
    "1.1.1 ○ 국내 현황",
    "1.1.2 ○ 해외 현황",
    "1.2 □ 추진 목표",
    "2 2. 추진 체계",
    "2.1 □ 조직 구성",
    "2.1.1 ○ 총괄 부서",
    "3 3. 기대 효과",
  ]);
  // The id is painted on AFTER the tree is built, so "1." "2." "3." on the page
  // and 1/2/3 in the tree agreeing here is a coincidence, not a mechanism.
  const root = res.tree[0];
  assert.equal(res.tree.length, 3);
  assert.equal(root.children.length, 2);
  assert.equal(root.children[0].children.length, 2);
});

// ── the false-positive filters, F1..F11 ───────────────────────────────────

test("F1 rejects amendment-date lines but never a clause heading", () => {
  const res = detectHeadings(build(HAKCHIK).blocks);
  assert.equal(filterCount(res, "F1"), 4, "the four 부칙 history lines");
  assert.ok(!res.nodes.some((n) => n.markerClass === "NUM1"));
  // 제3조 mentions "3월 1일" and 제N조 lines routinely carry a 시행 date; the
  // structural classes are exempt from F1 for exactly that reason.
  assert.ok(res.nodes.some((n) => n.title === "제3조(학년도)"));
});

test("F2 rejects a table-of-contents line by its page number and by its echo", () => {
  const res = detectHeadings(headingFixture().blocks);
  const hits = rejectedBy(res, "F2");
  assert.deepEqual(
    hits.map((h) => h.index),
    [2, 3, 4],
  );
  assert.equal(hits[0].detail, "tab+page-number");

  // Strip the page numbers and the tab: the "this title turns up again later"
  // half of F2 still catches the first three, because they sit in the leading
  // quarter of the document and reappear verbatim further down.
  const noTabs = FIXTURE_DATA.HEADING_LINES.map(([t, l], i) =>
    i >= 2 && i <= 4 ? [t.replace(/\t.*$/, ""), l] : [t, l],
  );
  const res2 = detectHeadings(build(noTabs).blocks);
  assert.equal(
    rejectedBy(res2, "F2").every((h) => h.detail === "repeated-later"),
    true,
  );
  assert.ok(res2.nodes.some((n) => n.blockIndex === 9), "the later twin still survives");
});

test("F3 rejects a line-initial cross-reference; a mid-sentence one never matches at all", () => {
  const res = detectHeadings(
    build([
      ["제1조(목적) 이 규정은 학교의 운영에 관한 사항을 정한다.", 0],
      ["제2조(적용) 이 규정은 모든 구성원에게 적용한다.", 0],
      ["제3조에 따른 부서에 각각 위원회를 둘 수 있다.", 0],
      ["제4조(위원회) 제3조에 따른 부서에 위원회를 둔다.", 0],
    ]).blocks,
  );
  assert.equal(filterCount(res, "F3"), 1);
  assert.deepEqual(titles(res), ["제1조(목적)", "제2조(적용)", "제4조(위원회)"]);

  // The mid-sentence reference inside 제4조's body is not a rejection — it is
  // structurally unmatchable, because every marker regex is ^-anchored and run
  // with a single exec. Nothing counted it because nothing ever saw it.
  const jo4 = res.nodes.find((n) => n.title === "제4조(위원회)");
  assert.ok(jo4.headEnd > 0 && jo4.headEnd < 12, "제4조's body starts right after its caption");
});

test("F4 rejects a table caption sitting between two real headings", () => {
  const res = detectHeadings(headingFixture().blocks);
  assert.deepEqual(
    rejectedBy(res, "F4").map((r) => r.index),
    [14],
  );
  // Its neighbours — the ○ above it and the □ below — are unharmed.
  assert.ok(res.nodes.some((n) => n.blockIndex === 13));
  assert.ok(res.nodes.some((n) => n.blockIndex === 15));
});

test("F5 rejects footnote and source apparatus, not every leading star", () => {
  const res = detectHeadings(
    build([
      ["□ 추진 배경", 0],
      ["** 각주 표시", 0],
      ["* 자료: 통계청", 0],
      ["□ 추진 목표", 0],
    ]).blocks,
  );
  assert.equal(filterCount(res, "F5"), 2);
  assert.deepEqual(titles(res), ["□ 추진 배경", "□ 추진 목표"]);
});

test("F6 refuses a table cell even though the contract says it can never arrive", () => {
  // Blocks are body-only, so this filter should read 0 forever. It is a
  // tripwire for the day a producer starts flattening cells into the stream —
  // a cell's short numeric text hits the ^\d rules constantly.
  const res = detectHeadings(
    build([
      ["□ 조직 구성", 0],
      ["1. 교무처", 0, { cell: true }],
      ["□ 예산 편성", 0],
    ]).blocks,
  );
  assert.equal(filterCount(res, "F6"), 1);
  assert.deepEqual(titles(res), ["□ 조직 구성", "□ 예산 편성"]);
  assert.equal(filterCount(detectHeadings(headingFixture().blocks), "F6"), 0);
});

test("F7 rejects a sentence wearing a bullet", () => {
  const res = detectHeadings(headingFixture().blocks);
  const hits = rejectedBy(res, "F7").map((r) => r.index);
  // paragraph 12 "- 시장 규모는 연 12% 성장하고 있다.", 21 "* 각주 성격의 …
  // 아니다.", 22 "※ … 있음."
  assert.deepEqual(hits, [12, 21, 22]);
  assert.ok(res.nodes.some((n) => n.blockIndex === 11), "the ○ above it survives");
  assert.ok(res.nodes.some((n) => n.blockIndex === 13), "and the ○ below it too");
});

test("F7 does not touch an inline clause heading, whose body always ends in -다", () => {
  const res = detectHeadings(clauseFixture().blocks);
  assert.equal(filterCount(res, "F7"), 0);
  assert.equal(res.nodes.filter((n) => n.markerClass === "CLAUSE_JO").length, 4);
});

test("F8 rejects a number that is out of sequence, keeping the sequence around it", () => {
  const res = detectHeadings(
    build([
      ["1. 사업 개요", 0],
      ["5. 다음 회계연도 예산", 0],
      ["2. 추진 체계", 0],
      ["3. 기대 효과", 0],
    ]).blocks,
  );
  assert.equal(filterCount(res, "F8"), 1);
  assert.deepEqual(rejectedBy(res, "F8")[0].detail, "1 → 5");
  assert.deepEqual(titles(res), ["1. 사업 개요", "2. 추진 체계", "3. 기대 효과"]);
});

test("F9 rejects a dense back-to-back enumeration (an attachment list)", () => {
  const res = detectHeadings(
    build([
      ["□ 총괄", 0],
      ["□ 세부 내용", 0],
      ["붙임 1 사업계획서", 0],
      ["붙임 2 예산내역", 0],
      ["붙임 3 추진일정", 0],
      ["붙임 4 조직도", 0],
      ["붙임 5 위탁계약서", 0],
      ["붙임 6 참고자료", 0],
    ]).blocks,
  );
  assert.equal(filterCount(res, "F9"), 6);
  assert.deepEqual(titles(res), ["□ 총괄", "□ 세부 내용"]);

  // One short of the run threshold and the same lines are kept — the rule is
  // "a long run", not "붙임 is never a heading".
  const shorter = detectHeadings(
    build([
      ["□ 총괄", 0],
      ["□ 세부 내용", 0],
      ["붙임 1 사업계획서", 0],
      ["붙임 2 예산내역", 0],
    ]).blocks,
  );
  assert.equal(filterCount(shorter, "F9"), 0);
  assert.equal(shorter.nodes.filter((n) => n.markerClass === "ATTACHMENT").length, 2);
});

test("F10 rejects an overlong line whatever it starts with", () => {
  const long = "□ " + "본 사업은 관계 기관과의 협의를 거쳐 단계적으로 추진할 예정이며 ".repeat(4);
  assert.ok(long.length > _internals.MAX_HEADING_LEN);
  const res = detectHeadings(
    build([
      ["□ 추진 배경", 0],
      [long, 0],
      ["□ 추진 목표", 0],
    ]).blocks,
  );
  assert.equal(filterCount(res, "F10"), 1);
  assert.deepEqual(titles(res), ["□ 추진 배경", "□ 추진 목표"]);
});

test("F11 counts blank paragraphs and never emits them", () => {
  const res = detectHeadings(headingFixture().blocks);
  assert.equal(filterCount(res, "F11"), 3, "paragraphs 1, 5 and 8 are empty");
  assert.ok(res.nodes.every((n) => n.title.trim().length > 0));
});

// ── the clause path ────────────────────────────────────────────────────────

test("fixture-clause: the clause strategy wins and 제N조 splits into title + body", () => {
  const { blocks } = clauseFixture();
  const res = detectHeadings(blocks);

  assert.equal(res.strategy, "clause");
  assert.equal(res.detection.confidence, "high");
  assert.deepEqual(res.detection.levels, { CLAUSE_JANG: 1, CLAUSE_JO: 2 });
  assert.deepEqual(ids(res), [
    "1 제1장 총칙",
    "1.1 제1조(목적)",
    "1.2 제2조(적용범위)",
    "2 제2장 조직",
    "2.1 제3조(부서)",
    "2.2 제4조(위원회)",
    "3 부칙",
  ]);

  // The split: headEnd is a char offset into the ORIGINAL paragraph text, so a
  // caller can take the body span without re-parsing anything.
  const jo1 = res.nodes.find((n) => n.title === "제1조(목적)");
  const raw = blocks[jo1.blockIndex].text;
  assert.equal(jo1.headEnd, "제1조(목적)".length);
  assert.equal(raw.slice(0, jo1.headEnd), "제1조(목적)");
  assert.equal(raw.slice(jo1.headEnd).trim(), "이 규정은 학교의 운영에 관한 사항을 정함을 목적으로 한다.");

  // 부칙 rides on the 장 class rather than getting one of its own: it sits at
  // 장 depth in every regulation, and a class of its own would be ordered by
  // first appearance — which for 부칙 is always last, i.e. deepest.
  assert.equal(res.nodes.at(-1).markerClass, "CLAUSE_JANG");
  assert.equal(res.nodes.at(-1).headEnd, 0, "a standalone heading reports headEnd 0");

  // Typeable, document-unique handles.
  assert.deepEqual(
    res.nodes.map((n) => n.ref),
    ["제1장", "제1조", "제2조", "제2장", "제3조", "제4조", "부칙"],
  );
});

test("the clause strategy leaves numbered lines as body rather than nesting them", () => {
  const res = detectHeadings(clauseFixture().blocks);
  // "1. 교무처" / "2. 학생처" are perfectly good NUM1 candidates and are still
  // excluded — see the 학칙 test below for why letting them in is fatal.
  assert.ok(!res.nodes.some((n) => n.markerClass === "NUM1"));
  assert.ok(res.detection.notes.some((n) => /non-clause candidate/.test(n)));
});

test("a mid-sentence 제3조 is never a heading, in any strategy", () => {
  const { blocks } = clauseFixture();
  // Paragraph 9 is "제4조(위원회) 제3조에 따른 부서에 …" — a heading that also
  // MENTIONS another clause. The heading is 제4조; the 제3조 inside its body must
  // not produce a second node, must not steal the paragraph, and must not
  // collide with the real 제3조 four paragraphs earlier.
  const xref = blocks.findIndex((b) => b.text.startsWith("제4조") && b.text.includes("제3조"));
  assert.ok(xref > 0, "the fixture must contain a mid-sentence cross-reference");

  for (const detect of ["auto", "clause", "marker"]) {
    const res = detectHeadings(blocks, { detect });
    const here = res.nodes.filter((n) => n.blockIndex === xref);
    assert.equal(here.length, 1, `detect=${detect}: at most one heading per block`);
    assert.equal(here[0].ref, "제4조", `detect=${detect} read the cross-reference as the heading`);
    assert.equal(
      res.nodes.filter((n) => n.ref === "제3조").length,
      1,
      `detect=${detect} duplicated 제3조`,
    );
    assert.ok(res.nodes.find((n) => n.ref === "제3조").blockIndex < xref);
  }
});

// ── the ladder ─────────────────────────────────────────────────────────────

test("clause outranks marker: 155 date lines must not outvote 제N조", () => {
  const res = detectHeadings(build(HAKCHIK).blocks);
  assert.equal(res.strategy, "clause");
  assert.deepEqual(
    res.detection.ladder.map((l) => `${l.strategy}:${l.chosen}`),
    ["style:false", "clause:true"],
    "the ladder stops at rank 2 — marker is never even asked",
  );
  // The □ lines are a viable marker tree, which is what makes this a real
  // contest rather than a walkover: strip the 제N조 lines and rank 3 does take
  // over. (제N장/부칙 stay, because a structural class is adopted by the marker
  // learner too — it just no longer decides which strategy runs.)
  const bare = detectHeadings(build(HAKCHIK.filter(([t]) => !/^제\d+조/.test(t))).blocks);
  assert.equal(bare.strategy, "marker");
  assert.deepEqual(bare.detection.levels, { CLAUSE_JANG: 1, BOX: 2 });
  assert.ok(!bare.nodes.some((n) => n.markerClass === "NUM1"), "F1 still holds the date lines out");
});

test("auto never selects regex, and an explicit regex overrides everything", () => {
  const lines = [
    ["제1편 총론", 0],
    ["이 편은 총론을 다룬다.", 0],
    ["제2편 각론", 0],
  ];
  const auto = run(lines);
  assert.equal(auto.strategy, "none");
  assert.ok(!auto.detection.ladder.some((l) => l.strategy === "regex"));

  const forced = run(lines, { detect: "regex", headingRegex: "^(?<title>제\\d+편.*)$" });
  assert.equal(forced.strategy, "regex");
  assert.equal(forced.detection.confidence, "high");
  assert.deepEqual(ids(forced), ["1 제1편 총론", "2 제2편 각론"]);

  // Authoritative means authoritative: a user pattern is not second-guessed by
  // the false-positive filters, so it can pick up the ※ line auto refuses.
  const notes = run(FIXTURE_DATA.HEADING_LINES, { detect: "regex", headingRegex: "^※" });
  assert.equal(notes.nodes.length, 1);
  assert.ok(notes.nodes[0].title.startsWith("※"));
  const auto2 = detectHeadings(headingFixture().blocks);
  assert.equal(auto2.nodes.some((n) => n.title.startsWith("※")), false);

  assert.throws(() => run(lines, { detect: "regex" }), /requires opts\.headingRegex/);
});

test("a body-less document falls through to the table strategy, not to []", () => {
  const empty = [
    ["", 0],
    ["", 0, { hasTable: true, tableIndices: [2] }],
    ["", 0],
  ];
  const res = detectHeadings(build(empty).blocks);
  assert.equal(res.strategy, "table");
  assert.deepEqual(res.detection.ladder.at(-1), {
    rank: 4,
    strategy: "table",
    chosen: true,
    why: "1 table(s) and 0 non-empty body block(s)",
  });
  assert.equal(res.nodes.length, 1);
  assert.deepEqual(
    { id: res.nodes[0].id, ref: res.nodes[0].ref, title: res.nodes[0].title, level: res.nodes[0].level },
    { id: "1", ref: "T0", title: "표 1", level: 1 },
  );
  // Low confidence, and the object says why without anyone having to infer it.
  assert.equal(res.detection.confidence, "low");
  assert.match(res.detection.lowConfidenceReasons.join(" "), /no body outline/);

  // A caller that can read the table's header row supplies a better title.
  const named = detectHeadings(build(empty).blocks, { tableTitles: [FIXTURE_DATA.TABLE_ONLY_HEADER] });
  assert.equal(named.nodes[0].title, FIXTURE_DATA.TABLE_ONLY_HEADER);
});

test("the style rank is rejected on a 바탕글 document, and says so", () => {
  const res = detectHeadings(headingFixture().blocks);
  const style = res.detection.ladder.find((l) => l.strategy === "style");
  assert.equal(style.chosen, false);
  assert.match(style.why, /heading style\(s\) actually used/);
  assert.equal(res.detection.style.distinctStyles.length, 0);
});

test("the style rank wins when two heading styles are genuinely in use", () => {
  // Two body paragraphs per heading, because heading styles covering more than
  // 40% of a document are not heading styles — they are the body style under
  // another name, and the rank rejects them for it.
  const body = (n) => [`본 항목의 세부 내용은 관계 부서와 협의하여 별도로 정한다. (${n})`, 0];
  const styled = [
    ["사업 추진 계획", 0, { styleName: "개요 1" }],
    body(1),
    body(2),
    ["세부 추진 사항", 0, { styleName: "개요 2" }],
    body(3),
    body(4),
    ["기대 효과", 0, { styleName: "개요 1" }],
    body(5),
    body(6),
    ["세부 기대 효과", 0, { styleName: "개요 2" }],
    body(7),
    body(8),
  ];
  const res = detectHeadings(build(styled).blocks);
  assert.equal(res.strategy, "style");
  assert.deepEqual(res.detection.levels, { "개요 1": 1, "개요 2": 2 });
  assert.deepEqual(ids(res), [
    "1 사업 추진 계획",
    "1.1 세부 추진 사항",
    "2 기대 효과",
    "2.1 세부 기대 효과",
  ]);
});

test("the style rank reports an exhausted budget as inconclusive, not as a no", () => {
  // "≥2 heading styles ACTUALLY USED" is a claim about every paragraph, and
  // styleName only arrives through props(). There is no text-only proxy, so
  // the rank is budgeted; when the budget runs out it must say it did not
  // establish a negative, rather than quietly reporting one.
  const lines = [];
  for (let i = 0; i < 60; i++) lines.push([`짧은 항목 ${i}`, 0]);
  lines.push(["사업 추진 계획", 0, { styleName: "개요 1" }]);
  lines.push(["세부 추진 사항", 0, { styleName: "개요 2" }]);

  const stingy = detectHeadings(build(lines).blocks, { styleBudget: 10 });
  assert.equal(stingy.detection.style.truncated, true);
  assert.equal(stingy.detection.style.probed, 10);
  assert.match(stingy.detection.ladder[0].why, /inconclusive, not negative/);

  // props() is what the budget buys, so it is what the budget caps.
  const { blocks, counter } = build(lines);
  detectHeadings(blocks, { styleBudget: 10 });
  assert.equal(counter.calls, 10);

  const patient = detectHeadings(build(lines).blocks, { styleBudget: Infinity });
  assert.equal(patient.detection.style.truncated, false);
  assert.equal(patient.detection.style.probed, lines.length);
});

// ── the depth learner ──────────────────────────────────────────────────────

test("marker depth is LEARNED per document: □ < ○ < -", () => {
  const res = detectHeadings(
    build([
      ["□ 추진 배경", 0],
      ["○ 국내 현황", 1],
      ["- 시장 규모 확대", 2],
      ["- 수출 비중 증가", 2],
      ["○ 해외 현황", 1],
      ["- 신흥국 성장", 2],
      ["□ 추진 목표", 0],
      ["○ 단기 과제", 1],
      ["- 시범 사업 착수", 2],
    ]).blocks,
  );
  assert.equal(res.strategy, "marker");
  assert.deepEqual(res.detection.levels, { BOX: 1, CIRCLE: 2, DASH: 3 });
  assert.deepEqual(ids(res).slice(0, 4), [
    "1 □ 추진 배경",
    "1.1 ○ 국내 현황",
    "1.1.1 - 시장 규모 확대",
    "1.1.2 - 수출 비중 증가",
  ]);
});

test("depth still comes out right when the document carries no indent at all", () => {
  // marginLeft reads 0 when unknown, which is most of the time. With indent
  // silent, ordering falls to transitions (usually degenerate on a cyclic
  // outline) and then to first appearance, which is what actually decides it.
  const flat = [
    ["□ 추진 배경", 0],
    ["○ 국내 현황", 0],
    ["○ 해외 현황", 0],
    ["□ 추진 목표", 0],
    ["○ 단기 과제", 0],
  ];
  const res = detectHeadings(build(flat).blocks);
  assert.deepEqual(res.detection.levels, { BOX: 1, CIRCLE: 2 });
  assert.deepEqual(ids(res), [
    "1 □ 추진 배경",
    "1.1 ○ 국내 현황",
    "1.2 ○ 해외 현황",
    "2 □ 추진 목표",
    "2.1 ○ 단기 과제",
  ]);
});

test("one line is not a level: a class below MIN_CLASS_SUPPORT is not adopted", () => {
  const res = detectHeadings(
    build([
      ["□ 추진 배경", 0],
      ["□ 추진 목표", 0],
      ["- 단일 항목", 1],
    ]).blocks,
  );
  assert.deepEqual(res.detection.levels, { BOX: 1 });
  const dash = res.detection.classes.find((c) => c.class === "DASH");
  assert.equal(dash.adopted, false);
  assert.match(dash.verdict, /only 1 line/);
});

test("a class that would exceed maxLevel is DROPPED, not clamped", () => {
  const lines = [
    ["1. 추진 개요", 0],
    ["□ 배경", 1],
    ["○ 국내 동향", 2],
    ["① 수요 증가", 3],
    ["- 시장 확대", 4],
    ["① 공급 확대", 3],
    ["- 설비 증설", 4],
    ["○ 해외 동향", 2],
    ["□ 목표", 1],
    ["2. 추진 체계", 0],
    ["□ 조직", 1],
    ["○ 총괄 부서", 2],
  ];
  const res = detectHeadings(build(lines).blocks, { maxLevel: 4 });
  assert.deepEqual(res.detection.levels, { NUM1: 1, BOX: 2, CIRCLE: 3, CIRCLED: 4 });
  assert.deepEqual(res.detection.dropped, [{ class: "DASH", wouldBeLevel: 5 }]);
  assert.ok(!res.nodes.some((n) => n.markerClass === "DASH"), "the - lines are body, not headings");

  // The anti-clamp assertion. Clamped to 4, "- 시장 확대" would become a SIBLING
  // of "① 수요 증가" — its own parent's peer — and 국내 동향 would show four
  // children in the wrong order instead of two.
  const kukne = res.nodes.find((n) => n.title === "○ 국내 동향");
  assert.deepEqual(
    kukne.children.map((c) => c.title),
    ["① 수요 증가", "① 공급 확대"],
  );
  assert.equal(res.detection.lowConfidenceReasons.join(" ").includes("dropped"), true);

  // With room for it, the same input keeps all five levels.
  const roomy = detectHeadings(build(lines).blocks, { maxLevel: 5 });
  assert.deepEqual(roomy.detection.levels, { NUM1: 1, BOX: 2, CIRCLE: 3, CIRCLED: 4, DASH: 5 });
  assert.equal(roomy.nodes.find((n) => n.title === "① 수요 증가").children.length, 1);
});

test("hard constraints survive a statistics run that contradicts them", () => {
  // Indent alone would put 제N조 above 제N장 here. 장 < 절 < 조 is not
  // negotiable, so repairOrder pulls it back.
  assert.deepEqual(_internals.repairOrder(["CLAUSE_JO", "CLAUSE_JANG", "CLAUSE_JEOL"]), [
    "CLAUSE_JANG",
    "CLAUSE_JEOL",
    "CLAUSE_JO",
  ]);
  assert.deepEqual(_internals.repairOrder(["NUM2", "NUM1"]), ["NUM1", "NUM2"]);
  assert.deepEqual(_internals.repairOrder(["DASH", "STAR"]), ["STAR", "DASH"]);
  // Unconstrained classes keep the order the statistics gave them.
  assert.deepEqual(_internals.repairOrder(["CIRCLE", "BOX"]), ["CIRCLE", "BOX"]);
});

test("opts.markerLevel overrides the learner outright", () => {
  const lines = [
    ["□ 추진 배경", 0],
    ["○ 국내 현황", 1],
    ["○ 해외 현황", 1],
    ["□ 추진 목표", 0],
  ];
  const res = detectHeadings(build(lines).blocks, { markerLevel: { "○": 1, "□": 2 } });
  assert.deepEqual(res.detection.levels, { CIRCLE: 1, BOX: 2 });
  assert.deepEqual(ids(res), ["1 □ 추진 배경", "2 ○ 국내 현황", "3 ○ 해외 현황", "3.1 □ 추진 목표"]);
  assert.ok(res.detection.notes.some((n) => /markerLevel/.test(n)));
});

// ── cost ───────────────────────────────────────────────────────────────────

test("props() is paid for on candidates only, never on the whole document", () => {
  // 1,200 paragraphs: 1,160 of prose and 40 headings. props() is an engine
  // round-trip, so a detector that touches every paragraph turns a 40-page
  // document into a stall. Pass 1 is pure text; only the survivors cost
  // anything.
  const lines = [];
  for (let i = 0; i < 40; i++) {
    lines.push([`□ 추진 과제 ${i + 1}`, 0]);
    for (let j = 0; j < 29; j++) {
      lines.push([
        `본 항목은 관계 기관과의 협의를 거쳐 단계적으로 추진할 예정이며 세부 사항은 별도로 정한다. (${i}-${j})`,
        0,
      ]);
    }
  }
  const { blocks, counter } = build(lines);
  assert.equal(blocks.length, 1200);

  const res = detectHeadings(blocks);
  assert.equal(res.strategy, "marker");
  assert.equal(res.nodes.length, 40);
  assert.equal(counter.calls, res.detection.propsProbed, "the report must state what it spent");
  assert.ok(
    counter.calls <= blocks.length * 0.1,
    `props() called ${counter.calls} times for ${blocks.length} blocks — the budget is 10%`,
  );
  // And it is exactly the candidates: no block gets probed twice, because the
  // module memoizes rather than trusting the producer to.
  assert.equal(counter.calls, 40);
});

test("a document with nothing to find costs nothing and admits it", () => {
  const { blocks, counter } = build([
    ["이 문서는 특별한 구조를 가지고 있지 않으며 모든 문단이 표지 없는 평범한 본문으로만 이어진다.", 0],
    ["두 번째 문단 역시 아무런 표지 없이 이어지는 평범한 서술형 문장이며 표지가 전혀 없는 본문이다.", 0],
  ]);
  const res = detectHeadings(blocks);
  assert.equal(res.strategy, "none");
  assert.deepEqual(res.nodes, []);
  assert.deepEqual(res.tree, []);
  assert.equal(res.detection.confidence, "low");
  assert.equal(counter.calls, 0, "no candidates, no engine calls");
});

// ── contract ───────────────────────────────────────────────────────────────

test("the same input twice produces a deeply equal result", () => {
  const a = detectHeadings(headingFixture().blocks);
  const b = detectHeadings(headingFixture().blocks);
  assert.deepStrictEqual(a, b);
  // …and it survives a JSON round-trip, so a caller can print the honesty
  // report to stderr without tripping over a cycle.
  assert.deepStrictEqual(JSON.parse(JSON.stringify(a.detection)), a.detection);
});

test("every node carries the shape a consumer is promised", () => {
  const res = detectHeadings(headingFixture().blocks);
  for (const n of res.nodes) {
    assert.match(n.id, /^\d+(\.\d+)*$/);
    assert.ok(n.ref === null || typeof n.ref === "string");
    assert.equal(typeof n.title, "string");
    assert.ok(Number.isInteger(n.level) && n.level >= 1 && n.level <= 4);
    assert.ok(Number.isInteger(n.blockIndex));
    assert.ok(Number.isInteger(n.headEnd) && n.headEnd >= 0);
    assert.ok(Array.isArray(n.children));
    assert.equal(typeof n.markerClass, "string");
  }
  // nodes is document order; tree is the same objects nested.
  assert.deepEqual(
    res.nodes.map((n) => n.blockIndex),
    [...res.nodes.map((n) => n.blockIndex)].sort((x, y) => x - y),
  );
  const flatten = (list) => list.flatMap((n) => [n, ...flatten(n.children)]);
  assert.equal(flatten(res.tree).length, res.nodes.length);
  assert.ok(flatten(res.tree).every((n) => res.nodes.includes(n)));
});

test("the honesty report carries the ladder, the filters and the class histogram", () => {
  const d = detectHeadings(headingFixture().blocks).detection;
  assert.equal(d.blockCount, FIXTURE_DATA.HEADING_LINES.length);
  assert.equal(d.filters.length, 11, "F1..F11 are all reported, even at zero");
  assert.deepEqual(
    d.filters.map((f) => f.id),
    ["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11"],
  );
  assert.ok(d.filters.every((f) => typeof f.why === "string" && f.why.length > 20));

  // The classes it saw and refused are reported too — "we saw a ※ and ignored
  // it on purpose" is more useful to a caller than silence.
  const note = d.classes.find((c) => c.class === "NOTE");
  assert.equal(note.disposition, "NEVER");
  assert.equal(note.raw, 1);
  assert.equal(note.adopted, false);
  const circle = d.classes.find((c) => c.class === "CIRCLE");
  assert.equal(circle.purity, 1);
  assert.equal(circle.modalIndent, FIXTURE_DATA.INDENT(1));
  assert.match(circle.verdict, /≥ 0\.75/);
});

test("the thresholds are the documented ones", () => {
  // 0.55 sits within 0.05 of a real rejection in the survey. If this test is
  // failing because someone nudged the constant, that is the review it needs.
  assert.equal(_internals.HEADINGY_PURITY, 0.55);
  assert.equal(_internals.CONDITIONAL_PURITY, 0.75);
  const withDisposition = (d) => _internals.CATALOGUE.filter((c) => c.disposition === d).map((c) => c.glyph);
  const conditional = withDisposition("CONDITIONAL");
  assert.deepEqual(conditional, ["○", "①", "*", "-"]);
  const never = withDisposition("NEVER");
  assert.deepEqual(never, ["※", "<표 N>"]);
});

test("bad options fail loudly instead of guessing", () => {
  assert.throws(() => detectHeadings([], { detect: "outline" }), /unknown detect/);
  assert.throws(() => detectHeadings([], { maxLevel: 0 }), /maxLevel/);
  // An empty document is not an error, though.
  const res = detectHeadings([]);
  assert.equal(res.strategy, "none");
  assert.deepEqual(res.nodes, []);
});
