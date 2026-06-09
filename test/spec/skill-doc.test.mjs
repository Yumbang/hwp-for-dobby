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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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

test("frontmatter declares `name: hwp` (skill identity / routing)", () => {
  // Must be a YAML frontmatter key, not just the word 'hwp' somewhere in prose.
  assert.match(
    SKILL,
    /^name:\s*hwp\s*$/m,
    "LOST DISCLOSURE: SKILL.md frontmatter no longer declares `name: hwp` — the skill loses its identity and won't route correctly.",
  );
});

test("retains the form pre-fill corruption warning (#838)", () => {
  assert.ok(
    contains("#838"),
    "LOST DISCLOSURE: the '#838' pre-filled-form-field hazard is gone — agents would fill pre-populated fields without warning that Hancom may reject the result.",
  );
});

test("retains the raw replaceAll find/replace silent-drop hazard", () => {
  assert.ok(
    contains("replaceAll"),
    "LOST DISCLOSURE: 'replaceAll' is no longer named — the central reason replace.mjs exists (raw bulk replace on .hwp) is undocumented.",
  );
  assert.ok(
    containsAny("FAILS-SILENTLY", "silently drop", "drop"),
    "LOST DISCLOSURE: the silent-drop nature of raw replaceAll is gone — without it 'replaceAll' reads as safe-to-use, which corrupts .hwp edits.",
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

test("retains the pinned engine version 0.7.15", () => {
  assert.ok(
    contains("0.7.15"),
    "LOST DISCLOSURE: the pinned engine version '0.7.15' is gone — the behavioral guarantees in this doc are no longer tied to a known engine build.",
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
