# Images — command detail and traps

Read this before using `src/core/image.mjs` for anything beyond `--op list`.
`SKILL.md` says when to reach for it; this file is why the obvious call is wrong.

## The engine's defaults ARE the layout bug

A picture inserted the plain way comes out like this — measured, not guessed:

```
treatAsChar : false        not part of the text
vertRelTo   : "Paper"      anchored to the sheet, not the paragraph
horzRelTo   : "Paper"
vertOffset  : 0            so every image lands in the same corner…
horzOffset  : 0
textWrap    : "Square"     …and shoves the body text around it
```

That is why a naive insert "destroys the document": the images are not in the
text at all. `image.mjs --op insert` therefore sets `treatAsChar: true` by
default, which also flips `vertRelTo`/`horzRelTo` to `"Para"`. `--float` opts
back into the engine's behaviour, with a warning.

## `treatAsChar` alone does not persist the anchor

Setting `{treatAsChar: true}` flips `vertRelTo`/`horzRelTo` to `"Para"` **in
memory** — and they revert to `"Paper"` on save→reload. Only an explicit set
survives:

```js
setPictureProperties(s, p, c, JSON.stringify({
  treatAsChar: true, vertRelTo: "Para", horzRelTo: "Para",   // all three
}));
```

Measured. Reading the property back before saving reports `"Para"` and is a lie
about what will be on disk, which is why `image.mjs` re-reads the SAVED file and
fails (exit 5) if an inline image is still paper-anchored there.

## Units: HWPUNIT, not pixels

`insertPicture`'s `width`/`height` are **HWPUNIT = 1/7200 inch**.

| What you pass for a 1600px-wide image | Result |
|---|---|
| `1600` (the pixel count) | 1600 HWPUNIT ≈ **5.6 mm** — a postage stamp |
| `120000` (1600px "at 96 dpi") | **2.8× the usable width** — the layout explodes |
| what `image.mjs` computes | fits the text area, aspect ratio preserved |

A4 geometry from `getPageDef(0)`:

```
width 59528 − marginLeft 8504 − marginRight 8504 = 42520 HWPUNIT usable
```

`lib/image_layout.mjs` owns this arithmetic. `--width` is honoured exactly when
it fits and **REFUSED (exit 2) when it does not** — never silently clamped,
because a caller who asked for a specific width and quietly got another is how
the layout breaks without anyone noticing. Omit `--width` to have it fitted.

## Replacing an image keeps the formatting — except the crop

`--op replace` uses `assignPictureImage`, which preserves `width`, `height`,
`treatAsChar`, `borderWidth` and `description`.

**It resets the crop** (`cropLeft` 100 → 0, verified). So `image.mjs` reads the
crop before the swap and writes it back after. If you ever call the engine
directly, do the same or "replace the picture, keep the formatting" silently
loses it.

## Captions are addressed like a table cell

`setPictureProperties({hasCaption: true})` returns `{"ok":true,"captionCharOffset":N}`.

**The trap: `captionCharOffset` is not a body offset.** Writing there with
`insertText` lands in the BODY — verified, `"앞 문단"` became
`"앞 문단그림 1. 캡션 텍스트"`. The caption is a text container hanging off the
picture control, reachable as **cell 0, paragraph 0**:

```js
const path = JSON.stringify([{ controlIndex: c, cellIndex: 0, cellParaIndex: 0 }]);
doc.getTextInCellByPath(s, p, path, 0, len);
doc.insertTextInCellByPath(s, p, path, 0, "그림 1. 연도별 매출");
```

Enabling a caption **auto-creates the default text `"그림  "`**, so clear it
before writing or the result reads `"그림  그림 1. …"`. `--caption` does this
for you. Captions survive export→reload.

## `insertPictureEx` ignores `treatAsChar`

Passing `treatAsChar: true` in `insertPictureEx`'s options JSON returns
`{"ok":true}` and leaves it `false`. Insert first, then `setPictureProperties`.
This is the same family of silent no-op as the character/paragraph format props
(spec rule 54) — the engine reports success for fields it does not act on.

## `--op list` reports hazards, it does not fix them

`list` flags an image as risky when it is floating, paper-anchored, or wider
than the text area. It never re-anchors anything: silently moving a logo that
somebody placed deliberately is its own kind of damage. Fix with an explicit
`--op replace` or by re-inserting.

## Finding a picture's control index

Probe `getPictureProperties(s, p, c)` across the indices from
`getControlTextPositions(s, p)`. **Never assume control 0** — paragraph 0 of
every section carries invisible SectionDef/ColumnDef controls, so the first
real object is rarely index 0. After `insertPicture`, use the `controlIdx` the
engine returns rather than a guess.

## Natural pixel size is the caller's job

`insertPicture` takes `naturalWidthPx`/`naturalHeightPx` and does not decode the
file to find them. `image.mjs` reads them from the image header (PNG, JPEG, GIF,
BMP) and refuses the insert if it cannot — an unknown size would mean inserting
at the wrong aspect ratio.

## Exit codes

| Code | When |
|---|---|
| 0 | done (`list` with zero images is still 0) |
| 1 | input or image file unreadable, or its dimensions unparseable |
| 2 | bad arguments, unsupported image type, or `--width` too wide to fit |
| 3 | `--index N` names no image |
| 5 | the edit did not survive save→reload, or an insert failed to become inline |
| 6 | refused: the document has memos or tracked changes the engine would destroy |
