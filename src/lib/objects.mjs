// Where an object actually READS: tables and pictures, placed.
//
// doc_walk.mjs answers "what kind of control is this". It stops there, and
// pictures fall out of its classifier as `kind: "other"` — which every caller
// then drops. This module is the next question, the one that decides whether a
// picture is even allowed into the text at all.
//
// ── LOGICAL POSITION IS NOT VISUAL POSITION ────────────────────────────────
//
// An HWP object has two positions and they are not the same thing:
//
//   LOGICAL   the paragraph whose record holds the control. Always exists.
//   VISUAL    where the object is laid out on paper. What a reader sees.
//
// For an inline object (`treatAsChar: true`) they agree, exactly — the control
// is a zero-width character in the paragraph and its offset is its position.
// For a floating object anchored to a paragraph they agree approximately: the
// object is near that paragraph, above or beside it. For a PAPER-anchored
// object they do not agree at all — the control's paragraph is wherever the
// author happened to have the caret, and the object is pinned to a page
// coordinate that has nothing to do with it. Reading that paragraph as the
// object's position is not an approximation, it is a fabrication.
//
// Measured over 40 real documents (re-verified here on the repo fixtures):
//
//   tables 424:  inline 313 / floating 111 · wrap TopAndBottom 399, Square 25
//                relTo Para/Para 262, Para/Column 162, Paper 0
//   images  32:  inline  11 / floating  21 · wrap Square 11, TopAndBottom 12,
//                InFrontOfText 5, BehindText 4 · Para/Para 10, Para/Column 17,
//                Paper/Paper 5
//
// So no real table is paper-anchored and images are, and images alone bring the
// two overlay wraps — watermarks and stamps. Those are the case this module
// exists to refuse.
//
// ── WHY RANK 5 REFUSES TO PLACE ────────────────────────────────────────────
//
// A `BehindText` watermark and an `InFrontOfText` stamp are not in the reading
// flow. They are painted under or over the whole page. There is no paragraph
// they belong after, no sentence they interrupt, and no reader who encounters
// them at a particular point in the text. Any position we assigned would be
// invented — and it would be invented CONFIDENTLY, landing in the middle of a
// sentence in an extracted text file, which is worse than omitting it, because
// the reader cannot tell the difference between a marker the document put there
// and one we made up.
//
// This is the same error as inferring a heading tree for a document that has no
// headings (headings.mjs refuses that too). So overlays are never inlined. They
// come back in `overlays`, grouped by PAGE, which is the only positional fact
// about them that is true.
//
// ── WHY LAZINESS IS LOAD-BEARING, NOT AN OPTIMIZATION ──────────────────────
//
// Everything above ranks 1-3 is answerable from properties the paragraph walk
// already pays for. Rank 4 and rank 5 need the layout engine, and the FIRST
// layout call paginates the entire document. Measured on `fixture-table.hwp`
// (6 pages, 87 paragraphs, 12 tables), pinned by the test file:
//
//   paragraph/control walk                       ~0.5 ms
//   first getPageControlLayout(n)               ~26   ms   ← pagination
//   each further getPageControlLayout(n)         ~0.5-3 ms
//   getPageTextLayout over all 6 pages          ~22   ms
//
// That is 50-100× the walk, paid on the first layout call whether or not the
// document has anything that needs it — and `fixture-table.hwp` does not: all
// 12 of its tables are `treatAsChar`, rank 1. Reading it must not touch layout
// at all. `geometry: "auto"` does the cheap walk first and only reaches for a
// layout API once an object has actually landed on rank 4 or rank 5. Once the
// pagination is paid, per-page probing is cheap, so the expensive decision is
// binary: touch it, or don't. `test/spec/objects.test.mjs` proves the "don't"
// with a call counter, which is the only way that stays true.
//
// ── WHAT THE ENGINE ACTUALLY RETURNS (probed on the pinned 0.7.19) ─────────
//
// getTableProperties(s,p,c) carries the whole placement vocabulary for a table
// — treatAsChar, textWrap, vertRelTo, horzRelTo, hasCaption, tableWidth,
// tableHeight — and throws `지정된 컨트롤이 표가 아닙니다` for anything else, the
// same message getTableDimensions uses. getPictureProperties(s,p,c) carries the
// same vocabulary for a picture (width/height/description/hasCaption) and
// throws `지정된 컨트롤이 그림이 아닙니다`. Both throw a bare STRING, not an
// Error — doc_walk's msgOf handles that, so its predicates are reused here.
//
// getPageControlLayout(page) → {"controls":[{type,x,y,w,h,secIdx,paraIdx,
// controlIdx,plane,zOrder,stableIndex,...}]}. It covers BOTH images and tables
// and back-references the logical position, which is what makes a bbox
// attachable to the object it belongs to. Two things the survey got wrong and
// this module does not rely on: a TABLE entry has NO `wrap` field (only images
// do), and a table entry carries a full `cells` array, so the payload is not
// free.
//
// getPageTextLayout(page) → {"runs":[{text,x,y,w,h,...,secIdx,paraIdx,
// charStart}]}. The runs back-reference their paragraph directly, so mapping a
// run to a reading position is a field read, not a geometric search. Rule 8 of
// spec/rhwp-behavior.md: the y grouping is approximate (±half a run height).
// That is fine here — "which run is above this object" survives that slack.
//
// getPageOfPosition(s,p) → {"ok":true,"page":n} (0-based). MEASURED CHEAP:
// ~0.4 ms on a cold document, and it does NOT force pagination. So finding an
// object's page costs nothing; it is the bbox and the text runs that cost.
//
// getPageOverlayImages(page) is NOT used, and the reason is worth writing down:
// it inlines the full base64 PNG of every overlay (hundreds of KB per image)
// and carries no secIdx/paraIdx, so it cannot tie an overlay back to a control
// and it cannot be called speculatively. `getPageControlLayout`'s `plane` and
// `wrap` fields say the same thing for free — and rank 5 is already decided by
// `textWrap` in the cheap walk, before any page is touched at all.

import {
  controlOffsets,
  eachParagraph,
  isNotTableError,
  isOutOfRangeError,
} from "./doc_walk.mjs";

// ── the wrap vocabulary ────────────────────────────────────────────────────

// Text flows AROUND the object, so it shares a band with the paragraph beside
// it. "Tight" and "Through" are in here on purpose: image_props.mjs records
// that OUR save downgrades both to "Square", but a document Hancom itself wrote
// can genuinely carry them, and we are reading other people's files.
const WRAP_AROUND = new Set(["Square", "Tight", "Through"]);

// The two overlay wraps. Not in the reading flow — see the header.
const WRAP_OVERLAY = new Set(["BehindText", "InFrontOfText"]);

// What the VERTICAL offset is measured from. Vertical is the one that decides a
// reading position, because reading order is vertical: an object whose vertical
// origin is the paragraph is near that paragraph however its horizontal origin
// is expressed. This is exactly the survey's "Para/Para" and "Para/Column"
// collapsing into one bucket, and "Paper/Paper" standing alone.
const VERT_PAGE_ANCHORED = new Set(["Paper", "Page"]);

export const PLACEMENTS = Object.freeze(["inline", "block", "beside", "overlay"]);
export const RESOLVERS = Object.freeze(["offset", "anchor", "geometry", "none"]);
export const GEOMETRY_MODES = Object.freeze(["auto", "never", "always"]);

// How far either side of an object's anchor page we will look for its bbox
// before giving up. A floating object normally lays out on its anchor's page;
// `restrictInPage: false` lets it spill to the next one. Bounded on purpose —
// an unbounded search over a 200-page document is the cost this module refuses
// to pay, and a bbox we could not find is reported as null rather than guessed.
const PAGE_SEARCH_RADIUS = 1;

const str = (v) => (v == null ? "" : String(v));
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function parseOrNull(json) {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// ── the ladder, pure ───────────────────────────────────────────────────────

const placed = (placement, resolvedBy, rank) => ({ placement, resolvedBy, rank });

// The whole placement decision, from four properties and nothing else. Pure so
// that the ladder can be tested without a document — the combinations that
// matter are the ones the survey found in the wild, and a unit test can state
// all of them in one screen.
//
// The five rules are checked IN RANK ORDER and they are mutually exclusive:
// rank 1 takes any inline object, ranks 2/3 and rank 4 split on where the
// vertical offset is measured from, and rank 5 takes the two overlay wraps that
// ranks 2-4 all exclude. Every input lands on exactly one.
export function classifyPlacement(props = {}) {
  const treatAsChar = props?.treatAsChar;
  const wrap = str(props?.textWrap);
  const vert = str(props?.vertRelTo);

  // RANK 1 — inline. The control is a zero-width character in the paragraph and
  // `getControlTextPositions` reports its offset in the same coordinate system
  // as `getTextRange` (doc_walk's header). Nothing is approximate here, so
  // nothing below it can improve on the answer.
  //
  // This is checked FIRST, before the wrap is even looked at, and that is
  // deliberate: an inline object's `textWrap` is dead data the engine does not
  // clear. `samples/fixture-image.hwp` has a `treatAsChar: true` picture still
  // carrying `textWrap: "Square"` from before it was made inline. Reading the
  // wrap first would place a picture that is literally a character in the text
  // as though text flowed around it.
  if (treatAsChar === true) return placed("inline", "offset", 1);

  const overlay = WRAP_OVERLAY.has(wrap);
  const around = WRAP_AROUND.has(wrap);
  // Anything that is not explicitly a paper/page coordinate is treated as
  // paragraph-relative. The engine's vertRelTo enum is only Paper/Page/Para, so
  // in practice this is `=== "Para"`; written as the negative because an
  // unrecognized value should fall back to the anchor paragraph, which is the
  // one positional fact we actually hold, rather than to page geometry we would
  // then have to interpret with no idea what it was measured against.
  const pageAnchored = VERT_PAGE_ANCHORED.has(vert);

  // RANK 2 — floating, anchored to the paragraph, text pushed above and below.
  // The anchor paragraph IS the position: the object gets its own band of the
  // page immediately at that paragraph. In practice the wrap here is
  // "TopAndBottom": 399 of the 424 surveyed tables carry it. An unrecognized
  // wrap lands here too, deliberately — a block on its own line is the
  // conservative reading, since the alternative puts the object mid-sentence.
  if (!pageAnchored && !overlay && !around) return placed("block", "anchor", 2);

  // RANK 3 — floating, anchored to the paragraph, text flows around it. Same
  // anchor, weaker claim: the object is BESIDE that paragraph rather than
  // between it and the next one, so a renderer should not break the paragraph
  // to insert it.
  if (!pageAnchored && !overlay && around) return placed("beside", "anchor", 3);

  // RANK 4 — pinned to the paper. The anchor paragraph is noise; the position
  // has to come from the page. The wrap still says HOW it sits once we know
  // where it is, so the placement is decided here and only the anchor waits on
  // geometry. `resolvedBy: "geometry"` is a promise the caller can check: an
  // object still carrying it after collection was actually resolved from the
  // page, and one degraded to "none" was not.
  if (pageAnchored && !overlay) return placed(around ? "beside" : "block", "geometry", 4);

  // RANK 5 — overlay. Never placed in the body. See the header; this is the
  // rule the module exists for.
  return placed("overlay", "none", 5);
}

// ── engine-call counting ───────────────────────────────────────────────────

// The same transparent proxy blocks.mjs uses, for the same reason: a call
// budget that is asserted by a test is a budget that stays true, and one that
// is estimated in a comment is a budget that rots. Duplicated rather than
// exported across modules because blocks.mjs keeps its counter private to its
// own accounting and this module must not disturb it.
function countingProxy(doc, counter) {
  return new Proxy(doc, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      return (...args) => {
        counter.calls++;
        return value.apply(target, args);
      };
    },
  });
}

// ── the cheap walk ─────────────────────────────────────────────────────────

// A picture's caption is addressed like a table cell hanging off the control:
// cell 0, paragraph 0 (core/image.mjs, reference/images.md). A picture has no
// real cells, so cell 0 is unambiguous — which is exactly why the same path
// does NOT work for a table, where cell 0 is the top-left data cell.
const captionPath = (controlIndex) =>
  JSON.stringify([{ controlIndex, cellIndex: 0, cellParaIndex: 0 }]);

// Read a picture's caption text. Only called when `hasCaption` is already true,
// so a captionless picture costs nothing: the accessor throws
// `그림에 캡션이 없습니다` and speculating on every picture would pay for that
// throw on the 21 of 32 surveyed images that have no caption.
function readPictureCaption(eng, s, p, c) {
  try {
    const len = eng.getCellParagraphLengthByPath(s, p, captionPath(c));
    if (!(len > 0)) return "";
    return str(eng.getTextInCellByPath(s, p, captionPath(c), 0, len)).normalize("NFC").trim();
  } catch {
    return null;
  }
}

// One control, two probes, in the order that makes the common case cheap.
//
// `getTableProperties` is the discriminator rather than `getTableDimensions`
// because it doubles as the property read: a table costs one call to identify
// and one more for its dimensions, instead of one to identify, one to reject
// the picture probe and one for properties. Everything that is neither a table
// nor a picture — SectionDef and ColumnDef at offset 0 of every section's first
// paragraph, equations, footnotes, form fields — costs exactly two throws and
// is dropped.
function readObjectAt(eng, s, p, c) {
  let tableProps = null;
  try {
    tableProps = JSON.parse(eng.getTableProperties(s, p, c));
  } catch (e) {
    // An out-of-range index means the caller's control count and the engine's
    // disagree; there is nothing at this index, so stop rather than probing
    // again with the same bad index.
    if (isOutOfRangeError(e)) return null;
    if (!isNotTableError(e)) {
      /* unknown failure — fall through to the picture probe rather than guess */
    }
  }

  if (tableProps) {
    const dims = parseOrNull(safeCall(eng, "getTableDimensions", s, p, c)) ?? {};
    return {
      kind: "table",
      props: tableProps,
      dims: {
        rowCount: num(dims.rowCount),
        colCount: num(dims.colCount),
        cellCount: num(dims.cellCount),
      },
      width: num(tableProps.tableWidth),
      height: num(tableProps.tableHeight),
      hasCaption: tableProps.hasCaption === true,
      // A table's caption is NOT reachable by the picture caption path (cell 0
      // is real data), and the engine exposes no caption accessor of its own.
      // Reporting the flag and null text is the honest shape; inventing the
      // first cell's text as a caption would be a lie that reads plausibly.
      caption: null,
      altText: null,
    };
  }

  let picProps = null;
  try {
    picProps = JSON.parse(eng.getPictureProperties(s, p, c));
  } catch {
    return null; // neither a table nor a picture
  }

  const hasCaption = picProps.hasCaption === true;
  return {
    kind: "image",
    props: picProps,
    dims: null,
    width: num(picProps.width),
    height: num(picProps.height),
    hasCaption,
    caption: hasCaption ? readPictureCaption(eng, s, p, c) : null,
    altText: str(picProps.description) || null,
  };
}

function safeCall(eng, method, ...args) {
  try {
    return eng[method](...args);
  } catch {
    return null;
  }
}

// ── geometry, lazily ───────────────────────────────────────────────────────

// Per-page memo over the two expensive layout accessors. Nothing in here runs
// until someone asks for a page, and `pages` records which pages were touched
// so `stats.pagesProbed` is a fact rather than a guess.
function makeLayoutCache(eng) {
  const controls = new Map();
  const runs = new Map();
  const pages = new Set();
  let used = false;

  // Memoized: findBox asks for it once per object, and a document with fifty
  // paper-anchored logos should not pay fifty times for a number that cannot
  // change while we are reading.
  let total = null;
  const pageCount = () => {
    if (total === null) {
      const n = Number(safeCall(eng, "pageCount"));
      total = Number.isFinite(n) && n > 0 ? n : 0;
    }
    return total;
  };

  function controlsOn(page) {
    if (controls.has(page)) return controls.get(page);
    used = true;
    pages.add(page);
    const v = parseOrNull(safeCall(eng, "getPageControlLayout", page));
    const list = Array.isArray(v?.controls) ? v.controls : [];
    controls.set(page, list);
    return list;
  }

  function runsOn(page) {
    if (runs.has(page)) return runs.get(page);
    used = true;
    pages.add(page);
    const v = parseOrNull(safeCall(eng, "getPageTextLayout", page));
    const list = Array.isArray(v?.runs) ? v.runs : [];
    runs.set(page, list);
    return list;
  }

  return {
    controlsOn,
    runsOn,
    pageCount,
    get used() {
      return used;
    },
    get pagesProbed() {
      return pages.size;
    },
  };
}

// The page the control's paragraph is on. Cheap and pagination-free — verified
// against every control of `fixture-table.hwp`, where it agrees with the page
// each control's bbox was actually found on for all 12 tables.
function anchorPageOf(eng, s, p) {
  const v = parseOrNull(safeCall(eng, "getPageOfPosition", s, p));
  if (!v || v.ok !== true) return null;
  return num(v.page);
}

const sameControl = (entry, s, p, c) =>
  entry?.secIdx === s && entry?.paraIdx === p && entry?.controlIdx === c;

// Find the object's laid-out box. Starts on the anchor's page because that is
// where it almost always is, then widens by PAGE_SEARCH_RADIUS. Returns null
// rather than a plausible-looking box when it cannot find the control.
function findBox(layout, startPage, s, p, c) {
  if (startPage == null) return null;
  const total = layout.pageCount();
  for (let d = 0; d <= PAGE_SEARCH_RADIUS; d++) {
    for (const page of d === 0 ? [startPage] : [startPage - d, startPage + d]) {
      if (page < 0 || (total > 0 && page >= total)) continue;
      const hit = layout.controlsOn(page).find((e) => sameControl(e, s, p, c));
      if (hit) {
        return {
          page,
          bbox: { x: num(hit.x), y: num(hit.y), w: num(hit.w), h: num(hit.h) },
          plane: num(hit.plane),
          zOrder: num(hit.zOrder),
        };
      }
    }
  }
  return null;
}

// The reading position of a paper-anchored object: the body text run nearest
// ABOVE its top edge on the same page, mapped back to the paragraph the run
// belongs to. The run already carries `secIdx`/`paraIdx`, so this is a field
// read after a comparison — no coordinate matching against paragraph boxes, and
// rule 8's approximate y grouping cannot move an object from one side of a run
// to the other.
//
// "Above" is measured against the run's TOP, not its baseline or its bottom: a
// run that begins above the object's top edge is one the reader has already
// passed when they reach the object.
//
// Nothing above it means the object sits above all body text on that page — a
// logo in the top margin, a header image. That is a real position and it is
// "before the first paragraph on this page", not "nowhere", so it is reported
// with `anchorSide: "before"` rather than dropped.
function anchorFromGeometry(layout, page, top) {
  const runs = layout
    .runsOn(page)
    .filter((r) => num(r?.paraIdx) !== null && num(r?.secIdx) !== null && num(r?.y) !== null);
  if (runs.length === 0) return null;

  let best = null;
  for (const r of runs) {
    if (r.y > top) continue;
    if (best === null || r.y > best.y || (r.y === best.y && r.paraIdx > best.paraIdx)) best = r;
  }
  if (best) return { section: best.secIdx, paragraph: best.paraIdx, side: "after" };

  // Above everything on the page. Take the topmost run, breaking a tie on the
  // lower paragraph index so the answer does not depend on run order.
  let first = runs[0];
  for (const r of runs) {
    if (r.y < first.y || (r.y === first.y && r.paraIdx < first.paraIdx)) first = r;
  }
  return { section: first.secIdx, paragraph: first.paraIdx, side: "before" };
}

// ── description ────────────────────────────────────────────────────────────

// One line a human can read, in the voice of blocks.mjs' table placeholder.
// This is a SUMMARY, not the picture's own alt text — that is `altText`, kept
// separate because an empty alt text and an unknown object are different facts.
function describe(o) {
  const where =
    o.placement === "overlay"
      ? o.page == null
        ? "overlay, page unknown"
        : `overlay on page ${o.page + 1}`
      : o.anchorParagraph == null
        ? `${o.placement}, position unresolved`
        : `${o.placement} at section ${o.anchorSection}, paragraph ${o.anchorParagraph}`;

  const what =
    o.kind === "table"
      ? `table ${o.dims?.rowCount ?? "?"}×${o.dims?.colCount ?? "?"}`
      : `image ${o.width ?? "?"}×${o.height ?? "?"} HWPUNIT`;

  const tail = [];
  if (o.caption) tail.push(`caption "${o.caption}"`);
  else if (o.hasCaption) tail.push("captioned");
  if (o.altText) tail.push(`alt "${o.altText}"`);

  return `[${what}: ${where}, wrap ${o.textWrap || "unknown"}, resolved by ${o.resolvedBy}` +
    `${tail.length ? `, ${tail.join(", ")}` : ""}]`;
}

// ── the collector ──────────────────────────────────────────────────────────

// Every table and picture in the document, placed.
//
//   geometry: "auto"    (default) lazy — the layout engine is touched only if
//                       an object actually lands on rank 4 or rank 5. A
//                       document whose objects are all inline or paragraph-
//                       anchored costs ZERO layout calls.
//   geometry: "never"   never touch it. Rank-4 objects come back with
//                       `resolvedBy: "none"`, `anchorParagraph: null`,
//                       `page: null`, `bbox: null` — the position is not known
//                       and the result says so, instead of quietly substituting
//                       the anchor paragraph the ladder just ruled out.
//   geometry: "always"  resolve page and bbox for every object, not only the
//                       ones that need it. `resolvedBy` does NOT change: an
//                       inline object is still resolved by its offset, which is
//                       exact, and geometry could only make that answer worse.
//
// Returns { objects, overlays, stats }. `objects` is in document order and
// includes overlays (with `placement: "overlay"`); a caller splicing objects
// into text MUST skip those. `overlays` is the same set grouped by page, which
// is the only positional claim about them that is true.
export async function collectObjects(doc, { geometry = "auto" } = {}) {
  const mode = GEOMETRY_MODES.includes(geometry) ? geometry : "auto";
  const counter = { calls: 0 };
  const eng = countingProxy(doc, counter);

  // Pass 1 — the cheap walk. One getControlTextPositions per paragraph, two
  // probes per control. No layout, no page, no bbox.
  const found = [];
  for (const { s, p } of eachParagraph(eng)) {
    const offsets = controlOffsets(eng, s, p);
    for (let c = 0; c < offsets.length; c++) {
      const o = readObjectAt(eng, s, p, c);
      if (!o) continue;
      const props = o.props ?? {};
      const cls = classifyPlacement(props);
      found.push({
        index: found.length,
        kind: o.kind,
        section: s,
        paragraph: p,
        controlIndex: c,
        charOffset: num(offsets[c]),
        treatAsChar: props.treatAsChar === true,
        textWrap: str(props.textWrap) || null,
        vertRelTo: str(props.vertRelTo) || null,
        horzRelTo: str(props.horzRelTo) || null,
        placement: cls.placement,
        resolvedBy: cls.resolvedBy,
        rank: cls.rank,
        // Ranks 1-3 already know their anchor: it is the control's own
        // paragraph, and `anchorSide: "at"` says the marker belongs exactly at
        // `charOffset`. Rank 4 waits for geometry; rank 5 never gets one.
        anchorSection: cls.rank <= 3 ? s : null,
        anchorParagraph: cls.rank <= 3 ? p : null,
        anchorSide: cls.rank <= 3 ? "at" : null,
        page: null,
        bbox: null,
        plane: null,
        zOrder: null,
        width: o.width,
        height: o.height,
        dims: o.dims,
        hasCaption: o.hasCaption,
        caption: o.caption,
        altText: o.altText,
        description: "",
      });
    }
  }

  // Pass 2 — geometry, and only if it is owed. This branch is the whole point
  // of the module's cost profile: `needsGeometry` is false for every document
  // whose objects are inline or paragraph-anchored, and the layout cache below
  // is then never asked for a page, so the pagination is never paid.
  const needsGeometry = found.some((o) => o.rank >= 4);
  const layout = makeLayoutCache(eng);

  if (mode !== "never" && (needsGeometry || mode === "always")) {
    const targets = mode === "always" ? found : found.filter((o) => o.rank >= 4);
    for (const o of targets) {
      const start = anchorPageOf(eng, o.section, o.paragraph);
      const box = findBox(layout, start, o.section, o.paragraph, o.controlIndex);
      if (box) {
        o.page = box.page;
        o.bbox = box.bbox;
        o.plane = box.plane;
        o.zOrder = box.zOrder;
      } else if (start != null) {
        // The paragraph's page is still a true fact even when the control's box
        // could not be located, so it is kept — but the bbox stays null and, on
        // rank 4, the reading position stays unresolved.
        o.page = start;
      }

      // Rank 5 stops here. A page and a box are all an overlay ever gets; the
      // reading position it does not have is not filled in from either.
      if (o.rank === 5) continue;
      if (o.rank !== 4) continue;

      const top = o.bbox?.y;
      if (o.page == null || top == null) continue;
      const anchor = anchorFromGeometry(layout, o.page, top);
      if (!anchor) continue;
      o.anchorSection = anchor.section;
      o.anchorParagraph = anchor.paragraph;
      o.anchorSide = anchor.side;
    }
  }

  // A rank-4 object that never got an anchor — geometry off, or the layout
  // could not place it — is downgraded to `resolvedBy: "none"` here rather than
  // keeping the "geometry" label the ladder handed it. The label is a claim
  // about what actually happened, and a caller checking it must be able to
  // trust that "geometry" means resolved.
  for (const o of found) {
    if (o.rank === 4 && o.anchorParagraph == null) o.resolvedBy = "none";
    o.description = describe(o);
  }

  const overlays = found
    .filter((o) => o.placement === "overlay")
    .map((o) => ({
      index: o.index,
      page: o.page,
      kind: o.kind,
      bbox: o.bbox,
      plane: o.plane,
      zOrder: o.zOrder,
      textWrap: o.textWrap,
      section: o.section,
      paragraph: o.paragraph,
      controlIndex: o.controlIndex,
      width: o.width,
      height: o.height,
      caption: o.caption,
      altText: o.altText,
      description: o.description,
    }))
    // Grouped by page. A null page (geometry off) sorts last rather than
    // first — an unknown page is not page zero.
    .sort((a, b) => {
      const ap = a.page == null ? Number.POSITIVE_INFINITY : a.page;
      const bp = b.page == null ? Number.POSITIVE_INFINITY : b.page;
      return ap - bp || a.index - b.index;
    });

  return {
    objects: found,
    overlays,
    stats: {
      engineCalls: counter.calls,
      geometryUsed: layout.used,
      pagesProbed: layout.pagesProbed,
    },
  };
}

export { WRAP_AROUND, WRAP_OVERLAY, VERT_PAGE_ANCHORED, PAGE_SEARCH_RADIUS };

// ── the inline marker a reader sees ───────────────────────────────────────
//
// What goes into rendered body text where a picture sits. Three decisions,
// each from a measurement:
//
// SIZE IS RELATIVE, not absolute. "150x112mm" cannot be judged without knowing
// the page is 210mm wide; "100% of the text column" answers "is this a
// full-width figure or an icon?" immediately, and it is the same language the
// insert path already refuses oversized images in. getPageDef costs 0.004ms, so
// the denominator is effectively free. Absolute mm rides along second.
//
// THE FILENAME IS WORTH PRINTING, BARELY. Hancom auto-fills a description like
// "그림입니다.\n원본 그림의 이름: 그림3.png\n원본 그림의 크기: ...", and it is
// present on 40 of 41 pictures across 40 real documents — but the names are
// auto-numbered (그림3.png, 그림8.png), so it identifies WHICH picture rather
// than what it shows. Printed when it exists, never faked when it does not.
//
// PLACEMENT IS NAMED. "beside" tells a reader the body text flows around this
// thing, so the paragraph either side may read oddly — the sort of thing that
// otherwise looks like an extraction bug.
const FILENAME_RE = /원본 그림의 이름:\s*([^\r\n]+)/;

export function pictureFilename(altText) {
  const m = FILENAME_RE.exec(String(altText ?? ""));
  return m ? m[1].trim() : null;
}

export function pictureMarker(props, { usableWidth = 0, placement = null } = {}) {
  const place = placement ?? classifyPlacement(props).placement;
  const name = pictureFilename(props?.description);
  const w = Number(props?.width) || 0;
  const bits = [];
  if (name) bits.push(`"${name}"`);
  if (usableWidth > 0 && w > 0) {
    const pct = Math.round((w / usableWidth) * 100);
    bits.push(`${pct}% of text width`);
    if (pct > 100) bits.push("WIDER THAN THE TEXT COLUMN");
  } else if (w > 0) {
    bits.push(`${w} HWPUNIT wide`);
  }
  bits.push(place);
  return `[image ${bits.join(" · ")}]`;
}
