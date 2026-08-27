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
// PROPS — validated against a verified table before anything is applied.
//   char: bold, italic, underline, strikethrough, superscript, subscript,
//         emboss, engrave (boolean); underlineType ("None"|"Bottom"|"Top");
//         fontSize (integer HWPUNIT, 1400 = 14pt); textColor ("#RRGGBB").
//   para: alignment ("left"|"center"|"right"|"justify"|"distribute");
//         lineSpacingType ("Percent"|"Fixed"); lineSpacing (integer — PERCENT
//         under "Percent", HWPUNIT under "Fixed"; the unit follows the type);
//         marginLeft / marginRight / indent / spacingBefore / spacingAfter
//         (integer HWPUNIT, negative allowed for a hanging indent);
//         keepWithNext, pageBreakBefore, widowOrphan, keepLines (boolean).
//   Every key in that list was confirmed by applying it alone and reading the
//   value back after an export→reload. See lib/format_props.mjs.
//
//   WHY THE TABLE EXISTS: the engine is completely permissive. A typo'd key
//   ({"boldd":true}), the right key in the wrong case ({"BOLD":true}), a real
//   key it does not act on ({"fontFamily":"굴림"} — only applyStyle can change
//   a font), a key that is the WRONG NAME for a working feature
//   ({"bgColor":...}, whose real name is shadeColor), an invalid enum value
//   ({"alignment":"banana"}) and a wrong-typed value ({"bold":"yes"}) ALL return
//   {"ok":true} and change nothing. Before this table, format.mjs answered
//   `ok:true, verified:true` for a document it had not altered at all — the
//   formatting silently did not happen and every signal said it did. Unknown or
//   ill-typed props are now a USAGE error naming the nearest valid key;
//   --allow-unknown-props sends them anyway (with a warning) so a future engine
//   version's new key is never blocked by our list.
//
//   The ORIGINAL --props string is still what reaches the engine, unchanged, so
//   the engine always sees exactly what the caller wrote.
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
import { classifyEffect, validateProps } from "../lib/format_props.mjs";
import { assertMemoSafe } from "../lib/memo.mjs";
import { assertTrackChangeSafe } from "../lib/trackchange.mjs";
import { exportVerify } from "../lib/verify.mjs";

const USAGE =
  "usage: format.mjs <input> --op char|para --section N --paragraph N " +
  "[--start N --end N] --props '<json>' [--allow-unknown-props] --output <out.hwp>";

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

// Then check the KEYS and VALUES against the verified table. This is the only
// thing standing between a typo and a confident "verified:true" on a document
// that was never changed — the engine reports success either way.
{
  const { errors, warnings } = validateProps(op, props, {
    allowUnknown: flag("--allow-unknown-props"),
  });
  for (const w of warnings) process.stderr.write(`WARNING: ${w}\n`);
  if (errors.length) {
    fail(
      EXIT.USAGE,
      errors.map((e) => `error: ${e}`).join("\n") + `\n${USAGE}`,
    );
  }
}

// Refuse a memo-bearing input (the engine drops memos on save) unless the
// caller passed --allow-memo-loss. No-op on memo-free inputs.
assertMemoSafe(input, process.argv);
// Same contract for tracked changes (변경 내용 추적): the engine does not model
// them either, so an edit destroys every recorded change AND the original text
// each deletion still holds. Override: --allow-trackchange-loss.
assertTrackChangeSafe(input, process.argv);

// --- load --------------------------------------------------------------------
let doc;
try {
  doc = await loadDocument(input);
} catch (e) {
  fail(EXIT.LOAD, `error: could not load ${input}: ${e?.message ?? e}`);
}

// Snapshot the shape BEFORE the edit. Comparing it against the reloaded shape
// is what turns "the engine said ok" into "the value actually moved" — the
// engine says ok for requests it ignores entirely.
function readShape(d) {
  try {
    return JSON.parse(
      op === "char"
        ? d.getCharPropertiesAt(section, paragraph, start)
        : d.getParaPropertiesAt(section, paragraph),
    );
  } catch {
    return null;
  }
}
const beforeShape = readShape(doc);

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
const effect = {};
let confirmed = false;
let note;
try {
  const reloaded = await loadDocument(result.outputPath);
  const shape = readShape(reloaded);
  if (!shape) throw new Error("shape getter unavailable");
  for (const key of Object.keys(props)) {
    if (Object.prototype.hasOwnProperty.call(shape, key)) {
      applied[key] = shape[key];
      confirmed = true;
    }
    effect[key] = classifyEffect(key, props[key], beforeShape, shape);
  }

  // A key that came back "no-effect" was accepted by the engine and did
  // nothing — the exact silent failure this script exists to refuse. It is
  // reported as CORRUPTION rather than success, because "verified:true" on a
  // document that did not change is worse than an error.
  const dead = Object.keys(effect).filter((k) => effect[k] === "no-effect");
  if (dead.length) {
    process.stderr.write(JSON.stringify({ op, section, paragraph, props, effect }) + "\n");
    fail(
      EXIT.CORRUPTION,
      `error: the engine accepted ${dead.map((k) => `"${k}"`).join(", ")} and applied nothing —\n` +
        `       the value is unchanged on disk and does not match what was requested.\n` +
        `       This usually means the VALUE is not one the engine acts on.\n` +
        `       The output file at ${result.outputPath} is a clean copy WITHOUT that formatting.`,
    );
  }

  if (!confirmed)
    note =
      "applied + clean round-trip, but no requested key is exposed by the shape " +
      "getter — verify visually with enhanced/render (Phase 3).";
  else if (Object.values(effect).includes("unverifiable"))
    note =
      "some values are unit-converted by the engine (e.g. marginLeft HWPUNIT → pt), " +
      "so an unchanged number cannot be told apart from a re-applied one; the keys " +
      "marked 'unverifiable' in `effect` were sent but not independently confirmed.";
} catch {
  // Getter not available / threw — fall back to the clean-round-trip guarantee.
  // (fail() above exits the process outright, so it never lands here.)
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
  effect, // per key: changed | already-set | unverifiable | unexposed
  verified: true,
  outputPath: result.outputPath,
};
if (note) summary.note = note;
process.stdout.write(JSON.stringify(summary) + "\n");
