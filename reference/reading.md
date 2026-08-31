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

## Images in body text

A picture used to be invisible here: it was classified with the SectionDef /
ColumnDef controls and dropped, so a document could say "아래 그림은…" and the
extracted text below it was a blank line. 20% of 40 real documents carry images.

They now render as a marker where they sit:

```
[image "그림3.png" · 100% of text width · inline]
[image 23% of text width · beside]
```

**The size is relative to the text column, not absolute.** "150mm" cannot be
judged without knowing the page is 210mm wide; "100% of text width" answers
"full-width figure or icon?" at once. The denominator comes from `getPageDef`
per SECTION, because documents do mix a landscape section in.

**The placement word is load-bearing.** `inline` flows with the text;
`block` sits between paragraphs; `beside` means the body text wraps AROUND it,
so the paragraphs either side may read oddly — which otherwise looks like an
extraction bug.

**The filename is there when Hancom recorded one** — on 40 of 41 pictures
across 40 real documents, though the names are auto-numbered (`그림3.png`), so
it says WHICH picture rather than what it shows. Captions, by contrast, were on
0 of 41: real documents caption figures with an ordinary body paragraph.

**Overlays are listed separately, never placed in the body:**

```
─── overlay images (3) ───
[image "그림6.png" · 18% of text width · overlay]
```

A watermark or stamp anchored in front of or behind the text has no reading
position, and inventing one would be the same error as fabricating a heading
tree for a document that has none.

For anything beyond seeing that they exist — sizes, anchoring, replacing —
use `image.mjs --op list` (reference/images.md).

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

## A cell's newlines are two different things

`extract_tables` joins a cell's paragraphs with `\n`, and a **soft line break** inside one paragraph is also `\n`. So these are byte-identical in the text and completely different to edit:

```
three paragraphs           →  "가\n나\n다"
one paragraph, two breaks  →  "가\n나\n다"
```

Paragraph properties apply per paragraph, so an alignment set on the second line is either one line or all three depending on which of those it is. On a real 성과요약 form this hid a cell paragraph holding **4,555 characters across 57 lines**, and reading the document carefully produced exactly the wrong conclusion — that the lines were paragraphs, so formatting them individually should work. It could not, and nothing in the output said why.

So a cell whose text is ambiguous now carries the counts: `cellParagraphs` is how many it really has, `softBreaks` how many newlines are inside a paragraph rather than between two. Unambiguous cells carry neither, so the signal is not buried in noise. `format.mjs --op list` with a cell address says it in words — `[57 LINES IN ONE PARAGRAPH — --op split-lines first]`.

**Do not read INDENTATION off this flattened text either.** The repo's standing warning — never read table *data* off flattened text — is about records, and the same flattening misleads about formatting in a different way: leading whitespace you see here may be literal spaces, or the line may be flush with a `marginLeft` underneath it, and the two are indistinguishable in the string. A reader who treats the spaces as ground truth concludes the fix is "strip the stray spaces" when the real difference is which mechanism carries the depth. Check `format.mjs --op list` with a cell address before treating this text as the basis for a formatting decision.

**`softBreaks > 0` means per-line formatting is impossible until you split.** See `reference/editing.md` for `--op split-lines`.
