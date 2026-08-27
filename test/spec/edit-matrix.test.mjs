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
//      find/replace path:
//        • safeReplaceAll body+cell on a genuine .hwp → verified=true
//        • the engine's raw replaceAll on the SAME .hwp → verified=true, the
//          property safe-edit's one-line delegation now rests on (spec rule 9;
//          this assertion was inverted up to engine 0.7.15)
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

test("unit: engine raw replaceAll on a genuine .hwp survives save→reload (≥0.7.16)", async () => {
  // safeReplaceAll now delegates straight to the engine, so this asserts the
  // property that delegation depends on: the .hwp raw_stream cache is nulled by
  // replaceAll, and the edit reaches disk. Up to 0.7.15 this was false and the
  // skill routed around it with searchAllText + delete/insert (spec rule 9).
  const doc = await loadDocument(HWP);
  const reported = JSON.parse(
    doc.replaceAll("관리대상수지", "RAW_REPLACEALL_SURVIVES", true),
  ).count;
  assert.ok(reported > 0, "engine must report an in-memory match for the body text");
  const r = await exportVerify(doc, out("unit-rawdrop.hwp"), {
    expectPresent: ["RAW_REPLACEALL_SURVIVES"],
  });
  assert.equal(
    r.verified,
    true,
    "REGRESSION: engine replaceAll is dropping edits on .hwp again — restore the " +
      "delete/insert routing in lib/safe-edit.mjs.",
  );
  record("raw replaceAll", "hwp", r.verified);
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

// ── --op insert --format : the inserted span, and ONLY it ──────────────────
//
// insertText has no formatting argument, so new text inherits the character
// before the insertion point (spec rule 63). --format formats the inserted run
// afterwards. The whole correctness question is the RANGE: it is measured from
// the engine's paragraph length, not computed from text.length, because a
// surrogate pair is two units in JS and one in the document. These tests pin
// the boundary from the SAVED file — the character after the span must be
// untouched, which is what a text.length range would get wrong.

const HEADINGS = join(ROOT, "samples", "fixture-headings.hwp");
const FMT_S = 0;
const FMT_P = 6; // len 16, real text. Paragraph 5 is EMPTY — see spec rule 62.

// Read (bold, textColor) for every character of the saved paragraph.
async function charMap(path, sec, para) {
  const doc = await loadDocument(path);
  const len = doc.getParagraphLength(sec, para);
  const rows = [];
  for (let o = 0; o < len; o++) {
    const c = JSON.parse(doc.getCharPropertiesAt(sec, para, o));
    rows.push({ bold: c.bold, textColor: c.textColor, fontSize: c.fontSize });
  }
  return rows;
}

test("edit_text --format: formats exactly the inserted span, nothing adjacent", async () => {
  const dst = out("fmt-basic.hwp");
  const j = assertVerifiedOk(
    "edit_text.mjs",
    [HEADINGS, "--op", "insert", "--section", String(FMT_S), "--paragraph", String(FMT_P),
     "--offset", "4", "--text", "삽입됨", "--format", '{"bold":true}', "--output", dst],
    "insert with --format",
  );
  assert.deepEqual(j.formattedRange, { start: 4, end: 7 });
  assert.equal(j.effect.bold, "changed");

  const rows = await charMap(dst, FMT_S, FMT_P);
  for (let o = 0; o < rows.length; o++) {
    assert.equal(rows[o].bold, o >= 4 && o < 7, `char ${o} bold should be ${o >= 4 && o < 7}`);
  }
});

test("edit_text --format: an astral character does not overrun the span", async () => {
  // "테스트🙂끝" is 6 in JS and 5 in the document. A range of off+text.length
  // would format one character that was never inserted — the character at
  // index 9 below, which must stay unformatted.
  const TEXT = "테스트🙂끝";
  assert.equal(TEXT.length, 6, "precondition: JS sees 6 units");
  const dst = out("fmt-astral.hwp");
  const j = assertVerifiedOk(
    "edit_text.mjs",
    [HEADINGS, "--op", "insert", "--section", String(FMT_S), "--paragraph", String(FMT_P),
     "--offset", "4", "--text", TEXT, "--format", '{"bold":true}', "--output", dst],
    "insert an astral character with --format",
  );
  assert.deepEqual(
    j.formattedRange,
    { start: 4, end: 9 },
    "the engine counts the surrogate pair as one character",
  );

  const rows = await charMap(dst, FMT_S, FMT_P);
  for (let o = 0; o < rows.length; o++) {
    assert.equal(rows[o].bold, o >= 4 && o < 9, `char ${o} bold should be ${o >= 4 && o < 9}`);
  }
  assert.equal(rows[9].bold, false, "the character AFTER the insert must not be formatted");
});

test("edit_text --format: does not inherit the anchor's formatting", async () => {
  // The failure this feature exists for. Make the anchor bold, then insert
  // unformatted text next to it: --format false must win over inheritance.
  const bolded = out("fmt-anchor.hwp");
  assertVerifiedOk(
    "format.mjs",
    [HEADINGS, "--op", "char", "--section", String(FMT_S), "--paragraph", String(FMT_P),
     "--start", "0", "--end", "16", "--props", '{"bold":true}', "--output", bolded],
    "make the whole anchor paragraph bold",
  );
  const dst = out("fmt-anchor-out.hwp");
  const j = assertVerifiedOk(
    "edit_text.mjs",
    [bolded, "--op", "insert", "--section", String(FMT_S), "--paragraph", String(FMT_P),
     "--offset", "8", "--text", "보통", "--format", '{"bold":false}', "--output", dst],
    "insert unformatted text into a bold paragraph",
  );
  assert.deepEqual(j.formattedRange, { start: 8, end: 10 });
  const rows = await charMap(dst, FMT_S, FMT_P);
  assert.equal(rows[7].bold, true, "the anchor stays bold");
  assert.equal(rows[8].bold, false, "the inserted text is NOT bold — inheritance overridden");
  assert.equal(rows[9].bold, false);
  assert.equal(rows[10].bold, true, "text after the insert stays bold");
});

test("edit_text --format: refused for ops where it cannot work", () => {
  for (const [op, extra] of [["delete", ["--count", "1"]], ["insert-paragraph", []]]) {
    const r = runScript("edit_text.mjs", [
      HEADINGS, "--op", op, "--section", "0", "--paragraph", "6",
      ...extra, "--format", '{"bold":true}', "--output", out(`fmt-bad-${op}.hwp`),
    ]);
    assert.equal(r.status, 2, `--format with --op ${op} should exit USAGE(2)`);
    assert.match(r.stderr, /--format applies only to --op insert/);
    assert.equal(existsSync(out(`fmt-bad-${op}.hwp`)), false, "a refused edit writes no file");
  }
  // The insert-paragraph message must explain the empty-paragraph trap, since
  // "format a new paragraph" is the obvious thing to try.
  const r = runScript("edit_text.mjs", [
    HEADINGS, "--op", "insert-paragraph", "--section", "0", "--paragraph", "6",
    "--format", '{"bold":true}', "--output", out("fmt-bad-2.hwp"),
  ]);
  assert.match(r.stderr, /EMPTY/);
  assert.match(r.stderr, /insert-paragraph first, then insert its text/);
});

test("edit_text --format: a silently-ignored property is refused, not applied", () => {
  // Same guarantee format.mjs gives: the engine answers ok:true for all of
  // these and changes nothing, so they must never reach it.
  for (const [props, expected] of [
    ['{"boldd":true}', /did you mean "bold"/],
    ['{"BOLD":true}', /did you mean "bold"/],
    ['{"fontFamily":"굴림"}', /NO EFFECT/],
    ['{"bold":"yes"}', /must be true or false/],
    ['{"alignment":"center"}', /is a --op para property/],
    ['{"underlineType":"Solid"}', /must be one of "None", "Bottom", "Top"/],
    ["{}", /--props is empty/],
    ["not json", /not valid JSON/],
  ]) {
    const dst = out("fmt-reject.hwp");
    const r = runScript("edit_text.mjs", [
      HEADINGS, "--op", "insert", "--section", "0", "--paragraph", "6",
      "--offset", "0", "--text", "x", "--format", props, "--output", dst,
    ]);
    assert.equal(r.status, 2, `${props} should exit USAGE(2), got ${r.status}`);
    assert.match(r.stderr, expected);
    assert.equal(existsSync(dst), false, `${props}: a refused edit must write no file`);
  }
});

// ── HWPX → HWP export: what it may and may not change ─────────────────────
//
// An HWPX input is converted on export (the engine emits .hwp only), and that
// conversion is allowed to normalise structure. Measured across the corpus:
// 0 of 106 .hwp documents change their paragraph count on a no-op round trip,
// and 1 of 18 .hwpx documents does — it gains ONE empty paragraph at the end
// of a non-final section that did not already end with one. Spec rule 70.
//
// That is benign, and these tests pin the reasons it is benign rather than the
// count itself: no text is lost, no existing address moves, and it happens once
// rather than accumulating. If a future engine broke any of those, an agent
// holding paragraph addresses across a save would silently edit the wrong line.

const HWPX_FIX = join(ROOT, "samples", "fixture-table.hwpx");

function allText(doc) {
  const out = [];
  for (let s = 0; s < doc.getSectionCount(); s++) {
    for (let p = 0; p < doc.getParagraphCount(s); p++) {
      const len = doc.getParagraphLength(s, p);
      if (len) out.push(doc.getTextRange(s, p, 0, len));
    }
  }
  return out.join("\n");
}

test("hwpx→hwp export: no text is lost and no existing address moves", async () => {
  const { writeFileSync } = await import("node:fs");
  const a = await loadDocument(HWPX_FIX);
  const dst = out("hwpx-rt.hwp");
  writeFileSync(dst, Buffer.from(a.exportHwp()));
  const b = await loadDocument(dst);

  assert.equal(allText(b), allText(a), "conversion must not change body text");
  assert.equal(b.pageCount(), a.pageCount(), "nor the page count");
  // The invariant that matters most: an address an agent already holds still
  // points at the same paragraph after the save.
  for (let s = 0; s < a.getSectionCount(); s++) {
    for (let p = 0; p < a.getParagraphCount(s); p++) {
      assert.equal(
        b.getParagraphLength(s, p),
        a.getParagraphLength(s, p),
        `paragraph (${s},${p}) must not drift`,
      );
    }
  }
  // Any normalisation only APPENDS.
  for (let s = 0; s < a.getSectionCount(); s++) {
    assert.ok(
      b.getParagraphCount(s) >= a.getParagraphCount(s),
      `section ${s} must not lose paragraphs`,
    );
  }
});

test("hwpx→hwp export: normalisation happens once, it does not accumulate", async () => {
  // A conversion artifact that grew on every save would turn a document that
  // is edited repeatedly into one with a tail of empty paragraphs.
  const { writeFileSync } = await import("node:fs");
  let current = HWPX_FIX;
  const counts = [];
  for (let i = 0; i < 4; i++) {
    const d = await loadDocument(current);
    counts.push([...Array(d.getSectionCount()).keys()].map((s) => d.getParagraphCount(s)));
    const dst = out(`hwpx-acc-${i}.hwp`);
    writeFileSync(dst, Buffer.from(d.exportHwp()));
    current = dst;
  }
  // Rounds 1..3 are all .hwp→.hwp and must be identical to each other.
  assert.deepEqual(counts[2], counts[1], "a second .hwp round trip changes nothing");
  assert.deepEqual(counts[3], counts[1], "and neither does a third");
});
