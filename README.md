# hwp — HWP/HWPX skill for AI agents

**Purpose (north-star).** Give AI agents Korean **HWP/HWPX** viewing & editing at the level of Anthropic's `docx`/`pdf` skills — accurate parsing (especially tables) and hop-level editing — running identically across **claude.ai, cowork, and Claude Code**.

The engine is third-party **rhwp** (`@rhwp/core`, Rust→WASM, MIT — github.com/edwardkim/rhwp), vendored under `vendor/rhwp/`. This skill is a thin, robust wrapper over it. We borrow the engine; we do not own it. Known engine limitations are documented honestly (and test-enforced) rather than papered over.

## Architecture — three tiers, one capability boundary

| Tier | Runs on | Contents |
|---|---|---|
| **`src/core/`** | WASM only → **every platform** (claude.ai / cowork / code) | read, table extraction, info, find/replace, cell edit, table, format, header/footer, footnote, form fill, create, unlock |
| **`src/enhanced/`** | native rhwp CLI → **Claude Code only** | vision PNG (skia), PDF export, precise text/markdown, IR debug |
| **`src/lib/`** | shared | WASM bootstrap, capability detection, round-trip verify, exit codes |

**Boundary principle (invariant):** *WASM-only → `core/`; needs the native binary → `enhanced/`. Core never silently degrades.* The single distributed zip ships both tiers; `lib/capabilities.mjs` gates `enhanced/` at runtime and exits `UNSUPPORTED(4)` with a "run on Claude Code" hint when the CLI is absent.

## Output policy

Output is **always `.hwp`**, never `.hwpx` (Hancom Office rejects rhwp-produced HWPX). `.hwpx` **input** is fully supported (the engine runs an HWPX→HWP adapter on export). `lib/_bootstrap.mjs:assertHwpOutput` enforces this.

## Key documents

- **`spec/rhwp-behavior.md`** — the keystone: every empirically-verified engine behavior (pinned to rhwp 0.7.15), each mapped to a test in `test/spec/`. Read this before touching parse/edit logic.
- **Plan** — `~/.claude/plans/sequential-enchanting-puffin.md` (re-architecture plan & phases).

## Engine version

Pinned to rhwp **0.7.15** (`vendor/rhwp/VERSION`, exact-pinned in `package.json`). `test/pin-integrity.test.mjs` fails if the vendored WASM, `package.json`, `package-lock.json`, and the WASM's own `version()` ever disagree.

## Tests

```bash
npm test          # pin-integrity + smoke + spec(coming) + skill-doc(coming)
```

`test/smoke.test.mjs` locks the behaviors the skill depends on (e.g. `insertTextInCell` survives a `.hwp` round-trip) AND the known bug it routes around (`replaceAll` is silently dropped on a genuine `.hwp` — use the safe insert/delete path instead).

## Status

Under clean re-architecture (port-proven-logic, not from-scratch). Phase 0 (foundation: lib + spec + pin/smoke tests) complete; core parsing/editing, enhanced tier, and packaging follow. Legacy scripts under `scripts/` remain functional during migration.
