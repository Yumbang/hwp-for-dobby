# CLAUDE.md

Notes for editing this skill. It wraps the rhwp engine (Rust→WASM, vendored, MIT — third-party, not ours) to read and edit HWP/HWPX. `SKILL.md` is for the agent using the skill; this file is for whoever changes the skill.

## Layout

- `src/lib/` — shared plumbing: WASM bootstrap, capability detection, the verify gate, exit codes, safe find/replace.
- `src/core/` — scripts that run everywhere (claude.ai, cowork, Claude Code). WASM only. Never shell out to the rhwp CLI here; that's the line that keeps the skill working off Claude Code.
- `src/enhanced/` — needs the native `rhwp` binary (PNG, PDF, precise text, IR debug). Gate each one with `requireCli()` so it exits 4 cleanly when the binary isn't there.
- `spec/rhwp-behavior.md` — what the engine actually does on the pinned version. Source of truth.
- `test/` — `npm test`; keep it green.

## Rules that bite if you ignore them

1. Every edit goes through `exportVerify`. The engine will accept an edit in memory and then drop it silently on save, so nothing's done until you reload and confirm. `verified: false` is a failure (exit 5), not a success.
2. Go through `safeReplaceAll` (`lib/safe-edit`) rather than calling the engine's `replaceAll` from a script. It's a one-line delegation now that 0.7.16 fixed the raw_stream silent-drop, but it's the choke point where a regression gets re-routed — and two tests watch that property, so you'd find out.
3. Output is always `.hwp`. Hancom rejects our HWPX; `assertHwpOutput` enforces it.
4. Memos (메모/주석) aren't modeled by the engine — they ride along only in a section's `raw_stream`, so any edit to that section deletes them on save with no error. Every write script must call `assertMemoSafe` (`lib/memo`) before editing: it blocks by default (exit 6) and only proceeds with `--allow-memo-loss`. Never silently let an edit drop memos.
5. Every rule in `spec/rhwp-behavior.md` has a matching test in `test/spec/`. Learn something new about the engine, write the rule and the test. If the doc and the engine disagree, the engine wins.
6. Exit codes: 0 ok, 1 load, 2 usage, 3 not-found, 4 unsupported-here, 5 corruption/verify-fail, 6 unsafe/refused-data-loss (override available).

## Engine version

Pinned in `vendor/rhwp/VERSION` (0.7.19), vendored from npm `@rhwp/core`. `test/pin-integrity` fails if the WASM, `package.json`, the lockfile and VERSION ever drift apart. To move versions, run `npm run bump <version>` — it re-vendors and refuses the bump unless the whole suite stays green. Don't hand-edit the vendored files.

## Adding a script

Put it in `core/` or `enhanced/`, import from `../lib/`, follow the five rules, add a `test/spec/` case, then `npm run build` to refresh the dist zip.

## Delivery

The skill reaches users two ways, and both read the SAME allowlist — `scripts/_payload.mjs`:

- `scripts/build.mjs` → `dist/hwp-skill.zip` for a claude.ai upload.
- `scripts/install-skill.mjs` → copies into `~/.claude/skills/hwp` (or `.claude/skills/`, or the `agents` target's `.agents/skills/` + an `AGENTS.md` pointer).

Change what the skill contains in `_payload.mjs` only. Inlining a second allowlist means a claude.ai upload and a Claude Code install become different skills — `test/spec/install-skill.test.mjs` guards the seam, along with the installer's refusal to clobber a symlink or a directory it did not create.

`install-skill.mjs status` compares content hashes and exits 5 when an installed copy has drifted from the repo. A stale skill is worse than no skill, so keep that loud.

Setup and install instructions live in `README.md` (Korean) — if you change how a tier is resolved, packaged, or installed, update that too.

The engine is a moving third-party target, so don't promise round-trips it can't deliver. When unsure, check `spec/` and verify empirically.
