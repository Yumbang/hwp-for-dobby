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
import { skillName } from "../../scripts/_payload.mjs";

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
