# Editing — the safe path, in detail

`SKILL.md` routes; this is how each editing command behaves and what bites.

**Find/replace (`replace.mjs`) is the keystone.** It replaces across body text, table cells and textboxes in one pass, then reloads the saved file and confirms — `verified: true` means the change is really on disk, and that check, not the replace itself, is the guarantee. (Historical note for anyone reading older docs: up to engine 0.7.15 bulk replace was silently dropped on a genuine `.hwp` because the serializer's round-trip byte cache wasn't invalidated, and the skill routed around it with a search + delete/insert walk. Fixed upstream in 0.7.16; the workaround is gone.)

Every editing script (`edit_text`, `edit_cell`, `table`, `format`, `header_footer`, `footnote`, `fill_form`, `unlock`, `create`) follows the same contract: edit → atomic `.hwp` save → reload → verify → report `verified`. A `verified: false` result is a **failed task** (exit 5), never reported as success.

**What `verified` does and does not prove.** It is a persistence check, not a correctness check, and the difference has already cost a bug:

| signal | proves |
|---|---|
| `ok: true` from the engine | nothing — it is returned for typos, wrong types, invalid enums and inert keys |
| `verified: true` | the edit is **on disk** and the file reloads cleanly |
| `effect` / `confirmed` / `applied` | the **named property** holds the requested value on disk |
| a rendered page | how it actually **looks** |

Only the last row sees layout. Everything above it reads bytes back, so an edit can be right at every level and still wrap, overflow or paginate wrong. That is not a theoretical gap: `--op bullet` once wrote correct markers with correct text and a clean round trip, while every wrapped line returned to the marker's own column, because the leading spaces went in without the matching hanging indent. `verified` was `true` and the document was wrong.

So: for edits that move text or geometry — indents, bullets, images, font sizes, table widths — treat `verified` as the floor. On Claude Code, `render.mjs` a page and look at it. Off Claude Code there is no renderer, so say plainly that the layout was not visually confirmed rather than implying it was.

- **`fill_form.mjs`** — `--list` shows fields (`occurrence` / `sameNameCount`). `--values` fills them. A name that appears more than once must be written `name[N]` or the fill is refused as ambiguous — never silently fill only the first. `--dry-run` writes nothing. `--rows` + `--out-dir` fills one output per data row. **Empty fields fill cleanly.** Filling a **pre-populated** field warns about upstream bug #838 (char-shape not shifted → Hancom may reject) — visually verify those with `render.mjs`.
- **`edit_cell.mjs`** — `--table N` uses the same index as `extract_tables` (top-level tables). Or `--section/--paragraph/--control`. Address a cell by linear `--cell` index or by `--row/--col`. Out-of-range cell index is caught and reported (the raw engine call would throw). Covered (merged-away) positions are NOT_FOUND with a pointer at the origin.
- **`edit_text.mjs --format`** — inserted text is not neutral. `insertText` has no formatting argument, so the engine gives new characters the formatting of the character **before** the insertion point (at offset 0, the one after). Insert a sentence beside a bold heading and the whole sentence arrives bold. `--format` takes the same character-property JSON as `format.mjs --op char` — one vocabulary, so what you read back can be written straight in — and formats only the characters that were inserted. The span is measured from the engine (paragraph length before vs after), never from `text.length`, because JS counts a surrogate pair as two units and the document counts it as one; `"테스트🙂끝"` is 6 in JS and 5 on the page. `--format` is refused on `--op delete` and `--op insert-paragraph`: the latter creates an *empty* paragraph, and character formatting on a paragraph with no characters is silently ignored — insert the paragraph, then insert its text with `--format`. A tab inside the inserted text keeps its own (absent) formatting; you get a warning. The result carries `effect`, the same per-key verdict `format.mjs` reports, read back from the saved file.
- **`format.mjs --op bullet`** — Korean 개조식 lists are written two ways, and the format's own feature is the one used *less*: across 70 real documents, 274 paragraphs start with a typed `□`/`○`/`-` against 146 that use `headType: "Bullet"`, and only 4 documents use the feature at all. So `--mode auto` (the default) follows what the document already does — a file with any real bullet gets `hwp`, everything else gets the glyph convention. `--paragraphs` takes `6`, `6-9` (inclusive) or `6,8,11`, because fixing a list means fixing twenty paragraphs. `--level N` is depth: `paraLevel` in `hwp` mode, N leading **spaces** in `text` mode (the corpus indents markers with 1,137 spaces against 3 tabs, and `marginLeft` is 0 in 85% of them). Setting a bullet on a paragraph that already has one **replaces** the marker rather than stacking a second in front of it. `--remove` deliberately clears **both** mechanisms whatever the mode, because one paragraph can carry a glyph *and* a `headType`, and "headType is no longer Bullet" is trivially true of a paragraph that never had one — clearing only one would leave a visible `□` behind and report success. If nothing in the range was bulleted you get a warning naming the range, not a silent success. `--char` must be a single character: the engine keeps only the first character of a longer string and **crashes the WASM heap** on a number or object.
- **`format.mjs --op indent`** — changing an indent level looks like moving `marginLeft`, and real documents mostly do not. Across 1,328 marker paragraphs, leading **spaces** beat `marginLeft` 37% to 12%, `marginLeft` is 0 in 85% of them, and half carry no indent signal at all because the glyph itself (`□` vs `○`) is the depth. `--scheme auto` (the default) picks `margin` only when the document clearly uses it, otherwise `space`. **You usually do not need this after `--op bullet`:** in `text` mode `--op bullet --char X --level N` replaces the whole existing prefix — leading whitespace, glyph and gap — with `N spaces + X + space` AND sets the matching hanging indent, so one call normalises glyph and depth together. Reach for `--op indent` when you want to change depth *without* touching the glyph, or to use the `margin` scheme. In `space` scheme the marker glyph is preserved and only moved, never rewritten. **Spaces and a hanging indent are set together**, because they do different jobs — the spaces push the marker right, the negative `indent` pulls wrapped lines back under the text after it — and 91% of space-indented paragraphs long enough to wrap set both. Spaces alone would wrap long lines to column 0, a visible break; `--no-hanging` opts out explicitly. A paragraph with no marker gets spaces but no hang, since a hang on prose is just a broken first line. **Unit trap:** `marginLeft`/`indent` go in as HWPUNIT but the getter divides by 150, so its numbers are 1/48 inch — 1.5 points, not one. `marginLeft: 2000` is 20pt and reads back as `13.3`. Anything derived from getter output and sent back needs the 1.5, and the first version of this code missed it and produced hanging indents two thirds of the intended size.
- **`edit_text.mjs --op insert-paragraph`** — `--paragraph N` inserts the new empty paragraph AT index N, pushing the rest down. Its upper bound is inclusive: passing the current paragraph COUNT appends at the end, which is how you add a line after the last one. Every other op's `--paragraph` is bounded by `count - 1`.
- **`create.mjs --input <doc> --plan <plan.json>`** — replays a plan onto an EXISTING document. This is the batching path, and it matters solo, not just for multi-agent work: the same twelve edits cost **4,895 ms and twelve intermediate files** as twelve invocations against **59 ms and one file** replayed, with the same verification in both. What is being paid twelve times is the process start, the 6.9 MB WASM load, the parse and the save — the editing itself is under 50 ms for a whole document. Ops: `insert_text`, `insert_paragraph`, `create_table`, `insert_text_in_cell`, `apply_para_format`, `apply_char_format`, in one vocabulary so a plan can span what would otherwise be separate scripts. **Batching does not buy a cheaper guarantee:** each step records an intent that is checked against the reloaded file, so a step the engine accepted and ignored fails the run (exit 5) naming the step. A failure writes no output — there is no intermediate-file trail to inspect, so the step index has to carry that information. **Addresses shift**, so a plan whose earlier insertion would misaddress a later step is refused (exit 2) naming both steps; `"order": "descending"` sorts independent steps highest-address-first, and refuses to sort a plan containing `insert_paragraph` because that would reorder a sequence that has to stay in order.
- **`create.mjs --plan`** (no `--input`) — replays a JSON plan (`insert_text`, `insert_paragraph`, `create_table`, `insert_text_in_cell`) against a fresh blank document.

### `format.mjs --op list` — what the document already does

Read-only; refuses `--output`. Reports the distinct shapes the document uses, each described in the same keys `--props` accepts, so what you read goes straight back in. The `P1` labels are local to one report and are never stored in the document — this is deduplication of a report, not a format.

Why a palette rather than a per-paragraph dump: across 74 real documents the most common paragraph shape covers a median of only **42%**, so "baseline plus exceptions" would list most of the document as an exception. The *vocabulary* is small though — a median of 9 paragraph shapes for a 57-paragraph document — so describing the shapes once and referencing them is what fits.

**It describes; it does not prescribe.** A draft whose level-2 items drifted across ○, -, ◦ and * has four shapes and three mistakes. `shapes` and `markers` state the facts; `observations` gives evidence of inconsistency **with the reasoning**, so you can overrule it. Nothing is normalised automatically — deciding whether a deviation is a slip or a deliberate choice is yours, and a tool that quietly "corrected" intentional variation would be the silent-success failure this skill exists to avoid.

Observations are deliberately conservative. A glyph used at two leading-space depths is flagged, because one glyph cannot mark two levels whatever the intended outline. A shape one property away from a much more common one is flagged as *possibly* a slip. But **different glyphs sharing a depth is not flagged**: half of all real marker paragraphs carry no indent at all, so at depth 0 that test puts a legitimate top-level `□` beside level-2 items that merely lost their indent and then calls `□` the majority — which would push the strays up a level instead of fixing them. The marker inventory states the same facts without pointing anywhere.

Fonts are reported under `readOnly`, never among the writable props, because `applyCharFormat` cannot set one.

### Formatting inside a table cell

Korean form documents keep their content in tables — **22% of real documents have no body paragraphs at all**, and on one real 성과요약 form a single cell carries 5,086 characters across ~70 paragraphs. `--op char` and `--op para` reach inside with the same address `edit_cell.mjs` uses:

```
format.mjs <in> --op para --table 0 --cell 0 --paragraphs 0,3 --props '{"alignment":"center"}' --output out.hwp
format.mjs <in> --op list --table 0 --cell 0        # what paragraphs does this cell hold?
```

Address the table by `--table N` (the index `extract_tables` prints) or by `--section/--paragraph/--control`, and the cell by `--cell N` or `--row R --col C`. **`--paragraphs` then means cell paragraphs**, not body ones — one vocabulary, one meaning per context. Start with `--op list` on the cell: it prints each cell paragraph with its index, length, alignment and bold, which is what you need to pick targets.

`--op char` does not need `--start`/`--end` here; the range defaults to the whole cell paragraph, since you already named the paragraph. Character formatting on an **empty** cell paragraph is refused rather than silently ignored — form cells are full of empty spacers, and the engine returns success for that.

**Which ops take a cell address:** `--op list`, `--op char`, `--op para`, `--op bullet`, `--op indent` and `--op split-lines` — all of them.

**`--op bullet` in a cell changes the GLYPH and nothing else.** In the body it sets glyph and depth together, because there the two travel as one convention (leading spaces plus a hanging indent). In a cell they do not: depth lives in the paragraph shape, and changing that mints a new shape which Hancom renders differently from its donor (spec rule 71). So the cell path edits the marker as *text* — measured to leave `paraShapeId` untouched — and **refuses `--level` and `--mode hwp`**, naming `--op indent --by-marker` as the op that does depth safely. Set the glyph here, match the depth there; the two compose.

Without `--paragraphs` it touches only paragraphs that **already carry a marker** — "change the bullets in this cell" means the bullets, and defaulting to every paragraph would put a glyph in front of headers and prose. Naming paragraphs explicitly is how you *add* a marker where there was none. A cell with no markers and no `--paragraphs` is an error (exit 3) rather than a silent no-op. A paragraph that also carries HWP's own `headType` bullet gets a warning: only the typed glyph changed, because clearing `headType` is a paragraph property and would mint a shape.

#### `--op split-lines` — when a cell paragraph is really many lines

A cell paragraph can hold many logical lines separated by `U+000A`, the soft break Shift+Enter produces. On a real 성과요약 form, one cell paragraph held **4,555 characters across 57 lines**. That is what "the whole thing is treated as one chunk" actually is, and formatting cannot help while it lasts: paragraph properties apply per paragraph, so 57 lines sharing one paragraph share one indent.

```
format.mjs <in> --op split-lines --section 0 --paragraph 6 --control 0 --cell 20 --paragraphs 5 --output out.hwp
```

Splitting runs from the last break backwards, so earlier offsets stay valid — the same reason `lib/blocks.mjs` splices in descending order. The engine leaves the newline at the head of the new paragraph, so it is removed. The command refuses to deliver if the cell's characters changed, since only the breaks should have become boundaries.

#### `--op indent --by-marker` — match what is already there

After splitting, the new paragraphs still carry the old convention. `--by-marker` **learns the mapping from the cell itself**: for each marker glyph it takes the most common `marginLeft` among paragraphs that already have one, then applies it to the ones that do not, stripping leading spaces so the text is flush and depth lives in `marginLeft` alone.

```
format.mjs <in> --op indent --section 0 --paragraph 6 --control 0 --cell 20 --by-marker --output out.hwp
  → learned from this cell: "◦" → marginLeft 14.1, "-" → marginLeft 27.4
```

**It copies the paragraph SHAPE, not the numbers.** `applyParaFormatInCell` *mints* a new paragraph shape rather than reusing one, and a minted shape can carry something rhwp does not report: a first version of this copied `marginLeft`, rhwp reported the copies as identical to their donors, and **Hancom rendered them further right with long lines running past the cell edge and clipping mid-word**. The cell had five paragraph shapes where three were intended. `setCellParaShapeId` points at the donor instead, so a matched paragraph renders identically to it by construction. Equal reported values are not equal shapes.

A paragraph that still carries leading spaces is not used as a donor — it is half-converted, and spreading a half-applied convention is worse than stopping.

It prints what it learned on stderr AND returns it as `learned` in the JSON result, so the inference is auditable both by a person reading the run and by a caller checking the output — including which path it took, since `learned` naming a shape id is the evidence it pointed at the donor rather than copying values. With nothing to learn from — no paragraph carrying both a glyph and a `marginLeft` — it **refuses** (exit 3) and says to format one by hand first, because inventing a convention would be worse than declining.

### `format.mjs --op char` / `--op para` — the `--props` vocabulary

`--op char` needs an explicit `--start`/`--end`; there is no whole-paragraph
shortcut. Get the length from `search.mjs --format json` (`length`) or count the
text yourself. `--op para` takes no range.

| op | keys |
|---|---|
| `char` | `bold` `italic` `underline` `strikethrough` `superscript` `subscript` `emboss` `engrave` (boolean) · `underlineType` (`None`\|`Bottom`\|`Top`) · `fontSize` (integer HWPUNIT, **1400 = 14pt**) · `textColor` (`"#RRGGBB"`, long form only) |
| `para` | `alignment` (`left`\|`center`\|`right`\|`justify`\|`distribute`) · `lineSpacingType` (`Percent`\|`Fixed`) · `lineSpacing` (integer — **percent under `Percent`, HWPUNIT under `Fixed`**) · `marginLeft` `marginRight` `indent` `spacingBefore` `spacingAfter` (integer HWPUNIT, negative `indent` = 내어쓰기) · `keepWithNext` `pageBreakBefore` `widowOrphan` `keepLines` (boolean) |

Every key there was confirmed by applying it alone and reading it back after a
save→reload. Anything else is a USAGE error naming the nearest valid key —
because the engine returns `{"ok":true}` for typos, wrong case, wrong types and
invalid enum values alike, and changes nothing. `--allow-unknown-props` sends a
key through anyway, with a warning.

**A font cannot be set by name.** `fontFamily` is accepted and ignored; the only
thing that changes a font is applying a style the document already carries.

**Unit trap:** these go in as HWPUNIT and the *getter* divides by 150, so read-back
numbers are 1/48 inch — 1.5 points, not one. `marginLeft: 2000` is 20pt and reads
back as `13.3`. Multiply by 1.5 before sending anything derived from getter output.

### Images — `image.mjs`

Detail and traps: **`reference/images.md`**.

**The engine's defaults are the layout bug.** A plainly inserted picture is
FLOATING and anchored to the paper corner (`treatAsChar:false`,
`vertRelTo/horzRelTo:"Paper"`, offsets 0), so several of them stack in the same
spot and shove the body text around — this is what "the agent put an image in
and the document fell apart" actually is. `image.mjs --op insert` makes images
**inline (`treatAsChar`) by default**; `--float` opts back in, loudly.

Sizes are **HWPUNIT (1/7200 inch), never pixels** — passing a 1600px width gives
a 5.6 mm stamp, and "converting" it at 96 dpi gives 2.8× the page. Omit
`--width` and it is fitted to the text area; give one that cannot fit and it is
**refused (exit 2), not clamped**.

Start with `--op list`: it reports which existing images are floating,
paper-anchored or wider than the text area, and never changes them.
