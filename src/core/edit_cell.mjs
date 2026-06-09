#!/usr/bin/env node
// Usage:
//   node src/core/edit_cell.mjs <input> --op insert|delete|set \
//     --section N --paragraph N --control N \
//     (--cell N | --row R --col C) [--cell-para N] [--offset N] \
//     [--text "..."] [--count N] --output <out.hwp>
//
// Edits the text of a single table cell and saves the result as .hwp.
//
//   --op insert  : insert --text at --offset (default 0) in the cell paragraph.
//   --op delete  : delete --count chars at --offset in the cell paragraph.
//   --op set     : replace the WHOLE cell paragraph with --text (delete current
//                  length via getCellParagraphLength, then insert at 0).
//
// A cell is addressed EITHER by its linear --cell index, OR by --row/--col.
// row/col are mapped to a cell index by scanning getCellInfo over the origin
// cells [0, cellCount) for the one whose {row,col} matches (spec rule 1 —
// merge-origin storage; covered positions have NO cell). If --row/--col names
// a covered (merged-away) position, we fail with NOT_FOUND and a hint that it
// belongs to a merge origin elsewhere.
//
// Why the cell-edit primitives (not replaceAll): on a genuine .hwp, replaceAll
// silently drops edits because it doesn't null section.raw_stream (spec rule
// 9). insertTextInCell / deleteTextInCell DO null it, so cell edits survive
// the save→reload round-trip (spec rule 14). exportVerify confirms that.
//
// Bounds: the engine THROWS (surfaces as undefined → JSON.parse failure, a
// Rust panic) when cell_idx >= cellCount, and the boundary is cellCount, NOT
// rowCount*colCount (spec rule 15). So we validate cell_idx ∈ [0, cellCount)
// BEFORE calling any cell API and return a clean NOT_FOUND instead of a throw.
//
// CORE-TIER: WASM-only. No rhwp CLI. Output is always .hwp (exportVerify →
// assertHwpOutput blocks .hwpx). A verified:false result is a hard failure
// (EXIT.CORRUPTION) — a dropped edit is never reported as success.

import { loadDocument } from "../lib/_bootstrap.mjs";
import { EXIT, fail } from "../lib/exit-codes.mjs";
import { exportVerify } from "../lib/verify.mjs";

const USAGE =
  "usage: edit_cell.mjs <input> --op insert|delete|set --section N --paragraph N --control N\n" +
  "       (--cell N | --row R --col C) [--cell-para N] [--offset N] [--text \"...\"] [--count N] --output <out.hwp>";

// Minimal option parsing in the style of the other core/ scripts: one
// positional input path plus named --flags. Numbers are validated as we go.
function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// Parse a required non-negative integer flag; fail(USAGE) if missing/invalid.
function intArg(name, { required = false, dflt = undefined } = {}) {
  const raw = arg(name);
  if (raw === undefined) {
    if (required) fail(EXIT.USAGE, `error: missing ${name}\n${USAGE}`);
    return dflt;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    fail(EXIT.USAGE, `error: ${name} must be a non-negative integer (got ${JSON.stringify(raw)})\n${USAGE}`);
  }
  return n;
}

const inputPath = process.argv[2];
if (!inputPath || inputPath.startsWith("-")) {
  fail(EXIT.USAGE, USAGE);
}

const op = arg("--op");
if (!op || !["insert", "delete", "set"].includes(op)) {
  fail(EXIT.USAGE, `error: --op must be insert|delete|set\n${USAGE}`);
}

const section = intArg("--section", { required: true });
const paragraph = intArg("--paragraph", { required: true });
const control = intArg("--control", { required: true });
const cellPara = intArg("--cell-para", { dflt: 0 });
const offset = intArg("--offset", { dflt: 0 });

// Cell addressing: exactly one of --cell OR (--row AND --col).
const cellRaw = arg("--cell");
const rowRaw = arg("--row");
const colRaw = arg("--col");
const byLinear = cellRaw !== undefined;
const byRowCol = rowRaw !== undefined || colRaw !== undefined;
if (byLinear && byRowCol) {
  fail(EXIT.USAGE, `error: use either --cell OR --row/--col, not both\n${USAGE}`);
}
if (!byLinear && !byRowCol) {
  fail(EXIT.USAGE, `error: address the cell with --cell N or --row R --col C\n${USAGE}`);
}
let wantCell = byLinear ? intArg("--cell", { required: true }) : null;
const wantRow = byRowCol ? intArg("--row", { required: true }) : null;
const wantCol = byRowCol ? intArg("--col", { required: true }) : null;

const text = arg("--text");
const count = arg("--count") !== undefined ? intArg("--count", { required: true }) : undefined;
const output = arg("--output");

if (!output) fail(EXIT.USAGE, `error: missing --output\n${USAGE}`);

// Per-op argument requirements.
if ((op === "insert" || op === "set") && (text === undefined || text === "")) {
  fail(EXIT.USAGE, `error: --op ${op} requires non-empty --text\n${USAGE}`);
}
if (op === "delete" && (count === undefined || count <= 0)) {
  fail(EXIT.USAGE, `error: --op delete requires --count > 0\n${USAGE}`);
}

let doc;
try {
  doc = await loadDocument(inputPath);
} catch (e) {
  fail(EXIT.LOAD, `error: could not load ${inputPath}: ${e?.message ?? e}`);
}

// Read the table's origin-cell count up front. getTableDimensions throws on a
// non-table control; translate that into a clean NOT_FOUND rather than a stack
// trace, so a wrong --control/--section/--paragraph is a graceful error.
let dims;
try {
  dims = JSON.parse(doc.getTableDimensions(section, paragraph, control));
} catch (e) {
  fail(
    EXIT.NOT_FOUND,
    `error: no table at section ${section}, paragraph ${paragraph}, control ${control} ` +
      `(${e?.message ?? e}). Run extract_tables.mjs to find the right address.`,
  );
}
const cellCount = dims.cellCount;

// Resolve --row/--col to a linear cell index by scanning the origin cells.
// Spec rule 1: text lives only on the top-left origin of a merge; a covered
// position has no cell, so a match miss there means "merged-away".
if (byRowCol) {
  let found = null;
  let coveringOrigin = null;
  for (let c = 0; c < cellCount; c++) {
    const ci = JSON.parse(doc.getCellInfo(section, paragraph, control, c));
    if (ci.row === wantRow && ci.col === wantCol) {
      found = c;
      break;
    }
    // Track whether (wantRow,wantCol) falls inside this origin's merge span,
    // so we can point the user at the origin cell that actually holds it.
    if (
      wantRow >= ci.row &&
      wantRow < ci.row + ci.rowSpan &&
      wantCol >= ci.col &&
      wantCol < ci.col + ci.colSpan
    ) {
      coveringOrigin = { cellIdx: c, ...ci };
    }
  }
  if (found === null) {
    if (coveringOrigin) {
      fail(
        EXIT.NOT_FOUND,
        `error: cell (row ${wantRow}, col ${wantCol}) is merged away — it is covered by the ` +
          `origin cell at (row ${coveringOrigin.row}, col ${coveringOrigin.col}) ` +
          `[--cell ${coveringOrigin.cellIdx}, rowSpan ${coveringOrigin.rowSpan}, colSpan ${coveringOrigin.colSpan}]. ` +
          `Edit that origin cell instead.`,
      );
    }
    fail(
      EXIT.NOT_FOUND,
      `error: no cell at (row ${wantRow}, col ${wantCol}) in table ` +
        `(${section},${paragraph},${control}) — grid is ${dims.rowCount}×${dims.colCount}.`,
    );
  }
  wantCell = found;
}

// Bounds gate (spec rule 15): the engine throws (→ undefined → JSON.parse
// failure) for cell_idx >= cellCount, and the boundary is cellCount, not
// rowCount*colCount. Validate BEFORE any cell call so we return a clean error.
if (wantCell < 0 || wantCell >= cellCount) {
  fail(
    EXIT.NOT_FOUND,
    `error: cell index ${wantCell} out of range — table (${section},${paragraph},${control}) ` +
      `has ${cellCount} origin cells (valid 0..${cellCount - 1}). ` +
      `Note: the limit is cellCount, not rowCount×colCount (${dims.rowCount}×${dims.colCount}).`,
  );
}

// Apply the edit through the cell primitives (which null raw_stream → survive
// the .hwp round-trip, spec rule 14). For `set` we first read the current
// paragraph length and delete it whole, then insert the new text at offset 0.
try {
  if (op === "insert") {
    doc.insertTextInCell(section, paragraph, control, wantCell, cellPara, offset, text);
  } else if (op === "delete") {
    doc.deleteTextInCell(section, paragraph, control, wantCell, cellPara, offset, count);
  } else {
    // set = clear the whole cell paragraph, then write the new text.
    const curLen = doc.getCellParagraphLength(section, paragraph, control, wantCell, cellPara);
    if (curLen > 0) {
      doc.deleteTextInCell(section, paragraph, control, wantCell, cellPara, 0, curLen);
    }
    doc.insertTextInCell(section, paragraph, control, wantCell, cellPara, 0, text);
  }
} catch (e) {
  fail(EXIT.CORRUPTION, `error: cell edit failed: ${e?.message ?? e}`);
}

// Save + round-trip verify. For insert/set the new text must be present on
// reload; delete carries no presence expectation (the deleted span may recur
// elsewhere in the doc, so an absence check would be unreliable).
const expectPresent = op === "insert" || op === "set" ? [text] : [];
let result;
try {
  result = await exportVerify(doc, output, { expectPresent });
} catch (e) {
  fail(EXIT.CORRUPTION, `error: export/verify failed: ${e?.message ?? e}`);
}

if (!result.verified) {
  process.stderr.write(JSON.stringify(result, null, 2) + "\n");
  fail(
    EXIT.CORRUPTION,
    `error: round-trip verification failed — the cell edit did not survive save→reload in ${output}. ` +
      `Treat the task as FAILED; do not deliver this file.`,
  );
}

// One-line JSON success summary (other core scripts pretty-print, but the
// edit contract asks for a single-line result on success).
process.stdout.write(
  JSON.stringify({
    ok: true,
    op,
    input: inputPath,
    table: { section, paragraph, control },
    cell: wantCell,
    ...(byRowCol ? { row: wantRow, col: wantCol } : {}),
    cellPara,
    verified: result.verified,
    bytesWritten: result.bytesWritten,
    outputPath: result.outputPath,
  }) + "\n",
);
