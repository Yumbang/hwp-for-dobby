# Editing — the safe path, in detail

`SKILL.md` routes; this is how each editing command behaves and what bites.

**Find/replace (`replace.mjs`) is the keystone.** It replaces across body text, table cells and textboxes in one pass, then reloads the saved file and confirms — `verified: true` means the change is really on disk, and that check, not the replace itself, is the guarantee. (Historical note for anyone reading older docs: up to engine 0.7.15 bulk replace was silently dropped on a genuine `.hwp` because the serializer's round-trip byte cache wasn't invalidated, and the skill routed around it with a search + delete/insert walk. Fixed upstream in 0.7.16; the workaround is gone.)

Every editing script (`edit_text`, `edit_cell`, `table`, `format`, `header_footer`, `footnote`, `fill_form`, `unlock`, `create`) follows the same contract: edit → atomic `.hwp` save → reload → verify → report `verified`. A `verified: false` result is a **failed task** (exit 5), never reported as success.

- **`fill_form.mjs`** — `--list` shows fields (`occurrence` / `sameNameCount`). `--values` fills them. A name that appears more than once must be written `name[N]` or the fill is refused as ambiguous — never silently fill only the first. `--dry-run` writes nothing. `--rows` + `--out-dir` fills one output per data row. **Empty fields fill cleanly.** Filling a **pre-populated** field warns about upstream bug #838 (char-shape not shifted → Hancom may reject) — visually verify those with `render.mjs`.
- **`edit_cell.mjs`** — `--table N` uses the same index as `extract_tables` (top-level tables). Or `--section/--paragraph/--control`. Address a cell by linear `--cell` index or by `--row/--col`. Out-of-range cell index is caught and reported (the raw engine call would throw). Covered (merged-away) positions are NOT_FOUND with a pointer at the origin.
- **`create.mjs`** — replays a JSON plan (`insert_text`, `insert_paragraph`, `create_table`, `insert_text_in_cell`) against a fresh blank document.

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
