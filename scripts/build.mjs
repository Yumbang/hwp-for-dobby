#!/usr/bin/env node
// Usage:
//   node scripts/build.mjs
//
// Deterministic skill-ZIP builder. Produces dist/hwp-skill.zip — the exact
// archive uploaded to claude.ai's skill registry.
//
// WHY AN EXPLICIT ALLOWLIST (not "zip the whole repo minus excludes"):
// a skill ZIP must contain ONLY what the skill needs at runtime. The repo
// also carries node_modules/, test/, samples/, tmp/, dist/, this very
// scripts/ dir, and the legacy pre-rebuild .mjs — none of which ship. An
// allowlist fails closed: a new stray top-level dir is excluded by default,
// it never silently leaks into a shipped artifact.
//
// WHAT SHIPS (allowlist, all resolved relative to the repo root):
//   SKILL.md, README.md, package.json, LICENSE.txt   (top-level files)
//   spec/        (recursively)  — rhwp-behavior.md and friends
//   src/         (recursively)  — lib/ + core/ + enhanced/ runtime scripts
//   vendor/rhwp/ (recursively)  — the WASM bundle + VERSION; EXCLUDE vendor/bin
//
// Note vendor/ is included only via its rhwp/ subtree, so vendor/bin/ (the
// optional native CLI, gitignored, not for the ZIP) is never picked up.
//
// DETERMINISM: we enumerate the allowlist into a sorted, explicit file list
// and feed it to the system `zip` via `-X -@`:
//   -X  strip extra file attributes (uid/gid, extended attrs) so the archive
//       bytes don't depend on the building machine.
//   -@  read the member list from stdin, one path per line, in the order
//       given — so the sorted list fixes member order too.
// We cd into the repo root before zipping so every archive path is
// repo-relative (src/core/read.mjs, not /Users/.../src/core/read.mjs).
//
// After building we re-open the archive and ASSERT its manifest: a set of
// required entries must be present and a set of forbidden top-level dirs must
// be absent. A build that silently dropped vendor/rhwp/rhwp_bg.wasm — or
// silently swept in node_modules/ — is a failed build, not a warning.
//
// Output: a one-line JSON summary {ok, outputPath, entryCount, bytes}.

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { EXIT, fail } from "../src/lib/exit-codes.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const OUT_DIR = join(ROOT, "dist");
const OUT_PATH = join(OUT_DIR, "hwp-skill.zip");

// ── Allowlist ──────────────────────────────────────────────────────────────
// Each entry is a path relative to the repo root. Files are taken verbatim;
// directories are walked recursively. PRUNE excludes a subtree even when it
// lives under an included directory (vendor/bin under vendor — though here we
// only include vendor/rhwp, PRUNE is belt-and-suspenders against a future
// `vendor/` allowlist entry).
const ALLOW_FILES = ["SKILL.md", "README.md", "package.json", "LICENSE.txt"];
const ALLOW_DIRS = ["spec", "src", join("vendor", "rhwp")];
const PRUNE_DIRS = [join("vendor", "bin")];

// Manifest assertions, all repo-relative POSIX paths.
const REQUIRE_ENTRIES = [
  "SKILL.md",
  "src/lib/_bootstrap.mjs",
  "src/core/read.mjs",
  "src/core/replace.mjs",
  "src/enhanced/render.mjs",
  "vendor/rhwp/rhwp_bg.wasm",
  "vendor/rhwp/VERSION",
  "spec/rhwp-behavior.md",
];
// Forbidden as a leading path segment in any archive entry.
const FORBID_TOP = [
  "node_modules",
  "test",
  "samples",
  "scripts",
  "tmp",
  "dist",
  "evals",
];

// Normalize an OS path (relative to ROOT) to a POSIX archive path.
function toPosix(p) {
  return sep === "/" ? p : p.split(sep).join("/");
}

function isPruned(relPath) {
  return PRUNE_DIRS.some(
    (d) => relPath === d || relPath.startsWith(d + sep),
  );
}

// Recursively collect regular files under an allowlisted dir, repo-relative.
function walkDir(relDir, acc) {
  const abs = join(ROOT, relDir);
  let entries;
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch (e) {
    fail(EXIT.NOT_FOUND, `build: cannot read directory ${relDir}: ${e.message}`);
  }
  for (const ent of entries) {
    const childRel = join(relDir, ent.name);
    if (isPruned(childRel)) continue;
    if (ent.isDirectory()) {
      walkDir(childRel, acc);
    } else if (ent.isFile()) {
      acc.push(childRel);
    }
    // Symlinks / sockets / etc. are intentionally skipped.
  }
}

// ── 1. Build the sorted member list ─────────────────────────────────────────
const members = [];

for (const f of ALLOW_FILES) {
  const abs = join(ROOT, f);
  if (!existsSync(abs)) {
    fail(EXIT.NOT_FOUND, `build: required file missing from repo: ${f}`);
  }
  if (!statSync(abs).isFile()) {
    fail(EXIT.LOAD, `build: allowlisted path is not a regular file: ${f}`);
  }
  members.push(f);
}

for (const d of ALLOW_DIRS) {
  const abs = join(ROOT, d);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    fail(EXIT.NOT_FOUND, `build: required directory missing from repo: ${d}`);
  }
  walkDir(d, members);
}

// Sort the POSIX form for a stable, machine-independent member order.
const posixMembers = [...new Set(members.map(toPosix))].sort();
if (posixMembers.length === 0) {
  fail(EXIT.LOAD, "build: allowlist resolved to zero files");
}

// ── 2. Stage with fixed timestamps, then zip deterministically ───────────────
mkdirSync(OUT_DIR, { recursive: true });
// Remove any prior archive so `zip` writes a fresh one (zip otherwise UPDATES
// an existing archive in place, which would defeat determinism).
if (existsSync(OUT_PATH)) rmSync(OUT_PATH);

// Copy the members into a staging tree and stamp every file and directory with
// a fixed mtime. `zip -X` already drops uid/gid and extended attributes, but it
// still stores each entry's modification time — and a git checkout/merge
// rewrites those, so the archive bytes would otherwise change for identical
// content. Staging lets us normalize the times without touching the source
// tree. We also run zip under TZ=UTC because ZIP stores DOS timestamps in local
// time; together this makes the build byte-identical across rebuilds and across
// machines/timezones.
const STAGE = join(OUT_DIR, ".stage");
const FIXED = new Date("2020-01-01T00:00:00Z");
rmSync(STAGE, { recursive: true, force: true });
for (const m of posixMembers) {
  const dst = join(STAGE, m);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(join(ROOT, m), dst);
}
// Stamp files first, then directories deepest-first (copying a file into a dir
// bumps that dir's mtime, so dirs must be stamped after their contents).
for (const m of posixMembers) utimesSync(join(STAGE, m), FIXED, FIXED);
const stageDirs = new Set();
for (const m of posixMembers) {
  let d = dirname(m);
  while (d && d !== ".") {
    stageDirs.add(d);
    d = dirname(d);
  }
}
for (const d of [...stageDirs].sort((a, b) => b.length - a.length)) {
  utimesSync(join(STAGE, d), FIXED, FIXED);
}

const zip = spawnSync(
  "zip",
  ["-X", "-@", OUT_PATH],
  {
    cwd: STAGE,
    input: posixMembers.join("\n") + "\n",
    encoding: "utf8",
    env: { ...process.env, TZ: "UTC" },
  },
);
rmSync(STAGE, { recursive: true, force: true });
if (zip.error) {
  fail(EXIT.UNSUPPORTED, `build: failed to spawn 'zip': ${zip.error.message}`);
}
if (zip.status !== 0) {
  fail(
    EXIT.LOAD,
    `build: 'zip' exited ${zip.status}\n${zip.stderr || zip.stdout || ""}`,
  );
}
if (!existsSync(OUT_PATH)) {
  fail(EXIT.LOAD, `build: zip reported success but ${OUT_PATH} is absent`);
}

// ── 3. Re-open the archive and assert its manifest ──────────────────────────
const list = spawnSync("unzip", ["-Z1", OUT_PATH], { encoding: "utf8" });
if (list.error) {
  fail(EXIT.UNSUPPORTED, `build: failed to spawn 'unzip': ${list.error.message}`);
}
if (list.status !== 0) {
  fail(
    EXIT.LOAD,
    `build: 'unzip -Z1' exited ${list.status}\n${list.stderr || ""}`,
  );
}
const archiveEntries = list.stdout
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean);
const entrySet = new Set(archiveEntries);

const missing = REQUIRE_ENTRIES.filter((e) => !entrySet.has(e));
if (missing.length) {
  fail(
    EXIT.CORRUPTION,
    `build: archive is missing required entries:\n  ${missing.join("\n  ")}`,
  );
}

const leaked = archiveEntries.filter((e) =>
  FORBID_TOP.includes(e.split("/")[0]),
);
if (leaked.length) {
  fail(
    EXIT.CORRUPTION,
    `build: archive leaked forbidden paths:\n  ${leaked.join("\n  ")}`,
  );
}

// File entries only (zip lists directory entries with a trailing slash).
const fileEntryCount = archiveEntries.filter((e) => !e.endsWith("/")).length;
const bytes = statSync(OUT_PATH).size;

process.stdout.write(
  JSON.stringify({
    ok: true,
    outputPath: OUT_PATH,
    entryCount: fileEntryCount,
    bytes,
  }) + "\n",
);

process.exit(EXIT.OK);
