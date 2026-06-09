// Locate the rhwp CLI binary used by the `enhanced/` tier for vision-grade
// PNG rendering, PDF export, precise text/markdown extraction, and IR debug.
// Resolution order:
//   1. $RHWP_BIN env var (explicit override)
//   2. ../../vendor/bin/rhwp-<platform>-<arch>  (bundled, future)
//   3. `rhwp` on PATH
//
// PNG/PDF rendering requires the native CLI because the WASM build does not
// include the native skia raster path (it's a `native-skia` feature gate in
// rhwp/Cargo.toml). The CLI ships as a GitHub Release asset for 4 platforms
// starting in rhwp v0.7.10.
//
// This is the boundary between the `core/` tier (WASM, runs everywhere:
// claude.ai / cowork / code) and the `enhanced/` tier (native CLI, code
// only). core/ scripts never import this; only enhanced/ does. See
// lib/capabilities.mjs for the non-throwing detection wrapper that the
// enhanced scripts use to degrade gracefully.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { platform, arch } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const VENDOR_BIN = join(HERE, "..", "..", "vendor", "bin");

function platformTag() {
  const p = platform(); // 'darwin' | 'linux' | 'win32'
  const a = arch(); // 'x64' | 'arm64'
  return `${p}-${a}`;
}

function tryBinary(path) {
  if (!existsSync(path)) return false;
  const r = spawnSync(path, ["--help"], { encoding: "utf8" });
  return (
    r.status !== null &&
    (r.status === 0 || /usage/i.test(r.stdout || r.stderr || ""))
  );
}

// Returns the resolved binary path, or null if none found (non-throwing).
export function tryResolveCli() {
  if (process.env.RHWP_BIN && tryBinary(process.env.RHWP_BIN)) {
    return process.env.RHWP_BIN;
  }
  const vendored = join(
    VENDOR_BIN,
    `rhwp-${platformTag()}${platform() === "win32" ? ".exe" : ""}`,
  );
  if (tryBinary(vendored)) return vendored;
  if (tryBinary("rhwp")) return "rhwp";
  return null;
}

// Throwing variant kept for callers that treat the CLI as mandatory.
export async function resolveCli() {
  const found = tryResolveCli();
  if (found) return found;
  const vendored = join(
    VENDOR_BIN,
    `rhwp-${platformTag()}${platform() === "win32" ? ".exe" : ""}`,
  );
  throw new Error(
    `rhwp CLI not found. Install one of:\n` +
      `  • Set $RHWP_BIN to the binary path\n` +
      `  • Place a binary at ${vendored}\n` +
      `  • Install from https://github.com/edwardkim/rhwp/releases (v0.7.10+) and ensure 'rhwp' is on PATH`,
  );
}
