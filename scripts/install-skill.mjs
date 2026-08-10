#!/usr/bin/env node
// Install the skill into whatever agent the user runs.
//
// Usage:
//   node scripts/install-skill.mjs install   [--target claude|agents] [--project]
//                                            [--dry-run] [--force] [--no-agents-md]
//   node scripts/install-skill.mjs uninstall [--target claude|agents] [--project] [--dry-run]
//   node scripts/install-skill.mjs status
//   node scripts/install-skill.mjs list
//
// Two targets, deliberately:
//
//   claude   A skill directory (SKILL.md + src/ + spec/ + vendor/rhwp/) under
//            .claude/skills/hwp/. Claude Code discovers it from the frontmatter
//            `description` on its own, so nothing else is written — no CLAUDE.md
//            edit is needed or made.
//
//   agents   The same directory under .agents/skills/hwp/, plus a pointer
//            section in AGENTS.md — the cross-agent convention Codex, Cursor,
//            Zed and Aider already read. Those agents have no skill
//            auto-discovery, so without the pointer the directory is never
//            found: there the section IS the discovery mechanism, not a
//            convenience. Decline it with --no-agents-md. Skipped in global
//            scope, where no equivalent convention exists.
//
// Each target installs at either scope:
//   global   under $HOME — available in every project (the default)
//   project  under the current directory — travels with the repo, so
//            collaborators and CI get it by checking out
//
// install / uninstall / status are one lifecycle: whatever options place a
// skill take it back out again, and `status` compares an installed copy's
// content hash against the repo's. That comparison is the whole point of
// `status` — an install goes stale the moment the repo moves on without a
// re-run, and a skill describing behavior the code no longer has is worse than
// no skill at all, because the agent follows it confidently.
//
// What gets copied is scripts/_payload.mjs' allowlist — the same set that goes
// into dist/hwp-skill.zip, so a Claude Code install and a claude.ai upload can
// never contain different skills.
//
// PACKAGING-TIER: a maintainer/user tool, not shipped skill behavior. It reads
// and writes the filesystem by design (unlike the WASM-only core/ scripts).

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EXIT, fail } from "../src/lib/exit-codes.mjs";
import { collectPayload, skillName } from "./_payload.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

// The skill's directory name IS its frontmatter `name:` — the directory name is
// what becomes the /<name> invocation, so it is read from SKILL.md rather than
// repeated here. A hardcoded copy that drifts installs the skill into a
// directory that does not match its own frontmatter, and it then loads as
// nothing at all, with no error to notice.
const SKILL = skillName(ROOT);
const SUMMARY =
  "Read, extract tables from, edit, fill and create Korean HWP/HWPX (한글) documents.";

const MARK_BEGIN = `<!-- BEGIN ${SKILL} skill -->`;
const MARK_END = `<!-- END ${SKILL} skill -->`;

// Only layouts that were actually verified get a path here. Inventing a path
// for an agent nobody tested installs a skill that silently never loads.
const TARGETS = {
  claude: {
    label: "Claude Code",
    dir: (scope) =>
      scope === "global"
        ? join(homedir(), ".claude", "skills", SKILL)
        : join(process.cwd(), ".claude", "skills", SKILL),
    agentsMd: false,
  },
  agents: {
    label: "Codex / Cursor / Zed / Aider (AGENTS.md convention)",
    dir: (scope) =>
      scope === "global"
        ? join(homedir(), ".agents", "skills", SKILL)
        : join(process.cwd(), ".agents", "skills", SKILL),
    agentsMd: true,
  },
};

const USAGE =
  "usage: install-skill.mjs <install|uninstall|status|list> [--target claude|agents] [--project] [--dry-run] [--force] [--no-agents-md]";

// ── args ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const command = argv.find((a) => !a.startsWith("-")) ?? "status";
const flag = (n) => argv.includes(n);
function optValue(name, dflt) {
  const i = argv.indexOf(name);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("-")) fail(EXIT.USAGE, `error: ${name} requires a value`);
  return v;
}

if (!["install", "uninstall", "status", "list"].includes(command)) {
  fail(EXIT.USAGE, `error: unknown command '${command}'\n${USAGE}`);
}
const targetName = optValue("--target", "claude");
if (!TARGETS[targetName]) {
  fail(
    EXIT.USAGE,
    `error: unknown --target '${targetName}' (expected ${Object.keys(TARGETS).join("|")})`,
  );
}
const scope = flag("--project") ? "project" : "global";
const dryRun = flag("--dry-run");
const force = flag("--force");
const wantAgentsMd = !flag("--no-agents-md");

// ── payload + hashing ───────────────────────────────────────────────────────

let PAYLOAD;
try {
  PAYLOAD = collectPayload(ROOT);
} catch (e) {
  fail(EXIT.NOT_FOUND, `install: ${e.message}`);
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

// A content hash over the payload as a SET: every relative path plus the hash
// of its bytes. Independent of mtimes and of the order files were copied, so it
// answers exactly one question — "is the installed copy the same skill as this
// repo's?" — and nothing else.
function payloadHash(baseDir, members) {
  const h = createHash("sha256");
  for (const m of members) {
    const abs = join(baseDir, m);
    let bytes;
    try {
      bytes = readFileSync(abs);
    } catch {
      return null; // incomplete install — cannot be "current"
    }
    h.update(m).update("\0").update(sha256(bytes)).update("\n");
  }
  return h.digest("hex");
}

const SOURCE_HASH = payloadHash(ROOT, PAYLOAD);

// ── install-state inspection ────────────────────────────────────────────────

// Returns {state, dir, detail}. state ∈ absent | current | stale | linked | foreign
//   linked  — the path is a symlink (typically a dev checkout wired in by hand).
//             Reported, never silently overwritten: replacing a link with a copy
//             changes how the user's edits propagate, which is their call.
//   foreign — a directory exists but has no SKILL.md; not ours to delete.
function inspect(dir) {
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    return { state: "absent", dir };
  }
  if (st.isSymbolicLink()) {
    let target = "?";
    let sameRepo = false;
    try {
      target = readlinkSync(dir);
      sameRepo = realpathSync(dir) === realpathSync(ROOT);
    } catch {
      /* dangling link */
    }
    return { state: "linked", dir, detail: target, sameRepo };
  }
  if (!st.isDirectory()) return { state: "foreign", dir, detail: "not a directory" };
  if (!existsSync(join(dir, "SKILL.md"))) {
    return { state: "foreign", dir, detail: "directory exists but has no SKILL.md" };
  }
  const h = payloadHash(dir, PAYLOAD);
  return { state: h === SOURCE_HASH ? "current" : "stale", dir };
}

// ── AGENTS.md pointer ───────────────────────────────────────────────────────

function agentsMdBody(skillDir) {
  return (
    `${MARK_BEGIN}\n` +
    `## ${SKILL} skill\n\n` +
    `${SUMMARY}\n\n` +
    `Read \`${skillDir}/SKILL.md\` before touching any \`.hwp\` / \`.hwpx\` file — it carries\n` +
    `the routing table (task → script), the exit-code contract, and the data-loss rules\n` +
    `(never read table data off flattened text; never edit a memo-bearing file without\n` +
    `\`--allow-memo-loss\`; every edit must report \`verified: true\`).\n` +
    `${MARK_END}`
  );
}

// Rewrite the marked section in place, leaving the rest of AGENTS.md untouched.
function writeAgentsMd(path, skillDir) {
  const body = agentsMdBody(skillDir);
  let text = "";
  if (existsSync(path)) text = readFileSync(path, "utf8");
  const b = text.indexOf(MARK_BEGIN);
  const e = text.indexOf(MARK_END);
  let next;
  if (b >= 0 && e > b) {
    next = text.slice(0, b) + body + text.slice(e + MARK_END.length);
  } else {
    next = text.trimEnd();
    next = (next ? next + "\n\n" : "") + body + "\n";
  }
  if (!dryRun) writeFileSync(path, next);
  return b >= 0 && e > b ? "refreshed" : "added";
}

function removeAgentsMdSection(path) {
  if (!existsSync(path)) return "absent";
  const text = readFileSync(path, "utf8");
  const b = text.indexOf(MARK_BEGIN);
  const e = text.indexOf(MARK_END);
  if (b < 0 || e <= b) return "absent";
  const next = (text.slice(0, b).trimEnd() + "\n" + text.slice(e + MARK_END.length).trimStart())
    .trimEnd();
  if (!dryRun) writeFileSync(path, next ? next + "\n" : "");
  return "removed";
}

// ── commands ────────────────────────────────────────────────────────────────

function copyPayload(destDir) {
  for (const m of PAYLOAD) {
    const dst = join(destDir, m);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(join(ROOT, m), dst);
  }
}

function doInstall() {
  const t = TARGETS[targetName];
  const dir = t.dir(scope);
  const found = inspect(dir);

  if (found.state === "linked" && !force) {
    const what = found.sameRepo
      ? `already a symlink to THIS repo (${found.detail}) — it is live, no copy needed`
      : `a symlink to ${found.detail}`;
    fail(
      EXIT.UNSAFE,
      `error: ${dir} is ${what}.\n` +
        `       Refusing to overwrite a symlink you set up by hand.\n` +
        `       • Keep the link (edits stay live): do nothing.\n` +
        `       • Replace it with a real copy: re-run with --force`,
    );
  }
  if (found.state === "foreign" && !force) {
    fail(
      EXIT.UNSAFE,
      `error: ${dir} exists but does not look like this skill (${found.detail}).\n` +
        `       Refusing to delete it. Re-run with --force to replace it.`,
    );
  }

  const action = found.state === "absent" ? "installed" : "updated";
  if (!dryRun) {
    // Clean replace: a plain overwrite would leave files behind that the payload
    // no longer has, and a half-old skill is exactly the drift `status` exists
    // to catch. Symlinks are unlinked, never recursed into.
    if (found.state === "linked") unlinkSync(dir);
    else if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    copyPayload(dir);
  }

  const result = { ok: true, action, skill: SKILL, target: targetName, scope, path: dir, files: PAYLOAD.length, dryRun };

  if (t.agentsMd && wantAgentsMd) {
    if (scope === "project") {
      const md = join(process.cwd(), "AGENTS.md");
      // Relative, not absolute: a project install is committed and checked out
      // on other machines, where this repo's absolute path does not exist.
      const rel = relative(process.cwd(), dir) || ".";
      result.agentsMd = { path: md, action: writeAgentsMd(md, rel) };
    } else {
      result.agentsMd = { skipped: "global scope has no AGENTS.md convention" };
    }
  }
  process.stdout.write(JSON.stringify(result) + "\n");
}

function doUninstall() {
  const t = TARGETS[targetName];
  const dir = t.dir(scope);
  const found = inspect(dir);
  const result = { ok: true, skill: SKILL, target: targetName, scope, path: dir, dryRun };

  if (found.state === "absent") {
    result.action = "absent";
  } else if (found.state === "linked") {
    // Unlink only — never follow the link and delete the developer's checkout.
    if (!dryRun) unlinkSync(dir);
    result.action = "unlinked";
    result.detail = found.detail;
  } else if (found.state === "foreign" && !force) {
    fail(
      EXIT.UNSAFE,
      `error: ${dir} does not look like this skill (${found.detail}). Refusing to delete it.\n` +
        `       Re-run with --force if you are sure.`,
    );
  } else {
    if (!dryRun) rmSync(dir, { recursive: true, force: true });
    result.action = "removed";
  }

  if (t.agentsMd && scope === "project") {
    const md = join(process.cwd(), "AGENTS.md");
    result.agentsMd = { path: md, action: removeAgentsMdSection(md) };
  }
  process.stdout.write(JSON.stringify(result) + "\n");
}

// status/list survey EVERY target × scope, because the useful question is
// "where is this skill on this machine, and is any copy stale?" — not "what
// about the one location I happened to name".
function survey() {
  const rows = [];
  for (const [name, t] of Object.entries(TARGETS)) {
    for (const sc of ["global", "project"]) {
      rows.push({ target: name, scope: sc, ...inspect(t.dir(sc)) });
    }
  }
  return rows;
}

function doStatus() {
  const rows = survey();
  const present = rows.filter((r) => r.state !== "absent");
  process.stdout.write(
    JSON.stringify(
      { skill: SKILL, sourceHash: SOURCE_HASH.slice(0, 12), installs: rows },
      null,
      2,
    ) + "\n",
  );
  if (present.some((r) => r.state === "stale")) {
    process.stderr.write(
      `\nSTALE: an installed copy differs from this repo. Re-run:\n` +
        `  node scripts/install-skill.mjs install${scope === "project" ? " --project" : ""}\n`,
    );
    process.exit(EXIT.CORRUPTION);
  }
  if (present.length === 0) process.exit(EXIT.NOT_FOUND);
  process.exit(EXIT.OK);
}

function doList() {
  const rows = survey();
  process.stdout.write(`skill: ${SKILL} — ${SUMMARY}\n`);
  process.stdout.write(`source: ${ROOT} (${PAYLOAD.length} files, hash ${SOURCE_HASH.slice(0, 12)})\n\n`);
  for (const [name, t] of Object.entries(TARGETS)) {
    process.stdout.write(`${name}  — ${t.label}\n`);
    for (const sc of ["global", "project"]) {
      const r = rows.find((x) => x.target === name && x.scope === sc);
      const detail = r.detail ? `  (${r.detail})` : "";
      process.stdout.write(`  ${sc.padEnd(8)} ${r.state.padEnd(8)} ${t.dir(sc)}${detail}\n`);
    }
  }
  process.exit(EXIT.OK);
}

switch (command) {
  case "install":
    doInstall();
    break;
  case "uninstall":
    doUninstall();
    break;
  case "list":
    doList();
    break;
  default:
    doStatus();
}
