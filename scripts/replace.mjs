#!/usr/bin/env node
// Usage:
//   node scripts/replace.mjs <input> --query "<text>" --replacement "<text>" \
//     [--all] [--case-sensitive] --output <output.hwp>
//
// Performs find/replace on the document and saves the result. Without `--all`
// only the first match is replaced (matches the @rhwp/core replaceOne /
// replaceAll split). Output is always HWP 5.0 binary — `.hwpx` output is
// refused (Hancom Office rejects rhwp-produced HWPX; see assertHwpOutput in
// _bootstrap.mjs). `.hwpx` INPUT is fine: exportHwp runs the engine's
// HWPX→HWP adapter for HWPX-sourced docs.
//
// Subtle engine behavior: replaceOne (without --all) ONLY searches the body,
// not text inside tables, textboxes, or shapes. replaceAll covers everything.
// If you have body+table content and want to hit both, use --all.
//
// CRITICAL — round-trip verification:
// rhwp's HWP 5.0 serializer can lose certain in-memory edits on save
// (verified on aift.hwp at v0.7.10: replaceAll reports count=28 but the
// saved .hwp shows 0 of the new string, 32 of the old, on reload). After
// saving, this script reloads the output and searches for the original
// query; if it still appears, the round-trip dropped the edit. The agent
// gets a "verified": false signal in the JSON summary plus a warning on
// stderr. With --strict, that case exits non-zero.
//
// Prints a JSON summary on stdout: { input, output, replaced, verified, query }.
// If no match is found, exits non-zero so the agent notices.

import { assertHwpOutput, atomicWriteFile, loadDocument } from "./_bootstrap.mjs";

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
}
function flag(name) {
  return process.argv.includes(name);
}

const input = process.argv[2];
const query = arg("--query");
const replacement = arg("--replacement");
const output = arg("--output");
const all = flag("--all");
const caseSensitive = flag("--case-sensitive");

if (!input || !query || replacement === undefined || !output) {
  console.error(
    "usage: replace.mjs <input> --query <text> --replacement <text> [--all] [--case-sensitive] --output <out.hwp>",
  );
  process.exit(2);
}
assertHwpOutput(output);

const doc = await loadDocument(input);
let replaced = 0;
if (all) {
  // replaceAll → {"ok":true,"count":N}
  const r = JSON.parse(doc.replaceAll(query, replacement, caseSensitive));
  replaced = r.ok ? (r.count ?? 0) : 0;
} else {
  // replaceOne → {"ok":true,"sec":..,"para":..,...} or {"ok":false}
  const r = JSON.parse(doc.replaceOne(query, replacement, caseSensitive));
  replaced = r.ok ? 1 : 0;
}

if (replaced === 0) {
  console.error(`no match for ${JSON.stringify(query)}`);
  process.exit(3);
}

const bytes = doc.exportHwp();
atomicWriteFile(output, Buffer.from(bytes));

// Round-trip verify: re-read the saved file and search for the ORIGINAL
// query. If still present, the engine's serializer dropped the edit.
const verifyDoc = await loadDocument(output);
const stillFound = JSON.parse(
  verifyDoc.searchText(query, 0, 0, 0, true, caseSensitive),
).found === true;
const verified = !stillFound;
const summary = { input, output, replaced, verified, query };
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
if (!verified) {
  process.stderr.write(
    `WARNING: round-trip verification failed — '${query}' is still present in ${output} after save.\n` +
      `         The rhwp engine's HWP 5.0 serializer dropped this edit (upstream bug).\n` +
      `         Treat the task as FAILED — do not deliver ${output} as an edited file.\n` +
      `         There is no .hwpx fallback: Hancom Office rejects rhwp-produced HWPX.\n`,
  );
  if (flag("--strict")) process.exit(4);
}
