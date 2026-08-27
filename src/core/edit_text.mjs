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
//                       at char `offset` (default 0). With --format, the
//                       inserted characters are then formatted (see below).
//   delete            → deleteText(sec, para, offset, count)  removes `count`
//                       chars starting at `offset` (default offset 0, count 1).
//   insert-paragraph  → insertParagraph(sec, para)            opens a new empty
//                       paragraph at index `para` in the section.
//
// --format '<json>' — INSERTED TEXT INHERITS THE ANCHOR OTHERWISE.
//
// insertText takes no formatting argument, so the engine gives the new text the
// formatting of the character BEFORE the insertion point (at offset 0, the one
// after). That is spec rule 63, and it is why a sentence added next to a bold
// heading arrives entirely bold. --format takes the same character-property
// JSON that format.mjs --op char accepts — one vocabulary, so what you read
// from a document can be written straight back:
//
//   --format '{"bold":true}'   --format '{"italic":true,"textColor":"#c00000"}'
//
// THE RANGE IS MEASURED, NOT COMPUTED. The formatted span is
// [offset, offset + delta) where delta is getParagraphLength AFTER minus
// BEFORE. It is deliberately not offset + text.length: JS string length counts
// a surrogate pair as 2 and the engine counts it as 1, so "테스트🙂끝" is 6 in
// JS and 5 in the document, and text.length would format one character that
// was never inserted. Asking the engine removes the assumption entirely.
//
// Why these primitives rather than a search-and-replace: they are positional.
// This script edits at coordinates the caller already knows, so there is no
// query to match and nothing to disambiguate. insertText / deleteText /
// insertParagraph all null the section's raw_stream cache, so they survive the
// .hwp save→reload round-trip (spec rules 12–13); exportVerify proves it.
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
// With --format it also carries { format, formattedRange, effect } — `effect`
// is the same per-key verdict format.mjs reports, read back from the SAVED
// file, so a property the engine accepted and ignored is visible.

import { loadDocument } from "../lib/_bootstrap.mjs";
import { EXIT, fail } from "../lib/exit-codes.mjs";
import { classifyEffect, validateProps } from "../lib/format_props.mjs";
import { assertMemoSafe } from "../lib/memo.mjs";
import { assertTrackChangeSafe } from "../lib/trackchange.mjs";
import { exportVerify } from "../lib/verify.mjs";

const USAGE =
  "usage: edit_text.mjs <input> --op insert|delete|insert-paragraph " +
  "--section N --paragraph N [--offset N] [--text <text>] [--count N] " +
  "[--format '<char-props json>'] [--allow-unknown-props] --output <out.hwp>";

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
let formatRaw = null;
let allowUnknownProps = false;

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
  else if (a === "--format") formatRaw = argv[++i];
  else if (a === "--allow-unknown-props") allowUnknownProps = true;
  // A bare boolean, read straight from process.argv by assertTrackChangeSafe
  // (lib/trackchange.mjs). It is named here only so this script's strict parser
  // does not reject the guard's own documented override as an unknown option.
  else if (a === "--allow-trackchange-loss") {
  } else if (a.startsWith("-")) {
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

// --format is validated BEFORE the document is touched, so a bad property is a
// usage error that writes no file — same contract as format.mjs.
let formatProps = null;
if (formatRaw !== null) {
  if (op !== "insert") {
    fail(
      EXIT.USAGE,
      `error: --format applies only to --op insert (got --op ${op}).\n` +
        `       --op delete removes text, and --op insert-paragraph creates an EMPTY\n` +
        `       paragraph — character formatting on a paragraph with no characters is\n` +
        `       silently ignored by the engine (spec rule 62). To format a new\n` +
        `       paragraph, insert-paragraph first, then insert its text --format.\n${USAGE}`,
    );
  }
  try {
    formatProps = JSON.parse(formatRaw);
  } catch (e) {
    fail(EXIT.USAGE, `error: --format is not valid JSON: ${e?.message ?? e}\n${USAGE}`);
  }
  if (formatProps === null || typeof formatProps !== "object" || Array.isArray(formatProps)) {
    fail(EXIT.USAGE, `error: --format must be a JSON object, got ${JSON.stringify(formatProps)}\n${USAGE}`);
  }
  // Character properties only: the span being formatted is a run of characters,
  // not a paragraph. A paragraph key here is a routing mistake worth naming.
  const { errors, warnings } = validateProps("char", formatProps, {
    allowUnknown: allowUnknownProps,
  });
  if (errors.length) {
    fail(
      EXIT.USAGE,
      `error: --format rejected (the engine reports success for these and applies nothing):\n` +
        errors.map((e) => `  - ${e}`).join("\n"),
    );
  }
  for (const w of warnings) process.stderr.write(`WARNING: ${w}\n`);
  if (text === "") {
    fail(EXIT.USAGE, `error: --format with empty --text would format nothing\n${USAGE}`);
  }
}

// Refuse a memo-bearing input (the engine drops memos on save) unless the
// caller passed --allow-memo-loss. No-op on memo-free inputs.
assertMemoSafe(inputPath, process.argv);
// Same contract for tracked changes (변경 내용 추적): the engine does not model
// them either, so an edit destroys every recorded change AND the original text
// each deletion still holds. Override: --allow-trackchange-loss.
assertTrackChangeSafe(inputPath, process.argv);

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
// Measured across the insert, never computed from text.length — see the header.
let lenBefore = null;
let formattedRange = null;
let beforeProps = null;
try {
  let raw;
  if (op === "insert") {
    if (formatProps) {
      lenBefore = doc.getParagraphLength(sec, para);
      // The pre-edit properties at the anchor, for the effect report: this is
      // the formatting the inserted text would have INHERITED, which is the
      // baseline a caller cares about when asking "did --format do anything?".
      const probe = lenBefore > 0 ? Math.max(0, Math.min(off, lenBefore) - 1) : 0;
      try {
        beforeProps = lenBefore > 0 ? JSON.parse(doc.getCharPropertiesAt(sec, para, probe)) : null;
      } catch {
        beforeProps = null;
      }
    }
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

// Format exactly the characters that were inserted. The span comes from the
// engine's own length accounting, so astral characters (a surrogate pair is 2
// in JS and 1 here) cannot push the end past the insertion.
if (formatProps) {
  const lenAfter = doc.getParagraphLength(sec, para);
  const delta = lenAfter - lenBefore;
  if (delta <= 0) {
    fail(
      EXIT.CORRUPTION,
      `error: --format could not be applied — the paragraph length did not grow ` +
        `(${lenBefore} → ${lenAfter}) after inserting ${JSON.stringify(text)}. ` +
        `Formatting a zero-width range would silently do nothing.`,
    );
  }
  formattedRange = { start: off, end: off + delta };
  let fr;
  try {
    fr = JSON.parse(doc.applyCharFormat(sec, para, off, off + delta, JSON.stringify(formatProps)));
  } catch (e) {
    fail(EXIT.CORRUPTION, `error: engine rejected --format on the inserted span: ${e?.message ?? e}`);
  }
  if (!fr || fr.ok !== true) {
    fail(EXIT.CORRUPTION, `error: engine reported failure for --format: ${JSON.stringify(fr)}`);
  }
  // A tab carries no character shape, so it never takes the formatting. Say so
  // rather than letting the effect report look inexplicably partial.
  if (text.includes("\t")) {
    process.stderr.write(
      "WARNING: the inserted text contains a tab; tabs do not take character " +
        "formatting, so that position stays as it was.\n",
    );
  }
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

// --format is not text-probeable, so exportVerify's clean round-trip is not by
// itself proof the formatting stuck. Re-read the inserted span from the SAVED
// file and report a per-key verdict, the same way format.mjs does. This is the
// check that catches an engine that accepted a property and dropped it on save.
let effect = null;
if (formatProps) {
  try {
    const back = await loadDocument(result.outputPath);
    const afterProps = JSON.parse(back.getCharPropertiesAt(sec, para, off));
    effect = {};
    for (const [key, want] of Object.entries(formatProps)) {
      effect[key] = classifyEffect(key, want, beforeProps, afterProps);
    }
    const dead = Object.entries(effect).filter(([, v]) => v === "no-effect");
    if (dead.length) {
      process.stdout.write(JSON.stringify({ ...result, effect }) + "\n");
      fail(
        EXIT.CORRUPTION,
        `error: the text was inserted but --format did NOT take on disk: ` +
          `${dead.map(([k]) => k).join(", ")}.\n` +
          `       The engine reported success for it. Do not deliver ${output}.`,
      );
    }
  } catch (e) {
    if (e?.code === "ERR_FAIL") throw e;
    fail(
      EXIT.CORRUPTION,
      `error: could not confirm --format from the saved file: ${e?.message ?? e}`,
    );
  }
}

const summary = {
  ok: true,
  op,
  section: sec,
  paragraph: para,
  ...(op === "insert" ? { offset: off, text } : {}),
  ...(op === "delete" ? { offset: off, count: cnt } : {}),
  ...(formatProps ? { format: formatProps, formattedRange, effect } : {}),
  charOffset: applied.charOffset,
  verified: true,
  bytesWritten: result.bytesWritten,
  outputPath: result.outputPath,
};
process.stdout.write(JSON.stringify(summary) + "\n");
