// Freeze the lib/memo.mjs return SHAPE before hwp5.mjs is split out of it.
//
// memo.mjs currently owns the CFB reader, the record walker and the PARA_TEXT
// decoder. That plumbing is about to move to lib/hwp5.mjs so trackchange.mjs can
// share it — a pure code move, but the thing sitting on top of it is the exit-6
// data-loss guard (CLAUDE.md rule 4). The worst possible regression here is not
// a wrong count; it is `hasMemos` quietly becoming `undefined` and
// `assertMemoSafe` therefore letting every edit through in silence.
//
// So this asserts the CONTRACT, not the internals: which keys exist, their
// types, and the boolean/count invariant the guard branches on.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { detectMemos, readMemos } from "../../src/lib/memo.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const p = (f) => join(ROOT, "samples", f);

const WITH_MEMOS = "fixture-memo.hwpx";
const WITHOUT_MEMOS = ["fixture-table.hwp", "fixture-table.hwpx", "fixture-form.hwp"];

test("detectMemos: exact key set and types on a memo-bearing document", () => {
  const info = detectMemos(p(WITH_MEMOS));
  assert.deepEqual(
    Object.keys(info).sort(),
    ["count", "format", "hasMemos", "sections"],
    "detectMemos key set changed — assertMemoSafe reads every one of these",
  );
  assert.equal(typeof info.format, "string");
  assert.equal(typeof info.hasMemos, "boolean", "hasMemos MUST stay a real boolean");
  assert.equal(typeof info.count, "number");
  assert.equal(typeof info.sections, "object");
  assert.equal(info.format, "hwpx");
  assert.equal(info.hasMemos, true);
  assert.equal(info.count, 1);
});

test("detectMemos: hasMemos === (count > 0) on every fixture", () => {
  for (const f of [WITH_MEMOS, ...WITHOUT_MEMOS]) {
    const info = detectMemos(p(f));
    assert.equal(
      info.hasMemos,
      info.count > 0,
      `${f}: hasMemos and count disagree — the guard would misfire`,
    );
  }
});

test("detectMemos: memo-free fixtures report zero, not 'unknown'", () => {
  for (const f of WITHOUT_MEMOS) {
    const info = detectMemos(p(f));
    assert.equal(info.hasMemos, false, `${f} must not report memos`);
    assert.equal(info.count, 0);
    assert.notEqual(
      info.format,
      "unknown",
      `${f}: format 'unknown' means the container could not be scanned at all`,
    );
  }
});

test("readMemos: entry shape is {index,id,location,text,anchor}", () => {
  const memos = readMemos(p(WITH_MEMOS));
  assert.equal(memos.length, 1);
  assert.deepEqual(Object.keys(memos[0]).sort(), ["anchor", "id", "index", "location", "text"]);
  assert.equal(memos[0].index, 0);
  assert.equal(typeof memos[0].text, "string");
  assert.ok(memos[0].text.includes("테스트 메모"), `unexpected memo text: ${memos[0].text}`);
  assert.equal(typeof memos[0].anchor, "string", "anchor is always a string, '' when unrecovered");
});

test("readMemos: memo-free documents return [] (never null/undefined)", () => {
  for (const f of WITHOUT_MEMOS) {
    assert.deepEqual(readMemos(p(f)), [], `${f} must return an empty array`);
  }
});

// The end of the chain: the guard itself. A write script must still refuse a
// memo-bearing input with exit 6 and still be overridable — both directions
// matter, because a guard that cannot be overridden gets deleted by the next
// person in a hurry.
test("assertMemoSafe: replace.mjs still exits 6 on a memo-bearing input", () => {
  const r = spawnSync(
    process.execPath,
    [
      "src/core/replace.mjs",
      "samples/fixture-memo.hwpx",
      "--query",
      "x",
      "--replacement",
      "y",
      "--output",
      join(ROOT, "test", "golden", ".tmp-memo-guard.hwp"),
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(r.status, 6, `expected UNSAFE(6), got ${r.status}\n${r.stderr}`);
  assert.match(r.stderr, /--allow-memo-loss/, "the refusal must name its override flag");
  assert.match(r.stderr, /--memos/, "the refusal must point at how to read the memos first");
});
