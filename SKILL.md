---
name: hwp
description: "Use this skill whenever the user wants to view, read, edit, fill, or create Korean HWP/HWPX documents (.hwp, .hwpx files — the native format of Hancom Office and the de facto standard for Korean public-sector forms). Triggers include: opening or summarizing an .hwp, finding/replacing text in an .hwp, filling a Korean government form (신청서, 보고서, 양식), building a new .hwp from scratch, extracting text/tables/images from .hwp, converting .hwp to text/markdown/PDF/PNG, inspecting .hwp structure, references to '한글 문서', '한컴 한글', 'HWP', 'HWPX', or casual mentions like 'the hwp in my downloads' / 'this 보고서 양식 they sent me' / '이거 한글 파일'. Use this skill even when the user does not explicitly say HWP, as long as the file extension is .hwp/.hwpx or the document is described as a Hangul/Hancom file. Do NOT use for .docx (use the docx skill), .xlsx (use xlsx), .pptx (use pptx), .pdf (use pdf), or .odt — only HWP and HWPX."
license: MIT (built on the rhwp engine — github.com/edwardkim/rhwp, MIT)
---

# HWP/HWPX viewing, editing, and creation

## Overview

This skill views, edits, fills, and creates HWP and HWPX documents — the format of Hancom Office and Korean public-sector workflows. It wraps the **rhwp** engine (Rust→WASM, vendored under `vendor/rhwp/`, pinned to **0.7.19**) with small Node.js scripts.

**Read first, edit second, verify third.** Every edit is confirmed by reloading the saved file — the engine has corner cases (documented in `spec/rhwp-behavior.md`) where an in-memory edit can be silently dropped, so "it returned ok" is not proof. The scripts do this verification for you and report `verified: true/false`.

### Two tiers — what works where

| Tier | Scripts | Runs on |
|---|---|---|
| **core** (`src/core/`) | read, sections, extract_tables, info, replace, edit_text, edit_cell, table, format, header_footer, footnote, fill_form, unlock, create | **WASM only → every platform** (claude.ai, cowork, Claude Code). No install, no binary. |
| **enhanced** (`src/enhanced/`) | render (PNG), export_pdf, read_precise (CLI text/markdown), debug (ir-diff/dump) | **native rhwp CLI → Claude Code only.** Degrades with exit 4 + a clear message elsewhere. |

All read/edit/create works everywhere on the core tier. The enhanced tier only adds vision-grade PNG, PDF, precise extraction, and IR debugging, and only when the `rhwp` binary is on `PATH` (or `$RHWP_BIN`). If an enhanced script exits `4`, you're not on Claude Code or the binary isn't installed — fall back to a core script and tell the user.

## ⚠️ Output policy: always `.hwp`, never `.hwpx`

Output is **always HWP 5.0 (`.hwp`)**. Native HWPX save is rejected by Hancom Office ("파일 손상"), so every write script refuses `--output *.hwpx` with exit 2. **`.hwpx` INPUT is fully supported** — the engine runs an HWPX→HWP adapter on export. So: open an `.hwpx`, edit it, save it as `.hwp`.

## Quick Reference (routing: task → script)

| Task | Command |
|---|---|
| Inspect an unfamiliar file | `node src/core/info.mjs <in> [--validate]` |
| Read body text | `node src/core/read.mjs <in> --format text` |
| Read memos (메모/주석) | `node src/core/read.mjs <in> --memos` |
| Read tracked changes (변경 내용 추적) | `node src/core/read.mjs <in> --track-changes [--format text\|json]` |
| **Document STRUCTURE** (outline · §4.3 · split · diff) | `node src/core/sections.mjs <in> --op outline\|extract\|split\|snapshot\|diff [--id 2.3.1\|제12조\|T0] [--out-dir <dir>]` |
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

Route to **`sections.mjs`** on: *"extract section 4.3"* · *"outline this document"* · *"split by section"* · *"what changed since last week"* · *"give me §3.2"* · *"hand each section to a subagent"*.

Scripts are ESM (Node 18+), print one-line JSON or extracted content on stdout, and exit non-zero on failure. Exit codes are uniform: **0** ok · **1** load/parse · **2** usage / bad output target / uncomparable snapshot · **3** target not found — including *no structure could be detected* · **4** unsupported here (enhanced needs the CLI) · **5** engine-detected corruption / round-trip verify failed · **6** UNSAFE — refused to prevent silent data loss, override available (`--allow-memo-loss`, `--allow-trackchange-loss`).

## When NOT to use this skill

- `.docx` → docx skill · `.xlsx` → xlsx · `.pptx` → pptx · `.pdf` → pdf · `.odt` → not supported.
- **Producing a Hancom-readable `.hwpx`** — the engine can't; we only emit `.hwp`. Say so honestly.
- **Reading table data off flattened text** — never. Use `extract_tables.mjs` (address/merge-aware). `read.mjs` strict mode refuses to flatten tables for exactly this reason.
- Shape/textbox/chart insertion and style systems — not supported on this engine build (documented gap).

## Setup

The rhwp WASM bundle ships vendored under `vendor/rhwp/` — no `npm install` needed at runtime. The enhanced tier additionally needs the `rhwp` CLI binary, resolved as `$RHWP_BIN` → `vendor/bin/rhwp-<platform>` → `rhwp` on `PATH`. If it's absent, core works; enhanced exits 4.

## Reading & extraction

- **`info.mjs`** — JSON summary (pages, sections, sourceFormat, fonts, dimensions, hasTable, **memoCount**, field count, engine version). `--validate` adds `getValidationWarnings()` so you can spot a structurally suspect source before extracting.
- **`read.mjs`** — body text (WASM). **Strict by default**: it does NOT flatten tables (which would misplace merged-cell text); each table becomes a `[table: use extract_tables.mjs for data]` marker plus a stderr warning. `--mode best-effort` flattens inline (with a warning) if you really want it. `--format svg --page N` for a quick visual preview. **Memos surface automatically**: if the document has memos (메모/주석), a plain read appends a `─── 메모 / memos (N) ───` section after the body (the engine hides memos from normal extraction, so this prevents missing them). `--memos` prints only the memos — each with its text **and the body span it is anchored to** (`anchor`) — as JSON, or as `--format text`.
- **`read.mjs --track-changes`** — tracked changes (변경 내용 추적) are the memo problem one degree worse: **deleted text is still physically in the paragraph records**, so a plain read prints text the author already removed, inlined with the live body and indistinguishable from it. A plain read now emits a stderr WARNING (with insertion/deletion counts) when — and only when — the document really has them; do not treat that output as the document's final text. `--track-changes` lists each change (kind / author / covered text / location), `--format json` for the full verdict. **HWPX cannot be scanned**: the answer is `NOT CHECKED`, which is not `none`.
- **`extract_tables.mjs`** — the ONLY safe way to read table data. Rebuilds the grid by cell `{row,col,rowSpan,colSpan}` so a merged cell never leaks onto the wrong record. Flags: `--data-tables-only` (drop legend/작성요령 tables by header keyword, conservative), `--drop-empty` (normalize placeholders 번호/해당없음/-/X to ""), `--detect-form-type` (annotate marker ①②/label/plain), `--fill-merged`, `--table N`, `--no-nested`.
- **`read_precise.mjs`** (enhanced) — accurate text/markdown via the CLI, with real table grids in markdown. Use on Claude Code when you need a faithful markdown rendering.

### Document structure — `sections.mjs`

Read a document as a STRUCTURE instead of a wall of text.

```bash
node src/core/sections.mjs <in> --op outline                 # the heading tree
node src/core/sections.mjs <in> --op extract --id 2.3.1      # one section + breadcrumb
node src/core/sections.mjs <in> --op extract --id 제12조       # …by document reference
node src/core/sections.mjs <in> --op split --out-dir chunks/ # one .md per top-level section
node src/core/sections.mjs <in> --op snapshot                # record a baseline
node src/core/sections.mjs <in> --op diff                    # what changed since it
```

**Structure is INFERRED, never read.** Korean HWP documents carry no outline metadata — `headType`/`paraLevel`/`numberingId` read None/0/0 on ~100% of paragraphs, and the built-in 개요 1..7 styles exist in every document but are almost never used. Depth is learned **per document** from marker glyph + indent (□ → ○ → -). So **every run writes a `detection:` block to stderr**: the strategy that won, the ladder (style → clause → marker → table → none) with why each rank was rejected, how many candidates each filter killed, the learned marker→level map, a confidence grade, and an agreement rate against the engine's own `getStructure` (a second opinion — it is 조문-only and returned zero nodes on 6 of 9 real documents, so it is reported, never used). **Read that block.** At `confidence=low` a loud WARNING says to eyeball `--op outline` before trusting an `--op extract`.

**"No structure" is a normal answer, not a bug.** Measured over 60 real Korean documents: 22 got a marker outline, 26 fell back to a **table index**, and 12 exited **3** rather than invent a tree. On exit 3, the two escape hatches are `--detect regex --heading-regex '<pattern>'` (authoritative — `auto` never picks regex on its own) and `--marker-level '{"BOX":1,"CIRCLE":2}'`. Otherwise read the document flat and say so.

**Body-less documents fall back to a table index** rather than an empty tree — the fallback fires when no heading candidate survives (or the document has ≤3 non-empty body blocks) *and* there is at least one table. ~22% of real Korean documents have zero body paragraphs; everything lives inside tables. `--op outline` then lists `1  표 1  [T0]`, exit 0, confidence low. That index is for *navigation only* — `--op extract --id T0` returns the heading line with an **empty body**. Read the data with `extract_tables.mjs`.

- **`--id`** takes an ordinal path (`2.3.1`), a document reference (`제12조`, `T0`), or an exact title. The id comes from the tree position, not from any number printed in the document.
- **`extract` / `split` emit Markdown**: `# title`, a breadcrumb comment (`<!-- 제1장 총칙 › 제1조(목적) — file.hwp -->`) so a subagent knows where the chunk sits, real markdown table grids, `[^n]` footnotes with bodies after the span. `--format json` for a structured chunk; `--format markdown` is accepted but is currently identical to `text`.
- **Equations** render inline from the HWP equation script — `$x^2 + y^2 = z^2$`. No pandoc, no OMML; HWP has its own script language. `--equations latex` translates only when the mapping is **complete** and otherwise falls back to the raw script, so a half-translated formula is never dressed up as LaTeX.
- **`--op split`** writes one file per **top-level** section by default (`000-<ref>-<title>.md`, streamed, so a 40-page document never holds every chunk in memory) and prints each path on stdout. `--level N` adds the deeper sections down to level N — use it when a top-level section is still too big for one subagent.
- **Scoping**: `--own-text` (a node without its children) · `--level N` (cap outline depth / widen split) · `--max-level N` (default 4; how many levels may be learned) · `--table-mode cells` (tables become placeholders instead of grids).
- **Snapshots are a user-owned artifact**, not a cache: `.hwp-snapshots/<stem>/` **next to the document** (`--snapshot-dir` to move it), deterministic so an unchanged document re-snapshots byte-identically. `--op diff` prints `변경 없음` when nothing moved, otherwise `+/-/~/M` lines with a word diff, then **re-baselines** so "diff" means "since the last diff" (`--no-update` to keep the old one). A first `--op diff` with no baseline just creates one and exits 0.
- **A diff across a different `--table-mode` or source format is REFUSED (exit 2)** — it would report ~100% change that never happened. Re-run `--op snapshot`.
- **Cache**: the parsed model is cached in the OS temp dir keyed on the file's **sha256**, so an edited document can never be served a stale tree (`--no-cache` to bypass). Measured on the largest fixture (`node scripts/bench.mjs`): `--op outline` 427 ms cold, 61 ms warm.

## Editing — the safe path

**Find/replace (`replace.mjs`) is the keystone.** It replaces across body text, table cells and textboxes in one pass, then reloads the saved file and confirms — `verified: true` means the change is really on disk, and that check, not the replace itself, is the guarantee. (Historical note for anyone reading older docs: up to engine 0.7.15 bulk replace was silently dropped on a genuine `.hwp` because the serializer's round-trip byte cache wasn't invalidated, and the skill routed around it with a search + delete/insert walk. Fixed upstream in 0.7.16; the workaround is gone.)

Every editing script (`edit_text`, `edit_cell`, `table`, `format`, `header_footer`, `footnote`, `fill_form`, `unlock`, `create`) follows the same contract: edit → atomic `.hwp` save → reload → verify → report `verified`. A `verified: false` result is a **failed task** (exit 5), never reported as success.

- **`fill_form.mjs`** — `--list` shows fields; `--values` fills them. **Empty fields fill cleanly.** Filling a **pre-populated** field warns about upstream bug #838 (char-shape not shifted → Hancom may reject) — visually verify those with `render.mjs`.
- **`edit_cell.mjs`** — address a cell by linear `--cell` index or by `--row/--col`. Out-of-range cell index is caught and reported (the raw engine call would throw).
- **`create.mjs`** — replays a JSON plan (`insert_text`, `insert_paragraph`, `create_table`, `insert_text_in_cell`) against a fresh blank document.

## Verify outputs after every run

- **Edits**: trust the `verified` field, not the exit code alone. `verified: true` = the change survived save→reload. If `false`, the engine couldn't do it — tell the user; do not claim success.
- **Table data**: came from `extract_tables.mjs` (address-aware), never from flattened text.
- **Structure**: read the `detection:` block on stderr. At `confidence=low`, confirm with `--op outline` before quoting an `--op extract`, and tell the user the outline was inferred.
- **Visual fidelity** (Korean typography, tab stops, form styling): on Claude Code, render a page with `render.mjs` and look at it. This matters more for HWP than for docx.
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

## Behavioral Guarantee Matrix (summary — full spec in `spec/rhwp-behavior.md`)

| Operation | genuine `.hwp` | `.hwpx` input |
|---|---|---|
| read tables (address grid) | WORKS | WORKS |
| body edit / safe find-replace | WORKS | WORKS |
| in-cell edit | WORKS | WORKS |
| form fill — empty field | WORKS | WORKS |
| form fill — pre-filled field | WORKS+WARN (#838) | WORKS+WARN |
| create from scratch | WORKS (→ `.hwp`) | — |
| bulk find/replace (body + cells + textboxes) | WORKS (engine ≥0.7.16) | WORKS |
| edit a file that has memos | **BLOCKED** (exit 6; memos deleted on save, override `--allow-memo-loss`) | BLOCKED |
| detect tracked changes (변경 내용 추적) | WORKS (FileHeader bit 14 **plus** corroborating change records — the bit alone over-reports) | NOT CHECKED (container unscannable; says so) |
| edit a file that has tracked changes | **BLOCKED** (exit 6; changes destroyed on save, override `--allow-trackchange-loss`) | WARN + proceed (cannot scan, so refusing would be a guess) |
| detect section structure | INFERRED from text, per document (no outline metadata exists) — exit 3 when it can't | INFERRED, same path |
| save as HWPX | **BLOCKED** (Hancom-rejected) | BLOCKED |

Engine pinned to rhwp **0.7.19** (`vendor/rhwp/VERSION`). Known live limitations on this build: form #838 (warned), memos not modeled — they ride along only in a section's `raw_stream` round-trip cache, so editing their section deletes them on save (guarded, exit 6, override `--allow-memo-loss`; read with `read.mjs --memos`) — tracked changes not modeled either, same `raw_stream` mechanism and same guard (exit 6, override `--allow-trackchange-loss`; read with `read.mjs --track-changes`), and no outline metadata to read, so `sections.mjs` infers structure and reports its confidence — and shapes/charts not supported. The full, test-backed rule set is in `spec/rhwp-behavior.md`; `test/` enforces it.
