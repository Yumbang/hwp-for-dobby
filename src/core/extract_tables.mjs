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
// Engine notes (verified on rhwp v0.7.15, see spec/rhwp-behavior.md §1):
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
import { EXIT, fail } from "../lib/exit-codes.mjs";

// Option helpers that fail loudly: a flag given without a value (or with
// another flag accidentally consumed as its value) is a usage error, not a
// silent default — silently mis-parsed options here mean silently wrong or
// missing table data downstream.
function strArg(name, dflt) {
  const i = process.argv.indexOf(name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith("--")) {
    fail(EXIT.USAGE, `error: ${name} requires a value`);
  }
  return v;
}
function intArg(name, dflt) {
  const i = process.argv.indexOf(name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  const n = v !== undefined && !v.startsWith("--") ? Number.parseInt(v, 10) : NaN;
  if (!Number.isInteger(n) || n < 0 || String(n) !== v.trim()) {
    fail(
      EXIT.USAGE,
      `error: ${name} requires a non-negative integer (got ${v === undefined ? "nothing" : JSON.stringify(v)})`,
    );
  }
  return n;
}
function flag(name) {
  return process.argv.includes(name);
}

const input = process.argv[2];
if (!input || input.startsWith("--")) {
  fail(
    EXIT.USAGE,
    "usage: extract_tables.mjs <input.hwp|.hwpx> [--format json|markdown] [--table N] [--fill-merged] [--no-nested] [--max-depth N] [--data-tables-only] [--drop-empty] [--detect-form-type]",
  );
}
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

// Per cell paragraph, how many control indices to probe for nested tables.
// There is no API that counts controls inside a cell paragraph, so this is
// a bounded guess; 8 is far beyond anything observed in real documents
// (spec rule 3: NESTED_PROBE_MAX is the engine's hardcoded ceiling — tables
// behind control index >= 8 in a cell paragraph are not discoverable).
const NESTED_PROBE_MAX = 8;

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

// ── accessor shims ──────────────────────────────────────────────────────
// A table location is {s, p, steps} where steps is a non-empty array of
// {controlIndex, cellIndex, cellParaIndex} path entries; the LAST entry's
// controlIndex addresses the table itself (its cellIndex/cellParaIndex are
// ignored there but the engine's path parser requires all three keys on
// every entry). Top-level tables (steps.length === 1) use the plain APIs,
// nested ones the *ByPath APIs.

const isFlat = (loc) => loc.steps.length === 1;
const flatCtrl = (loc) => loc.steps[0].controlIndex;

function cellPathJson(loc, cellIdx, cellParaIdx = 0) {
  const steps = loc.steps.slice(0, -1);
  const last = loc.steps[loc.steps.length - 1];
  steps.push({ controlIndex: last.controlIndex, cellIndex: cellIdx, cellParaIndex: cellParaIdx });
  return JSON.stringify(steps);
}

function tableDims(loc) {
  const j = isFlat(loc)
    ? doc.getTableDimensions(loc.s, loc.p, flatCtrl(loc))
    : doc.getTableDimensionsByPath(loc.s, loc.p, JSON.stringify(loc.steps));
  return JSON.parse(j);
}
function cellInfo(loc, k) {
  const j = isFlat(loc)
    ? doc.getCellInfo(loc.s, loc.p, flatCtrl(loc), k)
    : doc.getCellInfoByPath(loc.s, loc.p, cellPathJson(loc, k));
  return JSON.parse(j); // {row, col, rowSpan, colSpan}
}
function cellParaCount(loc, k) {
  return isFlat(loc)
    ? doc.getCellParagraphCount(loc.s, loc.p, flatCtrl(loc), k)
    : doc.getCellParagraphCountByPath(loc.s, loc.p, cellPathJson(loc, k));
}
function cellParaLen(loc, k, cp) {
  return isFlat(loc)
    ? doc.getCellParagraphLength(loc.s, loc.p, flatCtrl(loc), k, cp)
    : doc.getCellParagraphLengthByPath(loc.s, loc.p, cellPathJson(loc, k, cp));
}
function cellParaText(loc, k, cp, len) {
  return isFlat(loc)
    ? doc.getTextInCell(loc.s, loc.p, flatCtrl(loc), k, cp, 0, len)
    : doc.getTextInCellByPath(loc.s, loc.p, cellPathJson(loc, k, cp), 0, len);
}

function readCellText(loc, k) {
  // A cell holds one or more inner paragraphs; there is no whole-cell text
  // getter, so read each paragraph and join with newline.
  let n = 0;
  try {
    n = cellParaCount(loc, k);
  } catch {
    return "";
  }
  const parts = [];
  for (let cp = 0; cp < n; cp++) {
    let len = 0;
    try {
      len = cellParaLen(loc, k, cp);
    } catch {
      len = 0;
    }
    parts.push(len > 0 ? cellParaText(loc, k, cp, len) : "");
  }
  return parts.join("\n").normalize("NFC");
}

// ── extraction ──────────────────────────────────────────────────────────

const tables = []; // output entries, discovery order (parents before children)

function extractTable(loc, nestedIn, hostCell, depth) {
  const index = tables.length;
  let dim;
  try {
    dim = tableDims(loc);
  } catch (e) {
    return -1; // not a table / vanished — caller probed speculatively
  }
  const entry = {
    index,
    section: loc.s,
    paragraph: loc.p,
    ...(isFlat(loc) ? { controlIndex: flatCtrl(loc) } : { nestedIn, hostCell }),
    rowCount: dim.rowCount,
    colCount: dim.colCount,
    cellCount: dim.cellCount,
    grid: null,
  };
  tables.push(entry);

  // 1. read every stored cell (origins only — covered positions have none)
  const cells = [];
  for (let k = 0; k < dim.cellCount; k++) {
    let info;
    try {
      info = cellInfo(loc, k);
    } catch {
      break; // defensive: malformed table — keep what we have
    }
    cells.push({ k, ...info, text: readCellText(loc, k), nestedTables: [] });
  }

  // 2. discover nested tables per cell paragraph (parents-first order)
  if (!noNested && depth < maxDepth) {
    for (const c of cells) {
      let nPara = 0;
      try {
        nPara = cellParaCount(loc, c.k);
      } catch {
        nPara = 0;
      }
      for (let cp = 0; cp < nPara; cp++) {
        for (let j = 0; j < NESTED_PROBE_MAX; j++) {
          const steps = loc.steps.slice(0, -1);
          const last = loc.steps[loc.steps.length - 1];
          steps.push({ controlIndex: last.controlIndex, cellIndex: c.k, cellParaIndex: cp });
          steps.push({ controlIndex: j, cellIndex: 0, cellParaIndex: 0 });
          const childIdx = extractTable(
            { s: loc.s, p: loc.p, steps },
            index,
            { row: c.row, col: c.col },
            depth + 1,
          );
          if (childIdx >= 0) c.nestedTables.push(childIdx);
        }
      }
    }
  }

  // 3. rebuild the R x C grid from cell addresses + span footprints
  const grid = Array.from({ length: dim.rowCount }, () => Array(dim.colCount).fill(null));
  for (const c of cells) {
    // --drop-empty normalizes placeholder/whitespace cell text to "".
    const cellText = dropEmpty ? normalizePlaceholder(c.text) : c.text;
    for (let dr = 0; dr < c.rowSpan; dr++) {
      for (let dc = 0; dc < c.colSpan; dc++) {
        const rr = c.row + dr;
        const cc = c.col + dc;
        if (rr >= dim.rowCount || cc >= dim.colCount) continue; // clamp malformed spans
        if (dr === 0 && dc === 0) {
          grid[rr][cc] = {
            text: cellText,
            rowSpan: c.rowSpan,
            colSpan: c.colSpan,
            origin: true,
            ...(c.nestedTables.length ? { nestedTables: c.nestedTables } : {}),
          };
        } else {
          grid[rr][cc] = {
            text: fillMerged ? cellText : "",
            origin: false,
            originRow: c.row,
            originCol: c.col,
          };
        }
      }
    }
  }
  entry.grid = grid;

  // 4. annotate form type (spec rule 5) — pure annotation, grid unchanged.
  if (detectFormType) {
    entry.formType = detectTableFormType(grid, dim.rowCount, dim.colCount);
  }
  return index;
}

// flat scan over every paragraph's controls
for (let s = 0; s < doc.getSectionCount(); s++) {
  for (let p = 0; p < doc.getParagraphCount(s); p++) {
    let ctrlN = 0;
    try {
      ctrlN = JSON.parse(doc.getControlTextPositions(s, p)).length;
    } catch {
      ctrlN = 0;
    }
    // probe EVERY index: tables can sit behind non-table controls, and one
    // paragraph can host several tables
    for (let c = 0; c < ctrlN; c++) {
      extractTable({ s, p, steps: [{ controlIndex: c, cellIndex: 0, cellParaIndex: 0 }] }, null, null, 0);
    }
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
  // markdown
  const esc = (t) => String(t).replace(/\|/g, "\\|").replace(/\n/g, "<br>");
  if (!selected.length) process.stdout.write("(no tables)\n");
  for (const t of selected) {
    const where =
      t.nestedIn !== undefined && t.nestedIn !== null
        ? `nested in table ${t.nestedIn}, cell [${t.hostCell.row},${t.hostCell.col}]`
        : `section ${t.section}, paragraph ${t.paragraph}`;
    const ft = t.formType ? ` [${t.formType}]` : "";
    process.stdout.write(`### Table ${t.index} — ${t.rowCount}×${t.colCount} (${where})${ft}\n\n`);
    // A 1-row table would otherwise render its only data row as a markdown
    // header; give it an empty header instead so the row stays a body row.
    if (t.rowCount === 1) {
      process.stdout.write(`|${"   |".repeat(t.colCount)}\n`);
      process.stdout.write(`|${" --- |".repeat(t.colCount)}\n`);
    }
    for (let r = 0; r < t.rowCount; r++) {
      const cellsMd = [];
      for (let c = 0; c < t.colCount; c++) {
        const cell = t.grid[r][c];
        let txt = cell ? esc(cell.text) : "";
        if (cell && cell.origin && cell.nestedTables) {
          txt += cell.nestedTables.map((n) => ` [nested table #${n}]`).join("");
        }
        cellsMd.push(txt);
      }
      process.stdout.write(`| ${cellsMd.join(" | ")} |\n`);
      if (r === 0 && t.rowCount > 1) process.stdout.write(`|${" --- |".repeat(t.colCount)}\n`);
    }
    process.stdout.write("\n");
  }
}
