# Reading & extraction — command detail

Read this when you have already decided to read or extract from a document and
need the flags, output shapes and traps of a specific script. `SKILL.md` decides
WHICH script; this file explains HOW each one behaves.

## `info.mjs` — what is this file?

JSON summary: pages, sections, `sourceFormat`, fonts, dimensions, `hasTable`,
**`memoCount`**, field count, engine version. `--validate` adds
`getValidationWarnings()` so a structurally suspect source is visible before you
spend time extracting from it.

Run this first on an unfamiliar file. It is cheap and it tells you which of the
other tools you actually need.

## `read.mjs` — body text

**Strict by default.** It does NOT flatten tables: flattening loses a merged
cell's grid position and silently attaches values to the wrong record, so each
table becomes a `[table: use extract_tables.mjs for data]` marker plus a stderr
warning. `--mode best-effort` flattens inline anyway, still warning.

- `--format svg --page N` — quick visual preview. Not authoritative: PUA glyphs
  render as tofu and font metrics use an approximate shim.
- **Memos surface automatically.** The engine hides them from normal extraction,
  so a plain read appends a `─── 메모 / memos (N) ───` block after the body.
  `--memos` prints only the memos — each with its text and the body span it is
  anchored to (`anchor`) — as JSON, or `--format text`.
- **Snapshot on read.** Every body read records the inferred section tree (the
  same baseline `sections.mjs --op snapshot` writes, in `.hwp-snapshots/` next
  to the document). The first read records it; later reads print a
  since-last-read `+/-/~/M` report on **stderr**, then re-baseline — so "what
  changed?" means "since I last looked". `--no-snapshot` opts out;
  `--snapshot-dir` moves the root. A document with no detectable structure skips
  the snapshot rather than inventing a tree, and a snapshot failure never fails
  the read.
- `--memos`, `--track-changes` and `--format svg` do not snapshot — they are not
  a body read.

## `read.mjs --track-changes` — 변경 내용 추적

The memo problem one degree worse: **deleted text is still physically present in
the paragraph records**, so a plain read prints text the author already removed,
inlined with the live body and indistinguishable from it.

A plain read emits a stderr WARNING (with insertion/deletion counts) when — and
only when — the document really has tracked changes. Do not treat that output as
the document's final text.

`--track-changes` lists each change (kind / author / covered text / location);
`--format json` gives the full verdict.

**HWPX cannot be scanned**: the answer is `NOT CHECKED`, which is not `none`.

## `extract_tables.mjs` — the ONLY safe way to read table data

Rebuilds the grid by cell `{row, col, rowSpan, colSpan}` so a merged cell never
leaks onto the wrong record.

Do **not** dump every table of an unfamiliar file. `--summary` first, then
`--table N`.

| Flag | Effect |
|---|---|
| `--summary` | sizes + first-row headers, **no cell data** |
| `--format csv` | rectangular grid; covered cells empty unless `--fill-merged` |
| `--data-tables-only` | drop legend / 작성요령 tables by header keyword (conservative) |
| `--drop-empty` | normalize placeholders (번호, 해당없음, `-`, `X`) to `""` |
| `--detect-form-type` | annotate marker ①② / label / plain |
| `--fill-merged` | replicate origin text into covered positions |
| `--table N` | one table plus its nested descendants |
| `--no-nested` | skip nested-table discovery |

## `search.mjs` — find text with addresses

`searchAllText` plus page and cell coordinates. **0 matches is exit 0**, not an
error. `--limit` sets `truncated` / `totalMatchCount` rather than pretending the
rest do not exist.

## `extract_data.mjs` — dates and KRW amounts

Same addressing as `search.mjs`. `normalized: null` means we did not guess —
treat it as "unparsed", never as zero.

## `read_precise.mjs` (enhanced tier)

Accurate text/markdown via the native CLI, with real table grids in markdown.
Claude Code only; exits 4 elsewhere. Use when you need faithful markdown
rendering rather than the WASM tier's paragraph walk.
