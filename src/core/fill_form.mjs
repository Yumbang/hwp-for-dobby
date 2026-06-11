#!/usr/bin/env node
// Usage:
//   node src/core/fill_form.mjs <input.hwp|.hwpx> --list
//   node src/core/fill_form.mjs <input.hwp|.hwpx> --values <values.json> --output <out.hwp>
//
// Korean public-sector forms ship as .hwp/.hwpx with named fields (clickhere /
// cell fields). This wraps the engine Field API:
//   --list   → prints getFieldList() JSON so the agent can see what fields
//              exist (and their current values) before assigning anything.
//   --values → reads {fieldName: value, ...} and applies setFieldValueByName
//              for each, then saves verified .hwp.
//
// CORE TIER — WASM ONLY. Runs entirely through the vendored @rhwp/core WASM
// bundle; behaves identically on claude.ai / cowork / code. MUST NOT shell out
// to the rhwp CLI.
//
// Round-trip safety (spec §17): setFieldValueByName routes through the IR
// update path (not the raw_stream fast-path), so empty-field fills survive
// .hwp export→reload. Every save still goes through exportVerify() — we never
// trust the in-memory write; a value that doesn't materialize on reload is a
// FAILED task (exit CORRUPTION), never reported as success.
//
// Pre-fill detection + #838 warning (spec §18–19): BEFORE filling a field we
// read its current value. A non-empty value means the field is PRE-POPULATED;
// overwriting it does NOT shift the char-shape / line-seg metadata (#838), so
// Hancom Office may reject the result. We still fill (the value is correct in
// rhwp's IR) but warn loudly on stderr and recommend a visual verify. Empty
// fields fill cleanly and need no warning.
//
// Output is always HWP 5.0 binary — .hwpx output is refused (assertHwpOutput,
// invoked inside exportVerify). .hwpx INPUT is fine: exportHwp runs the
// engine's HWPX→HWP adapter.

import { loadDocument } from "../lib/_bootstrap.mjs";
import { exportVerify } from "../lib/verify.mjs";
import { EXIT, fail } from "../lib/exit-codes.mjs";
import { assertMemoSafe } from "../lib/memo.mjs";
import { readFileSync } from "node:fs";

const USAGE =
  "usage: fill_form.mjs <input> --list\n" +
  "       fill_form.mjs <input> --values <values.json> --output <out.hwp>";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name) {
  return process.argv.includes(name);
}

// Surface load failures as a clean one-line diagnostic instead of a raw
// engine stack trace (ENOENT, corrupt CFB, wrong format, etc.).
async function loadOrExit(path) {
  try {
    return await loadDocument(path);
  } catch (e) {
    fail(EXIT.LOAD, `error: cannot read ${path}: ${e?.message ?? e}`);
  }
}

// Current value of a named field, "" if absent/unreadable. getFieldValueByName
// returns {ok, fieldId, value}; we treat a non-ok / parse failure as "no value"
// so detection never throws the run.
function currentFieldValue(doc, name) {
  try {
    const r = JSON.parse(doc.getFieldValueByName(name));
    return r && r.ok ? String(r.value ?? "") : "";
  } catch {
    return "";
  }
}

const inputPath = process.argv[2];
if (!inputPath || inputPath.startsWith("--")) {
  fail(EXIT.USAGE, USAGE);
}

const doc = await loadOrExit(inputPath);

// ── --list ────────────────────────────────────────────────────────────────
// Print the field catalog as-is. getFieldList returns "[]" on a fieldless doc,
// so the JSON is always valid; the agent reads `name`/`value`/`location` to
// decide what to fill.
if (flag("--list")) {
  let fields;
  try {
    fields = JSON.parse(doc.getFieldList());
  } catch (e) {
    fail(EXIT.LOAD, `error: could not read field list: ${e?.message ?? e}`);
  }
  process.stdout.write(JSON.stringify(fields, null, 2) + "\n");
  process.exit(EXIT.OK);
}

// ── --values --output ───────────────────────────────────────────────────────
const valuesPath = arg("--values");
const output = arg("--output");
if (!valuesPath || !output) {
  fail(EXIT.USAGE, `error: --values <json> and --output <out.hwp> are both required\n${USAGE}`);
}

// Write path only (NOT --list, which is read-only): refuse a memo-bearing input
// (the engine drops memos on save) unless the caller passed --allow-memo-loss.
// No-op on memo-free inputs.
assertMemoSafe(inputPath, process.argv);

// Parse the values map up front so a malformed file fails before any mutation.
let values;
try {
  values = JSON.parse(readFileSync(valuesPath, "utf8"));
} catch (e) {
  fail(EXIT.USAGE, `error: cannot read --values JSON ${valuesPath}: ${e?.message ?? e}`);
}
if (values === null || typeof values !== "object" || Array.isArray(values)) {
  fail(EXIT.USAGE, `error: --values JSON must be an object {fieldName: value, ...}`);
}

// Validate the requested fields exist before touching anything. A typo'd field
// name must be a hard NOT_FOUND, never a silent no-op partial fill.
const known = new Set();
try {
  for (const f of JSON.parse(doc.getFieldList())) known.add(f.name);
} catch {
  /* leave empty → every name will be reported missing below */
}
const missing = Object.keys(values).filter((name) => !known.has(name));
if (missing.length) {
  fail(
    EXIT.NOT_FOUND,
    `error: field(s) not found in document: ${missing.join(", ")}\n` +
      `       run --list to see available fields.`,
  );
}

// Apply each field. Detect pre-population first (spec §18): a non-empty current
// value means overwriting risks #838 (char-shape not shifted → Hancom may
// reject). Warn but still fill (spec §19) — the value is correct in the IR.
const applied = [];
const prefilledWarned = [];
for (const [name, raw] of Object.entries(values)) {
  const value = String(raw);
  const existing = currentFieldValue(doc, name);
  if (existing !== "") {
    prefilledWarned.push(name);
    process.stderr.write(
      `WARNING: field '${name}' is PRE-POPULATED (current value ${JSON.stringify(existing)}).\n` +
        `         Overwriting a filled field does NOT shift its char-shape / line-seg\n` +
        `         metadata (rhwp #838), so Hancom Office may reject the saved .hwp as\n` +
        `         manipulated ("파일 손상"). The new value is written to rhwp's IR and\n` +
        `         survives the round-trip, but you should VISUALLY VERIFY the result in\n` +
        `         Hancom before delivering. Filling EMPTY fields is the clean path.\n`,
    );
  }
  const r = JSON.parse(doc.setFieldValueByName(name, value));
  if (!r || r.ok !== true) {
    // setFieldValueByName returns {ok, fieldId, oldValue, newValue}; a non-ok
    // result here is unexpected (we pre-validated existence) → hard fail.
    fail(EXIT.CORRUPTION, `error: setFieldValueByName failed for '${name}': ${JSON.stringify(r)}`);
  }
  applied.push(name);
}

// Save with round-trip verification (spec §17): every filled value MUST be
// present on reload. exportVerify also calls assertHwpOutput, so a .hwpx
// --output is refused here. A verified=false result means the .hwp round-trip
// dropped a value — treat as CORRUPTION, never success.
//
// We assert presence of the (non-empty) values we wrote. Empty-string fills
// (clearing a field) can't be probed for presence, so they're excluded from
// expectPresent; their setFieldValueByName already returned ok above.
const expectPresent = [
  ...new Set(Object.values(values).map(String).filter((v) => v.length > 0)),
];
const result = await exportVerify(doc, output, { expectPresent });

if (!result.verified) {
  process.stderr.write(JSON.stringify(result, null, 2) + "\n");
  fail(
    EXIT.CORRUPTION,
    `error: round-trip verification failed — a filled value did not survive save→reload of ${output}.\n` +
      `       The edit was accepted in memory but dropped on .hwp serialization (upstream bug).\n` +
      `       Treat the task as FAILED — do not deliver ${output}.`,
  );
}

process.stdout.write(
  JSON.stringify({
    ok: true,
    input: inputPath,
    outputPath: result.outputPath,
    applied,
    prefilledWarned,
    bytesWritten: result.bytesWritten,
    verified: result.verified,
  }) + "\n",
);
