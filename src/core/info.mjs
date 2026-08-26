#!/usr/bin/env node
// Usage: node src/core/info.mjs <input.hwp|.hwpx> [--validate]
//
// Prints a JSON summary of the document: source format, engine version,
// page/section counts, fonts used, per-page width/height/section, a
// hasTable flag, and a table/field count. With --validate, also runs the
// engine's structural anomaly check and includes a `validation` object.
//
// Use this first when you open an unfamiliar document — the JSON is small
// and tells you whether the doc is HWP or HWPX, how many pages exist, and
// where to address edits (sections are 0-indexed; many edit APIs need a
// section_idx). Run it with --validate before extracting to surface
// structural anomalies (empty/uncomputed line segments) up front.
//
// CORE-TIER: WASM-only. Behaves identically on claude.ai / cowork / code.
// Must NOT shell out to the rhwp CLI (that is the enhanced/ tier).

import { loadDocument, version, documentHasTable } from "../lib/_bootstrap.mjs";
import { EXIT, fail } from "../lib/exit-codes.mjs";
import { collectObjects } from "../lib/objects.mjs";
import { detectMemos } from "../lib/memo.mjs";

// Minimal option parsing: one positional input path plus an optional
// --validate flag. Kept deliberately small to match the port source.
let inputPath = null;
let validate = false;
for (const arg of process.argv.slice(2)) {
  if (arg === "--validate") validate = true;
  else if (arg === "-h" || arg === "--help") {
    process.stdout.write("usage: info.mjs <input.hwp|.hwpx> [--validate]\n");
    process.exit(EXIT.OK);
  } else if (arg.startsWith("-")) {
    fail(EXIT.USAGE, `error: unknown option ${arg}\nusage: info.mjs <input.hwp|.hwpx> [--validate]`);
  } else if (inputPath === null) {
    inputPath = arg;
  } else {
    fail(EXIT.USAGE, `error: unexpected argument ${arg}\nusage: info.mjs <input.hwp|.hwpx> [--validate]`);
  }
}
if (!inputPath) {
  fail(EXIT.USAGE, "usage: info.mjs <input.hwp|.hwpx> [--validate]");
}

let doc;
try {
  doc = await loadDocument(inputPath);
} catch (e) {
  fail(EXIT.LOAD, `error: could not load ${inputPath}: ${e?.message ?? e}`);
}

// getDocumentInfo already carries version/section/page counts plus
// fontsUsed and the encryption flag; surface it as the `info` block and
// also lift fonts/dimensions to the top level for a lean at-a-glance read.
const info = JSON.parse(doc.getDocumentInfo());
const sourceFormat = doc.getSourceFormat();

const pageCount = doc.pageCount();
const pages = [];
for (let i = 0; i < pageCount; i++) {
  pages.push(JSON.parse(doc.getPageInfo(i)));
}

// Field count (forms): getFieldList returns "[]" on a doc with no fields;
// guard the parse so a non-form doc still produces clean output.
let fields = [];
try {
  fields = JSON.parse(doc.getFieldList());
} catch {
  fields = [];
}

// Memo (메모/주석) count, read straight from the container (the engine has no
// memo API). Surfaced here so the standard "inspect first" step always reveals
// memos — they are invisible to body-text extraction and are destroyed by an
// edit to their section, so an agent must know they exist.
let memoCount = 0;
try {
  memoCount = detectMemos(inputPath).count;
} catch {
  memoCount = 0;
}

// Object counts. Images were invisible to every read path: a document could
// carry a dozen and nothing in the skill's output said so. `overlayCount` is
// broken out because a watermark or stamp is not content a reader is missing
// — it has no place in the body at all — while an ordinary image is.
// geometry:"never" keeps this cheap; info.mjs is the "open an unfamiliar file"
// command and must not pay for page layout.
let imageCount = 0;
let overlayCount = 0;
try {
  const objectModel = await collectObjects(doc, { geometry: "never" });
  overlayCount = objectModel.overlays.length;
  imageCount = objectModel.objects.filter((o) => o.kind === "image").length + overlayCount;
} catch {
  imageCount = 0;
  overlayCount = 0;
}

const summary = {
  input: inputPath,
  engineVersion: version(),
  sourceFormat,
  sectionCount: doc.getSectionCount(),
  pageCount,
  hasTable: documentHasTable(doc),
  imageCount,
  overlayCount,
  memoCount,
  fieldCount: Array.isArray(fields) ? fields.length : 0,
  fonts: Array.isArray(info.fontsUsed) ? info.fontsUsed : [],
  info,
  pages,
};

// --validate: getValidationWarnings() returns a JSON string
// {count, summary, warnings} flagging HWPX non-standard structures
// (empty/uncomputed line segments). Include it only when asked so the
// default output stays lean.
if (validate) {
  try {
    summary.validation = JSON.parse(doc.getValidationWarnings());
  } catch (e) {
    summary.validation = { error: String(e?.message ?? e) };
  }
}

process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
