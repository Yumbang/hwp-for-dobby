#!/usr/bin/env node
// Usage:
//   node src/core/extract_tables.mjs <input.hwp|.hwpx> [--format json|markdown] \
//     [--table N] [--fill-merged] [--no-nested] [--max-depth N] \
//     [--data-tables-only] [--drop-empty] [--detect-form-type]
//
// Structured table extraction with cell addresses and merge info. This is
// the safe way to read table DATA out of a document — unlike text/markdown
// extraction it can never glue a merged cell's text onto the wrong record,
// because every cell is placed by its (row, col) address and its
// rowSpan/colSpan footprint is reported explicitly.
//
// Why this script exists: a merged cell (e.g. a student name spanning 7
// rows in a Korean government form) is stored ONCE, at its origin cell.
// Flattened text extraction emits it once, in document order, where it
// visually glues onto whichever cell happens to serialize next — silently
// corrupting any record-oriented reading of the table. See "Structured
// table extraction" in SKILL.md.
//
// CORE TIER (WASM-only): this script runs identically on claude.ai / cowork
// / code and never shells out to the rhwp CLI. The WASM engine parses both
// .hwp and .hwpx into the same IR; this script walks the IR via the
// structured cell APIs (getTableDimensions / getCellInfo / getTextInCell and
// their *ByPath variants for nested tables). No CLI binary is required.
//
// Output (--format json, default): pretty-printed JSON
//   {
//     input, sourceFormat, tableCount,
//     tables: [{
//       index,                     // discovery order; parents before children
//       section, paragraph,        // location of the hosting paragraph
//       controlIndex,              // top-level tables only
//       nestedIn, hostCell,        // nested tables only: parent table index
//                                  //   and {row, col} of the hosting cell
//       rowCount, colCount, cellCount,
//       formType,                  // with --detect-form-type only:
//                                  //   'marker' | 'label' | 'plain'
//       grid                       // rowCount x colCount; each position is
//                                  //   {text, rowSpan, colSpan, origin: true,
//                                  //    nestedTables?: [idx...]}        (origin)
//                                  //   {text, origin: false, originRow, originCol}
//                                  //                                    (covered)
//                                  //   or null (no cell stored there)
//     }]
//   }
// Covered positions carry text only with --fill-merged (origin text is
// replicated into every position of its span footprint — convenient for
// row-wise record grouping). Without it their text is "".
//
// --format markdown renders each grid as a markdown table (pipes escaped,
// in-cell newlines become <br>). Nested tables render as separate tables;
// the hosting cell is annotated with [nested table #N].
//
// --table N limits output to that table (by `index`) plus its transitive
//   nested descendants, so nestedTables references never dangle.
// --no-nested skips nested-table discovery (faster on huge documents).
// --max-depth N caps nesting recursion (default 3).
//
// Korean-form heuristics (SPEC rules 4/5/6 — all agent-side; the engine does
// not distinguish data from legend, marker from label, or placeholder from
// value):
// --data-tables-only  drops legend / 작성요령 tables (spec rule 4). A table is
//   KEPT when its header row carries a data keyword (연번/학위과정/성명/
//   발표형식/순번/번호) or otherwise looks tabular; it is DROPPED only when its
//   first row clearly reads as a 범례/작성요령/구분 legend (starts with
//   구분/작성요령 AND lacks 연번). Conservative by design: when uncertain, KEEP.
//   A stderr note is emitted for every dropped table.
// --drop-empty        normalizes placeholder cell text to "" (spec rule 6):
//   '-', 'X', ';N', 'N', '번호', '해당없음', 'N/A', 'DOI 번호' and
//   whitespace-only become empty. Applies to the emitted grid text.
// --detect-form-type  annotates each table with a `formType` field (spec
//   rule 5): 'marker' if detail cells start with circled digits ①~⑩,
//   'label' if cells match `라벨: 값` / `라벨：값`, else 'plain'. The grid is
//   NOT restructured — this is a pure annotation.
//
// All cell text is NFC-normalized. Exit codes (lib/exit-codes.mjs): 0 OK
// (even with zero tables — check tableCount), 1 LOAD (load/extraction
// failure), 2 USAGE (bad arguments), 3 NOT_FOUND (--table index absent).
//
// Engine notes (verified on the pinned rhwp v0.7.19, see spec/rhwp-behavior.md §1):
// - A paragraph's control list mixes tables with images/shapes/section
//   defs, and one paragraph can host SEVERAL tables, so every control
//   index is probed (getControlTextPositions supplies the control count;
//   getTableDimensions throws on non-tables).
// - cellCount counts ORIGIN cells only, so cellCount < rowCount*colCount
//   when merges exist: covered positions simply have no stored cell. The
//   grid is rebuilt from {row,col}+span (NO 'cellAddr' field — getCellInfo
//   returns {row, col, rowSpan, colSpan}).
// - Nested tables are invisible to the flat scan; they are discovered by
//   probing each cell paragraph's control indices via the *ByPath APIs
//   (no control-count API exists for cell paragraphs, so indices
//   0..NESTED_PROBE_MAX-1 are tried — tables beyond that are missed,
//   which no real-world sample comes near).
// - Full-width spaces surface as U+2007 FIGURE SPACE, not U+3000.

import { loadDocument } from "../lib/_bootstrap.mjs";
// Strict option helpers (a flag given without a value is a USAGE error, not a
// silent default) now live in lib/argv.mjs — this file was where they were
// written, and every other script needed them too.
import { flag, inputPath, intArg, strArg } from "../lib/argv.mjs";
import { EXIT, fail } from "../lib/exit-codes.mjs";
import { renderTableMarkdown } from "../lib/render_md.mjs";
import { extractTables } from "../lib/tables.mjs";

const input = inputPath(
  "usage: extract_tables.mjs <input.hwp|.hwpx> [--format json|markdown] [--table N] [--fill-merged] [--no-nested] [--max-depth N] [--data-tables-only] [--drop-empty] [--detect-form-type]",
);
const format = strArg("--format", "json");
if (format !== "json" && format !== "markdown") {
  fail(EXIT.USAGE, `unknown --format: ${format} (expected json|markdown)`);
}
const onlyTable = intArg("--table", null);
const fillMerged = flag("--fill-merged");
const noNested = flag("--no-nested");
const maxDepth = intArg("--max-depth", 3);
const dataTablesOnly = flag("--data-tables-only");
const dropEmpty = flag("--drop-empty");
const detectFormType = flag("--detect-form-type");

let doc;
try {
  doc = await loadDocument(input);
} catch (e) {
  fail(EXIT.LOAD, `error: cannot read ${input}: ${e?.message ?? e}`);
}

// ── Korean-form heuristics (agent-side; spec rules 4/5/6) ────────────────
// Circled digits ①(U+2460)..⑩(U+2469) — the markers used by 마커형 forms.
const CIRCLED_DIGIT_RE = /^[①-⑳]/;
// 라벨: 값 / 라벨：값 — half-width or full-width colon, label may contain
// spaces ('학술대회 논문 제목: ...'). Anchored, non-greedy label so a value
// that itself contains a colon doesn't swallow the label.
const LABEL_VALUE_RE = /^[^\n:：]{1,30}[:：]\s*\S/;

// Header-row data keywords (spec rule 4 / postmortem §1.5, §3 step 5). Their
// presence as a column header marks a genuine data table.
const DATA_HEADER_KEYWORDS = [
  "연번",
  "학위과정",
  "성명",
  "발표형식",
  "순번",
  "번호",
];
// Legend / instruction first-row openers (spec rule 4 / postmortem §1.5).
const LEGEND_OPENERS = ["구분", "작성요령"];

// Placeholder strings normalized to "" by --drop-empty (spec rule 6 /
// postmortem §3 step 9). Compared NFC + trimmed.
const PLACEHOLDERS = new Set([
  "-",
  "X",
  ";N",
  "N",
  "번호",
  "해당없음",
  "N/A",
  "DOI 번호",
]);

// Treat a placeholder / whitespace-only cell as empty for grid output.
function normalizePlaceholder(text) {
  const t = String(text ?? "").trim();
  if (t === "") return "";
  return PLACEHOLDERS.has(t) ? "" : text;
}

// Classify a table by its header row (spec rule 4). Returns true to KEEP.
// Conservative: only the unambiguous 범례/작성요령 legend shape is dropped;
// everything else (including tables we cannot read a header for) is kept so
// data is never silently lost.
function isDataTable(grid, rowCount, colCount) {
  if (!rowCount || !colCount) return true; // nothing to judge → keep
  // Collect first-row header texts (origin cells only — covered cells carry
  // no own text unless --fill-merged, which would just duplicate origins).
  const header = [];
  for (let c = 0; c < colCount; c++) {
    const cell = grid[0][c];
    if (cell && cell.origin) header.push(String(cell.text ?? "").trim());
  }
  const headerJoined = header.join(" ");
  const hasDataKeyword = DATA_HEADER_KEYWORDS.some((kw) => headerJoined.includes(kw));
  if (hasDataKeyword) return true; // explicit data header → keep
  const first = header[0] ?? "";
  const startsLegend = LEGEND_OPENERS.some((o) => first.startsWith(o));
  const hasYeonbeon = headerJoined.includes("연번");
  // Drop only the clear legend shape: opens with 구분/작성요령 AND no 연번.
  if (startsLegend && !hasYeonbeon) return false;
  return true; // uncertain → KEEP (never silently drop data)
}

// Detect the form variant (spec rule 5) by scanning detail cells. Returns
// 'marker' if any detail cell starts with a circled digit, else 'label' if
// any detail cell matches the 라벨:값 pattern, else 'plain'. Detail cells =
// the last column's body cells (postmortem §3: detail is the last column);
// to stay robust we scan every origin cell below the header row.
function detectTableFormType(grid, rowCount, colCount) {
  if (rowCount <= 1) return "plain";
  let sawMarker = false;
  let sawLabel = false;
  for (let r = 1; r < rowCount; r++) {
    for (let c = 0; c < colCount; c++) {
      const cell = grid[r][c];
      if (!cell || !cell.origin) continue;
      // Per-paragraph scan: a multi-line cell's first line carries the
      // marker/label, and a marker form may stack several ①/② lines.
      for (const line of String(cell.text ?? "").split("\n")) {
        const s = line.trim();
        if (!s) continue;
        if (CIRCLED_DIGIT_RE.test(s)) sawMarker = true;
        else if (LABEL_VALUE_RE.test(s)) sawLabel = true;
      }
    }
  }
  if (sawMarker) return "marker"; // marker wins — circled digits are decisive
  if (sawLabel) return "label";
  return "plain";
}

// ── extraction ──────────────────────────────────────────────────────────
// Addressing ({s,p,steps}), the accessor shims, cell reading, nested-table
// discovery and the merge-origin grid rebuild all live in lib/tables.mjs now,
// shared with the section extractor so there is exactly one implementation of
// spec rules 1-3.

const tables = extractTables(doc, {
  noNested,
  maxDepth,
  fillMerged,
  // --drop-empty normalizes placeholder/whitespace cell text to "".
  mapText: dropEmpty ? normalizePlaceholder : undefined,
});

// Annotate form type (spec rule 5) — pure annotation, grid unchanged.
if (detectFormType) {
  for (const t of tables) {
    t.formType = detectTableFormType(t.grid, t.rowCount, t.colCount);
  }
}

// ── data-tables-only filter (spec rule 4) ────────────────────────────────
// Drop legend / 작성요령 tables, but keep their nested descendants attached
// to a surviving parent. We never drop a table that is nested inside a kept
// table (the parent's grid references it). Conservative: only top-level
// tables whose header row reads as a legend are dropped, with a stderr note.
const dropped = new Set();
if (dataTablesOnly) {
  for (const t of tables) {
    // Only judge top-level tables — nested tables are content of a cell and
    // are governed by their parent's keep/drop decision.
    const isTopLevel = t.nestedIn == null;
    if (!isTopLevel) continue;
    if (!isDataTable(t.grid, t.rowCount, t.colCount)) {
      dropped.add(t.index);
      const header = (t.grid[0] || [])
        .filter((c) => c && c.origin)
        .map((c) => String(c.text ?? "").trim())
        .join(" | ");
      process.stderr.write(
        `note: dropping table ${t.index} (section ${t.section}, paragraph ${t.paragraph}) ` +
          `as legend/instruction — header: ${header || "(empty)"}\n`,
      );
    }
  }
  // Cascade: drop nested descendants of any dropped table so their grid
  // references don't dangle.
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of tables) {
      if (t.nestedIn != null && dropped.has(t.nestedIn) && !dropped.has(t.index)) {
        dropped.add(t.index);
        grew = true;
      }
    }
  }
}

// ── output ──────────────────────────────────────────────────────────────

let selected = tables.filter((t) => !dropped.has(t.index));
if (onlyTable !== null) {
  if (!tables.some((t) => t.index === onlyTable)) {
    fail(EXIT.NOT_FOUND, `no table with index ${onlyTable} (document has ${tables.length})`);
  }
  if (dropped.has(onlyTable)) {
    fail(
      EXIT.NOT_FOUND,
      `table ${onlyTable} was dropped by --data-tables-only (legend/instruction)`,
    );
  }
  // Include the selected table AND its transitive nested descendants, so a
  // grid's nestedTables references never dangle in the output.
  const keep = new Set([onlyTable]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of tables) {
      if (t.nestedIn != null && keep.has(t.nestedIn) && !keep.has(t.index)) {
        keep.add(t.index);
        grew = true;
      }
    }
  }
  selected = tables.filter((t) => keep.has(t.index) && !dropped.has(t.index));
}

if (format === "json") {
  const out = {
    input,
    sourceFormat: doc.getSourceFormat(),
    tableCount: selected.length,
    tables: selected,
  };
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
} else {
  // markdown — rendering lives in lib/render_md.mjs so the section extractor
  // can splice the same grid inline instead of a placeholder.
  if (!selected.length) process.stdout.write("(no tables)\n");
  for (const t of selected) {
    process.stdout.write(renderTableMarkdown(t) + "\n");
  }
}
