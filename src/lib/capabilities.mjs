// Capability detection — the runtime boundary that lets the SAME skill
// behave correctly on all three target platforms:
//
//   • claude.ai / cowork : WASM only. `core/` scripts work; `enhanced/`
//                          scripts degrade with an actionable message.
//   • Claude Code        : full shell, native rhwp CLI available → the
//                          `enhanced/` tier lights up (PNG, PDF, precise
//                          extraction, IR debug).
//
// The boundary principle (see plan §1): WASM-only → core/; needs the native
// binary → enhanced/. core/ MUST work whenever `wasm` is true (always).
// enhanced/ scripts call requireCli()/requireSkia() and exit UNSUPPORTED(4)
// with a "run on Claude Code" hint when the capability is missing — they
// never silently produce a degraded result.

import { spawnSync } from "node:child_process";
import { tryResolveCli } from "./_resolve_cli.mjs";
import { EXIT, fail } from "./exit-codes.mjs";

let cached = null;

// Detect what the current environment can do. Cached after first call.
//   { wasm: true, cli: bool, cliPath: string|null, skia: bool }
// `wasm` is always true (the vendored bundle ships in the skill).
// `skia` (native raster for PNG/PDF) is inferred from the CLI's help text;
// the actual render scripts still validate that real output was produced,
// because a CLI built without the native-skia feature exits 0 but writes
// nothing.
export function detectCapabilities() {
  if (cached) return cached;
  const caps = { wasm: true, cli: false, cliPath: null, skia: false };
  const cli = tryResolveCli();
  if (cli) {
    caps.cli = true;
    caps.cliPath = cli;
    const r = spawnSync(cli, ["--help"], { encoding: "utf8" });
    const help = (r.stdout || "") + (r.stderr || "");
    // A release binary advertises these subcommands; a WASM-only or
    // feature-stripped build won't. Render scripts re-verify output bytes.
    caps.skia = /export-png|export-pdf/.test(help);
  }
  cached = caps;
  return caps;
}

// Guard for enhanced/ scripts that require the native CLI. Exits 4 with a
// clear, agent-actionable message instead of failing obscurely. `op` is the
// human name of the operation, used in the message.
export function requireCli(op) {
  const caps = detectCapabilities();
  if (caps.cli) return caps;
  fail(
    EXIT.UNSUPPORTED,
    `error: "${op}" needs the native rhwp CLI, which isn't available here.\n` +
      `       This is a code-only (enhanced) feature — run it on Claude Code, or\n` +
      `       install the rhwp binary (https://github.com/edwardkim/rhwp/releases) and\n` +
      `       put it on PATH or set $RHWP_BIN. Core read/edit features work without it.`,
  );
}

// Reset cache (tests that manipulate PATH/RHWP_BIN use this).
export function _resetCapabilitiesCache() {
  cached = null;
}
