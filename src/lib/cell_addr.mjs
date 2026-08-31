// Addressing a table cell — the second address space this skill has.
//
// WHY IT MATTERS MORE THAN IT LOOKS. Body paragraphs are not where Korean form
// documents keep their content: 22% of real documents have ZERO body
// paragraphs and hold everything in tables. On one real 성과요약 form, a single
// cell carries 5,086 characters across ~70 paragraphs, and another holds 27 —
// so "apply centre alignment to that paragraph" is a cell-paragraph operation,
// not a body-paragraph one. Commands that address only body paragraphs cannot
// touch such a document at all.
//
// The engine models cell paragraphs fully — getCellParagraphCount /
// getCellParagraphLength / getTextInCell to read, applyParaFormatInCell /
// applyCharFormatInCell / setCellParaShapeId to write, all verified through
// disk. The gap was ours: the addressing stopped at the table.
//
// The convention here is edit_cell.mjs's, deliberately unchanged — a table by
// `--table N` (the index extract_tables prints) or by
// --section/--paragraph/--control, then a cell by `--cell N` or --row/--col.
// Inventing a second spelling for the same address would be the worse of the
// two costs.

import { EXIT, fail } from "./exit-codes.mjs";
import { extractTables } from "./tables.mjs";

// True when the caller named a table at all. Lets a command treat cell
// addressing as opt-in and keep its body-paragraph behaviour untouched.
export function hasCellAddress(argv = process.argv) {
  return argv.includes("--table") || argv.includes("--cell") || argv.includes("--row") || argv.includes("--col");
}

// Resolve to { section, paragraph, control, cell, cellCount }.
//
// `arg` and `intArg` are passed in so this works with either option-parsing
// style in the repo without importing one into the other.
export function resolveCellAddress(doc, { table, section, paragraph, control, cell, row, col }, usage = "") {
  const hasTableIdx = table !== undefined && table !== null;
  const hasAddr = section !== undefined || paragraph !== undefined || control !== undefined;
  if (hasTableIdx && hasAddr) {
    fail(EXIT.USAGE, `error: use either --table N or --section/--paragraph/--control, not both\n${usage}`);
  }
  if (!hasTableIdx && !hasAddr) {
    fail(EXIT.USAGE, `error: address the table with --table N or --section/--paragraph/--control\n${usage}`);
  }

  let s = section;
  let p = paragraph;
  let c = control;
  if (hasTableIdx) {
    const found = extractTables(doc, { noNested: false }).find((t) => t.index === table);
    if (!found) {
      fail(
        EXIT.NOT_FOUND,
        `error: no table with index ${table}. Run extract_tables.mjs --summary to list them.`,
      );
    }
    if (found.controlIndex == null) {
      fail(
        EXIT.NOT_FOUND,
        `error: table ${table} is nested (inside table ${found.nestedIn}). --table addresses ` +
          `top-level tables only; use --section/--paragraph/--control on the parent.`,
      );
    }
    s = found.section;
    p = found.paragraph;
    c = found.controlIndex;
  }
  if (!Number.isInteger(s) || !Number.isInteger(p) || !Number.isInteger(c)) {
    fail(EXIT.USAGE, `error: --section, --paragraph and --control must all be integers\n${usage}`);
  }

  let dims;
  try {
    dims = JSON.parse(doc.getTableDimensions(s, p, c));
  } catch (e) {
    fail(
      EXIT.NOT_FOUND,
      `error: no table at section ${s}, paragraph ${p}, control ${c} (${e?.message ?? e}). ` +
        `Run extract_tables.mjs to find the right address.`,
    );
  }
  const cellCount = dims.cellCount;

  const byLinear = cell !== undefined && cell !== null;
  const byRowCol = row !== undefined || col !== undefined;
  if (byLinear && byRowCol) {
    fail(EXIT.USAGE, `error: use either --cell OR --row/--col, not both\n${usage}`);
  }
  if (!byLinear && !byRowCol) {
    fail(EXIT.USAGE, `error: address the cell with --cell N or --row R --col C\n${usage}`);
  }

  let k = byLinear ? cell : null;
  if (byRowCol) {
    if (!Number.isInteger(row) || !Number.isInteger(col)) {
      fail(EXIT.USAGE, `error: --row and --col must both be integers\n${usage}`);
    }
    // Spec rule 1: text lives only on the top-left origin of a merge, so a
    // covered position has no cell of its own. Point at the origin that holds
    // it rather than reporting "not found".
    let coveringOrigin = null;
    for (let i = 0; i < cellCount; i++) {
      let ci;
      try {
        ci = JSON.parse(doc.getCellInfo(s, p, c, i));
      } catch {
        continue;
      }
      if (ci.row === row && ci.col === col) {
        k = i;
        break;
      }
      if (
        row >= ci.row &&
        row < ci.row + (ci.rowSpan ?? 1) &&
        col >= ci.col &&
        col < ci.col + (ci.colSpan ?? 1)
      ) {
        coveringOrigin = ci;
      }
    }
    if (k === null) {
      fail(
        EXIT.NOT_FOUND,
        coveringOrigin
          ? `error: row ${row}, col ${col} is merged away — its text lives on the origin cell ` +
              `at row ${coveringOrigin.row}, col ${coveringOrigin.col}. Address that one.`
          : `error: no cell at row ${row}, col ${col} (table is ${dims.rowCount}x${dims.colCount}).`,
      );
    }
  }
  if (!Number.isInteger(k) || k < 0 || k >= cellCount) {
    fail(EXIT.NOT_FOUND, `error: cell ${k} out of range (table has ${cellCount} origin cell(s))`);
  }
  return { section: s, paragraph: p, control: c, cell: k, cellCount };
}

// How many paragraphs a cell holds, and how long each is. This is the axis
// that makes per-paragraph formatting inside a cell possible at all.
export function cellParagraphs(doc, addr) {
  const { section: s, paragraph: p, control: c, cell: k } = addr;
  let n = 0;
  try {
    n = doc.getCellParagraphCount(s, p, c, k);
  } catch (e) {
    fail(EXIT.NOT_FOUND, `error: could not read cell ${k}: ${e?.message ?? e}`);
  }
  const out = [];
  for (let cp = 0; cp < n; cp++) {
    let len = 0;
    try {
      len = doc.getCellParagraphLength(s, p, c, k, cp);
    } catch {
      len = 0;
    }
    let text = "";
    if (len > 0) {
      try {
        text = doc.getTextInCell(s, p, c, k, cp, 0, len);
      } catch {
        text = "";
      }
    }
    out.push({ cellPara: cp, length: len, text });
  }
  return out;
}
