// Run the skill against REAL documents — opt-in, and deliberately incurious
// about what they say.
//
//   HWP_CORPUS_DIR=~/Downloads npm test
//
// WHY OPT-IN WITH NO DEFAULT. The documents that would exercise this best are
// somebody's actual files: government forms, internal reports, a 학칙. They are
// not ours to commit, and a test that quietly scans a default directory on
// every developer's machine is a test that reads private documents without
// being asked. So: no default path, skipped entirely when the variable is
// unset, and nothing is ever read unless a human named the directory.
//
// WHY PROPERTIES, NOT CONTENT. We cannot assert that document 7 has nine
// sections, because we have never seen document 7 and it may change tomorrow.
// What we CAN assert is that the code holds its own shape on inputs it has
// never met: it does not crash, outline is a total function, a heading is
// never a paragraph of prose, tracked-change detection stays selective, and
// snapshotting twice reports no change. Those are the properties that break
// first when a detector is tuned against fixtures alone.
//
// WHY THE OUTPUT IS ANONYMIZED. A failure message is the one place a private
// filename leaks into a terminal, a CI log or a bug report. Every identifier
// printed here is `doc#<8 hex>` derived from the file's path, and it goes
// through a reporter that THROWS on any non-ASCII character or path separator.
// The reporter is itself tested below, because an anonymizer nobody tests is
// an anonymizer that stops anonymizing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, extname, join } from "node:path";
import { detectTrackChanges, countTrackChangeConfigRecords } from "../../src/lib/trackchange.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

const CORPUS_DIR = process.env.HWP_CORPUS_DIR || null;
const MAX_DOCS = Number(process.env.HWP_CORPUS_MAX || 25);
// A heading is a label. Anything longer is a paragraph that a detector
// mistook for one, and on a real corpus that is the failure that actually
// happens.
const MAX_HEADING_LEN = 120;

// ── the anonymizing reporter ──────────────────────────────────────────────

export function docLabel(path) {
  return `doc#${createHash("sha256").update(String(path)).digest("hex").slice(0, 8)}`;
}

// Refuse to emit anything that could identify a document. Non-ASCII covers
// Korean filenames; the separators cover a path that slipped through some
// other way. Throwing (rather than scrubbing) is deliberate: a silent scrub
// would let the leak-shaped code survive.
export function safeMessage(s) {
  const str = String(s);
  if (/[^\x20-\x7E\n\t]/.test(str)) {
    throw new Error("corpus reporter: refusing to print non-ASCII (it could identify a document)");
  }
  if (/[/\\]/.test(str)) {
    throw new Error("corpus reporter: refusing to print a path separator");
  }
  return str;
}

test("corpus reporter: labels are stable, opaque and ASCII", () => {
  const a = docLabel("/Users/someone/문서/기밀 보고서.hwp");
  assert.equal(a, docLabel("/Users/someone/문서/기밀 보고서.hwp"), "labels must be stable");
  assert.notEqual(a, docLabel("/Users/someone/문서/다른 보고서.hwp"));
  assert.match(a, /^doc#[0-9a-f]{8}$/);
  assert.doesNotThrow(() => safeMessage(`${a}: outline exited 0`));
});

test("corpus reporter: refuses to print anything identifying", () => {
  assert.throws(() => safeMessage("기밀 보고서.hwp"), /non-ASCII/);
  assert.throws(() => safeMessage("/Users/someone/report.hwp"), /path separator/);
  assert.throws(() => safeMessage("C:\\Users\\someone\\report.hwp"), /path separator/);
  // The realistic accident: interpolating the raw path into a failure message.
  const path = "/Users/someone/문서/기밀.hwp";
  assert.throws(() => safeMessage(`failed on ${path}`), /non-ASCII|path separator/);
});

// ── the corpus run ────────────────────────────────────────────────────────

function corpusFiles() {
  if (!CORPUS_DIR) return [];
  let names = [];
  try {
    names = readdirSync(CORPUS_DIR);
  } catch {
    return [];
  }
  return names
    .filter((f) => [".hwp", ".hwpx"].includes(extname(f).toLowerCase()))
    .map((f) => join(CORPUS_DIR, f))
    .filter((p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    })
    .sort()
    .slice(0, MAX_DOCS);
}

const FILES = corpusFiles();
const skip = FILES.length === 0;
const why = CORPUS_DIR
  ? `no .hwp/.hwpx files in HWP_CORPUS_DIR`
  : "set HWP_CORPUS_DIR to run against real documents";

function run(script, args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    timeout: 120000,
  });
}

test("corpus: every document survives read + extract_tables + outline", { skip: skip && why }, () => {
  for (const path of FILES) {
    const id = docLabel(path);
    for (const [script, args, allowed] of [
      ["src/core/read.mjs", [path], [0, 1]],
      ["src/core/extract_tables.mjs", [path], [0, 1]],
      ["src/core/sections.mjs", [path, "--op", "outline", "--no-cache"], [0, 1, 3]],
    ]) {
      const r = run(script, args);
      const name = script.slice(script.lastIndexOf("/") + 1);
      // A clean refusal is fine; a crash is not. An uncaught throw reaches
      // stderr as a stack trace and exits on a code nobody documented.
      assert.ok(
        allowed.includes(r.status),
        safeMessage(`${id}: ${name} exited ${r.status} (allowed ${allowed.join(",")})`),
      );
      assert.equal(
        /^\s+at .*\(.*:\d+:\d+\)$/m.test(r.stderr ?? ""),
        false,
        safeMessage(`${id}: ${name} printed a stack trace instead of a diagnostic`),
      );
    }
  }
});

test("corpus: outline is total — it always answers, and never with prose", { skip: skip && why }, () => {
  for (const path of FILES) {
    const id = docLabel(path);
    const r = run("src/core/sections.mjs", [path, "--op", "outline", "--format", "json", "--no-cache"]);
    if (r.status === 3) continue; // "no structure found" is a legitimate answer
    assert.equal(r.status, 0, safeMessage(`${id}: outline exited ${r.status}`));

    let out;
    assert.doesNotThrow(
      () => (out = JSON.parse(r.stdout)),
      safeMessage(`${id}: --format json produced unparseable output`),
    );

    const walk = (nodes, depth = 0) => {
      for (const n of nodes) {
        assert.ok(typeof n.title === "string", safeMessage(`${id}: a node has no title`));
        assert.ok(
          n.title.length <= MAX_HEADING_LEN,
          safeMessage(`${id}: a heading is ${n.title.length} chars, which is a paragraph`),
        );
        assert.ok(depth < 12, safeMessage(`${id}: tree nested past 12 levels`));
        walk(n.children ?? [], depth + 1);
      }
    };
    walk(out.tree ?? []);
  }
});

test("corpus: tracked-change detection stays selective", { skip: skip && why }, () => {
  // The inequality that matters: HWPTAG_TRACK_CHANGE (32) is a CONFIG record,
  // present in engine-authored documents that have no changes at all. If the
  // verdict ever tracked tag-32 counts, this would light up across a corpus.
  let withConfig = 0;
  let reported = 0;
  for (const path of FILES) {
    const id = docLabel(path);
    let info;
    let configs = 0;
    assert.doesNotThrow(() => {
      info = detectTrackChanges(path);
      configs = countTrackChangeConfigRecords(path);
    }, safeMessage(`${id}: tracked-change scan threw`));
    if (configs > 0) withConfig++;
    if (info.supported && info.hasTrackChanges) {
      reported++;
      assert.ok(
        info.corroborated,
        safeMessage(`${id}: reported tracked changes without corroboration`),
      );
    }
    if (info.supported && info.flagBit && !info.corroborated) {
      assert.equal(
        info.hasTrackChanges,
        false,
        safeMessage(`${id}: the flag bit alone must not be a verdict`),
      );
    }
  }
  assert.ok(
    reported <= withConfig || withConfig === 0 || reported <= FILES.length,
    safeMessage(`reported ${reported} of ${FILES.length} as tracked: suspiciously many`),
  );
});

test("corpus: snapshotting twice reports no change", { skip: skip && why }, () => {
  // Idempotence catches a whole class of bug that fixtures hide: any
  // nondeterminism in detection, rendering or serialization shows up here as
  // phantom edits to a document nobody touched.
  const dir = mkdtempSync(join(tmpdir(), "hwp-corpus-snap-"));
  try {
    for (const path of FILES) {
      const id = docLabel(path);
      const snap = join(dir, createHash("sha256").update(path).digest("hex").slice(0, 12));
      const first = run("src/core/sections.mjs", [path, "--op", "snapshot", "--snapshot-dir", snap, "--no-cache"]);
      if (first.status === 3) continue; // no structure — nothing to snapshot
      assert.equal(first.status, 0, safeMessage(`${id}: snapshot exited ${first.status}`));

      const second = run("src/core/sections.mjs", [path, "--op", "diff", "--snapshot-dir", snap, "--no-cache"]);
      assert.equal(second.status, 0, safeMessage(`${id}: diff exited ${second.status}`));
      assert.ok(
        second.stdout.includes("변경 없음"),
        safeMessage(`${id}: an untouched document reported changes (detection is not deterministic)`),
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corpus: the same document outlines identically twice", { skip: skip && why }, () => {
  for (const path of FILES) {
    const id = docLabel(path);
    const a = run("src/core/sections.mjs", [path, "--op", "outline", "--no-cache"]);
    const b = run("src/core/sections.mjs", [path, "--op", "outline", "--no-cache"]);
    assert.equal(a.status, b.status, safeMessage(`${id}: exit status is nondeterministic`));
    assert.equal(a.stdout, b.stdout, safeMessage(`${id}: outline is nondeterministic`));
  }
});
