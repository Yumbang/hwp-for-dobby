---
name: hwp-for-dobby
description: "Read, edit, fill, create, outline and section-extract Korean HWP/HWPX documents (.hwp, .hwpx — Hancom Office 한글, the standard for Korean public-sector forms). Use for: opening or summarizing an .hwp; find/replace; filling a form (신청서, 보고서, 양식); building one from scratch; extracting text, tables or images; converting to text/markdown/PDF/PNG. Also for STRUCTURE: 'extract section 4.3', '§3.2', '제12조', '4.3절만 뽑아줘', outline/목차 a document, split it by section for per-section review or to feed subagents, and 'what changed since last week' / '지난주 대비 뭐가 바뀌었어' (snapshot + diff). Also to read TRACKED CHANGES (변경 내용 추적) — a plain reader silently mixes deleted text into the body — plus memos/주석, footnotes and equations. Triggers on '한글 문서', '한컴 한글', HWP, HWPX, or 'the hwp in my downloads' / '이거 한글 파일' — even when the user never says HWP, as long as the file is .hwp/.hwpx. NOT for .docx (use docx or docx-section-extractor), .xlsx, .pptx, .pdf or .odt."
license: MIT (built on the rhwp engine — github.com/edwardkim/rhwp, MIT)
---

# HWP/HWPX viewing, editing, and creation

## Overview

This skill views, edits, fills, and creates HWP and HWPX documents — the format of Hancom Office and Korean public-sector workflows. It wraps the **rhwp** engine (Rust→WASM, vendored under `vendor/rhwp/`, pinned to **0.7.19**) with small Node.js scripts.

**Read first, edit second, verify third.** Every edit is confirmed by reloading the saved file — the engine has corner cases (documented in `spec/rhwp-behavior.md`) where an in-memory edit can be silently dropped, so "it returned ok" is not proof. The scripts do this verification for you and report `verified: true/false`.

### Two tiers — what works where

| Tier | Scripts | Runs on |
|---|---|---|
| **core** (`src/core/`) | read, sections, extract_tables, extract_data, search, info, replace, edit_text, edit_cell, table, format, header_footer, footnote, fill_form, unlock, create | **WASM only → every platform** (claude.ai, cowork, Claude Code). No install, no binary. |
| **enhanced** (`src/enhanced/`) | render (PNG), export_pdf, read_precise (CLI text/markdown), debug (ir-diff/dump) | **native rhwp CLI → Claude Code only.** Degrades with exit 4 + a clear message elsewhere. |

All read/edit/create works everywhere on the core tier. The enhanced tier only adds vision-grade PNG, PDF, precise extraction, and IR debugging, and only when the `rhwp` binary is on `PATH` (or `$RHWP_BIN`). If an enhanced script exits `4`, you're not on Claude Code or the binary isn't installed — fall back to a core script and tell the user.

## ⚠️ Output policy: always `.hwp`, never `.hwpx`

Output is **always HWP 5.0 (`.hwp`)**. Native HWPX save is rejected by Hancom Office ("파일 손상"), so every write script refuses `--output *.hwpx` with exit 2. **`.hwpx` INPUT is fully supported** — the engine runs an HWPX→HWP adapter on export. So: open an `.hwpx`, edit it, save it as `.hwp`.

## Quick Reference (routing: task → script)

| Task | Command |
|---|---|
| Inspect an unfamiliar file | `node src/core/info.mjs <in> [--validate]` then `extract_tables.mjs --summary` (table sizes, no cell text) |
| Read body text | `node src/core/read.mjs <in> --format text` (default: section snapshot + since-last-read diff on stderr; `--no-snapshot` to skip; `--max-chars N` truncates honestly) |
| Read memos (메모/주석) | `node src/core/read.mjs <in> --memos` |
| Read tracked changes (변경 내용 추적) | `node src/core/read.mjs <in> --track-changes [--format text\|json]` |
| **Document STRUCTURE** (outline · §4.3 · split · diff) | `node src/core/sections.mjs <in> --op outline\|extract\|split\|snapshot\|diff [--id 2.3.1\|제12조\|T0] [--out-dir <dir>]` |
| **Extract table DATA (safe)** | `node src/core/extract_tables.mjs <in> [--format json\|markdown\|csv] [--summary] [--table N] [--data-tables-only] [--drop-empty] [--detect-form-type]` |
| Search with page/cell address | `node src/core/search.mjs <in> --query <q> [--limit N] [--format json]` (0 hits = exit 0) |
| Dates / amounts with address | `node src/core/extract_data.mjs <in> [--kind date\|amount\|number\|all]` |
| Find & replace (safe, saves) | `node src/core/replace.mjs <in> --query <q> --replacement <r> --output <out.hwp>` |
| Insert/delete body text | `node src/core/edit_text.mjs <in> --op insert\|delete\|insert-paragraph ... [--format '<char props>'] --output <out.hwp>` — **inserted text inherits the formatting of the character before it**; `--format` overrides that |
| Edit a table cell | `node src/core/edit_cell.mjs <in> --op set --table N --row R --col C --text "..." --output <out.hwp>` (same `index` as extract_tables; or `--section/--paragraph/--control`) |
| **Images** (list · insert · replace · caption) | `node src/core/image.mjs <in> --op list\|insert\|replace\|remove [--file img.png] [--index N] [--caption "..."] --output <out.hwp>` |
| Create/merge/split a table | `node src/core/table.mjs <in> --op create\|merge\|split ... --output <out.hwp>` |
| **Formatting** (inspect · char · para · bullets · indent) | `node src/core/format.mjs <in> --op list\|char\|para\|bullet\|indent ...` — **start with `--op list`**: it reports the shapes a document uses and where they disagree, changes nothing, and decides nothing. `--op bullet --paragraphs 6-9 --char '□' [--remove]` · `--op indent --paragraphs 6-9 --level N`. Korean lists use a typed glyph ~2x more than HWP's bullet feature, and depth is leading SPACES ~3x more than `marginLeft`; `auto` follows the document |
| Header/footer | `node src/core/header_footer.mjs <in> --op create\|apply ... --output <out.hwp>` |
| Footnote | `node src/core/footnote.mjs <in> --op insert\|delete ... --output <out.hwp>` |
| List / fill form fields | `node src/core/fill_form.mjs <in> --list` · `--values vals.json --output <out.hwp>` · duplicate names use `name[N]` · `--dry-run` · `--rows file.jsonl --out-dir dir/` |
| Unlock read-only doc | `node src/core/unlock.mjs <in> --output <out.hwp>` |
| Build a doc · **batch-apply many edits** | `node src/core/create.mjs [--input <in.hwp>] --plan plan.json --output <out.hwp>` — with `--input` it replays a plan onto an existing document in **one** load/save instead of one per edit (measured 59ms vs 4,895ms for 12 edits). Every step is confirmed on reload; a plan that would misaddress a later step is refused |
| **Vision-quality PNG** (code) | `node src/enhanced/render.mjs <in> --page N --output page.png` |
| **PDF export** (code) | `node src/enhanced/export_pdf.mjs <in> --output out.pdf` |
| **Precise text/markdown** (code) | `node src/enhanced/read_precise.mjs <in> --format text\|markdown` |
| IR/layout debug (code) | `node src/enhanced/debug.mjs <in> --op dump\|dump-pages\|ir-diff\|thumbnail ...` |

Route to **`sections.mjs`** on: *"extract section 4.3"* · *"outline this document"* · *"split by section"* · *"what changed since last week"* · *"give me §3.2"* · *"hand each section to a subagent"*.

Scripts are ESM (Node 18+), print one-line JSON or extracted content on stdout, and exit non-zero on failure. Exit codes are uniform: **0** ok · **1** load/parse · **2** usage / bad output target / uncomparable snapshot · **3** target not found — including *no structure could be detected* · **4** unsupported here (enhanced needs the CLI) · **5** engine-detected corruption / round-trip verify failed · **6** UNSAFE — refused to prevent silent data loss, override available (`--allow-memo-loss`, `--allow-trackchange-loss`).

## When NOT to use this skill

- `.docx` → docx skill · `.xlsx` → xlsx · `.pptx` → pptx · `.pdf` → pdf · `.odt` → not supported.
- **Producing a Hancom-readable `.hwpx`** — the engine can't; we only emit `.hwp`. Say so honestly.
- **Reading table data off flattened text** — never. Use `extract_tables.mjs` (address/merge-aware). `read.mjs` strict mode refuses to flatten tables for exactly this reason.
- Shape/textbox/chart insertion — not supported on this engine build (documented gap).
- **Defining** a style (create/update/delete) — the engine reports success and does nothing, and `deleteStyle` also reverts paragraphs that used the style. Reading the style list and **applying** an existing style do work.
- **Setting a font by name** — `applyCharFormat` cannot. Applying a style the document already carries changes the font; nothing else does.

## Setup

The rhwp WASM bundle ships vendored under `vendor/rhwp/` — no `npm install` needed at runtime. The enhanced tier additionally needs the `rhwp` CLI binary, resolved as `$RHWP_BIN` → `vendor/bin/rhwp-<platform>` → `rhwp` on `PATH`. If it's absent, core works; enhanced exits 4.

## Reading & extraction

Pick the script here; the flags and traps live in **`reference/reading.md`** and
**`reference/sections.md`** — read those when you need them, not before.

| Need | Script | Rule that bites |
|---|---|---|
| What is this file? | `info.mjs` | Run it first on anything unfamiliar. |
| Body text | `read.mjs` | Strict by default — **never flattens tables**. Memos appended automatically; a body read also snapshots the section tree and reports what changed since your last read. |
| Images in the text | `read.mjs` (automatic) | Pictures render as `[image … · inline\|block\|beside]`, sized **relative to the text column**. Overlays (watermarks) are listed after the body, never placed in it. Details: `image.mjs --op list`. |
| Tracked changes | `read.mjs --track-changes` | A plain read of a tracked document mixes DELETED text into the body. Heed the stderr warning. HWPX = `NOT CHECKED`, not `none`. |
| Table DATA | `extract_tables.mjs` | The ONLY safe path — address-aware. `--summary` before dumping grids. |
| Find text + addresses | `search.mjs` | 0 matches is exit 0, not an error. |
| Dates / KRW amounts | `extract_data.mjs` | `normalized: null` means unparsed, never zero. |
| Outline · one section · split · diff | `sections.mjs --op …` | Structure is **inferred**. Read the `detection:` block on stderr; at `confidence=low` verify with `--op outline` first. "No structure" (exit 3) is a normal answer. |
| Faithful markdown (code) | `read_precise.mjs` | Enhanced tier — exits 4 off Claude Code. |

**Never read table data off flattened text.** `read.mjs` strict mode refuses to
flatten for exactly this reason: a merged cell's text would attach to the wrong
record, silently.

## Editing — the safe path

Detail: **`reference/editing.md`**. Images: **`reference/images.md`**.

**Nothing is done until it survives save→reload.** Every write script exports,
writes, reloads and re-checks; `verified: true` is the guarantee, not the exit
code. A `verified: false` is a CORRUPTION failure (exit 5), never a success.

**Two refusals you will meet** (exit 6, each with its own override): a document
carrying **memos** (`--allow-memo-loss`) or **tracked changes**
(`--allow-trackchange-loss`). The engine models neither, so saving would delete
them silently. Read them first — `read.mjs --memos`, `--track-changes`.

**Output is always `.hwp`.** `.hwpx` input is fine; `.hwpx` output is refused.

## Verify outputs after every run

- **Edits — know what `verified` covers.** Three levels, and they are not the same claim:
  - `ok: true` from the engine proves **nothing**. It is returned for typos, wrong types, invalid enums and inert keys alike.
  - `verified: true` proves the edit **is on disk and reloads cleanly**. `false` is a failed task (exit 5) — say so, never claim success.
  - `effect` / `confirmed` / `applied` proves **the specific property holds the requested value on disk**.
  - **None sees LAYOUT.** They read bytes, not a rendered page — a change can pass all three and still wrap, overflow or paginate wrong. A bulleted list once did exactly that, every wrapped line falling back to the marker's column. When an edit moves text or geometry (indents, bullets, images, sizes, table widths), `verified` is the floor: **render it and look** (`render.mjs`, Claude Code only), or say plainly that layout was not visually confirmed.
- **Table data**: came from `extract_tables.mjs` (address-aware), never from flattened text.
- **Structure**: read the `detection:` block on stderr. At `confidence=low`, confirm with `--op outline` before quoting an `--op extract`, and tell the user the outline was inferred.
- **Visual fidelity** (Korean typography, tab stops, form styling): same instrument, same limit — `render.mjs` is the only thing here that sees a page. This matters more for HWP than for docx.
- **Forms**: after filling, re-list or render to confirm values landed and aren't wearing placeholder styling.

## Done when

- The requested read/extraction/edit/creation produced its output, and for any edit the script reported `verified: true`.
- Table data was read structurally (no flattening).
- If the deliverable required `.hwpx` output or an unsupported op, you said so honestly instead of shipping something Hancom will reject.

## Failure modes (per the behavioral spec)

| Symptom | Cause | What to do |
|---|---|---|
| `verified: false` after an edit | engine dropped the edit on save | report honestly; on the pinned 0.7.19 a `.hwp` find/replace survives the round-trip, so this means either an unusual input or an engine regression (spec rule 9) |
| exit `4` from an enhanced script | no `rhwp` CLI (not on Claude Code) | use a core script; tell the user PNG/PDF/precise-read need Claude Code + the binary |
| exit `2` on `--output x.hwpx` | HWPX output is blocked | save as `.hwp` |
| exit `5` on form fill | filled value didn't survive | the field/doc is problematic; surface it |
| exit `6` editing a file with memos | engine can't model memos — editing their section silently deletes them on save | guard blocks (exit 6); read them with `read.mjs --memos`, or pass `--allow-memo-loss` to edit and lose them |
| exit `6` editing a file with tracked changes | engine can't model 변경 내용 추적 either — the save destroys every recorded change, including the original text each deletion still holds | guard blocks (exit 6); inspect with `read.mjs --track-changes`, or pass `--allow-trackchange-loss` to edit and lose them |
| a plain read WARNs about tracked changes | deleted text is physically in the body and is printed as if live | the output is NOT the final text; run `read.mjs --track-changes` to see which spans are insertions vs deletions |
| tracked changes on an `.hwpx` | the container can't be scanned | you get `NOT CHECKED` / a warning, never "none". An edit warns and proceeds — say it was unchecked |
| exit `3` from `sections.mjs --op outline` | no structure could be detected (normal — 12 of 60 real documents) | `--detect regex --heading-regex '<re>'` or `--marker-level '<json>'`; else read it flat and say there's no outline |
| outline is a table index (`표 1 [T0]`) | body-less document — everything is in tables | expected; `--op extract` on it is empty, use `extract_tables.mjs` for the data |
| exit `2` from `sections.mjs --op diff` | baseline was built with a different `--table-mode` or source format | re-run `--op snapshot`; the refused diff would have reported change that never happened |
| Hancom rejects a filled form | pre-filled field char-shape (#838) | warn was printed; fill empty fields only, or accept the risk and visually verify |
| merged-cell data looks shifted | table read from flattened text | re-read with `extract_tables.mjs` |
| `R&D` etc. special chars | (was a ≤0.7.11 bug) | fine on 0.7.19 — `&`/`<`/`>` preserved |

## Engine limitations on this build

The per-operation guarantee matrix is in **`spec/rhwp-behavior.md`** — it is engine behaviour, and every row there is backed by a test. What bites *before* you pick a command is in **Failure modes** above.

Engine pinned to rhwp **0.7.19** (`vendor/rhwp/VERSION`). Known live limitations on this build: form #838 (warned), memos not modeled — they ride along only in a section's `raw_stream` round-trip cache, so editing their section deletes them on save (guarded, exit 6, override `--allow-memo-loss`; read with `read.mjs --memos`) — tracked changes not modeled either, same `raw_stream` mechanism and same guard (exit 6, override `--allow-trackchange-loss`; read with `read.mjs --track-changes`), and no outline metadata to read, so `sections.mjs` infers structure and reports its confidence — and shapes/charts not supported. The full, test-backed rule set is in `spec/rhwp-behavior.md`; `test/` enforces it.
