#!/usr/bin/env node
// Re-record the golden baseline: node test/golden/record.mjs
//
// This is NOT part of `npm test`. Running it is a deliberate act that says
// "the behavior change in the diff is intended" — so always read the diff
// before committing. A refactor that is supposed to be observably inert must
// NOT need this script at all.
//
// Every case is run TWICE and the two runs must agree; a case whose output
// wobbles between runs is refused rather than baked into the baseline (a
// nondeterministic golden is worse than none — it teaches the suite to be
// ignored).

import { writeFileSync } from "node:fs";
import { CASES } from "./cases.mjs";
import { GOLDEN_PATH, encodeStream, runCase } from "./runner.mjs";

const entries = {};
let refused = 0;

for (const c of CASES) {
  const a = runCase(c);
  const b = runCase(c);
  if (a.status !== b.status || a.stdout !== b.stdout || a.stderr !== b.stderr) {
    process.stderr.write(`REFUSED (nondeterministic): ${c.name}\n`);
    refused++;
    continue;
  }
  entries[c.name] = {
    script: c.script,
    argv: c.argv,
    status: a.status,
    stdout: encodeStream(a.stdout),
    stderr: encodeStream(a.stderr),
  };
  process.stderr.write(`recorded ${c.name} (exit ${a.status})\n`);
}

if (refused) {
  process.stderr.write(`\n${refused} case(s) refused — fix the nondeterminism, then re-record.\n`);
  process.exit(1);
}

writeFileSync(GOLDEN_PATH, JSON.stringify({ cases: entries }, null, 2) + "\n");
process.stderr.write(`\nwrote ${Object.keys(entries).length} cases to ${GOLDEN_PATH}\n`);
