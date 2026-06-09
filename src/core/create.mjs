#!/usr/bin/env node
// Usage:
//   node src/core/create.mjs --plan <plan.json> --output <out.hwp>
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
// CORE-TIER: WASM-only. No rhwp CLI, no capabilities/requireCli. Behaves
// identically on claude.ai / cowork / code.
//
// The save routes through exportVerify() — export, write, reload from disk,
// and confirm the created document round-trips. As an end-to-end sanity
// check we assert the text of the FIRST insert_text step (if any) is present
// on reload; a `verified: false` result is a CORRUPTION failure, never
// reported as success (universal edit contract 2).
//
// Output is always HWP 5.0 binary — `.hwpx` output is refused (exportVerify →
// assertHwpOutput in _bootstrap.mjs).
//
// Prints a one-line JSON result on success:
//   {"ok":true,"output":"...","applied":[...],"verified":true}

import { emptyDocument } from "../lib/_bootstrap.mjs";
import { EXIT, fail } from "../lib/exit-codes.mjs";
import { exportVerify } from "../lib/verify.mjs";
import { readFileSync } from "node:fs";

const USAGE = "usage: create.mjs --plan <plan.json> --output <out.hwp>";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name) {
  return process.argv.includes(name);
}

if (flag("-h") || flag("--help")) {
  process.stdout.write(USAGE + "\n");
  process.exit(EXIT.OK);
}

const planPath = arg("--plan");
const output = arg("--output");
if (!planPath || !output) {
  fail(EXIT.USAGE, USAGE);
}

let plan;
try {
  plan = JSON.parse(readFileSync(planPath, "utf8"));
} catch (e) {
  fail(EXIT.LOAD, `error: could not read/parse plan ${planPath}: ${e?.message ?? e}`);
}

// Start from a blank editable document (section 0 / paragraph 0 ready).
const doc = await emptyDocument();

// Replay each step against the engine. The first insert_text's text is
// captured for the post-save round-trip presence check below.
const applied = [];
let firstInsertText;
try {
  for (const [i, step] of (plan.steps ?? []).entries()) {
    switch (step.op) {
      case "insert_text":
        doc.insertText(step.section ?? 0, step.para ?? 0, step.char ?? 0, step.text ?? "");
        if (firstInsertText === undefined && step.text) firstInsertText = step.text;
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
        fail(EXIT.USAGE, `unknown op at step ${i}: ${step.op}`);
    }
  }
} catch (e) {
  fail(EXIT.CORRUPTION, `error: build failed: ${e?.message ?? e}`);
}

// Verify the created document survives save→reload. When the plan inserts
// body text, assert that first run is present on reload — proving the new
// .hwp round-trips rather than serializing to an empty/garbled shell.
let result;
try {
  result = await exportVerify(doc, output, {
    expectPresent: firstInsertText ? [firstInsertText] : [],
  });
} catch (e) {
  fail(EXIT.CORRUPTION, `error: export/verify failed: ${e?.message ?? e}`);
}

if (!result.verified) {
  // The engine accepted the build in memory but the .hwp round-trip dropped
  // it (or produced an unreadable file). Print the verification JSON so the
  // failure is diagnosable, then fail hard — never delivered as success.
  process.stderr.write(JSON.stringify(result) + "\n");
  fail(
    EXIT.CORRUPTION,
    `error: round-trip verification failed — the created document did not survive save→reload to ${output}.`,
  );
}

process.stdout.write(
  JSON.stringify({
    ok: true,
    output: result.outputPath,
    applied,
    verified: true,
  }) + "\n",
);
