#!/usr/bin/env node
// Usage:
//   node src/core/footnote.mjs <input> --op insert --section N --paragraph N \
//     [--offset N] [--text "..."] --output <out.hwp>
//   node src/core/footnote.mjs <input> --op delete --section N --paragraph N \
//     --control N --output <out.hwp>
//
// Inserts or deletes a footnote and saves the result as .hwp (never .hwpx —
// Hancom Office rejects rhwp-produced HWPX; see assertHwpOutput).
//
//   --op insert  → insertFootnote(sec, para, offset). Returns
//                  {ok, paraIdx, controlIdx, footnoteNumber}. The returned
//                  controlIdx is the body-paragraph control index of the new
//                  footnote marker — capture it for later edits/deletes.
//                  With --text, the string is then inserted into the footnote
//                  BODY via insertTextInFootnote(sec, para, controlIdx, 0, 0,
//                  text). (Empirically: both the marker AND the body text
//                  survive the .hwp round-trip — confirmed by reloading and
//                  re-reading getFootnoteInfo. See the verification note below.)
//   --op delete  → deleteFootnote(sec, para, controlIdx). Returns
//                  {ok, ..., deletedNumber}. --control is the footnote's
//                  body-paragraph control index (the controlIdx from a prior
//                  insert, or one discovered with getFootnoteInfo).
//
// VERIFICATION — why this script does NOT use exportVerify's text probe:
// exportVerify confirms presence/absence with probeTextCount, which is built
// on the engine's replaceAll/search_all. That search walks the body, table
// cells, and textboxes but NOT footnote bodies, so footnote body text is
// invisible to it (a clean round-trip would still read verified:false). The
// authoritative footnote getter is getFootnoteInfo(sec, para, ctrlIdx) →
// {ok, paraCount, totalTextLen, number, texts[]}. We therefore:
//   1. count footnotes across the whole document (probing getFootnoteInfo on
//      every body control) BEFORE the edit,
//   2. route the save through exportVerify (so assertHwpOutput runs, the write
//      is atomic, and the file is reloaded from disk),
//   3. re-count footnotes on the RELOADED document and assert the count moved
//      the right way (insert: +1; delete: -1), and for insert+--text also
//      assert the reloaded footnote body actually contains the text.
// A failed assertion is a CORRUPTION exit — a dropped edit is never reported
// as success (universal edit contract, spec rules 2/9).
//
// CORE-TIER: WASM-only. No rhwp CLI, no capabilities/requireCli.

import { loadDocument } from "../lib/_bootstrap.mjs";
import { exportVerify } from "../lib/verify.mjs";
import { EXIT, fail } from "../lib/exit-codes.mjs";
import { assertMemoSafe } from "../lib/memo.mjs";

const USAGE =
  "usage: footnote.mjs <input> --op insert|delete --section N --paragraph N\n" +
  "                    [--offset N] [--control N] [--text \"...\"] --output <out.hwp>";

// --- option parsing (mirrors the replace.mjs/fill_form.mjs style) ----------
function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
// Parse a required non-negative integer option; fail with USAGE otherwise.
function intArg(name, { required = false } = {}) {
  const raw = arg(name);
  if (raw === undefined) {
    if (required) fail(EXIT.USAGE, `error: ${name} is required\n${USAGE}`);
    return undefined;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    fail(EXIT.USAGE, `error: ${name} must be a non-negative integer (got ${JSON.stringify(raw)})\n${USAGE}`);
  }
  return n;
}

const input = process.argv[2];
const op = arg("--op");
const output = arg("--output");
const text = arg("--text");

if (process.argv.includes("-h") || process.argv.includes("--help")) {
  process.stdout.write(USAGE + "\n");
  process.exit(EXIT.OK);
}
if (!input || input.startsWith("-")) fail(EXIT.USAGE, USAGE);
if (op !== "insert" && op !== "delete") {
  fail(EXIT.USAGE, `error: --op must be 'insert' or 'delete'\n${USAGE}`);
}
if (!output) fail(EXIT.USAGE, `error: --output is required\n${USAGE}`);

const section = intArg("--section", { required: true });
const paragraph = intArg("--paragraph", { required: true });
const offset = intArg("--offset") ?? 0; // insert position in the body paragraph
const control = intArg("--control"); // required for delete

// --- footnote counting helper ----------------------------------------------
// The only doc-wide "footnote count getter" the engine exposes is to probe
// getFootnoteInfo on every body control; it returns {ok:true,...} for a
// footnote control and throws (undefined → JSON.parse fail) for anything
// else. Cheap on the fixtures; bounded by control count per paragraph.
function countFootnotes(doc) {
  let n = 0;
  for (let s = 0; s < doc.getSectionCount(); s++) {
    const pCount = doc.getParagraphCount(s);
    for (let p = 0; p < pCount; p++) {
      let ctrls = 0;
      try {
        ctrls = JSON.parse(doc.getControlTextPositions(s, p)).length;
      } catch {
        ctrls = 0;
      }
      for (let c = 0; c < ctrls; c++) {
        try {
          const fi = JSON.parse(doc.getFootnoteInfo(s, p, c));
          if (fi && fi.ok) n++;
        } catch {
          /* not a footnote control */
        }
      }
    }
  }
  return n;
}

// Refuse a memo-bearing input (the engine drops memos on save) unless the
// caller passed --allow-memo-loss. No-op on memo-free inputs.
assertMemoSafe(input, process.argv);

// --- load -------------------------------------------------------------------
let doc;
try {
  doc = await loadDocument(input);
} catch (e) {
  fail(EXIT.LOAD, `error: could not load ${input}: ${e?.message ?? e}`);
}

if (section >= doc.getSectionCount()) {
  fail(EXIT.NOT_FOUND, `error: section ${section} out of range (document has ${doc.getSectionCount()})`);
}
if (paragraph >= doc.getParagraphCount(section)) {
  fail(
    EXIT.NOT_FOUND,
    `error: paragraph ${paragraph} out of range (section ${section} has ${doc.getParagraphCount(section)})`,
  );
}

const before = countFootnotes(doc);

// --- perform the edit -------------------------------------------------------
let controlIdx; // the footnote marker's control index (for the JSON summary)
let footnoteNumber;
let deletedNumber;

if (op === "insert") {
  // insertFootnote → {ok, paraIdx, controlIdx, footnoteNumber}. The engine
  // throws (surfaced as undefined → JSON.parse fail) on an invalid target.
  let res;
  try {
    res = JSON.parse(doc.insertFootnote(section, paragraph, offset));
  } catch {
    fail(
      EXIT.UNSUPPORTED,
      `error: insertFootnote(${section}, ${paragraph}, ${offset}) failed — ` +
        `the engine rejected this position (offset out of range, or this paragraph cannot host a footnote).`,
    );
  }
  if (!res || res.ok !== true) {
    fail(EXIT.UNSUPPORTED, `error: insertFootnote returned ${JSON.stringify(res)}`);
  }
  controlIdx = res.controlIdx;
  footnoteNumber = res.footnoteNumber;

  // Optional footnote body text. insertTextInFootnote(sec, para, ctrlIdx,
  // fn_para_idx=0, char_offset=0, text). The fresh footnote body has a single
  // paragraph (paraCount=1), so fn_para_idx 0 / offset 0 is the start.
  if (text !== undefined) {
    try {
      const t = JSON.parse(doc.insertTextInFootnote(section, paragraph, controlIdx, 0, 0, text));
      if (!t || t.ok !== true) {
        fail(EXIT.UNSUPPORTED, `error: insertTextInFootnote returned ${JSON.stringify(t)}`);
      }
    } catch (e) {
      fail(EXIT.UNSUPPORTED, `error: insertTextInFootnote failed: ${e?.message ?? e}`);
    }
  }
} else {
  // delete: --control identifies the footnote's body-paragraph control index.
  if (control === undefined) {
    fail(EXIT.USAGE, `error: --control N is required for --op delete (the footnote marker's control index)\n${USAGE}`);
  }
  // Guard: confirm the target control is actually a footnote before deleting,
  // so we return a clean NOT_FOUND instead of a raw engine panic.
  try {
    const fi = JSON.parse(doc.getFootnoteInfo(section, paragraph, control));
    if (!fi || fi.ok !== true) throw new Error("not a footnote");
  } catch {
    fail(
      EXIT.NOT_FOUND,
      `error: no footnote at section ${section}, paragraph ${paragraph}, control ${control} ` +
        `(control index must be a footnote marker — use --op insert's reported controlIdx, or getFootnoteInfo).`,
    );
  }
  let res;
  try {
    res = JSON.parse(doc.deleteFootnote(section, paragraph, control));
  } catch (e) {
    fail(EXIT.UNSUPPORTED, `error: deleteFootnote failed: ${e?.message ?? e}`);
  }
  if (!res || res.ok !== true) {
    fail(EXIT.UNSUPPORTED, `error: deleteFootnote returned ${JSON.stringify(res)}`);
  }
  controlIdx = control;
  deletedNumber = res.deletedNumber;
}

// --- save + round-trip verify ----------------------------------------------
// Route the save through exportVerify (assertHwpOutput + atomic write + reload)
// with no text probe — footnote body text is invisible to probeTextCount (see
// the header note). We then re-count footnotes on the reloaded document and
// assert the count changed by the expected delta, which is the authoritative
// footnote-aware round-trip check.
let exp;
try {
  exp = await exportVerify(doc, output, {});
} catch (e) {
  fail(EXIT.CORRUPTION, `error: export failed: ${e?.message ?? e}`);
}

let reloaded;
try {
  reloaded = await loadDocument(output);
} catch (e) {
  fail(EXIT.CORRUPTION, `error: saved ${output} but could not reload it for verification: ${e?.message ?? e}`);
}
const after = countFootnotes(reloaded);
const expectedDelta = op === "insert" ? 1 : -1;
const countVerified = after - before === expectedDelta;

// For insert + --text, also confirm the footnote BODY actually carries the
// text after the round-trip (the marker can survive while the body is empty).
let textVerified = true;
if (op === "insert" && text !== undefined) {
  textVerified = false;
  try {
    const fi = JSON.parse(reloaded.getFootnoteInfo(section, paragraph, controlIdx));
    textVerified = Array.isArray(fi.texts) && fi.texts.some((s) => String(s).includes(text));
  } catch {
    textVerified = false;
  }
}

const verified = countVerified && textVerified;

const summary = {
  ok: true,
  op,
  input,
  outputPath: exp.outputPath,
  bytesWritten: exp.bytesWritten,
  section,
  paragraph,
  controlIdx,
  ...(op === "insert" ? { offset, footnoteNumber } : { deletedNumber }),
  ...(op === "insert" && text !== undefined ? { text, textVerified } : {}),
  footnotesBefore: before,
  footnotesAfter: after,
  verified,
};

if (!verified) {
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  fail(
    EXIT.CORRUPTION,
    `error: round-trip verification FAILED — footnote count went ${before} → ${after} ` +
      `(expected delta ${expectedDelta})${op === "insert" && text !== undefined && !textVerified ? " and/or footnote body text was dropped" : ""}. ` +
      `The engine accepted the edit in memory but it did not survive save→reload. Treat the task as FAILED.`,
  );
}

process.stdout.write(JSON.stringify(summary) + "\n");
