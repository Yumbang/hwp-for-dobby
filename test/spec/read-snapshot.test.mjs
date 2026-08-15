// Default read.mjs snapshots the inferred section tree and diffs against the
// last read. The body stays on stdout; the report is stderr-only and must
// never fail the read.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT } from "../../src/lib/exit-codes.mjs";
import { NO_CHANGES_LINE } from "../../src/lib/snapshot.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const HEADINGS = join(ROOT, "samples", "fixture-headings.hwp");
const TABLE = join(ROOT, "samples", "fixture-table.hwp");

function run(args, cwd = ROOT) {
  return spawnSync(process.execPath, ["src/core/read.mjs", ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), "hwp-read-snap-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("--no-snapshot: stdout is the body and stderr has no snapshot: line", () => {
  const r = run([TABLE, "--no-snapshot"]);
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.doesNotMatch(r.stderr, /^snapshot:/m);
  assert.match(r.stdout, /\[table: use extract_tables\.mjs for data\]/);
});

test("first text read records a baseline and does not fail the read", async () => {
  await withTmp((dir) => {
    const doc = join(dir, "doc.hwp");
    copyFileSync(HEADINGS, doc);
    const r = run([doc, "--snapshot-dir", join(dir, "snaps")]);
    assert.equal(r.status, EXIT.OK, r.stderr);
    assert.match(r.stderr, /snapshot: first read — recorded \d+ section\(s\)/);
    assert.doesNotMatch(r.stdout, /snapshot:/, "snapshot report must not leak onto stdout");
    const meta = join(dir, "snaps", "doc", "meta.json");
    JSON.parse(readFileSync(meta, "utf8"));
  });
});

test("second read of an unchanged document reports 변경 없음 and keeps the body", async () => {
  await withTmp((dir) => {
    const doc = join(dir, "doc.hwp");
    copyFileSync(HEADINGS, doc);
    const snaps = join(dir, "snaps");
    const first = run([doc, "--snapshot-dir", snaps]);
    assert.equal(first.status, EXIT.OK, first.stderr);
    const second = run([doc, "--snapshot-dir", snaps]);
    assert.equal(second.status, EXIT.OK, second.stderr);
    assert.match(second.stderr, new RegExp(`snapshot: ${NO_CHANGES_LINE}`));
    assert.equal(second.stdout, first.stdout, "body text must be identical across reads");
  });
});

test("a later read after an edit reports the changed section, then re-baselines", async () => {
  await withTmp((dir) => {
    const doc = join(dir, "doc.hwp");
    copyFileSync(HEADINGS, doc);
    const snaps = join(dir, "snaps");
    assert.equal(run([doc, "--snapshot-dir", snaps]).status, EXIT.OK);

    const replaced = spawnSync(
      process.execPath,
      [
        "src/core/replace.mjs",
        doc,
        "--query",
        "12%",
        "--replacement",
        "18%",
        "--output",
        doc,
      ],
      { cwd: ROOT, encoding: "utf8" },
    );
    assert.equal(replaced.status, EXIT.OK, replaced.stderr);

    const after = run([doc, "--snapshot-dir", snaps]);
    assert.equal(after.status, EXIT.OK, after.stderr);
    assert.match(after.stderr, /snapshot: since last read/);
    assert.match(after.stderr, /^M /m);
    assert.match(after.stderr, /18%/);
    assert.match(after.stderr, /snapshot: baseline updated/);

    const third = run([doc, "--snapshot-dir", snaps]);
    assert.equal(third.status, EXIT.OK, third.stderr);
    assert.match(third.stderr, new RegExp(`snapshot: ${NO_CHANGES_LINE}`));
    assert.doesNotMatch(third.stderr, /snapshot: since last read/);
  });
});

test("--memos and --format svg do not write a snapshot", async () => {
  await withTmp((dir) => {
    const doc = join(dir, "doc.hwp");
    copyFileSync(HEADINGS, doc);
    const snaps = join(dir, "snaps");
    const memos = run([doc, "--memos", "--snapshot-dir", snaps]);
    assert.equal(memos.status, EXIT.OK, memos.stderr);
    assert.doesNotMatch(memos.stderr, /^snapshot:/m);
    const svg = run([doc, "--format", "svg", "--page", "0", "--snapshot-dir", snaps]);
    assert.equal(svg.status, EXIT.OK, svg.stderr);
    assert.doesNotMatch(svg.stderr, /^snapshot:/m);
  });
});
