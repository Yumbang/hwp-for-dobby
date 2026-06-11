#!/usr/bin/env node
// Usage:
//   node src/core/replace.mjs <input> --query "<text>" --replacement "<text>" \
//     [--case-sensitive] --output <output.hwp>
//
// Find/replace ALL occurrences of --query with --replacement across the whole
// document — body text AND table cells — and save the result as .hwp.
//
// CORE-TIER: WASM-only. No rhwp CLI, no capabilities/requireCli. Behaves
// identically on claude.ai / cowork / code.
//
// This is the centerpiece edit. It routes through safeReplaceAll() (lib/
// safe-edit.mjs), NEVER the engine's replaceAll() directly: on a genuine .hwp
// the engine's replaceAll mutates the IR but does NOT null section.raw_stream,
// so the edit is silently dropped on save (spec rule 9). safeReplaceAll instead
// locates every hit with searchAllText(include_cells=true) and rewrites it with
// the delete/insert primitives, which DO null raw_stream and therefore survive
// the round-trip (spec rules 10/11). On .hwpx input the engine's replaceAll is
// safe (no raw_stream fast-path) so safeReplaceAll uses it directly (rule 24).
//
// Every save goes through exportVerify() — export, reload from disk, and confirm
// the replacement actually materialized. A `verified: false` result means the
// engine accepted the edit in memory but the .hwp round-trip dropped it; that is
// a CORRUPTION failure, never reported as success (universal edit contract 2).
//
// Output is ALWAYS .hwp (exportVerify → assertHwpOutput refuses .hwpx, since
// Hancom Office rejects rhwp-produced HWPX). .hwpx INPUT is fine — exportHwp
// runs the engine's HWPX→HWP adapter for HWPX-sourced docs.
//
// Prints a one-line JSON result on success:
//   {"ok":true,"count":N,"verified":true,"outputPath":"..."}

import { loadDocument } from "../lib/_bootstrap.mjs";
import { EXIT, fail } from "../lib/exit-codes.mjs";
import { assertMemoSafe } from "../lib/memo.mjs";
import { safeReplaceAll } from "../lib/safe-edit.mjs";
import { exportVerify } from "../lib/verify.mjs";

const USAGE =
  "usage: replace.mjs <input> --query <text> --replacement <text> [--case-sensitive] --output <out.hwp>";

// Option parsing in the style of the sibling core scripts: one positional
// input plus named flags. Kept small.
function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name) {
  return process.argv.includes(name);
}

const input = process.argv[2];
const query = arg("--query");
const replacement = arg("--replacement");
const output = arg("--output");
const caseSensitive = flag("--case-sensitive");

if (flag("-h") || flag("--help")) {
  process.stdout.write(USAGE + "\n");
  process.exit(EXIT.OK);
}
if (!input || input.startsWith("-") || !query || replacement === undefined || !output) {
  fail(EXIT.USAGE, USAGE);
}

// Refuse a memo-bearing input (the engine drops memos on save) unless the
// caller passed --allow-memo-loss. No-op on memo-free inputs.
assertMemoSafe(input, process.argv);

let doc;
try {
  doc = await loadDocument(input);
} catch (e) {
  fail(EXIT.LOAD, `error: could not load ${input}: ${e?.message ?? e}`);
}

// safeReplaceAll mutates `doc` in place and returns the match count, dispatching
// on source format (.hwpx → replaceAll; genuine .hwp → search + delete/insert).
let count = 0;
try {
  count = safeReplaceAll(doc, query, replacement, caseSensitive);
} catch (e) {
  fail(EXIT.CORRUPTION, `error: replace failed: ${e?.message ?? e}`);
}

if (count === 0) {
  fail(EXIT.NOT_FOUND, `error: no match for ${JSON.stringify(query)}`);
}

// Verify the edit survived save→reload.
//   • expectPresent: the replacement must appear afterward — but only when it is
//     non-empty. An empty replacement is a DELETION; probing for "" always
//     yields 0, so asserting its presence would falsely fail a valid delete.
//     In that case the absence check below carries the proof.
//   • expectAbsent: the original query must be gone — UNLESS the replacement
//     itself contains the query (e.g. "cat" → "cats"), in which case the query
//     legitimately remains and we cannot assert its absence.
const expectPresent = replacement ? [replacement] : [];
const expectAbsent = replacement.includes(query) ? [] : [query];
let result;
try {
  result = await exportVerify(doc, output, {
    expectPresent,
    expectAbsent,
    caseSensitive,
  });
} catch (e) {
  fail(EXIT.CORRUPTION, `error: export/verify failed: ${e?.message ?? e}`);
}

if (!result.verified) {
  // The engine dropped (or left stale) the edit on the .hwp round-trip. Print
  // the verification JSON so the failure is diagnosable, then fail hard — a
  // dropped edit is a FAILED task, never delivered as success.
  process.stderr.write(JSON.stringify(result) + "\n");
  fail(
    EXIT.CORRUPTION,
    `error: round-trip verification failed — the edit did not survive save→reload to ${output}.`,
  );
}

process.stdout.write(
  JSON.stringify({
    ok: true,
    count,
    verified: true,
    outputPath: result.outputPath,
  }) + "\n",
);
