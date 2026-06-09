#!/usr/bin/env node
// Usage:
//   node src/core/format.mjs <input> --op char|para --section N --paragraph N \
//     [--start N --end N] --props '<json>' --output <out.hwp>
//
// Apply character or paragraph formatting to one paragraph and save as .hwp.
//
//   --op char  → applyCharFormat(sec, para, start, end, props)   needs --start/--end
//   --op para  → applyParaFormat(sec, para, props)               whole paragraph
//
// CORE-TIER: WASM-only. No rhwp CLI, no capabilities/requireCli. Behaves
// identically on claude.ai / cowork / code.
//
// PROPS (validated only as "parses to a JSON object" on our side — see below):
//   char (applyCharFormat): keys the engine reads include
//     bold, italic, underline, strikethrough (bool); fontSize (HWPUNIT, e.g.
//     1400 = 14pt); textColor ("#RRGGBB"); fontFamily (string). Empirically
//     confirmed to round-trip: {"bold":true}, {"fontSize":1400},
//     {"textColor":"#FF0000"} all read back via getCharPropertiesAt on reload.
//   para (applyParaFormat): keys the engine reads include
//     alignment ("left"|"center"|"right"|"justify"|"distribute"); lineSpacing
//     (percent, e.g. 200); marginLeft / marginRight / indent; spacingBefore /
//     spacingAfter. Empirically confirmed to round-trip: {"alignment":"center"},
//     {"lineSpacing":200} read back via getParaPropertiesAt on reload.
//
//   NOTE on validation: the engine is LENIENT — unknown keys, an empty object,
//   and even malformed JSON passed to applyCharFormat/applyParaFormat all return
//   {"ok":true} and are silently ignored. So we cannot rely on the engine to
//   reject a typo'd prop. We validate on OUR side that --props parses to a plain
//   JSON object (fail USAGE otherwise), then pass the ORIGINAL string through
//   unchanged so the engine sees exactly what the caller wrote. A misspelled key
//   will simply have no effect (and the getter-confirm below will not show it).
//
// VERIFICATION (universal edit contract 2): formatting is NOT text-probeable, so
// exportVerify is called with NO expectPresent/expectAbsent — it still exports,
// atomically writes, reloads from disk, and a `verified:false` would mean the
// engine flagged a corrupt round-trip. On top of that clean-round-trip check we
// RE-READ the applied property from the reloaded document via the engine's shape
// getters (getCharPropertiesAt / getParaPropertiesAt) and report each requested
// key's reloaded value under `applied[]`, so the caller gets positive
// confirmation the property actually stuck on disk — not just an in-memory ok.
// (Visual confirmation — how it RENDERS — still belongs to Phase 3 enhanced/.)
//
// Output is ALWAYS .hwp (exportVerify → assertHwpOutput refuses .hwpx, since
// Hancom Office rejects rhwp-produced HWPX). .hwpx INPUT is fine — exportHwp runs
// the engine's HWPX→HWP adapter for HWPX-sourced docs.
//
// Prints a one-line JSON result on success:
//   {"ok":true,"op":"char","section":0,"paragraph":7,"props":{...},
//    "applied":{"bold":true},"verified":true,"outputPath":"..."}

import { loadDocument } from "../lib/_bootstrap.mjs";
import { EXIT, fail } from "../lib/exit-codes.mjs";
import { exportVerify } from "../lib/verify.mjs";

const USAGE =
  "usage: format.mjs <input> --op char|para --section N --paragraph N " +
  "[--start N --end N] --props '<json>' --output <out.hwp>";

// Option parsing in the style of the sibling core scripts (replace.mjs): one
// positional input plus named flags. Kept small.
function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name) {
  return process.argv.includes(name);
}
// Parse an integer flag; returns undefined when absent, NaN when present but
// non-numeric (caller rejects NaN as a usage error).
function intArg(name) {
  const v = arg(name);
  if (v === undefined) return undefined;
  return Number.parseInt(v, 10);
}

const input = process.argv[2];
const op = arg("--op");
const section = intArg("--section");
const paragraph = intArg("--paragraph");
const start = intArg("--start");
const end = intArg("--end");
const propsRaw = arg("--props");
const output = arg("--output");

if (flag("-h") || flag("--help")) {
  process.stdout.write(USAGE + "\n");
  process.exit(EXIT.OK);
}

// --- argument validation -----------------------------------------------------
if (!input || input.startsWith("-") || !output) fail(EXIT.USAGE, USAGE);
if (op !== "char" && op !== "para")
  fail(EXIT.USAGE, `error: --op must be 'char' or 'para'\n${USAGE}`);
if (!Number.isInteger(section) || section < 0)
  fail(EXIT.USAGE, `error: --section must be a non-negative integer\n${USAGE}`);
if (!Number.isInteger(paragraph) || paragraph < 0)
  fail(EXIT.USAGE, `error: --paragraph must be a non-negative integer\n${USAGE}`);
if (propsRaw === undefined)
  fail(EXIT.USAGE, `error: --props <json> is required\n${USAGE}`);

// char needs an explicit [start, end) range; para applies to the whole paragraph.
if (op === "char") {
  if (!Number.isInteger(start) || start < 0)
    fail(EXIT.USAGE, `error: --op char requires --start (non-negative integer)\n${USAGE}`);
  if (!Number.isInteger(end) || end < 0)
    fail(EXIT.USAGE, `error: --op char requires --end (non-negative integer)\n${USAGE}`);
  if (end < start)
    fail(EXIT.USAGE, `error: --end (${end}) must be >= --start (${start})`);
}

// Validate --props on OUR side: it must parse to a plain JSON object. The engine
// itself silently accepts garbage (unknown keys, empty, even malformed strings —
// all return ok:true), so this is the only guard against a typo'd or non-object
// payload. We pass the ORIGINAL string through to the engine unchanged.
let props;
try {
  props = JSON.parse(propsRaw);
} catch (e) {
  fail(EXIT.USAGE, `error: --props is not valid JSON: ${e?.message ?? e}\n${USAGE}`);
}
if (props === null || typeof props !== "object" || Array.isArray(props))
  fail(EXIT.USAGE, `error: --props must be a JSON object, e.g. '{"bold":true}'\n${USAGE}`);

// --- load --------------------------------------------------------------------
let doc;
try {
  doc = await loadDocument(input);
} catch (e) {
  fail(EXIT.LOAD, `error: could not load ${input}: ${e?.message ?? e}`);
}

// --- apply -------------------------------------------------------------------
// applyCharFormat / applyParaFormat return a JSON string {"ok":true}. An
// out-of-range section/paragraph makes the WASM call return `undefined`
// (Rust panic surfaced as a missing return), so JSON.parse throws — we treat
// any throw / non-ok as a hard failure rather than reporting a phantom success.
function applyFormat() {
  const raw =
    op === "char"
      ? doc.applyCharFormat(section, paragraph, start, end, propsRaw)
      : doc.applyParaFormat(section, paragraph, propsRaw);
  const r = JSON.parse(raw); // throws if raw is undefined (OOB index)
  if (!r || r.ok !== true) throw new Error(`engine returned ${raw}`);
}
try {
  applyFormat();
} catch (e) {
  fail(
    EXIT.CORRUPTION,
    `error: apply ${op} format failed at section ${section}, paragraph ${paragraph}` +
      `${op === "char" ? ` [${start},${end})` : ""}: ${e?.message ?? e}\n` +
      `       (check the section/paragraph indices are in range)`,
  );
}

// --- export + verify ---------------------------------------------------------
// No text to probe — exportVerify with empty expectations still exports,
// atomically writes, and reloads, so verified:false would flag a corrupt
// round-trip. We then re-read the applied property from the reloaded doc.
let result;
try {
  result = await exportVerify(doc, output, {});
} catch (e) {
  fail(EXIT.CORRUPTION, `error: export/verify failed: ${e?.message ?? e}`);
}

if (!result.verified) {
  // Clean-round-trip check failed — the engine flagged a corrupt save→reload.
  process.stderr.write(JSON.stringify(result) + "\n");
  fail(
    EXIT.CORRUPTION,
    `error: round-trip verification failed — the document did not reload cleanly from ${output}.`,
  );
}

// Getter confirmation: re-read the saved file and pull back the values of the
// keys the caller requested, so success is CONFIRMED on disk, not just claimed
// in memory. getCharPropertiesAt(sec,para,char) / getParaPropertiesAt(sec,para)
// return a rich JSON object; we surface only the requested keys under `applied`.
// If the getter or a key is unavailable we still succeed (the clean round-trip
// already passed) but note that visual confirmation needs Phase 3 render.
const applied = {};
let confirmed = false;
let note;
try {
  const reloaded = await loadDocument(result.outputPath);
  const shape = JSON.parse(
    op === "char"
      ? reloaded.getCharPropertiesAt(section, paragraph, start)
      : reloaded.getParaPropertiesAt(section, paragraph),
  );
  for (const key of Object.keys(props)) {
    if (Object.prototype.hasOwnProperty.call(shape, key)) {
      applied[key] = shape[key];
      confirmed = true;
    }
  }
  if (!confirmed)
    note =
      "applied + clean round-trip, but no requested key is exposed by the shape " +
      "getter — verify visually with enhanced/render (Phase 3).";
} catch {
  // Getter not available / threw — fall back to the clean-round-trip guarantee.
  note =
    "applied + clean round-trip, but the shape getter was unavailable — verify " +
    "visually with enhanced/render (Phase 3).";
}

const summary = {
  ok: true,
  op,
  section,
  paragraph,
  ...(op === "char" ? { start, end } : {}),
  props,
  applied,
  verified: true,
  outputPath: result.outputPath,
};
if (note) summary.note = note;
process.stdout.write(JSON.stringify(summary) + "\n");
