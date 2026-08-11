// Spec tests for the skill installer (scripts/install-skill.mjs).
//
// The installer is how the skill actually reaches an agent, so its failure
// modes are user-visible in the same way an edit script's are:
//
//   • A payload that drifts from the ZIP means a Claude Code install and a
//     claude.ai upload are DIFFERENT skills. Both must come from the one
//     allowlist in scripts/_payload.mjs.
//   • A stale install is worse than no install: the agent follows a skill
//     describing behavior the code no longer has, confidently. `status` must
//     detect it, and must say so with a non-zero exit.
//   • An install must never destroy something it did not create — a symlinked
//     dev checkout, or an unrelated directory that happens to sit at the path.
//   • A project-scope install is COMMITTED, so the AGENTS.md pointer it writes
//     must be repo-relative; an absolute path breaks on every other machine.
//
// Everything here runs with cwd set to a throwaway temp dir and uses --project
// scope ONLY, so no test can touch the developer's real ~/.claude/skills.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join } from "node:path";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";

import { collectPayload, skillName } from "../../scripts/_payload.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const INSTALLER = join(ROOT, "scripts", "install-skill.mjs");
// The installed directory is named after SKILL.md's frontmatter `name:`, so the
// test reads it from the same place the installer does. Hard-coding it here
// once meant a rename had to be made in twelve places, and any one of them
// missed would have left a test asserting a path nothing writes to.
const SKILL = skillName(ROOT);

// Run the installer with cwd pointed at a scratch "project".
function run(cwd, args) {
  return spawnSync(process.execPath, [INSTALLER, ...args], {
    cwd,
    encoding: "utf8",
  });
}

function workdir() {
  return mkdtempSync(join(tmpdir(), "hwp-install-test-"));
}

test("payload parity: the installer ships exactly what the ZIP ships", () => {
  // Both consumers import collectPayload, so this asserts the seam exists and
  // resolves — the anti-drift guarantee that lets one skill have two delivery
  // channels. If someone re-inlines an allowlist into either script, the file
  // sets diverge and this is where it should be caught.
  const payload = collectPayload(ROOT);
  assert.ok(payload.includes("SKILL.md"), "payload must contain SKILL.md");
  assert.ok(
    payload.includes("vendor/rhwp/rhwp_bg.wasm"),
    "payload must contain the WASM engine — a skill without it cannot parse anything",
  );
  assert.ok(
    payload.some((p) => p.startsWith("src/core/")),
    "payload must contain the core scripts",
  );
  assert.ok(
    !payload.some((p) => p.startsWith("test/") || p.startsWith("samples/") || p.startsWith("scripts/")),
    "payload must NOT contain test/, samples/ or scripts/ — those are not the skill",
  );
  assert.ok(
    !payload.some((p) => p.startsWith("vendor/bin/")),
    "payload must NOT contain vendor/bin/ — the native CLI is machine-specific and resolved at runtime",
  );
});

test("install --project: lands a working skill and reports the file count", () => {
  const w = workdir();
  try {
    const r = run(w, ["install", "--project"]);
    assert.equal(r.status, 0, `install must exit 0: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.action, "installed");
    assert.equal(out.files, collectPayload(ROOT).length);

    const skillDir = join(w, ".claude", "skills", SKILL);
    assert.ok(existsSync(join(skillDir, "SKILL.md")), "SKILL.md must be installed");
    assert.ok(
      existsSync(join(skillDir, "vendor", "rhwp", "rhwp_bg.wasm")),
      "the WASM engine must be installed",
    );

    // The real proof: the installed copy runs standalone, off its own tree.
    const probe = spawnSync(
      process.execPath,
      [join(skillDir, "src", "core", "info.mjs"), join(ROOT, "samples", "fixture-table.hwp")],
      { encoding: "utf8" },
    );
    assert.equal(probe.status, 0, `installed skill must run: ${probe.stderr}`);
    assert.match(probe.stdout, /"engineVersion": *"\d+\.\d+\.\d+"/);
  } finally {
    rmSync(w, { recursive: true, force: true });
  }
});

test("--dry-run: reports the plan and writes nothing", () => {
  const w = workdir();
  try {
    const r = run(w, ["install", "--project", "--dry-run"]);
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).dryRun, true);
    assert.equal(
      existsSync(join(w, ".claude", "skills", SKILL)),
      false,
      "--dry-run must not create the skill directory",
    );
  } finally {
    rmSync(w, { recursive: true, force: true });
  }
});

test("status: 0 when current, 5 when an installed copy drifts from the repo", () => {
  const w = workdir();
  try {
    run(w, ["install", "--project"]);
    assert.equal(run(w, ["status"]).status, 0, "a fresh install must report current (exit 0)");

    // Simulate the real failure: the repo moved on (or someone hand-edited the
    // installed copy) and nobody re-ran install.
    const installed = join(w, ".claude", "skills", SKILL, "SKILL.md");
    writeFileSync(installed, readFileSync(installed, "utf8") + "\nDRIFTED\n");

    const r = run(w, ["status"]);
    assert.equal(r.status, 5, "a drifted install must exit 5, not pass silently");
    assert.match(r.stderr, /STALE/, "status must say STALE on stderr");
    assert.match(r.stderr, /install-skill\.mjs install/, "status must say how to fix it");

    run(w, ["install", "--project"]);
    assert.equal(run(w, ["status"]).status, 0, "re-installing must clear the stale state");
  } finally {
    rmSync(w, { recursive: true, force: true });
  }
});

test("re-install is a CLEAN replace: files the payload dropped do not linger", () => {
  const w = workdir();
  try {
    run(w, ["install", "--project"]);
    const stray = join(w, ".claude", "skills", SKILL, "STRAY-FROM-OLD-VERSION.mjs");
    writeFileSync(stray, "// left over from an older skill version\n");
    run(w, ["install", "--project"]);
    assert.equal(
      existsSync(stray),
      false,
      "a re-install must not leave files from the previous version behind",
    );
  } finally {
    rmSync(w, { recursive: true, force: true });
  }
});

test("install refuses to overwrite a symlink, and leaves it intact", () => {
  const w = workdir();
  try {
    const skillsDir = join(w, ".claude", "skills");
    mkdirSync(skillsDir, { recursive: true });
    symlinkSync(ROOT, join(skillsDir, SKILL));

    const r = run(w, ["install", "--project"]);
    assert.equal(r.status, 6, `must refuse with UNSAFE(6), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /symlink/i, "the refusal must name the symlink as the reason");
    assert.match(r.stderr, /--force/, "the refusal must document the override");
    assert.ok(
      existsSync(join(skillsDir, SKILL, "SKILL.md")),
      "the symlink must survive a refused install",
    );
  } finally {
    rmSync(w, { recursive: true, force: true });
  }
});

test("install refuses to delete an unrelated directory sitting at the target path", () => {
  const w = workdir();
  try {
    const target = join(w, ".claude", "skills", SKILL);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "someone-elses-notes.md"), "important\n");

    const r = run(w, ["install", "--project"]);
    assert.equal(r.status, 6, "must refuse to clobber a directory that isn't this skill");
    assert.ok(
      existsSync(join(target, "someone-elses-notes.md")),
      "the pre-existing content must survive",
    );
  } finally {
    rmSync(w, { recursive: true, force: true });
  }
});

test("agents target: AGENTS.md pointer is repo-RELATIVE and refreshes in place", () => {
  const w = workdir();
  try {
    const md = join(w, "AGENTS.md");
    writeFileSync(md, "# My project\n\nPre-existing notes.\n");

    const r = run(w, ["install", "--target", "agents", "--project"]);
    assert.equal(r.status, 0, `agents install must exit 0: ${r.stderr}`);
    assert.equal(JSON.parse(r.stdout).agentsMd.action, "added");

    let text = readFileSync(md, "utf8");
    const cited = text.match(/`([^`]*SKILL\.md)`/);
    assert.ok(cited, "AGENTS.md must cite the skill's SKILL.md path");
    assert.equal(
      isAbsolute(cited[1]),
      false,
      `AGENTS.md is committed with the repo, so the path must be relative (got ${cited[1]})`,
    );
    assert.ok(text.includes("Pre-existing notes."), "existing AGENTS.md content must survive");

    // Re-running refreshes the marked section rather than appending a second one.
    const r2 = run(w, ["install", "--target", "agents", "--project"]);
    assert.equal(JSON.parse(r2.stdout).agentsMd.action, "refreshed");
    text = readFileSync(md, "utf8");
    assert.equal(
      text.split(`<!-- BEGIN ${SKILL} skill -->`).length - 1,
      1,
      "re-running must not duplicate the pointer section",
    );
  } finally {
    rmSync(w, { recursive: true, force: true });
  }
});

test("--no-agents-md: installs the directory without touching AGENTS.md", () => {
  const w = workdir();
  try {
    const r = run(w, ["install", "--target", "agents", "--project", "--no-agents-md"]);
    assert.equal(r.status, 0);
    assert.ok(existsSync(join(w, ".agents", "skills", SKILL, "SKILL.md")));
    assert.equal(existsSync(join(w, "AGENTS.md")), false, "AGENTS.md must not be created");
  } finally {
    rmSync(w, { recursive: true, force: true });
  }
});

test("uninstall: removes the skill and its AGENTS.md section, leaving the rest", () => {
  const w = workdir();
  try {
    const md = join(w, "AGENTS.md");
    writeFileSync(md, "# My project\n\nPre-existing notes.\n");
    run(w, ["install", "--target", "agents", "--project"]);

    const r = run(w, ["uninstall", "--target", "agents", "--project"]);
    assert.equal(r.status, 0, `uninstall must exit 0: ${r.stderr}`);
    assert.equal(JSON.parse(r.stdout).action, "removed");
    assert.equal(existsSync(join(w, ".agents", "skills", SKILL)), false);

    const text = readFileSync(md, "utf8");
    assert.ok(!text.includes("BEGIN hwp skill"), "the pointer section must be gone");
    assert.ok(text.includes("Pre-existing notes."), "the rest of AGENTS.md must be untouched");
  } finally {
    rmSync(w, { recursive: true, force: true });
  }
});

test("uninstall on a symlink unlinks it WITHOUT deleting the checkout it points at", () => {
  const w = workdir();
  try {
    // A real dev checkout stand-in, so a follow-the-link delete would be visible.
    const checkout = join(w, "checkout");
    mkdirSync(checkout, { recursive: true });
    writeFileSync(join(checkout, "SKILL.md"), "---\nname: hwp\n---\n");

    const skillsDir = join(w, ".claude", "skills");
    mkdirSync(skillsDir, { recursive: true });
    symlinkSync(checkout, join(skillsDir, SKILL));

    const r = run(w, ["uninstall", "--project"]);
    assert.equal(r.status, 0, `uninstall must exit 0: ${r.stderr}`);
    assert.equal(JSON.parse(r.stdout).action, "unlinked");
    assert.equal(existsSync(join(skillsDir, SKILL)), false, "the link must be gone");
    assert.ok(
      existsSync(join(checkout, "SKILL.md")),
      "uninstall must NEVER follow the link and delete the developer's checkout",
    );
  } finally {
    rmSync(w, { recursive: true, force: true });
  }
});
