#!/usr/bin/env node
// IR / layout debugging passthrough (enhanced tier — needs the native rhwp CLI).
//
// Usage:
//   node debug.mjs <input> --op dump        [--section N] [--para N]
//   node debug.mjs <input> --op dump-pages  [--page N]
//   node debug.mjs <input> --op ir-diff     --compare <other> [--section N] [--para N]
//   node debug.mjs <input> --op thumbnail   --output <file.png>
//
// Why enhanced/: dump/dump-pages/ir-diff expose the engine's internal IR and
// pagination model, and thumbnail rasters a preview — none of that is in the
// WASM build, so we shell out to the rhwp CLI. On claude.ai / cowork (no CLI)
// requireCli() degrades with an actionable "run on Claude Code" message and
// exits UNSUPPORTED(4); it never crashes or silently produces nothing.
//
// Maps to CLI subcommands (verified flags):
//   dump        -> dump <in> [--section N] [--para N]      (prints IR to stdout)
//   dump-pages  -> dump-pages <in> [-p N]                  (prints page IR to stdout)
//   ir-diff     -> ir-diff <in> <--compare> [-s N] [-p N]  (prints diff to stdout)
//   thumbnail   -> thumbnail <in> -o <output.png>          (writes a preview image)
//
// For dump/dump-pages/ir-diff we stream the CLI stdout. For thumbnail we
// validate that a real, non-empty image was written at --output and emit a
// one-line JSON result. Accepts both .hwp and .hwpx input (the CLI reads both).

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { requireCli } from "../lib/capabilities.mjs";
import { EXIT, fail } from "../lib/exit-codes.mjs";

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

const USAGE =
  "usage: debug.mjs <input> --op dump|dump-pages|ir-diff|thumbnail\n" +
  "         [--section N] [--para N] [--page N] [--output <file.png>] [--compare <other>]";

const input = process.argv[2];
const op = arg("--op");
const section = arg("--section");
const para = arg("--para");
const page = arg("--page");
const output = arg("--output");
const compare = arg("--compare");

const OPS = new Set(["dump", "dump-pages", "ir-diff", "thumbnail"]);

if (!input || input.startsWith("--") || !op) {
  fail(EXIT.USAGE, USAGE);
}
if (!OPS.has(op)) {
  fail(EXIT.USAGE, `error: unknown --op "${op}"\n${USAGE}`);
}
if (!existsSync(input)) {
  fail(EXIT.NOT_FOUND, `error: input not found: ${input}`);
}

// Gate + degrade. On claude.ai / cowork this exits UNSUPPORTED(4) with the
// "run on Claude Code" hint and never returns.
const caps = requireCli("debug");
const cli = caps.cliPath;

// ---------------------------------------------------------------------------
// thumbnail: writes an image file; validate real output bytes were produced.
// ---------------------------------------------------------------------------
if (op === "thumbnail") {
  if (!output) {
    fail(EXIT.USAGE, `error: --op thumbnail requires --output <file.png>\n${USAGE}`);
  }
  const outPath = resolve(output);
  const r = spawnSync(cli, ["thumbnail", input, "-o", outPath], { encoding: "utf8" });
  // A CLI built without the native raster feature can exit 0 but write
  // nothing; the empty-output check below is the real guard (see contract §5).
  if (r.status !== 0) {
    fail(
      EXIT.UNSUPPORTED,
      (r.stderr || "") + (r.stdout || "") + "rhwp thumbnail failed\n",
    );
  }
  if (!existsSync(outPath) || statSync(outPath).size === 0) {
    fail(
      EXIT.UNSUPPORTED,
      "error: rhwp thumbnail produced no output — this build may lack native raster support.\n" +
        "       Run on Claude Code with a full rhwp release binary.",
    );
  }
  const bytes = statSync(outPath).size;
  process.stdout.write(JSON.stringify({ ok: true, op, outputPath: outPath, bytes }) + "\n");
  process.exit(EXIT.OK);
}

// ---------------------------------------------------------------------------
// dump / dump-pages / ir-diff: passthrough — print the CLI's stdout.
// ---------------------------------------------------------------------------
let cliArgs;
if (op === "dump") {
  cliArgs = ["dump", input];
  if (section !== undefined) cliArgs.push("--section", String(section));
  if (para !== undefined) cliArgs.push("--para", String(para));
} else if (op === "dump-pages") {
  cliArgs = ["dump-pages", input];
  if (page !== undefined) cliArgs.push("-p", String(page));
} else {
  // ir-diff
  if (!compare) {
    fail(EXIT.USAGE, `error: --op ir-diff requires --compare <other>\n${USAGE}`);
  }
  if (!existsSync(compare)) {
    fail(EXIT.NOT_FOUND, `error: --compare file not found: ${compare}`);
  }
  cliArgs = ["ir-diff", input, compare];
  if (section !== undefined) cliArgs.push("-s", String(section));
  if (para !== undefined) cliArgs.push("-p", String(para));
}

const r = spawnSync(cli, cliArgs, { encoding: "utf8" });
if (r.status !== 0) {
  fail(EXIT.LOAD, (r.stderr || "") + (r.stdout || "") + `rhwp ${op} failed\n`);
}
const out = r.stdout || "";
if (!out.trim()) {
  // Honest about empty output rather than reporting a false success.
  process.stderr.write((r.stderr || "") + `rhwp ${op} produced no output\n`);
  process.exit(EXIT.OK);
}
process.stdout.write(out.endsWith("\n") ? out : out + "\n");
process.exit(EXIT.OK);
