// Spec tests for src/core/read.mjs — the anti-silent-corruption contract
// (spec §1.1 merge-origin storage + "tables existing is not an error").
//
// The load-bearing rule: WASM text extraction can only FLATTEN a table to
// document-order cell text, which misplaces merged cells. So the DEFAULT
// (--mode strict) MUST NOT emit flattened table cell text — it replaces each
// table with a placeholder and prints a loud stderr warning, but keeps body
// text and exits 0 (a table is not a failure). --mode best-effort opts into
// the risky inline flattening and must still emit a warning.
//
// We assert by spawning src/core/read.mjs (cwd=repo root) and inspecting
// stdout/stderr, so the behavior is checked end-to-end exactly as an agent
// would invoke it.
//
// Fixture: fixture-table.hwp — genuine HWP whose table cells include "△1,802"
// and the header "구   분" (ASCII spaces). These cell values are the canary:
// they must be ABSENT from strict stdout and PRESENT in best-effort stdout.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

const PLACEHOLDER = "[table: use extract_tables.mjs for data]";
// Cell values that live ONLY inside the table; if they appear in strict stdout
// the table was flattened (silent corruption). △1,802 is the canonical cell
// from the spec; the others are extra canaries from distinct table cells.
const TABLE_CELL_CANARIES = ["△1,802", "△443"];

function runRead(args) {
  return spawnSync(process.execPath, ["src/core/read.mjs", ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

test("strict mode (default): table cell values are NOT emitted to stdout", () => {
  const r = runRead(["samples/fixture-table.hwp"]); // default --mode strict
  assert.equal(r.status, 0, `strict read must exit 0 (a table is not an error): ${r.stderr}`);
  for (const canary of TABLE_CELL_CANARIES) {
    assert.equal(
      r.stdout.includes(canary),
      false,
      `strict stdout must NOT contain flattened table cell "${canary}"`,
    );
  }
  // Each table is replaced by a placeholder line instead of its data.
  assert.ok(
    r.stdout.includes(PLACEHOLDER),
    "strict stdout must replace tables with the placeholder line",
  );
});

test("strict mode: prints a loud stderr WARNING but still exits 0", () => {
  const r = runRead(["samples/fixture-table.hwp"]);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /WARNING/, "strict must warn that tables are present and not flattened");
  assert.match(
    r.stderr,
    /extract_tables\.mjs/,
    "strict warning must steer the agent to extract_tables.mjs for table DATA",
  );
});

test("strict mode: body text is preserved even though tables are withheld", () => {
  const r = runRead(["samples/fixture-table.hwp"]);
  assert.equal(r.status, 0);
  // Body paragraph text (outside any table) must survive — strict only
  // refuses to FLATTEN tables, it does not drop the document body.
  assert.ok(
    r.stdout.includes("관리대상수지"),
    "strict must still emit body text outside tables",
  );
});

test("best-effort mode: flattened table cell values ARE emitted and the warning fires", () => {
  const r = runRead(["samples/fixture-table.hwp", "--mode", "best-effort"]);
  assert.equal(r.status, 0, r.stderr);
  // Opt-in flattening: the canary cell value now appears inline.
  assert.ok(
    r.stdout.includes("△1,802"),
    "best-effort must flatten table cell text inline (△1,802 present)",
  );
  // No placeholder lines in best-effort — the data replaces them.
  assert.equal(
    r.stdout.includes(PLACEHOLDER),
    false,
    "best-effort must not emit the strict placeholder",
  );
  // It must STILL warn that merged cells may be misplaced.
  assert.match(r.stderr, /WARNING/, "best-effort must warn about possible merged-cell misplacement");
  assert.match(r.stderr, /best-effort/, "best-effort warning must name the mode");
});

test("strict vs best-effort: the table cell is the only difference for the canary value", () => {
  const strict = runRead(["samples/fixture-table.hwp"]);
  const best = runRead(["samples/fixture-table.hwp", "--mode", "best-effort"]);
  assert.equal(strict.status, 0);
  assert.equal(best.status, 0);
  // The exact contract: strict withholds, best-effort reveals.
  assert.equal(strict.stdout.includes("△1,802"), false);
  assert.equal(best.stdout.includes("△1,802"), true);
});

test("cross-format: strict withholds the .hwpx merged cell, best-effort reveals it", () => {
  // fixture-table.hwpx merged data cell value.
  const CELL = "65,063,026,600";
  const strict = runRead(["samples/fixture-table.hwpx"]);
  const best = runRead(["samples/fixture-table.hwpx", "--mode", "best-effort"]);
  assert.equal(strict.status, 0, strict.stderr);
  assert.equal(best.status, 0, best.stderr);
  assert.equal(
    strict.stdout.includes(CELL),
    false,
    "strict must withhold the .hwpx merged cell value",
  );
  assert.equal(
    best.stdout.includes(CELL),
    true,
    "best-effort must flatten the .hwpx merged cell value",
  );
});
