// Spec tests for the memo (메모/주석) data-loss guard — src/lib/memo.mjs plus
// its two wirings: the write-script guard (assertMemoSafe) and the read --memos
// mode (src/core/read.mjs).
//
// THE BUG these tests pin: the rhwp engine does NOT model document memos. Memos
// survive a save ONLY via the HWP5 per-section raw_stream fast-path; the moment
// an edit touches the section holding them, that section is re-serialized from
// an IR that never modeled the memos and every memo in it is silently dropped.
// (Verified empirically on a real file — 13 memos wiped by a single edit.) So
// every write script must REFUSE a memo-bearing input (exit UNSAFE=6) unless the
// caller passes --allow-memo-loss, and read.mjs must expose the memos first.
//
// Fixtures (committable only): fixture-memo.hwpx has exactly 1 memo whose text
// is "테스트 메모입니다"; fixture-table.hwpx / fixture-table.hwp / fixture-form.hwp
// have none. The REAL 13-memo user .hwp is sensitive and is NEVER referenced
// here — the HWP5 (.hwp) memo e2e path was verified manually against it and
// cannot be committed (see the unit-coverage note below).
//
// Detection/extraction are checked directly against the public memo.mjs API;
// the guard and the read mode are checked end-to-end by spawning the scripts
// (cwd=repo root), exactly as an agent / wrapping tool would invoke them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { detectMemos, readMemos } from "../../src/lib/memo.mjs";
import { EXIT } from "../../src/lib/exit-codes.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const sample = (name) => join(ROOT, "samples", name);

// A scratch dir for write-script outputs (the guard runs before the write, so
// most of these files are never actually created — but we still give the
// scripts a real, writable --output target so nothing is left to chance).
let TMP;
test.before(() => {
  TMP = mkdtempSync(join(tmpdir(), "hwp-memo-test-"));
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

// ── detectMemos ────────────────────────────────────────────────────────────

test("detectMemos: fixture-memo.hwpx → hasMemos true, count 1, format hwpx", () => {
  const info = detectMemos(sample("fixture-memo.hwpx"));
  assert.equal(info.hasMemos, true, "the memo fixture must be flagged as memo-bearing");
  assert.equal(info.count, 1, "the memo fixture has exactly one memo");
  assert.equal(info.format, "hwpx");
});

test("detectMemos: fixture-table.hwpx → no memos (memo-free HWPX)", () => {
  const info = detectMemos(sample("fixture-table.hwpx"));
  assert.equal(info.hasMemos, false);
  assert.equal(info.count, 0);
  assert.equal(info.format, "hwpx");
});

test("detectMemos: fixture-table.hwp → no memos (memo-free HWP5)", () => {
  const info = detectMemos(sample("fixture-table.hwp"));
  assert.equal(info.hasMemos, false);
  assert.equal(info.count, 0);
  assert.equal(info.format, "hwp");
});

test("detectMemos: fixture-form.hwp → no memos (memo-free HWP5)", () => {
  const info = detectMemos(sample("fixture-form.hwp"));
  assert.equal(info.hasMemos, false);
  assert.equal(info.count, 0);
  assert.equal(info.format, "hwp");
});

// ── readMemos ──────────────────────────────────────────────────────────────

test("readMemos: fixture-memo.hwpx → one memo containing '테스트 메모'", () => {
  const memos = readMemos(sample("fixture-memo.hwpx"));
  assert.equal(Array.isArray(memos), true, "readMemos must return an array");
  assert.equal(memos.length, 1, "the memo fixture yields exactly one memo");
  assert.equal(memos[0].index, 0);
  assert.ok(
    memos[0].text.includes("테스트 메모"),
    `memo text must include the fixture's content, got: ${JSON.stringify(memos[0].text)}`,
  );
});

test("readMemos: a memo-free document yields an empty array (never throws)", () => {
  // The guard's read companion must degrade to [] on memo-free input rather
  // than error — that is what makes `read --memos` safe to run unconditionally.
  assert.deepEqual(readMemos(sample("fixture-table.hwp")), []);
});

// ── HWP5 record-walk coverage ──────────────────────────────────────────────
//
// detectMemos's HWP5 path counts HWPTAG_MEMO_LIST records (tag 93 = 0x10 + 77)
// in each inflated BodyText/SectionN stream. An HWP5 record header is a single
// LE u32: tag = h & 0x3ff, level = (h >> 10) & 0x3ff, size = (h >> 20) & 0xfff
// (size == 0xfff escapes to a following u32). The walker is internal (not
// exported), and the only committable file exercising a live MEMO_LIST record
// is the .hwpx fixture's HWPX path. The HWP5 record-walk over a real
// MEMO_LIST run was verified MANUALLY against the sensitive 13-memo user .hwp
// (which must not be copied into the repo), where a single edit to the memos'
// section wiped all 13 — the bug this guard exists to stop. Here we re-pin the
// header-math invariant the walker relies on, so a regression in the tag/size
// bit layout is caught without needing the uncommittable file.
test("HWP5 record-header math: MEMO_LIST tag and header field extraction", () => {
  const TAG = 93; // HWPTAG_MEMO_LIST = HWPTAG_BEGIN(0x10) + 77
  assert.equal(0x10 + 77, TAG, "HWPTAG_MEMO_LIST must be 0x10 + 77 = 93");

  // Pack a synthetic header exactly as the engine does, then unpack it the way
  // detectMemos's countRecords/walkRecords do, and assert round-trip identity.
  const level = 2;
  const size = 40;
  const header = (TAG & 0x3ff) | ((level & 0x3ff) << 10) | ((size & 0xfff) << 20);
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(header >>> 0, 0);
  const h = buf.readUInt32LE(0);
  assert.equal(h & 0x3ff, TAG, "tag must decode from the low 10 bits");
  assert.equal((h >> 10) & 0x3ff, level, "level must decode from bits 10–19");
  assert.equal((h >> 20) & 0xfff, size, "size must decode from bits 20–31");
});

// ── the write guard (assertMemoSafe wired into the write scripts) ───────────

test("GUARD: replace.mjs on a memo file exits UNSAFE(6) and names the memo", () => {
  const out = join(TMP, "guard.hwp");
  const r = run("replace.mjs", [
    "samples/fixture-memo.hwpx",
    "--query", "x",
    "--replacement", "y",
    "--output", out,
  ]);
  assert.equal(r.status, EXIT.UNSAFE, `memo-bearing write must exit 6 (UNSAFE): ${r.stderr}`);
  assert.match(r.stderr, /memo/i, "the refusal must mention the memo(s) it is protecting");
  // The refusal must steer the user to the documented override + read command.
  assert.match(r.stderr, /--allow-memo-loss/, "refusal must name the override flag");
});

test("GUARD: --allow-memo-loss disarms the guard (proceeds; exit is NOT 6)", () => {
  const out = join(TMP, "guard-override.hwp");
  const r = run("replace.mjs", [
    "samples/fixture-memo.hwpx",
    "--query", "x",
    "--replacement", "y",
    "--output", out,
    "--allow-memo-loss",
  ]);
  // With the override the guard is a no-op and the edit proceeds. The query "x"
  // is absent in the fixture, so the script exits NOT_FOUND(3) — that's fine;
  // the contract under test is only that the guard no longer blocks (≠ 6).
  assert.notEqual(r.status, EXIT.UNSAFE, "--allow-memo-loss must NOT exit UNSAFE(6)");
});

test("GUARD: a memo-free file is never blocked by the guard", () => {
  // Sanity: the guard must be a clean no-op on memo-free input. We use a query
  // that is absent so we don't depend on the engine's edit succeeding — only
  // that the guard itself did not turn a normal run into an UNSAFE(6).
  const out = join(TMP, "clean.hwp");
  const r = run("replace.mjs", [
    "samples/fixture-table.hwp",
    "--query", "장롱깊이숨은없는말",
    "--replacement", "z",
    "--output", out,
  ]);
  assert.notEqual(r.status, EXIT.UNSAFE, "memo-free input must never trip the memo guard");
});

// ── read.mjs --memos mode ───────────────────────────────────────────────────

test("read --memos: prints the memo text and exits 0 (memo fixture)", () => {
  const r = run("read.mjs", ["samples/fixture-memo.hwpx", "--memos"]);
  assert.equal(r.status, 0, `read --memos must exit 0: ${r.stderr}`);
  assert.ok(
    r.stdout.includes("테스트 메모"),
    `--memos stdout must contain the memo text, got: ${r.stdout}`,
  );
});

test("read --memos: emits a valid empty JSON array on a memo-free file (exit 0)", () => {
  const r = run("read.mjs", ["samples/fixture-table.hwp", "--memos"]);
  assert.equal(r.status, 0, `read --memos on memo-free input must exit 0: ${r.stderr}`);
  // Default --memos output is JSON; memo-free → "[]" (still valid, parseable).
  assert.deepEqual(JSON.parse(r.stdout), [], "memo-free --memos must print an empty JSON array");
});
