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
//   { "op": "apply_para_format",
//     "section": 0, "para": 3,
//     "props": { "marginLeft": 2000, "indent": 0, "alignment": "left" } }
//     // Paragraph shape for one paragraph. `props` goes to the engine's
//     // applyParaFormat verbatim; keys it reads include alignment,
//     // lineSpacing, marginLeft / marginRight / indent (HWPUNIT, 1/7200
//     // inch), spacingBefore / spacingAfter.
//     //
//     // marginLeft is the one that matters for structure. Korean documents
//     // encode outline DEPTH as marker glyph + INDENT, not as heading
//     // styles or numbering: headType/paraLevel/numberingId read None/0/0
//     // on effectively every paragraph of every real document, so a
//     // depth-aware reader has nothing else to go on. This op is what lets
//     // the heading fixtures carry real indentation.
//     //
//     // NOTE the engine accepts unknown keys silently (it never rejects a
//     // typo'd prop), so a misspelled key is a no-op, not an error.
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

import { emptyDocument, loadDocument } from "../lib/_bootstrap.mjs";
import { EXIT, fail } from "../lib/exit-codes.mjs";
import { assertMemoSafe } from "../lib/memo.mjs";
import { PLAN_OPS, confirmAll, replay } from "../lib/plan.mjs";
import { assertTrackChangeSafe } from "../lib/trackchange.mjs";
import { exportVerify } from "../lib/verify.mjs";
import { readFileSync } from "node:fs";

const USAGE =
  "usage: create.mjs --plan <plan.json> --output <out.hwp>            (build from blank)\n" +
  "       create.mjs --input <in.hwp> --plan <plan.json> --output <out.hwp>  (batch-apply)\n" +
  `       plan ops: ${PLAN_OPS.join(", ")}   optional: "order": "descending"`;

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
const inputPath = arg("--input");
if (!planPath || !output) {
  fail(EXIT.USAGE, USAGE);
}

let plan;
try {
  plan = JSON.parse(readFileSync(planPath, "utf8"));
} catch (e) {
  fail(EXIT.LOAD, `error: could not read/parse plan ${planPath}: ${e?.message ?? e}`);
}

// Blank, or an existing document to batch-apply onto. The second form is what
// makes many edits cost ONE load/save instead of one per edit: measured at 59 ms
// against 4,895 ms for the same twelve edits run as twelve invocations, with the
// same per-step verification in both.
let doc;
if (inputPath) {
  // Batch-applying is editing, so it owes the same data-loss guards every other
  // write script keeps. Building from blank has nothing to lose.
  assertMemoSafe(inputPath, process.argv);
  assertTrackChangeSafe(inputPath, process.argv);
  try {
    doc = await loadDocument(inputPath);
  } catch (e) {
    fail(EXIT.LOAD, `error: could not load ${inputPath}: ${e?.message ?? e}`);
  }
} else {
  doc = await emptyDocument();
}

// Replay. lib/plan.mjs refuses a plan whose later steps would be misaddressed
// by an earlier insertion, and records an INTENT per step to confirm after the
// save — a batch must not buy a cheaper guarantee than the individual scripts.
// The paragraph count BEFORE the plan runs is what tells an ordinary append
// apart from an insertion inside an existing document — only the latter can
// renumber a paragraph a later step still addresses by its old index.
const existingParagraphs = inputPath ? doc.getParagraphCount(0) : 0;
const { applied, intents } = replay(doc, plan.steps ?? [], {
  order: plan.order ?? "as-given",
  existingParagraphs,
});
const firstInsertText = (plan.steps ?? []).find((st) => st.op === "insert_text" && st.text)?.text;

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

// Per-step confirmation against the RELOADED file. Twelve separate invocations
// verify twelve times; collapsing that into "the file still opens" would
// re-open the silent-failure hole the engine's permissive ok:true creates.
const back = await loadDocument(result.outputPath);
const notConfirmed = confirmAll(back, intents);
if (notConfirmed.length) {
  process.stdout.write(JSON.stringify({ ...result, applied, notConfirmed }) + "\n");
  fail(
    EXIT.CORRUPTION,
    `error: ${notConfirmed.length} step(s) did not take on disk:\n` +
      notConfirmed.map((f) => `  - step ${f.step} (${f.op}): ${f.why}`).join("\n") +
      `\n       Do not deliver ${output}.`,
  );
}

process.stdout.write(
  JSON.stringify({
    ok: true,
    mode: inputPath ? "batch-apply" : "build",
    ...(inputPath ? { input: inputPath } : {}),
    output: result.outputPath,
    applied,
    confirmed: intents.length,
    verified: true,
  }) + "\n",
);
