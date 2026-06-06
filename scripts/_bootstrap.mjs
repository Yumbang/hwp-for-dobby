// Common bootstrap for all hwp-skill scripts.
//
// Responsibilities:
//   1. Provide the global `measureTextWidth` shim that @rhwp/core requires
//      whenever any layout-touching method runs (rendering, pagination).
//      Pure edit + save paths don't trigger it, but we install it
//      unconditionally so callers don't have to think about it.
//   2. Initialize the WASM module by reading rhwp_bg.wasm off disk.
//   3. Re-export the {HwpDocument, version} surface so call sites don't
//      need to know about init at all.
//
// Why a shim instead of node-canvas: node-canvas pulls a native dep with
// system libraries (cairo/pango). The agent shouldn't need that to read a
// .hwp. A naive approximation is enough — the rhwp engine has its own
// font-metric tables internally; this shim only fires for chars not in
// those tables. When the agent needs pixel-accurate rendering they should
// shell out to the rhwp CLI binary (`scripts/render.mjs`), which uses
// native skia and has full font support.

import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
// The rhwp WASM bundle is vendored under ../vendor/rhwp/ rather than
// imported via the `@rhwp/core` npm name. Reason: Anthropic's Claude.ai
// skill ZIP validator rejects paths containing `@`, so a path like
// `node_modules/@rhwp/core/` triggers "Zip file contains path with
// invalid characters". Vendoring sidesteps that and removes the
// `npm install` requirement at runtime — the WASM bundle ships in the
// skill itself.
import init, { HwpDocument, version } from "../vendor/rhwp/rhwp.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const WASM_PATH = join(HERE, "..", "vendor", "rhwp", "rhwp_bg.wasm");

// Cheap, deterministic approximation: pull pixel size out of a CSS font
// string (e.g. "12pt 함초롬바탕") and assume an average advance of 0.55em.
// Korean glyphs are roughly 1em wide; ASCII a bit narrower. This is good
// enough for parse/edit; it's not the right path for visual fidelity.
function approxMeasure(font, text) {
  const m = String(font || "").match(/(\d+(?:\.\d+)?)\s*(px|pt)/);
  let px = 12;
  if (m) {
    const n = parseFloat(m[1]);
    px = m[2] === "pt" ? (n * 96) / 72 : n;
  }
  let w = 0;
  for (const ch of String(text ?? "")) {
    const code = ch.codePointAt(0);
    // CJK / Hangul ≈ 1em, ASCII ≈ 0.55em, default 0.7em
    if (code >= 0xac00 && code <= 0xd7a3) w += px;
    else if (code >= 0x3000 && code <= 0x9fff) w += px;
    else if (code < 0x80) w += px * 0.55;
    else w += px * 0.7;
  }
  return w;
}

let initialized = false;
export async function ensureInit() {
  if (initialized) return;
  globalThis.measureTextWidth = approxMeasure;
  await init({ module_or_path: readFileSync(WASM_PATH) });
  initialized = true;
}

export async function loadDocument(path) {
  await ensureInit();
  const bytes = readFileSync(path);
  return new HwpDocument(new Uint8Array(bytes));
}

export async function emptyDocument() {
  await ensureInit();
  // createEmpty produces a HwpDocument with zero sections — calling
  // insertText/createTable on it errors with "구역 인덱스 0 범위 초과".
  // createBlankDocument hydrates from an embedded blank2010 template so
  // the document has a valid section 0 / paragraph 0 ready to edit.
  const doc = HwpDocument.createEmpty();
  doc.createBlankDocument();
  return doc;
}

// Crash-safe write: stage to a sibling tempfile, fsync, then atomic rename
// onto the target path. Same-directory rename is atomic on POSIX (and on
// Windows via MoveFileEx with REPLACE_EXISTING under modern Node), so a
// process crash mid-write leaves either the old file intact or the new
// file fully on disk — never a half-written .hwp at the agent's output
// path. Adopted from hop's desktop save path (state.rs:323–340).
export function atomicWriteFile(path, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const dir = dirname(path);
  const tmp = join(
    dir,
    `.${basename(path)}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`,
  );
  const fd = openSync(tmp, "w", 0o644);
  try {
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw e;
  }
}

// Fast "does this document contain at least one table?" probe. Used by
// read.mjs to warn loudly before flattened (WASM-fallback) text extraction:
// flattening a table with merged cells silently misplaces cell text, so the
// agent should be steered to extract_tables.mjs. Sub-millisecond even on
// 40-page documents — getControlTextPositions is cheap and returns "[]"
// rather than throwing on out-of-range indices; getTableDimensions throws
// on non-table controls, which is how non-tables are skipped.
export function documentHasTable(doc) {
  for (let s = 0; s < doc.getSectionCount(); s++) {
    for (let p = 0; p < doc.getParagraphCount(s); p++) {
      let n = 0;
      try {
        n = JSON.parse(doc.getControlTextPositions(s, p)).length;
      } catch {
        n = 0;
      }
      for (let c = 0; c < n; c++) {
        try {
          doc.getTableDimensions(s, p, c);
          return true;
        } catch {
          /* not a table */
        }
      }
    }
  }
  return false;
}

// Output-format policy: the skill always emits .hwp, never .hwpx.
// Native HWPX save is unsupported — Hancom Office rejects rhwp-produced
// .hwpx files as manipulated ("파일 손상"); upstream, unfixed as of v0.7.13.
// .hwpx INPUT is fine: exportHwp() runs the engine's HWPX→HWP adapter for
// HWPX-sourced docs. Every script calls this on its --output argument
// before doing any work, so a bad extension fails fast instead of after
// an expensive edit pass.
export function assertHwpOutput(path) {
  if (String(path).toLowerCase().endsWith(".hwpx")) {
    process.stderr.write(
      `error: .hwpx output is not supported — Hancom Office rejects rhwp-produced HWPX files ("파일 손상").\n` +
        `       Save as .hwp instead: --output ${String(path).replace(/\.hwpx$/i, ".hwp")}\n` +
        `       (.hwpx INPUT is fine — exportHwp converts it to .hwp via the engine's adapter.)\n`,
    );
    process.exit(2);
  }
}

export { HwpDocument, version };
