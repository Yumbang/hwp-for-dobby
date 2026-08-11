// Memo (메모/주석 comment annotation) detection — a data-loss guard.
//
// The rhwp engine does NOT model document memos: the parser reads only the
// memo_shape_count and skips the MEMO_LIST/MEMO_SHAPE records, so memos never
// enter the IR. They survive a save ONLY via the HWP5 serializer's per-section
// raw_stream fast-path (original bytes emitted verbatim). The moment an edit
// touches the section that holds the memos, that section's raw_stream is
// nulled, the section is re-serialized from an IR that never modeled the memos,
// and every memo in it is silently dropped. (Verified on real files 2026-06.)
//
// The engine exposes no memo API, so we detect memos by reading the container
// ourselves, with zero dependencies (works on every platform / the WASM tier).
// The container plumbing — CFB, the record walker, PARA_TEXT decoding, the ZIP
// reader — now lives in lib/hwp5.mjs, shared with lib/trackchange.mjs:
//   • HWP5  (.hwp)  = OLE/CFB compound file → inflate each BodyText/SectionN
//                     stream → count HWPTAG_MEMO_LIST (93) records.
//   • HWPX  (.hwpx) = ZIP → inflate Contents/section*.xml → count <hp:memo ...>.
//
// detectMemos() drives the edit guard (assertMemoSafe) that every write script
// runs before touching a document, so a memo-bearing file is never edited into
// silent data loss without the user's explicit consent.

import { readFileSync } from "node:fs";
import { EXIT, fail } from "./exit-codes.mjs";
import {
  HWPX_CONTENT_PART,
  INLINE8,
  TAG,
  containerFormat,
  decodeParaText,
  indexOfUtf16,
  isCfb,
  isZip,
  readCfbStreamsByName,
  readZipEntries,
  sectionStreams,
  walkRecords,
} from "./hwp5.mjs";

const HWPTAG_MEMO_LIST = TAG.MEMO_LIST; // 93
const HWPTAG_PARA_TEXT = TAG.PARA_TEXT; // 67
const HWPTAG_CTRL_HEADER = TAG.CTRL_HEADER; // 71

// ── HWP5 / CFB ───────────────────────────────────────────────────────────────

function detectHwpMemos(buf) {
  const streams = readCfbStreamsByName(buf);
  if (!streams) return null;

  const perSection = {};
  let total = 0;
  for (const [name, data] of sectionStreams(streams)) {
    let c = 0;
    for (const r of walkRecords(data)) if (r.tag === HWPTAG_MEMO_LIST) c++;
    if (c > 0) perSection[name] = c;
    total += c;
  }
  return { format: "hwp", hasMemos: total > 0, count: total, sections: perSection };
}

// ── HWPX / ZIP ───────────────────────────────────────────────────────────────

function detectHwpxMemos(buf) {
  const perFile = {};
  let total = 0;
  for (const [name, bytes] of readZipEntries(buf, (n) => HWPX_CONTENT_PART.test(n))) {
    const xml = bytes.toString("utf8");
    // Count opening memo elements (namespace-prefixed in OWPML).
    const m = xml.match(/<(?:\w+:)?memo[\s>]/g);
    const c = m ? m.length : 0;
    if (c > 0) perFile[name] = c;
    total += c;
  }
  return { format: "hwpx", hasMemos: total > 0, count: total, sections: perFile };
}

// ── public API ───────────────────────────────────────────────────────────────

// Detect memo annotations in an .hwp or .hwpx file. Returns
//   { format, hasMemos, count, sections }
// or { format: 'unknown', hasMemos: false, count: 0 } for formats we can't scan
// (e.g. HWP3) — callers must treat 'unknown' as "could not rule memos out".
export function detectMemos(path) {
  const buf = readFileSync(path);
  const fmt = containerFormat(buf);
  if (fmt === "hwp") {
    return detectHwpMemos(buf) ?? { format: "unknown", hasMemos: false, count: 0 };
  }
  if (fmt === "hwpx") return detectHwpxMemos(buf);
  return { format: "unknown", hasMemos: false, count: 0 };
}

// ── reading memos ────────────────────────────────────────────────────────────

// Extract memos. Returns [{ index, id, location, text, anchor }] where `text`
// is the memo's own content and `anchor` is the body text the memo is attached
// to (empty if not recovered). HWP5: memo text lives in the MEMO_LIST paragraph
// list (keyed by the memo id = the MEMO_LIST 4-byte value); the anchor is the
// span between a "%%me" field-begin/end pair in the body, whose CTRL_HEADER
// carries the same id. HWPX: <hp:t> runs inside each <…:memo> element.
export function readMemos(path) {
  const buf = readFileSync(path);
  const out = [];
  if (isCfb(buf)) {
    const streams = readCfbStreamsByName(buf);
    if (!streams) return out;
    for (const [name, data] of sectionStreams(streams)) {
      const recs = [...walkRecords(data)];
      const firstMemo = recs.findIndex((r) => r.tag === HWPTAG_MEMO_LIST);
      if (firstMemo < 0) continue;

      // (a) Memo TEXT, keyed by memo id (the MEMO_LIST record's 4-byte value).
      //     Each MEMO_LIST is followed by its paragraph list; collect the
      //     PARA_TEXT until the next MEMO_LIST.
      const text = new Map();
      let curId = null;
      let parts = [];
      const flushText = () => {
        if (curId != null) {
          const joined = parts.join("\n").trim();
          text.set(curId, text.has(curId) ? `${text.get(curId)}\n${joined}` : joined);
        }
        parts = [];
      };
      for (const { tag, body } of recs.slice(firstMemo)) {
        if (tag === HWPTAG_MEMO_LIST) {
          flushText();
          curId = body.length >= 4 ? body.readUInt32LE(0) : null;
        } else if (curId != null && tag === HWPTAG_PARA_TEXT) {
          const t = decodeParaText(body);
          if (t) parts.push(t);
        }
      }
      flushText();

      // (b) ANCHOR — the body span each memo comments on. In the body (before
      //     the memo block) a "%%me" field-begin (inline char code 3, payload
      //     starts with the bytes of "%%me") and a field-end (code 4) bracket
      //     the anchored text; the memo's CTRL_HEADER in between carries the id
      //     in its last 4 bytes. Pair them up, tolerating either order.
      const anchor = new Map();
      const doneSpans = [];
      let inField = false;
      let span = "";
      let openId = null;
      const isMemoCtrl = (b) => b.length >= 8 && indexOfUtf16(b, "MEMO") >= 0;
      for (const { tag, body } of recs.slice(0, firstMemo)) {
        if (tag === HWPTAG_CTRL_HEADER && isMemoCtrl(body)) {
          const id = body.readUInt32LE(body.length - 4);
          if (doneSpans.length) anchor.set(id, doneSpans.shift());
          else openId = id;
        } else if (tag === HWPTAG_PARA_TEXT) {
          let j = 0;
          while (j + 2 <= body.length) {
            const c = body.readUInt16LE(j);
            if (
              c === 3 &&
              j + 16 <= body.length &&
              body[j + 2] === 0x65 && body[j + 3] === 0x6d &&
              body[j + 4] === 0x25 && body[j + 5] === 0x25
            ) {
              inField = true;
              span = "";
              j += 16;
              continue;
            }
            if (c === 4) {
              if (inField) {
                const t = span.normalize("NFC").trim();
                if (openId != null) {
                  anchor.set(openId, t);
                  openId = null;
                } else {
                  doneSpans.push(t);
                }
                inField = false;
              }
              j += 16;
              continue;
            }
            if (INLINE8.has(c)) {
              j += 16;
              continue;
            }
            if (c < 32) {
              j += 2;
              continue;
            }
            if (inField) span += String.fromCharCode(c);
            j += 2;
          }
        }
      }

      for (const id of [...text.keys()].sort((a, b) => a - b)) {
        out.push({
          index: out.length,
          id,
          location: name,
          text: text.get(id) || "",
          anchor: anchor.get(id) || "",
        });
      }
    }
    return out;
  }
  if (isZip(buf)) {
    for (const [name, bytes] of readZipEntries(buf, (n) => HWPX_CONTENT_PART.test(n))) {
      const xml = bytes.toString("utf8");
      const blocks = xml.match(/<(?:\w+:)?memo\b[^>]*>[\s\S]*?<\/(?:\w+:)?memo>/g) || [];
      for (const blk of blocks) {
        const text = (blk.match(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g) || [])
          .map((t) => t.replace(/<[^>]+>/g, ""))
          .join("")
          .normalize("NFC")
          .trim();
        // HWPX anchor (the run the memo attaches to) is not yet recovered —
        // kept "" for shape parity with the HWP5 path.
        out.push({ index: out.length, id: out.length + 1, location: name, text, anchor: "" });
      }
    }
    return out;
  }
  return out;
}

// ── edit guard ───────────────────────────────────────────────────────────────

// The guard every write script runs before editing. If the input has memos and
// the caller did not pass --allow-memo-loss, refuse (exit UNSAFE=6) with an
// actionable message, because the engine will silently drop the memos on save.
// Returns the detection result so callers can log it.
export function assertMemoSafe(inputPath, argv = process.argv) {
  let info;
  try {
    info = detectMemos(inputPath);
  } catch {
    return { format: "unknown", hasMemos: false, count: 0 }; // never block on a scan error
  }
  if (info.hasMemos && !argv.includes("--allow-memo-loss")) {
    const where = Object.entries(info.sections || {})
      .map(([k, v]) => `${k}:${v}`)
      .join(", ");
    fail(
      EXIT.UNSAFE,
      `error: this document contains ${info.count} memo(s)${where ? ` (${where})` : ""}, and the rhwp engine CANNOT preserve memos through an edit —\n` +
        `       saving the edit would silently delete every memo. Refusing.\n` +
        `       • To read the memos first:  node src/core/read.mjs "${inputPath}" --memos\n` +
        `       • To edit anyway and accept losing the memos: re-run with --allow-memo-loss`,
    );
  }
  return info;
}
