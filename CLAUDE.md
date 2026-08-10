# CLAUDE.md

Notes for editing this skill. It wraps the rhwp engine (Rust→WASM, vendored, MIT — third-party, not ours) to read and edit HWP/HWPX. `SKILL.md` is for the agent using the skill; this file is for whoever changes the skill.

## Layout

- `src/lib/` — shared plumbing. Bootstrap and policy: `_bootstrap` (WASM loader, atomic write, `.hwp`-only output), `capabilities`, `_resolve_cli`, `verify` (the round-trip gate), `exit-codes`, `argv` (strict parsing — a flag given without a value is a usage error, never `undefined`), `safe-edit` (the find/replace choke point). Reading a document: `doc_walk` (paragraph/control walk + kind classification by probe), `blocks` (the ONE block-stream walk everything sits on, with inline splicing and the engine-call budget), `tables` (addressing, cell reads, merge-origin grid), `render_md` (a table entry → markdown), `eqn` (HWP equation script → normalized / best-effort LaTeX). Things the engine does not model: `memo`, `trackchange`, both reading the container directly through `hwp5` (pure CFB/ZIP + record plumbing, no dependencies). Section work: `headings` (pure outline inference — no engine, no I/O), `snapshot` (baselines, the meta gate, word diff), `cache` (content-addressed model cache in tmpdir).
- `src/core/` — scripts that run everywhere (claude.ai, cowork, Claude Code). WASM only. Never shell out to the rhwp CLI here; that's the line that keeps the skill working off Claude Code.
- `src/enhanced/` — needs the native `rhwp` binary (PNG, PDF, precise text, IR debug). Gate each one with `requireCli()` so it exits 4 cleanly when the binary isn't there.
- `spec/rhwp-behavior.md` — what the engine actually does on the pinned version. Source of truth.
- `test/` — `npm test`; keep it green.

## Rules that bite if you ignore them

1. Every edit goes through `exportVerify`. The engine will accept an edit in memory and then drop it silently on save, so nothing's done until you reload and confirm. `verified: false` is a failure (exit 5), not a success.
2. Go through `safeReplaceAll` (`lib/safe-edit`) rather than calling the engine's `replaceAll` from a script. It's a one-line delegation now that 0.7.16 fixed the raw_stream silent-drop, but it's the choke point where a regression gets re-routed — and two tests watch that property, so you'd find out.
3. Output is always `.hwp`. Hancom rejects our HWPX; `assertHwpOutput` enforces it.
4. Memos (메모/주석) aren't modeled by the engine — they ride along only in a section's `raw_stream`, so any edit to that section deletes them on save with no error. Every write script must call `assertMemoSafe` (`lib/memo`) before editing: it blocks by default (exit 6) and only proceeds with `--allow-memo-loss`. Never silently let an edit drop memos.
5. Tracked changes (변경 내용 추적) are the twin of rule 4: the engine doesn't model them either, so the first edit to a section destroys every recorded change — including the original text each deletion still holds. Every write script calls `assertTrackChangeSafe` (`lib/trackchange`) right beside `assertMemoSafe`: same exit 6, override `--allow-trackchange-loss`. A source-level test fails if a script ever guards one and not the other. Detection needs the FileHeader flag bit AND corroboration (the bit alone over-reports), and `HWPTAG_TRACK_CHANGE` (tag 32) is a config record — counting it flags every engine-authored file. HWPX reports `supported: false`, which means "not checked", never "clean".
6. A body equation MUST be probed as `getEquationProperties(s, p, c, -1, -1)`. With cell indices `(0,0)` the engine routes into its table lookup and throws `지정된 컨트롤이 표가 아닙니다` — the exact message the table probe reads as "skip this control", so the naive port loses every equation in every document with no error at all. Use `BODY_EQUATION_CELL` from `lib/doc_walk`; never write a bare `-1`, and never a `0`.
7. Never enumerate controls with `findNearestControlForward`/`Backward`. They are editor cursor navigation and they skip controls — on `fixture-table.hwpx` a forward sweep from `(0,0,0)` reports nothing while the document's only table sits at control 2 of paragraph 0. Enumerate with `getControlTextPositions` and classify by probe (`lib/doc_walk`).
8. Every rule in `spec/rhwp-behavior.md` has a matching test in `test/spec/`. Learn something new about the engine, write the rule and the test. If the doc and the engine disagree, the engine wins.
9. Exit codes: 0 ok, 1 load, 2 usage, 3 not-found, 4 unsupported-here, 5 corruption/verify-fail, 6 unsafe/refused-data-loss (override available).

## Testing

`npm test` runs everything that is safe to run anywhere. Three parts:

- `test/spec/` — one test per rule in `spec/rhwp-behavior.md`, plus the unit-level judgement (heading detection, snapshot matching, the tracked-change parser).
- `test/golden/` — 40 recorded cases (20 `read.mjs` + 20 `extract_tables.mjs`) pinning exit status, stdout and stderr byte for byte, plus the cross-script seam (the two scripts must agree about the same document) and the memo-shape guard. It is the witness that a refactor changed nothing observable. Re-recording (`node test/golden/record.mjs`) is a deliberate act that SAYS the behavior change in the diff is intended — read the diff, and never run it to make a red test go green. The recorder runs every case twice and refuses one whose output wobbles, so a nondeterministic baseline can't get committed.
- Opt-in, no defaults: `HWP_CORPUS_DIR=<dir> npm test` runs the whole skill over real documents (properties only — nothing crashes, outline is total, tracked-change detection stays selective, snapshotting twice reports no change; output is anonymized to `doc#<8 hex>` through a reporter that throws on non-ASCII or a path separator). `HWP_TRACKED_FIXTURE=<file.hwp>` runs the tracked-change path end to end. Both are unset by default on purpose: a test that scans a directory nobody named is a test that reads private documents without being asked, and a tracked-changes fixture can never be committed (a deletion preserves the original text, and the container carries author names, `PrvText` and `HwpSummaryInformation`).

`node scripts/bench.mjs` (not part of `npm test`) prints what the commands cost: engine calls per paragraph, blocks whose properties were actually read, cold vs warm `--op outline`. Wall clock is machine-dependent; the call counts are a property of the code, and `test/spec/inline.test.mjs` asserts the per-paragraph budget so a stray `props()` in a loop fails loudly instead of quietly.

## Fixtures

`samples/fixture-{headings,clause,table-only,inline}.hwp` are generated by `scripts/build-fixtures.mjs` and **committed**, because `scripts/` is not in the delivery allowlist — a generator-only fixture would be missing from every installed copy. They are guarded twice: `test/spec/fixtures.test.mjs` pins the committed bytes by sha256, and `build-fixtures.mjs --check` rebuilds them and compares SEMANTICALLY (paragraph text, indent, control kinds and offsets, table cells), because a byte comparison would go red on every engine bump for reasons that have nothing to do with the fixture.

To change one: edit `scripts/build-fixtures.mjs`, re-run it, copy the printed sha256 into `FIXTURE_SHA256`, and say in the commit message why the document changed. If a fixture and the detector disagree, check which one is wrong before you change either — that has already gone the other way once.

## Engine version

Pinned in `vendor/rhwp/VERSION` (0.7.19), vendored from npm `@rhwp/core`. `test/pin-integrity` fails if the WASM, `package.json`, the lockfile and VERSION ever drift apart. To move versions, run `npm run bump <version>` — it re-vendors and refuses the bump unless the whole suite stays green. Don't hand-edit the vendored files.

## Adding a script

Put it in `core/` or `enhanced/`, import from `../lib/`, follow the rules above (a write script calls BOTH `assertMemoSafe` and `assertTrackChangeSafe`), add a `test/spec/` case, then `npm run build` to refresh the dist zip.

## Delivery

The skill reaches users two ways, and both read the SAME allowlist — `scripts/_payload.mjs`:

- `scripts/build.mjs` → `dist/hwp-for-dobby.zip` for a claude.ai upload.
- `scripts/install-skill.mjs` → copies into `~/.claude/skills/hwp-for-dobby` (or `.claude/skills/`, or the `agents` target's `.agents/skills/` + an `AGENTS.md` pointer).

Change what the skill contains in `_payload.mjs` only. Inlining a second allowlist means a claude.ai upload and a Claude Code install become different skills — `test/spec/install-skill.test.mjs` guards the seam, along with the installer's refusal to clobber a symlink or a directory it did not create.

`install-skill.mjs status` compares content hashes and exits 5 when an installed copy has drifted from the repo. A stale skill is worse than no skill, so keep that loud.

Setup and install instructions live in `README.md` (Korean) — if you change how a tier is resolved, packaged, or installed, update that too.

The engine is a moving third-party target, so don't promise round-trips it can't deliver. When unsure, check `spec/` and verify empirically.
