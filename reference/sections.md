# Document structure — `sections.mjs` detail

Read this when you are outlining, extracting or diffing sections. `SKILL.md`
says when to reach for this script; here is how it behaves.

```bash
node src/core/sections.mjs <in> --op outline                 # the heading tree
node src/core/sections.mjs <in> --op extract --id 2.3.1      # one section + breadcrumb
node src/core/sections.mjs <in> --op extract --id 제12조       # …by document reference
node src/core/sections.mjs <in> --op split --out-dir chunks/ # one .md per top-level section
node src/core/sections.mjs <in> --op snapshot                # record a baseline
node src/core/sections.mjs <in> --op diff                    # what changed since it
```

## Structure is INFERRED, never read

Korean HWP documents carry no outline metadata: `headType` / `paraLevel` /
`numberingId` read None/0/0 on ~100% of paragraphs, and the built-in 개요 1..7
styles exist in every document but are almost never used. Depth is learned **per
document** from marker glyph + indent (□ → ○ → -).

So **every run writes a `detection:` block to stderr**: the winning strategy, the
ladder (style → clause → marker → table → none) with why each rank was rejected,
how many candidates each filter killed, the learned marker→level map, a
confidence grade, and an agreement rate against the engine's own `getStructure`
(a second opinion — it is 조문-only and returned zero nodes on 6 of 9 real
documents, so it is reported, never used).

**Read that block.** At `confidence=low` a loud WARNING says to eyeball
`--op outline` before trusting an `--op extract`.

## "No structure" is a normal answer, not a bug

Measured over 60 real Korean documents: 22 got a marker outline, 26 fell back to
a **table index**, and 12 exited **3** rather than invent a tree.

On exit 3 the two escape hatches are:

- `--detect regex --heading-regex '<pattern>'` — authoritative; `auto` never
  picks regex on its own
- `--marker-level '{"BOX":1,"CIRCLE":2}'`

Otherwise read the document flat and say so.

## Body-less documents fall back to a table index

The fallback fires when no heading candidate survives (or the document has ≤3
non-empty body blocks) *and* there is at least one table. ~22% of real Korean
documents have zero body paragraphs — everything lives inside tables.

`--op outline` then lists `1  표 1  [T0]`, exit 0, confidence low. That index is
for **navigation only**: `--op extract --id T0` returns the heading line with an
empty body. Read the data with `extract_tables.mjs`.

## Options

- **`--id`** takes an ordinal path (`2.3.1`), a document reference (`제12조`,
  `T0`), or an exact title. The id comes from the tree POSITION, not from any
  number printed in the document.
- **`extract` / `split` emit Markdown**: `# title`, a breadcrumb comment
  (`<!-- 제1장 총칙 › 제1조(목적) — file.hwp -->`) so a subagent knows where the
  chunk sits, real markdown table grids, `[^n]` footnotes with bodies after the
  span. `--format json` for a structured chunk; `--format markdown` is accepted
  but currently identical to `text`.
- **Equations** render inline from the HWP equation script — `$x^2 + y^2 = z^2$`.
  No pandoc, no OMML; HWP has its own script language. `--equations latex`
  translates only when the mapping is **complete**, otherwise it falls back to
  the raw script, so a half-translated formula is never dressed up as LaTeX.
- **`--op split`** writes one file per **top-level** section by default
  (`000-<ref>-<title>.md`, streamed, so a 40-page document never holds every
  chunk in memory) and prints each path on stdout. `--level N` adds deeper
  sections — use it when a top-level section is still too big for one subagent.
- **Scoping**: `--own-text` (a node without its children) · `--level N` (cap
  outline depth / widen split) · `--max-level N` (default 4; how many levels may
  be learned) · `--table-mode cells` (tables become placeholders, not grids).

## Snapshots and diff

Snapshots are a **user-owned artifact**, not a cache: `.hwp-snapshots/<stem>/`
next to the document (`--snapshot-dir` to move it), deterministic so an unchanged
document re-snapshots byte-identically.

`--op diff` prints `변경 없음` when nothing moved, otherwise `+/-/~/M` lines with
a word diff, then **re-baselines** so "diff" means "since the last diff"
(`--no-update` to keep the old one). A first `--op diff` with no baseline just
creates one and exits 0.

**A diff across a different `--table-mode` or source format is REFUSED (exit 2)**
— it would report ~100% change that never happened. Re-run `--op snapshot`.

## Cache

The parsed model is cached in the OS temp dir keyed on the file's **sha256**, so
an edited document can never be served a stale tree. `--no-cache` bypasses it.
Measured (`node scripts/bench.mjs`): `--op outline` 427 ms cold, 61 ms warm.
