#!/usr/bin/env node
// Usage:
//   node scripts/render.mjs <input> --page N --output <page.png> \
//     [--vlm-target claude] [--scale 2.0] [--max-dimension 1568]
//
// Renders a single page to PNG via the rhwp CLI binary. Defaults match
// Claude Vision's preferred input shape (--vlm-target claude →
// 1568px longest edge, ≈1.15 MP). Use this when the agent needs to
// "see" the document — verifying after an edit, inspecting layout, or
// handing the page to a vision model.
//
// PNG render is in the native-skia path (rhwp/document_core/queries/
// rendering.rs). It's not in the WASM build; that's why we shell out
// rather than calling @rhwp/core directly.
//
// Prints the absolute output path on stdout.

import { resolveCli } from "./_resolve_cli.mjs";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

const input = process.argv[2];
const page = arg("--page");
const output = arg("--output");
const vlm = arg("--vlm-target", "claude");
const scale = arg("--scale");
const maxDim = arg("--max-dimension");

if (!input || page === undefined || !output) {
  console.error(
    "usage: render.mjs <input> --page N --output <png> [--vlm-target claude] [--scale F] [--max-dimension N]",
  );
  process.exit(2);
}

const cli = await resolveCli();
const outPath = resolve(output);

// rhwp's `export-png -o` takes a *directory* and auto-names the file after
// the input's stem. We give it a temp dir, then move the single .png that
// appears into the user's requested file path.
const tmpOut = mkdtempSync(join(tmpdir(), "hwp-render-"));
const args = ["export-png", input, "-p", String(page), "-o", tmpOut];
if (vlm) args.push("--vlm-target", vlm);
if (scale) args.push("--scale", String(scale));
if (maxDim) args.push("--max-dimension", String(maxDim));

try {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  // rhwp's export-png currently exits 0 even when missing the native-skia
  // feature; verify a PNG actually appears in the temp dir.
  const produced = readdirSync(tmpOut).filter((f) => f.toLowerCase().endsWith(".png"));
  if (r.status !== 0 || produced.length === 0) {
    process.stderr.write(
      (r.stderr || "") + (r.stdout || "") + "rhwp export-png produced no output\n",
    );
    process.exit(1);
  }
  renameSync(join(tmpOut, produced[0]), outPath);
  if (!existsSync(outPath) || statSync(outPath).size === 0) {
    process.stderr.write("rhwp export-png produced an empty file\n");
    process.exit(1);
  }
  process.stdout.write(outPath + "\n");
} finally {
  rmSync(tmpOut, { recursive: true, force: true });
}
