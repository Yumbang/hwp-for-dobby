#!/usr/bin/env node
// Usage:
//   node src/core/edit_text.mjs <input.hwp|.hwpx> \
//     --op insert|delete|insert-paragraph \
//     --section N --paragraph N [--offset N] [--text "..."] [--count N] \
//     --output <out.hwp>
//
// Body-text editing at a known (section, paragraph) position. This is the
// position-based sibling of replace.mjs (which is query-based): use it when
// you already know where the cursor goes — e.g. after locating a spot with
// read.mjs / info.mjs. Three operations:
//
//   insert            → insertText(sec, para, offset, text)   inserts `text`
//                       at char `offset` (default 0).
//   delete            → deleteText(sec, para, offset, count)  removes `count`
//                       chars starting at `offset` (default offset 0, count 1).
//   insert-paragraph  → insertParagraph(sec, para)            opens a new empty
//                       paragraph at index `para` in the section.
//
// Why these primitives and not replaceAll: on a genuine .hwp the engine caches
// the original section bytes (raw_stream) and the serializer emits those
// verbatim, dropping IR edits — UNLESS the editing call nulled raw_stream.
// insertText / deleteText / insertParagraph all null it, so they survive the
// .hwp save→reload round-trip; replaceAll does not (spec rules 9–13). We never
// touch replaceAll here.
//
// CORE-TIER: WASM-only. No rhwp CLI, no capabilities/requireCli. Behaves
// identically on claude.ai / cowork / code.
//
// Output is ALWAYS .hwp. The save is routed through exportVerify (which calls
// assertHwpOutput) so a `.hwpx` target fails fast and, more importantly, every
// write is CONFIRMED on save→reload — an edit the serializer silently dropped
// is reported as verified:false and exits CORRUPTION, never as success.
//
// Verification strategy per op:
//   • insert           → expectPresent:[text] (case-sensitive). The reload must
//                        show the inserted text or the edit was dropped.
//   • delete           → no reliable absence assertion (the deleted substring
//                        may legitimately recur elsewhere in the document), so
//                        we assert the doc simply round-trips (export→reload
//                        without throwing). exportVerify with empty
//                        expectations still performs that reload and confirms
//                        the output is a loadable .hwp.
//   • insert-paragraph → likewise a structural edit with no text to probe;
//                        verified by clean round-trip.
//
// Prints a one-line JSON result on success:
//   { ok, op, section, paragraph, offset?, text?, count?, verified, outputPath }

import { loadDocument } from "../lib/_bootstrap.mjs";
import { EXIT, fail } from "../lib/exit-codes.mjs";
import { exportVerify } from "../lib/verify.mjs";

const USAGE =
  "usage: edit_text.mjs <input> --op insert|delete|insert-paragraph " +
  "--section N --paragraph N [--offset N] [--text <text>] [--count N] --output <out.hwp>";

// Minimal option parser in the style of the sibling core scripts: one
// positional input, the rest are `--name value` pairs. We collect raw strings
// and validate/coerce after, so error messages can be specific.
let inputPath = null;
let op = null;
let output = null;
let section = null;
let paragraph = null;
let offset = null;
let text = null;
let count = null;

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "-h" || a === "--help") {
    process.stdout.write(USAGE + "\n");
    process.exit(EXIT.OK);
  } else if (a === "--op") op = argv[++i];
  else if (a === "--output") output = argv[++i];
  else if (a === "--section") section = argv[++i];
  else if (a === "--paragraph") paragraph = argv[++i];
  else if (a === "--offset") offset = argv[++i];
  else if (a === "--text") text = argv[++i];
  else if (a === "--count") count = argv[++i];
  else if (a.startsWith("-")) {
    fail(EXIT.USAGE, `error: unknown option ${a}\n${USAGE}`);
  } else if (inputPath === null) {
    inputPath = a;
  } else {
    fail(EXIT.USAGE, `error: unexpected argument ${a}\n${USAGE}`);
  }
}

// Parse a required non-negative integer option, failing with a clear message
// rather than letting a NaN/garbage value reach the WASM engine (where it
// surfaces as an opaque Rust panic / JSON.parse failure).
function reqInt(name, raw) {
  const n = Number(raw);
  if (raw === null || raw === undefined || !Number.isInteger(n) || n < 0) {
    fail(EXIT.USAGE, `error: --${name} must be a non-negative integer (got ${JSON.stringify(raw)})\n${USAGE}`);
  }
  return n;
}

if (!inputPath) fail(EXIT.USAGE, USAGE);
if (!op) fail(EXIT.USAGE, `error: --op is required\n${USAGE}`);
if (!["insert", "delete", "insert-paragraph"].includes(op)) {
  fail(EXIT.USAGE, `error: --op must be insert|delete|insert-paragraph (got ${JSON.stringify(op)})\n${USAGE}`);
}
if (!output) fail(EXIT.USAGE, `error: --output is required\n${USAGE}`);

const sec = reqInt("section", section);
const para = reqInt("paragraph", paragraph);

// Per-op required-option validation. Defaults mirror the primitive semantics:
// insert/delete offset defaults to 0; delete count defaults to 1.
let off = 0;
let cnt = 1;
if (op === "insert") {
  if (text === null) fail(EXIT.USAGE, `error: --op insert requires --text\n${USAGE}`);
  off = offset === null ? 0 : reqInt("offset", offset);
} else if (op === "delete") {
  off = offset === null ? 0 : reqInt("offset", offset);
  cnt = count === null ? 1 : reqInt("count", count);
  if (cnt < 1) fail(EXIT.USAGE, `error: --count must be >= 1 for delete (got ${cnt})\n${USAGE}`);
}
// insert-paragraph needs only --section/--paragraph (already parsed).

let doc;
try {
  doc = await loadDocument(inputPath);
} catch (e) {
  fail(EXIT.LOAD, `error: could not load ${inputPath}: ${e?.message ?? e}`);
}

// Pre-validate the (section, paragraph) address so an out-of-range index
// fails with a readable message instead of an undefined return / JSON.parse
// crash from the WASM layer. For insert-paragraph the new paragraph may be
// appended at index == paragraphCount, so its upper bound is inclusive.
const sectionCount = doc.getSectionCount();
if (sec >= sectionCount) {
  fail(EXIT.NOT_FOUND, `error: section ${sec} out of range (document has ${sectionCount} section(s))`);
}
const paraCount = doc.getParagraphCount(sec);
const paraUpper = op === "insert-paragraph" ? paraCount : paraCount - 1;
if (para > paraUpper || para < 0) {
  fail(
    EXIT.NOT_FOUND,
    `error: paragraph ${para} out of range for section ${sec} ` +
      `(valid 0..${paraUpper}${op === "insert-paragraph" ? " inclusive" : ""})`,
  );
}

// Apply the edit. Each primitive returns a JSON string `{"ok":true,...}`;
// a dropped/failed engine call surfaces as `undefined` (Rust panic) → the
// JSON.parse throws and we report it as a hard failure rather than pretending
// success. The authoritative success signal is still the exportVerify round
// trip below — this guards the in-memory call only.
let applied;
try {
  let raw;
  if (op === "insert") {
    raw = doc.insertText(sec, para, off, text);
  } else if (op === "delete") {
    raw = doc.deleteText(sec, para, off, cnt);
  } else {
    raw = doc.insertParagraph(sec, para);
  }
  applied = JSON.parse(raw);
} catch (e) {
  fail(EXIT.CORRUPTION, `error: engine rejected ${op} at (sec=${sec}, para=${para}): ${e?.message ?? e}`);
}
if (!applied || applied.ok !== true) {
  fail(EXIT.CORRUPTION, `error: engine reported failure for ${op}: ${JSON.stringify(applied)}`);
}

// Round-trip verification (universal edit contract). insert asserts the text
// reappears on reload; delete and insert-paragraph have no unique text to
// probe, so an empty expectation set still forces the export→reload and
// confirms the output is a valid, loadable .hwp.
const expectPresent = op === "insert" ? [text] : [];
let result;
try {
  result = await exportVerify(doc, output, { expectPresent, caseSensitive: true });
} catch (e) {
  // assertHwpOutput throws via fail() (exit 2) for .hwpx targets; any other
  // throw here means the export or reload itself failed → corruption.
  fail(EXIT.CORRUPTION, `error: export/verify failed: ${e?.message ?? e}`);
}

if (!result.verified) {
  // The engine accepted the edit in memory but the .hwp round-trip dropped it.
  // Per the universal edit contract this is a FAILED task, never success.
  process.stdout.write(JSON.stringify(result) + "\n");
  fail(
    EXIT.CORRUPTION,
    `error: round-trip verification FAILED — the ${op} edit did not survive save→reload.\n` +
      `       The rhwp serializer dropped it (upstream bug). Do not deliver ${output}.`,
  );
}

const summary = {
  ok: true,
  op,
  section: sec,
  paragraph: para,
  ...(op === "insert" ? { offset: off, text } : {}),
  ...(op === "delete" ? { offset: off, count: cnt } : {}),
  charOffset: applied.charOffset,
  verified: true,
  bytesWritten: result.bytesWritten,
  outputPath: result.outputPath,
};
process.stdout.write(JSON.stringify(summary) + "\n");
