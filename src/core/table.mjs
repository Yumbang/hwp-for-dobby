#!/usr/bin/env node
// Usage:
//   node src/core/table.mjs <input> --op create|merge|split \
//     [--section N] [--paragraph N] [--offset N] [--rows N] [--cols N] \
//     [--control N] [--start-row N] [--start-col N] [--end-row N] [--end-col N] \
//     [--row N] [--col N] \
//     --output <out.hwp>
//
// Structural table operations (create / merge / split). Output is ALWAYS
// .hwp — `.hwpx` output is refused (Hancom Office rejects rhwp-produced
// HWPX; see assertHwpOutput in lib/_bootstrap.mjs). `.hwpx` INPUT is fine:
// exportHwp runs the engine's HWPX→HWP adapter for HWPX-sourced docs.
//
//   --op create  → createTable(section, paragraph, offset, rows, cols)
//                  Inserts a fresh rows×cols table at the cursor position.
//                  Returns {ok,paraIdx,controlIdx}; we record where it
//                  landed and re-read its dimensions after reload to prove
//                  a real table control now exists there.
//
//   --op merge   → mergeTableCells(section, paragraph, control,
//                                  start-row, start-col, end-row, end-col)
//                  Merges a rectangular cell block into its top-left origin.
//                  Origin-cell count DECREASES (covered cells vanish), so we
//                  assert reloaded cellCount < before.
//
//   --op split   → splitTableCell(section, paragraph, control, row, col)
//                  Splits a (previously merged) cell back out. Origin-cell
//                  count INCREASES, so we assert reloaded cellCount > before.
//
// Here `paragraph` is the PARENT paragraph that holds the table control and
// `control` is the table's index among controls in that paragraph (usually
// 0 when a paragraph holds a single table). Find these with src/core/info.mjs
// / read.mjs / extract_tables.mjs before editing.
//
// VERIFICATION (universal edit contract):
// Every save routes through exportVerify (which calls assertHwpOutput and
// confirms a clean .hwp round-trip). Because these edits are STRUCTURAL —
// not text presence — we pass empty expectPresent/expectAbsent (round-trip
// integrity is what exportVerify proves) AND additionally re-read
// getTableDimensions on the reloaded document to assert the structural
// delta (new table exists / cellCount decreased / cellCount increased). If
// either the round-trip verify OR the structural assertion fails, we print
// the JSON and exit CORRUPTION — a dropped structural edit is a FAILED task,
// never reported as success.
//
// CORE-TIER: WASM-only. Must NOT shell out to the rhwp CLI (enhanced/ tier).

import { loadDocument } from "../lib/_bootstrap.mjs";
import { EXIT, fail } from "../lib/exit-codes.mjs";
import { assertMemoSafe } from "../lib/memo.mjs";
import { exportVerify } from "../lib/verify.mjs";

const USAGE =
  "usage: table.mjs <input> --op create|merge|split " +
  "[--section N --paragraph N --offset N --rows N --cols N] " +
  "[--control N --start-row N --start-col N --end-row N --end-col N] " +
  "[--row N --col N] --output <out.hwp>";

// Minimal option parsing in the style of the lib/port scripts: one
// positional input path, then named flags. Numeric flags are parsed lazily
// via num() so a missing/garbage value surfaces as a clear USAGE error at
// the point of use rather than a silent NaN deep in the engine call.
function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

let inputPath = null;
for (const a of process.argv.slice(2)) {
  if (a === "-h" || a === "--help") {
    process.stdout.write(USAGE + "\n");
    process.exit(EXIT.OK);
  }
  if (!a.startsWith("-") && inputPath === null && !isFlagValue(a)) {
    inputPath = a;
  }
}

// A bare token is the positional input only if it is not the value of a
// preceding flag (e.g. the "3" in `--rows 3`). Without this guard a numeric
// value could be mistaken for the input path.
function isFlagValue(token) {
  const i = process.argv.indexOf(token);
  return i > 0 && process.argv[i - 1].startsWith("--");
}

const op = arg("--op");
const output = arg("--output");

if (!inputPath || !op || !output) {
  fail(EXIT.USAGE, USAGE);
}
if (!["create", "merge", "split"].includes(op)) {
  fail(EXIT.USAGE, `error: --op must be one of create|merge|split (got ${JSON.stringify(op)})\n${USAGE}`);
}

// Refuse a memo-bearing input (the engine drops memos on save) unless the
// caller passed --allow-memo-loss. No-op on memo-free inputs.
assertMemoSafe(inputPath, process.argv);

// Parse a required numeric flag; fail USAGE if missing or non-integer.
function num(name) {
  const raw = arg(name);
  if (raw === undefined) {
    fail(EXIT.USAGE, `error: --op ${op} requires ${name}\n${USAGE}`);
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    fail(EXIT.USAGE, `error: ${name} must be a non-negative integer (got ${JSON.stringify(raw)})\n${USAGE}`);
  }
  return n;
}

let doc;
try {
  doc = await loadDocument(inputPath);
} catch (e) {
  fail(EXIT.LOAD, `error: could not load ${inputPath}: ${e?.message ?? e}`);
}

// Read table dimensions defensively: getTableDimensions throws on a
// non-table control / out-of-range index. Return null so callers can detect
// "no table here" instead of crashing.
function dims(d, sec, para, ctrl) {
  try {
    return JSON.parse(d.getTableDimensions(sec, para, ctrl));
  } catch {
    return null;
  }
}

// Each branch performs the engine mutation, then defines:
//   • result fields describing the op,
//   • a `verify(reloaded)` closure that re-reads the reloaded doc and
//     returns {ok, structural} asserting the expected structural delta.
let result;
let verifyStructural;

if (op === "create") {
  const section = num("--section");
  const paragraph = num("--paragraph");
  const offset = num("--offset");
  const rows = num("--rows");
  const cols = num("--cols");
  if (rows < 1 || cols < 1) {
    fail(EXIT.USAGE, `error: --rows and --cols must each be >= 1\n${USAGE}`);
  }

  let created;
  try {
    created = JSON.parse(doc.createTable(section, paragraph, offset, rows, cols));
  } catch (e) {
    fail(EXIT.UNSUPPORTED, `error: createTable failed at (${section},${paragraph}) offset ${offset}: ${e?.message ?? e}`);
  }
  if (!created || created.ok !== true) {
    fail(EXIT.UNSUPPORTED, `error: createTable returned ${JSON.stringify(created)}`);
  }
  // createTable reports where the new table landed: paraIdx (the parent
  // paragraph holding the control) and controlIdx within it. Re-read dims at
  // that exact location after reload to prove a real table exists there.
  const newPara = created.paraIdx;
  const newCtrl = created.controlIdx;

  result = {
    op,
    section,
    paragraph,
    offset,
    requested: { rows, cols },
    tableAt: { section, paragraph: newPara, control: newCtrl },
  };
  verifyStructural = (reloaded) => {
    const d = dims(reloaded, section, newPara, newCtrl);
    const ok = !!d && d.rowCount === rows && d.colCount === cols;
    return { ok, structural: { newTableDims: d, expected: { rowCount: rows, colCount: cols } } };
  };
} else if (op === "merge") {
  const section = num("--section");
  const paragraph = num("--paragraph");
  const control = num("--control");
  const startRow = num("--start-row");
  const startCol = num("--start-col");
  const endRow = num("--end-row");
  const endCol = num("--end-col");

  const before = dims(doc, section, paragraph, control);
  if (!before) {
    fail(EXIT.NOT_FOUND, `error: no table at (${section},${paragraph},${control}) to merge`);
  }

  let merged;
  try {
    merged = JSON.parse(doc.mergeTableCells(section, paragraph, control, startRow, startCol, endRow, endCol));
  } catch (e) {
    fail(EXIT.UNSUPPORTED, `error: mergeTableCells failed at (${section},${paragraph},${control}) [${startRow},${startCol}]-[${endRow},${endCol}]: ${e?.message ?? e}`);
  }
  if (!merged || merged.ok !== true) {
    fail(EXIT.UNSUPPORTED, `error: mergeTableCells returned ${JSON.stringify(merged)}`);
  }

  result = {
    op,
    section,
    paragraph,
    control,
    range: { startRow, startCol, endRow, endCol },
    cellCountBefore: before.cellCount,
  };
  // Merge collapses covered cells into the origin, so origin-cell count must
  // DROP. Assert on the reloaded doc (raw_stream round-trip survived).
  verifyStructural = (reloaded) => {
    const after = dims(reloaded, section, paragraph, control);
    const ok = !!after && after.cellCount < before.cellCount;
    return { ok, structural: { cellCountBefore: before.cellCount, cellCountAfter: after?.cellCount ?? null } };
  };
} else {
  // split
  const section = num("--section");
  const paragraph = num("--paragraph");
  const control = num("--control");
  const row = num("--row");
  const col = num("--col");

  const before = dims(doc, section, paragraph, control);
  if (!before) {
    fail(EXIT.NOT_FOUND, `error: no table at (${section},${paragraph},${control}) to split`);
  }

  let splitR;
  try {
    splitR = JSON.parse(doc.splitTableCell(section, paragraph, control, row, col));
  } catch (e) {
    fail(EXIT.UNSUPPORTED, `error: splitTableCell failed at (${section},${paragraph},${control}) [${row},${col}]: ${e?.message ?? e}`);
  }
  if (!splitR || splitR.ok !== true) {
    fail(EXIT.UNSUPPORTED, `error: splitTableCell returned ${JSON.stringify(splitR)}`);
  }

  result = {
    op,
    section,
    paragraph,
    control,
    cell: { row, col },
    cellCountBefore: before.cellCount,
  };
  // Split re-materializes covered cells, so origin-cell count must RISE.
  verifyStructural = (reloaded) => {
    const after = dims(reloaded, section, paragraph, control);
    const ok = !!after && after.cellCount > before.cellCount;
    return { ok, structural: { cellCountBefore: before.cellCount, cellCountAfter: after?.cellCount ?? null } };
  };
}

// Save through exportVerify: it asserts a clean .hwp round-trip (and refuses
// .hwpx output). With no text expectations the round-trip itself is the
// integrity check; then we re-read the reloaded doc to confirm the
// structural delta. We need the reloaded doc, so we redo the load here from
// the verified output path (exportVerify already wrote+reloaded it once).
let verifyResult;
try {
  verifyResult = await exportVerify(doc, output, { expectPresent: [], expectAbsent: [] });
} catch (e) {
  fail(EXIT.CORRUPTION, `error: export/verify failed: ${e?.message ?? e}`);
}

// Re-read the saved file for the structural assertion. If the round-trip
// dropped the structural edit, dims() on the reloaded doc won't match.
let reloaded;
try {
  reloaded = await loadDocument(output);
} catch (e) {
  fail(EXIT.CORRUPTION, `error: could not reload ${output} for structural verify: ${e?.message ?? e}`);
}
const structuralCheck = verifyStructural(reloaded);

const verified = verifyResult.verified && structuralCheck.ok;
const summary = {
  ok: true,
  ...result,
  outputPath: output,
  bytesWritten: verifyResult.bytesWritten,
  ...structuralCheck.structural,
  roundTripVerified: verifyResult.verified,
  structuralVerified: structuralCheck.ok,
  verified,
};

if (!verified) {
  // A failed verify is a CORRUPTION exit — never report a dropped structural
  // edit as success. Print the full JSON (including checks) so the agent sees
  // exactly which assertion failed.
  process.stderr.write(JSON.stringify({ ...summary, checks: verifyResult.checks }, null, 2) + "\n");
  fail(
    EXIT.CORRUPTION,
    `error: ${op} did not survive the .hwp round-trip ` +
      `(roundTripVerified=${verifyResult.verified}, structuralVerified=${structuralCheck.ok}).`,
  );
}

process.stdout.write(JSON.stringify(summary) + "\n");
