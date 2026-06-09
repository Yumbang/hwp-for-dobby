#!/usr/bin/env node
// bump.mjs — gated engine-version bump for the hwp skill.
//
// Usage: node scripts/bump.mjs <version> [--dry-run]
//
// Bumping the pinned rhwp engine (@rhwp/core) is the one change that can
// silently rot the whole skill: a new WASM build may alter edit round-trips,
// drop entities, or reject HWPX. So a bump is treated like a hop-style release
// gate — it is ACCEPTED only if every safety net stays green afterward:
// pin-integrity + smoke + spec + edit-matrix (all run by `npm test`).
//
// The pipeline, in order:
//   1. Refuse if the git working tree is dirty (so a rejected bump can be
//      cleanly reverted with `git checkout`). Skipped under --dry-run. If git
//      is unavailable, warn and continue rather than hard-fail.
//   2. npm install @rhwp/core@<version> --save-exact  (skipped under --dry-run).
//   3. node scripts/vendor-sync.mjs — refresh + byte-verify vendor/rhwp/ and
//      rewrite vendor/rhwp/VERSION from the freshly installed package.
//   4. npm test — the full gate (pin-integrity + smoke + spec + edit-matrix).
//      If it fails the bump is REJECTED: exit CORRUPTION and tell the operator
//      to revert the working tree (git checkout .) so nothing half-bumped ships.
//
// Only on an all-green run does it print {ok:true, version, testsPassed:true}
// and exit 0. --dry-run still runs vendor-sync + npm test (the real gates) but
// makes no install and tolerates a dirty tree, so it is a safe no-op rehearsal
// (e.g. re-bumping to the already-installed version).
//
// PACKAGING-TIER: a maintainer tool, not shipped behavior. It shells out to
// git/npm/node by design (unlike the WASM-only core/ scripts).

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { EXIT, fail } from "../src/lib/exit-codes.mjs";

const HERE = dirname(fileURLToPath(import.meta.url)); // .../hwp/scripts
const REPO = dirname(HERE); // .../hwp

const USAGE = "usage: bump.mjs <version> [--dry-run]";

// ---- argument parsing -----------------------------------------------------
let version = null;
let dryRun = false;
for (const arg of process.argv.slice(2)) {
  if (arg === "--dry-run") dryRun = true;
  else if (arg === "-h" || arg === "--help") {
    process.stdout.write(USAGE + "\n");
    process.exit(EXIT.OK);
  } else if (arg.startsWith("-")) {
    fail(EXIT.USAGE, `error: unknown option ${arg}\n${USAGE}`);
  } else if (version === null) {
    version = arg;
  } else {
    fail(EXIT.USAGE, `error: unexpected argument ${arg}\n${USAGE}`);
  }
}
if (!version) {
  fail(EXIT.USAGE, USAGE);
}
// Guard against obviously malformed versions before we touch npm.
if (!/^\d+\.\d+\.\d+([-+].+)?$/.test(version)) {
  fail(
    EXIT.USAGE,
    `error: '${version}' does not look like a semver version (e.g. 0.7.15)\n${USAGE}`,
  );
}

// ---- helpers --------------------------------------------------------------

// Run a command synchronously, inheriting stdio so the operator sees live
// install/test output. Returns the spawnSync result; callers inspect .status.
function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    cwd: REPO,
    stdio: "inherit",
    encoding: "utf8",
    ...opts,
  });
}

// Like run() but captures stdout/stderr instead of streaming them (used for
// the porcelain status probe, whose output we want to inspect, not echo).
function capture(cmd, args) {
  return spawnSync(cmd, args, { cwd: REPO, encoding: "utf8" });
}

function log(msg) {
  process.stderr.write(msg + "\n");
}

// ---- step 1: clean-tree gate ---------------------------------------------
// A bump mutates package.json, package-lock.json and the whole vendor/rhwp/
// bundle. We require a clean tree first so that, if the test gate later
// rejects the bump, `git checkout .` restores a known-good state with nothing
// of the operator's own work caught in the blast radius. Under --dry-run we
// skip this entirely (the dry run is meant to be runnable mid-work).
if (!dryRun) {
  const status = capture("git", ["-C", REPO, "status", "--porcelain"]);
  if (status.error || status.status === null) {
    // git missing or unrunnable: warn and continue (per spec) rather than
    // blocking a bump just because this isn't a git checkout.
    log(
      `warning: git not available (${status.error?.message ?? "no status"}); ` +
        `skipping clean-tree check. Cannot auto-revert if the bump is rejected.`,
    );
  } else if (status.status !== 0) {
    log(
      `warning: 'git status' exited ${status.status}; skipping clean-tree check.`,
    );
  } else if (status.stdout && status.stdout.trim() !== "") {
    fail(
      EXIT.USAGE,
      "error: git working tree is dirty. Commit or stash your changes first\n" +
        "       so a rejected bump can be reverted cleanly (git checkout .).\n" +
        "       Use --dry-run to rehearse the gate without this check.\n\n" +
        "dirty paths:\n" +
        status.stdout.replace(/^/gm, "  "),
    );
  } else {
    log("clean-tree check: OK");
  }
} else {
  log("[dry-run] skipping clean-tree check");
}

// ---- step 2: install the requested engine version -------------------------
// --save-exact pins it as an exact version (no ^range) — the whole point of a
// vendored, byte-verified engine is that the version is deterministic.
if (!dryRun) {
  log(`installing @rhwp/core@${version} (--save-exact)...`);
  const install = run("npm", [
    "install",
    `@rhwp/core@${version}`,
    "--save-exact",
  ]);
  if (install.error) {
    fail(EXIT.UNSUPPORTED, `error: failed to run npm install: ${install.error.message}`);
  }
  if (install.status !== 0) {
    fail(
      EXIT.LOAD,
      `error: 'npm install @rhwp/core@${version}' failed (exit ${install.status}).\n` +
        `       Check the version exists on the registry and try again.`,
    );
  }
} else {
  log(`[dry-run] skipping 'npm install @rhwp/core@${version} --save-exact'`);
}

// ---- step 3: vendor-sync --------------------------------------------------
// Flatten + byte-verify the installed package into vendor/rhwp/ and rewrite
// vendor/rhwp/VERSION. vendor-sync itself fails CORRUPTION on any sha mismatch.
log("running vendor-sync...");
const sync = run("node", [join(HERE, "vendor-sync.mjs")]);
if (sync.error) {
  fail(EXIT.UNSUPPORTED, `error: failed to run vendor-sync: ${sync.error.message}`);
}
if (sync.status !== 0) {
  fail(
    sync.status === EXIT.CORRUPTION ? EXIT.CORRUPTION : EXIT.LOAD,
    `error: vendor-sync failed (exit ${sync.status}). Bump REJECTED.\n` +
      (dryRun
        ? "       Revert with: git checkout vendor/"
        : "       Revert the working tree with: git checkout ."),
  );
}

// ---- step 4: the test gate ------------------------------------------------
// pin-integrity (vendor matches the pin) + smoke (engine loads & round-trips)
// + spec + edit-matrix. This is the accept/reject decision for the whole bump.
log("running test gate (npm test)...");
const test = run("npm", ["test"]);
if (test.error) {
  fail(EXIT.UNSUPPORTED, `error: failed to run npm test: ${test.error.message}`);
}
if (test.status !== 0) {
  fail(
    EXIT.CORRUPTION,
    `\nBUMP REJECTED: test gate failed (npm test exited ${test.status}).\n` +
      `The engine bump to ${version} did NOT keep pin-integrity + smoke + spec +\n` +
      `edit-matrix green, so it must not be shipped.\n` +
      `Revert the working tree now:  git checkout .\n` +
      `(restores package.json, package-lock.json and vendor/rhwp/ to the prior pin)`,
  );
}

// ---- accepted -------------------------------------------------------------
process.stdout.write(
  JSON.stringify({
    ok: true,
    version,
    dryRun,
    testsPassed: true,
  }) + "\n",
);
process.exit(EXIT.OK);
