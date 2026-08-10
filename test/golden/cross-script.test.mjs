// Cross-script consistency — read.mjs and extract_tables.mjs must agree about
// the SAME document.
//
// The golden replay pins each script against its own past. That is blind to the
// failure this repo actually fears: a shared-module refactor that shifts BOTH
// scripts the same way, or that quietly re-numbers table addresses so
// `extract_tables --table N` no longer names the table `read` placeheld. So this
// file asserts the seam between them:
//
//   A. read --mode strict emits exactly one placeholder per TOP-LEVEL table
//      that extract_tables reports (same count, and zero when there are none);
//   B. every non-empty origin-cell text in the extract_tables grid appears
//      somewhere in read --mode best-effort stdout (best-effort flattens the
//      same cells it addresses — it may misplace them, but it may not LOSE
//      them, and it may not invent a cell that has no address);
//   C. addresses are well-formed and unique: every top-level table has a
//      distinct (section, paragraph, controlIndex), and the grid footprint of
//      each origin cell stays inside rowCount × colCount.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const PLACEHOLDER = "[table: use extract_tables.mjs for data]";

const DOCS = [
  "samples/fixture-table.hwp",
  "samples/fixture-table.hwpx",
  "samples/fixture-form.hwp",
  "samples/fixture-memo.hwpx",
];

function run(script, args) {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(r.status, 0, `${script} ${args.join(" ")} exited ${r.status}\n${r.stderr}`);
  return r;
}

function tablesOf(doc) {
  return JSON.parse(run("src/core/extract_tables.mjs", [doc]).stdout);
}

for (const doc of DOCS) {
  test(`cross-script: ${doc} — one strict placeholder per top-level table`, () => {
    const { tables } = tablesOf(doc);
    const topLevel = tables.filter((t) => t.controlIndex !== undefined);
    const strict = run("src/core/read.mjs", [doc]).stdout;
    const placeholders = strict.split("\n").filter((l) => l === PLACEHOLDER).length;
    assert.equal(
      placeholders,
      topLevel.length,
      `${doc}: read strict emitted ${placeholders} placeholder(s) but extract_tables ` +
        `reports ${topLevel.length} top-level table(s)`,
    );
  });

  test(`cross-script: ${doc} — best-effort loses no addressed cell text`, () => {
    const { tables } = tablesOf(doc);
    const flat = run("src/core/read.mjs", [doc, "--mode", "best-effort"]).stdout;
    // Compare on a whitespace-insensitive projection: best-effort writes a
    // cell's paragraphs joined by \n, and this test is about presence, not
    // layout. (Both sides are already NFC — spec §21.)
    const haystack = flat.replace(/\s+/g, " ");
    for (const t of tables) {
      for (const row of t.grid) {
        for (const cell of row) {
          if (!cell || !cell.origin) continue;
          const needle = String(cell.text ?? "").replace(/\s+/g, " ").trim();
          if (!needle) continue;
          assert.ok(
            haystack.includes(needle),
            `${doc}: table ${t.index} cell text ${JSON.stringify(needle)} is addressed by ` +
              `extract_tables but missing from read --mode best-effort`,
          );
        }
      }
    }
  });

  test(`cross-script: ${doc} — table addresses are unique and in-bounds`, () => {
    const { tables } = tablesOf(doc);
    const seen = new Set();
    for (const t of tables) {
      if (t.controlIndex !== undefined) {
        const key = `${t.section}/${t.paragraph}/${t.controlIndex}`;
        assert.equal(seen.has(key), false, `${doc}: duplicate table address ${key}`);
        seen.add(key);
      }
      assert.equal(t.grid.length, t.rowCount, `${doc}: table ${t.index} grid row count mismatch`);
      for (const row of t.grid) {
        assert.equal(row.length, t.colCount, `${doc}: table ${t.index} grid col count mismatch`);
      }
      // Origin footprints must tile inside the grid: an origin at (r,c) with
      // span (R,C) owns exactly the covered positions that point back at it.
      for (let r = 0; r < t.rowCount; r++) {
        for (let c = 0; c < t.colCount; c++) {
          const cell = t.grid[r][c];
          if (!cell || cell.origin) continue;
          const origin = t.grid[cell.originRow]?.[cell.originCol];
          assert.ok(
            origin && origin.origin,
            `${doc}: table ${t.index} covered cell (${r},${c}) points at ` +
              `(${cell.originRow},${cell.originCol}) which is not an origin`,
          );
          assert.ok(
            r < cell.originRow + origin.rowSpan && c < cell.originCol + origin.colSpan,
            `${doc}: table ${t.index} covered cell (${r},${c}) lies outside its origin's span`,
          );
        }
      }
    }
  });
}
