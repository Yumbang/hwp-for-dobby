// Finding the outline of a Korean HWP document — from its TEXT, not its metadata.
//
// PURE MODULE. No engine, no filesystem, no process.exit, no printing. It takes
// an array of blocks (one per body paragraph) and returns a detection result.
// That is deliberate: the hard part here is judgement, and judgement you cannot
// test without a document is judgement nobody will ever change again.
//
// ── Why this is not the docx algorithm ─────────────────────────────────────
//
// A .docx tells you its outline: Heading N styles, or a numbering definition
// with a level on every paragraph. Korean HWP documents, in practice, tell you
// nothing. Surveyed across ~18 real documents plus the committed fixtures:
//
//   * 44/44 body paragraphs carried style 바탕글. The built-in 개요 1..7 styles
//     EXIST in every document — the engine will happily list them — and are
//     almost never USED. So their existence proves nothing; only usage counts.
//   * headType / paraLevel / numberingId read "None" / 0 / 0 on ~100% of
//     paragraphs across ~80 documents. The Word-shaped fields are all there and
//     all empty. (Pinned by test/spec/fixtures.test.mjs.)
//   * Three-level dotted numbering (1.1.1) NEVER appeared. Depth is carried by
//     MARKER GLYPH + INDENT: □ → ○ → -. So `id.split(".").length` — the docx
//     skill's depth model — has nothing to read.
//   * Clause headings are INLINE: "제1조(목적) 이 규정은 …" is one paragraph
//     holding both the title and its body.
//   * 22% of real documents have ZERO body paragraphs (everything lives inside
//     tables) and 33% have ≤3.
//
// So the outline has to be INFERRED from text, and the levels have to be
// LEARNED PER DOCUMENT, because □/○/- mean "level 1/2/3" only relative to which
// of them this particular document happens to use.
//
// ── The two rules that keep the tree upright ──────────────────────────────
//
// THE ID COMES FROM THE TREE; THE TREE DOES NOT COME FROM THE ID. Levels build
// the tree, then `id` is painted on as the ordinal path (1, 1.1, 1.2, 2, …).
// Deriving structure from a printed number is what breaks the moment a document
// numbers its sections 1., 1., 2. — or not at all.
//
// AT MOST ONE HEADING PER BLOCK. Every marker regex is ^-anchored and matched
// with a single exec, never a /g/ loop. That is what lets a caller attach a body
// span to a heading without a second heading boundary landing mid-paragraph —
// and it is also, for free, the reason a mid-sentence "제3조" cross-reference can
// never be mistaken for a heading (filter F3).
//
// ── Cost ──────────────────────────────────────────────────────────────────
//
// `block.props()` is an engine round-trip. Pass 1 uses ONLY `block.text` (plain
// JS regex) to pick candidates, and props() is paid for on candidates only —
// typically 5-10% of a document. Everything that wants a paragraph property has
// to earn it by looking heading-shaped first. There is exactly one exception —
// the style ladder rank, which cannot be answered from text at all and is
// BUDGETED rather than free. See the comment above styleCensus().

// ── thresholds ─────────────────────────────────────────────────────────────

// Purity = the fraction of a marker class's surviving lines that are SHORT
// (heading-shaped). It is the only defence a glyph like "-" has, because "-" is
// also how every Korean document writes a bullet in the middle of a sentence.
//
// HEADINGY_PURITY (□, 1., 가., (1), 붙임) — these glyphs mean "outline item"
// far more often than not, so they get a low bar. THIS NUMBER IS FRAGILE: the
// weakest genuine class in the survey scored 0.60, i.e. one more long line
// would have put it at 0.50 and the document would have lost a whole level.
// 0.05 of margin. Do not nudge it without re-running the survey.
const HEADINGY_PURITY = 0.55;

// CONDITIONAL_PURITY (①, ○, -, *) — these are used as ordinary in-prose bullets
// constantly, so they must be nearly all short before they are believed. In
// prose-heavy documents these classes land around 0.6-0.7, which is exactly
// what 0.75 is positioned to exclude.
const CONDITIONAL_PURITY = 0.75;

// A heading is short. 40 characters covers every genuine outline item in the
// survey (they ran 4-30) with headroom for a long noun phrase.
const SHORT_LEN = 40;

// …and beyond this it is prose, whatever it starts with (filter F10).
const MAX_HEADING_LEN = 100;

// A class needs more than one line to prove a level exists. One "-" line is a
// bullet; six are an outline level.
const MIN_CLASS_SUPPORT = 2;

// A run of this many CONSECUTIVE numbered lines with nothing between them is an
// enumeration (an attachment list, a list of committee members), not an outline
// (filter F9).
const DENSE_RUN_MIN = 6;

// A table of contents lives at the front. F2's "this title appears again later"
// rule only fires inside this leading fraction of the document, so a heading
// that legitimately repeats in the middle of a long document is left alone.
const TOC_ZONE = 0.25;

// The style ladder rank cannot be answered from text alone — see styleCensus().
// This bounds what it is allowed to spend before it gives up and says so.
const STYLE_PROBE_BUDGET = 200;

// Heading styles that cover more than this share of the document are not
// heading styles, they are the body style with a fancy name.
const STYLE_MAX_SHARE = 0.4;

const DEFAULT_MAX_LEVEL = 4;

// ── the marker catalogue ───────────────────────────────────────────────────
//
// Order is SHALLOW → DEEP, and it is load-bearing twice over: it is the order
// the regexes are tried in (first match wins, so 1.1 must be reachable before
// 1. claims it — handled by NUM1's negative lookahead rather than by order),
// and it is the FINAL tiebreak when the learner cannot separate two classes by
// indent, transitions or first appearance. Being last means the answer is at
// least the conventional Korean one, and the same one every run.
//
// disposition:
//   ALWAYS      structural by definition (장/절/조). Adopted on sight.
//   HEADINGY    usually an outline marker. Adopted at HEADINGY_PURITY.
//   CONDITIONAL also an ordinary bullet. Adopted at CONDITIONAL_PURITY.
//   NEVER       never an outline marker (※ is a note, <표 1> is a caption).
//               Kept in the catalogue anyway so they show up in the histogram —
//               "we saw 14 ※ lines and deliberately ignored them" is a more
//               useful report than silence.

const HANGUL_ORDER = "가나다라마바사아자차카타파하";

const CATALOGUE = [
  {
    id: "ATTACHMENT",
    glyph: "붙임",
    disposition: "HEADINGY",
    re: /^(붙\s*임|별\s*첨|별\s*표|별\s*지)\s*(\d+)?/,
    ordinal: (m) => (m[2] ? Number(m[2]) : null),
  },
  {
    // 부칙 is an alias, not a class of its own: it sits at exactly the depth of
    // 제N장 in every regulation, and giving it a separate class would let the
    // learner order it by first appearance — which, since 부칙 always comes
    // LAST, would bury the supplementary provisions under the final clause.
    id: "CLAUSE_JANG",
    glyph: "제N장",
    disposition: "ALWAYS",
    re: /^(?:제\s*(\d+)\s*장|부\s*칙)(?![가-힣])/,
    ordinal: (m) => (m[1] ? Number(m[1]) : null),
    ref: (m) => (m[1] ? `제${m[1]}장` : "부칙"),
  },
  {
    id: "CLAUSE_JEOL",
    glyph: "제N절",
    disposition: "ALWAYS",
    re: /^제\s*(\d+)\s*절(?![가-힣])/,
    ordinal: (m) => Number(m[1]),
    ref: (m) => `제${m[1]}절`,
  },
  {
    // The inline one. "제1조(목적) 이 규정은 …" is a heading AND its own first
    // paragraph of body text, so this class carries a splitter (see splitHead).
    id: "CLAUSE_JO",
    glyph: "제N조",
    disposition: "ALWAYS",
    inline: true,
    re: /^제\s*(\d+)\s*조(?:\s*의\s*(\d+))?/,
    ordinal: (m) => Number(m[1]),
    ref: (m) => `제${m[1]}조${m[2] ? `의${m[2]}` : ""}`,
  },
  {
    // (?!\d) is what keeps "1.1" out of NUM1 — without it NUM1 swallows the
    // first component and NUM2 never matches anything.
    id: "NUM1",
    glyph: "1.",
    disposition: "HEADINGY",
    re: /^(\d{1,2})\.(?!\d)(?=\s|$)/,
    ordinal: (m) => Number(m[1]),
  },
  {
    id: "NUM2",
    glyph: "1.1",
    disposition: "HEADINGY",
    re: /^(\d{1,2})\.(\d{1,2})\.?(?=\s|$)/,
    ordinal: (m) => Number(m[2]),
  },
  { id: "BOX", glyph: "□", disposition: "HEADINGY", re: /^([□■◇◆▣▢])(?=\s|\S)/ },
  {
    id: "HANGUL",
    glyph: "가.",
    disposition: "HEADINGY",
    re: /^([가나다라마바사아자차카타파하])\.(?=\s|$)/,
    ordinal: (m) => HANGUL_ORDER.indexOf(m[1]) + 1,
  },
  {
    id: "PAREN_NUM",
    glyph: "(1)",
    disposition: "HEADINGY",
    re: /^\(\s*(\d{1,2})\s*\)/,
    ordinal: (m) => Number(m[1]),
  },
  { id: "CIRCLE", glyph: "○", disposition: "CONDITIONAL", re: /^([○●◦ㅇ〇])(?=\s|\S)/ },
  {
    id: "CIRCLED",
    glyph: "①",
    disposition: "CONDITIONAL",
    re: /^([①-⑳])/,
    ordinal: (m) => m[1].codePointAt(0) - 0x245f,
  },
  // STAR before DASH: a hard constraint, enforced again in repairOrder().
  // Matching "**" here rather than excluding it is deliberate — it makes the
  // line a candidate so F5 can REJECT it and say so, instead of it vanishing
  // unexplained because no regex happened to match.
  { id: "STAR", glyph: "*", disposition: "CONDITIONAL", re: /^(\*{1,2})(?=\s)/ },
  { id: "DASH", glyph: "-", disposition: "CONDITIONAL", re: /^([-–—‧·•∙])(?=\s)/ },
  { id: "NOTE", glyph: "※", disposition: "NEVER", re: /^(※)/ },
  {
    id: "CAPTION",
    glyph: "<표 N>",
    disposition: "NEVER",
    re: /^[<〈[(]\s*(표|그림|도표|사진|별표|서식|붙임)\s*[\d-]/,
  },
];

const CATALOGUE_BY_ID = new Map(CATALOGUE.map((c) => [c.id, c]));
const CATALOGUE_ORDER = new Map(CATALOGUE.map((c, i) => [c.id, i]));

// Only these become nodes under the `clause` strategy. NOT the numbered ones:
// the whole reason clause outranks marker (see the ladder) is that a 학칙 had
// 155 date-shaped "1." lines, and letting NUM1 into a clause tree would bury
// every 제N조 under a date.
const CLAUSE_CLASSES = ["CLAUSE_JANG", "CLAUSE_JEOL", "CLAUSE_JO"];

// Hard constraints the learner may not violate, whatever the statistics say.
// [shallower, deeper].
const CONSTRAINTS = [
  ["CLAUSE_JANG", "CLAUSE_JEOL"],
  ["CLAUSE_JEOL", "CLAUSE_JO"],
  ["CLAUSE_JANG", "CLAUSE_JO"],
  ["NUM1", "NUM2"],
  ["STAR", "DASH"],
];

// ── the false-positive filters ─────────────────────────────────────────────
//
// Every one of these exists because a real document broke without it. They run
// BEFORE any statistics, which is load-bearing: 57 date lines left inside NUM1
// would drag its purity under HEADINGY_PURITY and cost a genuinely
// number-outlined document its top level.

const FILTER_META = [
  {
    id: "F1",
    name: "date-line",
    why:
      "부칙 sections number their amendment history: '2. 2015. 5. 1. 일부개정'. " +
      "One 학칙 held 155 of these; left in, they outnumber the real NUM1 headings " +
      "and sink the class. Structural classes are exempt — '제5조(시행일) … 2024. " +
      "3. 1.부터 시행한다.' is both a date line and a clause heading.",
  },
  {
    id: "F2",
    name: "table-of-contents",
    why:
      "'1. 사업 개요\\t 2' three paragraphs above '1. 사업 개요'. A detector keying " +
      "on the leading number gets exactly one of the twins right.",
  },
  {
    id: "F3",
    name: "cross-reference",
    why:
      "'제3조에 따른 부서에…' opens a paragraph with a clause token that refers to " +
      "a clause rather than declaring one. Mid-sentence references need no filter — " +
      "the ^ anchor already makes them unmatchable.",
  },
  {
    id: "F4",
    name: "table-caption",
    why:
      "'<표 1-1> 연도별 시장 규모' and '<그림 2>' are short, sit at the left margin " +
      "and look exactly like headings.",
  },
  {
    id: "F5",
    name: "footnote-marker",
    why:
      "'** 각주' and '* 자료: 통계청' are note apparatus. A single '*' is left to the " +
      "CONDITIONAL purity gate, because it is genuinely also used as an outline glyph.",
  },
  {
    id: "F6",
    name: "table-cell",
    why:
      "A table cell's text is short and frequently numeric ('1.', '2024'), so cells " +
      "hit the ^\\d rules constantly. Blocks are body-only by contract, so this should " +
      "always read 0 — it is a tripwire for a producer that ever starts flattening " +
      "cells into the stream.",
  },
  {
    id: "F7",
    name: "sentence-ending",
    why:
      "'- 시장 규모는 연 12% 성장하고 있다.' is a sentence wearing a bullet. Inline " +
      "clause headings are exempt because their body is split off first, leaving a " +
      "title that never ends this way.",
  },
  {
    id: "F8",
    name: "non-monotonic",
    why:
      "'1.' then '5.' then '2.' is not an outline; the 5. is a quantity, a year or a " +
      "page reference that wandered into the left margin.",
  },
  {
    id: "F9",
    name: "dense-enumeration",
    why:
      "A back-to-back run of numbered lines with no body between them is an " +
      "attachment list or a roster, not a level.",
  },
  {
    id: "F10",
    name: "overlong",
    why:
      "A heading has a length ceiling. Inline clause headings are exempt — their raw " +
      "paragraph is long by construction, so the ceiling is applied to the split title.",
  },
  { id: "F11", name: "blank", why: "A whitespace-only paragraph is spacing, not structure." },
];

const RE_DATE = /\d{1,4}\s*\.\s*\d{1,2}\s*\.\s*\d{1,2}\s*\.?/;
const RE_AMEND = /(제정|개정|시행|공포|신설|폐지|삭제)/;
const RE_TOC_TAIL = /(?:\t|\.{3,}|…+)\s*\d{1,4}\s*$/;
const RE_XREF_PARTICLE = /^제\s*\d+\s*조(?:\s*의\s*\d+)?\s*(?:에|에서|의|를|을|와|과|부터|까지|에도|이하)/;
const RE_CAPTION = /^[<〈[(]?\s*(표|그림|도표|사진|별표|서식)\s*[\d]/;
const RE_FOOTNOTE = /^(?:\*{2,}|\*\s*(?:자료|출처|주|註)\s*[::])/;
const RE_SENTENCE_END = /(?:다|음|함|임|됨)\s*[.。]?\s*$/;

// ── lazy props ─────────────────────────────────────────────────────────────

const DEFAULT_PROPS = Object.freeze({
  marginLeft: 0,
  indent: 0,
  alignment: "",
  styleName: "",
  styleId: -1,
  fontSize: 0,
  bold: false,
  headType: "None",
  paraLevel: 0,
  numberingId: 0,
});

// One props() call per block, ever, for the whole detection run. The block
// contract promises memoization on its side too, but this module does not rely
// on a promise it cannot check — and a probe counter that equals "distinct
// blocks touched" is what makes the cost assertion in the tests meaningful.
function makeProbe() {
  const cache = new Map();
  const probe = (block) => {
    if (cache.has(block)) return cache.get(block);
    let p;
    try {
      p = { ...DEFAULT_PROPS, ...(block.props ? block.props() : null) };
    } catch {
      p = { ...DEFAULT_PROPS };
    }
    cache.set(block, p);
    return p;
  };
  probe.count = () => cache.size;
  return probe;
}

// ── pass 1: candidates, from text alone ────────────────────────────────────

function matchClass(text) {
  for (const cls of CATALOGUE) {
    const m = cls.re.exec(text);
    if (m) return { cls, m };
  }
  return null;
}

// Where does the heading stop and the body start?
//
// Only the inline classes ever answer anything but 0. A 제N조 paragraph splits
// after its parenthetical caption: "제1조(목적) 이 규정은 …" → "제1조(목적)".
// With no parenthetical there is nothing to split on, so a short line is taken
// whole ("제5조 목적" is all title) and a long one keeps only its token.
const RE_JO_HEAD = /^(제\s*\d+\s*조(?:\s*의\s*\d+)?)(\s*\([^)\n]{0,60}\))?/;

function splitHead(cls, text) {
  if (!cls.inline) return 0;
  const m = RE_JO_HEAD.exec(text);
  if (!m) return 0;
  if (m[2]) return m[0].length;
  return text.length <= SHORT_LEN ? 0 : m[1].length;
}

const titleOf = (text, headEnd) => (headEnd > 0 ? text.slice(0, headEnd) : text).trim();

// A candidate is heading-SHAPED. Whether it is heading-shaped ENOUGH is the
// depth learner's problem; this pass only has text to work with, and spending
// an engine round-trip to find out that a paragraph starts with "이" would be
// the whole performance budget gone.
function scanCandidates(blocks, counts, rejected) {
  const bump = (id) => {
    counts[id] = (counts[id] ?? 0) + 1;
  };
  const reject = (block, cls, id, detail) => {
    bump(id);
    rejected.push({
      index: block.index,
      filter: id,
      class: cls ? cls.id : null,
      // Omitted rather than left undefined: the report is printed to stderr as
      // JSON, and JSON.stringify silently eats an undefined value, so a key
      // that is sometimes present and sometimes undefined makes the printed
      // report differ from the object a test compared.
      ...(detail ? { detail } : {}),
      text: String(block.text ?? "").slice(0, 60),
    });
    return null;
  };

  // Text census for F2's "this exact title turns up again later" rule. Pure
  // string work over the whole document — no props(), so it is free.
  const seenAt = new Map();
  blocks.forEach((b, i) => {
    const k = tocKey(String(b.text ?? ""));
    if (k && !seenAt.has(k)) seenAt.set(k, []);
    if (k) seenAt.get(k).push(i);
  });

  const raw = [];
  const kept = [];
  const tocLimit = Math.max(1, Math.ceil(blocks.length * TOC_ZONE));

  for (const block of blocks) {
    const text = String(block.text ?? "");

    // F11 — blank/whitespace-only.
    if (!text.trim()) {
      bump("F11");
      continue;
    }

    const hit = matchClass(text);
    if (!hit) continue; // ordinary body text: not a candidate, not a rejection
    const { cls, m } = hit;
    const headEnd = splitHead(cls, text);
    const title = titleOf(text, headEnd);
    const cand = { block, cls, m, headEnd, title, text };
    raw.push(cand);

    // F6 — a table cell can never be a candidate. Blocks are body-only by
    // contract, so this is a tripwire, not a workhorse.
    if (block.cell === true || block.inTable === true) {
      reject(block, cls, "F6");
      continue;
    }

    // F2 — table of contents. Two shapes: a tab or dot-leader followed by a
    // page number, and a leading-zone line whose title reappears later.
    if (RE_TOC_TAIL.test(text)) {
      reject(block, cls, "F2", "tab+page-number");
      continue;
    }
    const key = tocKey(text);
    const where = key ? seenAt.get(key) : null;
    if (where && block.index < tocLimit && where.some((i) => i > block.index)) {
      reject(block, cls, "F2", "repeated-later");
      continue;
    }

    // F1 — an amendment date wearing an item number. ALWAYS classes are exempt:
    // "제5조(시행일) 이 규정은 2024. 3. 1.부터 시행한다." is a date line by every
    // test this filter applies, and it is also unambiguously a clause heading.
    if (cls.disposition !== "ALWAYS" && RE_DATE.test(text) && RE_AMEND.test(text)) {
      reject(block, cls, "F1");
      continue;
    }

    // F4 — table/figure caption.
    if (RE_CAPTION.test(text)) {
      reject(block, cls, "F4");
      continue;
    }

    // F5 — footnote / source apparatus.
    if (RE_FOOTNOTE.test(text)) {
      reject(block, cls, "F5");
      continue;
    }

    // F3 — a line-initial clause token followed by a particle is a reference to
    // that clause, not a declaration of it.
    if (RE_XREF_PARTICLE.test(text)) {
      reject(block, cls, "F3");
      continue;
    }

    // F10 — length ceiling, measured on the TITLE so inline clauses are exempt
    // without needing a special case.
    if (title.length > MAX_HEADING_LEN) {
      reject(block, cls, "F10");
      continue;
    }

    // F7 — sentence endings. Also measured on the title, same reason.
    if (RE_SENTENCE_END.test(title)) {
      reject(block, cls, "F7");
      continue;
    }

    kept.push(cand);
  }

  const survivors = sequenceFilters(kept, counts, rejected);
  return { raw, survivors };
}

// The TOC key: the line with its trailing page number and its leader stripped,
// so "1. 사업 개요\t 2" and "1. 사업 개요" collapse to the same string.
function tocKey(text) {
  const t = text.replace(RE_TOC_TAIL, "").trim();
  return t.length ? t : null;
}

// F8 and F9 need a class's lines in document order, so they run after the
// per-line pass rather than inside it.
function sequenceFilters(cands, counts, rejected) {
  const bump = (id) => {
    counts[id] = (counts[id] ?? 0) + 1;
  };
  const drop = new Set();
  const note = (c, id, detail) => {
    bump(id);
    drop.add(c);
    rejected.push({
      index: c.block.index,
      filter: id,
      class: c.cls.id,
      ...(detail ? { detail } : {}),
      text: c.text.slice(0, 60),
    });
  };

  const byClass = new Map();
  for (const c of cands) {
    if (!byClass.has(c.cls.id)) byClass.set(c.cls.id, []);
    byClass.get(c.cls.id).push(c);
  }

  for (const [id, list] of byClass) {
    const cls = CATALOGUE_BY_ID.get(id);
    if (!cls.ordinal) continue; // F8/F9 are about NUMBERED classes only
    if (cls.disposition === "ALWAYS") continue; // 제N조 numbering is its own law

    // F8 — non-monotonic numbering. A restart to 1 is a new section, and a gap
    // of one is a deleted item; anything else is a number that is not an index.
    let prev = null;
    for (const c of list) {
      const n = cls.ordinal(c.m);
      if (n == null) continue;
      const ok = prev === null || n === 1 || (n > prev && n - prev <= 2);
      if (!ok) {
        note(c, "F8", `${prev} → ${n}`);
        continue;
      }
      prev = n;
    }

    // F9 — dense enumeration: DENSE_RUN_MIN or more of the same class on
    // CONSECUTIVE blocks, i.e. with no body text at all between them.
    let run = [];
    const flush = () => {
      if (run.length >= DENSE_RUN_MIN) for (const c of run) note(c, "F9", `run of ${run.length}`);
      run = [];
    };
    for (const c of list) {
      if (drop.has(c)) {
        flush();
        continue;
      }
      if (run.length && c.block.index !== run[run.length - 1].block.index + 1) flush();
      run.push(c);
    }
    flush();
  }

  return cands.filter((c) => !drop.has(c));
}

// ── pass 2: the depth learner ──────────────────────────────────────────────

function modeOf(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = 0;
  let bestN = -1;
  // Sorted so a tie resolves to the SMALLEST value, deterministically. A tie
  // here means the class has no consistent indent, and the shallower reading is
  // the safer one — it makes the class a sibling rather than inventing a child.
  for (const v of [...counts.keys()].sort((a, b) => a - b)) {
    if (counts.get(v) > bestN) {
      bestN = counts.get(v);
      best = v;
    }
  }
  return best;
}

// Class statistics, computed on SURVIVORS only. `raw` is carried alongside so
// the report can say "we saw 14 ※ lines" even though none of them survived.
function classStats(raw, survivors, probe) {
  const stats = new Map();
  const ensure = (cls) => {
    if (!stats.has(cls.id)) {
      stats.set(cls.id, {
        class: cls.id,
        glyph: cls.glyph,
        disposition: cls.disposition,
        raw: 0,
        surviving: 0,
        short: 0,
        purity: 0,
        modalIndent: 0,
        firstIndex: Number.MAX_SAFE_INTEGER,
        indents: [],
      });
    }
    return stats.get(cls.id);
  };

  for (const c of raw) ensure(c.cls).raw += 1;

  for (const c of survivors) {
    const st = ensure(c.cls);
    st.surviving += 1;
    // Shortness is measured on the TITLE. That IS the inline bypass: a 제N조
    // paragraph is never short, but "제1조(목적)" always is.
    if (c.title.length <= SHORT_LEN) st.short += 1;
    st.firstIndex = Math.min(st.firstIndex, c.block.index);
    // The only place props() is spent on the marker path, and only for blocks
    // that already look like headings.
    st.indents.push(probe(c.block).marginLeft ?? 0);
  }

  for (const st of stats.values()) {
    st.purity = st.surviving ? st.short / st.surviving : 0;
    st.modalIndent = modeOf(st.indents);
    delete st.indents;
    if (st.firstIndex === Number.MAX_SAFE_INTEGER) st.firstIndex = -1;
  }
  return stats;
}

function adoptable(st) {
  if (st.disposition === "NEVER") return { ok: false, why: "never an outline marker" };
  if (st.surviving === 0) return { ok: false, why: "every line was filtered out" };
  if (st.disposition === "ALWAYS") return { ok: true, why: "structural class" };
  if (st.surviving < MIN_CLASS_SUPPORT) {
    return { ok: false, why: `only ${st.surviving} line (needs ${MIN_CLASS_SUPPORT})` };
  }
  const bar = st.disposition === "CONDITIONAL" ? CONDITIONAL_PURITY : HEADINGY_PURITY;
  if (st.purity < bar) return { ok: false, why: `purity ${st.purity.toFixed(2)} < ${bar}` };
  return { ok: true, why: `purity ${st.purity.toFixed(2)} ≥ ${bar}` };
}

// How often class B directly follows class A among the surviving candidates.
function transitions(survivors) {
  const t = new Map();
  for (let i = 1; i < survivors.length; i++) {
    const a = survivors[i - 1].cls.id;
    const b = survivors[i].cls.id;
    if (a === b) continue;
    const k = `${a}\x00${b}`;
    t.set(k, (t.get(k) ?? 0) + 1);
  }
  return (a, b) => t.get(`${a}\x00${b}`) ?? 0;
}

// Order the adopted classes shallow → deep.
//
// Indent leads, because a document that indents its levels has told you the
// answer. Transition asymmetry is next but it is WEAK and frequently
// degenerate: a real outline is a cyclic walk (□ ○ ○ □ ○ 1. □ …), so the
// per-pair counts routinely form a 3-cycle with no consistent winner. It breaks
// the ties it can and leaves the rest to first appearance, which handles the
// common un-indented case correctly (□ appears before its first ○), and finally
// to catalogue order, which is what makes two runs agree.
function orderClasses(ids, stats, tr) {
  const wins = new Map(ids.map((id) => [id, 0]));
  for (const a of ids) {
    for (const b of ids) {
      if (a === b) continue;
      if (tr(a, b) > tr(b, a)) wins.set(a, wins.get(a) + 1);
    }
  }
  return [...ids].sort((a, b) => {
    const sa = stats.get(a);
    const sb = stats.get(b);
    return (
      sa.modalIndent - sb.modalIndent ||
      wins.get(b) - wins.get(a) ||
      sa.firstIndex - sb.firstIndex ||
      CATALOGUE_ORDER.get(a) - CATALOGUE_ORDER.get(b)
    );
  });
}

// Enforce the hard constraints (장 < 절 < 조, NUM1 < NUM2, * < -) by stable
// topological sort: the heuristic order is the priority, the constraints are
// the law. A constraint edge only ever moves a class earlier, never invents one.
function repairOrder(order) {
  const present = new Set(order);
  const priority = new Map(order.map((id, i) => [id, i]));
  const deps = new Map(order.map((id) => [id, new Set()]));
  for (const [before, after] of CONSTRAINTS) {
    if (present.has(before) && present.has(after)) deps.get(after).add(before);
  }
  const out = [];
  const done = new Set();
  while (out.length < order.length) {
    const ready = order.filter((id) => !done.has(id) && [...deps.get(id)].every((d) => done.has(d)));
    // A cycle is impossible with the constraints above, but if one is ever
    // added the fallback keeps the function total rather than looping forever.
    const next = (ready.length ? ready : order.filter((id) => !done.has(id))).sort(
      (a, b) => priority.get(a) - priority.get(b),
    )[0];
    out.push(next);
    done.add(next);
  }
  return out;
}

// ── nodes and tree ─────────────────────────────────────────────────────────

function makeNode(cand, level) {
  return {
    id: "",
    ref: cand.cls.ref ? cand.cls.ref(cand.m) : null,
    title: cand.title,
    level,
    blockIndex: cand.block.index,
    headEnd: cand.headEnd,
    children: [],
    markerClass: cand.cls.id,
  };
}

// Build the tree from LEVELS, then paint the ordinal path on. Never the other
// way round: a document that numbers two consecutive sections "1." would, under
// id-first construction, collapse them into one.
function buildTree(nodes) {
  const roots = [];
  const stack = [];
  for (const n of nodes) {
    while (stack.length && stack[stack.length - 1].level >= n.level) stack.pop();
    if (stack.length) stack[stack.length - 1].children.push(n);
    else roots.push(n);
    stack.push(n);
  }
  assignIds(roots, "");
  return roots;
}

function assignIds(list, prefix) {
  list.forEach((n, i) => {
    n.id = prefix ? `${prefix}.${i + 1}` : String(i + 1);
    assignIds(n.children, n.id);
  });
}

// A ref is a handle a human can retype ("제12조", "붙임2"). A duplicate handle
// is worse than none — it silently sends the caller to the wrong place — so
// collisions are cleared rather than disambiguated.
function uniquifyRefs(nodes) {
  const counts = new Map();
  for (const n of nodes) if (n.ref) counts.set(n.ref, (counts.get(n.ref) ?? 0) + 1);
  for (const n of nodes) if (n.ref && counts.get(n.ref) > 1) n.ref = null;
}

function finish(nodes) {
  uniquifyRefs(nodes);
  const tree = buildTree(nodes);
  return { nodes, tree };
}

// ── strategies ─────────────────────────────────────────────────────────────

function markerStrategy(survivors, stats, cfg, report) {
  const levels = new Map();
  const dropped = [];

  if (cfg.markerLevel) {
    // An explicit map is the caller telling us the answer. Only the named
    // markers are adopted — a partial map means "these levels, exactly".
    // Keys are matched EXACTLY against a class id or its glyph; a prefix match
    // would quietly bind "**" to the "*" class.
    for (const [key, lvl] of Object.entries(cfg.markerLevel)) {
      const cls = CATALOGUE_BY_ID.get(key) ?? CATALOGUE.find((c) => c.glyph === key);
      if (!cls) continue;
      if (lvl > cfg.maxLevel) {
        dropped.push({ class: cls.id, wouldBeLevel: lvl });
        continue;
      }
      levels.set(cls.id, lvl);
    }
    report.notes.push("levels supplied by opts.markerLevel; the depth learner did not run");
  } else {
    const adopted = [];
    for (const st of stats.values()) {
      const verdict = adoptable(st);
      st.adopted = verdict.ok;
      st.verdict = verdict.why;
      if (verdict.ok) adopted.push(st.class);
    }
    const order = repairOrder(orderClasses(adopted, stats, transitions(survivors)));
    order.forEach((id, i) => {
      const lvl = i + 1;
      // DROPPED, NEVER CLAMPED. Clamping a level-5 class to 4 makes it a
      // SIBLING of its own parent, which inverts the structure and puts the
      // parent's remaining children under the wrong node. Dropping it merely
      // leaves those lines as body text under the parent they belonged to —
      // less information, but never wrong information.
      if (lvl > cfg.maxLevel) {
        dropped.push({ class: id, wouldBeLevel: lvl });
        const st = stats.get(id);
        if (st) {
          st.adopted = false;
          st.verdict = `dropped: level ${lvl} exceeds maxLevel ${cfg.maxLevel}`;
        }
        return;
      }
      levels.set(id, lvl);
    });
  }

  report.dropped = dropped;
  report.levels = Object.fromEntries([...levels.entries()].sort((a, b) => a[1] - b[1]));

  const nodes = survivors
    .filter((c) => levels.has(c.cls.id))
    .map((c) => makeNode(c, levels.get(c.cls.id)));
  return { levels, nodes };
}

function clauseStrategy(survivors, cfg, report) {
  const present = CLAUSE_CLASSES.filter((id) => survivors.some((c) => c.cls.id === id));
  // Compact: with no 절 in the document, 조 is level 2 rather than a level-3
  // node with no level-2 parent — which would build a tree with a hole in it.
  const levels = new Map(present.map((id, i) => [id, i + 1]));
  const dropped = [];
  for (const [id, lvl] of [...levels]) {
    if (lvl > cfg.maxLevel) {
      dropped.push({ class: id, wouldBeLevel: lvl });
      levels.delete(id);
    }
  }
  report.dropped = dropped;
  report.levels = Object.fromEntries([...levels.entries()].sort((a, b) => a[1] - b[1]));
  const ignored = survivors.filter((c) => !levels.has(c.cls.id)).length;
  if (ignored) {
    report.notes.push(
      `clause: ${ignored} non-clause candidate(s) left as body — numbered lines are ` +
        "deliberately excluded from a clause tree",
    );
  }
  return survivors
    .filter((c) => levels.has(c.cls.id))
    .map((c) => makeNode(c, levels.get(c.cls.id)));
}

// A body-less document still deserves an index. This does NOT invent a heading
// tree — it emits one flat node per table, which is a usable answer where [] is
// not.
function tableStrategy(blocks, cfg, report) {
  const nodes = [];
  let ordinal = 0;
  for (const b of blocks) {
    const indices = Array.isArray(b.tableIndices) && b.tableIndices.length
      ? b.tableIndices
      : b.hasTable
        ? [0]
        : [];
    for (const ci of indices) {
      const title = cfg.tableTitles?.[ordinal];
      nodes.push({
        id: "",
        ref: `T${ordinal}`,
        title: title && String(title).trim() ? String(title).trim() : `표 ${ordinal + 1}`,
        level: 1,
        blockIndex: b.index,
        headEnd: 0,
        children: [],
        markerClass: "TABLE",
        controlIndex: ci,
      });
      ordinal += 1;
    }
  }
  report.levels = { TABLE: 1 };
  return nodes;
}

// ── the style rank, and the honest limit on it ────────────────────────────
//
// THE DESIGN CANNOT BE HAD FOR FREE. "≥2 heading styles ACTUALLY USED" is a
// statement about every paragraph in the document, and styleName only arrives
// through props(). There is no text-only proxy: a style-outlined document's
// headings look, in text, exactly like body paragraphs.
//
// So the rank is BUDGETED instead of skipped. It probes short non-empty blocks
// (a heading is short) in document order, up to STYLE_PROBE_BUDGET, reusing
// anything the candidate pass already paid for. Under the budget the answer is
// exact; over it, the rank reports `truncated` and is rejected with that reason
// stated rather than pretending to a negative it did not establish. A caller
// willing to pay for certainty raises opts.styleBudget (Infinity = full scan).

const RE_HEADING_STYLE = /(개\s*요\s*\d|제\s*목|title|heading|outline)/i;
const RE_BODY_STYLE = /^(바탕글|본문|표\s*내용|각주|미주|머리말|꼬리말|쪽번호|Normal|Default|Body)/i;

function styleCensus(blocks, probe, cfg) {
  const used = new Map();
  let probed = 0;
  let truncated = false;
  for (const b of blocks) {
    const text = String(b.text ?? "");
    if (!text.trim() || text.trim().length > SHORT_LEN) continue;
    if (probed >= cfg.styleBudget) {
      truncated = true;
      break;
    }
    probed += 1;
    const name = String(probe(b).styleName ?? "").trim();
    if (!name) continue;
    if (!used.has(name)) used.set(name, []);
    used.get(name).push(b);
  }
  return { used, probed, truncated };
}

function styleStrategy(blocks, probe, cfg, report) {
  const { used, probed, truncated } = styleCensus(blocks, probe, cfg);
  const qualifying = [...used.entries()]
    .filter(([name, bs]) => RE_HEADING_STYLE.test(name) && !RE_BODY_STYLE.test(name) && bs.length >= 2)
    .sort((a, b) => a[1][0].index - b[1][0].index);

  const covered = qualifying.reduce((n, [, bs]) => n + bs.length, 0);
  const share = blocks.length ? covered / blocks.length : 0;

  const info = {
    probed,
    truncated,
    distinctStyles: qualifying.map(([n, bs]) => ({ style: n, blocks: bs.length })),
    share: Number(share.toFixed(3)),
  };

  let why = null;
  if (qualifying.length < 2) {
    why = truncated
      ? `only ${qualifying.length} used heading style(s) in the first ${probed} short ` +
        "paragraphs, and the probe budget ran out — inconclusive, not negative"
      : `${qualifying.length} heading style(s) actually used on ≥2 paragraphs (needs 2)`;
  } else if (share > STYLE_MAX_SHARE) {
    why =
      `heading styles cover ${(share * 100).toFixed(0)}% of blocks ` +
      `(> ${STYLE_MAX_SHARE * 100}%) — that is a body style`;
  }
  if (why) return { ok: false, why, info, nodes: [] };

  // 개요 N carries its own level. Anything else is ranked by first appearance.
  const levels = new Map();
  const dropped = [];
  let rank = 0;
  for (const [name] of qualifying) {
    const m = /개\s*요\s*(\d)/.exec(name);
    const lvl = m ? Number(m[1]) : ++rank;
    if (lvl > cfg.maxLevel) {
      dropped.push({ class: `STYLE:${name}`, wouldBeLevel: lvl });
      continue;
    }
    levels.set(name, lvl);
  }
  report.dropped = dropped;
  report.levels = Object.fromEntries([...levels.entries()].sort((a, b) => a[1] - b[1]));

  const nodes = [];
  for (const [name, bs] of qualifying) {
    if (!levels.has(name)) continue;
    for (const b of bs) {
      nodes.push({
        id: "",
        ref: null,
        title: String(b.text ?? "").trim(),
        level: levels.get(name),
        blockIndex: b.index,
        headEnd: 0,
        children: [],
        markerClass: `STYLE:${name}`,
      });
    }
  }
  nodes.sort((a, b) => a.blockIndex - b.blockIndex);
  return { ok: true, why: `${qualifying.length} heading styles in use`, info, nodes };
}

// ── the user-supplied regex ────────────────────────────────────────────────
//
// Authoritative: no false-positive filters run. A caller who hands us a pattern
// has looked at the document, and second-guessing them would make the escape
// hatch useless exactly when it is needed. `auto` never reaches here — an
// unguessable pattern cannot be guessed.
function regexStrategy(blocks, cfg, report) {
  if (!cfg.headingRegex) throw new Error('detect: "regex" requires opts.headingRegex');
  // No /g/: a global regex carries lastIndex between calls and would break the
  // one-heading-per-block invariant on the second paragraph it saw.
  const re = new RegExp(cfg.headingRegex, "u");
  const nodes = [];
  for (const b of blocks) {
    const text = String(b.text ?? "");
    if (!text.trim()) continue;
    const m = re.exec(text);
    if (!m) continue;
    const g = m.groups ?? {};
    let level = 1;
    if (g.level != null) {
      const n = Number(g.level);
      level = Number.isFinite(n) && n >= 1 ? Math.trunc(n) : String(g.level).split(".").length;
    }
    if (level > cfg.maxLevel) {
      report.dropped.push({ class: "REGEX", wouldBeLevel: level });
      continue;
    }
    const headEnd = g.title != null ? text.indexOf(g.title) + g.title.length : 0;
    nodes.push({
      id: "",
      ref: g.ref != null ? String(g.ref) : null,
      title: g.title != null ? String(g.title).trim() : text.trim(),
      level,
      blockIndex: b.index,
      headEnd: g.title != null ? headEnd : 0,
      children: [],
      markerClass: "REGEX",
    });
  }
  report.levels = { REGEX: 1 };
  return nodes;
}

// ── confidence ─────────────────────────────────────────────────────────────

// Low confidence must be readable off the object without re-deriving anything,
// so the reasons ride along with the label.
function gradeConfidence(strategy, nodes, report) {
  const reasons = [];
  let confidence;
  switch (strategy) {
    case "regex":
      confidence = "high";
      break;
    case "style":
      confidence = report.style?.truncated ? "medium" : "high";
      if (report.style?.truncated) reasons.push("style probe hit its budget");
      break;
    case "clause":
      confidence = nodes.length >= 3 ? "high" : "medium";
      if (nodes.length < 3) reasons.push(`only ${nodes.length} clause node(s)`);
      break;
    case "marker": {
      const classes = Object.keys(report.levels).length;
      if (classes >= 2 && nodes.length >= 5) confidence = "medium";
      else {
        confidence = "low";
        reasons.push(`learned ${classes} level(s) from ${nodes.length} node(s)`);
      }
      break;
    }
    case "table":
      confidence = "low";
      reasons.push("no body outline; the index is the document's tables");
      break;
    default:
      confidence = "low";
      reasons.push("no heading structure found");
  }
  if (report.dropped.length) {
    reasons.push(`${report.dropped.length} class(es) dropped for exceeding maxLevel`);
  }
  return { confidence, reasons };
}

// ── entry point ────────────────────────────────────────────────────────────

const STRATEGIES = ["regex", "style", "clause", "marker", "table", "none"];
// "auto" is a detect MODE, not a strategy: it is never the answer, only the
// instruction to walk the ladder. Keeping the two lists apart is what stops
// `strategy: "auto"` ever reaching a caller.
const DETECT_MODES = ["auto", ...STRATEGIES];

export function detectHeadings(blocks, opts = {}) {
  const cfg = {
    detect: "auto",
    headingRegex: null,
    markerLevel: null,
    maxLevel: DEFAULT_MAX_LEVEL,
    tableTitles: null,
    styleBudget: STYLE_PROBE_BUDGET,
    ...opts,
  };
  if (!DETECT_MODES.includes(cfg.detect)) {
    throw new Error(`unknown detect: ${cfg.detect} (expected ${DETECT_MODES.join("|")})`);
  }
  if (!Number.isInteger(cfg.maxLevel) || cfg.maxLevel < 1) {
    throw new Error(`maxLevel must be a positive integer (got ${cfg.maxLevel})`);
  }

  const src = (Array.isArray(blocks) ? blocks : []).map((b, i) => ({
    ...b,
    index: Number.isInteger(b?.index) ? b.index : i,
  }));
  const probe = makeProbe();
  const counts = {};
  const rejected = [];

  const report = {
    strategy: "none",
    confidence: "low",
    lowConfidenceReasons: [],
    blockCount: src.length,
    nonEmptyCount: src.filter((b) => String(b.text ?? "").trim()).length,
    tableCount: src.reduce(
      (n, b) => n + (Array.isArray(b.tableIndices) ? b.tableIndices.length : b.hasTable ? 1 : 0),
      0,
    ),
    candidateCount: 0,
    propsProbed: 0,
    ladder: [],
    filters: [],
    rejected,
    classes: [],
    levels: {},
    dropped: [],
    notes: [],
  };

  const done = (strategy, nodes) => {
    report.strategy = strategy;
    const { nodes: flat, tree } = finish(nodes);
    const grade = gradeConfidence(strategy, flat, report);
    report.confidence = grade.confidence;
    report.lowConfidenceReasons = grade.reasons;
    report.filters = FILTER_META.map((f) => ({ ...f, rejected: counts[f.id] ?? 0 }));
    report.propsProbed = probe.count();
    return { strategy, nodes: flat, tree, detection: report };
  };

  if (cfg.detect === "regex") {
    report.ladder.push({ rank: 0, strategy: "regex", chosen: true, why: "forced by opts.detect" });
    return done("regex", regexStrategy(src, cfg, report));
  }

  // Pass 1 — text only. No props() has been spent at this point.
  const { raw, survivors } = scanCandidates(src, counts, rejected);
  report.candidateCount = survivors.length;

  // Pass 2 — props(), on candidates only.
  const stats = classStats(raw, survivors, probe);

  const forced = cfg.detect === "auto" ? null : cfg.detect;
  const note = (rank, strategy, chosen, why) => {
    report.ladder.push({ rank, strategy, chosen, why });
  };

  // ── rank 1: style ────────────────────────────────────────────────────────
  let style = null;
  if (!forced || forced === "style") {
    style = styleStrategy(src, probe, cfg, report);
    report.style = style.info;
    if (forced === "style") {
      note(0, "style", true, `forced by opts.detect (${style.why})`);
      report.classes = statsOut(stats);
      return done("style", style.nodes);
    }
    note(1, "style", style.ok, style.why);
    if (style.ok) {
      report.classes = statsOut(stats);
      return done("style", style.nodes);
    }
  }

  // ── rank 2: clause ───────────────────────────────────────────────────────
  const clauseHits = survivors.filter((c) => c.cls.id === "CLAUSE_JO").length;
  if (forced === "clause") {
    note(0, "clause", true, `forced by opts.detect (${clauseHits} 제N조)`);
    const nodes = clauseStrategy(survivors, cfg, report);
    report.classes = statsOut(stats);
    return done("clause", nodes);
  }
  if (!forced) {
    // Clause outranks marker on purpose. In a 학칙 with 155 date-shaped "1."
    // lines, a marker strategy that won here would hang every 제N조 off a date.
    const ok = clauseHits >= 3;
    note(2, "clause", ok, ok ? `${clauseHits} line-initial 제N조` : `${clauseHits} 제N조 (needs 3)`);
    if (ok) {
      const nodes = clauseStrategy(survivors, cfg, report);
      report.classes = statsOut(stats);
      return done("clause", nodes);
    }
  }

  // ── rank 3: marker ───────────────────────────────────────────────────────
  if (!forced || forced === "marker") {
    const { levels, nodes } = markerStrategy(survivors, stats, cfg, report);
    report.classes = statsOut(stats);
    if (forced === "marker") {
      note(0, "marker", true, `forced by opts.detect (${levels.size} class(es))`);
      return done("marker", nodes);
    }
    const ok = levels.size >= 1;
    note(3, "marker", ok, ok ? `adopted ${levels.size} class(es)` : "no class met its purity bar");
    if (ok) return done("marker", nodes);
  } else {
    report.classes = statsOut(stats);
  }

  // ── rank 4: table ────────────────────────────────────────────────────────
  const bodyless = survivors.length === 0 || report.nonEmptyCount <= 3;
  if (forced === "table") {
    note(0, "table", true, "forced by opts.detect");
    return done("table", tableStrategy(src, cfg, report));
  }
  if (!forced) {
    const ok = bodyless && report.tableCount >= 1;
    note(
      4,
      "table",
      ok,
      ok
        ? `${report.tableCount} table(s) and ${report.nonEmptyCount} non-empty body block(s)`
        : `${report.tableCount} table(s), ${survivors.length} candidate(s), ` +
          `${report.nonEmptyCount} non-empty block(s)`,
    );
    if (ok) return done("table", tableStrategy(src, cfg, report));
  }

  // ── rank 5: none ─────────────────────────────────────────────────────────
  note(forced ? 0 : 5, "none", true, forced ? "forced by opts.detect" : "no strategy triggered");
  return done("none", []);
}

// Class histogram for the report: sorted by catalogue order so two runs of the
// same document produce byte-identical output.
function statsOut(stats) {
  return [...stats.values()]
    .map((s) => ({
      class: s.class,
      glyph: s.glyph,
      disposition: s.disposition,
      raw: s.raw,
      surviving: s.surviving,
      short: s.short,
      purity: Number(s.purity.toFixed(3)),
      modalIndent: s.modalIndent,
      firstIndex: s.firstIndex,
      adopted: s.adopted ?? false,
      verdict: s.verdict ?? adoptable(s).why,
    }))
    .sort((a, b) => CATALOGUE_ORDER.get(a.class) - CATALOGUE_ORDER.get(b.class));
}

// Exported for tests and for a caller that wants to explain itself. Not part of
// the node contract.
export const _internals = {
  CATALOGUE,
  CONSTRAINTS,
  FILTER_META,
  HEADINGY_PURITY,
  CONDITIONAL_PURITY,
  SHORT_LEN,
  MAX_HEADING_LEN,
  DENSE_RUN_MIN,
  MIN_CLASS_SUPPORT,
  matchClass,
  splitHead,
  repairOrder,
};
