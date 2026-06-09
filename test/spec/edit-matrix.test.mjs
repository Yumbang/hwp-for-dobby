// Round-trip EDIT MATRIX — the core guarantee of Phase 2 (core editing).
//
// Phase 2's whole promise is that an edit, once accepted in memory, actually
// SURVIVES save→reload on a genuine .hwp. The rhwp HWP5 serializer has a
// "raw_stream fast-path": a section that still holds its original parsed bytes
// is re-emitted verbatim, so any IR edit made through an API that did NOT null
// section.raw_stream is silently DROPPED on save (spec rule 9). In-memory
// success therefore means nothing; the only proof is to export, reload from
// disk, and confirm the change materialized. Every edit script routes its save
// through exportVerify() exactly for this reason.
//
// This file asserts that guarantee at two levels:
//
//   1. UNIT (lib/safe-edit + lib/verify, no subprocess) — the keystone
//      find/replace path. We prove BOTH halves of the design's justification:
//        • safeReplaceAll body+cell on a genuine .hwp → verified=true
//        • the engine's raw replaceAll on the SAME .hwp → verified=FALSE
//          (the silent-drop contrast that justifies safe-edit's existence)
//        • safeReplaceAll on a .hwpx-sourced doc → verified=true
//
//   2. END-TO-END (spawn each src/core editing script, cwd=repo root) — every
//      editing op an agent can invoke must exit 0 AND print a "verified":true
//      marker on stdout (a clean, confirmed round-trip). For the text-probeable
//      ops (replace/edit_text/edit_cell/table/fill_form) verified=true is a
//      real text/structural re-read on the reloaded file; for the ops whose
//      change is invisible to the text probe (format/header_footer/footnote/
//      unlock) the scripts perform their own authoritative reload check and
//      still surface "verified":true, which we assert.
//
// Fixtures (spec §0): fixture-table.hwp — genuine HWP, body text "관리대상수지"×6,
// table (0,4,0)=9×8/cellCount 68 with cell "1,802"; fixture-table.hwpx — HWPX,
// table (0,0,2)=3×8 with cell "65,063,026,600"; fixture-form.hwp — clickhere
// field 'myMsg01' (empty).
//
// All outputs go to a per-run tmp dir; nothing is written under the repo. The
// suite is deterministic — fixed queries, fixed sentinels, fixed addresses.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadDocument } from "../../src/lib/_bootstrap.mjs";
import { safeReplaceAll } from "../../src/lib/safe-edit.mjs";
import { exportVerify } from "../../src/lib/verify.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const HWP = join(ROOT, "samples", "fixture-table.hwp"); // genuine HWP
const HWPX = join(ROOT, "samples", "fixture-table.hwpx"); // HWPX
const FORM = join(ROOT, "samples", "fixture-form.hwp"); // clickhere field 'myMsg01'

// Per-run tmp dir for every output (.hwp only). Created once, torn down once.
let TMP;
const out = (name) => join(TMP, name);
test.before(() => {
  TMP = mkdtempSync(join(tmpdir(), "hwp-editmatrix-"));
});
test.after(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
});

// Spawn a src/core script with cwd=repo root, exactly as an agent / wrapping
// tool would. Returns spawnSync's {status, stdout, stderr}.
function runScript(script, args) {
  return spawnSync(process.execPath, [join("src", "core", script), ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

// A success-marker probe shared by every end-to-end case: the script must exit
// 0 and print a one-line JSON result carrying `"verified":true` on stdout.
// Returns the parsed JSON so individual cases can assert extra fields.
function assertVerifiedOk(script, args, label) {
  const r = runScript(script, args);
  assert.equal(
    r.status,
    0,
    `${label}: ${script} must exit 0 — exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
  );
  // The literal marker — robust to extra fields, and it is exactly what the
  // universal edit contract requires every success line to contain.
  assert.match(
    r.stdout,
    /"verified":\s*true/,
    `${label}: stdout must contain "verified":true — got: ${r.stdout}`,
  );
  // Parse the last JSON line (scripts may emit a warning line first).
  const lastLine = r.stdout.trim().split("\n").pop();
  let parsed;
  try {
    parsed = JSON.parse(lastLine);
  } catch {
    assert.fail(`${label}: final stdout line is not JSON: ${lastLine}`);
  }
  assert.equal(parsed.verified, true, `${label}: parsed.verified must be true`);
  assert.equal(parsed.ok, true, `${label}: parsed.ok must be true`);
  return parsed;
}

// The matrix the task asks for: op × source → verified result. Each end-to-end
// case appends a "<op>×<source> -> verified=true|false" row here so the run can
// print one consolidated view. (Exposed via the MATRIX export for the runner;
// node:test does not surface return values, so we just keep it module-local and
// log it from an after hook.)
const MATRIX = [];
function record(op, source, verified) {
  MATRIX.push(`${op}×${source} -> verified=${verified}`);
}
test.after(() => {
  // Deterministic order; printed so the integrator sees the full grid.
  // eslint-disable-next-line no-console
  console.log("\nEDIT MATRIX (op×source -> verified):\n  " + MATRIX.join("\n  "));
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. UNIT — lib/safe-edit + lib/verify (the keystone, no subprocess)
// ─────────────────────────────────────────────────────────────────────────────

test("unit safe-edit: BODY replace on genuine .hwp survives round-trip (verified=true)", async () => {
  // "관리대상수지" appears 6× in the body of fixture-table.hwp.
  const doc = await loadDocument(HWP);
  const count = safeReplaceAll(doc, "관리대상수지", "X_BODY_UNIT", true);
  assert.equal(count, 6, "expected 6 body matches of 관리대상수지");
  const r = await exportVerify(doc, out("unit-body.hwp"), {
    expectPresent: ["X_BODY_UNIT"],
    expectAbsent: ["관리대상수지"],
  });
  assert.equal(
    r.verified,
    true,
    "safeReplaceAll BODY edit must survive save→reload on a genuine .hwp",
  );
  record("safe-edit body", "hwp", r.verified);
});

test("unit safe-edit CONTRAST: engine raw replaceAll on the SAME .hwp does NOT survive (verified=false)", async () => {
  // This is the contrast that justifies safe-edit's existence: the engine's
  // own replaceAll reports an in-memory match but the .hwp raw_stream fast-path
  // drops it on save. If this ever flips to true, upstream fixed the bug and
  // the whole safe-edit indirection can be reconsidered (spec rule 9).
  const doc = await loadDocument(HWP);
  const reported = JSON.parse(
    doc.replaceAll("관리대상수지", "RAW_REPLACEALL_DROPPED", true),
  ).count;
  assert.ok(reported > 0, "engine must report an in-memory match for the body text");
  const r = await exportVerify(doc, out("unit-rawdrop.hwp"), {
    expectPresent: ["RAW_REPLACEALL_DROPPED"],
  });
  assert.equal(
    r.verified,
    false,
    "REGRESSION/GOOD-NEWS if this fails: engine replaceAll now survives on .hwp — " +
      "the raw_stream silent-drop bug appears fixed; revisit safe-edit + verify routing.",
  );
  record("raw replaceAll (contrast)", "hwp", r.verified);
});

test("unit safe-edit: CELL replace on genuine .hwp survives round-trip (verified=true)", async () => {
  // The bare cell value "1,802" lives in table (0,4,0). safeReplaceAll must
  // locate it via searchAllText(include_cells=true) and rewrite it with the
  // cell delete/insert primitives so it survives the round-trip (spec rule 14).
  const doc = await loadDocument(HWP);
  const count = safeReplaceAll(doc, "1,802", "Y_CELL_UNIT", true);
  assert.ok(count >= 1, "expected at least one cell match of 1,802");
  const r = await exportVerify(doc, out("unit-cell.hwp"), {
    expectPresent: ["Y_CELL_UNIT"],
  });
  assert.equal(
    r.verified,
    true,
    "safeReplaceAll CELL edit must survive save→reload on a genuine .hwp",
  );
  record("safe-edit cell", "hwp", r.verified);
});

test("unit safe-edit: replace on .hwpx-sourced doc survives round-trip (verified=true)", async () => {
  // HWPX-sourced docs have no raw_stream cache, so safeReplaceAll dispatches to
  // the engine's replaceAll, which is safe here (spec rule 24). Output is .hwp.
  const doc = await loadDocument(HWPX);
  const count = safeReplaceAll(doc, "65,063,026,600", "Z_HWPX_UNIT", true);
  assert.ok(count >= 1, "expected the probed cell value in the .hwpx fixture");
  const r = await exportVerify(doc, out("unit-hwpx.hwp"), {
    expectPresent: ["Z_HWPX_UNIT"],
    expectAbsent: ["65,063,026,600"],
  });
  assert.equal(r.verified, true, "safeReplaceAll on .hwpx input must survive to .hwp");
  record("safe-edit replace", "hwpx", r.verified);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. END-TO-END — spawn each src/core editing script, assert exit 0 + verified
// ─────────────────────────────────────────────────────────────────────────────

// ── replace.mjs (body / cell / hwpx) ────────────────────────────────────────
test("e2e replace: BODY replace on genuine .hwp → exit 0, verified=true, count 6", () => {
  const p = assertVerifiedOk(
    "replace.mjs",
    [HWP, "--query", "관리대상수지", "--replacement", "E2E_BODY", "--case-sensitive", "--output", out("e2e-r-body.hwp")],
    "replace/body/hwp",
  );
  assert.equal(p.count, 6, "body replace must report 6 matches");
  record("replace body", "hwp", p.verified);
});

test("e2e replace: CELL replace on genuine .hwp → exit 0, verified=true", () => {
  const p = assertVerifiedOk(
    "replace.mjs",
    [HWP, "--query", "1,802", "--replacement", "E2E_CELL", "--case-sensitive", "--output", out("e2e-r-cell.hwp")],
    "replace/cell/hwp",
  );
  assert.ok(p.count >= 1, "cell replace must report at least one match");
  record("replace cell", "hwp", p.verified);
});

test("e2e replace: .hwpx input → .hwp output → exit 0, verified=true", () => {
  const p = assertVerifiedOk(
    "replace.mjs",
    [HWPX, "--query", "65,063,026,600", "--replacement", "E2E_HWPX", "--case-sensitive", "--output", out("e2e-r-hwpx.hwp")],
    "replace/hwpx",
  );
  assert.ok(p.count >= 1);
  record("replace", "hwpx", p.verified);
});

// ── edit_text.mjs (insert sentinel) ─────────────────────────────────────────
test("e2e edit_text: insert sentinel into body → exit 0, verified=true", () => {
  const p = assertVerifiedOk(
    "edit_text.mjs",
    [HWP, "--op", "insert", "--section", "0", "--paragraph", "0", "--offset", "0", "--text", "EDITTEXT_SENTINEL_0715", "--output", out("e2e-edit-text.hwp")],
    "edit_text/insert/hwp",
  );
  assert.equal(p.op, "insert");
  record("edit_text insert", "hwp", p.verified);
});

// ── edit_cell.mjs (set cell) ────────────────────────────────────────────────
test("e2e edit_cell: set cell (0,4,0)@row0/col0 → exit 0, verified=true", () => {
  const p = assertVerifiedOk(
    "edit_cell.mjs",
    [HWP, "--op", "set", "--section", "0", "--paragraph", "4", "--control", "0", "--row", "0", "--col", "0", "--text", "EDITCELL_SET_0715", "--output", out("e2e-edit-cell.hwp")],
    "edit_cell/set/hwp",
  );
  assert.equal(p.op, "set");
  record("edit_cell set", "hwp", p.verified);
});

// ── table.mjs (create) ──────────────────────────────────────────────────────
test("e2e table: create 3×4 table → exit 0, verified=true, structural delta confirmed", () => {
  const p = assertVerifiedOk(
    "table.mjs",
    [HWP, "--op", "create", "--section", "0", "--paragraph", "0", "--offset", "0", "--rows", "3", "--cols", "4", "--output", out("e2e-table-create.hwp")],
    "table/create/hwp",
  );
  // The script independently re-reads getTableDimensions on the reloaded output.
  assert.equal(p.newTableDims.rowCount, 3);
  assert.equal(p.newTableDims.colCount, 4);
  assert.equal(p.structuralVerified, true, "table create must confirm the structural delta on reload");
  record("table create", "hwp", p.verified);
});

// ── fill_form.mjs (fill myMsg01) ────────────────────────────────────────────
test("e2e fill_form: fill empty field myMsg01 → exit 0, verified=true, clean (no #838 warn)", () => {
  const valuesPath = out("ff-values.json");
  writeFileSync(valuesPath, JSON.stringify({ myMsg01: "FILLFORM_0715" }));
  const p = assertVerifiedOk(
    "fill_form.mjs",
    [FORM, "--values", valuesPath, "--output", out("e2e-fill-form.hwp")],
    "fill_form/fill/hwp",
  );
  assert.deepEqual(p.applied, ["myMsg01"], "exactly the one field must be applied");
  // The fixture field is empty, so filling it is the CLEAN path — no #838 warn.
  assert.deepEqual(p.prefilledWarned, [], "filling an empty field must not trigger the #838 pre-fill warning");
  record("fill_form fill", "hwp", p.verified);
});

// ── format.mjs (char + para; not text-probeable, asserted via clean round-trip)
test("e2e format: para alignment=center → exit 0, verified=true (clean round-trip)", () => {
  const p = assertVerifiedOk(
    "format.mjs",
    [HWP, "--op", "para", "--section", "0", "--paragraph", "7", "--props", '{"alignment":"center"}', "--output", out("e2e-format-para.hwp")],
    "format/para/hwp",
  );
  // The script re-reads the prop via the shape getter after reload.
  assert.equal(p.applied.alignment, "center", "para alignment must read back as center on reload");
  record("format para", "hwp", p.verified);
});

test("e2e format: char bold=true → exit 0, verified=true (clean round-trip)", () => {
  const p = assertVerifiedOk(
    "format.mjs",
    [HWP, "--op", "char", "--section", "0", "--paragraph", "7", "--start", "0", "--end", "6", "--props", '{"bold":true}', "--output", out("e2e-format-char.hwp")],
    "format/char/hwp",
  );
  assert.equal(p.applied.bold, true, "char bold must read back as true on reload");
  record("format char", "hwp", p.verified);
});

// ── header_footer.mjs (create; H/F text is invisible to probeTextCount) ──────
test("e2e header_footer: create header (apply-to all) → exit 0, verified=true", () => {
  const p = assertVerifiedOk(
    "header_footer.mjs",
    [HWP, "--op", "create", "--section", "0", "--header", "--apply-to", "1", "--output", out("e2e-hf-create.hwp")],
    "header_footer/create/hwp",
  );
  assert.equal(p.op, "create");
  assert.equal(p.kind, "header");
  record("header_footer create", "hwp", p.verified);
});

// ── footnote.mjs (insert; footnote bodies are invisible to probeTextCount) ───
test("e2e footnote: insert footnote into body → exit 0, verified=true, count +1", () => {
  const p = assertVerifiedOk(
    "footnote.mjs",
    [HWP, "--op", "insert", "--section", "0", "--paragraph", "0", "--output", out("e2e-footnote.hwp")],
    "footnote/insert/hwp",
  );
  assert.equal(p.op, "insert");
  assert.equal(p.footnotesBefore, 0);
  assert.equal(p.footnotesAfter, 1, "insert must add exactly one footnote (confirmed on reload)");
  record("footnote insert", "hwp", p.verified);
});

// ── unlock.mjs (convertToEditable; verified via clean body round-trip) ───────
test("e2e unlock: convertToEditable on an unlocked fixture → exit 0, verified=true (clean no-op)", () => {
  const p = assertVerifiedOk(
    "unlock.mjs",
    [HWP, "--output", out("e2e-unlock.hwp")],
    "unlock/hwp",
  );
  // The fixtures are unlocked, so this is a successful no-op (converted=false).
  assert.equal(p.converted, false, "an already-unlocked doc reports converted=false");
  assert.equal(p.wasLocked, false);
  record("unlock", "hwp", p.verified);
});

// ── A negative-control sanity gate: prove the verified marker is meaningful ──
test("sanity: a script that fails its round-trip would NOT print verified:true (guard is non-trivial)", () => {
  // We can't easily force a real round-trip drop through the scripts (they're
  // correct), so we instead prove the assertion is non-vacuous: the .hwpx
  // OUTPUT path is hard-refused (assertHwpOutput), exiting 2 with NO
  // "verified":true marker. This guards that assertVerifiedOk's marker check
  // can actually distinguish success from failure.
  const r = runScript("replace.mjs", [
    HWP, "--query", "관리대상수지", "--replacement", "X", "--output", out("bad.hwpx"),
  ]);
  assert.equal(r.status, 2, "refusing .hwpx output must be a USAGE(2) error");
  assert.doesNotMatch(
    r.stdout,
    /"verified":\s*true/,
    "a refused write must NOT print a verified:true marker",
  );
  assert.equal(existsSync(out("bad.hwpx")), false, "no .hwpx file may be written");
});
