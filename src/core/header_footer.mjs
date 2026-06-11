#!/usr/bin/env node
// Usage:
//   node src/core/header_footer.mjs <input> --op create|apply \
//     --section N (--header | --footer) --apply-to 0|1|2 \
//     [--template N] [--text "..."] --output <out.hwp>
//
// Adds or replaces a header/footer on one section of an HWP document.
//
//   --op create   → createHeaderFooter(section, is_header, apply_to). Makes a
//                   fresh header/footer holding one empty paragraph. If --text
//                   is given, the text is then inserted into that paragraph via
//                   insertTextInHeaderFooter(...,0,0,text).
//   --op apply    → applyHfTemplate(section, is_header, apply_to, template_id).
//                   Applies one of the engine's built-in header/footer layout
//                   templates (template_id 0..3 on 0.7.15; an unknown id throws
//                   "알 수 없는 템플릿 ID"). applyHfTemplate materializes the
//                   header/footer if the section has none, so --text is also
//                   honored after apply (same insert path as create).
//
// --apply-to picks which pages the header/footer binds to. The engine maps the
// value to a page-type label (0="양 쪽"/both, 1="짝수 쪽"/even, 2="홀수 쪽"/odd).
// NOTE on spec rule 28: the keystone spec documents applyHfTemplate's apply_to
// as 0=first-only, 1=all, 2=all-but-first. On 0.7.15 the value is surfaced as
// the HWP page-type enum (both/even/odd) on the returned `label`. We pass the
// value through unchanged and echo the engine's label so the agent sees exactly
// what the engine bound; we do not silently remap it. Values outside {0,1,2}
// are rejected up front (the engine would otherwise accept e.g. 9 and default
// the label to "양 쪽", which would be a silent surprise).
//
// MULTI-SECTION (spec rule 28): a header/footer is NOT auto-propagated to other
// sections. This script touches exactly the one --section you name; to cover a
// multi-section document, run it once per section.
//
// Output is ALWAYS .hwp (assertHwpOutput refuses .hwpx — Hancom Office rejects
// rhwp-produced HWPX). .hwpx INPUT is fine: exportHwp runs the engine's
// HWPX→HWP adapter (verified: create+text on a .hwpx input survives the
// .hwp round-trip).
//
// VERIFICATION (important): the round-trip probe used elsewhere
// (verify.mjs/probeTextCount, which drives exportVerify's expectPresent) is
// built on replaceAll search, and that search does NOT reach into header/footer
// paragraphs — so header text reads back as count=0 even when it is present and
// correct on disk. We therefore verify header/footer edits authoritatively by
// reloading the saved file and asking getHeaderFooter(section, is_header,
// apply_to): we require exists===true, and when --text was given we require the
// reloaded `text` to contain it. exportVerify is still called (with no text
// expectations) so the write goes through the same atomic-write + .hwpx-guard +
// structural reload path as every other editing script; its `verified` and our
// header/footer `verified` are AND-combined. A failed check is a hard failure
// (EXIT.CORRUPTION) — a dropped header/footer is a FAILED task, never success.

import { loadDocument } from "../lib/_bootstrap.mjs";
import { EXIT, fail } from "../lib/exit-codes.mjs";
import { assertMemoSafe } from "../lib/memo.mjs";
import { exportVerify } from "../lib/verify.mjs";

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
}
function flag(name) {
  return process.argv.includes(name);
}

const USAGE =
  "usage: header_footer.mjs <input> --op create|apply --section N " +
  "(--header | --footer) --apply-to 0|1|2 [--template N] [--text \"...\"] " +
  "--output <out.hwp>";

const input = process.argv[2];
const op = arg("--op");
const sectionArg = arg("--section");
const applyToArg = arg("--apply-to");
const templateArg = arg("--template");
const text = arg("--text"); // optional; undefined means "no text"
const output = arg("--output");
const isHeaderFlag = flag("--header");
const isFooterFlag = flag("--footer");

// ---- argument validation (USAGE = exit 2) ---------------------------------
if (!input || !op || !output) fail(EXIT.USAGE, USAGE);
if (op !== "create" && op !== "apply")
  fail(EXIT.USAGE, `error: --op must be 'create' or 'apply' (got ${JSON.stringify(op)})\n${USAGE}`);
if (isHeaderFlag === isFooterFlag)
  fail(EXIT.USAGE, `error: pass exactly one of --header or --footer\n${USAGE}`);
const isHeader = isHeaderFlag;

if (sectionArg === undefined) fail(EXIT.USAGE, `error: --section N is required\n${USAGE}`);
const section = Number(sectionArg);
if (!Number.isInteger(section) || section < 0)
  fail(EXIT.USAGE, `error: --section must be a non-negative integer (got ${JSON.stringify(sectionArg)})`);

if (applyToArg === undefined) fail(EXIT.USAGE, `error: --apply-to 0|1|2 is required\n${USAGE}`);
const applyTo = Number(applyToArg);
if (![0, 1, 2].includes(applyTo))
  fail(
    EXIT.USAGE,
    `error: --apply-to must be 0, 1, or 2 (got ${JSON.stringify(applyToArg)}).\n` +
      `       0=both/양 쪽, 1=even/짝수 쪽, 2=odd/홀수 쪽 (engine page-type label).`,
  );

// --template only meaningful for --op apply; require it there, reject it elsewhere.
let templateId = 0;
if (op === "apply") {
  if (templateArg === undefined)
    fail(EXIT.USAGE, `error: --op apply requires --template N (built-in layout id, 0..3 on 0.7.15)`);
  templateId = Number(templateArg);
  if (!Number.isInteger(templateId) || templateId < 0)
    fail(EXIT.USAGE, `error: --template must be a non-negative integer (got ${JSON.stringify(templateArg)})`);
} else if (templateArg !== undefined) {
  fail(EXIT.USAGE, `error: --template is only valid with --op apply (create makes an empty header/footer)`);
}

// Refuse a memo-bearing input (the engine drops memos on save) unless the
// caller passed --allow-memo-loss. No-op on memo-free inputs.
assertMemoSafe(input, process.argv);

const doc = await loadDocument(input);

// Bound-check the section against the loaded document so we throw a clean
// usage error instead of letting the WASM engine raise "구역 인덱스 N 범위 초과".
const sectionCount = doc.getSectionCount();
if (section >= sectionCount)
  fail(
    EXIT.NOT_FOUND,
    `error: section ${section} out of range — document has ${sectionCount} section(s) [0..${sectionCount - 1}].`,
  );

const kind = isHeader ? "header" : "footer";

// ---- perform the create / apply -------------------------------------------
// Both engine calls return a JSON string; an out-of-range section or unknown
// template id throws (caught below). create returns rich metadata; applyHfTemplate
// returns just {"ok":true}. We don't depend on the shape beyond `ok`.
let opResult;
try {
  const raw =
    op === "create"
      ? doc.createHeaderFooter(section, isHeader, applyTo)
      : doc.applyHfTemplate(section, isHeader, applyTo, templateId);
  opResult = JSON.parse(raw);
} catch (e) {
  // e.g. unknown template id, or any engine-side rejection.
  fail(EXIT.UNSUPPORTED, `error: ${kind} ${op} failed — ${String(e.message ?? e)}`);
}
if (!opResult || opResult.ok !== true)
  fail(EXIT.UNSUPPORTED, `error: ${kind} ${op} returned non-ok: ${JSON.stringify(opResult)}`);

// ---- optional text insertion ----------------------------------------------
// Both create and apply leave a header/footer with at least one paragraph
// (index 0). Insert the requested text at the start of that first paragraph.
if (text !== undefined && text !== "") {
  let ins;
  try {
    ins = JSON.parse(doc.insertTextInHeaderFooter(section, isHeader, applyTo, 0, 0, text));
  } catch (e) {
    fail(EXIT.UNSUPPORTED, `error: inserting --text into ${kind} failed — ${String(e.message ?? e)}`);
  }
  if (!ins || ins.ok !== true)
    fail(EXIT.UNSUPPORTED, `error: inserting --text into ${kind} returned non-ok: ${JSON.stringify(ins)}`);
}

// ---- write through exportVerify, then authoritatively verify the H/F ------
// exportVerify gives us the atomic write, the .hwpx-output guard, and a clean
// structural reload. We pass NO text expectations because probeTextCount cannot
// see header/footer paragraphs (see header comment) — a stale false negative
// would be worse than no check. Our real verification is the getHeaderFooter
// reload below.
const result = await exportVerify(doc, output, {});
if (!result.verified) {
  // The save itself (or some other expectation) failed the round-trip.
  process.stdout.write(JSON.stringify(result) + "\n");
  fail(EXIT.CORRUPTION, `error: export round-trip verification failed for ${output}`);
}

// Authoritative header/footer check: reload from disk and confirm the
// header/footer materialized (and carries the requested text).
const reloaded = await loadDocument(output);
let hf;
try {
  hf = JSON.parse(reloaded.getHeaderFooter(section, isHeader, applyTo));
} catch (e) {
  fail(EXIT.CORRUPTION, `error: could not read back ${kind} after save — ${String(e.message ?? e)}`);
}

const existsOk = hf && hf.ok === true && hf.exists === true;
// text-presence check: getHeaderFooter returns the joined paragraph text.
const textOk = text === undefined || text === "" ? true : typeof hf?.text === "string" && hf.text.includes(text);
const hfVerified = !!existsOk && textOk;

const summary = {
  ok: true,
  input,
  op,
  kind,
  section,
  applyTo,
  label: hf?.label, // engine page-type label (양 쪽 / 짝수 쪽 / 홀수 쪽)
  template: op === "apply" ? templateId : undefined,
  textInserted: text !== undefined && text !== "" ? text : undefined,
  reloadedText: typeof hf?.text === "string" ? hf.text : undefined,
  multiSection: sectionCount > 1 ? "not auto-propagated — run once per section (spec rule 28)" : undefined,
  verified: hfVerified,
  bytesWritten: result.bytesWritten,
  outputPath: output,
};

if (!hfVerified) {
  process.stdout.write(JSON.stringify(summary) + "\n");
  const why = !existsOk
    ? `${kind} not present after save→reload`
    : `${kind} text did not contain ${JSON.stringify(text)} after save→reload`;
  fail(EXIT.CORRUPTION, `error: header/footer verification failed — ${why}.`);
}

process.stdout.write(JSON.stringify(summary) + "\n");
