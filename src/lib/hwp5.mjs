// HWP5 / HWPX container plumbing — pure functions over a Buffer.
//
// Split out of memo.mjs unchanged. Memos were the first thing the rhwp engine
// did not model, so memo.mjs grew its own CFB reader, record walker and
// PARA_TEXT decoder. Tracked changes are the second (lib/trackchange.mjs), and
// two hand-rolled compound-file parsers in one repo is one too many.
//
// Everything here takes bytes and returns data: no filesystem, no process exit,
// no engine. That is what lets the record-level tests synthesize a stream and
// assert on the parser directly, without a fixture the engine cannot author.
//
// Formats:
//   HWP5 (.hwp)  = OLE/CFB compound file; BodyText/SectionN streams are
//                  raw-deflate when FileHeader flag bit 0 is set.
//   HWPX (.hwpx) = ZIP of OWPML XML parts.

import { inflateRawSync } from "node:zlib";

// ── signatures ─────────────────────────────────────────────────────────────

export const CFB_SIG_LO = 0xe011cfd0; // bytes D0 CF 11 E0 (LE u32)
export const CFB_SIG_HI = 0xe11ab1a1; // bytes A1 B1 1A E1 (LE u32)
export const ZIP_SIG = 0x04034b50;

const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;

export function isCfb(buf) {
  return (
    buf.length >= 8 && buf.readUInt32LE(0) === CFB_SIG_LO && buf.readUInt32LE(4) === CFB_SIG_HI
  );
}

export function isZip(buf) {
  return buf.length >= 4 && buf.readUInt32LE(0) === ZIP_SIG;
}

// "hwp" | "hwpx" | "unknown". `unknown` means the container could not be
// scanned at all (e.g. HWP3) — callers MUST treat it as "could not rule it
// out", never as "clean".
export function containerFormat(buf) {
  if (isCfb(buf)) return "hwp";
  if (isZip(buf)) return "hwpx";
  return "unknown";
}

// ── HWP5 record tags ───────────────────────────────────────────────────────

export const HWPTAG_BEGIN = 0x10;
export const TAG = Object.freeze({
  DOCUMENT_PROPERTIES: HWPTAG_BEGIN + 0, // 16
  ID_MAPPINGS: HWPTAG_BEGIN + 1, // 17
  TRACK_CHANGE_CONFIG: HWPTAG_BEGIN + 16, // 32 — CONFIG, not an edit. See below.
  PARA_HEADER: HWPTAG_BEGIN + 50, // 66
  PARA_TEXT: HWPTAG_BEGIN + 51, // 67
  PARA_CHAR_SHAPE: HWPTAG_BEGIN + 52, // 68
  PARA_LINE_SEG: HWPTAG_BEGIN + 53, // 69
  PARA_RANGE_TAG: HWPTAG_BEGIN + 54, // 70 — body tracked-change ranges
  CTRL_HEADER: HWPTAG_BEGIN + 55, // 71
  MEMO_LIST: HWPTAG_BEGIN + 77, // 93
  TRACK_CHANGE_AUTHOR: HWPTAG_BEGIN + 80, // 96
  TRACK_CHANGE: HWPTAG_BEGIN + 81, // 97
});

// ── CFB ────────────────────────────────────────────────────────────────────

// Read every CFB stream, keyed by its (local) directory name. HWP5 stream names
// are unique enough for our needs — "FileHeader", "Section0", "DocInfo", … — so
// we skip full red-black-tree path reconstruction and key by local name.
// Returns null when `buf` is not a compound file.
export function readCfbStreamsByName(buf) {
  if (buf.length < 512 || !isCfb(buf)) return null;

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
    return sizeLimit != null && out.length > sizeLimit ? out.subarray(0, sizeLimit) : out;
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

// FileHeader flag bit 0 — are the record streams raw-deflate compressed?
// Absent/short FileHeader is treated as compressed, which is the common case.
export function isCompressed(streams) {
  const fh = streams?.get("FileHeader");
  return fh && fh.length >= 40 ? (fh.readUInt32LE(36) & 1) === 1 : true;
}

// The FileHeader property DWORD at offset 36 (flags). Returns null when absent.
export function fileHeaderFlags(streams) {
  const fh = streams?.get("FileHeader");
  return fh && fh.length >= 40 ? fh.readUInt32LE(36) : null;
}

// Inflate a record stream if the container says it is compressed. Returns null
// when the stream is unreadable — callers must not treat that as "empty",
// which would turn a parse failure into a false "nothing found".
export function inflateStream(bytes, compressed) {
  if (!compressed) return bytes;
  try {
    return inflateRawSync(bytes);
  } catch {
    return null;
  }
}

// Yield [name, inflatedBytes] for each BodyText section stream, in name order.
export function* sectionStreams(streams) {
  const names = [...streams.keys()].filter((n) => /^Section\d+$/.test(n));
  names.sort((a, b) => Number(a.slice(7)) - Number(b.slice(7)));
  const compressed = isCompressed(streams);
  for (const name of names) {
    const data = inflateStream(streams.get(name), compressed);
    if (data) yield [name, data];
  }
}

// ── record stream ──────────────────────────────────────────────────────────

// Walk an inflated HWP5 record stream, yielding { tag, level, body }.
// Header: u32 = tag(10) | level(10) | size(12); size 0xfff means the real
// size is the next u32.
export function* walkRecords(data) {
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

export function countRecords(data, wantTag) {
  let n = 0;
  for (const r of walkRecords(data)) if (r.tag === wantTag) n++;
  return n;
}

// Build a record stream from {tag, level, body} entries — the inverse of
// walkRecords. Only used by tests, to synthesize streams for document shapes
// the engine has no authoring API for (tracked changes).
export function buildRecords(records) {
  const parts = [];
  for (const { tag, level = 0, body = Buffer.alloc(0) } of records) {
    const big = body.length >= 0xfff;
    const size = big ? 0xfff : body.length;
    const head = Buffer.alloc(big ? 8 : 4);
    head.writeUInt32LE(((tag & 0x3ff) | ((level & 0x3ff) << 10) | (size << 20)) >>> 0, 0);
    if (big) head.writeUInt32LE(body.length, 4);
    parts.push(head, body);
  }
  return Buffer.concat(parts);
}

// ── text ───────────────────────────────────────────────────────────────────

// Code points 0-31 inside PARA_TEXT are inline control markers. This set
// occupies 8 wchars (the control + 6 params + the control again); the rest are
// 1 wchar.
export const INLINE8 = new Set([
  1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
]);

// Decode a PARA_TEXT record body (UTF-16LE + inline control markers) to text.
export function decodeParaText(body) {
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

// Byte offset of `s` encoded UTF-16LE in `buf` (-1 if absent).
export function indexOfUtf16(buf, s) {
  return buf.indexOf(Buffer.from(s, "utf16le"));
}

// ── ZIP (HWPX) ─────────────────────────────────────────────────────────────

// Minimal ZIP reader: yield [name, bytes] for entries whose name passes `want`.
export function* readZipEntries(buf, want) {
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

// The OWPML parts that carry body content.
export const HWPX_CONTENT_PART = /^Contents\/(section\d+|header)\.xml$/i;
