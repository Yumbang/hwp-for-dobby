#!/usr/bin/env node
// Usage:
//   node scripts/read.mjs <input.hwp|.hwpx> [--format text|markdown|svg] [--page N|all]
//
// Default: --format text --page all.
//
// Extraction backends, in priority order:
//   1. rhwp CLI (`export-text` / `export-markdown`) — most accurate, handles
//      tables as markdown grids, preserves image references. Requires the
//      `rhwp` binary on $PATH or via $RHWP_BIN. Use this when you can.
//   2. WASM fallback via `getPageTextLayout` (text only) — runs entirely
//      in-process through @rhwp/core. No CLI binary needed. Reconstructs
//      lines by grouping text runs by y-coordinate. Markdown tables are
//      NOT formatted (they appear inline as cell text); pass --format text
//      explicitly when running on this path so the result is consistent.
//
// `read.mjs` chooses backend automatically: tries CLI first, falls back to
// WASM with a one-line stderr note. SVG always runs in-process.
//
// Markdown post-processing (CLI path only): rhwp's export-markdown emits
// literal `<br>` tags for in-paragraph line breaks. We convert these to
// real newlines so downstream LLMs aren't distracted by HTML residue.
//
// Output goes to stdout; pipe or capture as needed. For multi-page
// extraction the script writes a single concatenated stream with form-feed
// (U+000C) page separators between pages.

import { loadDocument } from "./_bootstrap.mjs";
import { resolveCli } from "./_resolve_cli.mjs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

const inputPath = process.argv[2];
if (!inputPath || inputPath.startsWith("--")) {
  console.error("usage: read.mjs <input.hwp|.hwpx> [--format text|markdown|svg] [--page N|all]");
  process.exit(2);
}
const format = arg("--format", "text");
const pageArg = arg("--page", "all");

if (format === "svg") {
  const doc = await loadDocument(inputPath);
  const total = doc.pageCount();
  const pages = pageArg === "all" ? [...Array(total).keys()] : [parseInt(pageArg, 10)];
  for (const p of pages) process.stdout.write(doc.renderPageSvg(p));
} else if (format === "text" || format === "markdown") {
  let cli = null;
  try {
    cli = await resolveCli();
  } catch {
    cli = null; // fall through to WASM
  }
  if (cli) {
    const out = mkdtempSync(join(tmpdir(), "hwp-read-"));
    try {
      const args = [`export-${format === "markdown" ? "markdown" : "text"}`, inputPath, "-o", out];
      if (pageArg !== "all") args.push("-p", pageArg);
      const r = spawnSync(cli, args, { encoding: "utf8" });
      if (r.status !== 0) {
        process.stderr.write(r.stderr || `rhwp ${args[0]} failed\n`);
        process.exit(1);
      }
      const ext = format === "markdown" ? ".md" : ".txt";
      const files = readdirSync(out).filter((f) => f.endsWith(ext)).sort();
      for (let i = 0; i < files.length; i++) {
        if (i > 0) process.stdout.write("\n\f\n");
        let body = readFileSync(join(out, files[i]), "utf8");
        if (format === "markdown") body = body.replace(/<br\s*\/?>/gi, "\n");
        process.stdout.write(body);
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  } else {
    // WASM fallback. getPageTextLayout returns {runs:[{text,x,y,w,h,...}]}.
    // Group by y (within tolerance), sort by x within a line, join texts.
    if (format === "markdown") {
      process.stderr.write(
        "note: rhwp CLI not found; using WASM text extraction. Tables are not formatted as markdown grids on this path. Set $RHWP_BIN if you need full markdown.\n",
      );
    } else {
      process.stderr.write("note: rhwp CLI not found; using WASM text extraction.\n");
    }
    const doc = await loadDocument(inputPath);
    const total = doc.pageCount();
    const pages = pageArg === "all" ? [...Array(total).keys()] : [parseInt(pageArg, 10)];
    for (let pi = 0; pi < pages.length; pi++) {
      if (pi > 0) process.stdout.write("\n\f\n");
      const layout = JSON.parse(doc.getPageTextLayout(pages[pi]));
      const runs = layout.runs || [];
      // Bucket runs into lines by y coordinate, with tolerance equal to
      // ~half the run's height (handles superscripts/subscripts).
      const lines = [];
      for (const r of runs) {
        const y = r.y;
        const tol = Math.max(2, (r.h || 12) * 0.5);
        let bucket = lines.find((b) => Math.abs(b.y - y) <= tol);
        if (!bucket) {
          bucket = { y, runs: [] };
          lines.push(bucket);
        }
        bucket.runs.push(r);
      }
      lines.sort((a, b) => a.y - b.y);
      for (const line of lines) {
        line.runs.sort((a, b) => a.x - b.x);
        process.stdout.write(line.runs.map((r) => r.text || "").join("") + "\n");
      }
    }
  }
} else {
  console.error(`unknown --format: ${format}`);
  process.exit(2);
}
