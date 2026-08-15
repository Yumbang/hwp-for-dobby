// Compare the current document against the last-read section snapshot, then
// write a new baseline so the next read means "since I last looked".
//
// Used by read.mjs (default on) and kept engine-thin: snapshot.mjs still owns
// serialize / match / the meta gate. This file only builds a baseline from a
// live document and turns the diff into a short stderr report.
//
// A read MUST NOT fail because a snapshot could not be taken. Callers wrap
// reportReadSnapshot() and treat every throw as a non-fatal stderr note.
// Documents with no detectable structure skip rather than invent a tree
// (same honesty as sections.mjs --op outline exiting 3).

import { version } from "./_bootstrap.mjs";
import { buildBlocks } from "./blocks.mjs";
import { detectHeadings } from "./headings.mjs";
import { detectMemos } from "./memo.mjs";
import {
  NO_CHANGES_LINE,
  buildBaseline,
  diffBaselines,
  hasChanges,
  readBaseline,
  writeBaseline,
} from "./snapshot.mjs";
import { detectTrackChanges } from "./trackchange.mjs";

// Defaults match sections.mjs snapshot/diff so a later `--op diff` is
// comparable with a baseline that a plain read just wrote.
const DETECT_DEFAULTS = Object.freeze({
  detect: "auto",
  headingRegex: null,
  markerLevel: null,
  maxLevel: 4,
  tableMode: "body",
  equations: "raw",
});

function spanOf(nodes, blocks, nodeIndex, withChildren) {
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

function renderOwnText(model, nodes, nodeIndex, { equations, tableMode }) {
  const { start, end } = spanOf(nodes, model.blocks, nodeIndex, false);
  const n = nodes[nodeIndex];
  if (n.headEnd > 0) {
    const text = model.renderSpan(start, end, { equations, tableMode });
    return text.startsWith(n.title) ? text.slice(n.title.length).trimStart() : text;
  }
  if (start >= end) return "";
  return model.renderSpan(start + 1, end, { equations, tableMode });
}

function currentMeta(inputPath, doc, detection, opts) {
  let memos = { count: 0, digest: "" };
  try {
    const info = detectMemos(inputPath);
    memos = { count: info.count, digest: `${info.format}:${info.count}` };
  } catch {
    /* container unreadable — treat as no memos for the meta gate */
  }
  let track = { supported: false, has: false };
  try {
    const tc = detectTrackChanges(inputPath);
    track = { supported: tc.supported, has: tc.hasTrackChanges };
  } catch {
    /* same: an unchecked container is not "clean" */
  }
  return {
    sourceFormat: doc.getSourceFormat?.() ?? "unknown",
    tableMode: opts.tableMode,
    detect: opts.detect,
    headingRegex: opts.headingRegex,
    strategy: detection.strategy,
    levels: detection.levels ?? {},
    engineVersion: version(),
    memos,
    trackChange: track,
  };
}

export function formatReadSnapshot(result) {
  if (!result) return "";
  const lines = [];
  switch (result.kind) {
    case "no-structure":
      lines.push("snapshot: skipped — no section structure could be detected.");
      lines.push("         The body above is the whole document; nothing to diff by section.");
      break;
    case "first-run":
      lines.push(`snapshot: first read — recorded ${result.sectionCount} section(s)`);
      if (result.path) lines.push(`         ${result.path}`);
      break;
    case "unchanged":
      lines.push(`snapshot: ${NO_CHANGES_LINE}`);
      break;
    case "incomparable":
      lines.push("snapshot: previous baseline is not comparable — recorded a fresh one.");
      for (const r of result.reject ?? []) lines.push(`         • ${r}`);
      if (result.path) lines.push(`         ${result.path}`);
      break;
    case "changed": {
      const d = result.diff;
      lines.push("snapshot: since last read");
      for (const n of d.added) lines.push(`+ ${n.id}  ${n.title}`);
      for (const n of d.removed) lines.push(`- ${n.id}  ${n.title}`);
      for (const n of d.moved) lines.push(`~ ${n.id}  ${n.title}  (moved)`);
      for (const n of d.changed) {
        lines.push(`M ${n.id}  ${n.title}`);
        if (n.diff) lines.push(`    ${n.diff.split("\n").join("\n    ")}`);
      }
      lines.push(
        `${d.added.length} added, ${d.removed.length} removed, ${d.changed.length} changed, ` +
          `${d.moved.length} moved, ${d.unchanged.length} unchanged`,
      );
      if (result.path) lines.push(`snapshot: baseline updated (${result.path})`);
      break;
    }
    default:
      lines.push(`snapshot: ${result.kind}`);
  }
  return lines.join("\n") + "\n";
}

// Build the current section baseline, diff it against the on-disk one, write
// the new baseline (every read becomes the next "last looked").
//
// opts: { doc, snapshotDir, update = true }
export async function compareAndUpdateSnapshot(inputPath, opts = {}) {
  const detectOpts = { ...DETECT_DEFAULTS, ...opts };
  const doc = opts.doc;
  if (!doc) throw new TypeError("compareAndUpdateSnapshot: opts.doc is required");

  const model = await buildBlocks(doc, {
    tableMode: detectOpts.tableMode,
    equations: true,
    footnotes: true,
  });
  const { detection, nodes, tree } = detectHeadings(model.blocks, {
    detect: detectOpts.detect,
    headingRegex: detectOpts.headingRegex,
    markerLevel: detectOpts.markerLevel,
    maxLevel: detectOpts.maxLevel,
  });

  if (!nodes.length) return { kind: "no-structure", detection };

  const ownText = {};
  for (let i = 0; i < nodes.length; i++) {
    ownText[nodes[i].id] = renderOwnText(model, nodes, i, detectOpts);
  }
  const baseline = buildBaseline({
    nodes: tree,
    ownText,
    meta: currentMeta(inputPath, doc, detection, detectOpts),
  });

  const previous = readBaseline(inputPath, { dir: opts.snapshotDir });
  const d = diffBaselines(previous, baseline);

  // A rejected comparison would report change that never happened (e.g. the
  // last read used a different --table-mode). Do not print it; replace the
  // baseline so the *next* read is comparable.
  if (d.safety.reject.length) {
    const res = writeBaseline(inputPath, baseline, { dir: opts.snapshotDir, update: opts.update !== false });
    return {
      kind: "incomparable",
      reject: d.safety.reject,
      path: res.path,
      sectionCount: nodes.length,
      detection,
    };
  }

  if (d.firstRun) {
    const res = writeBaseline(inputPath, baseline, { dir: opts.snapshotDir, update: opts.update !== false });
    return { kind: "first-run", path: res.path, sectionCount: nodes.length, detection };
  }

  const res = writeBaseline(inputPath, baseline, { dir: opts.snapshotDir, update: opts.update !== false });
  if (!hasChanges(d)) {
    return { kind: "unchanged", path: res.path, sectionCount: nodes.length, detection };
  }
  return {
    kind: "changed",
    diff: d,
    path: res.path,
    sectionCount: nodes.length,
    detection,
  };
}

// The read.mjs hook: never throws out, never writes stdout.
export async function reportReadSnapshot(inputPath, opts = {}) {
  try {
    const result = await compareAndUpdateSnapshot(inputPath, opts);
    const text = formatReadSnapshot(result);
    if (text) process.stderr.write(text);
    return result;
  } catch (e) {
    process.stderr.write(
      `snapshot: failed (read is unchanged): ${e?.message ?? e}\n`,
    );
    return { kind: "failed", error: e };
  }
}
