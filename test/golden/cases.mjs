// Golden case list — the observable surface of the read/extract scripts.
//
// WHY THIS EXISTS: the section/diff/equation work refactors read.mjs and
// extract_tables.mjs onto shared src/lib/ modules. A refactor that is supposed
// to change NOTHING observable needs a witness that says so, recorded BEFORE
// the refactor lands. Each case is one argv; the recorder freezes exit status,
// stdout and stderr verbatim into golden.json and golden.test.mjs replays them.
//
// Cases MUST be:
//   • cwd-relative (never an absolute path) — golden.json is machine-portable;
//   • deterministic — no clock, no PID, no tmpdir in the output. golden.test.mjs
//     runs every case TWICE and asserts the two runs agree, so a case that
//     leaks nondeterminism fails loudly instead of rotting the baseline.
//
// To add a case: append it here, run `node test/golden/record.mjs`, and read
// the diff. Re-recording is how you SAY a behavior change is intended — the
// diff is the review artifact.

export const CASES = [
  // ── read.mjs: the strict/best-effort table contract ──────────────────────
  { name: "read/hwp-strict", script: "src/core/read.mjs", argv: ["samples/fixture-table.hwp", "--no-snapshot"] },
  {
    name: "read/hwp-best-effort",
    script: "src/core/read.mjs",
    argv: ["samples/fixture-table.hwp", "--mode", "best-effort", "--no-snapshot"],
  },
  { name: "read/hwpx-strict", script: "src/core/read.mjs", argv: ["samples/fixture-table.hwpx", "--no-snapshot"] },
  {
    name: "read/hwpx-best-effort",
    script: "src/core/read.mjs",
    argv: ["samples/fixture-table.hwpx", "--mode", "best-effort", "--no-snapshot"],
  },
  { name: "read/form-no-tables", script: "src/core/read.mjs", argv: ["samples/fixture-form.hwp", "--no-snapshot"] },
  {
    name: "read/explicit-strict-and-page-all",
    script: "src/core/read.mjs",
    argv: ["samples/fixture-table.hwp", "--format", "text", "--page", "all", "--mode", "strict", "--no-snapshot"],
  },

  // Images. fixture-image.hwp carries one default/floating picture, one
  // treatAsChar one, and one with a caption — so these cases pin the marker
  // format, the relative sizing, and the overlay separation. Without them the
  // golden set had no document with a picture in it at all, and the render
  // change that introduced markers was invisible to every case.
  { name: "read/images", script: "src/core/read.mjs", argv: ["samples/fixture-image.hwp", "--no-snapshot"] },
  {
    name: "read/images-no-snapshot-json-info",
    script: "src/core/info.mjs",
    argv: ["samples/fixture-image.hwp"],
  },
  {
    name: "tables/image-doc-json",
    script: "src/core/extract_tables.mjs",
    argv: ["samples/fixture-image.hwp"],
  },

  // ── read.mjs: memos (the guard's read path) ──────────────────────────────
  {
    name: "read/memo-auto-surfaced",
    script: "src/core/read.mjs",
    argv: ["samples/fixture-memo.hwpx", "--no-snapshot"],
  },
  {
    name: "read/memos-json",
    script: "src/core/read.mjs",
    argv: ["samples/fixture-memo.hwpx", "--memos"],
  },
  {
    name: "read/memos-text",
    script: "src/core/read.mjs",
    argv: ["samples/fixture-memo.hwpx", "--memos", "--format", "text"],
  },
  {
    name: "read/memos-json-none",
    script: "src/core/read.mjs",
    argv: ["samples/fixture-table.hwp", "--memos"],
  },
  {
    name: "read/memos-text-none",
    script: "src/core/read.mjs",
    argv: ["samples/fixture-table.hwp", "--memos", "--format", "text"],
  },

  // ── read.mjs: SVG preview (large — stored as a digest, see record.mjs) ────
  {
    name: "read/svg-page-0",
    script: "src/core/read.mjs",
    argv: ["samples/fixture-table.hwp", "--format", "svg", "--page", "0"],
  },
  {
    name: "read/svg-all-hwpx",
    script: "src/core/read.mjs",
    argv: ["samples/fixture-table.hwpx", "--format", "svg"],
  },

  // ── read.mjs: usage / load failures ──────────────────────────────────────
  { name: "read/no-args", script: "src/core/read.mjs", argv: [] },
  { name: "read/leading-flag", script: "src/core/read.mjs", argv: ["--memos"] },
  {
    name: "read/bad-format",
    script: "src/core/read.mjs",
    argv: ["samples/fixture-table.hwp", "--format", "markdown"],
  },
  {
    name: "read/bad-mode",
    script: "src/core/read.mjs",
    argv: ["samples/fixture-table.hwp", "--mode", "loose"],
  },
  {
    name: "read/bad-memo-format",
    script: "src/core/read.mjs",
    argv: ["samples/fixture-memo.hwpx", "--memos", "--format", "xml"],
  },
  {
    name: "read/bad-page",
    script: "src/core/read.mjs",
    argv: ["samples/fixture-table.hwp", "--format", "svg", "--page", "x"],
  },
  { name: "read/missing-file", script: "src/core/read.mjs", argv: ["samples/does-not-exist.hwp"] },

  // ── extract_tables.mjs: the address-aware grid ───────────────────────────
  {
    name: "tables/hwp-json",
    script: "src/core/extract_tables.mjs",
    argv: ["samples/fixture-table.hwp"],
  },
  {
    name: "tables/hwp-markdown",
    script: "src/core/extract_tables.mjs",
    argv: ["samples/fixture-table.hwp", "--format", "markdown"],
  },
  {
    name: "tables/hwpx-json",
    script: "src/core/extract_tables.mjs",
    argv: ["samples/fixture-table.hwpx"],
  },
  {
    name: "tables/hwpx-markdown",
    script: "src/core/extract_tables.mjs",
    argv: ["samples/fixture-table.hwpx", "--format", "markdown"],
  },
  {
    name: "tables/hwpx-fill-merged",
    script: "src/core/extract_tables.mjs",
    argv: ["samples/fixture-table.hwpx", "--fill-merged", "--format", "markdown"],
  },
  {
    name: "tables/hwpx-single-table",
    script: "src/core/extract_tables.mjs",
    argv: ["samples/fixture-table.hwpx", "--table", "0"],
  },
  {
    name: "tables/hwpx-no-nested",
    script: "src/core/extract_tables.mjs",
    argv: ["samples/fixture-table.hwpx", "--no-nested", "--format", "markdown"],
  },
  {
    name: "tables/hwpx-max-depth-0",
    script: "src/core/extract_tables.mjs",
    argv: ["samples/fixture-table.hwpx", "--max-depth", "0", "--format", "markdown"],
  },
  {
    name: "tables/hwp-data-tables-only",
    script: "src/core/extract_tables.mjs",
    argv: ["samples/fixture-table.hwp", "--data-tables-only", "--format", "markdown"],
  },
  {
    name: "tables/hwp-drop-empty-form-type",
    script: "src/core/extract_tables.mjs",
    argv: ["samples/fixture-table.hwp", "--drop-empty", "--detect-form-type", "--format", "markdown"],
  },
  {
    name: "tables/form-json-zero-tables",
    script: "src/core/extract_tables.mjs",
    argv: ["samples/fixture-form.hwp"],
  },
  {
    name: "tables/form-markdown-zero-tables",
    script: "src/core/extract_tables.mjs",
    argv: ["samples/fixture-form.hwp", "--format", "markdown"],
  },
  {
    name: "tables/memo-hwpx-markdown",
    script: "src/core/extract_tables.mjs",
    argv: ["samples/fixture-memo.hwpx", "--format", "markdown"],
  },

  // ── extract_tables.mjs: strict argv + not-found ──────────────────────────
  { name: "tables/no-args", script: "src/core/extract_tables.mjs", argv: [] },
  {
    name: "tables/bad-format",
    script: "src/core/extract_tables.mjs",
    argv: ["samples/fixture-table.hwp", "--format", "xml"],
  },
  {
    name: "tables/table-index-missing-value",
    script: "src/core/extract_tables.mjs",
    argv: ["samples/fixture-table.hwp", "--table", "--format", "markdown"],
  },
  {
    name: "tables/max-depth-negative",
    script: "src/core/extract_tables.mjs",
    argv: ["samples/fixture-table.hwp", "--max-depth", "-1"],
  },
  {
    name: "tables/format-missing-value",
    script: "src/core/extract_tables.mjs",
    argv: ["samples/fixture-table.hwp", "--format"],
  },
  {
    name: "tables/table-out-of-range",
    script: "src/core/extract_tables.mjs",
    argv: ["samples/fixture-table.hwp", "--table", "99"],
  },
  {
    name: "tables/missing-file",
    script: "src/core/extract_tables.mjs",
    argv: ["samples/does-not-exist.hwp"],
  },
];
