// The skill payload — the single definition of "what is actually the skill".
//
// Two consumers must agree on this exactly, or they drift:
//   • build.mjs        packages it into dist/hwp-skill.zip (claude.ai upload)
//   • install-skill.mjs copies it into ~/.claude/skills/hwp (Claude Code, agents)
//
// A file that ships in the ZIP but not in an install (or vice versa) means the
// skill behaves differently depending on how it was delivered — the exact class
// of bug this repo refuses elsewhere. So the allowlist lives here, once.
//
// WHY AN ALLOWLIST (not "everything minus excludes"): the repo also carries
// node_modules/, test/, samples/, dist/, scripts/ and vendor/bin/ — none of
// which are the skill. An allowlist fails closed: a new stray top-level
// directory is excluded by default and can never silently leak into a shipped
// or installed artifact.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

// Top-level files taken verbatim.
export const ALLOW_FILES = ["SKILL.md", "README.md", "package.json", "LICENSE.txt"];
// Directories walked recursively.
export const ALLOW_DIRS = ["spec", "src", join("vendor", "rhwp")];
// Subtrees excluded even when they sit under an included directory. vendor/bin
// holds the optional native CLI (gitignored, machine-specific): it must never
// travel with the skill — enhanced/ resolves it at runtime instead.
export const PRUNE_DIRS = [join("vendor", "bin")];

// Normalize an OS-relative path to a POSIX archive/install path.
export function toPosix(p) {
  return sep === "/" ? p : p.split(sep).join("/");
}

function isPruned(relPath) {
  return PRUNE_DIRS.some((d) => relPath === d || relPath.startsWith(d + sep));
}

function walkDir(root, relDir, acc) {
  const abs = join(root, relDir);
  let entries;
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch (e) {
    throw new Error(`cannot read directory ${relDir}: ${e.message}`);
  }
  for (const ent of entries) {
    const childRel = join(relDir, ent.name);
    if (isPruned(childRel)) continue;
    if (ent.isDirectory()) walkDir(root, childRel, acc);
    else if (ent.isFile()) acc.push(childRel);
    // Symlinks / sockets / etc. are intentionally skipped.
  }
}

// Resolve the allowlist against `root` into a sorted, de-duplicated list of
// repo-relative POSIX paths. Sorted so both consumers see a stable, machine-
// independent order (build.mjs depends on this for byte-deterministic ZIPs).
// Throws on a missing allowlisted path — a payload silently missing the WASM
// bundle is a broken skill, not a warning.
export function collectPayload(root) {
  const members = [];
  for (const f of ALLOW_FILES) {
    const abs = join(root, f);
    if (!existsSync(abs)) throw new Error(`required file missing from repo: ${f}`);
    if (!statSync(abs).isFile()) {
      throw new Error(`allowlisted path is not a regular file: ${f}`);
    }
    members.push(f);
  }
  for (const d of ALLOW_DIRS) {
    const abs = join(root, d);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
      throw new Error(`required directory missing from repo: ${d}`);
    }
    walkDir(root, d, members);
  }
  const posix = [...new Set(members.map(toPosix))].sort();
  if (posix.length === 0) throw new Error("allowlist resolved to zero files");
  return posix;
}
