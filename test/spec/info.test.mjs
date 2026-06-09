// Spec tests for src/core/info.mjs — the document-summary contract.
//
// Asserted rules / behaviors:
//   • --validate surfaces the engine's structural-anomaly report as a
//     `validation` object shaped {count, summary, warnings}
//     (getValidationWarnings, rhwp.d.ts). Default output omits it (lean).
//   • hasTable reflects documentHasTable() — true for both fixture-table.*
//     (genuine HWP and HWPX), false for the form fixture.
//   • fieldCount reflects getFieldList() — exactly 1 for fixture-form.hwp
//     (the clickhere field 'myMsg01', spec §0/§3 rule 18).
//   • sourceFormat is reported as 'hwp' / 'hwpx' so the agent knows the input.
//
// Driven by spawning src/core/info.mjs (cwd=repo root) and parsing its JSON,
// exactly as a wrapping tool would.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

function runInfo(args) {
  return spawnSync(process.execPath, ["src/core/info.mjs", ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
}
function infoJson(args) {
  const r = runInfo(args);
  assert.equal(r.status, 0, `info.mjs exited ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

test("--validate yields a validation object shaped {count, summary, warnings}", () => {
  const out = infoJson(["samples/fixture-form.hwp", "--validate"]);
  assert.ok(out.validation && typeof out.validation === "object", "validation object must be present");
  // The engine's getValidationWarnings contract: count + summary + warnings.
  assert.equal(typeof out.validation.count, "number", "validation.count must be a number");
  assert.ok("summary" in out.validation, "validation.summary must be present");
  assert.ok(Array.isArray(out.validation.warnings), "validation.warnings must be an array");
});

test("validation is OMITTED by default (lean output)", () => {
  const out = infoJson(["samples/fixture-form.hwp"]);
  assert.equal(
    "validation" in out,
    false,
    "default info output must not include the validation object",
  );
});

test("hasTable is true for fixture-table.hwp (genuine HWP)", () => {
  const out = infoJson(["samples/fixture-table.hwp"]);
  assert.equal(out.hasTable, true);
  assert.equal(out.sourceFormat, "hwp");
});

test("hasTable is true for fixture-table.hwpx (HWPX)", () => {
  const out = infoJson(["samples/fixture-table.hwpx"]);
  assert.equal(out.hasTable, true);
  assert.equal(out.sourceFormat, "hwpx");
});

test("fieldCount is 1 for fixture-form.hwp (the 'myMsg01' field) and hasTable is false", () => {
  const out = infoJson(["samples/fixture-form.hwp"]);
  assert.equal(out.fieldCount, 1, "form fixture has exactly one field (myMsg01)");
  assert.equal(out.hasTable, false, "the form fixture has no table");
  assert.equal(out.sourceFormat, "hwp");
});

test("--validate keeps the other summary fields intact", () => {
  // Adding --validate must not change the rest of the summary.
  const plain = infoJson(["samples/fixture-form.hwp"]);
  const validated = infoJson(["samples/fixture-form.hwp", "--validate"]);
  assert.equal(validated.fieldCount, plain.fieldCount);
  assert.equal(validated.hasTable, plain.hasTable);
  assert.equal(validated.sourceFormat, plain.sourceFormat);
  assert.equal(validated.pageCount, plain.pageCount);
});

test("usage errors: missing input → exit 2 (USAGE)", () => {
  const r = runInfo([]);
  assert.equal(r.status, 2, "missing input must be a USAGE error");
});
