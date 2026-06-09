#!/usr/bin/env node
// Usage:
//   node src/enhanced/read_precise.mjs <input> --format text|markdown [--output <file>]
//
// Precise text / markdown extraction via the native rhwp CLI — the accurate
// counterpart to core/read.mjs. core/read.mjs is WASM-only and deliberately
// WITHHOLDS tables (flattening a merged-cell table silently misplaces cell
// text). The CLI's export-text / export-markdown render real, paginated
// content, and `markdown` emits genuine table grids (pipe-delimited rows),
// so the agent gets faithful tabular data here.
//
// This is an ENHANCED-tier script: it needs the native binary and therefore
// only lights up on Claude Code. On claude.ai / cowork (no CLI) it degrades
// via requireCli('precise read') → exit UNSUPPORTED(4) with an actionable
// "run on Claude Code" message. It never crashes or silently produces nothing.
//
// Accepts both .hwp and .hwpx input (the CLI reads both).
//
// --- Why the temp-dir-then-collect dance (cf. enhanced/render.mjs) ---
// rhwp's export-text/export-markdown do NOT write to stdout and their `-o`
// flag is a *directory*, not a file. They emit ONE file PER PAGE, auto-named
// by the input stem: a multi-page doc yields `<stem>_001.md, <stem>_002.md…`,
// while a single-page doc yields just `<stem>.md` (no numeric suffix). So we
// run the CLI into a private temp dir, collect every produced file in page
// order (lexical sort puts _001 < _002 …; the single unsuffixed file sorts
// fine on its own), concatenate them, then either write the result to
// --output or print it to stdout. We also validate that non-empty bytes were
// actually produced — a CLI build that fails to render exits 0 but writes
// nothing.

import { requireCli } from "../lib/capabilities.mjs";
import { EXIT, fail } from "../lib/exit-codes.mjs";
import { atomicWriteFile } from "../lib/_bootstrap.mjs";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

const input = process.argv[2];
const format = (arg("--format") || "").toLowerCase();
const output = arg("--output");

if (!input || input.startsWith("--")) {
  fail(
    EXIT.USAGE,
    "usage: read_precise.mjs <input> --format text|markdown [--output <file>]",
  );
}
if (format !== "text" && format !== "markdown") {
  fail(
    EXIT.USAGE,
    `error: --format must be 'text' or 'markdown' (got ${format ? `'${format}'` : "nothing"}).\n` +
      "usage: read_precise.mjs <input> --format text|markdown [--output <file>]",
  );
}
if (!existsSync(input)) {
  fail(EXIT.NOT_FOUND, `error: input file not found: ${input}`);
}

// Gate + degrade. From here on caps.cliPath is the binary.
const caps = requireCli("precise read");

const subcommand = format === "markdown" ? "export-markdown" : "export-text";
const ext = format === "markdown" ? ".md" : ".txt";

// Run the CLI into a private temp dir so we control naming and cleanup, and
// so the CLI's default `output/` directory never lands in the user's cwd.
const tmpOut = mkdtempSync(join(tmpdir(), "hwp-readprecise-"));
try {
  const r = spawnSync(caps.cliPath, [subcommand, input, "-o", tmpOut], {
    encoding: "utf8",
  });

  // Collect produced page files (e.g. <stem>_001.md or single <stem>.md).
  // Lexical sort yields correct page order for the zero-padded suffixes.
  const produced = readdirSync(tmpOut)
    .filter((f) => f.toLowerCase().endsWith(ext))
    .sort();

  if (r.status !== 0 || produced.length === 0) {
    fail(
      EXIT.LOAD,
      (r.stderr || "") +
        (r.stdout || "") +
        `error: rhwp ${subcommand} produced no ${format} output for ${input}\n` +
        "       The input may be unreadable, or this CLI build can't render this document.",
    );
  }

  // Concatenate pages in order. A blank line between pages keeps adjacent
  // tables / paragraphs from running together when pages are joined.
  const parts = produced.map((f) =>
    readFileSync(join(tmpOut, f), "utf8").replace(/\n+$/, ""),
  );
  const content = parts.join("\n\n") + "\n";

  if (content.trim().length === 0) {
    fail(
      EXIT.LOAD,
      `error: rhwp ${subcommand} produced empty ${format} output for ${input}.`,
    );
  }

  if (output) {
    const outPath = resolve(output);
    atomicWriteFile(outPath, content);
    if (!existsSync(outPath) || statSync(outPath).size === 0) {
      fail(EXIT.LOAD, `error: failed to write ${format} output to ${outPath}.`);
    }
    process.stdout.write(
      JSON.stringify({
        ok: true,
        format,
        outputPath: outPath,
        bytes: statSync(outPath).size,
        pages: produced.length,
      }) + "\n",
    );
  } else {
    // No --output: emit the extracted content itself to stdout (this is the
    // payload the agent reads), then the one-line JSON result on stderr so
    // the structured signal survives even when stdout is the document text.
    process.stdout.write(content);
    process.stderr.write(
      JSON.stringify({
        ok: true,
        format,
        bytes: Buffer.byteLength(content, "utf8"),
        pages: produced.length,
      }) + "\n",
    );
  }
} finally {
  rmSync(tmpOut, { recursive: true, force: true });
}
