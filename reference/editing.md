# Editing — the safe path, in detail

`SKILL.md` routes; this is how each editing command behaves and what bites.

**Find/replace (`replace.mjs`) is the keystone.** It replaces across body text, table cells and textboxes in one pass, then reloads the saved file and confirms — `verified: true` means the change is really on disk, and that check, not the replace itself, is the guarantee. (Historical note for anyone reading older docs: up to engine 0.7.15 bulk replace was silently dropped on a genuine `.hwp` because the serializer's round-trip byte cache wasn't invalidated, and the skill routed around it with a search + delete/insert walk. Fixed upstream in 0.7.16; the workaround is gone.)

Every editing script (`edit_text`, `edit_cell`, `table`, `format`, `header_footer`, `footnote`, `fill_form`, `unlock`, `create`) follows the same contract: edit → atomic `.hwp` save → reload → verify → report `verified`. A `verified: false` result is a **failed task** (exit 5), never reported as success.

- **`fill_form.mjs`** — `--list` shows fields (`occurrence` / `sameNameCount`). `--values` fills them. A name that appears more than once must be written `name[N]` or the fill is refused as ambiguous — never silently fill only the first. `--dry-run` writes nothing. `--rows` + `--out-dir` fills one output per data row. **Empty fields fill cleanly.** Filling a **pre-populated** field warns about upstream bug #838 (char-shape not shifted → Hancom may reject) — visually verify those with `render.mjs`.
- **`edit_cell.mjs`** — `--table N` uses the same index as `extract_tables` (top-level tables). Or `--section/--paragraph/--control`. Address a cell by linear `--cell` index or by `--row/--col`. Out-of-range cell index is caught and reported (the raw engine call would throw). Covered (merged-away) positions are NOT_FOUND with a pointer at the origin.
- **`edit_text.mjs --format`** — inserted text is not neutral. `insertText` has no formatting argument, so the engine gives new characters the formatting of the character **before** the insertion point (at offset 0, the one after). Insert a sentence beside a bold heading and the whole sentence arrives bold. `--format` takes the same character-property JSON as `format.mjs --op char` — one vocabulary, so what you read back can be written straight in — and formats only the characters that were inserted. The span is measured from the engine (paragraph length before vs after), never from `text.length`, because JS counts a surrogate pair as two units and the document counts it as one; `"테스트🙂끝"` is 6 in JS and 5 on the page. `--format` is refused on `--op delete` and `--op insert-paragraph`: the latter creates an *empty* paragraph, and character formatting on a paragraph with no characters is silently ignored — insert the paragraph, then insert its text with `--format`. A tab inside the inserted text keeps its own (absent) formatting; you get a warning. The result carries `effect`, the same per-key verdict `format.mjs` reports, read back from the saved file.
- **`format.mjs --op bullet`** — Korean 개조식 lists are written two ways, and the format's own feature is the one used *less*: across 70 real documents, 274 paragraphs start with a typed `□`/`○`/`-` against 146 that use `headType: "Bullet"`, and only 4 documents use the feature at all. So `--mode auto` (the default) follows what the document already does — a file with any real bullet gets `hwp`, everything else gets the glyph convention. `--paragraphs` takes `6`, `6-9` (inclusive) or `6,8,11`, because fixing a list means fixing twenty paragraphs. `--level N` is depth: `paraLevel` in `hwp` mode, N leading **spaces** in `text` mode (the corpus indents markers with 1,137 spaces against 3 tabs, and `marginLeft` is 0 in 85% of them). Setting a bullet on a paragraph that already has one **replaces** the marker rather than stacking a second in front of it. `--remove` deliberately clears **both** mechanisms whatever the mode, because one paragraph can carry a glyph *and* a `headType`, and "headType is no longer Bullet" is trivially true of a paragraph that never had one — clearing only one would leave a visible `□` behind and report success. If nothing in the range was bulleted you get a warning naming the range, not a silent success. `--char` must be a single character: the engine keeps only the first character of a longer string and **crashes the WASM heap** on a number or object.
- **`format.mjs --op indent`** — changing an indent level looks like moving `marginLeft`, and real documents mostly do not. Across 1,328 marker paragraphs, leading **spaces** beat `marginLeft` 37% to 12%, `marginLeft` is 0 in 85% of them, and half carry no indent signal at all because the glyph itself (`□` vs `○`) is the depth. `--scheme auto` (the default) picks `margin` only when the document clearly uses it, otherwise `space`. **You usually do not need this after `--op bullet`:** in `text` mode `--op bullet --char X --level N` replaces the whole existing prefix — leading whitespace, glyph and gap — with `N spaces + X + space` AND sets the matching hanging indent, so one call normalises glyph and depth together. Reach for `--op indent` when you want to change depth *without* touching the glyph, or to use the `margin` scheme. In `space` scheme the marker glyph is preserved and only moved, never rewritten. **Spaces and a hanging indent are set together**, because they do different jobs — the spaces push the marker right, the negative `indent` pulls wrapped lines back under the text after it — and 91% of space-indented paragraphs long enough to wrap set both. Spaces alone would wrap long lines to column 0, a visible break; `--no-hanging` opts out explicitly. A paragraph with no marker gets spaces but no hang, since a hang on prose is just a broken first line. **Unit trap:** `marginLeft`/`indent` go in as HWPUNIT but the getter divides by 150, so its numbers are 1/48 inch — 1.5 points, not one. `marginLeft: 2000` is 20pt and reads back as `13.3`. Anything derived from getter output and sent back needs the 1.5, and the first version of this code missed it and produced hanging indents two thirds of the intended size.
- **`edit_text.mjs --op insert-paragraph`** — `--paragraph N` inserts the new empty paragraph AT index N, pushing the rest down. Its upper bound is inclusive: passing the current paragraph COUNT appends at the end, which is how you add a line after the last one. Every other op's `--paragraph` is bounded by `count - 1`.
- **`create.mjs`** — replays a JSON plan (`insert_text`, `insert_paragraph`, `create_table`, `insert_text_in_cell`) against a fresh blank document.

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
