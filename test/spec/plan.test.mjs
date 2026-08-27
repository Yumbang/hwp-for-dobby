// Replaying an edit plan — batching, and the two things batching must not lose.
//
// Batching is not a multi-agent nicety; the solo case is where it pays. The
// same twelve edits cost 4,895 ms and twelve intermediate files as twelve
// script invocations, against 59 ms and one file replayed — with the SAME
// verification, not a cheaper one. The cost being paid twelve times is the
// process start, the 6.9 MB WASM load, the parse and the save, not the editing.
//
// What batching changes, and what these tests pin:
//
//   1. FAILURE LOCATION. Twelve invocations leave files 1..6 when step 7
//      fails. One pass has no trail, so a failure must name the STEP and write
//      no output.
//   2. VERIFICATION GRANULARITY. Twelve invocations verify twelve times. A
//      batch that collapsed that into "the file still opens" would re-open the
//      silent-failure hole the engine's permissive ok:true creates. Every step
//      records an intent, checked against the RELOADED file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadDocument } from "../../src/lib/_bootstrap.mjs";
import { PLAN_OPS, checkOrdering } from "../../src/lib/plan.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const FIX = join(ROOT, "samples", "fixture-headings.hwp");

let TMP;
const at = (n) => join(TMP, n);
test.before(() => {
  TMP = mkdtempSync(join(tmpdir(), "hwp-plan-"));
});
test.after(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
});

function runPlan(plan, out, extra = []) {
  const planPath = at(`plan-${Math.abs(JSON.stringify(plan).length)}-${out}.json`);
  writeFileSync(planPath, JSON.stringify(plan));
  return spawnSync(
    process.execPath,
    [join("src", "core", "create.mjs"), "--input", FIX, "--plan", planPath, "--output", at(out), ...extra],
    { cwd: ROOT, encoding: "utf8" },
  );
}

// ── ordering ──────────────────────────────────────────────────────────────

test("plan: an insertion that would misaddress a later step is REFUSED", () => {
  // The whole index problem in one case: insert at 5, and the step that meant
  // paragraph 12 now means 13. Applying both as written edits the wrong
  // paragraph and looks like a success.
  const r = runPlan(
    {
      steps: [
        { op: "insert_paragraph", section: 0, para: 5 },
        { op: "apply_char_format", section: 0, para: 12, start: 0, end: 3, props: { bold: true } },
      ],
    },
    "hazard.hwp",
  );
  assert.equal(r.status, 2, "a misaddressing plan is a usage error");
  assert.match(r.stderr, /would edit the wrong paragraphs/);
  assert.match(r.stderr, /step 0 \(insert_paragraph\)/, "it names the inserting step");
  assert.match(r.stderr, /step 1 \(apply_char_format\)/, "and the affected one");
  assert.equal(existsSync(at("hazard.hwp")), false, "and writes nothing");
});

test("plan: checkOrdering is quiet when nothing can actually be misaddressed", () => {
  const EXISTING = 20;
  // Highest-address-first is the safe order — the same reason lib/blocks.mjs
  // splices inline controls in descending offset order.
  assert.deepEqual(
    checkOrdering(
      [
        { op: "apply_char_format", section: 0, para: 12 },
        { op: "insert_paragraph", section: 0, para: 5 },
      ],
      EXISTING,
    ),
    [],
  );
  // An insertion below a later edit shifts nothing that step refers to.
  assert.deepEqual(
    checkOrdering(
      [
        { op: "insert_paragraph", section: 0, para: 12 },
        { op: "apply_char_format", section: 0, para: 5 },
      ],
      EXISTING,
    ),
    [],
  );
});

test("plan: BUILDING a document is not a misaddressing hazard", () => {
  // The false positive that broke the fixture generator. Appending — insert at
  // the end, fill what you just made, repeat — is how a plan constructs a
  // document, and there is never a pre-existing paragraph after the insertion
  // point to renumber.
  const steps = [];
  for (let i = 0; i < 5; i++) {
    if (i > 0) steps.push({ op: "insert_paragraph", section: 0, para: i });
    steps.push({ op: "insert_text", section: 0, para: i, char: 0, text: `줄 ${i}` });
    steps.push({ op: "apply_para_format", section: 0, para: i, props: { marginLeft: 2000 } });
  }
  assert.deepEqual(checkOrdering(steps, 0), [], "building from blank flags nothing");
  // And the same shape appended to an existing 3-paragraph document.
  const appended = [
    { op: "insert_paragraph", section: 0, para: 3 },
    { op: "insert_text", section: 0, para: 3, char: 0, text: "새 줄" },
  ];
  assert.deepEqual(checkOrdering(appended, 3), [], "appending at the end flags nothing");
});

test('plan: order "descending" sorts independent steps, refuses dependent ones', () => {
  const ok = runPlan(
    {
      order: "descending",
      steps: [
        { op: "apply_para_format", section: 0, para: 6, props: { alignment: "center" } },
        { op: "apply_para_format", section: 0, para: 12, props: { alignment: "center" } },
      ],
    },
    "desc.hwp",
  );
  assert.equal(ok.status, 0, ok.stderr);
  const j = JSON.parse(ok.stdout);
  assert.deepEqual(
    j.applied.map((a) => a.step),
    [1, 0],
    "highest address first, so insertions could not invalidate anything",
  );

  const bad = runPlan(
    {
      order: "descending",
      steps: [
        { op: "insert_paragraph", section: 0, para: 5 },
        { op: "insert_text", section: 0, para: 5, char: 0, text: "새 문단" },
      ],
    },
    "desc-bad.hwp",
  );
  assert.equal(bad.status, 2, "sorting a dependent sequence would reorder it");
  assert.match(bad.stderr, /needs independent steps/);
});

// ── verification ──────────────────────────────────────────────────────────

test("plan: a step the engine silently ignored FAILS the run", () => {
  // Paragraph 1 of this fixture is empty, and character formatting on a
  // paragraph with no characters is a silent no-op that still answers
  // ok:true (spec rule 62). A batch that only checked "the file reloads"
  // would report success here.
  const r = runPlan(
    { steps: [{ op: "apply_char_format", section: 0, para: 1, start: 0, end: 5, props: { bold: true } }] },
    "noop.hwp",
  );
  assert.equal(r.status, 5, "an unconfirmed step is CORRUPTION, not success");
  assert.match(r.stderr, /did not take on disk/);
  assert.match(r.stderr, /step 0 \(apply_char_format\)/, "and it says which step");
});

test("plan: every applied step is confirmed against the reloaded file", async () => {
  const r = runPlan(
    {
      order: "descending",
      steps: [
        { op: "apply_char_format", section: 0, para: 6, start: 0, end: 10, props: { bold: true } },
        { op: "apply_para_format", section: 0, para: 12, props: { alignment: "center" } },
      ],
    },
    "confirm.hwp",
  );
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.verified, true);
  assert.equal(j.confirmed, 2, "both steps recorded and confirmed an intent");
  assert.equal(j.mode, "batch-apply");

  // Independently, from disk.
  const back = await loadDocument(at("confirm.hwp"));
  assert.equal(JSON.parse(back.getCharPropertiesAt(0, 6, 0)).bold, true);
  assert.equal(JSON.parse(back.getParaPropertiesAt(0, 12)).alignment, "center");
});

test("plan: a typo'd property is refused before the document is touched", () => {
  const r = runPlan(
    { steps: [{ op: "apply_char_format", section: 0, para: 6, start: 0, end: 3, props: { boldd: true } }] },
    "typo.hwp",
  );
  assert.equal(r.status, 2);
  assert.match(r.stderr, /step 0/, "the step index is in the message");
  assert.match(r.stderr, /did you mean "bold"\?/);
  assert.equal(existsSync(at("typo.hwp")), false);
});

test("plan: an unknown op names the vocabulary", () => {
  const r = runPlan({ steps: [{ op: "make_it_nice", section: 0, para: 0 }] }, "unknown.hwp");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /step 0: unknown op/);
  for (const op of PLAN_OPS) assert.ok(r.stderr.includes(op), `the error should list ${op}`);
});

test("plan: an empty plan is refused rather than producing a copy", () => {
  const r = runPlan({ steps: [] }, "empty.hwp");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /steps is empty/);
  assert.equal(existsSync(at("empty.hwp")), false);
});

// ── the reason it exists ──────────────────────────────────────────────────

test("plan: many edits cost ONE load/save, not one each", async () => {
  // Not a wall-clock assertion — that is machine-dependent. The property is
  // that N edits produce exactly one output document and one verified round
  // trip, which is what makes the batch cheap.
  const steps = [];
  for (const p of [3, 6, 9, 12, 15, 18]) {
    steps.push({ op: "apply_para_format", section: 0, para: p, props: { alignment: "center" } });
  }
  const r = runPlan({ order: "descending", steps }, "many.hwp");
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.applied.length, 6);
  assert.equal(j.confirmed, 6, "one pass, six confirmations");

  const back = await loadDocument(at("many.hwp"));
  for (const p of [3, 6, 9, 12, 15, 18]) {
    assert.equal(JSON.parse(back.getParaPropertiesAt(0, p)).alignment, "center", `paragraph ${p}`);
  }
});

test("plan: building from blank still works and is labelled as such", () => {
  const planPath = at("build.json");
  writeFileSync(
    planPath,
    JSON.stringify({ steps: [{ op: "insert_text", section: 0, para: 0, char: 0, text: "새 문서입니다" }] }),
  );
  const r = spawnSync(
    process.execPath,
    [join("src", "core", "create.mjs"), "--plan", planPath, "--output", at("built.hwp")],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.mode, "build");
  assert.equal(j.verified, true);
});
