// Locate the rhwp CLI binary used for vision-grade PNG rendering and for
// text/markdown extraction. Resolution order:
//   1. $RHWP_BIN env var (explicit override)
//   2. ./vendor/bin/rhwp-<platform>-<arch>  (bundled, future)
//   3. `rhwp` on PATH
//
// PNG rendering requires the rhwp CLI because the WASM build does not
// include the native skia raster path (it's a `native-skia` feature gate
// in rhwp/Cargo.toml). The CLI ships as a GitHub Release asset for 4
// platforms starting in rhwp v0.7.10.
//
// TODO(v1): if not resolvable, download from GitHub Releases on demand,
// verify SHA-256, cache under vendor/bin/. For v0 we error with an
// install hint so the agent knows what to ask the user for.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { platform, arch } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const VENDOR_BIN = join(HERE, "..", "vendor", "bin");

function platformTag() {
  const p = platform(); // 'darwin' | 'linux' | 'win32'
  const a = arch();     // 'x64' | 'arm64'
  return `${p}-${a}`;
}

function tryBinary(path) {
  if (!existsSync(path)) return false;
  const r = spawnSync(path, ["--help"], { encoding: "utf8" });
  return r.status !== null && (r.status === 0 || /usage/i.test(r.stdout || r.stderr || ""));
}

export async function resolveCli() {
  if (process.env.RHWP_BIN && tryBinary(process.env.RHWP_BIN)) {
    return process.env.RHWP_BIN;
  }
  const vendored = join(VENDOR_BIN, `rhwp-${platformTag()}${platform() === "win32" ? ".exe" : ""}`);
  if (tryBinary(vendored)) return vendored;
  if (tryBinary("rhwp")) return "rhwp";
  throw new Error(
    `rhwp CLI not found. Install one of:\n` +
      `  • Set $RHWP_BIN to the binary path\n` +
      `  • Place a binary at ${vendored}\n` +
      `  • Install from https://github.com/edwardkim/rhwp/releases (v0.7.10+) and ensure 'rhwp' is on PATH`,
  );
}
