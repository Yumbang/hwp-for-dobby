#!/usr/bin/env node
// Usage:
//   node src/core/sections.mjs <input.hwp|.hwpx> --op outline
//   node src/core/sections.mjs <input.hwp|.hwpx> --op extract  --id <id|ref>
//   node src/core/sections.mjs <input.hwp|.hwpx> --op split    --out-dir <dir>
//   node src/core/sections.mjs <input.hwp|.hwpx> --op snapshot
//   node src/core/sections.mjs <input.hwp|.hwpx> --op diff
//
//   [--detect auto|regex|style|clause|marker|table|none] [--heading-regex <re>]
//   [--marker-level '<json>'] [--max-level N] [--table-mode body|cells]
//   [--format text|json|markdown] [--level N] [--own-text] [--equations raw|latex]
//   [--snapshot-dir <dir>] [--no-update] [--no-cache]
//
// Reads a document as a STRUCTURE instead of a wall of text: pull out §4.3 of a
// 40-page report, hand one section at a time to a subagent, or find out what a
// co-author changed since last week.
//
// CORE TIER — WASM ONLY. Runs in-process through the vendored @rhwp/core bundle
// and behaves identically on claude.ai / cowork / code. Never shells out.
//
// ── WHY THE ENGINE'S OWN getStructure IS NOT USED ─────────────────────────
//
// The engine has a structure API. It is built for 조문 (statute) documents and
// is wrong for everything else: it flattens the hierarchy into a level-7 plane
// (4.1 does not nest under 4), reads date lines ("1953. 10. 20. 제정") and
// table-of-contents lines ("1. 사업 개요\t 2") as headings, and drops tables
// and equations from its body entirely. On 9 real documents, 6 returned ZERO
// nodes in outline mode. So detection is ours (lib/headings.mjs), and the
// detection report below includes an agreement rate against getStructure so the
// disagreement stays visible rather than assumed.
//
// ── HONESTY ───────────────────────────────────────────────────────────────
//
// Every op writes a `detection:` block to stderr — which strategy won, what the
// ladder rejected and why, how many candidates each filter killed, the learned
// marker→level map, and a confidence grade. Structure inference is a guess; a
// guess presented as a fact is how an agent silently extracts the wrong
// section. When confidence is low the warning is loud and says to eyeball
// `--op outline` first.
//
// Exit codes (lib/exit-codes.mjs): 0 OK, 1 LOAD, 2 USAGE (including a snapshot
// comparison the meta gate refuses), 3 NOT_FOUND (--id absent, or no structure
// could be detected at all).

import { ensureInit, loadDocument, version } from "../lib/_bootstrap.mjs";
import { enumArg, flag, inputPath, intArg, strArg } from "../lib/argv.mjs";
import { buildBlocks } from "../lib/blocks.mjs";
import { cacheKey, readCache, writeCache } from "../lib/cache.mjs";
import { EXIT, fail } from "../lib/exit-codes.mjs";
import { createHash } from "node:crypto";
import { detectHeadings } from "../lib/headings.mjs";
import { collectObjects } from "../lib/objects.mjs";
import { detectMemos } from "../lib/memo.mjs";
import {
  NO_CHANGES_LINE,
  buildBaseline,
  diffBaselines,
  hasChanges,
  readBaseline,
  writeBaseline,
} from "../lib/snapshot.mjs";
import { detectTrackChanges } from "../lib/trackchange.mjs";
import { mkdirSync, createWriteStream } from "node:fs";
import { join } from "node:path";

const USAGE =
  "usage: sections.mjs <input.hwp|.hwpx> --op outline|extract|split|snapshot|diff\n" +
  "       [--id <id|ref>] [--out-dir <dir>] [--detect auto|regex|style|clause|marker|table|none]\n" +
  "       [--heading-regex <re>] [--marker-level '<json>'] [--max-level N]\n" +
  "       [--table-mode body|cells] [--format text|json|markdown] [--level N]\n" +
  "       [--own-text] [--equations raw|latex] [--snapshot-dir <dir>] [--no-update] [--no-cache]";

const input = inputPath(USAGE);
const op = enumArg("--op", ["outline", "extract", "split", "snapshot", "diff"], null);
if (!op) fail(EXIT.USAGE, `error: --op is required\n${USAGE}`);

const detect = enumArg(
  "--detect",
  ["auto", "regex", "style", "clause", "marker", "table", "none"],
  "auto",
);
const headingRegex = strArg("--heading-regex", null);
const markerLevelRaw = strArg("--marker-level", null);
const maxLevel = intArg("--max-level", 4);
const tableMode = enumArg("--table-mode", ["body", "cells"], "body");
const format = enumArg("--format", ["text", "json", "markdown"], "text");
const equations = enumArg("--equations", ["raw", "latex"], "raw");
const wantId = strArg("--id", null);
const outDir = strArg("--out-dir", null);
const snapshotDirArg = strArg("--snapshot-dir", null);
const levelCap = intArg("--level", 0); // 0 = no cap
const ownTextOnly = flag("--own-text");
const noUpdate = flag("--no-update");
const useCache = !flag("--no-cache");

if (detect === "regex" && !headingRegex) {
  fail(EXIT.USAGE, "error: --detect regex requires --heading-regex '<pattern>'");
}
if (op === "extract" && !wantId) fail(EXIT.USAGE, "error: --op extract requires --id <id|ref>");
if (op === "split" && !outDir) fail(EXIT.USAGE, "error: --op split requires --out-dir <dir>");
if (maxLevel < 1) fail(EXIT.USAGE, "error: --max-level must be >= 1");

let markerLevel = null;
if (markerLevelRaw !== null) {
  try {
    markerLevel = JSON.parse(markerLevelRaw);
  } catch (e) {
    fail(EXIT.USAGE, `error: --marker-level is not valid JSON: ${e?.message ?? e}`);
  }
  if (markerLevel === null || typeof markerLevel !== "object" || Array.isArray(markerLevel)) {
    fail(EXIT.USAGE, `error: --marker-level must be a JSON object, e.g. '{"BOX":1,"CIRCLE":2}'`);
  }
}

// Options that change the MODEL, and therefore the cache key. Anything omitted
// here is a cache that can serve the wrong answer, so keep this exhaustive.
const modelOpts = { detect, headingRegex, markerLevel, maxLevel, tableMode };

// ── load + detect ─────────────────────────────────────────────────────────

async function loadOrExit(path) {
  try {
    return await loadDocument(path);
  } catch (e) {
    fail(EXIT.LOAD, `error: cannot read ${path}: ${e?.message ?? e}`);
  }
}

// version() reads the WASM module, so the bundle has to be initialized before
// the cache key can name the engine it was built with.
await ensureInit();

let key = null;
try {
  key = cacheKey({ inputPath: input, engineVersion: version(), opts: modelOpts });
} catch (e) {
  fail(EXIT.LOAD, `error: cannot read ${input}: ${e?.message ?? e}`);
}

// `outline` and `snapshot` need only the tree, so a cache hit skips loading the
// document entirely. `extract` and `split` still have to open it — rendering a
// section needs the live table/equation data — but they skip re-detection.
// The key is the file's sha256, so an edited document is a different key and a
// stale entry is unaddressable rather than merely unlikely (lib/cache.mjs).
const cached = readCache(key, { enabled: useCache });

let model = null; // block model; null while a cache hit is still sufficient
let detection;
let nodes;
let tree;
let blocks;

async function ensureModel() {
  if (model) return model;
  const doc = await loadOrExit(input);
  model = await buildBlocks(doc, { tableMode, equations: true, footnotes: true });
  return model;
}

if (cached) {
  ({ detection, nodes, tree, blocks } = cached);
} else {
  const m = await ensureModel();
  const result = detectHeadings(m.blocks, { detect, headingRegex, markerLevel, maxLevel });
  detection = result.detection;
  nodes = result.nodes;
  tree = result.tree;
  blocks = m.blocks.map((b) => ({
    s: b.s,
    p: b.p,
    index: b.index,
    text: b.text,
    hasTable: b.hasTable,
    tableIndices: b.tableIndices,
  }));
  // Computed here, while the document is open, and carried in the cache — so a
  // cached run still reports the second opinion instead of going quiet about it.
  detection.structureAgreement = structureAgreement(m.doc);
  detection.sourceFormat = m.doc.getSourceFormat();
  writeCache(key, { detection, nodes, tree, blocks }, { enabled: useCache });
}

// ── the honesty block ─────────────────────────────────────────────────────

function reportDetection() {
  const d = detection;
  const L = [];
  L.push(`detection: strategy=${d.strategy} confidence=${d.confidence}`);
  L.push(
    `  blocks=${d.blockCount} non-empty=${d.nonEmptyCount} tables=${d.tableCount} ` +
      `candidates=${d.candidateCount} headings=${nodes.length} props-probed=${d.propsProbed}`,
  );
  for (const rank of d.ladder ?? []) {
    L.push(`  ladder ${rank.rank} ${rank.strategy}: ${rank.chosen ? "CHOSEN" : "rejected"} — ${rank.why}`);
  }
  const firedFilters = (d.filters ?? []).filter((f) => f.rejected > 0);
  if (firedFilters.length) {
    L.push(`  filters: ${firedFilters.map((f) => `${f.id}=${f.rejected}`).join(" ")}`);
  }
  if (d.classes?.length) {
    // surviving/raw shows what the filters removed BEFORE purity was scored,
    // which is the number that decides whether a class becomes a level at all.
    // The adopt/reject verdict is the MARKER learner's, so it is only shown
    // when the marker strategy is the one that won — otherwise the histogram is
    // background evidence, not the decision that was taken.
    const isMarker = d.strategy === "marker";
    L.push(
      `  classes: ${d.classes
        .map((c) => {
          const stat = `${c.class}(${c.surviving}/${c.raw} short=${c.short} purity=${Number(c.purity ?? 0).toFixed(2)}`;
          return isMarker ? `${stat} ${c.adopted ? "ADOPTED" : `not adopted: ${c.verdict}`})` : `${stat})`;
        })
        .join("\n           ")}`,
    );
  }
  if (d.levels && Object.keys(d.levels).length) {
    L.push(`  levels: ${Object.entries(d.levels).map(([k, v]) => `${k}→${v}`).join(" ")}`);
  }
  if (d.dropped?.length) L.push(`  dropped (beyond --max-level ${maxLevel}): ${d.dropped.join(" ")}`);
  L.push(`  engine getStructure agreement: ${d.structureAgreement ?? "not probed"}`);
  process.stderr.write(L.join("\n") + "\n");

  if (d.confidence === "low") {
    process.stderr.write(
      "WARNING: structure detection confidence is LOW" +
        (d.lowConfidenceReasons?.length ? ` (${d.lowConfidenceReasons.join("; ")})` : "") +
        ".\n" +
        "         The heading tree below is a GUESS about a document that carries no\n" +
        "         outline metadata. Check it with --op outline before trusting an\n" +
        "         --op extract, and override with --detect regex --heading-regex '<re>'\n" +
        "         or --marker-level '<json>' if it is wrong.\n",
    );
  }
}

// How much of our tree the engine's own structure API agrees with. Reported,
// never used: getStructure is 조문-only and returned zero nodes on 6 of 9 real
// documents, so it is a second opinion worth showing and a poor source of
// truth. One engine call, computed once and cached with the tree.
function structureAgreement(doc) {
  try {
    const raw = JSON.parse(doc.getStructure("outline"));
    const engineTitles = new Set(
      collectTitles(raw).map((t) => String(t).replace(/\s+/g, " ").trim()),
    );
    if (engineTitles.size === 0) return "engine reported 0 nodes";
    const ours = nodes.map((n) => n.title.replace(/\s+/g, " ").trim());
    const hit = ours.filter((t) => engineTitles.has(t)).length;
    return `${hit}/${ours.length} of our headings (engine reported ${engineTitles.size})`;
  } catch (e) {
    return `unavailable (${String(e?.message ?? e).slice(0, 60)})`;
  }
}

function collectTitles(v, out = []) {
  if (Array.isArray(v)) for (const x of v) collectTitles(x, out);
  else if (v && typeof v === "object") {
    if (typeof v.title === "string") out.push(v.title);
    if (typeof v.text === "string" && !v.title) out.push(v.text);
    for (const k of Object.keys(v)) if (typeof v[k] === "object") collectTitles(v[k], out);
  }
  return out;
}

// ── spans ─────────────────────────────────────────────────────────────────

// The block range a node owns. `withChildren` runs to the next heading at the
// SAME OR SHALLOWER level (the whole subtree); otherwise to the very next
// heading of any level (own text only). Own text is what snapshots store — a
// subtree span would report one edited sentence as a change in every ancestor.
function spanOf(nodeIndex, withChildren) {
  const n = nodes[nodeIndex];
  const start = n.blockIndex;
  let end = blocks.length - 1;
  for (let i = nodeIndex + 1; i < nodes.length; i++) {
    const m = nodes[i];
    if (withChildren ? m.level <= n.level : true) {
      end = Math.max(start, m.blockIndex - 1);
      break;
    }
  }
  return { start, end };
}

function breadcrumb(nodeIndex) {
  const n = nodes[nodeIndex];
  const trail = [];
  let level = n.level;
  for (let i = nodeIndex - 1; i >= 0 && level > 1; i--) {
    if (nodes[i].level < level) {
      trail.unshift(nodes[i].title);
      level = nodes[i].level;
    }
  }
  trail.push(n.title);
  return trail.join(" › ");
}

// The BODY of a node: its span with the heading line itself removed, because
// every caller prints the title separately and would otherwise show it twice.
// Two shapes to strip:
//   standalone heading — the first block IS the title, so start one block later
//   inline clause      — "제1조(목적) 이 규정은 …" shares one block, so drop the
//                        title prefix and keep the rest
async function renderNode(nodeIndex, withChildren) {
  const m = await ensureModel();
  const { start, end } = spanOf(nodeIndex, withChildren);
  const n = nodes[nodeIndex];

  if (n.headEnd > 0) {
    const text = m.renderSpan(start, end, { equations, tableMode });
    return text.startsWith(n.title) ? text.slice(n.title.length).trimStart() : text;
  }
  if (start >= end) return ""; // a heading with no body of its own
  return m.renderSpan(start + 1, end, { equations, tableMode });
}

function findNode(id) {
  const byRef = nodes.findIndex((n) => n.ref === id);
  if (byRef >= 0) return byRef;
  const byId = nodes.findIndex((n) => n.id === id);
  if (byId >= 0) return byId;
  const norm = (s) => String(s).replace(/\s+/g, " ").trim();
  return nodes.findIndex((n) => norm(n.title) === norm(id));
}

// Structure could not be found at all: say what WAS seen rather than printing
// an empty tree, which reads as "this document has no sections".
function failNoStructure() {
  reportDetection();
  const hist = (detection.classes ?? [])
    .map((c) => `  ${c.class}: ${c.count} line(s), purity ${Number(c.purity ?? 0).toFixed(2)}`)
    .join("\n");
  fail(
    EXIT.NOT_FOUND,
    `error: no section structure could be detected in ${input}.\n` +
      (hist ? `marker classes seen:\n${hist}\n` : "no marker-like lines were found at all.\n") +
      `       • see the raw text:      node src/core/read.mjs "${input}"\n` +
      `       • force a pattern:       --detect regex --heading-regex '<pattern>'\n` +
      `       • force marker levels:   --marker-level '{"BOX":1,"CIRCLE":2}'`,
  );
}

// ── ops ───────────────────────────────────────────────────────────────────

if (op === "outline") {
  reportDetection();
  if (!nodes.length) failNoStructure();
  if (format === "json") {
    process.stdout.write(JSON.stringify({ input, strategy: detection.strategy, tree }, null, 2) + "\n");
  } else {
    for (const [i, n] of nodes.entries()) {
      if (levelCap && n.level > levelCap) continue;
      const indent = "  ".repeat(Math.max(0, n.level - 1));
      const ref = n.ref ? `  [${n.ref}]` : "";
      const span = spanOf(i, true);
      const blockN = span.end - span.start + 1;
      process.stdout.write(`${indent}${n.id}  ${n.title}${ref}  (${blockN} block(s))\n`);
    }
  }
  process.exit(EXIT.OK);
}

if (op === "extract") {
  reportDetection();
  if (!nodes.length) failNoStructure();
  const i = findNode(wantId);
  if (i < 0) {
    const near = nodes.slice(0, 12).map((n) => `${n.id}${n.ref ? ` (${n.ref})` : ""}`).join(", ");
    fail(
      EXIT.NOT_FOUND,
      `error: no section "${wantId}" in ${input}.\n` +
        `       available ids include: ${near}${nodes.length > 12 ? ", …" : ""}\n` +
        `       list them all: node src/core/sections.mjs "${input}" --op outline`,
    );
  }
  const withChildren = !ownTextOnly;
  const text = await renderNode(i, withChildren);
  const n = nodes[i];
  if (format === "json") {
    process.stdout.write(
      JSON.stringify(
        { input, id: n.id, ref: n.ref, title: n.title, level: n.level, breadcrumb: breadcrumb(i), text },
        null,
        2,
      ) + "\n",
    );
  } else {
    // A self-contained chunk: the breadcrumb is what lets a subagent read one
    // section without mistaking where it sits in the document.
    process.stdout.write(`# ${n.title}\n`);
    process.stdout.write(`<!-- ${breadcrumb(i)} — ${input} -->\n\n`);
    process.stdout.write(text.replace(/\s+$/, "") + "\n");
  }
  process.exit(EXIT.OK);
}

if (op === "split") {
  reportDetection();
  if (!nodes.length) failNoStructure();
  mkdirSync(outDir, { recursive: true });
  const topLevel = Math.min(...nodes.map((n) => n.level));
  const targets = nodes
    .map((n, i) => ({ n, i }))
    .filter(({ n }) => n.level === topLevel || (levelCap && n.level <= levelCap));
  let written = 0;
  for (const { n, i } of targets) {
    const name = `${String(written).padStart(3, "0")}-${slug(n.ref || n.id)}-${slug(n.title)}.md`;
    const path = join(outDir, name);
    // Stream: a 40-page document split into 30 chunks should never hold all 30
    // rendered chunks in memory at once.
    const out = createWriteStream(path, { encoding: "utf8" });
    out.write(`# ${n.title}\n`);
    out.write(`<!-- ${breadcrumb(i)} — ${input} -->\n\n`);
    out.write((await renderNode(i, true)).replace(/\s+$/, "") + "\n");
    await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));
    process.stdout.write(`${path}\n`);
    written++;
  }
  process.stderr.write(`wrote ${written} section file(s) to ${outDir}\n`);
  process.exit(EXIT.OK);
}

// ── snapshot / diff ───────────────────────────────────────────────────────

function currentMeta() {
  let memos = { count: 0, digest: "" };
  try {
    const info = detectMemos(input);
    memos = { count: info.count, digest: `${info.format}:${info.count}` };
  } catch {}
  let track = { supported: false, has: false };
  try {
    const tc = detectTrackChanges(input);
    track = { supported: tc.supported, has: tc.hasTrackChanges };
  } catch {}
  return {
    sourceFormat: model?.doc?.getSourceFormat?.() ?? cached?.detection?.sourceFormat ?? "unknown",
    tableMode,
    detect,
    headingRegex,
    strategy: detection.strategy,
    levels: detection.levels ?? {},
    engineVersion: version(),
    memos,
    trackChange: track,
  };
}

// Per-node image digests, so a swapped figure is a change even though the
// section's TEXT is byte-identical (the picture marker describes the frame,
// which a replacement preserves on purpose). Reading the bytes measured 12.8 ms
// for 10 MB across 13 pictures, so it is affordable at snapshot time — and it
// is paid ONLY here, never on an ordinary read.
async function imageDigestsByNode() {
  const m = await ensureModel();
  const byNode = {};
  let all = [];
  try {
    const collected = await collectObjects(m.doc, { geometry: "never" });
    all = [...collected.objects, ...collected.overlays].filter((o) => o.kind === "image");
  } catch {
    return byNode; // no digests is "not collected", which compares equal to absent
  }
  if (!all.length) return byNode;

  for (const [i, n] of nodes.entries()) {
    const { start, end } = spanOf(i, false);
    const from = blocks[start] ? blocks[start].p : -1;
    const to = blocks[end] ? blocks[end].p : -1;
    const mine = all.filter((o) => o.paragraph >= from && o.paragraph <= to);
    if (!mine.length) continue;
    byNode[n.id] = mine.map((o) => {
      try {
        const bytes = m.doc.getControlImageData(o.section, o.paragraph, "", o.controlIndex);
        return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
      } catch {
        return "unreadable";
      }
    });
  }
  return byNode;
}

async function currentBaseline() {
  await ensureModel(); // sourceFormat and own-text rendering both need the document
  const ownText = {};
  for (let i = 0; i < nodes.length; i++) {
    ownText[nodes[i].id] = await renderNode(i, false);
  }
  const objects = await imageDigestsByNode();
  return buildBaseline({ nodes: tree, ownText, objects, meta: currentMeta() });
}

if (op === "snapshot") {
  reportDetection();
  if (!nodes.length) failNoStructure();
  const baseline = await currentBaseline();
  const res = writeBaseline(input, baseline, { dir: snapshotDirArg });
  process.stdout.write(`baseline: ${res.path}\n`);
  process.stdout.write(`${nodes.length} section(s) recorded\n`);
  process.exit(EXIT.OK);
}

if (op === "diff") {
  reportDetection();
  if (!nodes.length) failNoStructure();
  const previous = readBaseline(input, { dir: snapshotDirArg });
  const baseline = await currentBaseline();
  const d = diffBaselines(previous, baseline);

  // The meta gate. A rejected comparison is never shown: the same document read
  // as .hwp and as .hwpx diffs as ~100% changed, and presenting that as a
  // result would be a confident lie.
  if (d.safety.reject.length) {
    fail(
      EXIT.USAGE,
      `error: this baseline is not comparable with the current run —\n` +
        d.safety.reject.map((r) => `       • ${r}`).join("\n") +
        `\n       re-create it: node src/core/sections.mjs "${input}" --op snapshot`,
    );
  }
  for (const w of d.safety.warn) process.stderr.write(`WARNING: ${w}\n`);

  if (d.firstRun) {
    const res = writeBaseline(input, baseline, { dir: snapshotDirArg });
    process.stdout.write(`baseline created: ${res.path}\n`);
    process.stdout.write(`${nodes.length} section(s) recorded — nothing to compare against yet.\n`);
    process.exit(EXIT.OK); // a missing baseline is not an error
  }

  if (!hasChanges(d)) {
    process.stdout.write(NO_CHANGES_LINE + "\n");
    process.exit(EXIT.OK); // baseline left alone: nothing moved
  }

  if (format === "json") {
    process.stdout.write(JSON.stringify(d, null, 2) + "\n");
  } else {
    for (const n of d.added) process.stdout.write(`+ ${n.id}  ${n.title}\n`);
    for (const n of d.removed) process.stdout.write(`- ${n.id}  ${n.title}\n`);
    for (const n of d.moved) process.stdout.write(`~ ${n.id}  ${n.title}  (moved)\n`);
    for (const n of d.changed) {
      process.stdout.write(`M ${n.id}  ${n.title}\n`);
      if (n.diff) process.stdout.write(`    ${n.diff.split("\n").join("\n    ")}\n`);
    }
    process.stdout.write(
      `\n${d.added.length} added, ${d.removed.length} removed, ${d.changed.length} changed, ` +
        `${d.moved.length} moved, ${d.unchanged.length} unchanged\n`,
    );
  }

  // Re-baseline so "diff" means "since the last diff" rather than "since the
  // first snapshot ever taken". --no-update opts out.
  const res = writeBaseline(input, baseline, { dir: snapshotDirArg, update: !noUpdate });
  process.stderr.write(
    res.written ? `baseline updated: ${res.path}\n` : `baseline left unchanged (--no-update)\n`,
  );
  process.exit(EXIT.OK);
}

function slug(s) {
  return String(s)
    .replace(/\s+/g, "-")
    .replace(/[/\\:*?"<>|]/g, "")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 40) || "section";
}
