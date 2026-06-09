---
name: hwp
description: "Use this skill whenever the user wants to view, read, edit, fill, or create Korean HWP/HWPX documents (.hwp, .hwpx files — the native format of Hancom Office and the de facto standard for Korean public-sector forms). Triggers include: opening or summarizing an .hwp, finding/replacing text in an .hwp, filling a Korean government form (신청서, 보고서, 양식), building a new .hwp from scratch, extracting text/tables/images from .hwp, converting .hwp to text/markdown/PDF/PNG, inspecting .hwp structure, references to '한글 문서', '한컴 한글', 'HWP', 'HWPX', or casual mentions like 'the hwp in my downloads' / 'this 보고서 양식 they sent me' / '이거 한글 파일'. Use this skill even when the user does not explicitly say HWP, as long as the file extension is .hwp/.hwpx or the document is described as a Hangul/Hancom file. Do NOT use for .docx (use the docx skill), .xlsx (use xlsx), .pptx (use pptx), .pdf (use pdf), or .odt — only HWP and HWPX."
license: MIT (built on the rhwp engine — github.com/edwardkim/rhwp, MIT)
---

# HWP/HWPX viewing, editing, and creation

## Overview

This skill views, edits, fills, and creates HWP and HWPX documents — the format of Hancom Office and Korean public-sector workflows. It wraps the **rhwp** engine (Rust→WASM, vendored under `vendor/rhwp/`, pinned to **0.7.15**) with small Node.js scripts.

**Read first, edit second, verify third.** Every edit is confirmed by reloading the saved file — the engine has corner cases (documented in `spec/rhwp-behavior.md`) where an in-memory edit can be silently dropped, so "it returned ok" is not proof. The scripts do this verification for you and report `verified: true/false`.

### Two tiers — what works where

| Tier | Scripts | Runs on |
|---|---|---|
| **core** (`src/core/`) | read, extract_tables, info, replace, edit_text, edit_cell, table, format, header_footer, footnote, fill_form, unlock, create | **WASM only → every platform** (claude.ai, cowork, Claude Code). No install, no binary. |
| **enhanced** (`src/enhanced/`) | render (PNG), export_pdf, read_precise (CLI text/markdown), debug (ir-diff/dump) | **native rhwp CLI → Claude Code only.** Degrades with exit 4 + a clear message elsewhere. |

All read/edit/create works everywhere on the core tier. The enhanced tier only adds vision-grade PNG, PDF, precise extraction, and IR debugging, and only when the `rhwp` binary is on `PATH` (or `$RHWP_BIN`). If an enhanced script exits `4`, you're not on Claude Code or the binary isn't installed — fall back to a core script and tell the user.

## ⚠️ Output policy: always `.hwp`, never `.hwpx`

Output is **always HWP 5.0 (`.hwp`)**. Native HWPX save is rejected by Hancom Office ("파일 손상"), so every write script refuses `--output *.hwpx` with exit 2. **`.hwpx` INPUT is fully supported** — the engine runs an HWPX→HWP adapter on export. So: open an `.hwpx`, edit it, save it as `.hwp`.

## Quick Reference (routing: task → script)

| Task | Command |
|---|---|
| Inspect an unfamiliar file | `node src/core/info.mjs <in> [--validate]` |
| Read body text | `node src/core/read.mjs <in> --format text` |
| **Extract table DATA (safe)** | `node src/core/extract_tables.mjs <in> [--format json\|markdown] [--data-tables-only] [--drop-empty] [--detect-form-type]` |
| Find & replace (safe, saves) | `node src/core/replace.mjs <in> --query <q> --replacement <r> --output <out.hwp>` |
| Insert/delete body text | `node src/core/edit_text.mjs <in> --op insert\|delete\|insert-paragraph ... --output <out.hwp>` |
| Edit a table cell | `node src/core/edit_cell.mjs <in> --op insert\|delete\|set --section N --paragraph N --control N (--cell N\|--row R --col C) --text "..." --output <out.hwp>` |
| Create/merge/split a table | `node src/core/table.mjs <in> --op create\|merge\|split ... --output <out.hwp>` |
| Char/paragraph formatting | `node src/core/format.mjs <in> --op char\|para ... --props '<json>' --output <out.hwp>` |
| Header/footer | `node src/core/header_footer.mjs <in> --op create\|apply ... --output <out.hwp>` |
| Footnote | `node src/core/footnote.mjs <in> --op insert\|delete ... --output <out.hwp>` |
| List / fill form fields | `node src/core/fill_form.mjs <in> --list` · `... --values vals.json --output <out.hwp>` |
| Unlock read-only doc | `node src/core/unlock.mjs <in> --output <out.hwp>` |
| Build a doc from scratch | `node src/core/create.mjs --plan plan.json --output <out.hwp>` |
| **Vision-quality PNG** (code) | `node src/enhanced/render.mjs <in> --page N --output page.png` |
| **PDF export** (code) | `node src/enhanced/export_pdf.mjs <in> --output out.pdf` |
| **Precise text/markdown** (code) | `node src/enhanced/read_precise.mjs <in> --format text\|markdown` |
| IR/layout debug (code) | `node src/enhanced/debug.mjs <in> --op dump\|dump-pages\|ir-diff\|thumbnail ...` |

Scripts are ESM (Node 18+), print one-line JSON or extracted content on stdout, and exit non-zero on failure. Exit codes are uniform: **0** ok · **1** load/parse · **2** usage / bad output target · **3** target not found · **4** unsupported here (enhanced needs the CLI) · **5** engine-detected corruption / round-trip verify failed.

## When NOT to use this skill

- `.docx` → docx skill · `.xlsx` → xlsx · `.pptx` → pptx · `.pdf` → pdf · `.odt` → not supported.
- **Producing a Hancom-readable `.hwpx`** — the engine can't; we only emit `.hwp`. Say so honestly.
- **Reading table data off flattened text** — never. Use `extract_tables.mjs` (address/merge-aware). `read.mjs` strict mode refuses to flatten tables for exactly this reason.
- Shape/textbox/chart insertion and style systems — not supported on this engine build (documented gap).

## Setup

The rhwp WASM bundle ships vendored under `vendor/rhwp/` — no `npm install` needed at runtime. The enhanced tier additionally needs the `rhwp` CLI binary, resolved as `$RHWP_BIN` → `vendor/bin/rhwp-<platform>` → `rhwp` on `PATH`. If it's absent, core works; enhanced exits 4.

## Reading & extraction

- **`info.mjs`** — JSON summary (pages, sections, sourceFormat, fonts, dimensions, hasTable, field count, engine version). `--validate` adds `getValidationWarnings()` so you can spot a structurally suspect source before extracting.
- **`read.mjs`** — body text (WASM). **Strict by default**: it does NOT flatten tables (which would misplace merged-cell text); each table becomes a `[table: use extract_tables.mjs for data]` marker plus a stderr warning. `--mode best-effort` flattens inline (with a warning) if you really want it. `--format svg --page N` for a quick visual preview.
- **`extract_tables.mjs`** — the ONLY safe way to read table data. Rebuilds the grid by cell `{row,col,rowSpan,colSpan}` so a merged cell never leaks onto the wrong record. Flags: `--data-tables-only` (drop legend/작성요령 tables by header keyword, conservative), `--drop-empty` (normalize placeholders 번호/해당없음/-/X to ""), `--detect-form-type` (annotate marker ①②/label/plain), `--fill-merged`, `--table N`, `--no-nested`.
- **`read_precise.mjs`** (enhanced) — accurate text/markdown via the CLI, with real table grids in markdown. Use on Claude Code when you need a faithful markdown rendering.

## Editing — the safe path

**Find/replace (`replace.mjs`) is the keystone.** On a genuine `.hwp`, the engine's bulk `replaceAll` silently drops edits on save (it doesn't invalidate the serializer's round-trip cache). `replace.mjs` routes around this automatically: `.hwpx` input → engine `replaceAll` (safe); `.hwp` input → locate every hit with `searchAllText` (body + cells) and rewrite with delete+insert primitives that DO persist. It then reloads and confirms — `verified: true` means the change is really on disk.

Every editing script (`edit_text`, `edit_cell`, `table`, `format`, `header_footer`, `footnote`, `fill_form`, `unlock`, `create`) follows the same contract: edit → atomic `.hwp` save → reload → verify → report `verified`. A `verified: false` result is a **failed task** (exit 5), never reported as success.

- **`fill_form.mjs`** — `--list` shows fields; `--values` fills them. **Empty fields fill cleanly.** Filling a **pre-populated** field warns about upstream bug #838 (char-shape not shifted → Hancom may reject) — visually verify those with `render.mjs`.
- **`edit_cell.mjs`** — address a cell by linear `--cell` index or by `--row/--col`. Out-of-range cell index is caught and reported (the raw engine call would throw).
- **`create.mjs`** — replays a JSON plan (`insert_text`, `insert_paragraph`, `create_table`, `insert_text_in_cell`) against a fresh blank document.

## Verify outputs after every run

- **Edits**: trust the `verified` field, not the exit code alone. `verified: true` = the change survived save→reload. If `false`, the engine couldn't do it — tell the user; do not claim success.
- **Table data**: came from `extract_tables.mjs` (address-aware), never from flattened text.
- **Visual fidelity** (Korean typography, tab stops, form styling): on Claude Code, render a page with `render.mjs` and look at it. This matters more for HWP than for docx.
- **Forms**: after filling, re-list or render to confirm values landed and aren't wearing placeholder styling.

## Done when

- The requested read/extraction/edit/creation produced its output, and for any edit the script reported `verified: true`.
- Table data was read structurally (no flattening).
- If the deliverable required `.hwpx` output or an unsupported op, you said so honestly instead of shipping something Hancom will reject.

## Failure modes (per the behavioral spec)

| Symptom | Cause | What to do |
|---|---|---|
| `verified: false` after an edit | engine dropped the edit on save | report honestly; for `.hwp` find/replace this should not happen (we route around it) — if it does, the input may be unusual |
| exit `4` from an enhanced script | no `rhwp` CLI (not on Claude Code) | use a core script; tell the user PNG/PDF/precise-read need Claude Code + the binary |
| exit `2` on `--output x.hwpx` | HWPX output is blocked | save as `.hwp` |
| exit `5` on form fill | filled value didn't survive | the field/doc is problematic; surface it |
| Hancom rejects a filled form | pre-filled field char-shape (#838) | warn was printed; fill empty fields only, or accept the risk and visually verify |
| merged-cell data looks shifted | table read from flattened text | re-read with `extract_tables.mjs` |
| `R&D` etc. special chars | (was a ≤0.7.11 bug) | fine on 0.7.15 — `&`/`<`/`>` preserved |

## Behavioral Guarantee Matrix (summary — full spec in `spec/rhwp-behavior.md`)

| Operation | genuine `.hwp` | `.hwpx` input |
|---|---|---|
| read tables (address grid) | WORKS | WORKS |
| body edit / safe find-replace | WORKS | WORKS |
| in-cell edit | WORKS | WORKS |
| form fill — empty field | WORKS | WORKS |
| form fill — pre-filled field | WORKS+WARN (#838) | WORKS+WARN |
| create from scratch | WORKS (→ `.hwp`) | — |
| `replaceAll` (raw engine) | **FAILS-SILENTLY** — never used directly | WORKS |
| save as HWPX | **BLOCKED** (Hancom-rejected) | BLOCKED |

Engine pinned to rhwp **0.7.15** (`vendor/rhwp/VERSION`). Known live limitations on this build: `replaceAll`-drop (routed around), form #838 (warned), shapes/charts not supported. The full, test-backed rule set is in `spec/rhwp-behavior.md`; `test/` enforces it.
