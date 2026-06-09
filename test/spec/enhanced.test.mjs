// Spec tests for the ENHANCED tier (src/enhanced/*.mjs) — the cross-platform
// guarantee that makes the same skill safe on every target platform.
//
// The load-bearing contract (plan §1 / README 3-tier model):
//
//   • WITH the native rhwp CLI (Claude Code) the enhanced scripts LIGHT UP:
//       render.mjs      → a real, non-empty PNG (>1KB)
//       export_pdf.mjs  → a real PDF (>1KB, begins with the %PDF- magic)
//       read_precise.mjs→ markdown WITH genuine table grids (a `|` pipe row and
//                         a known cell value that core/read.mjs withholds)
//       debug.mjs       → non-empty IR dump on stdout
//     …each exiting 0.
//
//   • WITHOUT any resolvable CLI (claude.ai / cowork — WASM only) each of the
//     four scripts MUST degrade LOUD-BUT-CLEAN: exit UNSUPPORTED(4) with a
//     stderr message that tells the agent to run on Claude Code / install the
//     CLI. It must NEVER crash and NEVER silently produce nothing. THIS is the
//     guarantee that core/ works everywhere while enhanced/ fails honestly.
//
// We spawn each script via `spawnSync(process.execPath, [...], {cwd, env})`,
// exactly as an agent (or a wrapping tool) would invoke it, and inspect
// status/stdout/stderr + the actual output bytes on disk.
//
// Robustness on hosts that genuinely lack the binary: if RHWP_BIN does not
// exist, the WITH-CLI cases are SKIPPED (test.skip) but the degrade cases STILL
// run — the degrade guarantee is the part that must hold on every host.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

const HWP = "samples/fixture-table.hwp"; // genuine HWP (relative to ROOT/cwd)

// The native CLI under test. Present on Claude Code; may be absent on a bare
// CI host — we degrade the WITH-CLI suite to skipped in that case.
const RHWP_BIN =
  "/Users/ybang_mac/Development/side-projects/rhwp-cli/rhwp/target/release/rhwp";
const HAS_CLI = existsSync(RHWP_BIN);

// A scratch dir for all produced artifacts (PNG/PDF/markdown). Created lazily.
let WORK = null;
function workdir() {
  if (!WORK) WORK = mkdtempSync(join(tmpdir(), "hwp-enhanced-test-"));
  return WORK;
}
test.after(() => {
  if (WORK) rmSync(WORK, { recursive: true, force: true });
});

// Run a script with the native CLI wired in via RHWP_BIN.
function runWithCli(script, args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, RHWP_BIN },
  });
}

// Run a script in a NO-CLI environment: PATH points nowhere ('rhwp' cannot be
// found on PATH), RHWP_BIN is unset, and there is no vendored binary — so
// tryResolveCli() returns null and requireCli() must degrade. We spawn the
// ABSOLUTE node (process.execPath), so the child still launches despite the
// bogus PATH; only the *enhanced* CLI lookup fails, which is the point.
function runNoCli(script, args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    // Deliberately minimal env with no RHWP_BIN and an unusable PATH.
    env: { PATH: "/nonexistent", HOME: process.env.HOME || "/tmp" },
  });
}

// The degrade message must steer the agent to Claude Code AND mention the
// install path — assert on stable substrings from lib/capabilities.mjs.
function assertDegradeMessage(stderr, script) {
  assert.match(
    stderr,
    /run it on Claude Code/i,
    `${script}: degrade stderr must tell the agent to run on Claude Code`,
  );
  assert.match(
    stderr,
    /install the rhwp binary/i,
    `${script}: degrade stderr must mention installing the rhwp CLI`,
  );
  assert.match(
    stderr,
    /native rhwp CLI/i,
    `${script}: degrade stderr must name the missing native rhwp CLI`,
  );
}

// ===========================================================================
// WITH CLI — the enhanced tier lights up (skipped if the binary is absent).
// ===========================================================================

test(
  "render.mjs (with CLI): emits a real, non-empty PNG (>1KB) and exits 0",
  { skip: HAS_CLI ? false : `native rhwp CLI not present at ${RHWP_BIN}` },
  () => {
    const out = join(workdir(), "render.png");
    const r = runWithCli("src/enhanced/render.mjs", [
      HWP,
      "--page",
      "0",
      "--output",
      out,
    ]);
    assert.equal(r.status, 0, `render must exit 0: ${r.stderr}`);
    assert.ok(existsSync(out), "render must write the PNG to --output");
    const bytes = statSync(out).size;
    assert.ok(bytes > 1024, `PNG must be a real image >1KB (got ${bytes} bytes)`);
    // A genuine PNG starts with the 8-byte signature 89 50 4E 47 0D 0A 1A 0A.
    const sig = readFileSync(out).subarray(0, 8);
    assert.deepEqual(
      [...sig],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      "render output must carry the PNG magic signature",
    );
    // The one-line JSON result confirms the structured success contract.
    assert.match(r.stdout, /"ok":true/, "render must print ok:true JSON");
  },
);

test(
  "export_pdf.mjs (with CLI): emits a real PDF (>1KB, %PDF- header) and exits 0",
  { skip: HAS_CLI ? false : `native rhwp CLI not present at ${RHWP_BIN}` },
  () => {
    const out = join(workdir(), "export.pdf");
    const r = runWithCli("src/enhanced/export_pdf.mjs", [HWP, "--output", out]);
    assert.equal(r.status, 0, `export_pdf must exit 0: ${r.stderr}`);
    assert.ok(existsSync(out), "export_pdf must write the PDF to --output");
    const bytes = statSync(out).size;
    assert.ok(bytes > 1024, `PDF must be real content >1KB (got ${bytes} bytes)`);
    const head = readFileSync(out).subarray(0, 5).toString("latin1");
    assert.equal(head, "%PDF-", "export_pdf output must begin with the %PDF- magic");
    assert.match(r.stdout, /"ok":true/, "export_pdf must print ok:true JSON");
  },
);

test(
  "read_precise.mjs (with CLI): markdown contains a table pipe and a known cell value",
  { skip: HAS_CLI ? false : `native rhwp CLI not present at ${RHWP_BIN}` },
  () => {
    // No --output → the extracted markdown payload goes to stdout (this is the
    // content the agent reads); the JSON result is written to stderr.
    const r = runWithCli("src/enhanced/read_precise.mjs", [
      HWP,
      "--format",
      "markdown",
    ]);
    assert.equal(r.status, 0, `read_precise must exit 0: ${r.stderr}`);
    assert.ok(r.stdout.length > 0, "read_precise must emit markdown to stdout");
    // A genuine table grid: pipe-delimited rows. core/read.mjs WITHHOLDS these.
    assert.ok(
      r.stdout.includes("|"),
      "markdown must contain a table pipe '|' (real table grid)",
    );
    // A known cell value that lives inside the table — proof the table DATA is
    // present, not just empty pipes. (Verified against the fixture.)
    assert.ok(
      r.stdout.includes("25,002"),
      "markdown must include the known table cell value '25,002'",
    );
    // The structured signal survives on stderr even though stdout is the doc.
    assert.match(r.stderr, /"ok":true/, "read_precise must print ok:true JSON to stderr");
  },
);

test(
  "debug.mjs (with CLI): --op dump prints a non-empty IR dump and exits 0",
  { skip: HAS_CLI ? false : `native rhwp CLI not present at ${RHWP_BIN}` },
  () => {
    const r = runWithCli("src/enhanced/debug.mjs", [HWP, "--op", "dump"]);
    assert.equal(r.status, 0, `debug dump must exit 0: ${r.stderr}`);
    assert.ok(
      r.stdout.trim().length > 0,
      "debug dump must stream a non-empty IR dump to stdout",
    );
  },
);

// ===========================================================================
// WITHOUT CLI — the load-bearing degrade guarantee. ALWAYS runs (every host).
// Each script must exit UNSUPPORTED(4), print the actionable message, and NOT
// produce an output file.
// ===========================================================================

test("render.mjs (no CLI): exits 4 UNSUPPORTED with the run-on-Claude-Code message", () => {
  const out = join(workdir(), "no-cli-render.png");
  const r = runNoCli("src/enhanced/render.mjs", [
    HWP,
    "--page",
    "0",
    "--output",
    out,
  ]);
  assert.equal(r.status, 4, `render must degrade to exit 4 (got ${r.status}): ${r.stderr}`);
  assertDegradeMessage(r.stderr, "render.mjs");
  assert.equal(
    existsSync(out),
    false,
    "render must not silently produce output when the CLI is missing",
  );
});

test("export_pdf.mjs (no CLI): exits 4 UNSUPPORTED with the run-on-Claude-Code message", () => {
  const out = join(workdir(), "no-cli-export.pdf");
  const r = runNoCli("src/enhanced/export_pdf.mjs", [HWP, "--output", out]);
  assert.equal(r.status, 4, `export_pdf must degrade to exit 4 (got ${r.status}): ${r.stderr}`);
  assertDegradeMessage(r.stderr, "export_pdf.mjs");
  assert.equal(
    existsSync(out),
    false,
    "export_pdf must not silently produce output when the CLI is missing",
  );
});

test("read_precise.mjs (no CLI): exits 4 UNSUPPORTED with the run-on-Claude-Code message", () => {
  // NOTE: read_precise checks input existence BEFORE requireCli, so we pass the
  // REAL fixture — otherwise it would (correctly) exit 3 NOT_FOUND first. With a
  // valid input and no CLI it must reach requireCli and degrade to 4.
  const r = runNoCli("src/enhanced/read_precise.mjs", [HWP, "--format", "markdown"]);
  assert.equal(r.status, 4, `read_precise must degrade to exit 4 (got ${r.status}): ${r.stderr}`);
  assertDegradeMessage(r.stderr, "read_precise.mjs");
  assert.equal(
    r.stdout.trim().length,
    0,
    "read_precise must not emit document content when the CLI is missing",
  );
});

test("debug.mjs (no CLI): exits 4 UNSUPPORTED with the run-on-Claude-Code message", () => {
  // debug.mjs also validates input existence before requireCli, so use the real
  // fixture to ensure we exercise the CLI-missing degrade path (not NOT_FOUND).
  const r = runNoCli("src/enhanced/debug.mjs", [HWP, "--op", "dump"]);
  assert.equal(r.status, 4, `debug must degrade to exit 4 (got ${r.status}): ${r.stderr}`);
  assertDegradeMessage(r.stderr, "debug.mjs");
  assert.equal(
    r.stdout.trim().length,
    0,
    "debug must not emit IR output when the CLI is missing",
  );
});
