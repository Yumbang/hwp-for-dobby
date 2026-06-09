#!/usr/bin/env node
// Usage:
//   node src/enhanced/render.mjs <input.hwp|.hwpx> --page N --output <page.png> \
//     [--vlm-target claude] [--scale 2.0] [--max-dimension 1568]
//
// ENHANCED TIER — NEEDS THE NATIVE rhwp CLI (code-only).
// Vision-grade PNG rendering of a single page. Defaults match Claude Vision's
// preferred input shape (--vlm-target claude → 1568px longest edge, ≈1.15 MP),
// so the output is ready to hand straight to a vision model: verifying after an
// edit, inspecting layout, or "seeing" the page.
//
// Why this is enhanced/ and not core/: PNG render lives in the native-skia path
// (rhwp/document_core/queries/rendering.rs). The WASM bundle that ships with the
// skill does NOT include it, so we MUST shell out to the rhwp CLI binary. On
// claude.ai / cowork there is no CLI → requireCli() degrades with an actionable
// "run on Claude Code" message (exit UNSUPPORTED(4)) instead of crashing.
//
// Input may be .hwp OR .hwpx — the CLI reads both (HWPX→HWP adapter).
//
// On success prints a one-line JSON result: {ok,outputPath,bytes,page,...}.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { requireCli } from "../lib/capabilities.mjs";
import { EXIT, fail } from "../lib/exit-codes.mjs";

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

if (!input || input.startsWith("--") || page === undefined || !output) {
  fail(
    EXIT.USAGE,
    "usage: render.mjs <input.hwp|.hwpx> --page N --output <png> " +
      "[--vlm-target claude] [--scale F] [--max-dimension N]",
  );
}

// Gate + degrade FIRST: on platforms without the native CLI this exits
// UNSUPPORTED(4) with the "run on Claude Code" hint and never reaches the
// rendering path. caps.cliPath is the resolved binary.
const caps = requireCli("render PNG");

if (!existsSync(input)) {
  fail(EXIT.LOAD, `error: input not found: ${input}`);
}

const outPath = resolve(output);

// rhwp's `export-png -o` takes a *directory* and auto-names the file after the
// input's stem. We give it a temp dir, then move the single .png that appears
// into the user's requested file path.
const tmpOut = mkdtempSync(join(tmpdir(), "hwp-render-"));
const args = ["export-png", input, "-p", String(page), "-o", tmpOut];
if (vlm) args.push("--vlm-target", vlm);
if (scale) args.push("--scale", String(scale));
if (maxDim) args.push("--max-dimension", String(maxDim));

try {
  const r = spawnSync(caps.cliPath, args, { encoding: "utf8" });

  // export-png currently exits 0 even when the binary was built WITHOUT the
  // native-skia feature (it just writes nothing). So we never trust status
  // alone — we verify a real, non-empty PNG actually appeared. If caps.skia is
  // false the build may lack native-skia; this empty-output check is the
  // backstop that turns that into an honest failure instead of a false success.
  let produced = [];
  try {
    produced = readdirSync(tmpOut).filter((f) =>
      f.toLowerCase().endsWith(".png"),
    );
  } catch {
    produced = [];
  }

  if (r.status !== 0 || produced.length === 0) {
    const detail = ((r.stderr || "") + (r.stdout || "")).trim();
    fail(
      EXIT.UNSUPPORTED,
      (detail ? detail + "\n" : "") +
        `error: rhwp export-png produced no PNG output.\n` +
        (caps.skia
          ? `       The CLI advertises export-png but emitted nothing for this page.\n`
          : `       This rhwp build may lack the native-skia feature (PNG render is gated on it).\n`) +
        `       Run on Claude Code with a native-skia rhwp build to render PNGs.`,
    );
  }

  renameSync(join(tmpOut, produced[0]), outPath);

  if (!existsSync(outPath) || statSync(outPath).size === 0) {
    fail(
      EXIT.UNSUPPORTED,
      `error: rhwp export-png produced an empty file at ${outPath}.\n` +
        `       The build may lack native-skia — run on Claude Code with a native-skia rhwp build.`,
    );
  }

  const bytes = statSync(outPath).size;
  process.stdout.write(
    JSON.stringify({
      ok: true,
      op: "render",
      outputPath: outPath,
      bytes,
      page: Number(page),
      vlmTarget: vlm || null,
      scale: scale ? Number(scale) : null,
      maxDimension: maxDim ? Number(maxDim) : null,
    }) + "\n",
  );
} finally {
  rmSync(tmpOut, { recursive: true, force: true });
}
