// The block stream: ONE walk of a document, shared by everything that needs it.
//
// Before this module, read.mjs, extract_tables.mjs and documentHasTable each
// walked every paragraph of the document independently, and a section renderer
// would have made a fourth. This is the single walk they can all sit on: it
// enumerates paragraphs once, hands back a `Block` per paragraph, and can
// render any contiguous range of them with tables, equations and footnotes
// spliced back into the exact character positions they occupy.
//
// ── WHY INLINE SPLICING IS EXACT, NOT APPROXIMATE ──────────────────────────
//
// doc_walk.mjs' header has the details; the consequence for this file is the
// whole design. Controls are ZERO-WIDTH, and `getControlTextPositions(s,p)`
// reports their offsets in the SAME coordinate system as `getTextRange`. A
// 42-character paragraph carrying two equations and a footnote is still 42
// characters, with the controls at offsets 11, 20 and 31. So a control's
// rendering can be spliced straight into the text at its offset and every
// character lands where the document put it. No estimation, no drift.
//
// The splice runs in DESCENDING offset order. Splicing at offset 31 first
// cannot move offset 11; splicing at 11 first would push 31 to the right by the
// width of whatever was inserted, and every later offset with it.
//
// Ties are real, not theoretical: `getControlTextPositions` on a paragraph
// whose equation inserts were clamped past the end returns `[0,0,5,5]` — two
// distinct controls at one offset. Every section's first paragraph likewise
// carries the invisible SectionDef/ColumnDef pair at `[0,0,…]`. So the
// comparator is TOTAL — offset descending, then control index descending — and
// never leaves the outcome to sort stability. Descending index at a shared
// offset is what puts the LOWER index first in the output: the later splice at
// the same position pushes the earlier-rendered text to the right, so
// processing 3 before 2 leaves 2 ahead of 3, which is document order.
//
// ── WHY THE CALL BUDGET IS PART OF THE CONTRACT ────────────────────────────
//
// Every property this module could read costs a WASM round-trip. Reading
// paragraph properties + style + character properties for every paragraph is
// ~5 calls each, which on a 1,200-paragraph document is ~6,000 calls before a
// single character is rendered — for data that 90% of callers never look at.
//
// So the walk is layered by cost:
//
//   pass 1        getTextRange + getControlTextPositions per paragraph, plus
//                 ONE cheap table probe per control found. Controls are rare
//                 (measured: 14 across the 87 paragraphs of fixture-table.hwp),
//                 so this is ~2.2 calls per paragraph, and it is everything
//                 detection, character counting and snapshotting need.
//   block.props() 3 calls, LAZY and MEMOIZED. Callers pay per block inspected.
//   classify      the full equation/footnote probe, only for the controls of a
//                 block inside a span actually being rendered.
//   tables        cell reading, ~275 calls for one 9×8 table, only on render.
//                 Nested-table discovery is OFF by default (maxDepth 1) because
//                 the nested probe is 8 speculative calls per cell paragraph —
//                 measured, it takes that same table from 275 calls to 911.
//
// `stats.engineCalls` is a real counter, not an estimate: the walk talks to the
// document through a counting proxy. That makes the budget testable, which is
// the only way it stays true.

import {
  BODY_EQUATION_CELL,
  classifyControl,
  controlOffsets,
  isTableControl,
  paragraphText,
} from "./doc_walk.mjs";
import { extractTables } from "./tables.mjs";
import { renderTableMarkdown } from "./render_md.mjs";
import { equationToLatex, normalizeEquationScript } from "./eqn.mjs";

// BODY_EQUATION_CELL is re-exported so a caller reaching for the equation trap
// sentinel does not have to know it lives one module over. Never write -1.
export { BODY_EQUATION_CELL };

const DEFAULTS = Object.freeze({
  tableMode: "body", // "body" → a real markdown grid | "cells" → a placeholder
  maxDepth: 1, // 1 = no nested-table discovery; see the budget note above
  equations: true,
  footnotes: true,
});

// ── engine call counting ───────────────────────────────────────────────────

// A transparent proxy that counts every method call made through it. The walk
// uses this instead of the raw document, so `stats.engineCalls` counts the
// calls made by doc_walk.mjs and tables.mjs helpers too — which is the point,
// since those are where most of the cost is.
//
// `model.doc` deliberately hands back the RAW document: a caller that goes
// around the model is not spending the model's budget and should not show up
// in its accounting.
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

// ── per-block property reads ───────────────────────────────────────────────

// Character height comes back in 1/100 pt (a 10pt run reports 1000), so the
// points a caller wants is the raw value over 100.
const CHAR_HEIGHT_PER_POINT = 100;

const EMPTY_PROPS = Object.freeze({
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

// The three engine calls a block's props() costs, each independently guarded:
// a document where one accessor fails should still yield the other two rather
// than an all-defaults blank.
function readProps(eng, s, p) {
  const out = { ...EMPTY_PROPS };

  try {
    const pp = JSON.parse(eng.getParaPropertiesAt(s, p));
    out.marginLeft = Number(pp?.marginLeft ?? 0);
    out.indent = Number(pp?.indent ?? 0);
    out.alignment = String(pp?.alignment ?? "");
    out.headType = pp?.headType ?? "None";
    out.paraLevel = Number(pp?.paraLevel ?? 0);
    out.numberingId = Number(pp?.numberingId ?? 0);
  } catch {
    /* leave the defaults */
  }

  try {
    const st = JSON.parse(eng.getStyleAt(s, p));
    out.styleName = String(st?.name ?? "");
    out.styleId = Number.isInteger(st?.id) ? st.id : -1;
  } catch {
    /* "" / -1 mean "the engine would not say", not "no style" */
  }

  try {
    // Character properties are per-run; offset 0 is the paragraph's opening run
    // and the only one a block-level summary can honestly claim.
    const cp = JSON.parse(eng.getCharPropertiesAt(s, p, 0));
    const raw = Number(cp?.fontSize ?? 0);
    out.fontSize = raw > 0 ? raw / CHAR_HEIGHT_PER_POINT : 0;
    out.bold = Boolean(cp?.bold);
  } catch {
    /* empty paragraphs have no run to ask about */
  }

  return out;
}

// ── rendering ──────────────────────────────────────────────────────────────

// Renderable pieces, in the order the splice loop wants them.
const RENDER_DEFAULTS = Object.freeze({
  tables: true,
  equationOpen: "$",
  equationClose: "$",
  latex: false,
  footnoteBodies: true,
  trimFootnotes: false,
  blockSeparator: "\n",
});

// `$…$` around the normalized HWP script by default. LaTeX is opt-in and, when
// asked for, is used ONLY if the translation was complete — a half-translated
// formula presented as finished is the failure mode eqn.mjs exists to prevent,
// so an incomplete result falls back to the script it could not translate.
function renderEquation(control, o) {
  const script = normalizeEquationScript(control.script);
  let body = script;
  if (o.latex) {
    const r = equationToLatex(script);
    if (r.complete) body = r.latex;
  }
  return `${o.equationOpen}${body}${o.equationClose}`;
}

// A footnote splices in as a marker only; its body is collected and emitted
// after the span, which is where markdown wants it and where it does not
// interrupt the sentence it annotates.
function footnoteMarker(control) {
  return `[^${control.number}]`;
}

function footnoteBody(control, o) {
  // getFootnoteInfo returns the body as an array of paragraph texts, and a
  // freshly inserted footnote's text carries two trailing spaces
  // ("각주 본문입니다.  "). They are preserved by default: they are what the
  // document contains, and a reader diffing extracted text against the file
  // should not have to account for a silent trim. `trimFootnotes` is there for
  // callers who want prose rather than fidelity.
  const raw = (Array.isArray(control.texts) ? control.texts : []).join("\n");
  return o.trimFootnotes ? raw.trim() : raw;
}

// Markdown tables need to start on their own line. `renderTableMarkdown`
// already ends with a newline, so only the leading side needs a separator, and
// only when there is text in front of the control.
function renderTable(entry) {
  const md = renderTableMarkdown(entry, { heading: false });
  return md.endsWith("\n") ? md : md + "\n";
}

function tablePlaceholder(block, control) {
  const d = control.dims ?? {};
  return `[table ${d.rowCount ?? "?"}×${d.colCount ?? "?"}: section ${block.s}, paragraph ${block.p}, control ${control.index}]`;
}

// ── the model ──────────────────────────────────────────────────────────────

// One model per (document, options). Keyed by document so a second
// buildBlocks(doc) in the same process costs zero engine calls, and by options
// inside that so a caller asking for a DIFFERENT walk gets one instead of
// silently receiving a model built to someone else's settings.
const MODEL_CACHE = new WeakMap();

const optionsKey = (o) => `${o.tableMode}|${o.maxDepth}|${o.equations}|${o.footnotes}`;

// Build (or return the cached) block stream for `doc`.
//
// Returns a model:
//   model.blocks              Block[] in document order
//   model.renderSpan(a, b, o) string — inclusive range, controls spliced inline
//   model.controls(i)         full classification of block i's controls (lazy)
//   model.tablesAt(i)         extracted table entries for block i (lazy)
//   model.classifyAll()       force classification everywhere, then return stats
//   model.blockAt(s, p)       the block for a (section, paragraph), or undefined
//   model.stats               live counters — see the note on stats below
//   model.doc                 the raw document (uncounted; see countingProxy)
//
// Async because every other document entry point in this skill is, so callers
// do not have to remember which is which.
export async function buildBlocks(doc, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const key = optionsKey(o);

  let perDoc = MODEL_CACHE.get(doc);
  if (perDoc) {
    const hit = perDoc.get(key);
    if (hit) return hit;
  } else {
    perDoc = new Map();
    MODEL_CACHE.set(doc, perDoc);
  }

  const model = build(doc, o);
  perDoc.set(key, model);
  return model;
}

function build(doc, o) {
  const counter = { calls: 0 };
  const eng = countingProxy(doc, counter);

  // `stats` is ONE object mutated in place, not a snapshot, so a caller can
  // hold onto it across renders and watch the counters move.
  //
  // `tables` is exact after the walk: the cheap table probe runs in pass 1.
  // `equations` and `footnotes` CANNOT be, because knowing them means fully
  // classifying every control in the document, which is the cost this model
  // exists to avoid. They count what has been discovered so far; compare
  // `classifiedBlocks` against `blocks` to know whether that is the whole
  // document, or call `classifyAll()` to make it so.
  const stats = {
    paragraphs: 0,
    blocks: 0,
    tables: 0,
    equations: 0,
    footnotes: 0,
    classifiedBlocks: 0,
  };
  // Live, not a snapshot taken at the end of some function: a lazy `props()`
  // fires whenever its caller decides to, with no hook to sync a copy from. An
  // enumerable getter keeps `JSON.stringify(stats)` honest too.
  Object.defineProperty(stats, "engineCalls", {
    get: () => counter.calls,
    enumerable: true,
  });

  const blocks = [];
  const byLocation = new Map();

  // ── pass 1 ───────────────────────────────────────────────────────────────
  const sectionCount = eng.getSectionCount();
  for (let s = 0; s < sectionCount; s++) {
    const paraCount = eng.getParagraphCount(s);
    for (let p = 0; p < paraCount; p++) {
      const text = paragraphText(eng, s, p);
      const offsets = controlOffsets(eng, s, p);

      // The cheap probe only: one call per control, and controls are rare. Full
      // classification waits for a render.
      const tableIndices = [];
      for (let c = 0; c < offsets.length; c++) {
        if (isTableControl(eng, s, p, c)) tableIndices.push(c);
      }

      const block = {
        s,
        p,
        index: blocks.length,
        text,
        hasTable: tableIndices.length > 0,
        tableIndices,
        props: makeLazyProps(eng, s, p),
      };
      // Not part of the public Block contract — internal caches the model uses
      // and a sibling module must not read.
      Object.defineProperty(block, "_offsets", { value: offsets, enumerable: false });

      blocks.push(block);
      byLocation.set(`${s}/${p}`, block);
      stats.paragraphs++;
      stats.tables += tableIndices.length;
    }
  }
  stats.blocks = blocks.length;

  // ── lazy layers ──────────────────────────────────────────────────────────

  const controlCache = new Map(); // block index → classified controls
  const tableCache = new Map(); // block index → extracted table entries

  function controlsOf(i) {
    if (controlCache.has(i)) return controlCache.get(i);
    const b = blocks[i];
    if (!b) return [];
    const list = b._offsets.map((off, c) => classifyControl(eng, b.s, b.p, c, off));
    controlCache.set(i, list);
    for (const c of list) {
      if (c.kind === "equation") stats.equations++;
      else if (c.kind === "footnote") stats.footnotes++;
    }
    stats.classifiedBlocks++;
    return list;
  }

  function tablesOf(i) {
    if (tableCache.has(i)) return tableCache.get(i);
    const b = blocks[i];
    const list =
      b && b.hasTable
        ? extractTables(eng, {
            onlyAt: { s: b.s, p: b.p },
            noNested: o.maxDepth <= 1,
            maxDepth: o.maxDepth,
          })
        : [];
    tableCache.set(i, list);
    return list;
  }

  // ── rendering ────────────────────────────────────────────────────────────

  function renderSpan(fromIndex, toIndex, spanOpts = {}) {
    const ro = { ...RENDER_DEFAULTS, ...o, ...spanOpts };
    const from = Math.max(0, Math.min(blocks.length - 1, fromIndex | 0));
    const to = Math.max(0, Math.min(blocks.length - 1, toIndex | 0));
    if (blocks.length === 0 || from > to) return "";

    const lines = [];
    const notes = [];

    for (let i = from; i <= to; i++) {
      const block = blocks[i];
      let out = block.text;

      // Only pay for classification when the block has controls at all.
      const parts = [];
      if (block._offsets.length) {
        for (const c of controlsOf(i)) {
          // kind "other" is the SectionDef/ColumnDef pair every section's first
          // paragraph carries, plus pictures, shapes and fields. Rendering them
          // would put a phantom marker at position 0 of every section. They
          // produce NOTHING, silently and on purpose.
          if (c.kind === "other") continue;
          if (c.kind === "table" && !ro.tables) continue;
          if (c.kind === "equation" && !ro.equations) continue;
          if (c.kind === "footnote" && !ro.footnotes) continue;
          parts.push(c);
        }
      }

      // Descending offset, then descending control index. Total, so the result
      // never depends on sort stability — see this file's header.
      parts.sort((a, b) => b.offset - a.offset || b.index - a.index);

      for (const c of parts) {
        let piece;
        if (c.kind === "equation") {
          piece = renderEquation(c, ro);
        } else if (c.kind === "footnote") {
          piece = footnoteMarker(c);
          notes.push({ number: c.number, text: footnoteBody(c, ro) });
        } else {
          if (ro.tableMode === "cells") {
            piece = tablePlaceholder(block, c);
          } else {
            const entry = tablesOf(i).find(
              (t) => t.controlIndex === c.index && t.nestedIn == null,
            );
            piece = entry ? renderTable(entry) : tablePlaceholder(block, c);
          }
        }

        const off = Math.max(0, Math.min(out.length, c.offset ?? 0));
        const before = out.slice(0, off);
        const after = out.slice(off);
        const lead = piece.includes("\n") && before && !before.endsWith("\n") ? "\n" : "";
        out = before + lead + piece + after;
      }

      lines.push(out);
    }

    // Footnote bodies land after the span, in the order their markers appeared.
    let text = lines.join(ro.blockSeparator);
    if (ro.footnoteBodies && notes.length) {
      text += `\n\n${notes.map((n) => `[^${n.number}]: ${n.text}`).join("\n")}`;
    }
    return text;
  }

  return {
    doc,
    blocks,
    stats,
    renderSpan,
    controls: controlsOf,
    tablesAt: tablesOf,
    blockAt: (s, p) => byLocation.get(`${s}/${p}`),
    // Force full classification of every block. The only honest way to get
    // document-wide equation/footnote counts, and it says what it costs by
    // moving `engineCalls`.
    classifyAll() {
      for (let i = 0; i < blocks.length; i++) controlsOf(i);
      return stats;
    },
  };
}

// A block's props() is one memoized read of three engine calls. Callers
// typically inspect 5-10% of a document's blocks, so paying for the rest up
// front is the difference between a snappy pass and a sluggish one.
function makeLazyProps(eng, s, p) {
  let cached = null;
  return () => (cached ??= Object.freeze(readProps(eng, s, p)));
}

export { DEFAULTS as BLOCK_DEFAULTS, RENDER_DEFAULTS };
