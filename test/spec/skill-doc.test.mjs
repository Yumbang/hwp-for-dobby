// Guard test for SKILL.md — the honesty / load-bearing-disclosure contract.
//
// SKILL.md is the agent's only briefing. A few of its lines are not prose
// polish: they are the warnings that keep this skill from quietly corrupting
// the user's documents. If any of them is ever deleted in a future rewrite,
// the skill would start *looking* fine while silently dropping edits,
// reading tables off flattened text, or emitting Hancom-rejected .hwpx.
//
// This is the "k-skill / hop" pattern: pin the disclosures with a test so a
// well-meaning edit can't strip them. Each assertion below fails LOUDLY and
// names exactly which disclosure would be lost.
//
// We assert on raw SKILL.md text (not on any script), so this test has no
// engine/fixture dependency — it is purely a documentation invariant.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { collectPayload, skillName } from "../../scripts/_payload.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const SKILL_PATH = join(ROOT, "SKILL.md");

const SKILL = readFileSync(SKILL_PATH, "utf8");
const SKILL_LC = SKILL.toLowerCase();

// Helper: does SKILL.md contain ANY of these substrings (case-insensitive)?
function containsAny(...needles) {
  return needles.some((n) => SKILL_LC.includes(n.toLowerCase()));
}
// Helper: does SKILL.md contain this exact substring (case-insensitive)?
function contains(needle) {
  return SKILL_LC.includes(needle.toLowerCase());
}

test("SKILL.md is non-trivial (sanity: file actually loaded)", () => {
  assert.ok(
    SKILL.length > 500,
    `SKILL.md at ${SKILL_PATH} is suspiciously short (${SKILL.length} bytes) — refusing to assert against a stub`,
  );
});

test("frontmatter declares a usable `name:` (skill identity / routing)", () => {
  // Must be a YAML frontmatter key, not just the name somewhere in prose. The
  // VALUE is deliberately not pinned here — scripts/_payload.mjs' skillName()
  // is the single source, and test/spec/portability.test.mjs proves every
  // consumer (installer, builder, package.json, the docs) agrees with it. What
  // this guards is the disclosure itself: without a syntactically valid name
  // line the skill has no identity and never routes, silently.
  assert.match(
    SKILL,
    /^name:\s*[a-z0-9][a-z0-9-]*\s*$/m,
    "LOST DISCLOSURE: SKILL.md frontmatter no longer declares a usable `name:` — the skill loses its identity and won't route correctly.",
  );
  // …and that our reader and this regex see the same thing.
  assert.equal(/^name:\s*([a-z0-9][a-z0-9-]*)\s*$/m.exec(SKILL)[1], skillName(ROOT));
});

test("retains the form pre-fill corruption warning (#838)", () => {
  assert.ok(
    contains("#838"),
    "LOST DISCLOSURE: the '#838' pre-filled-form-field hazard is gone — agents would fill pre-populated fields without warning that Hancom may reject the result.",
  );
});

// Until 0.7.15 this test guarded the raw `replaceAll` silent-drop hazard. That
// bug was fixed upstream in 0.7.16 (spec rule 9) and the disclosure was retired
// with it — a doc must not warn about a hazard that no longer exists. What is
// still live is the mechanism underneath it: the .hwp round-trip cache, which is
// the only reason memos survive at all and therefore why editing kills them.
test("retains the .hwp round-trip cache disclosure (why memos die on edit)", () => {
  assert.ok(
    containsAny("raw_stream", "round-trip cache", "serializer cache"),
    "LOST DISCLOSURE: the .hwp round-trip byte cache is no longer named — it's the mechanism behind memo loss and behind any future silent-drop regression.",
  );
});

test("retains the memo silent-data-loss disclosure + override flag", () => {
  assert.ok(
    contains("memo"),
    "LOST DISCLOSURE: 'memo' is no longer mentioned — agents would edit a memo-bearing file and silently delete every memo on save (the engine can't model them).",
  );
  assert.ok(
    contains("--allow-memo-loss"),
    "LOST DISCLOSURE: the '--allow-memo-loss' override is gone — the memo guard (exit 6) and its escape hatch are undocumented, so the data-loss block reads as unconditional or invisible.",
  );
});

test("retains the extract_tables (no-flattened-text) table-data rule", () => {
  assert.ok(
    contains("extract_tables"),
    "LOST DISCLOSURE: 'extract_tables' is gone — agents would read table data off flattened text and leak merged-cell values onto the wrong record.",
  );
});

test("retains the .hwpx output policy (input ok, output blocked)", () => {
  assert.ok(
    contains(".hwpx"),
    "LOST DISCLOSURE: '.hwpx' is no longer mentioned — the HWPX input/output policy is undocumented.",
  );
  assert.ok(
    containsAny("block", "reject", "never"),
    "LOST DISCLOSURE: the .hwpx OUTPUT policy is gone — nothing states that native HWPX save is blocked/rejected/never emitted, so an agent may ship a Hancom-rejected file.",
  );
});

test("retains the pinned engine version 0.7.19", () => {
  assert.ok(
    contains("0.7.19"),
    "LOST DISCLOSURE: the pinned engine version '0.7.19' is gone — the behavioral guarantees in this doc are no longer tied to a known engine build.",
  );
});

test("retains the round-trip verification contract ('verified')", () => {
  assert.ok(
    contains("verified"),
    "LOST DISCLOSURE: 'verified' is gone — the edit→save→reload→verify contract disappears and 'engine returned ok' would be wrongly treated as proof.",
  );
});

test("retains the enhanced-tier degrade disclosure (exit 4 / UNSUPPORTED / degrade)", () => {
  assert.ok(
    containsAny("exit 4", "UNSUPPORTED", "degrade"),
    "LOST DISCLOSURE: the enhanced-tier degrade path (exit 4 / unsupported / degrade) is gone — agents wouldn't know PNG/PDF/precise-read fall back to core off Claude Code.",
  );
});

// ── documentation structure (CLAUDE.md "where a sentence belongs") ─────────
//
// SKILL.md is loaded on EVERY invocation of the skill, so every byte in it is a
// tax paid by every task. It is meant to ROUTE — task → script, plus the traps
// that make the obvious choice wrong — while the flags and output shapes of a
// chosen command live in reference/, read only when needed.
//
// That distinction decayed once already: `## Reading & extraction` reached 8,294
// bytes, 2.3x the routing table it supported, because each new reading feature
// appended its whole manual there. These tests are what stops it happening
// again, since nothing else would notice.

// Budget, not a limit of taste: raise it only with a reason in the commit.
const SKILL_MD_MAX = 18000;

test("structure: SKILL.md stays inside its size budget", () => {
  assert.ok(
    SKILL.length <= SKILL_MD_MAX,
    `SKILL.md is ${SKILL.length} bytes, over the ${SKILL_MD_MAX} budget by ` +
      `${SKILL.length - SKILL_MD_MAX}. Move per-command detail into reference/ ` +
      `rather than raising the budget — it is loaded on every invocation.`,
  );
});

test("structure: no single SKILL.md section outgrows the routing table", () => {
  // The failure shape to catch: one capability's manual quietly becoming the
  // largest thing in the file.
  const sections = {};
  let current = "(preamble)";
  for (const line of SKILL.split("\n")) {
    if (line.startsWith("## ")) current = line.slice(3).trim();
    sections[current] = (sections[current] ?? 0) + line.length + 1;
  }
  const router = Object.entries(sections).find(([k]) => /Quick Reference/i.test(k));
  assert.ok(router, "SKILL.md must keep a Quick Reference routing table");
  for (const [name, size] of Object.entries(sections)) {
    if (name === router[0]) continue;
    assert.ok(
      size <= router[1],
      `section "${name}" is ${size} bytes, larger than the ${router[1]}-byte routing ` +
        `table. That is a manual, not routing — move it to reference/.`,
    );
  }
});

test("structure: every reference/ file is pointed at from SKILL.md", () => {
  const dir = join(ROOT, "reference");
  assert.ok(existsSync(dir), "reference/ must exist — it is where command detail lives");
  const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  assert.ok(files.length > 0, "reference/ must not be empty");
  for (const f of files) {
    assert.ok(
      SKILL.includes(`reference/${f}`),
      `reference/${f} exists but SKILL.md never points at it — the agent will ` +
        `never read it, so it may as well not ship.`,
    );
  }
});

test("structure: every reference/ pointer in SKILL.md resolves", () => {
  // A dead pointer is worse than no pointer: the agent cannot tell a missing
  // file from an unhelpful one.
  for (const m of SKILL.matchAll(/reference\/([A-Za-z0-9._-]+\.md)/g)) {
    assert.ok(
      existsSync(join(ROOT, "reference", m[1])),
      `SKILL.md points at reference/${m[1]}, which does not exist`,
    );
  }
});

test("structure: reference/ ships in the delivery payload", () => {
  const shipped = collectPayload(ROOT);
  const refs = shipped.filter((p) => p.startsWith("reference/"));
  assert.ok(
    refs.length > 0,
    "reference/ is not in the payload — every pointer would be a dead link in " +
      "an installed copy. Add it to ALLOW_DIRS in scripts/_payload.mjs.",
  );
  for (const f of readdirSync(join(ROOT, "reference")).filter((f) => f.endsWith(".md"))) {
    assert.ok(shipped.includes(`reference/${f}`), `reference/${f} is not shipped`);
  }
});
