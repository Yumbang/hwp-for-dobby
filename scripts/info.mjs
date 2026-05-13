#!/usr/bin/env node
// Usage: node scripts/info.mjs <input.hwp|.hwpx>
//
// Prints a JSON summary of the document: page count, section count,
// HWP version, encryption flag, and per-page width/height/section.
//
// Use this first when you open an unfamiliar document — the JSON is small
// and tells you whether the doc is HWP or HWPX, how many pages exist, and
// where to address edits (sections are 0-indexed; many edit APIs need a
// section_idx).

import { loadDocument } from "./_bootstrap.mjs";

const [, , inputPath] = process.argv;
if (!inputPath) {
  console.error("usage: info.mjs <input.hwp|.hwpx>");
  process.exit(2);
}

const doc = await loadDocument(inputPath);
const info = JSON.parse(doc.getDocumentInfo());
const pageCount = doc.pageCount();
const pages = [];
for (let i = 0; i < pageCount; i++) {
  pages.push(JSON.parse(doc.getPageInfo(i)));
}

process.stdout.write(JSON.stringify({ input: inputPath, info, pages }, null, 2) + "\n");
