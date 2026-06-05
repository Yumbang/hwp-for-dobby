#!/usr/bin/env node
// Usage:
//   node scripts/create.mjs --plan <plan.json> --output <out.hwp>
//
// Builds an HWP from scratch by replaying a JSON plan against a fresh
// blank document. Each step in plan.steps is one of:
//
//   { "op": "insert_text",
//     "section": 0, "para": 0, "char": 0, "text": "안녕하세요" }
//
//   { "op": "insert_paragraph",
//     "section": 0, "para": 1 }
//     // Adds a new empty paragraph AT the given index, shifting later
//     // paragraphs down. The new paragraph becomes para_idx=para.
//
//   { "op": "create_table",
//     "section": 0, "para": 0, "char": 0,
//     "rows": 3, "cols": 4 }
//
//   { "op": "insert_text_in_cell",
//     "section": 0, "para": 2,
//     "control": 0, "cell": 0, "cell_para": 0, "char": 0,
//     "text": "헤더 1" }
//     // Fills one cell of a table. `control` is the index of the table
//     // among controls in `para`; if a paragraph holds only one table
//     // it's typically 0. `cell` is row-major (row 0 cols 0..n-1, row 1
//     // cols 0..n-1, ...). Use this to fill a fresh table cell-by-cell
//     // immediately after `create_table`.
//
// IMPORTANT: a fresh blank document has exactly one section (index 0)
// with one paragraph (index 0). To add content beyond that one paragraph
// you MUST emit an `insert_paragraph` step before referencing the new
// paragraph index. Newlines inside `text` are kept as text — they do not
// split paragraphs. This mirrors the underlying engine's IR; it's not a
// limitation of this script.
//
// More ops can be added later (paragraph shape, char shape). The script
// keeps the plan format simple so an agent can produce one in a single
// pass — no need to maintain editor state across calls.
//
// Output is always HWP 5.0 binary — `.hwpx` output is refused (see
// assertHwpOutput in _bootstrap.mjs).

import { assertHwpOutput, atomicWriteFile, emptyDocument } from "./_bootstrap.mjs";
import { readFileSync } from "node:fs";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const planPath = arg("--plan");
const output = arg("--output");
if (!planPath || !output) {
  console.error("usage: create.mjs --plan <plan.json> --output <out.hwp>");
  process.exit(2);
}
assertHwpOutput(output);

const plan = JSON.parse(readFileSync(planPath, "utf8"));
const doc = await emptyDocument();

const applied = [];
for (const [i, step] of (plan.steps ?? []).entries()) {
  switch (step.op) {
    case "insert_text":
      doc.insertText(step.section ?? 0, step.para ?? 0, step.char ?? 0, step.text ?? "");
      applied.push({ i, op: step.op });
      break;
    case "insert_paragraph":
      doc.insertParagraph(step.section ?? 0, step.para ?? 0);
      applied.push({ i, op: step.op });
      break;
    case "create_table":
      doc.createTable(
        step.section ?? 0,
        step.para ?? 0,
        step.char ?? 0,
        step.rows,
        step.cols,
      );
      applied.push({ i, op: step.op });
      break;
    case "insert_text_in_cell":
      doc.insertTextInCell(
        step.section ?? 0,
        step.para ?? 0,
        step.control ?? 0,
        step.cell ?? 0,
        step.cell_para ?? 0,
        step.char ?? 0,
        step.text ?? "",
      );
      applied.push({ i, op: step.op });
      break;
    default:
      console.error(`unknown op at step ${i}: ${step.op}`);
      process.exit(2);
  }
}

const bytes = doc.exportHwp();
atomicWriteFile(output, Buffer.from(bytes));
process.stdout.write(JSON.stringify({ output, applied }, null, 2) + "\n");
