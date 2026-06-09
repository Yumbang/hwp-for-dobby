#!/usr/bin/env node
// Usage:
//   node src/enhanced/export_pdf.mjs <input.hwp|.hwpx> --output <out.pdf>
//
// Exports a document to a multi-page PDF via the native rhwp CLI binary
// (`export-pdf`). This is the print-fidelity sibling of render.mjs (PNG):
// use it when the agent needs to hand a whole document to a human, archive
// it, or attach it — a real, paginated PDF rather than a single page raster.
//
// ENHANCED-TIER: needs the native rhwp CLI (PDF generation is on the
// native-skia path, not in the WASM build). On claude.ai / cowork there is
// no CLI, so this script degrades: requireCli('export PDF') prints an
// actionable "run on Claude Code" message and exits UNSUPPORTED(4). It never
// crashes and never reports success without real output bytes.
//
// Both .hwp and .hwpx inputs are accepted (the CLI reads both; for an .hwpx
// source it runs the engine's HWPX→HWP adapter before paginating).
//
// Output validation: the CLI writes %PDF-… to disk. We export into a temp
// file, confirm it is non-empty AND begins with the %PDF magic header, then
// atomically move it onto the requested --output path. A CLI built without
// the native-skia feature can exit 0 while writing nothing or a stub — the
// magic-header + size checks catch that and fail honestly (EXIT.UNSUPPORTED
// with a "build may lack native-skia" hint) rather than reporting success.
//
// Prints a one-line JSON result on success: {ok:true, outputPath, bytes, ...}.

import { requireCli } from "../lib/capabilities.mjs";
import { EXIT, fail } from "../lib/exit-codes.mjs";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  openSync,
  readSync,
  closeSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

const USAGE =
  "usage: export_pdf.mjs <input.hwp|.hwpx> --output <out.pdf>";

const input = process.argv[2];
const output = arg("--output");

if (!input || input.startsWith("--") || !output) {
  fail(EXIT.USAGE, USAGE);
}

// Gate + degrade. On environments without the native CLI this prints the
// "run on Claude Code" message and exits UNSUPPORTED(4); it never returns.
const caps = requireCli("export PDF");

if (!existsSync(input)) {
  fail(EXIT.NOT_FOUND, `error: input not found: ${input}`);
}

const inLower = String(input).toLowerCase();
if (!inLower.endsWith(".hwp") && !inLower.endsWith(".hwpx")) {
  fail(
    EXIT.USAGE,
    `error: input must be .hwp or .hwpx (got: ${input})\n${USAGE}`,
  );
}

const outLower = String(output).toLowerCase();
if (!outLower.endsWith(".pdf")) {
  fail(
    EXIT.USAGE,
    `error: --output must end in .pdf (got: ${output})\n${USAGE}`,
  );
}

const outPath = resolve(output);

// export-pdf's -o takes a file path directly (unlike export-png's directory).
// Still, we stage to a temp file and move into place so a partial/failed run
// never leaves a half-written or stub PDF at the agent's requested path.
const tmpDir = mkdtempSync(join(tmpdir(), "hwp-pdf-"));
const tmpOut = join(tmpDir, "out.pdf");

// Reads the first `n` bytes of a file as a Buffer (header magic check).
function readMagic(path, n) {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(n);
    const read = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

try {
  const r = spawnSync(
    caps.cliPath,
    ["export-pdf", input, "-o", tmpOut],
    { encoding: "utf8" },
  );

  // The CLI can exit 0 even when a feature-stripped (non-native-skia) build
  // produced nothing usable. Validate real output bytes before trusting it.
  const produced = existsSync(tmpOut);
  const bytes = produced ? statSync(tmpOut).size : 0;

  if (r.status !== 0 || !produced || bytes === 0) {
    const detail = (r.stderr || "") + (r.stdout || "");
    fail(
      EXIT.UNSUPPORTED,
      `${detail}error: rhwp export-pdf produced no output.\n` +
        (caps.skia
          ? "       The PDF was empty or missing despite a native-skia build."
          : "       This rhwp build may lack the native-skia feature required for PDF export.\n" +
            "       Run on Claude Code with a full rhwp release binary."),
    );
  }

  // Confirm it is actually a PDF, not a stub/error file with a .pdf name.
  const magic = readMagic(tmpOut, 5);
  if (magic.toString("latin1") !== "%PDF-") {
    fail(
      EXIT.UNSUPPORTED,
      `error: rhwp export-pdf output is not a valid PDF (missing %PDF header).\n` +
        `       First bytes: ${JSON.stringify(magic.toString("latin1"))}\n` +
        `       This rhwp build may lack the native-skia feature; run on Claude Code.`,
    );
  }

  renameSync(tmpOut, outPath);
  if (!existsSync(outPath) || statSync(outPath).size === 0) {
    fail(EXIT.UNSUPPORTED, "error: rhwp export-pdf produced an empty file");
  }

  process.stdout.write(
    JSON.stringify({
      ok: true,
      op: "export-pdf",
      input: resolve(input),
      outputPath: outPath,
      bytes: statSync(outPath).size,
      format: "pdf",
    }) + "\n",
  );
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
