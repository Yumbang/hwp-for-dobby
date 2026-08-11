#!/usr/bin/env node
// Measure what the skill's commands actually cost.
//
//   node scripts/bench.mjs                    # the committed fixtures
//   node scripts/bench.mjs --corpus ~/Downloads   # …plus real documents
//   node scripts/bench.mjs --json
//
// WHY THIS EXISTS. This repo's rule is that a claim comes with evidence, and
// "we made it faster" is a claim. The section work is built on four
// performance decisions — a text-only first pass, lazy paragraph properties,
// lazy control classification, and a content-addressed cache — and each of
// them is a bet that a particular cost dominates. A bet nobody re-measures is
// a bet that quietly stops paying: an engine bump, or one careless props()
// call inside a loop, turns the fast path back into the slow one with no test
// going red. This prints the numbers so the next person can check.
//
// Reported per command: wall clock, and the ENGINE CALL COUNT, which is the
// number that actually matters. Wall clock varies with the machine; engine
// calls are a property of the code and are what a regression moves.
//
// Nothing here runs under `npm test` — it is a measuring tool, not a gate.
// (`test/spec/inline.test.mjs` asserts the per-paragraph call budget, which is
// the part that must not silently regress.)

import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join } from "node:path";
import { clearCache } from "../src/lib/cache.mjs";
import { buildBlocks } from "../src/lib/blocks.mjs";
import { detectHeadings } from "../src/lib/headings.mjs";
import { loadDocument } from "../src/lib/_bootstrap.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const asJson = process.argv.includes("--json");
const corpusIdx = process.argv.indexOf("--corpus");
const corpusDir = corpusIdx >= 0 ? process.argv[corpusIdx + 1] : process.env.HWP_CORPUS_DIR || null;

const FIXTURES = [
  "samples/fixture-table.hwp",
  "samples/fixture-table.hwpx",
  "samples/fixture-headings.hwp",
  "samples/fixture-clause.hwp",
  "samples/fixture-table-only.hwp",
  "samples/fixture-inline.hwp",
  "samples/fixture-form.hwp",
];

function ms(fn) {
  const t0 = process.hrtime.bigint();
  const value = fn();
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, value };
}

function runCli(args) {
  return ms(() =>
    spawnSync(process.execPath, args, {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    }),
  );
}

// ── in-process: the engine-call budget ────────────────────────────────────
// Spawning a process measures node startup as much as anything else, so the
// call counts are gathered in-process where model.stats is visible.
async function modelCost(path) {
  const doc = await loadDocument(path);
  const t0 = process.hrtime.bigint();
  const model = await buildBlocks(doc, {});
  const buildMs = Number(process.hrtime.bigint() - t0) / 1e6;

  const afterBuild = model.stats.engineCalls;
  const t1 = process.hrtime.bigint();
  const det = detectHeadings(model.blocks, {});
  const detectMs = Number(process.hrtime.bigint() - t1) / 1e6;
  const afterDetect = model.stats.engineCalls;

  // A second buildBlocks on the same document must be free (WeakMap memo).
  const t2 = process.hrtime.bigint();
  await buildBlocks(doc, {});
  const secondMs = Number(process.hrtime.bigint() - t2) / 1e6;
  const afterSecond = model.stats.engineCalls;

  return {
    paragraphs: model.stats.paragraphs,
    blocks: model.blocks.length,
    buildCalls: afterBuild,
    callsPerParagraph: model.stats.paragraphs ? afterBuild / model.stats.paragraphs : 0,
    detectCalls: afterDetect - afterBuild,
    propsProbed: det.detection.propsProbed,
    candidates: det.detection.candidateCount,
    memoCalls: afterSecond - afterDetect, // must be 0
    buildMs,
    detectMs,
    secondBuildMs: secondMs,
    strategy: det.strategy,
    headings: det.nodes.length,
  };
}

// ── the report ────────────────────────────────────────────────────────────

const rows = [];

for (const rel of FIXTURES) {
  const path = join(ROOT, rel);
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    continue;
  }
  const cost = await modelCost(path);

  clearCache();
  const cold = runCli([join(ROOT, "src", "core", "sections.mjs"), rel, "--op", "outline"]);
  const warm = runCli([join(ROOT, "src", "core", "sections.mjs"), rel, "--op", "outline"]);
  const read = runCli([join(ROOT, "src", "core", "read.mjs"), rel]);
  const tables = runCli([join(ROOT, "src", "core", "extract_tables.mjs"), rel]);

  rows.push({
    doc: rel.replace(/^samples\//, ""),
    sizeKB: Math.round(size / 1024),
    ...cost,
    outlineColdMs: cold.ms,
    outlineWarmMs: warm.ms,
    cacheSpeedup: warm.ms > 0 ? cold.ms / warm.ms : 0,
    readMs: read.ms,
    tablesMs: tables.ms,
  });
}

// Real documents, if the caller pointed at some. Names are never printed —
// see test/spec/corpus.test.mjs for why the corpus stays anonymous.
if (corpusDir) {
  let files = [];
  try {
    files = readdirSync(corpusDir)
      .filter((f) => [".hwp", ".hwpx"].includes(extname(f).toLowerCase()))
      .map((f) => join(corpusDir, f))
      .slice(0, 40);
  } catch (e) {
    process.stderr.write(`corpus unreadable: ${e?.message ?? e}\n`);
  }
  for (const [i, path] of files.entries()) {
    try {
      const cost = await modelCost(path);
      clearCache();
      const cold = runCli([join(ROOT, "src", "core", "sections.mjs"), path, "--op", "outline"]);
      const warm = runCli([join(ROOT, "src", "core", "sections.mjs"), path, "--op", "outline"]);
      rows.push({
        doc: `corpus#${String(i).padStart(2, "0")}`,
        sizeKB: Math.round(statSync(path).size / 1024),
        ...cost,
        outlineColdMs: cold.ms,
        outlineWarmMs: warm.ms,
        cacheSpeedup: warm.ms > 0 ? cold.ms / warm.ms : 0,
        readMs: 0,
        tablesMs: 0,
      });
    } catch (e) {
      process.stderr.write(`corpus#${i}: ${String(e?.message ?? e).slice(0, 80)}\n`);
    }
  }
}

if (asJson) {
  process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
} else {
  const n = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : "—");
  const pad = (s, w) => String(s).padEnd(w);
  const padL = (s, w) => String(s).padStart(w);
  process.stdout.write(
    `${pad("document", 24)} ${padL("KB", 5)} ${padL("paras", 6)} ${padL("calls", 7)} ` +
      `${padL("c/para", 7)} ${padL("props", 6)} ${padL("build", 8)} ${padL("detect", 7)} ` +
      `${padL("cold", 8)} ${padL("warm", 8)} ${padL("×", 5)}  strategy\n`,
  );
  process.stdout.write("-".repeat(120) + "\n");
  for (const r of rows) {
    process.stdout.write(
      `${pad(r.doc, 24)} ${padL(r.sizeKB, 5)} ${padL(r.paragraphs, 6)} ${padL(r.buildCalls, 7)} ` +
        `${padL(n(r.callsPerParagraph, 2), 7)} ${padL(`${r.propsProbed}/${r.blocks}`, 6)} ` +
        `${padL(n(r.buildMs), 8)} ${padL(n(r.detectMs), 7)} ${padL(n(r.outlineColdMs, 0), 8)} ` +
        `${padL(n(r.outlineWarmMs, 0), 8)} ${padL(n(r.cacheSpeedup, 1), 5)}  ${r.strategy} (${r.headings})\n`,
    );
  }
  const bad = rows.filter((r) => r.memoCalls !== 0);
  process.stdout.write("\n");
  process.stdout.write(
    bad.length
      ? `WARNING: the per-document memo leaked on ${bad.length} document(s) — a second buildBlocks cost engine calls.\n`
      : `memoization: a second buildBlocks() cost 0 extra engine calls on all ${rows.length} document(s).\n`,
  );
  process.stdout.write(
    "columns: calls = engine calls to build the block model; c/para = per paragraph;\n" +
      "         props = blocks whose properties were actually read / total blocks;\n" +
      "         cold/warm = `--op outline` wall clock in ms, without and with the model cache.\n",
  );
}
