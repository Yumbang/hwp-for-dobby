#!/usr/bin/env node
// Usage:
//   node scripts/extract_tables.mjs <input.hwp|.hwpx> [--format json|markdown] \
//     [--table N] [--fill-merged] [--no-nested] [--max-depth N]
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
// Works for both .hwp and .hwpx with no CLI binary: the WASM engine parses
// both formats into the same IR and this script walks the IR via the
// structured cell APIs (getTableDimensions / getCellInfo / getTextInCell
// and their *ByPath variants for nested tables).
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
// All cell text is NFC-normalized. Exit codes: 0 success (even with zero
// tables — check tableCount), 1 load/extraction failure, 2 usage.
//
// KNOWN ENGINE LIMITATION (vendored rhwp v0.7.10): the HWPX parser drops
// XML entities — literal `&`, `<`, `>` in HWPX cell text vanish ("R&D"
// reads as "RD"). The same document's .hwp twin reads correctly. Fixed
// upstream in rhwp v0.7.12 (commit 469d80d4); resolved here whenever the
// vendored bundle is rebuilt to >= v0.7.12. Full-width spaces (hp:fwSpace)
// surface as U+2007 FIGURE SPACE, not U+3000 — engine IR convention.
//
// Engine notes (verified on rhwp v0.7.10):
// - A paragraph's control list mixes tables with images/shapes/section
//   defs, and one paragraph can host SEVERAL tables, so every control
//   index is probed (getControlTextPositions supplies the control count;
//   getTableDimensions throws on non-tables).
// - cellCount < rowCount*colCount when merges exist: covered positions
//   simply have no stored cell. The grid is rebuilt from cellAddr+span.
// - Nested tables are invisible to the flat scan; they are discovered by
//   probing each cell paragraph's control indices via the *ByPath APIs
//   (no control-count API exists for cell paragraphs, so indices
//   0..NESTED_PROBE_MAX-1 are tried — tables beyond that are missed,
//   which no real-world sample comes near).

import { loadDocument } from "./_bootstrap.mjs";

// Option helpers that fail loudly: a flag given without a value (or with
// another flag accidentally consumed as its value) is a usage error, not a
// silent default — silently mis-parsed options here mean silently wrong or
// missing table data downstream.
function strArg(name, dflt) {
  const i = process.argv.indexOf(name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith("--")) {
    console.error(`error: ${name} requires a value`);
    process.exit(2);
  }
  return v;
}
function intArg(name, dflt) {
  const i = process.argv.indexOf(name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  const n = v !== undefined && !v.startsWith("--") ? Number.parseInt(v, 10) : NaN;
  if (!Number.isInteger(n) || n < 0 || String(n) !== v.trim()) {
    console.error(
      `error: ${name} requires a non-negative integer (got ${v === undefined ? "nothing" : JSON.stringify(v)})`,
    );
    process.exit(2);
  }
  return n;
}
function flag(name) {
  return process.argv.includes(name);
}

const input = process.argv[2];
if (!input || input.startsWith("--")) {
  console.error(
    "usage: extract_tables.mjs <input.hwp|.hwpx> [--format json|markdown] [--table N] [--fill-merged] [--no-nested] [--max-depth N]",
  );
  process.exit(2);
}
const format = strArg("--format", "json");
if (format !== "json" && format !== "markdown") {
  console.error(`unknown --format: ${format} (expected json|markdown)`);
  process.exit(2);
}
const onlyTable = intArg("--table", null);
const fillMerged = flag("--fill-merged");
const noNested = flag("--no-nested");
const maxDepth = intArg("--max-depth", 3);

// Per cell paragraph, how many control indices to probe for nested tables.
// There is no API that counts controls inside a cell paragraph, so this is
// a bounded guess; 8 is far beyond anything observed in real documents.
const NESTED_PROBE_MAX = 8;

let doc;
try {
  doc = await loadDocument(input);
} catch (e) {
  console.error(`error: cannot read ${input}: ${e?.message ?? e}`);
  process.exit(1);
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
    for (let dr = 0; dr < c.rowSpan; dr++) {
      for (let dc = 0; dc < c.colSpan; dc++) {
        const rr = c.row + dr;
        const cc = c.col + dc;
        if (rr >= dim.rowCount || cc >= dim.colCount) continue; // clamp malformed spans
        if (dr === 0 && dc === 0) {
          grid[rr][cc] = {
            text: c.text,
            rowSpan: c.rowSpan,
            colSpan: c.colSpan,
            origin: true,
            ...(c.nestedTables.length ? { nestedTables: c.nestedTables } : {}),
          };
        } else {
          grid[rr][cc] = {
            text: fillMerged ? c.text : "",
            origin: false,
            originRow: c.row,
            originCol: c.col,
          };
        }
      }
    }
  }
  entry.grid = grid;
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

// ── output ──────────────────────────────────────────────────────────────

let selected = tables;
if (onlyTable !== null) {
  if (!tables.some((t) => t.index === onlyTable)) {
    console.error(`no table with index ${onlyTable} (document has ${tables.length})`);
    process.exit(1);
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
  selected = tables.filter((t) => keep.has(t.index));
}

if (format === "json") {
  const out = {
    input,
    sourceFormat: doc.getSourceFormat(),
    tableCount: tables.length,
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
    process.stdout.write(`### Table ${t.index} — ${t.rowCount}×${t.colCount} (${where})\n\n`);
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
