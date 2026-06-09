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
2. Never call the engine's `replaceAll` on a `.hwp` — that's the silent-drop trap. Use `safeReplaceAll` (`lib/safe-edit`). On `.hwpx` input `replaceAll` is fine.
3. Output is always `.hwp`. Hancom rejects our HWPX; `assertHwpOutput` enforces it.
4. Every rule in `spec/rhwp-behavior.md` has a matching test in `test/spec/`. Learn something new about the engine, write the rule and the test. If the doc and the engine disagree, the engine wins.
5. Exit codes: 0 ok, 1 load, 2 usage, 3 not-found, 4 unsupported-here, 5 corruption/verify-fail.

## Engine version

Pinned in `vendor/rhwp/VERSION` (0.7.15), vendored from npm `@rhwp/core`. `test/pin-integrity` fails if the WASM, `package.json`, the lockfile and VERSION ever drift apart. To move versions, run `npm run bump <version>` — it re-vendors and refuses the bump unless the whole suite stays green. Don't hand-edit the vendored files.

## Adding a script

Put it in `core/` or `enhanced/`, import from `../lib/`, follow the five rules, add a `test/spec/` case, then `npm run build` to refresh the dist zip (allowlist: SKILL.md, src, spec, vendor/rhwp).

The engine is a moving third-party target, so don't promise round-trips it can't deliver. When unsure, check `spec/` and verify empirically.
