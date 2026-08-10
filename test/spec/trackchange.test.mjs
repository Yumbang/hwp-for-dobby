// Spec tests for the tracked-change (변경 내용 추적) data-loss guard —
// src/lib/trackchange.mjs plus its two wirings: the write-script guard
// (assertTrackChangeSafe) and read.mjs (--track-changes, and the warning a
// plain read emits).
//
// THE BUG these tests pin, in two halves:
//
//   READ — in a document with tracked changes the DELETED text is still
//   physically present in the PARA_TEXT records. read.mjs printed it as live
//   body text, so an agent saw text the author had already removed with no
//   indication. Measured on a real document: 4,316 characters of insertions and
//   618 of deletions, silently mixed together.
//
//   WRITE — the engine does not model tracked changes at all, so editing such a
//   document destroys them exactly the way editing a memo-bearing document
//   destroys memos. Hence exit UNSAFE(6) unless --allow-trackchange-loss.
//
// ── WHY THERE IS NO FIXTURE, AND WHAT WE DO INSTEAD ─────────────────────────
//
// A tracked-changes .hwp cannot be committed and cannot be authored:
//   • the engine has no API to create tracked changes, so we cannot generate
//     one; and
//   • a real one cannot go into public git history. A Delete range PRESERVES
//     the original text, and the container also carries the authors' real
//     names, PrvText and HwpSummaryInformation. A test that failed and printed
//     a diff would leak someone's private document, permanently.
//
// So the coverage is built three ways, in descending order of directness:
//
//   1. SYNTHESIZED CONTAINERS. hwp5.buildRecords is the inverse of walkRecords
//      and exists for exactly this; below it is paired with a small CFB writer
//      so we can put a *real file on disk* and spawn the real write scripts
//      against it. The rhwp engine refuses to LOAD these files (its CFB reader
//      wants a full red-black directory tree) — which does not matter, because
//      every guard under test runs before the engine ever sees the input. Where
//      a script loads first, that is called out at the assertion.
//   2. THE SELECTIVITY INEQUALITY, on the real committed samples: several of
//      them contain HWPTAG_TRACK_CHANGE_CONFIG (tag 32) records, and every one
//      of them must still report NO tracked changes. That is the exact false
//      positive the design avoids, asserted on real bytes.
//   3. HWP_TRACKED_FIXTURE=<path>, an opt-in end-to-end pass for whoever has a
//      real tracked document locally. Skipped, cleanly, when unset.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { TAG, buildRecords } from "../../src/lib/hwp5.mjs";
import {
  RANGE_KIND,
  TRACK_CHANGE_FLAG_BIT,
  assertTrackChangeSafe,
  countTrackChangeConfigRecords,
  detectTrackChanges,
  parseRangeTags,
  readTrackChanges,
  scanRecordStream,
  totalChanges,
} from "../../src/lib/trackchange.mjs";
import { EXIT } from "../../src/lib/exit-codes.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const sample = (name) => join(ROOT, "samples", name);

// ── synthesizing a container ────────────────────────────────────────────────

// A minimal CFB (OLE compound file) writer, just large enough for the three
// streams the detector reads: FileHeader, DocInfo, Section0.
//
// This is NOT a general-purpose writer and must not become one — it exists so a
// tracked-changes document can EXIST ON DISK for the guard tests without a
// fixture we are not allowed to commit. Every stream goes through the mini
// stream; the FAT is a single sector; HWP5's BodyText storage is flattened away
// because readCfbStreamsByName keys streams by local name and ignores the
// directory hierarchy.
const SEC = 512;
const MINI = 64;
const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;
const FATSECT = 0xfffffffd;

function buildCfb(entries) {
  const miniParts = [];
  const miniFat = [];
  const meta = [];
  let miniSectors = 0;
  for (const [name, data] of entries) {
    const n = Math.max(1, Math.ceil(data.length / MINI));
    const start = miniSectors;
    for (let k = 0; k < n; k++) miniFat.push(k === n - 1 ? ENDOFCHAIN : start + k + 1);
    const padded = Buffer.alloc(n * MINI);
    data.copy(padded);
    miniParts.push(padded);
    meta.push({ name, start, size: data.length });
    miniSectors += n;
  }
  const miniStream = Buffer.concat(miniParts);
  const miniStreamSectors = Math.max(1, Math.ceil(miniStream.length / SEC));

  // Sector plan: 0 = FAT, 1 = directory, 2 = mini FAT, 3… = the mini stream.
  const DIR_SEC = 1;
  const MINIFAT_SEC = 2;
  const MINI_START = 3;

  const fat = new Array(SEC / 4).fill(FREESECT);
  fat[0] = FATSECT;
  fat[DIR_SEC] = ENDOFCHAIN;
  fat[MINIFAT_SEC] = ENDOFCHAIN;
  for (let k = 0; k < miniStreamSectors; k++) {
    fat[MINI_START + k] = k === miniStreamSectors - 1 ? ENDOFCHAIN : MINI_START + k + 1;
  }

  const header = Buffer.alloc(SEC);
  header.writeUInt32LE(0xe011cfd0, 0); // D0 CF 11 E0
  header.writeUInt32LE(0xe11ab1a1, 4); // A1 B1 1A E1
  header.writeUInt16LE(0x3e, 24);
  header.writeUInt16LE(3, 26);
  header.writeUInt16LE(0xfffe, 28);
  header.writeUInt16LE(9, 30); // 1 << 9 = 512
  header.writeUInt16LE(6, 32); // 1 << 6 = 64
  header.writeUInt32LE(1, 44);
  header.writeUInt32LE(DIR_SEC, 48);
  header.writeUInt32LE(4096, 56); // mini-stream cutoff
  header.writeUInt32LE(MINIFAT_SEC, 60);
  header.writeUInt32LE(1, 64);
  header.writeUInt32LE(ENDOFCHAIN, 68);
  for (let i = 0; i < 109; i++) header.writeUInt32LE(FREESECT, 76 + i * 4);
  header.writeUInt32LE(0, 76); // DIFAT[0] → FAT sector 0

  const dir = Buffer.alloc(SEC);
  const writeEntry = (idx, name, type, startSec, size) => {
    const off = idx * 128;
    const nm = Buffer.from(name + "\0", "utf16le");
    nm.copy(dir, off);
    dir.writeUInt16LE(nm.length, off + 64);
    dir.writeUInt8(type, off + 66);
    dir.writeUInt8(1, off + 67);
    dir.writeUInt32LE(FREESECT, off + 68); // left sibling
    dir.writeUInt32LE(FREESECT, off + 72); // right sibling
    dir.writeUInt32LE(FREESECT, off + 76); // child
    dir.writeUInt32LE(startSec >>> 0, off + 116);
    dir.writeUInt32LE(size >>> 0, off + 120);
  };
  writeEntry(0, "Root Entry", 5, MINI_START, miniStream.length);
  meta.forEach((m, i) => writeEntry(i + 1, m.name, 2, m.start, m.size));

  const miniFatSec = Buffer.alloc(SEC, 0xff);
  miniFat.forEach((v, i) => miniFatSec.writeUInt32LE(v >>> 0, i * 4));
  const fatSec = Buffer.alloc(SEC);
  fat.forEach((v, i) => fatSec.writeUInt32LE(v >>> 0, i * 4));

  const body = Buffer.alloc((MINI_START + miniStreamSectors) * SEC);
  fatSec.copy(body, 0);
  dir.copy(body, DIR_SEC * SEC);
  miniFatSec.copy(body, MINIFAT_SEC * SEC);
  miniStream.copy(body, MINI_START * SEC);
  return Buffer.concat([header, body]);
}

// A 12-byte PARA_RANGE_TAG entry: start, end, then the packed tag whose HIGH
// byte is the kind and whose LOW 24 bits are the 1-based change id.
function rangeEntry(start, end, kind, id) {
  const b = Buffer.alloc(12);
  b.writeUInt32LE(start, 0);
  b.writeUInt32LE(end, 4);
  b.writeUInt32LE((((kind & 0xff) << 24) | (id & 0xffffff)) >>> 0, 8);
  return b;
}

function rangeTagBody(entries) {
  return Buffer.concat(entries.map((e) => rangeEntry(e.start, e.end, e.kind, e.id)));
}

// A HWPTAG_TRACK_CHANGE_AUTHOR body: u16 character count, then UTF-16LE.
function authorRecordBody(name) {
  const chars = Buffer.from(name, "utf16le");
  const b = Buffer.alloc(2 + chars.length + 4); // + undocumented trailing fields
  b.writeUInt16LE(name.length, 0);
  chars.copy(b, 2);
  return b;
}

// Build a section record stream from [{ text, ranges }] paragraphs.
function sectionStream(paragraphs) {
  const recs = [];
  for (const p of paragraphs) {
    recs.push({ tag: TAG.PARA_HEADER, body: Buffer.alloc(22) });
    recs.push({ tag: TAG.PARA_TEXT, body: Buffer.from(p.text, "utf16le") });
    if (p.ranges?.length) {
      recs.push({ tag: TAG.PARA_RANGE_TAG, body: rangeTagBody(p.ranges) });
    }
  }
  return buildRecords(recs);
}

// Write a synthetic .hwp to `path`.
//   flagBit       — FileHeader offset-36 bit 14
//   authors       — DocInfo tag-96 records
//   changeRecords — DocInfo tag-97 records
//   configRecords — DocInfo tag-32 records (TRACK_CHANGE_CONFIG: config, NOT an
//                   edit — present here precisely so tests can prove it is
//                   ignored)
//   paragraphs    — the Section0 body
// Streams are written UNCOMPRESSED (FileHeader flag bit 0 clear), which
// isCompressed() honors, so no deflate step is needed.
function writeSynthDoc(path, opts = {}) {
  const {
    flagBit = true,
    authors = ["홍길동"],
    changeRecords = 1,
    configRecords = 1,
    paragraphs = [],
  } = opts;

  const fileHeader = Buffer.alloc(256);
  fileHeader.write("HWP Document File", 0, "latin1");
  fileHeader.writeUInt32LE(0x05000500, 32);
  fileHeader.writeUInt32LE(flagBit ? 1 << TRACK_CHANGE_FLAG_BIT : 0, 36);

  const docRecs = [];
  for (let i = 0; i < configRecords; i++) {
    docRecs.push({ tag: TAG.TRACK_CHANGE_CONFIG, body: Buffer.alloc(8) });
  }
  for (const a of authors) {
    docRecs.push({ tag: TAG.TRACK_CHANGE_AUTHOR, body: authorRecordBody(a) });
  }
  for (let i = 0; i < changeRecords; i++) {
    docRecs.push({ tag: TAG.TRACK_CHANGE, body: Buffer.alloc(12) });
  }

  writeFileSync(
    path,
    buildCfb([
      ["FileHeader", fileHeader],
      ["DocInfo", buildRecords(docRecs)],
      ["Section0", sectionStream(paragraphs)],
    ]),
  );
  return path;
}

// ── scratch dir + the documents every guard test shares ─────────────────────

let TMP;
let TRACKED; // bit 14 + authors + change records + real ranges
let FLAG_ONLY; // bit 14 and NOTHING else — the over-reporting case
let CONFIG_ONLY; // tag-32 config records only, no flag, no ranges

test.before(() => {
  TMP = mkdtempSync(join(tmpdir(), "hwp-trackchange-test-"));
  TRACKED = writeSynthDoc(join(TMP, "tracked.hwp"), {
    paragraphs: [
      {
        text: "가나다라마바사",
        ranges: [
          { start: 0, end: 3, kind: RANGE_KIND.INSERT, id: 1 },
          { start: 3, end: 7, kind: RANGE_KIND.DELETE, id: 2 },
        ],
      },
    ],
  });
  FLAG_ONLY = writeSynthDoc(join(TMP, "flag-only.hwp"), {
    flagBit: true,
    authors: [],
    changeRecords: 0,
    configRecords: 1,
    paragraphs: [{ text: "변경 없는 문서" }],
  });
  CONFIG_ONLY = writeSynthDoc(join(TMP, "config-only.hwp"), {
    flagBit: false,
    authors: [],
    changeRecords: 0,
    configRecords: 3,
    paragraphs: [{ text: "변경 없는 문서" }],
  });
});
test.after(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
});

function run(script, args) {
  return spawnSync(process.execPath, [join("src", "core", script), ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

// Capture whatever a synchronous call writes to stderr. Only used on paths that
// are asserted NOT to exit, so nothing can escape the restore.
function captureStderr(fn) {
  const orig = process.stderr.write;
  let buf = "";
  process.stderr.write = (chunk) => {
    buf += chunk;
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = orig;
  }
  return buf;
}

// ── 1. the PARA_RANGE_TAG decoder, driven directly ──────────────────────────

test("parseRangeTags: decodes {start,end,kind,id} for all four tracked kinds", () => {
  // One entry per kind, each with a distinct id, so a swapped field or an
  // off-by-one in the 12-byte stride shows up as a wrong value, not a crash.
  const spec = [
    { start: 0, end: 5, kind: RANGE_KIND.INSERT, id: 1 },
    { start: 5, end: 9, kind: RANGE_KIND.DELETE, id: 2 },
    { start: 9, end: 12, kind: RANGE_KIND.CHAR_SHAPE, id: 3 },
    { start: 12, end: 40, kind: RANGE_KIND.PARA_SHAPE, id: 4 },
  ];
  const got = parseRangeTags(rangeTagBody(spec));
  assert.equal(got.length, 4, "one decoded entry per 12 bytes");
  for (let i = 0; i < spec.length; i++) {
    assert.equal(got[i].start, spec[i].start, `entry ${i}: start`);
    assert.equal(got[i].end, spec[i].end, `entry ${i}: end`);
    assert.equal(got[i].kind, spec[i].kind, `entry ${i}: kind must come from the HIGH byte`);
    assert.equal(got[i].id, spec[i].id, `entry ${i}: id must come from the LOW 24 bits`);
  }
  // Pin the kind numbering itself: 16/17/18/19 is the wire format, not a
  // local convention, and renumbering it would silently reclassify every change.
  assert.deepEqual(
    [RANGE_KIND.INSERT, RANGE_KIND.DELETE, RANGE_KIND.CHAR_SHAPE, RANGE_KIND.PARA_SHAPE],
    [16, 17, 18, 19],
  );
});

test("parseRangeTags: the high-byte/low-24-bit split holds at the boundaries", () => {
  // The largest id that fits in 24 bits, under the largest kind byte we name.
  // A mask written as 0xffff or a shift of 16 would both pass the small-id
  // cases above and fail here.
  const [e] = parseRangeTags(rangeEntry(0, 1, RANGE_KIND.PARA_SHAPE, 0xffffff));
  assert.equal(e.kind, 19);
  assert.equal(e.id, 0xffffff);
  assert.equal(e.raw >>> 0, 0x13ffffff, "packed tag = kind<<24 | id");

  // …and an id whose top bit would sign-extend if the shift were arithmetic.
  const [f] = parseRangeTags(rangeEntry(0, 1, 0xff, 0x800000));
  assert.equal(f.kind, 0xff, "kind must be read unsigned");
  assert.equal(f.id, 0x800000);
});

test("parseRangeTags: a trailing partial entry is dropped, not guessed at", () => {
  const body = Buffer.concat([
    rangeEntry(0, 2, RANGE_KIND.INSERT, 1),
    Buffer.alloc(7), // half an entry
  ]);
  assert.equal(parseRangeTags(body).length, 1);
});

// ── 2. the section scanner, over a synthesized record stream ────────────────

test("scanRecordStream: counts by kind and lifts each range's covered text", () => {
  const data = sectionStream([
    {
      text: "가나다라마바사",
      ranges: [
        { start: 0, end: 3, kind: RANGE_KIND.INSERT, id: 1 },
        { start: 3, end: 7, kind: RANGE_KIND.DELETE, id: 2 },
      ],
    },
    {
      text: "두번째문단",
      ranges: [{ start: 1, end: 3, kind: RANGE_KIND.CHAR_SHAPE, id: 3 }],
    },
  ]);
  const { counts, entries, rangeTagRecords } = scanRecordStream(data, "Section0");

  assert.deepEqual(counts, { insert: 1, delete: 1, charShape: 1, paraShape: 0 });
  assert.equal(totalChanges(counts), 3);
  assert.equal(rangeTagRecords, 2, "two paragraphs carried a PARA_RANGE_TAG record");

  assert.equal(entries[0].kind, "insert");
  assert.equal(entries[0].text, "가나다");
  // A DELETE keeps the ORIGINAL text — this string is exactly what a plain read
  // prints as if it were live body text. That is the whole bug.
  assert.equal(entries[1].kind, "delete");
  assert.equal(entries[1].text, "라마바사");
  // Ranges resolve against THEIR OWN paragraph, not the first one seen.
  assert.equal(entries[2].text, "번째");
  assert.equal(entries[0].location, "Section0:para0");
  assert.equal(entries[2].location, "Section0:para1");
});

test("scanRecordStream: range offsets are WCHAR positions, so inline controls count", () => {
  // An inline control (code 3 here) occupies 8 wchars in PARA_TEXT but decodes
  // to no text at all. decodeParaText collapses it, which would slide every
  // later offset left by 8 — the reason trackchange.mjs has its own
  // position-preserving decoder. Range [9,12) must land on "나다라".
  const control = Buffer.alloc(16);
  control.writeUInt16LE(3, 0);
  control.writeUInt16LE(3, 14);
  const text = Buffer.concat([
    Buffer.from("가", "utf16le"), // wchar 0
    control, // wchars 1–8
    Buffer.from("나다라마", "utf16le"), // wchars 9–12
  ]);
  const data = buildRecords([
    { tag: TAG.PARA_HEADER, body: Buffer.alloc(22) },
    { tag: TAG.PARA_TEXT, body: text },
    { tag: TAG.PARA_RANGE_TAG, body: rangeEntry(9, 12, RANGE_KIND.DELETE, 1) },
  ]);
  const { entries } = scanRecordStream(data, "Section0");
  assert.equal(entries.length, 1);
  assert.equal(
    entries[0].text,
    "나다라",
    "a collapsed inline control would have shifted this range off its text",
  );
});

test("scanRecordStream: an unrecognized range kind is not counted but still corroborates", () => {
  // Range tags exist for things other than tracked changes. We refuse to COUNT
  // a kind we cannot name (that would be inventing changes), but we still let
  // it corroborate, because "there is a range tag here I do not understand" is
  // not evidence that the document is clean — and this guard's job is to fail
  // toward refusing an edit, not toward permitting one.
  const data = buildRecords([
    { tag: TAG.PARA_HEADER, body: Buffer.alloc(22) },
    { tag: TAG.PARA_TEXT, body: Buffer.from("본문", "utf16le") },
    { tag: TAG.PARA_RANGE_TAG, body: rangeEntry(0, 2, 42, 1) },
  ]);
  const { counts, entries, rangeTagRecords } = scanRecordStream(data, "Section0");
  assert.equal(totalChanges(counts), 0, "an unnamed kind must not be counted as a change");
  assert.equal(entries.length, 0);
  assert.equal(rangeTagRecords, 1, "but it must still register as corroboration");
});

// ── 3. the verdict: two signals, and neither alone ──────────────────────────

test("detectTrackChanges: flag bit + corroboration → hasTrackChanges", () => {
  const info = detectTrackChanges(TRACKED);
  assert.equal(info.format, "hwp");
  assert.equal(info.supported, true);
  assert.equal(info.flagBit, true);
  assert.equal(info.corroborated, true);
  assert.equal(info.hasTrackChanges, true);
  assert.deepEqual(info.counts, { insert: 1, delete: 1, charShape: 0, paraShape: 0 });
  assert.deepEqual(info.authors, ["홍길동"]);
  assert.deepEqual(Object.keys(info.sections), ["Section0"]);
});

test("detectTrackChanges: the FLAG BIT ALONE never sets hasTrackChanges", () => {
  // This is the observed real-world case that shaped the whole design: a
  // document with FileHeader bit 14 set and zero actual changes. Reporting it as
  // tracked would block every edit to it, and a guard that cries wolf gets
  // deleted by the next person in a hurry.
  const info = detectTrackChanges(FLAG_ONLY);
  assert.equal(info.flagBit, true, "the fixture must actually have bit 14 set");
  assert.equal(info.corroborated, false, "nothing in DocInfo or BodyText backs it up");
  assert.equal(info.hasTrackChanges, false, "bit 14 alone MUST NOT be a verdict");
  assert.equal(totalChanges(info.counts), 0);
});

test("detectTrackChanges: corroboration WITHOUT the flag bit is also not a verdict", () => {
  // The other half of the AND. Asserted so nobody "simplifies" the rule to
  // whichever single signal they happened to be looking at.
  const path = writeSynthDoc(join(TMP, "ranges-no-flag.hwp"), {
    flagBit: false,
    authors: ["김철수"],
    changeRecords: 2,
    paragraphs: [{ text: "본문", ranges: [{ start: 0, end: 2, kind: RANGE_KIND.DELETE, id: 1 }] }],
  });
  const info = detectTrackChanges(path);
  assert.equal(info.flagBit, false);
  assert.equal(info.corroborated, true, "authors + change records + a range tag are all present");
  assert.equal(info.hasTrackChanges, false, "without bit 14 the verdict must stay false");
});

test("detectTrackChanges: hasTrackChanges is a real boolean, always", () => {
  // The memo guard's worst regression was hasMemos quietly becoming undefined,
  // which disarms every write script in silence. Same contract here.
  for (const p of [TRACKED, FLAG_ONLY, CONFIG_ONLY, sample("fixture-table.hwp")]) {
    const info = detectTrackChanges(p);
    assert.equal(typeof info.hasTrackChanges, "boolean", `${p}: hasTrackChanges must be boolean`);
    assert.equal(typeof info.supported, "boolean", `${p}: supported must be boolean`);
    assert.equal(
      info.hasTrackChanges,
      info.supported && info.flagBit && info.corroborated,
      `${p}: the verdict must be exactly flagBit AND corroborated`,
    );
  }
});

test("detectTrackChanges: exact key set — every one of these is read by the guard", () => {
  assert.deepEqual(Object.keys(detectTrackChanges(TRACKED)).sort(), [
    "authors",
    "corroborated",
    "counts",
    "flagBit",
    "format",
    "hasTrackChanges",
    "sections",
    "supported",
  ]);
});

// ── 4. THE SELECTIVITY INEQUALITY, on the real committed samples ────────────

test("HWPTAG_TRACK_CHANGE_CONFIG (tag 32) is present in real samples and proves NOTHING", () => {
  // Tag 32 is a CONFIG record, not an edit. Every blank document this engine
  // produces carries exactly one; the older fixtures carry zero. Counting it
  // would report tracked changes on 100% of engine-authored documents.
  //
  // The assertion is deliberately two-sided: at least one committed sample must
  // actually contain tag-32 records (otherwise this test is vacuous and would
  // keep passing after someone "fixed" the detector by counting them), and
  // every sample that contains them must still be reported as clean.
  const files = [
    "fixture-clause.hwp",
    "fixture-headings.hwp",
    "fixture-inline.hwp",
    "fixture-table-only.hwp",
    "fixture-table.hwp",
    "fixture-form.hwp",
  ].filter((f) => existsSync(sample(f)));

  let withConfig = 0;
  for (const f of files) {
    const n = countTrackChangeConfigRecords(sample(f));
    if (n > 0) withConfig++;
    const info = detectTrackChanges(sample(f));
    assert.equal(
      info.hasTrackChanges,
      false,
      `${f}: has ${n} tag-32 config record(s) and must STILL report no tracked changes`,
    );
  }
  assert.ok(
    withConfig > 0,
    "no committed sample contains a tag-32 record — this test has gone vacuous; " +
      "the false positive it guards against can no longer be observed",
  );

  // And the synthetic document built with THREE config records and nothing else.
  assert.equal(countTrackChangeConfigRecords(CONFIG_ONLY), 3);
  assert.equal(detectTrackChanges(CONFIG_ONLY).hasTrackChanges, false);
  assert.equal(detectTrackChanges(CONFIG_ONLY).corroborated, false);
});

test("clean samples: scanned (supported), no flag bit, no changes, no entries", () => {
  for (const f of ["fixture-table.hwp", "fixture-form.hwp"]) {
    const info = detectTrackChanges(sample(f));
    assert.equal(info.supported, true, `${f}: an .hwp must be scannable`);
    assert.equal(info.format, "hwp");
    assert.equal(info.flagBit, false, `${f}: no tracked-change flag`);
    assert.equal(info.hasTrackChanges, false);
    assert.equal(totalChanges(info.counts), 0);
    assert.deepEqual(info.sections, {});
    assert.deepEqual(readTrackChanges(sample(f)), [], `${f}: readTrackChanges must return []`);
  }
});

// ── 5. readTrackChanges ─────────────────────────────────────────────────────

test("readTrackChanges: entry shape is {index,kind,author,id,text,location}", () => {
  const changes = readTrackChanges(TRACKED);
  assert.equal(changes.length, 2);
  assert.deepEqual(Object.keys(changes[0]).sort(), [
    "author",
    "id",
    "index",
    "kind",
    "location",
    "text",
  ]);
  assert.deepEqual(
    changes.map((c) => [c.index, c.kind, c.id, c.text]),
    [
      [0, "insert", 1, "가나다"],
      [1, "delete", 2, "라마바사"],
    ],
  );
  // Single-author documents attribute every change to that author — an
  // inference that cannot be wrong. See the note in trackchange.mjs on why we
  // refuse to guess when there is more than one.
  assert.equal(changes[0].author, "홍길동");
});

test("readTrackChanges: with several authors, attribution is left EMPTY, not guessed", () => {
  const path = writeSynthDoc(join(TMP, "multi-author.hwp"), {
    authors: ["홍길동", "김철수"],
    changeRecords: 2,
    paragraphs: [{ text: "본문내용", ranges: [{ start: 0, end: 2, kind: RANGE_KIND.INSERT, id: 1 }] }],
  });
  assert.deepEqual(detectTrackChanges(path).authors, ["홍길동", "김철수"]);
  assert.equal(
    readTrackChanges(path)[0].author,
    "",
    "a confidently wrong name on someone's edit is worse than no name",
  );
});

// ── 6. HWPX: unsupported, and honest about it ───────────────────────────────

test("HWPX: detectTrackChanges reports supported:false — 'not checked', not 'clean'", () => {
  // There is no real tracked-changes .hwpx available to verify a scanner
  // against, so this path is UNVERIFIED and says so rather than guessing.
  // hasTrackChanges is false here ONLY because we did not look; a caller that
  // reads it without checking `supported` is reading a lie.
  for (const f of ["fixture-table.hwpx", "fixture-memo.hwpx"]) {
    const info = detectTrackChanges(sample(f));
    assert.equal(info.format, "hwpx");
    assert.equal(info.supported, false, `${f}: HWPX must report supported:false`);
    assert.equal(info.hasTrackChanges, false);
    assert.deepEqual(readTrackChanges(sample(f)), []);
  }
});

test("HWPX: assertTrackChangeSafe warns but does NOT block", () => {
  // Blocking on a container we cannot scan would break every legitimate HWPX
  // edit; staying silent would imply we checked. So: warn, proceed.
  const stderr = captureStderr(() => {
    const info = assertTrackChangeSafe(sample("fixture-table.hwpx"), []);
    assert.equal(info.supported, false);
  });
  assert.match(stderr, /cannot scan/i, "the unsupported path must say it could not scan");
  assert.match(stderr, /hwpx/, "the warning must name the format it could not scan");
});

test("assertTrackChangeSafe: a scan error never blocks and never warns", () => {
  // A missing/corrupt file is the load path's problem — and loadDocument is
  // about to print the real error. A warning here would only bury it.
  const stderr = captureStderr(() => {
    const info = assertTrackChangeSafe(join(TMP, "does-not-exist.hwp"), []);
    assert.equal(info.supported, false);
    assert.equal(info.hasTrackChanges, false);
  });
  assert.equal(stderr, "", "a scan error must be silent");
});

test("assertTrackChangeSafe: clean input is a no-op, tracked input throws the exit", () => {
  // Direct (non-spawned) coverage of the two branches. The refusing branch
  // calls process.exit, so it is exercised by the spawned tests below; here we
  // only pin that a clean document sails straight through without output.
  const stderr = captureStderr(() => {
    const info = assertTrackChangeSafe(sample("fixture-table.hwp"), []);
    assert.equal(info.supported, true);
    assert.equal(info.hasTrackChanges, false);
  });
  assert.equal(stderr, "", "a clean document must produce no output at all");
});

// ── 7. the write guard, end to end ──────────────────────────────────────────

// Every write script, with the minimum valid argv that reaches its guard. The
// engine cannot load a synthesized container, but the guard runs first — which
// is exactly the property under test, so exit 6 here is a real proof of wiring.
const WRITE_SCRIPTS = [
  ["replace.mjs", (t, o) => [t, "--query", "x", "--replacement", "y", "--output", o]],
  ["edit_text.mjs", (t, o) => [t, "--op", "insert", "--section", "0", "--paragraph", "0", "--text", "z", "--output", o]],
  ["edit_cell.mjs", (t, o) => [t, "--op", "set", "--section", "0", "--paragraph", "0", "--control", "0", "--cell", "0", "--text", "z", "--output", o]],
  ["table.mjs", (t, o) => [t, "--op", "create", "--section", "0", "--paragraph", "0", "--rows", "2", "--cols", "2", "--output", o]],
  ["format.mjs", (t, o) => [t, "--op", "char", "--section", "0", "--paragraph", "0", "--start", "0", "--end", "1", "--props", '{"bold":true}', "--output", o]],
  ["header_footer.mjs", (t, o) => [t, "--op", "create", "--section", "0", "--header", "--apply-to", "0", "--text", "h", "--output", o]],
  ["footnote.mjs", (t, o) => [t, "--op", "insert", "--section", "0", "--paragraph", "0", "--text", "f", "--output", o]],
  ["unlock.mjs", (t, o) => [t, "--output", o]],
];

for (const [script, argv] of WRITE_SCRIPTS) {
  test(`GUARD: ${script} refuses a tracked-changes input with UNSAFE(6)`, () => {
    const r = run(script, argv(TRACKED, join(TMP, `guard-${script}.hwp`)));
    assert.equal(r.status, EXIT.UNSAFE, `expected UNSAFE(6), got ${r.status}\n${r.stderr}`);
    assert.match(r.stderr, /변경 내용 추적|tracked changes/i, "the refusal must name what it protects");
    assert.match(r.stderr, /--allow-trackchange-loss/, "the refusal must name its override flag");
    assert.match(r.stderr, /--track-changes/, "the refusal must say how to inspect the changes first");
  });

  test(`GUARD: ${script} --allow-trackchange-loss disarms the guard (exit is NOT 6)`, () => {
    const r = run(script, [...argv(TRACKED, join(TMP, `override-${script}.hwp`)), "--allow-trackchange-loss"]);
    // With the override the guard is a no-op. The synthesized container is not
    // loadable by the engine, so the run then fails LOAD(1) — which is fine and
    // is the point: whatever happens next, it is no longer the guard's refusal.
    assert.notEqual(r.status, EXIT.UNSAFE, `override must not exit 6\n${r.stderr}`);
    assert.doesNotMatch(r.stderr, /--allow-trackchange-loss/, "the guard must be silent once overridden");
  });

  test(`GUARD: ${script} never blocks a clean document`, () => {
    const r = run(script, argv(sample("fixture-table.hwp"), join(TMP, `clean-${script}.hwp`)));
    assert.notEqual(r.status, EXIT.UNSAFE, `clean input must never trip the guard\n${r.stderr}`);
    assert.doesNotMatch(r.stderr, /변경 내용 추적/, "a clean document must not mention tracked changes");
  });
}

test("GUARD: every write script that guards memos also guards tracked changes", () => {
  // fill_form.mjs loads the document BEFORE its guard (it has to — `--list` is a
  // read-only mode on the loaded doc), so a synthesized container can never
  // reach its guard and the spawned loop above cannot cover it. This source-level
  // invariant covers it, and covers the next write script somebody adds: the two
  // guards are a pair, and adding one without the other is the regression.
  const dir = join(ROOT, "src", "core");
  const missing = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".mjs"))) {
    const src = readFileSync(join(dir, f), "utf8");
    if (/^assertMemoSafe\(/m.test(src) && !/^assertTrackChangeSafe\(/m.test(src)) missing.push(f);
  }
  assert.deepEqual(missing, [], `these write scripts guard memos but not tracked changes: ${missing}`);
});

// ── 8. read.mjs ─────────────────────────────────────────────────────────────

test("read --track-changes: lists each change with kind, id, author and text", () => {
  const r = run("read.mjs", [TRACKED, "--track-changes", "--format", "text"]);
  assert.equal(r.status, EXIT.OK, `--track-changes must exit 0: ${r.stderr}`);
  assert.match(r.stdout, /insert #1 by 홍길동/);
  assert.match(r.stdout, /delete #2 by 홍길동/);
  assert.ok(r.stdout.includes("라마바사"), `the deleted text must be shown: ${r.stdout}`);
});

test("read --track-changes: JSON carries the verdict, not just a list", () => {
  const r = run("read.mjs", [TRACKED, "--track-changes"]);
  assert.equal(r.status, EXIT.OK, r.stderr);
  const out = JSON.parse(r.stdout);
  // `supported`/`flagBit`/`corroborated` are what let a caller tell "none found"
  // from "could not look". A bare array of changes could not express that.
  assert.equal(out.supported, true);
  assert.equal(out.flagBit, true);
  assert.equal(out.corroborated, true);
  assert.equal(out.hasTrackChanges, true);
  assert.equal(out.changes.length, 2);
  assert.equal(out.changes[1].text, "라마바사");
});

test("read --track-changes: a clean document says none, and exits 0", () => {
  const r = run("read.mjs", [sample("fixture-table.hwp"), "--track-changes", "--format", "text"]);
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.match(r.stdout, /no tracked changes/);
  const j = JSON.parse(run("read.mjs", [sample("fixture-table.hwp"), "--track-changes"]).stdout);
  assert.deepEqual(j.changes, []);
  assert.equal(j.supported, true, "a clean .hwp really WAS checked");
});

test("read --track-changes: HWPX says NOT CHECKED rather than claiming none", () => {
  const r = run("read.mjs", [sample("fixture-table.hwpx"), "--track-changes", "--format", "text"]);
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.match(r.stderr, /cannot scan/i);
  assert.match(r.stdout, /NOT CHECKED/);
  assert.doesNotMatch(r.stdout, /no tracked changes/, "must never claim none for an unscanned container");
});

test("read --track-changes: rejects an unknown --format with USAGE(2)", () => {
  const r = run("read.mjs", [TRACKED, "--track-changes", "--format", "xml"]);
  assert.equal(r.status, EXIT.USAGE);
  assert.match(r.stderr, /expected json\|text/);
});

test("read (plain): warns that the body text MIXES insertions and deletions", () => {
  const r = run("read.mjs", [TRACKED]);
  assert.match(r.stderr, /TRACKED CHANGES/, "a plain read of a tracked document must warn");
  assert.match(r.stderr, /1 insertion\(s\), 1 deletion\(s\)/);
  assert.match(r.stderr, /--track-changes/, "the warning must point at how to separate them");
});

test("read (plain): a clean document emits NO tracked-change output at all", () => {
  // test/golden pins read.mjs's stdout AND stderr byte-for-byte on 40 cases.
  // Any unconditional line here — a "no tracked changes" note, a debug print —
  // breaks all of them. This is that contract, stated locally.
  for (const f of ["fixture-table.hwp", "fixture-form.hwp", "fixture-table.hwpx"]) {
    const r = run("read.mjs", [sample(f)]);
    assert.doesNotMatch(r.stderr, /TRACKED CHANGES/, `${f}: no tracked-change warning`);
    assert.doesNotMatch(r.stderr, /변경 내용 추적/, `${f}: no tracked-change warning`);
    assert.doesNotMatch(r.stdout, /변경 내용 추적/, `${f}: nothing on stdout either`);
  }
});

// ── 9. opt-in end-to-end against a REAL tracked document ────────────────────

test("HWP_TRACKED_FIXTURE: real-document end-to-end (skipped unless set)", (t) => {
  // Set HWP_TRACKED_FIXTURE=/path/to/real.hwp to run the full path against a
  // document that must never be committed. This is how someone with a real
  // tracked-changes file verifies the whole chain locally.
  const fixture = process.env.HWP_TRACKED_FIXTURE;
  if (!fixture) return t.skip("HWP_TRACKED_FIXTURE not set");
  if (!existsSync(fixture)) return t.skip(`HWP_TRACKED_FIXTURE not found: ${fixture}`);

  const info = detectTrackChanges(fixture);
  assert.equal(info.supported, true, "a real .hwp must be scannable");
  assert.equal(info.hasTrackChanges, true, "the fixture is supposed to HAVE tracked changes");
  assert.equal(info.flagBit, true);
  assert.equal(info.corroborated, true);
  assert.ok(totalChanges(info.counts) > 0, "at least one change must be counted");

  const changes = readTrackChanges(fixture);
  assert.equal(changes.length, totalChanges(info.counts), "detect and read must agree on the count");
  assert.ok(
    changes.some((c) => c.kind === "delete" && c.text.length > 0),
    "a real tracked document should expose at least one deletion WITH its original text",
  );

  // Never print the document's contents — that is the whole reason it is not a
  // committed fixture. Counts only.
  const r = run("read.mjs", [fixture]);
  assert.match(r.stderr, /TRACKED CHANGES/, "a plain read must warn on the real file too");

  const g = run("replace.mjs", [fixture, "--query", "x", "--replacement", "y", "--output", join(TMP, "real-guard.hwp")]);
  assert.equal(g.status, EXIT.UNSAFE, "a real tracked document must be refused by the write guard");
});
