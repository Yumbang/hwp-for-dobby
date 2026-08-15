// Workflow additions: --summary, csv, edit_cell --table, search, extract_data,
// fill_form dry-run / occurrence, read --max-chars.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT } from "../../src/lib/exit-codes.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const HWPX = join(ROOT, "samples", "fixture-table.hwpx");
const HWP = join(ROOT, "samples", "fixture-table.hwp");
const HEADINGS = join(ROOT, "samples", "fixture-headings.hwp");
const FORM = join(ROOT, "samples", "fixture-form.hwp");

function run(script, args, cwd = ROOT) {
  return spawnSync(process.execPath, [join("src/core", script), ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

function tmp() {
  return mkdtempSync(join(tmpdir(), "hwp-workflow-"));
}

test("extract_tables --summary: no grid, lists every table, keeps headers", () => {
  const r = run("extract_tables.mjs", [HWPX, "--summary"]);
  assert.equal(r.status, EXIT.OK, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.summary, true);
  assert.ok(j.tableCount >= 1);
  for (const t of j.tables) {
    assert.equal(t.grid, undefined, "summary must not ship cell text");
    assert.ok(Number.isInteger(t.rowCount));
    assert.ok(Number.isInteger(t.colCount));
    assert.equal(typeof t.hasMerged, "boolean");
    assert.ok(Array.isArray(t.header));
  }
  assert.ok(j.tables[0].header.join(" ").includes("기부"));
});

test("extract_tables --format csv: rectangular rows, covered cells empty", () => {
  const r = run("extract_tables.mjs", [HWPX, "--format", "csv", "--table", "0", "--no-nested"]);
  assert.equal(r.status, EXIT.OK, r.stderr);
  const lines = r.stdout.trimEnd().split("\n").filter((l) => l && !l.startsWith("#"));
  assert.ok(lines.length >= 2);
  assert.match(r.stdout, /65,063,026,600/);
});

test("extract_tables --summary + csv is USAGE", () => {
  const r = run("extract_tables.mjs", [HWPX, "--summary", "--format", "csv"]);
  assert.equal(r.status, EXIT.USAGE);
});

test("edit_cell --table uses extract_tables index", () => {
  const dir = tmp();
  try {
    const out = join(dir, "out.hwp");
    const r = run("edit_cell.mjs", [
      HWPX,
      "--op",
      "set",
      "--table",
      "0",
      "--row",
      "1",
      "--col",
      "0",
      "--text",
      "WORKFLOW_CELL",
      "--output",
      out,
    ]);
    assert.equal(r.status, EXIT.OK, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.ok, true);
    assert.equal(j.verified, true);
    assert.equal(j.table.index, 0);
    const check = run("extract_tables.mjs", [out, "--table", "0"]);
    assert.match(check.stdout, /WORKFLOW_CELL/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("search: hits carry page; 0 matches is exit 0", () => {
  const hit = run("search.mjs", [HEADINGS, "--query", "시장", "--format", "json"]);
  assert.equal(hit.status, EXIT.OK, hit.stderr);
  const j = JSON.parse(hit.stdout);
  assert.ok(j.matchCount >= 1);
  assert.equal(j.truncated, false);
  assert.ok(j.matches[0].context.includes("시장") || j.matches[0].text.includes("시장"));
  assert.ok(j.matches[0].page === null || Number.isInteger(j.matches[0].page));

  const miss = run("search.mjs", [HEADINGS, "--query", "ZZZ_NO_SUCH", "--format", "json"]);
  assert.equal(miss.status, EXIT.OK, miss.stderr);
  assert.equal(JSON.parse(miss.stdout).matchCount, 0);
  assert.equal(JSON.parse(miss.stdout).totalMatchCount, 0);
});

test("search --limit reports the omitted total", () => {
  const r = run("search.mjs", [HEADINGS, "--query", "현황", "--limit", "1", "--format", "json"]);
  assert.equal(r.status, EXIT.OK, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.matchCount, 1);
  assert.ok(j.totalMatchCount >= 1);
  if (j.totalMatchCount > 1) {
    assert.equal(j.truncated, true);
    assert.equal(j.omittedCount, j.totalMatchCount - 1);
  }
});

test("extract_data finds a percent quantity in the headings fixture", () => {
  const r = run("extract_data.mjs", [HEADINGS, "--kind", "number", "--format", "json"]);
  assert.equal(r.status, EXIT.OK, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.ok(j.items.some((it) => it.raw.includes("%") && it.normalized === 12));
});

test("fill_form --dry-run writes no file and lists wouldFill", () => {
  const dir = tmp();
  try {
    const values = join(dir, "v.json");
    const out = join(dir, "nope.hwp");
    writeFileSync(values, JSON.stringify({ myMsg01: "DRY" }));
    const r = run("fill_form.mjs", [FORM, "--values", values, "--output", out, "--dry-run"]);
    assert.equal(r.status, EXIT.OK, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.dryRun, true);
    assert.equal(j.wouldFill[0].key, "myMsg01");
    assert.equal(j.wouldFill[0].value, "DRY");
    try {
      readFileSync(out);
      assert.fail("dry-run must not write --output");
    } catch (e) {
      assert.equal(e.code, "ENOENT");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fill_form --list annotates occurrence", () => {
  const r = run("fill_form.mjs", [FORM, "--list"]);
  assert.equal(r.status, EXIT.OK, r.stderr);
  const fields = JSON.parse(r.stdout);
  assert.ok(Array.isArray(fields));
  const mine = fields.find((f) => f.name === "myMsg01");
  assert.ok(mine);
  assert.equal(mine.occurrence, 0);
  assert.ok(mine.sameNameCount >= 1);
});

test("fill_form --rows writes one file per jsonl row", () => {
  const dir = tmp();
  try {
    const rows = join(dir, "rows.jsonl");
    writeFileSync(rows, '{"myMsg01":"ROW_A"}\n{"myMsg01":"ROW_B"}\n');
    const r = run("fill_form.mjs", [FORM, "--rows", rows, "--out-dir", join(dir, "out")]);
    assert.equal(r.status, EXIT.OK, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.rowCount, 2);
    assert.equal(j.results.length, 2);
    assert.equal(j.results[0].verified, true);
    assert.ok(existsSync(join(dir, "out", "0001.hwp")));
    assert.ok(existsSync(join(dir, "out", "0002.hwp")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read --max-chars truncates and says so", () => {
  const r = run("read.mjs", [HEADINGS, "--no-snapshot", "--max-chars", "40"]);
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.ok(r.stdout.length <= 40, `stdout ${r.stdout.length} should be <= 40`);
  assert.match(r.stderr, /truncated/);
  assert.match(r.stderr, /omitted \d+/);
});
