#!/usr/bin/env node
// Usage:
//   node src/core/read.mjs <input.hwp|.hwpx> [--format text|svg] [--page N|all]
//                                            [--mode strict|best-effort]
//                                            [--no-snapshot] [--snapshot-dir <dir>] [--max-chars N]
//   node src/core/read.mjs <input.hwp|.hwpx> --memos [--format text|json]
//   node src/core/read.mjs <input.hwp|.hwpx> --track-changes [--format text|json]
//
// Default: --format text --page all --mode strict.
//
// (--track-changes is intentionally absent from the USAGE string below: that
// string is pinned byte-for-byte by test/golden, and re-recording the baseline
// is a separate, reviewed act. Documented here instead.)
//
// MEMOS (--memos): the rhwp engine does NOT model document memos (메모/주석
// comment annotations) — they live only in the container and are silently
// dropped the moment an edit touches their section (see lib/memo.mjs). The edit
// guard (assertMemoSafe) points users here to read them first. With --memos we
// bypass body-text extraction entirely and print the memos read straight from
// the container: JSON by default, or "[N] <text>" blocks with --format text.
//
// TRACKED CHANGES (--track-changes): the same story, one degree worse. In a
// document with tracked changes (변경 내용 추적) the DELETED text is still
// physically present in the paragraph records, so the body text printed by a
// plain read silently MIXES insertions and deletions — the reader sees text the
// author already removed and cannot tell. --track-changes lists the changes
// (kind / author / covered text) from the container; a plain read emits a
// stderr WARNING when, and only when, the document actually has them.
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
//
// SNAPSHOT (default on a text read): after printing the body, compare this
// document's inferred sections against the last read and then write a new
// baseline. "What changed?" means "since I last looked", not "since the first
// time anyone snapshotted this file". The report goes to stderr so stdout
// stays the document. --memos / --track-changes / --format svg skip this
// (they are not a body read). --no-snapshot opts out. A missing structure or
// a failed snapshot never fails the read.

import { loadDocument } from "../lib/_bootstrap.mjs";
import { flag as hasFlag } from "../lib/argv.mjs";
import { reportReadSnapshot } from "../lib/section_diff.mjs";
import {
  documentHasTable,
  eachParagraph,
  paragraphText,
  pictureControlsInParagraph,
  tableControlsInParagraph,
} from "../lib/doc_walk.mjs";
import { EXIT, fail } from "../lib/exit-codes.mjs";
import { parseMarker } from "../lib/bullets.mjs";
import { classifyPlacement, pictureMarker } from "../lib/objects.mjs";
import { readMemos } from "../lib/memo.mjs";
import { flatLoc, readCellText, tableDims } from "../lib/tables.mjs";
import { detectTrackChanges, readTrackChanges } from "../lib/trackchange.mjs";

// NOTE: this script keeps its own lenient `arg()` rather than lib/argv.mjs'
// strict strArg. read.mjs validates every option against a closed set right
// below (--format text|svg, --mode strict|best-effort), so a missing value
// already exits USAGE with a message naming the valid choices. Switching to
// strArg would change those messages — a behavior change with no benefit, and
// test/golden pins them.
function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
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

// All extracted text is NFC-normalized (spec §21): macOS NFD vs code NFC
// differ in length for Hangul, so a single normal form is pinned on the way
// out. That now happens at the source — doc_walk.paragraphText for body text,
// tables.readCellText for cell text, memo.readMemos for memo text.

const PLACEHOLDER = "[table: use extract_tables.mjs for data]";

const USAGE =
  "usage: read.mjs <input.hwp|.hwpx> [--format text|svg] [--page N|all] [--mode strict|best-effort]\n" +
  "       [--no-snapshot] [--snapshot-dir <dir>] [--max-chars N]\n" +
  "       read.mjs <input.hwp|.hwpx> --memos [--format text|json]";

const inputPath = process.argv[2];
if (!inputPath || inputPath.startsWith("--")) {
  fail(EXIT.USAGE, USAGE);
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

// ── TRACKED CHANGES ─────────────────────────────────────────────────────────
// --track-changes short-circuits the read path exactly as --memos does: no
// WASM, no body walk, just the container (lib/trackchange.mjs). This is the
// command the write guard (assertTrackChangeSafe) points at, and the only way
// to see WHICH spans of the body are insertions and which are deletions the
// author already made — a plain read prints both as ordinary text.
if (hasFlag("--track-changes")) {
  const tcFormat = arg("--format", "json");
  if (tcFormat !== "json" && tcFormat !== "text") {
    fail(EXIT.USAGE, `unknown --format for --track-changes: ${tcFormat} (expected json|text)`);
  }
  let info;
  let changes;
  try {
    info = detectTrackChanges(inputPath);
    changes = readTrackChanges(inputPath);
  } catch (e) {
    fail(EXIT.LOAD, `error: cannot read ${inputPath}: ${e?.message ?? e}`);
  }
  // An unscannable container (HWPX today) must NEVER be reported as "no tracked
  // changes" — that is the silent lie lib/trackchange.mjs exists to avoid. Say
  // we could not look, and still exit 0: this is a read, not a failure.
  if (!info.supported) {
    process.stderr.write(
      `WARNING: cannot scan this container (format: ${info.format}) for tracked changes ` +
        `(변경 내용 추적).\n` +
        `         The result below means "not checked", NOT "none found".\n`,
    );
  }
  if (tcFormat === "json") {
    // The whole verdict, not a bare array: `supported`, `flagBit` and
    // `corroborated` are what let a caller tell "none" from "could not look".
    process.stdout.write(JSON.stringify({ ...info, changes }, null, 2) + "\n");
  } else if (!info.supported) {
    process.stdout.write("(tracked changes NOT CHECKED: this container cannot be scanned)\n");
  } else if (changes.length === 0) {
    process.stdout.write("(no tracked changes)\n");
  } else {
    process.stdout.write(`─── 변경 내용 추적 / tracked changes (${changes.length}) ───\n`);
    for (const ch of changes) {
      const who = ch.author ? ` by ${ch.author}` : "";
      process.stdout.write(`[${ch.index}] ${ch.kind} #${ch.id}${who} (${ch.location})\n`);
      if (ch.text) process.stdout.write(`      ${JSON.stringify(ch.text)}\n`);
    }
  }
  process.exit(EXIT.OK);
}

const format = arg("--format", "text");
const pageArg = arg("--page", "all");
const mode = arg("--mode", "strict");

if (format !== "text" && format !== "svg" && format !== "json") {
  // 'markdown' is intentionally NOT a core format: markdown table grids need
  // the CLI (enhanced/read_precise.mjs, Phase 3). For table DATA use
  // extract_tables.mjs.
  fail(EXIT.USAGE, `unknown --format: ${format} (expected text|json|svg)`);
}
if (mode !== "strict" && mode !== "best-effort") {
  fail(EXIT.USAGE, `unknown --mode: ${mode} (expected strict|best-effort)`);
}

// ── table flattening (best-effort only, top-level tables) ─────────────────
// Control enumeration and cell reading live in lib/doc_walk.mjs and
// lib/tables.mjs, shared with extract_tables.mjs. The core read path only
// flattens top-level tables in best-effort mode; structured/nested extraction
// is extract_tables.mjs' job.

// Flatten a top-level table to document-order cell text (best-effort only).
// This is the corrupting path the strict mode refuses: cells are emitted in
// origin order with NO grid reconstruction, so merged cells land wherever
// they serialize. Lines are written directly to stdout.
function flattenTableInline(doc, s, p, ctrl, writeLine) {
  const loc = flatLoc(s, p, ctrl);
  let dim;
  try {
    dim = tableDims(doc, loc);
  } catch {
    return;
  }
  const write = writeLine ?? ((t) => process.stdout.write(t + "\n"));
  for (let k = 0; k < dim.cellCount; k++) {
    const t = readCellText(doc, loc, k);
    if (t.length) write(t);
  }
}

// ── JSON: body text WITH the address every editing script needs ───────────
//
// WHY THIS EXISTS. Every targeted edit — format.mjs, edit_text.mjs — is
// addressed by an integer (section, paragraph). Until this branch, no CORE
// reader emitted that number: --format text prints the lines and throws the
// indices away, and the only listing that carried them was
// enhanced/debug.mjs --op dump, which needs the native binary and therefore
// only exists on Claude Code. A test agent asked to renumber a 개조식 list hit
// exactly that wall and had to fall back to the enhanced tier; on claude.ai or
// cowork it would have had no supported route at all. search.mjs --format json
// does carry the address, but only for text you can already name, so it cannot
// answer "which paragraphs are level-2 items".
//
// Deliberately NOT a formatting dump. It carries what you need to ADDRESS a
// paragraph — index, length, and the 개조식 marker if it has one — because
// --op char needs an explicit range and the bullet/indent ops need to know
// which paragraphs already carry a marker. Character and paragraph properties
// are a separate question with its own answer.
if (format === "json") {
  const doc = await loadOrExit(inputPath);
  const paragraphs = [];
  for (const { s, p } of eachParagraph(doc)) {
    const text = paragraphText(doc, s, p);
    const tableCtrls = tableControlsInParagraph(doc, s, p);
    const pics = pictureControlsInParagraph(doc, s, p);
    const marker = parseMarker(text);
    paragraphs.push({
      section: s,
      paragraph: p,
      // The char count the engine uses, which is what --start/--end index
      // into. NOT text.length: an astral character is two JS units and one
      // engine unit (spec rule 63).
      length: doc.getParagraphLength(s, p),
      text,
      ...(marker
        ? { marker: { glyph: marker.glyph, indentChars: marker.indent.length, prefixLength: marker.prefixLength } }
        : {}),
      ...(tableCtrls.length ? { tables: tableCtrls.length } : {}),
      ...(pics.length ? { pictures: pics.length } : {}),
    });
  }
  process.stdout.write(
    JSON.stringify(
      {
        input: inputPath,
        sectionCount: doc.getSectionCount(),
        paragraphCount: paragraphs.length,
        paragraphs,
      },
      null,
      2,
    ) + "\n",
  );
  process.exit(EXIT.OK);
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
  // Tracked changes (변경 내용 추적). Deleted text is still physically present in
  // the paragraph records, so everything printed below MIXES insertions and
  // deletions with nothing to tell them apart. Warn BEFORE the body, because
  // the caveat is worthless after the reader has already believed the text —
  // and before the engine load, because the detection reads the container
  // directly and does not depend on the engine accepting the file.
  //
  // ONLY when the document actually has them. A clean document's stdout AND
  // stderr are pinned byte-for-byte by test/golden — this branch must stay
  // completely silent otherwise, which is also why the detection is guarded:
  // a scan failure (missing file, HWP3, …) degrades to "say nothing", never to
  // a spurious warning ahead of the load error that is about to be printed.
  let tracked = null;
  try {
    tracked = detectTrackChanges(inputPath);
  } catch {
    tracked = null;
  }
  if (tracked?.hasTrackChanges) {
    const c = tracked.counts;
    process.stderr.write(
      "WARNING: this document has TRACKED CHANGES (변경 내용 추적): " +
        `${c.insert} insertion(s), ${c.delete} deletion(s).\n` +
        "         The rhwp engine does not model them, so the text below is the RAW body:\n" +
        "         text the author DELETED is still in it and is printed as if it were live.\n" +
        "         Do not treat this output as the document's final text.\n" +
        "         To see which spans are insertions and which are deletions:\n" +
        `           node src/core/read.mjs "${inputPath}" --track-changes\n`,
    );
  }

  const doc = await loadOrExit(inputPath);
  const skipSnapshot = hasFlag("--no-snapshot");
  const snapshotDir = arg("--snapshot-dir", null);
  const maxCharsRaw = arg("--max-chars", null);
  let maxChars = null;
  if (maxCharsRaw != null) {
    const n = Number(maxCharsRaw);
    if (!Number.isInteger(n) || n < 1) {
      fail(EXIT.USAGE, `error: --max-chars must be an integer >= 1 (got ${JSON.stringify(maxCharsRaw)})`);
    }
    maxChars = n;
  }
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
  let emitted = 0;
  let omitted = 0;
  let cut = false;
  const writeBody = (chunk) => {
    const line = chunk.endsWith("\n") ? chunk : chunk + "\n";
    if (maxChars == null || !cut) {
      if (maxChars == null || emitted + line.length <= maxChars) {
        process.stdout.write(line);
        emitted += line.length;
        return;
      }
      const room = maxChars - emitted;
      if (room > 0) process.stdout.write(line.slice(0, room));
      emitted += Math.max(0, room);
      omitted += line.length - Math.max(0, room);
      cut = true;
    } else {
      omitted += line.length;
    }
  };

  // getPageDef is a property read (0.004 ms), not pagination, so every marker
  // can be relative to the real text column. Memoized per section anyway.
  const usableCache = new Map();
  const usableFor = (sec) => {
    if (usableCache.has(sec)) return usableCache.get(sec);
    let w = 0;
    try {
      const pd = JSON.parse(doc.getPageDef(sec));
      w = Math.max(0, (pd.width ?? 0) - (pd.marginLeft ?? 0) - (pd.marginRight ?? 0));
    } catch {
      w = 0;
    }
    usableCache.set(sec, w);
    return w;
  };
  const overlayLines = [];

  for (const { s, p } of eachParagraph(doc)) {
    const tableCtrls = tableControlsInParagraph(doc, s, p);
    // Pictures were dropped here along with the invisible SectionDef/ColumnDef
    // controls: a document could carry a dozen images and this output showed
    // nothing at all. Markers are sized RELATIVE to the text column, because
    // "150mm" cannot be judged without knowing how wide the page is.
    const pics = pictureControlsInParagraph(doc, s, p);

    // Body text of the paragraph (present even on table-hosting paragraphs;
    // a table control sits inline but its text is not in the paragraph body).
    const body = paragraphText(doc, s, p);

    if (tableCtrls.length === 0 && pics.length === 0) {
      // Plain paragraph: emit body text (may be empty → blank line, which
      // preserves paragraph spacing in the output stream).
      writeBody(body);
      continue;
    }

    // Table-hosting paragraph. Emit any leading body text, then handle each
    // table per the active mode.
    if (body.length) writeBody(body);
    for (const pic of pics) {
      const place = classifyPlacement(pic.props ?? {});
      const marker = pictureMarker(pic.props ?? {}, {
        usableWidth: usableFor(s),
        placement: place.placement,
      });
      // An overlay (watermark, stamp) has no reading position; placing it in
      // the body would invent one. Collected and reported after the body.
      if (place.placement === "overlay") overlayLines.push(marker);
      else writeBody(marker);
    }
    for (const ctrl of tableCtrls) {
      if (mode === "strict") {
        writeBody(PLACEHOLDER);
      } else {
        flattenTableInline(doc, s, p, ctrl, writeBody);
      }
    }
  }

  if (overlayLines.length) {
    process.stdout.write(`\n─── overlay images (${overlayLines.length}) ───\n`);
    for (const l of overlayLines) process.stdout.write(l + "\n");
    process.stderr.write(
      `NOTE: ${overlayLines.length} image(s) sit on an overlay plane (watermark/stamp).\n` +
        `      They have no position in the reading flow, so they are listed separately\n` +
        `      rather than placed in the body.\n`,
    );
  }

  if (cut) {
    process.stderr.write(
      `read: truncated — omitted ${omitted} character(s) (--max-chars ${maxChars})\n`,
    );
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

  // After the body: last-read section diff, then a fresh baseline. Never
  // blocks the read — a snapshot failure is a note, not a failed extraction.
  if (!skipSnapshot) {
    await reportReadSnapshot(inputPath, { doc, snapshotDir });
  }
}
