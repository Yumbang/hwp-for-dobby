---
name: hwp
description: "Use this skill whenever the user wants to view, read, edit, fill, or create Korean HWP/HWPX documents (.hwp, .hwpx files — the native format of Hancom Office and the de facto standard for Korean public-sector forms). Triggers include: opening or summarizing an .hwp, finding/replacing text in an .hwp, filling a Korean government form (신청서, 보고서, 양식), building a new .hwp from scratch, extracting text/tables/images from .hwp, converting .hwp to text/markdown/PDF/PNG, inspecting .hwp structure, references to '한글 문서', '한컴 한글', 'HWP', 'HWPX', or casual mentions like 'the hwp in my downloads' / 'this 보고서 양식 they sent me' / '이거 한글 파일'. Use this skill even when the user does not explicitly say HWP, as long as the file extension is .hwp/.hwpx or the document is described as a Hangul/Hancom file. Do NOT use for .docx (use the docx skill), .xlsx (use xlsx), .pptx (use pptx), .pdf (use pdf), or .odt — only HWP and HWPX."
license: MIT (built on the rhwp engine — github.com/edwardkim/rhwp, MIT)
---

# HWP/HWPX viewing, editing, and creation

## Overview

This skill lets you view, edit, fill, and create HWP and HWPX documents — the document format used by Hancom Office and Korean public-sector workflows. All operations go through the rhwp engine via small Node.js helper scripts in `scripts/`. Vision-grade PNG rendering uses the `rhwp` CLI binary, which has the native skia raster path that the WASM build doesn't include.

Read first, edit second, verify visually third. The visual verification step matters more for HWP than for docx because Korean typography, page layout, and tab stops have rhwp engine corner cases that don't always show up in text extraction.

## ⚠️ Output policy: always `.hwp`, never `.hwpx`

**This skill's output format is always HWP 5.0 (`.hwp`).** The write scripts (`replace.mjs`, `fill_form.mjs`, `create.mjs`) refuse `--output *.hwpx` with exit 2. Reasons, both upstream engine facts:

1. **Native HWPX save is broken**: Hancom Office (한글 program) rejects rhwp-produced `.hwpx` files as "suspiciously manipulated" and refuses to open them. Verified on real samples in 2026-05; still unfixed as of rhwp v0.7.13.
2. **`.hwp` output is the engine's supported lane.** `exportHwp()` runs an HWPX→HWP adapter for HWPX-sourced docs, so **`.hwpx` INPUT is fully fine** — open an `.hwpx`, edit it, save it as `.hwp`. (Production evidence: hop, the rhwp-based desktop word processor, ships exactly this policy — HWP save enabled, HWPX save blocked.)

What this means per task type:

- **Read-only / extraction / vision tasks**: reliable, both formats — with one trap: plain text extraction **flattens tables**, which silently misplaces merged-cell values. For table data always use `extract_tables.mjs` (see "Structured table extraction" below).
- **Find/replace / structural edits**: save as `.hwp`. One residual engine bug remains — **HWP save can silently drop some edits** (`replaceAll` reports count=28 in-memory, the on-disk file shows zero). `replace.mjs` auto-detects this on reload and reports `verified: false`; treat that as a failed task. There is no `.hwpx` fallback.
- **Form filling**: save as `.hwp`. Filled values may inherit placeholder styling (red/bold/italic), and on pre-populated fields the current engine build can corrupt metadata (upstream #838, fixed on rhwp devel, not yet in our build) — visually verify the output.
- **Create-from-scratch**: reliable. A doc built fresh via `create.mjs` saves cleanly to `.hwp` and Hancom Office reads it.
- **Task requires `.hwpx` as the deliverable**: the engine cannot produce a Hancom-readable `.hwpx` today. Say so honestly instead of shipping a file Hancom will reject.

This is a fork of the rhwp engine; the bugs are upstream. Do not promise round-trip preservation that the engine can't deliver.

## Quick Reference

| Task | Approach |
|---|---|
| Inspect an unfamiliar file | `node scripts/info.mjs <input>` — JSON: pages, sections, fonts, dimensions |
| Read text content | `node scripts/read.mjs <input> --format text` (or `--format markdown`) |
| Extract table data (structured) | `node scripts/extract_tables.mjs <input>` — address/merge-aware grid, JSON or markdown |
| Quick visual preview (SVG) | `node scripts/read.mjs <input> --format svg --page N` |
| Vision-quality page image | `node scripts/render.mjs <input> --page N --output page.png` |
| Find/replace and save | `node scripts/replace.mjs <input> --query <q> --replacement <r> --output <out>` |
| List form fields | `node scripts/fill_form.mjs <input> --list` |
| Fill a form template | `node scripts/fill_form.mjs <input> --values values.json --output <out>` |
| Build a doc from scratch | `node scripts/create.mjs --plan plan.json --output <out>` |

All scripts are ESM; run them with Node 18+. They print structured JSON or extracted content on stdout, and exit non-zero on failure. Pipe stdout when you want to capture; let stderr surface to the user when something is wrong.

## Setup

The skill ships with the rhwp WASM bundle vendored under `vendor/rhwp/` — the parser, renderer, and edit API run in WASM via that bundle. No `npm install` needed at runtime. (Local dev keeps the same files in `node_modules/@rhwp/core/` so editor tooling/intellisense works; the runtime ignores it.)

The `rhwp` CLI binary improves two paths but is not strictly required:
1. `scripts/render.mjs` — PNG rendering via native skia. **Required** for PNG output (the WASM build doesn't have a raster path).
2. `scripts/read.mjs --format text|markdown` — text extraction is more accurate via the native path (markdown gets proper table grids, image references). **Optional**: when the CLI isn't found, `read.mjs` falls back automatically to WASM-based extraction via `getPageTextLayout`. Body text is intact on the fallback, but **tables are flattened to document-order cell text — a data-corruption hazard for merged cells, not a cosmetic one** (the script warns loudly when the document has tables). Table data must come from `extract_tables.mjs` instead, which needs no CLI.

Resolution order in `_resolve_cli.mjs`:
1. `$RHWP_BIN` env var
2. `vendor/bin/rhwp-<platform>-<arch>` (bundled, when packaged for distribution)
3. `rhwp` on `PATH`

If none resolve: `render.mjs` errors with install instructions; `read.mjs` silently falls back (with stderr note). Get the binary from https://github.com/edwardkim/rhwp/releases (v0.7.10+) when you need PNG output or grid-formatted markdown.

## Reading

Start every task that touches an existing document with `info.mjs`. The JSON tells you whether the file is HWP or HWPX, how many sections and pages exist, and which fonts are referenced. Section indices and page counts feed the other scripts.

```bash
node scripts/info.mjs document.hwp
```

For text:

```bash
node scripts/read.mjs document.hwp --format text                 # all pages, plain text
node scripts/read.mjs document.hwp --format markdown             # tables/images preserved
node scripts/read.mjs document.hwp --format text --page 0        # single page
```

For a quick structural look without spawning the CLI binary, use SVG:

```bash
node scripts/read.mjs document.hwp --format svg --page 0 > preview.svg
```

SVG output is structural-fidelity, not pixel-perfect. Don't trust it for typography decisions; use `render.mjs` PNG when fidelity matters.

## Structured table extraction

**Never read table data out of flattened text extraction.** A merged cell (`rowSpan`/`colSpan` > 1) is stored once, at its origin; in flattened document-order text it visually glues onto whichever cell happens to come next. Real-world failure: in a batch of 22 identical government forms, a student name spanning 7 merged rows kept attaching itself to a neighboring record's field — every record-oriented reading of flattened table text risks exactly this. The same hazard applies to `read.mjs` output on the WASM-fallback path (it warns on stderr when the document has tables) and to any ad-hoc "strip the XML tags" approach.

`extract_tables.mjs` is the safe path. It rebuilds each table as a row×col grid from cell addresses and span footprints, for both `.hwp` and `.hwpx`, with no CLI binary needed:

```bash
node scripts/extract_tables.mjs form.hwpx                      # all tables, JSON
node scripts/extract_tables.mjs form.hwpx --format markdown    # human-readable grids
node scripts/extract_tables.mjs form.hwpx --table 2            # one table (plus its nested tables)
node scripts/extract_tables.mjs form.hwpx --fill-merged        # replicate origin text into covered cells
```

JSON shape: `{input, sourceFormat, tableCount, tables: [{index, section, paragraph, rowCount, colCount, grid}]}` where `grid[r][c]` is `{text, rowSpan, colSpan, origin: true}` at a cell's origin, `{text, origin: false, originRow, originCol}` for positions covered by a span, or `null`. Nested tables (a table inside a cell) are discovered recursively and appear as separate entries with `nestedIn` + `hostCell`; the hosting cell's grid entry lists them in `nestedTables`. Cell text is NFC-normalized; in-cell paragraphs and line breaks arrive as real `\n`.

**`--fill-merged` is the flag for record extraction.** When a column like 성명 uses one merged cell per record (rowSpan = rows-per-record), filling makes every row self-contained, so grouping rows into records is a simple scan.

Reading Korean public-sector form tables, expect these conventions (interpret with judgment — they vary by form family):

- **Record boundaries** follow the merged cell in the 연번 (sequence) column: one record spans from a sequence origin row to the next.
- **Field content** inside a 상세내용 (detail) column comes in two styles: *marker form* (each row starts with ①②③…) or *label form* (`저자: …`, `DOI: …` with a colon). Both put each field on its own table **row**, not in one multi-line cell.
- **Legend/instruction tables ride along**: forms commonly append a 범례 (legend) or 작성요령 (instructions) table after the data table. Check header keywords (e.g. does the header row contain 연번?) before treating a table as data.
- **Empty-looking cells often hold placeholder text** (`번호`, `해당없음`, `-`, `X`, `;N` …) — template residue, not data. Filter by meaning, not just emptiness.
- **PUA characters** (U+E000–U+F8FF and beyond) are Hancom custom glyphs (checkboxes, symbols); they survive extraction as-is and may render as tofu. Treat them as symbols, not text.

Two engine caveats on the current vendored bundle (rhwp v0.7.10):

- **HWPX cell text loses literal `&`, `<`, `>`** — the engine's HWPX parser drops XML entities, so "R&D" reads as "RD" and `<사>` as `사`. The same document's `.hwp` version reads correctly; prefer the `.hwp` twin when both exist and ampersands/brackets matter. Fixed upstream in rhwp v0.7.12; goes away when the bundle is rebuilt.
- **Full-width spaces** (`hp:fwSpace`, 전각 공백) surface as U+2007 FIGURE SPACE, not U+3000 — match whitespace with `\s` rather than literal spaces.

## Editing existing documents

The HWP 5.0 format is a binary CFB container, and HWPX is ZIP-of-XML. Both go through `@rhwp/core`'s structured edit API — there is no "unpack and edit XML" path here. This is simpler than the docx skill: you call edit methods directly and the engine handles serialization.

### Find/replace

```bash
# replace first match
node scripts/replace.mjs in.hwp --query "2024년" --replacement "2025년" --output out.hwp

# replace all
node scripts/replace.mjs in.hwp --query "old" --replacement "new" --all --output out.hwp

# case-sensitive
node scripts/replace.mjs in.hwp --query "Term" --replacement "Item" --case-sensitive --output out.hwp
```

Output is always HWP 5.0 — `--output *.hwpx` is refused (exit 2; see the output-policy callout above). **The script exits non-zero with no match** so you can detect failed replacements; do not assume success.

### Round-trip verification

`replace.mjs` automatically verifies after save by reloading the output and searching for the original query. If it's still present, the script:
- sets `verified: false` in the JSON summary
- prints a warning on stderr telling you to treat the task as failed
- with `--strict`, exits non-zero (exit code 4)

`verified: false` means the engine accepted the edit in-memory but dropped it on save (upstream HWP serializer bug). **Report it to the user as a failed edit** — there is no alternate output format to fall back to.

### Structural edits beyond find/replace

For inserting text at a specific location, deleting, creating tables, or working with cells, headers, footers, footnotes, the edit methods are exposed on `HwpDocument` directly (see `vendor/rhwp/rhwp.d.ts` — search for `insertText`, `deleteText`, `createTable`, `insertTextInCell`, `insertTextInHeaderFooter`, `insertTextInFootnote`). v0 of this skill only ships a one-shot `create.mjs` for these. For a one-off edit beyond find/replace, write a short ad-hoc script that imports `loadDocument` from `scripts/_bootstrap.mjs` and calls the methods you need:

```js
import { loadDocument } from "./scripts/_bootstrap.mjs";
import { writeFileSync } from "node:fs";
const doc = await loadDocument("in.hwp");
doc.insertText(0, 5, 0, "삽입할 텍스트");        // section, paragraph, char-offset
doc.createTable(0, 6, 0, 3, 4);                    // section, paragraph, char, rows, cols
writeFileSync("out.hwp", Buffer.from(doc.exportHwp()));
```

This is the same pattern the helper scripts use; nothing magical.

## Form filling (한컴 Field API)

This is the killer use case for HWP. Korean public-sector forms ship with named fields that the original Hancom 웹기안기 fills via its action API. `@rhwp/core` exposes the same Field API to JavaScript.

```bash
# 1. discover what fields exist
node scripts/fill_form.mjs form.hwpx --list > fields.json

# 2. write a values.json with the fields you want to fill
#    (object keyed by field name)

# 3. apply (output must be .hwp — .hwpx input is fine)
node scripts/fill_form.mjs form.hwpx --values values.json --output filled.hwp
```

`values.json` example:

```json
{
  "신청자_성명": "홍길동",
  "신청자_연락처": "010-1234-5678",
  "신청일자": "2026-05-08"
}
```

If any field name doesn't exist in the document, the script writes `{applied, failed}` to stderr and exits non-zero. **Do not silently skip failed fields** — confirm the field list with `--list` first when the agent isn't sure.

## Creating from scratch

`scripts/create.mjs` consumes a JSON plan and produces an HWP/HWPX. The plan format is intentionally minimal:

```json
{
  "steps": [
    { "op": "insert_text", "section": 0, "para": 0, "char": 0, "text": "보고서 제목" },
    { "op": "insert_paragraph", "section": 0, "para": 1 },
    { "op": "insert_text", "section": 0, "para": 1, "char": 0, "text": "본문 첫 문단입니다." },
    { "op": "insert_paragraph", "section": 0, "para": 2 },
    { "op": "create_table", "section": 0, "para": 2, "char": 0, "rows": 3, "cols": 4 },
    { "op": "insert_text_in_cell", "section": 0, "para": 2, "control": 0, "cell": 0, "cell_para": 0, "char": 0, "text": "항목" },
    { "op": "insert_text_in_cell", "section": 0, "para": 2, "control": 0, "cell": 1, "cell_para": 0, "char": 0, "text": "Q1" },
    { "op": "insert_text_in_cell", "section": 0, "para": 2, "control": 0, "cell": 2, "cell_para": 0, "char": 0, "text": "Q2" },
    { "op": "insert_text_in_cell", "section": 0, "para": 2, "control": 0, "cell": 3, "cell_para": 0, "char": 0, "text": "Q3" }
  ]
}
```

Cells are addressed in **row-major** order: cell 0 is row 0 col 0, cell 1 is row 0 col 1, ... cell `cols` is row 1 col 0. **A blank `create_table` produces an empty table** — agents who want filled cells must emit `insert_text_in_cell` ops for each cell that has content. The user almost always wants cells filled when they ask for "a table about X"; ask if you're not sure.

```bash
node scripts/create.mjs --plan plan.json --output report.hwp
```

Steps run in order against a freshly-created empty document. The plan format is small on purpose — paragraph and char shape are not yet exposed; if you need them, write an ad-hoc script (see Editing section above).

## Visual verification

After any non-trivial edit or generation, render at least one page to PNG and look at it. Korean fonts, tab stops, and page layout have engine corner cases that text extraction won't catch.

```bash
node scripts/render.mjs filled.hwp --page 0 --output page0.png
```

The default `--vlm-target claude` sizes the PNG for Claude Vision (~1568px longest edge, ~1.15 MP). For higher fidelity:

```bash
node scripts/render.mjs filled.hwp --page 0 --output page0.png --scale 2.0
node scripts/render.mjs filled.hwp --page 0 --output page0.png --max-dimension 2400
```

Then read the PNG back and confirm the layout is what was expected. **Do not declare an edit task complete without visually verifying at least the page that was changed.** This is the single biggest reliability win for HWP work; treat it as part of the task, not as optional polish.

## Common pitfalls

- **Trying to write `.hwpx`.** All write scripts refuse `--output *.hwpx` (exit 2) — native HWPX save produces files Hancom Office rejects. Always emit `.hwp`, even when the input was `.hwpx`. If the user explicitly asks for an `.hwpx` deliverable, explain the engine limitation instead of working around the guard with an ad-hoc `exportHwpx()` call.
- **Reading table data from flattened text.** Merged cells are stored once at their origin; flattened extraction (WASM-fallback `read.mjs`, naive XML stripping) glues that text onto the wrong neighbor — records silently absorb other records' values. Always use `extract_tables.mjs` for table data, and `--fill-merged` when grouping rows into records.
- **macOS Korean filenames are NFD.** Files saved on macOS carry decomposed Hangul names (`한글.hwpx` as `ㅎ+ㅏ+ㄴ…`), so a glob/comparison against an NFC literal in your code silently matches **zero files**. Don't glob with Korean literals — scan the directory and compare with `name.normalize("NFC")` (Node) / `unicodedata.normalize("NFC", name)` (Python).
- **Not visually verifying.** Text extraction can pass while the actual page is broken (missing characters, overflowing tables, font fallback issues). Render PNG and look.
- **Assuming replace succeeded.** `replace.mjs` exits non-zero on no-match. Check exit codes; do not chain blindly.
- **Trusting exit 0 alone on HWP output.** Because of the HWP edit-loss bug, `replace.mjs` can exit 0 with `replaced: N` while the saved `.hwp` actually contains zero of the new strings. **Always read the `verified` field from `replace.mjs`'s JSON output before telling the user the edit succeeded.** `verified: false` means the engine accepted the edit in-memory but the saved file does not show it on reload — treat that as a failed task, not a successful one. Use `--strict` if you want non-zero exit on `verified: false` (exit code 4).
- **`replaceOne` skips tables and textboxes.** Without `--all`, the engine only searches the body. If your target is inside a table cell or text box and you don't pass `--all`, you'll get a no-match error even though the string is visibly present. `--all` covers everything; use it whenever in doubt.
- **`createBlankDocument` is required after `createEmpty`.** A bare `createEmpty()` produces a doc with zero sections, so `insertText(0, 0, 0, ...)` fails. The bootstrap helper does this for you; if you call `createEmpty` directly, you must follow with `createBlankDocument()`.
- **Newlines in `insert_text` don't split paragraphs.** Each `insert_text` writes into one paragraph. To start a new paragraph, emit `insert_paragraph` first. This matches the engine's IR — paragraphs are first-class structural units, not delimited by `\n`.
- **`rhwp export-text` strips whitespace inside Korean runs.** "주관 기관" extracts as "주관기관". Do not grep extracted text to verify replacements that introduce or remove spaces around CJK characters — render PNG and inspect, or rely on `replace.mjs`'s built-in `verified` field (which uses the in-memory search API, not export-text).
- **`render.mjs --scale 2.0` can exceed the engine's raster size limit** with `RenderError("raster width out of range: 1588")`. Prefer `--max-dimension <N>` to cap the longer edge — it's calculated against the actual page geometry and won't blow past engine limits.
- **Form fields inherit placeholder character runs.** When `setFieldValueByName` overwrites a placeholder, the new text adopts the placeholder's color/bold/font. The text is correct; styling may not match surrounding body. If consistent styling matters, follow up with a separate char-shape command (not yet exposed in the helper scripts — drop to an ad-hoc script).
- **Field name mismatches.** Always run `--list` before `--values` if the field names weren't user-provided. Korean field names often have leading/trailing whitespace, internal hangul, or composed-vs-decomposed forms that look identical but compare differently.
- **Forgetting page count is 0-indexed in the API but human pages are 1-indexed.** All `--page` flags are 0-indexed. When the user says "page 5" they usually mean `--page 4`.
- **Coordinates: section/para/char triplet.** Many edit APIs take `(section_idx, para_idx, char_offset)`. Use `info.mjs` to find sections, then SVG preview or PNG render to identify paragraphs visually.

## Dependencies

- **Node.js ≥ 18** with native ESM support
- **rhwp WASM bundle ≥ 0.7.10** (vendored under `vendor/rhwp/` — `rhwp.js` + `rhwp_bg.wasm`)
- **`rhwp` CLI ≥ 0.7.10** for `render.mjs`, and for `read.mjs --format text|markdown` (resolution: `$RHWP_BIN` → `vendor/bin/` → `PATH`)

The skill depends on no other system tools — no LibreOffice, no pandoc, no poppler. The rhwp engine handles HWP↔HWPX, text/markdown extraction, SVG, and PNG natively.

Engine reference: https://github.com/edwardkim/rhwp (MIT). This skill targets v0.7.10.
