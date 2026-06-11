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
// ourselves, with zero dependencies (works on every platform / the WASM tier):
//   • HWP5  (.hwp)  = OLE/CFB compound file → inflate each BodyText/SectionN
//                     stream → count HWPTAG_MEMO_LIST (93) records.
//   • HWPX  (.hwpx) = ZIP → inflate Contents/section*.xml → count <hp:memo ...>.
//
// detectMemos() drives the edit guard (assertMemoSafe) that every write script
// runs before touching a document, so a memo-bearing file is never edited into
// silent data loss without the user's explicit consent.

import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { EXIT, fail } from "./exit-codes.mjs";

const HWPTAG_BEGIN = 0x10;
const HWPTAG_MEMO_LIST = HWPTAG_BEGIN + 77; // 93
const HWPTAG_PARA_TEXT = HWPTAG_BEGIN + 51; // 67
const HWPTAG_CTRL_HEADER = HWPTAG_BEGIN + 55; // 71

// Find the byte offset of `s` encoded UTF-16LE in `buf` (-1 if absent).
function indexOfUtf16(buf, s) {
  return buf.indexOf(Buffer.from(s, "utf16le"));
}

// ── HWP5 / CFB ───────────────────────────────────────────────────────────────

const CFB_SIG_LO = 0xe011cfd0; // bytes D0 CF 11 E0 (LE u32)
const CFB_SIG_HI = 0xe11ab1a1; // bytes A1 B1 1A E1 (LE u32)
const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;

// Read every CFB stream, keyed by its (local) directory name. HWP5 stream names
// are unique enough for our needs — "FileHeader", "Section0", "Section1", … —
// so we skip full red-black-tree path reconstruction and key by local name.
function readCfbStreamsByName(buf) {
  if (
    buf.length < 512 ||
    buf.readUInt32LE(0) !== CFB_SIG_LO ||
    buf.readUInt32LE(4) !== CFB_SIG_HI
  ) {
    return null; // not a compound file
  }
  const secSize = 1 << buf.readUInt16LE(30);
  const miniSize = 1 << buf.readUInt16LE(32);
  const firstDir = buf.readUInt32LE(48);
  const miniCutoff = buf.readUInt32LE(56);
  const firstMiniFat = buf.readUInt32LE(60);
  const numMiniFat = buf.readUInt32LE(64);
  const firstDifat = buf.readUInt32LE(68);
  const sectorOff = (s) => 512 + s * secSize;

  // DIFAT → list of FAT sectors (109 inline + any in DIFAT sectors).
  const fatSectors = [];
  for (let i = 0; i < 109; i++) {
    const v = buf.readUInt32LE(76 + i * 4);
    if (v < 0xfffffffc) fatSectors.push(v);
  }
  let ds = firstDifat;
  const perSec = secSize / 4;
  let guard = 0;
  while (ds !== ENDOFCHAIN && ds !== FREESECT && guard++ < 100000) {
    const base = sectorOff(ds);
    for (let i = 0; i < perSec - 1; i++) {
      const v = buf.readUInt32LE(base + i * 4);
      if (v < 0xfffffffc) fatSectors.push(v);
    }
    ds = buf.readUInt32LE(base + (perSec - 1) * 4);
  }
  // The FAT itself (next-sector pointers).
  const fat = [];
  for (const fs of fatSectors) {
    const base = sectorOff(fs);
    for (let i = 0; i < perSec; i++) fat.push(buf.readUInt32LE(base + i * 4));
  }
  const readChain = (start, sizeLimit) => {
    const parts = [];
    let s = start;
    let g = 0;
    while (s !== ENDOFCHAIN && s !== FREESECT && s < fat.length && g++ < 1e7) {
      const off = sectorOff(s);
      parts.push(buf.subarray(off, off + secSize));
      s = fat[s];
    }
    const out = Buffer.concat(parts);
    return sizeLimit != null && out.length > sizeLimit
      ? out.subarray(0, sizeLimit)
      : out;
  };

  // Directory entries (128 bytes each).
  const dir = readChain(firstDir);
  const all = [];
  for (let off = 0; off + 128 <= dir.length; off += 128) {
    const nameLen = dir.readUInt16LE(off + 64);
    if (nameLen < 2) continue;
    const name = dir.toString("utf16le", off, off + nameLen - 2);
    all.push({
      name,
      type: dir.readUInt8(off + 66),
      startSec: dir.readUInt32LE(off + 116),
      size: dir.readUInt32LE(off + 120),
    });
  }
  // Root (type 5) holds the mini-stream; mini-FAT subdivides it.
  const root = all.find((e) => e.type === 5);
  const miniStream = root ? readChain(root.startSec, root.size) : Buffer.alloc(0);
  const miniFatBytes = numMiniFat ? readChain(firstMiniFat) : Buffer.alloc(0);
  const miniFat = [];
  for (let i = 0; i + 4 <= miniFatBytes.length; i += 4) {
    miniFat.push(miniFatBytes.readUInt32LE(i));
  }
  const readMini = (start, size) => {
    const parts = [];
    let s = start;
    let g = 0;
    while (s !== ENDOFCHAIN && s !== FREESECT && s < miniFat.length && g++ < 1e7) {
      const off = s * miniSize;
      parts.push(miniStream.subarray(off, off + miniSize));
      s = miniFat[s];
    }
    const out = Buffer.concat(parts);
    return size != null && out.length > size ? out.subarray(0, size) : out;
  };

  const streams = new Map();
  for (const e of all) {
    if (e.type !== 2) continue; // streams only
    const bytes =
      e.size < miniCutoff ? readMini(e.startSec, e.size) : readChain(e.startSec, e.size);
    streams.set(e.name, bytes);
  }
  return streams;
}

// Walk an inflated HWP5 record stream and count records with the given tag.
function countRecords(data, wantTag) {
  let i = 0;
  let n = 0;
  while (i + 4 <= data.length) {
    const h = data.readUInt32LE(i);
    i += 4;
    const tag = h & 0x3ff;
    let size = (h >> 20) & 0xfff;
    if (size === 0xfff) {
      if (i + 4 > data.length) break;
      size = data.readUInt32LE(i);
      i += 4;
    }
    if (tag === wantTag) n++;
    i += size;
  }
  return n;
}

function detectHwpMemos(buf) {
  const streams = readCfbStreamsByName(buf);
  if (!streams) return null;
  // FileHeader flags bit 0 = compressed (BodyText sections are raw-deflate).
  const fh = streams.get("FileHeader");
  const compressed = fh && fh.length >= 40 ? (fh.readUInt32LE(36) & 1) === 1 : true;

  const perSection = {};
  let total = 0;
  for (const [name, bytes] of streams) {
    if (!/^Section\d+$/.test(name)) continue;
    let data = bytes;
    if (compressed) {
      try {
        data = inflateRawSync(bytes);
      } catch {
        continue; // unreadable section — skip rather than false-positive
      }
    }
    const c = countRecords(data, HWPTAG_MEMO_LIST);
    if (c > 0) perSection[name] = c;
    total += c;
  }
  return { format: "hwp", hasMemos: total > 0, count: total, sections: perSection };
}

// ── HWPX / ZIP ───────────────────────────────────────────────────────────────

// Minimal ZIP reader: yield [name, bytes] for entries whose name passes `want`.
function* readZipEntries(buf, want) {
  // Find the End Of Central Directory record (sig PK\x05\x06), scanning back.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0x10000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16); // central directory offset
  for (let k = 0; k < count && p + 46 <= buf.length; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (!want(name)) continue;
    // Local header → data start (its own name/extra lengths may differ).
    if (buf.readUInt32LE(lho) !== 0x04034b50) continue;
    const lNameLen = buf.readUInt16LE(lho + 26);
    const lExtraLen = buf.readUInt16LE(lho + 28);
    const dataOff = lho + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(dataOff, dataOff + compSize);
    let bytes;
    try {
      bytes = method === 0 ? comp : inflateRawSync(comp);
    } catch {
      continue;
    }
    yield [name, bytes];
  }
}

function detectHwpxMemos(buf) {
  const perFile = {};
  let total = 0;
  const want = (name) => /^Contents\/(section\d+|header)\.xml$/i.test(name);
  for (const [name, bytes] of readZipEntries(buf, want)) {
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
  if (buf.length >= 8 && buf.readUInt32LE(0) === CFB_SIG_LO && buf.readUInt32LE(4) === CFB_SIG_HI) {
    return detectHwpMemos(buf) ?? { format: "unknown", hasMemos: false, count: 0 };
  }
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) {
    return detectHwpxMemos(buf);
  }
  return { format: "unknown", hasMemos: false, count: 0 };
}

// ── reading memos ────────────────────────────────────────────────────────────

// Walk an inflated HWP5 record stream, yielding { tag, level, body }.
function* walkRecords(data) {
  let i = 0;
  while (i + 4 <= data.length) {
    const h = data.readUInt32LE(i);
    i += 4;
    const tag = h & 0x3ff;
    const level = (h >> 10) & 0x3ff;
    let size = (h >> 20) & 0xfff;
    if (size === 0xfff) {
      if (i + 4 > data.length) break;
      size = data.readUInt32LE(i);
      i += 4;
    }
    yield { tag, level, body: data.subarray(i, i + size) };
    i += size;
  }
}

// Decode an HWP5 PARA_TEXT record body to plain text. The body is UTF-16LE,
// but code points 0–31 are inline control markers: a fixed set occupy 8 wchars
// (the control + 6 params + the control again), the rest are 1 wchar.
const INLINE8 = new Set([
  1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
]);
function decodeParaText(body) {
  let out = "";
  let i = 0;
  while (i + 2 <= body.length) {
    const code = body.readUInt16LE(i);
    if (INLINE8.has(code)) {
      i += 16;
      continue;
    }
    if (code < 32) {
      if (code === 10 || code === 13) out += "\n";
      i += 2;
      continue;
    }
    out += String.fromCharCode(code);
    i += 2;
  }
  return out.normalize("NFC");
}

// Extract memos. Returns [{ index, id, location, text, anchor }] where `text`
// is the memo's own content and `anchor` is the body text the memo is attached
// to (empty if not recovered). HWP5: memo text lives in the MEMO_LIST paragraph
// list (keyed by the memo id = the MEMO_LIST 4-byte value); the anchor is the
// span between a "%%me" field-begin/end pair in the body, whose CTRL_HEADER
// carries the same id. HWPX: <hp:t> runs inside each <…:memo> element.
export function readMemos(path) {
  const buf = readFileSync(path);
  const out = [];
  if (buf.readUInt32LE(0) === CFB_SIG_LO && buf.readUInt32LE(4) === CFB_SIG_HI) {
    const streams = readCfbStreamsByName(buf);
    if (!streams) return out;
    const fh = streams.get("FileHeader");
    const compressed = fh && fh.length >= 40 ? (fh.readUInt32LE(36) & 1) === 1 : true;
    for (const [name, bytes] of streams) {
      if (!/^Section\d+$/.test(name)) continue;
      let data = bytes;
      if (compressed) {
        try {
          data = inflateRawSync(bytes);
        } catch {
          continue;
        }
      }
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
  if (buf.readUInt32LE(0) === 0x04034b50) {
    const want = (n) => /^Contents\/(section\d+|header)\.xml$/i.test(n);
    for (const [name, bytes] of readZipEntries(buf, want)) {
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

