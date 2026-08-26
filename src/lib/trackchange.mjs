// Tracked-change (변경 내용 추적) detection — the second data-loss guard.
//
// THE READ BUG. In a document with tracked changes, DELETED text is still
// physically present in the PARA_TEXT records. Nothing in the paragraph stream
// marks it: what makes it "deleted" is a separate PARA_RANGE_TAG record naming
// a character range. read.mjs walks paragraphs and prints that text verbatim,
// so an agent reading such a document sees text the author already removed,
// inlined with the live body, with no way to tell the two apart. Measured on a
// real document: 4,316 characters of insertions and 618 of deletions, silently
// mixed together.
//
// THE WRITE BUG. The rhwp engine does not model tracked changes at all — the
// same failure mode as memos (lib/memo.mjs). The change data survives a save
// only through the HWP5 serializer's per-section raw_stream fast-path, so the
// first edit that touches a section re-serializes it from an IR that never knew
// about the changes and destroys them. assertTrackChangeSafe is therefore a
// deliberate copy of assertMemoSafe's contract, with its own override flag.
//
// ── DETECTION: the part that is easy to get wrong ──────────────────────────
//
// The verdict requires TWO independent signals and refuses to fire on either
// one alone:
//
//   hasTrackChanges = FileHeader[36] bit 14
//                     AND (DocInfo tag 96/97 present OR BodyText tag 70 present)
//
// Bit 14 ALONE OVER-REPORTS. A real document was observed with the bit set and
// zero actual changes — the flag records that the feature was switched on at
// some point, not that anything was changed. Blocking every edit on that bit
// would be a guard nobody keeps. Requiring corroboration is the entire point of
// this module.
//
// HWPTAG_TRACK_CHANGE (tag 32) IS A CONFIG RECORD, NOT AN EDIT. Do not "fix"
// the detector by counting it. Every blank document this engine produces
// contains exactly one; several older fixtures contain zero. Counting tag 32
// gives a 100% false-positive rate on engine-authored files while proving
// nothing either way about real changes. Its presence proves nothing and its
// absence proves nothing — which is why hwp5.mjs names it
// TAG.TRACK_CHANGE_CONFIG rather than TAG.TRACK_CHANGE. The real change records
// are tag 97 (DocInfo) and tag 70 (BodyText).
//
// HWPX IS UNVERIFIED AND SAYS SO. OWPML carries tracked changes in its own XML
// elements, but there is no real tracked-changes .hwpx available to verify a
// scanner against, and answering "no tracked changes" for a container we cannot
// actually scan is a silent lie of exactly the kind this module exists to
// prevent. So HWPX (and any unrecognized container) returns supported:false.
// Callers MUST NOT read that as "clean" — assertTrackChangeSafe warns instead
// of blocking, because blocking on a guess would be just as wrong.
//
// Everything here reads the container directly through lib/hwp5.mjs: zero
// dependencies, works on the WASM-only tier, and — because the record scanner
// takes bytes rather than a path — is testable against synthesized streams, the
// only way to cover a document shape the engine has no API to author.

import { readFileSync } from "node:fs";
import { EXIT, fail } from "./exit-codes.mjs";
import {
  INLINE8,
  openContainer,
  TAG,
  containerFormat,
  countRecords,
  fileHeaderFlags,
  inflateStream,
  isCompressed,
  readCfbStreamsByName,
  sectionStreams,
  walkRecords,
} from "./hwp5.mjs";

// FileHeader property DWORD (offset 36) bit 14 — "변경 추적 문서". See the
// over-reporting note above: necessary, never sufficient.
export const TRACK_CHANGE_FLAG_BIT = 14;

// The tracked-change kinds encoded in the HIGH BYTE of a PARA_RANGE_TAG entry's
// third u32. Other high-byte values are range tags that have nothing to do with
// tracked changes, and are ignored rather than counted.
export const RANGE_KIND = Object.freeze({
  INSERT: 16,
  DELETE: 17,
  CHAR_SHAPE: 18,
  PARA_SHAPE: 19,
});

// kind byte → the key it accumulates into `counts`.
const KIND_KEY = Object.freeze({
  [RANGE_KIND.INSERT]: "insert",
  [RANGE_KIND.DELETE]: "delete",
  [RANGE_KIND.CHAR_SHAPE]: "charShape",
  [RANGE_KIND.PARA_SHAPE]: "paraShape",
});

function emptyCounts() {
  return { insert: 0, delete: 0, charShape: 0, paraShape: 0 };
}

function addCounts(into, from) {
  for (const k of Object.keys(into)) into[k] += from[k];
  return into;
}

export function totalChanges(counts) {
  return counts.insert + counts.delete + counts.charShape + counts.paraShape;
}

// The shape returned when we could not scan the container at all. `supported:
// false` is the load-bearing field: hasTrackChanges is false only because we
// did not look, not because we looked and found nothing.
function unsupported(format) {
  return {
    format,
    supported: false,
    hasTrackChanges: false,
    flagBit: false,
    corroborated: false,
    counts: emptyCounts(),
    authors: [],
    sections: {},
  };
}

// ── PARA_RANGE_TAG (tag 70) ────────────────────────────────────────────────

// A PARA_RANGE_TAG body is a flat array of 12-byte entries:
//   u32 start — first wchar of the range, inside this paragraph's PARA_TEXT
//   u32 end   — one past the last wchar
//   u32 tag   — HIGH byte = kind (see RANGE_KIND); LOW 24 bits = change id,
//               1-based, joining this range to a DocInfo change record.
// A trailing partial entry is ignored rather than guessed at.
export function parseRangeTags(body) {
  const out = [];
  for (let i = 0; i + 12 <= body.length; i += 12) {
    const raw = body.readUInt32LE(i + 8);
    out.push({
      start: body.readUInt32LE(i),
      end: body.readUInt32LE(i + 4),
      kind: (raw >>> 24) & 0xff,
      id: raw & 0xffffff,
      raw,
    });
  }
  return out;
}

// Expand a PARA_TEXT body to one slot PER WCHAR.
//
// decodeParaText() (hwp5.mjs) collapses inline controls to nothing, which is
// right for reading and wrong here: range-tag start/end are expressed in wchar
// positions, so collapsing them shifts every offset and the extracted text
// slides off its range. This decoder keeps the 1:1 wchar→slot mapping (an
// 8-wchar inline control contributes 8 empty slots) so `slice(start, end)` is
// exact.
function paraWchars(body) {
  const slots = [];
  let i = 0;
  while (i + 2 <= body.length) {
    const code = body.readUInt16LE(i);
    if (INLINE8.has(code)) {
      for (let k = 0; k < 8; k++) slots.push("");
      i += 16;
      continue;
    }
    if (code < 32) {
      slots.push(code === 10 || code === 13 ? "\n" : "");
      i += 2;
      continue;
    }
    slots.push(String.fromCharCode(code));
    i += 2;
  }
  return slots;
}

// Scan ONE inflated record stream (a BodyText/SectionN stream) for tracked-change
// ranges. Takes bytes, not a path, so tests can synthesize a stream with
// hwp5.buildRecords and drive this directly — there is no way to author a
// tracked-changes .hwp with the engine, and a real one cannot be committed.
//
// Returns { counts, entries, rangeTagRecords }. `rangeTagRecords` counts tag-70
// records regardless of kind: it is the corroboration signal, deliberately
// looser than `counts`, so a range tag whose kind byte we do not recognize
// still stops us from claiming the document is clean.
export function scanRecordStream(data, location = "") {
  const counts = emptyCounts();
  const entries = [];
  let rangeTagRecords = 0;
  let slots = [];
  let paragraph = -1;

  for (const { tag, body } of walkRecords(data)) {
    if (tag === TAG.PARA_HEADER) {
      // Paragraph ordinal in STREAM order, counting nested (table-cell)
      // paragraphs too. It is a human-readable pointer, not an engine address.
      paragraph++;
      slots = [];
      continue;
    }
    if (tag === TAG.PARA_TEXT) {
      slots = paraWchars(body);
      continue;
    }
    if (tag !== TAG.PARA_RANGE_TAG) continue;

    rangeTagRecords++;
    for (const e of parseRangeTags(body)) {
      const key = KIND_KEY[e.kind];
      if (!key) continue; // a range tag, but not a tracked-change one
      counts[key]++;
      entries.push({
        kind: key,
        id: e.id,
        start: e.start,
        end: e.end,
        // For a Delete this is the ORIGINAL text, still sitting in the body —
        // the whole reason a plain read is misleading.
        text: slots.slice(e.start, e.end).join("").normalize("NFC"),
        paragraph,
        location: location ? `${location}:para${paragraph}` : `para${paragraph}`,
      });
    }
  }
  return { counts, entries, rangeTagRecords };
}

// ── DocInfo (tags 96 / 97) ─────────────────────────────────────────────────

// HWPTAG_TRACK_CHANGE_AUTHOR (96) begins with a WCHAR array: u16 length in
// characters, then that many UTF-16LE code units. Anything after the name is
// left alone — we only need the name, and guessing at undocumented trailing
// fields buys nothing.
function parseAuthorName(body) {
  if (body.length < 2) return "";
  const len = body.readUInt16LE(0);
  const end = 2 + len * 2;
  if (len === 0 || end > body.length) return "";
  return body.toString("utf16le", 2, end).replace(/\0+$/, "").normalize("NFC");
}

// Author names, in record order, de-duplicated. Empty when DocInfo is missing
// or unreadable — never null, so callers can iterate unconditionally.
function readAuthors(docInfo) {
  if (!docInfo) return [];
  const seen = [];
  for (const { tag, body } of walkRecords(docInfo)) {
    if (tag !== TAG.TRACK_CHANGE_AUTHOR) continue;
    const name = parseAuthorName(body);
    if (name && !seen.includes(name)) seen.push(name);
  }
  return seen;
}

// ── public API ─────────────────────────────────────────────────────────────

// Detect tracked changes in an .hwp file. Returns
//   { format, supported, hasTrackChanges, flagBit, corroborated,
//     counts: {insert, delete, charShape, paraShape}, authors, sections }
// `sections` maps each section stream that carries changes to its own counts.
//
// supported:false (HWPX, HWP3, anything unrecognized) means WE DID NOT LOOK.
// Treating it as "clean" is the bug this field exists to prevent.
export function detectTrackChanges(path, { forceScan = false } = {}) {
  const container = openContainer(path);
  if (container.format !== "hwp") return unsupported(container.format);

  const streams = container.streams;
  if (!streams) return unsupported("hwp");

  const flags = fileHeaderFlags(streams);
  const flagBit = flags != null && ((flags >>> TRACK_CHANGE_FLAG_BIT) & 1) === 1;

  // SHORT-CIRCUIT. The verdict is `flagBit && corroborated`, so when the flag
  // is clear the corroboration scan cannot change the answer — and that scan is
  // the expensive half: inflating every BodyText section and walking its
  // records (113 ms on a 199 MB document). Measured over 40 real files, only 3
  // have the flag set, so 37 of them were paying for a walk whose result was
  // already decided.
  //
  // `corroborationScanned` keeps this honest. The module's whole contract is
  // that a caller can tell "none" from "could not look" (read.mjs relies on it),
  // so `corroborated: false` must not be read as "checked and found nothing"
  // when nothing was checked. The VERDICT is still certain: no flag means no
  // tracked changes, definitively.
  if (!flagBit && !forceScan) {
    return {
      format: "hwp",
      supported: true,
      hasTrackChanges: false,
      flagBit: false,
      corroborated: false,
      corroborationScanned: false,
      counts: emptyCounts(),
      authors: [],
      sections: {},
    };
  }

  const compressed = container.compressed;
  const docInfoRaw = streams.get("DocInfo");
  const docInfo = docInfoRaw ? inflateStream(docInfoRaw, compressed) : null;
  // Tag 96 = the author list, tag 97 = the change records themselves. Tag 32
  // (TRACK_CHANGE_CONFIG) is deliberately NOT consulted — see the header.
  const authorRecords = docInfo ? countRecords(docInfo, TAG.TRACK_CHANGE_AUTHOR) : 0;
  const changeRecords = docInfo ? countRecords(docInfo, TAG.TRACK_CHANGE) : 0;
  const authors = readAuthors(docInfo);

  const counts = emptyCounts();
  const sections = {};
  let rangeTagRecords = 0;
  for (const [name, data] of container.sections) {
    const s = scanRecordStream(data, name);
    rangeTagRecords += s.rangeTagRecords;
    addCounts(counts, s.counts);
    if (totalChanges(s.counts) > 0) sections[name] = s.counts;
  }

  const corroborated = authorRecords > 0 || changeRecords > 0 || rangeTagRecords > 0;
  return {
    format: "hwp",
    supported: true,
    // Boolean() on purpose: assertTrackChangeSafe branches on this, and an
    // `undefined` here would silently disarm every write guard in the repo.
    hasTrackChanges: Boolean(flagBit && corroborated),
    flagBit,
    corroborated,
    corroborationScanned: true,
    counts,
    authors,
    sections,
  };
}

// Extract the individual changes. Returns
//   [{ index, kind, author, id, text, location }]
// where `kind` is insert|delete|charShape|paraShape and `text` is the body text
// the range covers (for a delete: the original text the document still holds).
//
// AUTHOR ATTRIBUTION IS DELIBERATELY CONSERVATIVE. A range tag carries a change
// id, and DocInfo's tag-97 records carry the author — but that record's internal
// layout is not publicly documented and there is no fixture here to verify a
// decode against. A confidently WRONG name on someone's edit is worse than no
// name, so: with exactly one author in the document every change is attributed
// to them (that inference cannot be wrong), and otherwise `author` is "". The
// full author list is available from detectTrackChanges().authors.
export function readTrackChanges(path) {
  const buf = readFileSync(path);
  if (containerFormat(buf) !== "hwp") return [];
  const streams = readCfbStreamsByName(buf);
  if (!streams) return [];

  const compressed = isCompressed(streams);
  const docInfoRaw = streams.get("DocInfo");
  const authors = readAuthors(docInfoRaw ? inflateStream(docInfoRaw, compressed) : null);
  const soleAuthor = authors.length === 1 ? authors[0] : "";

  const out = [];
  for (const [name, data] of sectionStreams(streams)) {
    for (const e of scanRecordStream(data, name).entries) {
      out.push({
        index: out.length,
        kind: e.kind,
        author: soleAuthor,
        id: e.id,
        text: e.text,
        location: e.location,
      });
    }
  }
  return out;
}

// Diagnostic only: how many HWPTAG_TRACK_CHANGE_CONFIG (tag 32) records the
// document carries, across DocInfo and every section. NOT part of the verdict —
// it exists so the test suite can assert the selectivity property directly:
// documents with tag-32 records still report hasTrackChanges === false. If you
// ever feel tempted to add this to the detector, read the header first.
export function countTrackChangeConfigRecords(path) {
  const buf = readFileSync(path);
  if (containerFormat(buf) !== "hwp") return 0;
  const streams = readCfbStreamsByName(buf);
  if (!streams) return 0;
  const compressed = isCompressed(streams);
  const docInfoRaw = streams.get("DocInfo");
  const docInfo = docInfoRaw ? inflateStream(docInfoRaw, compressed) : null;
  let n = docInfo ? countRecords(docInfo, TAG.TRACK_CHANGE_CONFIG) : 0;
  for (const [, data] of sectionStreams(streams)) {
    n += countRecords(data, TAG.TRACK_CHANGE_CONFIG);
  }
  return n;
}

// ── edit guard ─────────────────────────────────────────────────────────────

// The guard every write script runs before editing, alongside assertMemoSafe.
// If the input has tracked changes and the caller did not pass
// --allow-trackchange-loss, refuse (exit UNSAFE=6) with an actionable message,
// because the engine will silently destroy every recorded change on save.
//
// Two deliberate non-blocks:
//   • a scan ERROR never blocks (a missing/corrupt file is the load path's
//     problem, and a guard that fails closed on its own bugs is a guard that
//     gets deleted). It is also silent — loadDocument is about to report the
//     real failure one line later, and a warning here would just bury it.
//   • an UNSCANNABLE container (HWPX) does not block either, because refusing
//     on a guess would break every legitimate HWPX edit. It DOES warn: we
//     genuinely cannot tell, and saying nothing would imply we checked.
// Returns the detection result so callers can log it.
export function assertTrackChangeSafe(inputPath, argv = process.argv) {
  let info;
  try {
    info = detectTrackChanges(inputPath);
  } catch {
    return unsupported("unknown"); // never block on a scan error
  }

  if (!info.supported) {
    process.stderr.write(
      `WARNING: cannot scan this container (format: ${info.format}) for tracked changes ` +
        `(변경 내용 추적).\n` +
        `         If the document has any, the engine does NOT model them and this edit will\n` +
        `         silently destroy them. Proceeding — but this is unchecked, not verified clean.\n`,
    );
    return info;
  }

  if (info.hasTrackChanges && !argv.includes("--allow-trackchange-loss")) {
    const c = info.counts;
    const parts = [];
    if (c.insert) parts.push(`${c.insert} insertion(s)`);
    if (c.delete) parts.push(`${c.delete} deletion(s)`);
    if (c.charShape) parts.push(`${c.charShape} character-format change(s)`);
    if (c.paraShape) parts.push(`${c.paraShape} paragraph-format change(s)`);
    const what = parts.length ? parts.join(", ") : "recorded changes";
    const where = Object.keys(info.sections).join(", ");
    fail(
      EXIT.UNSAFE,
      `error: this document has tracked changes / 변경 내용 추적 (${what}${where ? ` in ${where}` : ""}), ` +
        `and the rhwp engine CANNOT preserve tracked changes through an edit —\n` +
        `       saving the edit would silently destroy every recorded change, including the\n` +
        `       original text that each deletion still holds. Refusing.\n` +
        `       • To inspect the changes first:  node src/core/read.mjs "${inputPath}" --track-changes\n` +
        `       • To edit anyway and accept losing them: re-run with --allow-trackchange-loss`,
    );
  }
  return info;
}
