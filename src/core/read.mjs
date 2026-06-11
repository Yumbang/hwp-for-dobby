#!/usr/bin/env node
// Usage:
//   node src/core/read.mjs <input.hwp|.hwpx> [--format text|svg] [--page N|all]
//                                            [--mode strict|best-effort]
//   node src/core/read.mjs <input.hwp|.hwpx> --memos [--format text|json]
//
// Default: --format text --page all --mode strict.
//
// MEMOS (--memos): the rhwp engine does NOT model document memos (메모/주석
// comment annotations) — they live only in the container and are silently
// dropped the moment an edit touches their section (see lib/memo.mjs). The edit
// guard (assertMemoSafe) points users here to read them first. With --memos we
// bypass body-text extraction entirely and print the memos read straight from
// the container: JSON by default, or "[N] <text>" blocks with --format text.
//
// CORE TIER — WASM ONLY. This script runs entirely in-process through the
// vendored @rhwp/core WASM bundle and behaves identically on claude.ai /
// cowork / code. It MUST NOT shell out to the rhwp CLI. CLI-based precise
// text/markdown (rhwp export-text / export-markdown, which renders tables as
// real markdown grids) is deferred to enhanced/read_precise.mjs (Phase 3).
//
// TEXT extraction (WASM):
//   We walk the document paragraph-by-paragraph (getTextRange for body text;
//   getControlTextPositions + getTableDimensions to spot table controls).
//   This is deliberately NOT the page-layout run flattener: getPageTextLayout
//   interleaves a table's cell runs with surrounding body runs in y/x order,
//   so a table's flattened text leaks into the page stream with no way to mask
//   it. The paragraph walk keeps table content cleanly separable, which is
//   what lets --mode strict refuse to flatten without dropping body text.
//
// TABLES ARE THE TRAP. A merged cell's text is stored once at its origin
// (spec §1.1); flattening to document/visual order glues it onto whichever
// cell serializes next, so reading the flattened output row-by-row WILL
// misattribute values across records. The skill MUST NOT silently corrupt a
// document, so:
//   --mode strict (default): emit body text, but replace each table with a
//     placeholder line ('[table: use extract_tables.mjs for data]') and print
//     a loud stderr warning. Tables existing is NOT an error (exit stays 0) —
//     we only refuse to FLATTEN them. For table DATA always use
//     extract_tables.mjs (address-aware grid with merge info; no CLI needed).
//   --mode best-effort: flatten each table's cell text inline (document
//     order), with a stderr warning that merged cells may be misplaced.
//
// SVG: renderPageSvg(page) is kept for a quick visual preview. The visual
// layer is not authoritative — PUA glyphs render as tofu (spec §22) and font
// metrics use an approximate shim (see _bootstrap.mjs).
//
// --page applies to SVG (page index N, or all). Text extraction walks the
// whole document (paragraph stream is not page-indexed); --page is accepted
// for symmetry but only narrows SVG output.
//
// All extracted text is NFC-normalized (spec §21). Output goes to stdout.

import { documentHasTable, loadDocument } from "../lib/_bootstrap.mjs";
import { EXIT, fail } from "../lib/exit-codes.mjs";
import { readMemos } from "../lib/memo.mjs";

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

// Surface load failures as a clean one-line diagnostic instead of a raw
// Node/engine stack trace (ENOENT, corrupt CFB, etc.).
async function loadOrExit(path) {
  try {
    return await loadDocument(path);
  } catch (e) {
    fail(EXIT.LOAD, `error: cannot read ${path}: ${e?.message ?? e}`);
  }
}

// NFC-normalize all extracted text (spec §21): macOS NFD vs code NFC differ
// in length for Hangul, so we pin a single normal form on the way out.
function nfc(s) {
  return String(s ?? "").normalize("NFC");
}

const PLACEHOLDER = "[table: use extract_tables.mjs for data]";

const inputPath = process.argv[2];
if (!inputPath || inputPath.startsWith("--")) {
  fail(
    EXIT.USAGE,
    "usage: read.mjs <input.hwp|.hwpx> [--format text|svg] [--page N|all] [--mode strict|best-effort]\n" +
      "       read.mjs <input.hwp|.hwpx> --memos [--format text|json]",
  );
}

// ── MEMOS ───────────────────────────────────────────────────────────────────
// --memos short-circuits the whole read path: no WASM, no body-text walk. It
// reads memos straight from the container (lib/memo.mjs) so the user can see
// what an edit would silently drop. This is the command the edit guard points
// to. Output is JSON by default, or "[N] <text>" blocks with --format text.
if (hasFlag("--memos")) {
  const memoFormat = arg("--format", "json");
  if (memoFormat !== "json" && memoFormat !== "text") {
    fail(EXIT.USAGE, `unknown --format for --memos: ${memoFormat} (expected json|text)`);
  }
  let memos;
  try {
    memos = readMemos(inputPath);
  } catch (e) {
    fail(EXIT.LOAD, `error: cannot read ${inputPath}: ${e?.message ?? e}`);
  }
  if (memoFormat === "json") {
    // Always valid JSON — an empty array when there are no memos.
    process.stdout.write(JSON.stringify(memos, null, 2) + "\n");
  } else if (memos.length === 0) {
    process.stdout.write("(no memos)\n");
  } else {
    for (const m of memos) {
      process.stdout.write(`[${m.id ?? m.index}] ${m.text}\n`);
      if (m.anchor) process.stdout.write(`      ↳ 본문/anchored to: "${m.anchor}"\n`);
    }
  }
  process.exit(EXIT.OK);
}

const format = arg("--format", "text");
const pageArg = arg("--page", "all");
const mode = arg("--mode", "strict");

if (format !== "text" && format !== "svg") {
  // 'markdown' is intentionally NOT a core format: markdown table grids need
  // the CLI (enhanced/read_precise.mjs, Phase 3). For table DATA use
  // extract_tables.mjs.
  fail(EXIT.USAGE, `unknown --format: ${format} (expected text|svg)`);
}
if (mode !== "strict" && mode !== "best-effort") {
  fail(EXIT.USAGE, `unknown --mode: ${mode} (expected strict|best-effort)`);
}

// ── table control / cell-text helpers (top-level tables only) ─────────────
// Mirrors extract_tables.mjs' flat-scan accessors. The core read path only
// flattens top-level tables in best-effort mode; structured/nested extraction
// is extract_tables.mjs' job.

// Indices of table controls in paragraph (s,p), in control order.
function tableControlsInParagraph(doc, s, p) {
  let n = 0;
  try {
    n = JSON.parse(doc.getControlTextPositions(s, p)).length;
  } catch {
    n = 0;
  }
  const out = [];
  for (let c = 0; c < n; c++) {
    try {
      doc.getTableDimensions(s, p, c);
      out.push(c);
    } catch {
      /* not a table */
    }
  }
  return out;
}

// Read one cell's text (joins its inner paragraphs with newline). Same shape
// as extract_tables.mjs' readCellText for flat tables.
function readCellText(doc, s, p, ctrl, k) {
  let nPara = 0;
  try {
    nPara = doc.getCellParagraphCount(s, p, ctrl, k);
  } catch {
    return "";
  }
  const parts = [];
  for (let cp = 0; cp < nPara; cp++) {
    let len = 0;
    try {
      len = doc.getCellParagraphLength(s, p, ctrl, k, cp);
    } catch {
      len = 0;
    }
    parts.push(len > 0 ? doc.getTextInCell(s, p, ctrl, k, cp, 0, len) : "");
  }
  return nfc(parts.join("\n"));
}

// Flatten a top-level table to document-order cell text (best-effort only).
// This is the corrupting path the strict mode refuses: cells are emitted in
// origin order with NO grid reconstruction, so merged cells land wherever
// they serialize. Lines are written directly to stdout.
function flattenTableInline(doc, s, p, ctrl) {
  let dim;
  try {
    dim = JSON.parse(doc.getTableDimensions(s, p, ctrl));
  } catch {
    return;
  }
  for (let k = 0; k < dim.cellCount; k++) {
    const t = readCellText(doc, s, p, ctrl, k);
    if (t.length) process.stdout.write(t + "\n");
  }
}

// ── SVG ───────────────────────────────────────────────────────────────────
if (format === "svg") {
  // SVG is a quick visual preview only; tables are drawn visually so there is
  // no flatten-corruption concern. PUA glyphs may show as tofu (spec §22).
  const doc = await loadOrExit(inputPath);
  const total = doc.pageCount();
  let pages;
  if (pageArg === "all") {
    pages = [...Array(total).keys()];
  } else {
    const n = parseInt(pageArg, 10);
    if (Number.isNaN(n)) fail(EXIT.USAGE, `invalid --page: ${pageArg} (expected N|all)`);
    pages = [n];
  }
  for (const pg of pages) process.stdout.write(doc.renderPageSvg(pg));
} else {
  // ── TEXT ──────────────────────────────────────────────────────────────
  const doc = await loadOrExit(inputPath);
  const hasTable = documentHasTable(doc);

  // strict refuses to flatten tables (anti-silent-corruption default).
  // best-effort opts INTO inline flattened table text but still warns.
  if (hasTable && mode === "strict") {
    process.stderr.write(
      "WARNING: this document contains tables.\n" +
        "         WASM text extraction can only FLATTEN tables to document-order cell\n" +
        "         text; merged cells (rowSpan/colSpan) lose their grid position, so\n" +
        "         values can appear attached to the wrong row/record. In --mode strict\n" +
        "         each table is replaced with a placeholder and its data is NOT emitted.\n" +
        "         For table DATA use the structured, address-aware extractor:\n" +
        "           node src/core/extract_tables.mjs <input>\n" +
        "         To force inline flattened table text anyway (risky): --mode best-effort\n",
    );
  } else if (hasTable && mode === "best-effort") {
    process.stderr.write(
      "WARNING: --mode best-effort: this document contains tables and their cell text is\n" +
        "         FLATTENED inline below in document order. Merged cells (rowSpan/colSpan)\n" +
        "         may be misplaced against the wrong row/record. For reliable table data:\n" +
        "           node src/core/extract_tables.mjs <input>\n",
    );
  }

  // Walk every paragraph. A paragraph either hosts table control(s) or holds
  // plain body text — emit accordingly so a table's content is never glued
  // into the body stream by accident.
  for (let s = 0; s < doc.getSectionCount(); s++) {
    const P = doc.getParagraphCount(s);
    for (let p = 0; p < P; p++) {
      const tableCtrls = tableControlsInParagraph(doc, s, p);

      // Body text of the paragraph (present even on table-hosting paragraphs;
      // a table control sits inline but its text is not in the paragraph body).
      let body = "";
      try {
        body = doc.getTextRange(s, p, 0, 0x7fffffff);
      } catch {
        body = "";
      }
      body = nfc(body);

      if (tableCtrls.length === 0) {
        // Plain paragraph: emit body text (may be empty → blank line, which
        // preserves paragraph spacing in the output stream).
        process.stdout.write(body + "\n");
        continue;
      }

      // Table-hosting paragraph. Emit any leading body text, then handle each
      // table per the active mode.
      if (body.length) process.stdout.write(body + "\n");
      for (const ctrl of tableCtrls) {
        if (mode === "strict") {
          process.stdout.write(PLACEHOLDER + "\n");
        } else {
          flattenTableInline(doc, s, p, ctrl);
        }
      }
    }
  }

  // Memos (메모/주석) are invisible to body-text extraction and an edit to their
  // section silently destroys them — so surface them automatically here, after
  // the body, so a plain read never misses them. (`--memos` reads only memos.)
  let memos = [];
  try {
    memos = readMemos(inputPath);
  } catch {
    memos = [];
  }
  if (memos.length) {
    process.stderr.write(
      `NOTE: this document has ${memos.length} memo(s); appended below (the engine ` +
        `hides them from normal reads). Read only the memos with --memos.\n`,
    );
    process.stdout.write(`\n─── 메모 / memos (${memos.length}) ───\n`);
    for (const m of memos) {
      process.stdout.write(`[${m.id ?? m.index}] ${m.text}\n`);
      if (m.anchor) process.stdout.write(`      ↳ 본문/anchored to: "${m.anchor}"\n`);
    }
  }
}
