// Golden replay — the observable surface of read.mjs / extract_tables.mjs.
//
// Recorded before the src/lib/ extraction (argv / doc_walk / tables / render_md
// / hwp5) so the refactor has to PROVE it changed nothing. Three properties are
// asserted per case:
//
//   1. exit status matches the baseline,
//   2. stdout and stderr match the baseline (verbatim, or by sha256 for the
//      large SVG/JSON streams — see runner.mjs),
//   3. DETERMINISM: the same argv run twice in the same test produces the same
//      three streams. A script that leaks a clock, a PID or a tmpdir path into
//      its output would pass (1) and (2) by luck; (3) is what catches it.
//
// Intentional behavior changes are recorded with `node test/golden/record.mjs`
// and reviewed as a diff. Nothing else should ever make this file red.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CASES } from "./cases.mjs";
import { GOLDEN_PATH, diffStream, runCase } from "./runner.mjs";

const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")).cases;

test("golden: every case in cases.mjs has a recorded baseline", () => {
  const missing = CASES.filter((c) => !golden[c.name]).map((c) => c.name);
  assert.deepEqual(
    missing,
    [],
    `no baseline for: ${missing.join(", ")} — run: node test/golden/record.mjs`,
  );
});

test("golden: the baseline has no orphan cases", () => {
  const live = new Set(CASES.map((c) => c.name));
  const orphans = Object.keys(golden).filter((n) => !live.has(n));
  assert.deepEqual(
    orphans,
    [],
    `golden.json records cases that cases.mjs no longer defines: ${orphans.join(", ")}`,
  );
});

for (const c of CASES) {
  test(`golden: ${c.name}`, () => {
    const g = golden[c.name];
    assert.ok(g, `missing baseline for ${c.name}`);
    // The baseline records the argv it was recorded with; a silently edited
    // case name would otherwise compare against the wrong recording.
    assert.deepEqual(
      { script: c.script, argv: c.argv },
      { script: g.script, argv: g.argv },
      `${c.name}: argv drifted from the recording — re-record after reviewing`,
    );

    const first = runCase(c);
    const second = runCase(c);

    // (3) determinism, in-test.
    assert.equal(second.status, first.status, `${c.name}: exit status is nondeterministic`);
    assert.equal(second.stdout, first.stdout, `${c.name}: stdout is nondeterministic`);
    assert.equal(second.stderr, first.stderr, `${c.name}: stderr is nondeterministic`);

    // (1) exit status.
    assert.equal(
      first.status,
      g.status,
      `${c.name}: exit status ${first.status} != recorded ${g.status}\nstderr:\n${first.stderr}`,
    );

    // (2) streams.
    const outDiff = diffStream(`${c.name} stdout`, g.stdout, first.stdout);
    assert.equal(outDiff, null, outDiff ?? "");
    const errDiff = diffStream(`${c.name} stderr`, g.stderr, first.stderr);
    assert.equal(errDiff, null, errDiff ?? "");
  });
}
