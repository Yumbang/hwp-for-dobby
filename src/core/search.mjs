#!/usr/bin/env node
// Usage:
//   node src/core/search.mjs <input.hwp|.hwpx> --query <q> [--limit N] [--ignore-case] [--format text|json]
//
// Address-preserving search. Flattened text search loses "which page / which
// cell" — this walks the engine's searchAllText and attaches getPageOfPosition
// plus a short context span so a hit can be cited and, on Claude Code,
// rendered with enhanced/render.mjs --page N.
//
// 0 matches is success (exit 0, matchCount: 0). --limit cuts the returned
// list but totalMatchCount still reports the real total. CORE / WASM only.

import { loadDocument } from "../lib/_bootstrap.mjs";
import { enumArg, flag, inputPath, intArg, strArg } from "../lib/argv.mjs";
import { EXIT, fail } from "../lib/exit-codes.mjs";

const USAGE =
  "usage: search.mjs <input.hwp|.hwpx> --query <q> [--limit N] [--ignore-case] [--format text|json]";

const input = inputPath(USAGE);
const query = strArg("--query", null);
if (query == null || query === "") fail(EXIT.USAGE, `error: --query is required\n${USAGE}`);
const limit = intArg("--limit", null);
if (limit === 0) fail(EXIT.USAGE, "error: --limit must be >= 1 (omit it for no cap)");
const ignoreCase = flag("--ignore-case");
const format = enumArg("--format", ["text", "json"], "text");

let doc;
try {
  doc = await loadDocument(input);
} catch (e) {
  fail(EXIT.LOAD, `error: cannot read ${input}: ${e?.message ?? e}`);
}

let raw;
try {
  raw = JSON.parse(doc.searchAllText(query, !ignoreCase, true));
} catch (e) {
  fail(EXIT.LOAD, `error: search failed: ${e?.message ?? e}`);
}
if (!Array.isArray(raw)) raw = [];

const totalMatchCount = raw.length;
const truncated = limit != null && raw.length > limit;
const sliced = truncated ? raw.slice(0, limit) : raw;

function contextAround(sec, para, offset, length) {
  let text = "";
  try {
    const n = doc.getParagraphLength(sec, para);
    const from = Math.max(0, offset - 40);
    const to = Math.min(n, offset + length + 40);
    if (to > from) text = doc.getTextRange(sec, para, from, to - from);
  } catch {
    text = "";
  }
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function pageOf(sec, para) {
  try {
    const r = JSON.parse(doc.getPageOfPosition(sec, para));
    return r && r.ok === true && Number.isInteger(r.page) ? r.page : null;
  } catch {
    return null;
  }
}

const matches = sliced.map((h) => {
  const section = h.sec ?? h.section ?? 0;
  const paragraph = h.para ?? h.paragraph ?? 0;
  const charOffset = h.charOffset ?? 0;
  const length = h.length ?? query.length;
  let covered = "";
  try {
    covered = doc.getTextRange(section, paragraph, charOffset, length);
  } catch {
    covered = "";
  }
  const cell = h.cellContext
    ? {
        parentPara: h.cellContext.parentPara,
        control: h.cellContext.ctrlIdx,
        cell: h.cellContext.cellIdx,
        cellPara: h.cellContext.cellPara,
      }
    : undefined;
  return {
    section,
    paragraph,
    page: pageOf(section, paragraph),
    charOffset,
    length,
    text: covered,
    context: contextAround(section, paragraph, charOffset, length),
    ...(cell ? { cell } : {}),
  };
});

const envelope = {
  input,
  query,
  caseSensitive: !ignoreCase,
  matchCount: matches.length,
  totalMatchCount,
  truncated,
  omittedCount: truncated ? totalMatchCount - matches.length : 0,
  matches,
};

if (format === "json") {
  process.stdout.write(JSON.stringify(envelope, null, 2) + "\n");
} else if (matches.length === 0) {
  process.stdout.write("(no matches)\n");
} else {
  for (const m of matches) {
    const where = m.page != null ? `p${m.page + 1}` : `s${m.section}/¶${m.paragraph}`;
    const cell = m.cell ? ` cell ${m.cell.cell}` : "";
    process.stdout.write(`${where}${cell}: ${m.context || m.text}\n`);
  }
  if (truncated) {
    process.stderr.write(
      `search: truncated — showing ${matches.length} of ${totalMatchCount} (--limit ${limit})\n`,
    );
  }
}
