// lib/objects — the placement ladder, and the laziness that makes it usable.
//
// Two things are under test and they fail in different ways.
//
// THE LADDER is a judgement about reading position. It fails by being plausible
// and wrong: placing a watermark in the middle of a sentence, or trusting the
// anchor paragraph of an object pinned to the paper corner. So the ladder is
// tested PURELY — `classifyPlacement` takes four properties and no document —
// with the exact combinations the 40-document survey found in the wild, plus
// the ones that only show up as bugs.
//
// THE COST is a property of the code, not of the machine. The first layout call
// paginates the whole document (~26 ms on the 6-page fixture-table.hwp, against
// ~0.5 ms for the paragraph walk), and it is paid whether or not the document
// has anything that needs it. A regression here is silent — everything still
// returns the right answer, 50× slower — so it is pinned with a call counter
// rather than a stopwatch: a document with no rank-4/5 object must make ZERO
// layout calls. `test/spec/inline.test.mjs` guards the block walk's budget the
// same way, for the same reason.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { loadDocument, loadDocumentFromBytes } from "../../src/lib/_bootstrap.mjs";
import { eachParagraph } from "../../src/lib/doc_walk.mjs";
import {
  PLACEMENTS,
  RESOLVERS,
  classifyPlacement,
  collectObjects,
} from "../../src/lib/objects.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const sample = (name) => join(ROOT, "samples", name);

// ── the layout-call counter ────────────────────────────────────────────────

// Every accessor that can force pagination. `getPageOfPosition` is NOT in here:
// measured at ~0.4 ms on a cold document, it answers from the paragraph index
// without laying anything out, which is exactly why the module uses it to find
// an object's page before deciding whether to pay for the page itself.
const LAYOUT_METHODS = new Set([
  "getPageControlLayout",
  "getPageTextLayout",
  "getPageOverlayImages",
  "getPageLayerTree",
  "getPageLayerTreeWithProfile",
  "getPageRenderTree",
  "getPageInfo",
  "getPageFootnoteInfo",
]);

// Wrap a document so every call through it is recorded by name. collectObjects
// installs its own counting proxy on whatever it is handed, so this one sits
// outside it and sees exactly the same calls.
function watch(doc) {
  const calls = [];
  const proxy = new Proxy(doc, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      return (...args) => {
        calls.push(String(key));
        return value.apply(target, args);
      };
    },
  });
  return {
    doc: proxy,
    calls,
    layoutCalls: () => calls.filter((c) => LAYOUT_METHODS.has(c)),
    count: (name) => calls.filter((c) => c === name).length,
  };
}

function paragraphCount(doc) {
  let n = 0;
  for (const _ of eachParagraph(doc)) n++;
  return n;
}

// Build a variant of samples/fixture-image.hwp entirely in memory: apply
// picture properties, export, reload. The reload is not ceremony — CLAUDE.md
// rule 1 exists because the engine accepts an edit in memory and drops it on
// save, so a fixture built without the round trip could be testing properties
// the document does not actually have. Every builder below asserts what came
// back before the test uses it.
async function imageFixtureWith(edits) {
  const doc = await loadDocument(sample("fixture-image.hwp"));
  for (const [s, p, c, props] of edits) {
    doc.setPictureProperties(s, p, c, JSON.stringify(props));
  }
  return loadDocumentFromBytes(doc.exportHwp());
}

const FLOATING = { treatAsChar: false, vertOffset: 0, horzOffset: 0 };

// ── the ladder, pure ───────────────────────────────────────────────────────

test("classifyPlacement rank 1: treatAsChar is inline, resolved by its own offset", () => {
  const r = classifyPlacement({
    treatAsChar: true,
    textWrap: "TopAndBottom",
    vertRelTo: "Para",
    horzRelTo: "Para",
  });
  assert.deepEqual(r, { placement: "inline", resolvedBy: "offset", rank: 1 });
});

test("classifyPlacement rank 1 wins over a stale wrap on an inline object", () => {
  // MEASURED on samples/fixture-image.hwp: the picture at (0,4) is
  // treatAsChar:true and still carries textWrap:"Square" from before it was
  // made inline. The engine does not clear it. Reading the wrap first would
  // place a picture that IS a character in the text as though text flowed
  // around it — and for an overlay wrap it would drop it from the body
  // entirely, which is data loss dressed as a rule.
  for (const wrap of ["Square", "BehindText", "InFrontOfText", "", "Through"]) {
    const r = classifyPlacement({ treatAsChar: true, textWrap: wrap, vertRelTo: "Paper" });
    assert.equal(r.rank, 1, `wrap ${wrap || "(empty)"} must not beat treatAsChar`);
    assert.equal(r.placement, "inline");
    assert.equal(r.resolvedBy, "offset");
  }
});

test("classifyPlacement rank 2: floating, paragraph-anchored, TopAndBottom is a block", () => {
  // The survey's dominant table shape: 399 of 424 tables wrap TopAndBottom, and
  // 262 + 162 of them are Para/Para or Para/Column.
  for (const horz of ["Para", "Column"]) {
    const r = classifyPlacement({
      ...FLOATING,
      textWrap: "TopAndBottom",
      vertRelTo: "Para",
      horzRelTo: horz,
    });
    assert.deepEqual(r, { placement: "block", resolvedBy: "anchor", rank: 2 }, `horzRelTo ${horz}`);
  }
});

test("classifyPlacement rank 3: floating, paragraph-anchored, Square is beside", () => {
  for (const horz of ["Para", "Column"]) {
    const r = classifyPlacement({
      ...FLOATING,
      textWrap: "Square",
      vertRelTo: "Para",
      horzRelTo: horz,
    });
    assert.deepEqual(r, { placement: "beside", resolvedBy: "anchor", rank: 3 }, `horzRelTo ${horz}`);
  }
});

test("classifyPlacement rank 3 also takes Tight and Through", () => {
  // image_props.mjs records that OUR save downgrades both to "Square". That is
  // a fact about writing, not about reading: a document Hancom itself wrote can
  // carry either, and both mean text flows around the object.
  for (const wrap of ["Tight", "Through"]) {
    const r = classifyPlacement({ ...FLOATING, textWrap: wrap, vertRelTo: "Para" });
    assert.deepEqual(r, { placement: "beside", resolvedBy: "anchor", rank: 3 }, wrap);
  }
});

test("classifyPlacement rank 4: paper-anchored needs geometry, and says so", () => {
  // The survey found 5 images at Paper/Paper and no tables at all.
  const block = classifyPlacement({
    ...FLOATING,
    textWrap: "TopAndBottom",
    vertRelTo: "Paper",
    horzRelTo: "Paper",
  });
  assert.deepEqual(block, { placement: "block", resolvedBy: "geometry", rank: 4 });

  const beside = classifyPlacement({
    ...FLOATING,
    textWrap: "Square",
    vertRelTo: "Paper",
    horzRelTo: "Paper",
  });
  assert.deepEqual(beside, { placement: "beside", resolvedBy: "geometry", rank: 4 });
});

test('classifyPlacement rank 4 covers "Page" as well as "Paper"', () => {
  // vertRelTo's enum is Paper/Page/Para. "Page" means the text area rather than
  // the sheet, but it is still a page coordinate: the anchor paragraph says
  // nothing about it either, so it must not fall through to rank 2.
  const r = classifyPlacement({ ...FLOATING, textWrap: "TopAndBottom", vertRelTo: "Page" });
  assert.equal(r.rank, 4);
  assert.equal(r.resolvedBy, "geometry");
});

test("classifyPlacement rank 5: overlays are never placed in the body", () => {
  // The rule the module exists for. A watermark has no reading position, and
  // both the placement AND the resolver have to say so — a caller that only
  // checks `resolvedBy` must not find a usable-looking "anchor" here.
  for (const wrap of ["BehindText", "InFrontOfText"]) {
    for (const vert of ["Paper", "Page", "Para"]) {
      const r = classifyPlacement({ ...FLOATING, textWrap: wrap, vertRelTo: vert });
      assert.deepEqual(r, { placement: "overlay", resolvedBy: "none", rank: 5 }, `${wrap}/${vert}`);
    }
  }
});

test("classifyPlacement rank 5 beats paragraph anchoring", () => {
  // A BehindText watermark whose control happens to live in paragraph 12 is
  // still a watermark. Rank 2 would have taken it if the wrap were ignored.
  const r = classifyPlacement({
    ...FLOATING,
    textWrap: "BehindText",
    vertRelTo: "Para",
    horzRelTo: "Column",
  });
  assert.equal(r.rank, 5);
  assert.equal(r.placement, "overlay");
});

test("classifyPlacement is total: every input lands on exactly one rank", () => {
  const wraps = ["TopAndBottom", "Square", "Tight", "Through", "BehindText", "InFrontOfText", "", "Nonsense"];
  const verts = ["Para", "Paper", "Page", "", "Nonsense"];
  const horzs = ["Para", "Column", "Paper", "Page", ""];
  for (const treatAsChar of [true, false, undefined, null]) {
    for (const textWrap of wraps) {
      for (const vertRelTo of verts) {
        for (const horzRelTo of horzs) {
          const r = classifyPlacement({ treatAsChar, textWrap, vertRelTo, horzRelTo });
          const label = `${treatAsChar}/${textWrap}/${vertRelTo}/${horzRelTo}`;
          assert.ok([1, 2, 3, 4, 5].includes(r.rank), `${label} → rank ${r.rank}`);
          // Against the module's own exported vocabulary, so a new placement
          // value cannot be introduced without this test being updated too.
          assert.ok(PLACEMENTS.includes(r.placement), `${label} → placement ${r.placement}`);
          assert.ok(RESOLVERS.includes(r.resolvedBy), `${label} → resolvedBy ${r.resolvedBy}`);
          // Only a real inline object may claim the exact answer.
          assert.equal(r.resolvedBy === "offset", r.rank === 1, label);
          assert.equal(r.placement === "overlay", r.rank === 5, label);
        }
      }
    }
  }
});

test("classifyPlacement does not treat a truthy-ish treatAsChar as inline", () => {
  // getPictureProperties returns a real boolean. A string "true" reaching here
  // means someone hand-built the object, and quietly accepting it would make an
  // inline placement out of a floating picture.
  for (const bad of ["true", 1, "1"]) {
    const r = classifyPlacement({ treatAsChar: bad, textWrap: "TopAndBottom", vertRelTo: "Para" });
    assert.notEqual(r.rank, 1, `treatAsChar ${JSON.stringify(bad)}`);
  }
});

// ── against real documents ─────────────────────────────────────────────────

test("fixture-image.hwp: three pictures, found with their kinds and captions", async () => {
  const doc = await loadDocument(sample("fixture-image.hwp"));
  const { objects } = await collectObjects(doc);

  assert.equal(objects.length, 3);
  assert.deepEqual(
    objects.map((o) => o.kind),
    ["image", "image", "image"],
  );
  // Document order, and `index` follows it.
  assert.deepEqual(
    objects.map((o) => [o.section, o.paragraph, o.controlIndex]),
    [
      [0, 2, 0],
      [0, 4, 0],
      [0, 6, 0],
    ],
  );
  assert.deepEqual(
    objects.map((o) => o.index),
    [0, 1, 2],
  );

  // The three pictures the fixture was built with: default/floating,
  // treatAsChar, captioned.
  const [dflt, inline, captioned] = objects;

  assert.equal(inline.treatAsChar, true);
  assert.equal(inline.placement, "inline");
  assert.equal(inline.resolvedBy, "offset");
  assert.equal(inline.anchorParagraph, 4);
  assert.equal(inline.anchorSide, "at");
  assert.equal(inline.charOffset, 0);
  assert.equal(inline.width, 9600);
  assert.equal(inline.height, 7200);

  // Both floating pictures in this fixture are pinned to the paper — the
  // default an insert leaves behind (image_props.mjs' opening complaint).
  for (const o of [dflt, captioned]) {
    assert.equal(o.treatAsChar, false);
    assert.equal(o.vertRelTo, "Paper");
    assert.equal(o.horzRelTo, "Paper");
    assert.equal(o.rank, 4);
  }

  assert.equal(captioned.hasCaption, true);
  assert.equal(captioned.caption, "그림 1. 분기별 매출 추이");
  assert.equal(dflt.hasCaption, false);
  assert.equal(dflt.caption, null);

  // The picture's own description property is kept, separately from the
  // generated summary — an empty alt text and an unknown object are different
  // facts and must not collapse into one field.
  assert.equal(dflt.altText, "기본 상태 그림");
  assert.equal(inline.altText, "글자처럼 취급 그림");
  assert.ok(dflt.description.includes("image"));
  assert.ok(dflt.description !== dflt.altText);
});

test("fixture-image.hwp: paper-anchored pictures are resolved from the page, not the anchor", async () => {
  const doc = await loadDocument(sample("fixture-image.hwp"));
  const { objects, stats } = await collectObjects(doc);
  const [dflt, , captioned] = objects;

  assert.equal(stats.geometryUsed, true);
  assert.equal(stats.pagesProbed, 1);

  for (const o of [dflt, captioned]) {
    assert.equal(o.resolvedBy, "geometry");
    assert.equal(o.page, 0);
    assert.ok(o.bbox && typeof o.bbox.y === "number", "a rank-4 object must carry a bbox");
    // MEASURED: both sit at the paper origin (vertOffset/horzOffset 0), above
    // every body run on the page — the first is at y 132.3. So the honest
    // reading position is "before the first paragraph on this page", and the
    // anchor is NOT the control's own paragraph (2 and 6).
    assert.equal(o.bbox.x, 0);
    assert.equal(o.bbox.y, 0);
    assert.equal(o.anchorSide, "before");
    assert.equal(o.anchorParagraph, 0);
    assert.notEqual(o.anchorParagraph, o.paragraph);
  }
});

test("fixture-table.hwp: twelve inline tables, with dimensions", async () => {
  const doc = await loadDocument(sample("fixture-table.hwp"));
  const { objects, overlays } = await collectObjects(doc);

  assert.equal(objects.length, 12);
  assert.equal(overlays.length, 0);
  assert.ok(objects.every((o) => o.kind === "table"));
  // MEASURED: every table in this fixture is treatAsChar, so every one is
  // rank 1. That is what makes it the laziness fixture below.
  assert.ok(objects.every((o) => o.placement === "inline" && o.resolvedBy === "offset"));
  assert.ok(objects.every((o) => o.anchorParagraph === o.paragraph && o.anchorSide === "at"));
  assert.deepEqual(objects[1].dims, { rowCount: 9, colCount: 8, cellCount: 68 });
  assert.equal(objects[1].textWrap, "TopAndBottom");
  assert.ok(objects[1].description.includes("9×8"));
});

test("fixture-table-only.hwp: a floating table is placed by its anchor, block", async () => {
  const doc = await loadDocument(sample("fixture-table-only.hwp"));
  const { objects } = await collectObjects(doc);

  assert.equal(objects.length, 1);
  const [t] = objects;
  assert.equal(t.kind, "table");
  assert.equal(t.treatAsChar, false);
  assert.equal(t.textWrap, "TopAndBottom");
  assert.equal(t.vertRelTo, "Para");
  assert.deepEqual(t.dims, { rowCount: 4, colCount: 3, cellCount: 10 });
  assert.deepEqual(
    { placement: t.placement, resolvedBy: t.resolvedBy, rank: t.rank },
    { placement: "block", resolvedBy: "anchor", rank: 2 },
  );
  assert.equal(t.anchorParagraph, 0);
  // A table's caption text has no accessor (cell 0 is real data, not the
  // caption), so the flag is reported and the text is honestly null.
  assert.equal(t.hasCaption, false);
  assert.equal(t.caption, null);
});

test("documents with no objects come back empty rather than guessing", async () => {
  for (const name of ["fixture-inline.hwp", "fixture-clause.hwp", "fixture-headings.hwp"]) {
    const doc = await loadDocument(sample(name));
    const { objects, overlays, stats } = await collectObjects(doc);
    assert.deepEqual(objects, [], name);
    assert.deepEqual(overlays, [], name);
    assert.equal(stats.geometryUsed, false, name);
  }
});

test("ranks 2 and 3 are reachable on a real document", async () => {
  // fixture-image.hwp's floating pictures are Paper-anchored, so the two
  // paragraph-anchored floating ranks need a document built for them. Round
  // -tripped through export/reload so the properties under test are the ones
  // the file actually holds.
  const doc = await imageFixtureWith([
    [0, 2, 0, { ...FLOATING, textWrap: "Square", vertRelTo: "Para", horzRelTo: "Column" }],
    [0, 6, 0, { ...FLOATING, textWrap: "TopAndBottom", vertRelTo: "Para", horzRelTo: "Para" }],
  ]);
  const { objects } = await collectObjects(doc);

  const beside = objects[0];
  assert.equal(beside.vertRelTo, "Para", "the Square edit must have survived the save");
  assert.equal(beside.horzRelTo, "Column");
  assert.deepEqual(
    { placement: beside.placement, resolvedBy: beside.resolvedBy, rank: beside.rank },
    { placement: "beside", resolvedBy: "anchor", rank: 3 },
  );
  assert.equal(beside.anchorParagraph, 2);

  const block = objects[2];
  assert.equal(block.vertRelTo, "Para");
  assert.deepEqual(
    { placement: block.placement, resolvedBy: block.resolvedBy, rank: block.rank },
    { placement: "block", resolvedBy: "anchor", rank: 2 },
  );
  assert.equal(block.anchorParagraph, 6);
});

test("HWPX reads the same way, including the control a forward sweep misses", async () => {
  // fixture-table.hwpx' only table sits at control 2 of paragraph 0 — the case
  // CLAUDE.md rule 7 is about, where findNearestControlForward from (0,0,0)
  // reports nothing at all. This module enumerates with getControlTextPositions
  // like doc_walk does, so it finds it.
  const doc = await loadDocument(sample("fixture-table.hwpx"));
  const { objects, stats } = await collectObjects(doc);
  assert.equal(objects.length, 1);
  assert.deepEqual(
    [objects[0].section, objects[0].paragraph, objects[0].controlIndex],
    [0, 0, 2],
  );
  assert.equal(objects[0].kind, "table");
  assert.equal(objects[0].placement, "inline");
  assert.equal(stats.geometryUsed, false);
});

// ── the laziness proof ─────────────────────────────────────────────────────

test("a document with no rank-4/5 object makes ZERO layout calls", async () => {
  // fixture-table.hwp: 6 pages, 87 paragraphs, 12 tables, all treatAsChar.
  // Every table is rank 1, so nothing in it can want geometry. The first layout
  // call would paginate all 6 pages — ~26 ms against a ~0.5 ms walk — for an
  // answer that is already exact.
  const w = watch(await loadDocument(sample("fixture-table.hwp")));
  const { objects, stats } = await collectObjects(w.doc);

  assert.equal(objects.length, 12);
  assert.ok(objects.every((o) => o.rank <= 3));
  assert.deepEqual(w.layoutCalls(), [], "no layout accessor may be touched");
  assert.equal(stats.geometryUsed, false);
  assert.equal(stats.pagesProbed, 0);
  // Not even the cheap page lookup: there is nothing to look a page up for.
  assert.equal(w.count("getPageOfPosition"), 0);
  assert.equal(w.count("pageCount"), 0);
});

test("a FLOATING but paragraph-anchored document still makes zero layout calls", async () => {
  // The weaker, more interesting case: floating objects everywhere, and still
  // nothing to pay for. Laziness keyed on "is it floating" instead of "does it
  // need geometry" would fail here — and 111 of the survey's 424 tables are
  // floating, so this is the common document, not the corner case.
  const doc = await imageFixtureWith([
    [0, 2, 0, { ...FLOATING, textWrap: "Square", vertRelTo: "Para", horzRelTo: "Column" }],
    [0, 4, 0, { ...FLOATING, textWrap: "TopAndBottom", vertRelTo: "Para", horzRelTo: "Para" }],
    [0, 6, 0, { ...FLOATING, textWrap: "TopAndBottom", vertRelTo: "Para", horzRelTo: "Para" }],
  ]);
  const w = watch(doc);
  const { objects, stats } = await collectObjects(w.doc);

  assert.ok(objects.every((o) => o.treatAsChar === false), "all three must be floating");
  assert.ok(objects.every((o) => o.rank === 2 || o.rank === 3));
  assert.deepEqual(w.layoutCalls(), []);
  assert.equal(stats.geometryUsed, false);
});

test("one rank-4 object pays for its page and no more", async () => {
  // fixture-image.hwp has two paper-anchored pictures, both on page 0. The
  // per-page memo must turn that into ONE getPageControlLayout and ONE
  // getPageTextLayout, not one of each per object.
  const w = watch(await loadDocument(sample("fixture-image.hwp")));
  const { stats } = await collectObjects(w.doc);

  assert.equal(stats.geometryUsed, true);
  assert.equal(stats.pagesProbed, 1);
  assert.equal(w.count("getPageControlLayout"), 1);
  assert.equal(w.count("getPageTextLayout"), 1);
  assert.equal(w.count("getPageOverlayImages"), 0, "the base64-carrying accessor is never called");
});

test("the paragraph walk stays inside the block-walk budget", async () => {
  // blocks.mjs pins its pass-1 cost at ~2.2 engine calls per paragraph and
  // asserts it, because a stray property read inside a loop is invisible until
  // a 1,200-paragraph document arrives. Same discipline here: one
  // getControlTextPositions per paragraph plus two probes per control, and
  // controls are rare (14 across 87 paragraphs here).
  const doc = await loadDocument(sample("fixture-table.hwp"));
  const paras = paragraphCount(doc);
  const { stats } = await collectObjects(doc);

  assert.ok(paras > 50, `fixture should be substantial, got ${paras} paragraphs`);
  const perParagraph = stats.engineCalls / paras;
  assert.ok(
    perParagraph < 2.2,
    `${stats.engineCalls} calls over ${paras} paragraphs = ${perParagraph.toFixed(2)}/para`,
  );
});

// ── a floating object that spills off its anchor's page ────────────────────

// A stub document, because the case needs a layout the fixtures do not have:
// `restrictInPage: false` lets a floating object lay out on the page AFTER the
// one its anchor paragraph is on. Hand-built rather than authored, so the
// divergence is exact and the test says what it is testing.
function stubDocument({ anchorPage, boxPage, runs }) {
  const picture = {
    width: 24000,
    height: 18000,
    treatAsChar: false,
    textWrap: "Square",
    vertRelTo: "Paper",
    horzRelTo: "Paper",
    description: "",
    hasCaption: false,
  };
  const notATable = "렌더링 오류: 지정된 컨트롤이 표가 아닙니다";
  const notAPicture = "렌더링 오류: 지정된 컨트롤이 그림이 아닙니다";
  return {
    getSectionCount: () => 1,
    getParagraphCount: () => 4,
    getControlTextPositions: (_s, p) => JSON.stringify(p === 3 ? [7] : []),
    getTableProperties: () => {
      throw notATable;
    },
    getTableDimensions: () => {
      throw notATable;
    },
    getPictureProperties: (_s, p, c) => {
      if (p === 3 && c === 0) return JSON.stringify(picture);
      throw notAPicture;
    },
    pageCount: () => 4,
    getPageOfPosition: () => JSON.stringify({ ok: true, page: anchorPage }),
    getPageControlLayout: (page) =>
      JSON.stringify({
        controls:
          page === boxPage
            ? [
                {
                  type: "image",
                  x: 223.3,
                  y: 300,
                  w: 364.8,
                  h: 267.6,
                  secIdx: 0,
                  paraIdx: 3,
                  controlIdx: 0,
                  wrap: "square",
                  plane: 2,
                  zOrder: 0,
                },
              ]
            : [],
      }),
    getPageTextLayout: (page) => JSON.stringify({ runs: runs[page] ?? [] }),
  };
}

const run = (y, paraIdx, text = "본문") => ({ text, x: 113.4, y, w: 200, h: 13.3, secIdx: 0, paraIdx });

test("a floating object laid out on the next page is still found", async () => {
  const doc = stubDocument({
    anchorPage: 1,
    boxPage: 2,
    runs: { 2: [run(100, 8), run(250, 9), run(400, 10)] },
  });
  const { objects, stats } = await collectObjects(doc);

  assert.equal(objects.length, 1);
  const [o] = objects;
  assert.equal(o.rank, 4);
  // The page it is laid out on, not the page its anchor paragraph sits on.
  assert.equal(o.page, 2);
  assert.equal(o.bbox.y, 300);
  // The run nearest ABOVE y=300 on page 2 is the one at y=250, paragraph 9.
  assert.equal(o.anchorParagraph, 9);
  assert.equal(o.anchorSide, "after");
  assert.equal(o.resolvedBy, "geometry");
  // The widening cost exactly one extra page: the anchor page and the one after
  // it. It is bounded on purpose — an unbounded search is the cost the module
  // refuses to pay.
  assert.ok(stats.pagesProbed <= 3, `probed ${stats.pagesProbed} pages`);
});

test("a bbox that cannot be found anywhere is reported as unresolved, not guessed", async () => {
  const doc = stubDocument({ anchorPage: 0, boxPage: 99, runs: {} });
  const { objects } = await collectObjects(doc);
  const [o] = objects;
  assert.equal(o.bbox, null);
  // The paragraph's page is still true and is kept; the reading position is not.
  assert.equal(o.page, 0);
  assert.equal(o.anchorParagraph, null);
  assert.equal(o.resolvedBy, "none");
  assert.notEqual(o.anchorParagraph, o.paragraph);
});

test("an object above every run on its page anchors BEFORE the first paragraph", async () => {
  const doc = stubDocument({
    anchorPage: 2,
    boxPage: 2,
    runs: { 2: [run(400, 11), run(500, 12)] },
  });
  const { objects } = await collectObjects(doc);
  const [o] = objects;
  // Its top edge (300) is above every run on the page. That is a real position
  // — a logo in the top margin — and it is "before paragraph 11", not "nowhere"
  // and not "after the last thing we happened to see".
  assert.equal(o.anchorParagraph, 11);
  assert.equal(o.anchorSide, "before");
  assert.equal(o.resolvedBy, "geometry");
});

test("a page with no text runs at all leaves the position unresolved", async () => {
  const doc = stubDocument({ anchorPage: 2, boxPage: 2, runs: {} });
  const { objects } = await collectObjects(doc);
  const [o] = objects;
  assert.equal(o.page, 2);
  assert.ok(o.bbox, "the bbox is known");
  // Knowing where it IS does not make a reading position exist. A full-page
  // image on a page with no body text has nothing to be next to.
  assert.equal(o.anchorParagraph, null);
  assert.equal(o.resolvedBy, "none");
});

// ── overlays ───────────────────────────────────────────────────────────────

test("overlays are reported per page and never given an anchor paragraph", async () => {
  const doc = await imageFixtureWith([
    [0, 2, 0, { ...FLOATING, textWrap: "BehindText", vertRelTo: "Paper", horzRelTo: "Paper", vertOffset: 20000, horzOffset: 10000 }],
    [0, 6, 0, { ...FLOATING, textWrap: "InFrontOfText", vertRelTo: "Paper", horzRelTo: "Paper", vertOffset: 40000, horzOffset: 15000 }],
  ]);
  const { objects, overlays } = await collectObjects(doc);

  const marks = objects.filter((o) => o.placement === "overlay");
  assert.equal(marks.length, 2, "both overlay wraps must survive the save and be found");
  assert.deepEqual(
    marks.map((o) => o.textWrap),
    ["BehindText", "InFrontOfText"],
  );

  for (const o of marks) {
    // The whole point. A watermark has no reading position, so none is
    // invented — not from the anchor paragraph its control happens to sit in,
    // and not from the run above it.
    assert.equal(o.anchorParagraph, null, "an overlay must never carry an anchor paragraph");
    assert.equal(o.anchorSection, null);
    assert.equal(o.anchorSide, null);
    assert.equal(o.resolvedBy, "none");
    assert.equal(o.rank, 5);
    // The page IS a true fact about it, and the only one.
    assert.equal(o.page, 0);
    assert.ok(o.bbox && o.bbox.w > 0);
  }

  assert.equal(overlays.length, 2);
  assert.ok(overlays.every((o) => o.page === 0));
  assert.deepEqual(
    overlays.map((o) => o.index),
    marks.map((o) => o.index),
  );
  // The inline picture in the middle is untouched by any of this.
  const inline = objects.find((o) => o.placement === "inline");
  assert.equal(inline.paragraph, 4);
  assert.equal(inline.anchorParagraph, 4);
});

test("an overlay is still an object, so a caller can count them", async () => {
  // Overlays appear in BOTH lists on purpose: `objects` is the complete
  // inventory (an image extractor wants all of them), `overlays` is the
  // grouping. A caller splicing markers into text filters on `placement`.
  const doc = await imageFixtureWith([
    [0, 2, 0, { ...FLOATING, textWrap: "BehindText", vertRelTo: "Paper", horzRelTo: "Paper" }],
  ]);
  const { objects, overlays } = await collectObjects(doc);
  assert.equal(objects.length, 3);
  assert.equal(overlays.length, 1);
  assert.equal(objects.filter((o) => o.placement !== "overlay").length, 2);
});

// ── geometry modes ─────────────────────────────────────────────────────────

test('geometry:"never" degrades honestly instead of falling back to the anchor', async () => {
  const w = watch(await loadDocument(sample("fixture-image.hwp")));
  const { objects, stats } = await collectObjects(w.doc, { geometry: "never" });

  assert.deepEqual(w.layoutCalls(), []);
  assert.equal(stats.geometryUsed, false);
  assert.equal(stats.pagesProbed, 0);

  const paperAnchored = objects.filter((o) => o.rank === 4);
  assert.equal(paperAnchored.length, 2);
  for (const o of paperAnchored) {
    // The label must not still say "geometry" when no geometry was read.
    assert.equal(o.resolvedBy, "none");
    assert.equal(o.page, null);
    assert.equal(o.bbox, null);
    // And above all: NOT the control's own paragraph. Substituting it here is
    // the exact fabrication the ladder ruled out one step earlier.
    assert.equal(o.anchorParagraph, null);
    assert.equal(o.anchorSection, null);
    assert.notEqual(o.anchorParagraph, o.paragraph);
    assert.ok(o.description.includes("unresolved"), o.description);
  }

  // Ranks 1-3 are unaffected: their position never came from the page.
  const inline = objects.find((o) => o.rank === 1);
  assert.equal(inline.resolvedBy, "offset");
  assert.equal(inline.anchorParagraph, 4);
});

test('geometry:"never" leaves an overlay an overlay, with no page invented', async () => {
  const doc = await imageFixtureWith([
    [0, 2, 0, { ...FLOATING, textWrap: "BehindText", vertRelTo: "Paper", horzRelTo: "Paper" }],
  ]);
  const { objects, overlays } = await collectObjects(doc, { geometry: "never" });
  const mark = objects.find((o) => o.placement === "overlay");
  assert.equal(mark.page, null);
  assert.equal(mark.bbox, null);
  assert.equal(mark.anchorParagraph, null);
  assert.equal(overlays.length, 1);
  assert.equal(overlays[0].page, null);
});

test('geometry:"always" fills page and bbox without downgrading an exact answer', async () => {
  const w = watch(await loadDocument(sample("fixture-table.hwp")));
  const { objects, stats } = await collectObjects(w.doc, { geometry: "always" });

  assert.equal(stats.geometryUsed, true);
  assert.equal(stats.pagesProbed, 6, "all six pages of the fixture");
  assert.ok(objects.every((o) => o.page !== null), "every object should get a page");
  assert.ok(objects.every((o) => o.bbox !== null), "every object should get a bbox");
  // MEASURED: the two tables per page, pages 0..5.
  assert.deepEqual(
    objects.map((o) => o.page),
    [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5],
  );
  // resolvedBy is a claim about HOW the position was found, and an inline
  // object's offset is exact. Knowing the bbox as well must not relabel it.
  assert.ok(objects.every((o) => o.resolvedBy === "offset"));
  assert.ok(objects.every((o) => o.anchorParagraph === o.paragraph));
  // The text layout is only needed to resolve a rank-4 anchor, and there are
  // none here, so it is still not paid for.
  assert.equal(w.count("getPageTextLayout"), 0);
});

test("an unknown geometry mode falls back to auto rather than throwing", async () => {
  const doc = await loadDocument(sample("fixture-table-only.hwp"));
  const { objects, stats } = await collectObjects(doc, { geometry: "sometimes" });
  assert.equal(objects.length, 1);
  assert.equal(stats.geometryUsed, false);
});

// ── determinism ────────────────────────────────────────────────────────────

test("two runs over the same document return deeply equal results", async () => {
  for (const name of ["fixture-image.hwp", "fixture-table.hwp", "fixture-table-only.hwp"]) {
    const a = await collectObjects(await loadDocument(sample(name)));
    const b = await collectObjects(await loadDocument(sample(name)));
    assert.deepEqual(a.objects, b.objects, name);
    assert.deepEqual(a.overlays, b.overlays, name);
    assert.deepEqual(a.stats, b.stats, name);
  }
});

test("two runs on the SAME loaded document are equal too", async () => {
  // Not the same test: the second run sees a document the engine has already
  // paginated, and a memo that leaked across calls would show up here as a
  // different engineCalls count or a different anchor.
  const doc = await loadDocument(sample("fixture-image.hwp"));
  const a = await collectObjects(doc);
  const b = await collectObjects(doc);
  assert.deepEqual(a.objects, b.objects);
  assert.deepEqual(a.overlays, b.overlays);
  assert.deepEqual(a.stats, b.stats);
});

test("the geometry mode changes what is known, never the ladder's verdict", async () => {
  const doc = await loadDocument(sample("fixture-image.hwp"));
  const auto = await collectObjects(doc, { geometry: "auto" });
  const never = await collectObjects(doc, { geometry: "never" });
  const always = await collectObjects(doc, { geometry: "always" });
  const ladder = (r) => r.objects.map((o) => [o.index, o.kind, o.placement, o.rank]);
  assert.deepEqual(ladder(never), ladder(auto));
  assert.deepEqual(ladder(always), ladder(auto));
});
