#!/usr/bin/env node
// Usage:
//   node src/core/fill_form.mjs <input.hwp|.hwpx> --list
//   node src/core/fill_form.mjs <input.hwp|.hwpx> --values <values.json> --output <out.hwp> [--dry-run]
//   node src/core/fill_form.mjs <input.hwp|.hwpx> --rows <rows.jsonl|rows.csv> --out-dir <dir> [--name-field <name>] [--dry-run]
//
// Korean public-sector forms ship as .hwp/.hwpx with named fields (clickhere /
// cell fields). This wraps the engine Field API:
//   --list   → prints getFieldList() JSON so the agent can see what fields
//              exist (and their current values) before assigning anything.
//   --values → reads {fieldName: value, ...} and fills each field, then saves
//              verified .hwp. Duplicate names use fieldName[N] (0-based, same
//              order as --list). A bare name that occurs more than once is
//              ambiguous (exit 2) — never silently fill only the first.
//   --dry-run → resolve and report, write no file.
//   --rows / --out-dir → one output .hwp per data row (jsonl or csv).
//
// CORE TIER — WASM ONLY. Runs entirely through the vendored @rhwp/core WASM
// bundle; behaves identically on claude.ai / cowork / code. MUST NOT shell out
// to the rhwp CLI.
//
// Round-trip safety (spec §17): setFieldValueByName routes through the IR
// update path (not the raw_stream fast-path), so empty-field fills survive
// .hwp export→reload. Every save still goes through exportVerify() — we never
// trust the in-memory write; a value that doesn't materialize on reload is a
// FAILED task (exit CORRUPTION), never reported as success.
//
// Pre-fill detection + #838 warning (spec §18–19): BEFORE filling a field we
// read its current value. A non-empty value means the field is PRE-POPULATED;
// overwriting it does NOT shift the char-shape / line-seg metadata (#838), so
// Hancom Office may reject the result. We still fill (the value is correct in
// rhwp's IR) but warn loudly on stderr and recommend a visual verify. Empty
// fields fill cleanly and need no warning.
//
// Output is always HWP 5.0 binary — .hwpx output is refused (assertHwpOutput,
// invoked inside exportVerify). .hwpx INPUT is fine: exportHwp runs the
// engine's HWPX→HWP adapter.

import { loadDocument } from "../lib/_bootstrap.mjs";
import { exportVerify } from "../lib/verify.mjs";
import { EXIT, fail } from "../lib/exit-codes.mjs";
import { assertMemoSafe } from "../lib/memo.mjs";
import { assertTrackChangeSafe } from "../lib/trackchange.mjs";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const USAGE =
  "usage: fill_form.mjs <input> --list\n" +
  "       fill_form.mjs <input> --values <values.json> --output <out.hwp> [--dry-run]\n" +
  "       fill_form.mjs <input> --rows <rows.jsonl|rows.csv> --out-dir <dir> [--name-field <name>] [--dry-run]";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name) {
  return process.argv.includes(name);
}

// Surface load failures as a clean one-line diagnostic instead of a raw
// engine stack trace (ENOENT, corrupt CFB, wrong format, etc.).
async function loadOrExit(path) {
  try {
    return await loadDocument(path);
  } catch (e) {
    fail(EXIT.LOAD, `error: cannot read ${path}: ${e?.message ?? e}`);
  }
}

function fieldValueById(doc, fieldId) {
  try {
    const r = JSON.parse(doc.getFieldValue(fieldId));
    return r && r.ok ? String(r.value ?? "") : "";
  } catch {
    return "";
  }
}

function listFields(doc) {
  let fields;
  try {
    fields = JSON.parse(doc.getFieldList());
  } catch (e) {
    fail(EXIT.LOAD, `error: could not read field list: ${e?.message ?? e}`);
  }
  if (!Array.isArray(fields)) fields = [];
  const seen = new Map();
  const listed = fields.map((f) => {
    const name = f.name ?? "";
    const occurrence = seen.get(name) ?? 0;
    seen.set(name, occurrence + 1);
    return { ...f, occurrence };
  });
  for (const f of listed) f.sameNameCount = seen.get(f.name ?? "") ?? 1;
  return listed;
}

function parseFieldKey(key) {
  const m = /^(.*)\[(\d+)\]$/.exec(String(key));
  if (m) return { name: m[1], occurrence: Number(m[2]) };
  return { name: String(key), occurrence: null };
}

function resolveTargets(values, listed) {
  const byName = new Map();
  for (const f of listed) {
    const name = f.name ?? "";
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(f);
  }
  const missing = [];
  const ambiguous = [];
  const targets = [];
  for (const [key, raw] of Object.entries(values)) {
    const { name, occurrence } = parseFieldKey(key);
    const group = byName.get(name) ?? [];
    if (group.length === 0) {
      missing.push(key);
      continue;
    }
    if (occurrence == null) {
      if (group.length > 1) {
        ambiguous.push({ name, matched: group.length });
        continue;
      }
      targets.push({ key, name, occurrence: 0, field: group[0], value: String(raw) });
    } else if (!group[occurrence]) {
      missing.push(key);
    } else {
      targets.push({ key, name, occurrence, field: group[occurrence], value: String(raw) });
    }
  }
  return { targets, missing, ambiguous };
}

function warnPrefilled(name, existing) {
  process.stderr.write(
    `WARNING: field '${name}' is PRE-POPULATED (current value ${JSON.stringify(existing)}).\n` +
      `         Overwriting a filled field does NOT shift its char-shape / line-seg\n` +
      `         metadata (rhwp #838), so Hancom Office may reject the saved .hwp as\n` +
      `         manipulated ("파일 손상"). The new value is written to rhwp's IR and\n` +
      `         survives the round-trip, but you should VISUALLY VERIFY the result in\n` +
      `         Hancom before delivering. Filling EMPTY fields is the clean path.\n`,
  );
}

function applyTargets(doc, targets) {
  const applied = [];
  const prefilledWarned = [];
  for (const t of targets) {
    const existing = fieldValueById(doc, t.field.fieldId);
    if (existing !== "") {
      prefilledWarned.push(t.key);
      warnPrefilled(t.key, existing);
    }
    const r = JSON.parse(doc.setFieldValue(t.field.fieldId, t.value));
    if (!r || r.ok !== true) {
      fail(EXIT.CORRUPTION, `error: setFieldValue failed for '${t.key}': ${JSON.stringify(r)}`);
    }
    applied.push(t.key);
  }
  return { applied, prefilledWarned };
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let i = 0;
  let inQuotes = false;
  const s = String(text).replace(/^\uFEFF/, "");
  while (i < s.length) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(cell);
      cell = "";
      i += 1;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i += 1;
      row.push(cell);
      cell = "";
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
      i += 1;
      continue;
    }
    cell += ch;
    i += 1;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    if (row.some((c) => c !== "")) rows.push(row);
  }
  if (!rows.length) return [];
  const header = rows[0];
  return rows.slice(1).map((r) => {
    const obj = {};
    for (let c = 0; c < header.length; c++) obj[header[c]] = r[c] ?? "";
    return obj;
  });
}

function parseRowsFile(path) {
  const raw = readFileSync(path, "utf8");
  if (path.toLowerCase().endsWith(".csv")) return parseCsv(raw);
  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    let obj;
    try {
      obj = JSON.parse(t);
    } catch (e) {
      fail(EXIT.USAGE, `error: ${path} is not JSONL (${e?.message ?? e})`);
    }
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
      fail(EXIT.USAGE, `error: each JSONL line must be an object {fieldName: value, ...}`);
    }
    rows.push(obj);
  }
  return rows;
}

function safeFilePart(s) {
  return String(s).replace(/[\\/:*?"<>|]/g, "_").trim() || "row";
}

const inputPath = process.argv[2];
if (!inputPath || inputPath.startsWith("--")) {
  fail(EXIT.USAGE, USAGE);
}

const doc = await loadOrExit(inputPath);

const listed = listFields(doc);

// ── --list ────────────────────────────────────────────────────────────────
// Print the field catalog. getFieldList returns "[]" on a fieldless doc, so
// the JSON is always valid. `occurrence` / `sameNameCount` tell the agent
// when to use name[N] keys.
if (flag("--list")) {
  process.stdout.write(JSON.stringify(listed, null, 2) + "\n");
  process.exit(EXIT.OK);
}

// ── --values / --rows ───────────────────────────────────────────────────────
const valuesPath = arg("--values");
const output = arg("--output");
const rowsPath = arg("--rows");
const outDir = arg("--out-dir");
const nameField = arg("--name-field");
const dryRun = flag("--dry-run");

if (valuesPath && rowsPath) {
  fail(EXIT.USAGE, `error: use either --values or --rows, not both\n${USAGE}`);
}
if (rowsPath) {
  if (!outDir) fail(EXIT.USAGE, `error: --rows requires --out-dir <dir>\n${USAGE}`);
} else if (!valuesPath || (!output && !dryRun)) {
  fail(EXIT.USAGE, `error: --values <json> and --output <out.hwp> are both required (or --dry-run)\n${USAGE}`);
}

// Write path only (NOT --list, which is read-only): refuse a memo-bearing input
// (the engine drops memos on save) unless the caller passed --allow-memo-loss.
// No-op on memo-free inputs.
assertMemoSafe(inputPath, process.argv);
// Same contract for tracked changes (변경 내용 추적): the engine does not model
// them either, so an edit destroys every recorded change AND the original text
// each deletion still holds. Override: --allow-trackchange-loss.
assertTrackChangeSafe(inputPath, process.argv);

function resolveOrExit(values) {
  const { targets, missing, ambiguous } = resolveTargets(values, listed);
  if (ambiguous.length) {
    fail(
      EXIT.USAGE,
      `error: field name(s) occur more than once — say which with name[N]: ` +
        ambiguous.map((a) => `${a.name} ×${a.matched}`).join(", ") +
        `\n       run --list to see occurrence indexes.`,
    );
  }
  if (missing.length) {
    fail(
      EXIT.NOT_FOUND,
      `error: field(s) not found in document: ${missing.join(", ")}\n` +
        `       run --list to see available fields.`,
    );
  }
  return targets;
}

async function saveFilled(doc, targets, outPath) {
  const { applied, prefilledWarned } = applyTargets(doc, targets);
  const expectPresent = [...new Set(targets.map((t) => t.value).filter((v) => v.length > 0))];
  const result = await exportVerify(doc, outPath, { expectPresent });
  if (!result.verified) {
    process.stderr.write(JSON.stringify(result, null, 2) + "\n");
    fail(
      EXIT.CORRUPTION,
      `error: round-trip verification failed — a filled value did not survive save→reload of ${outPath}.\n` +
        `       The edit was accepted in memory but dropped on .hwp serialization (upstream bug).\n` +
        `       Treat the task as FAILED — do not deliver ${outPath}.`,
    );
  }
  return { applied, prefilledWarned, result };
}

if (rowsPath) {
  const rows = parseRowsFile(rowsPath);
  if (!rows.length) fail(EXIT.USAGE, `error: ${rowsPath} has no data rows`);
  if (!dryRun) mkdirSync(outDir, { recursive: true });
  const results = [];
  for (let i = 0; i < rows.length; i++) {
    const targets = resolveOrExit(rows[i]);
    const label = nameField && rows[i][nameField] != null ? safeFilePart(rows[i][nameField]) : String(i + 1).padStart(4, "0");
    const outPath = join(outDir, `${label}.hwp`);
    if (dryRun) {
      results.push({ row: i, dryRun: true, output: outPath, wouldFill: targets.map((t) => t.key) });
      continue;
    }
    const rowDoc = i === 0 ? doc : await loadOrExit(inputPath);
    const { applied, prefilledWarned, result } = await saveFilled(rowDoc, targets, outPath);
    results.push({
      row: i,
      output: result.outputPath,
      applied,
      prefilledWarned,
      verified: result.verified,
      bytesWritten: result.bytesWritten,
    });
  }
  process.stdout.write(JSON.stringify({ ok: true, input: inputPath, dryRun, rowCount: rows.length, results }, null, 2) + "\n");
  process.exit(EXIT.OK);
}

let values;
try {
  values = JSON.parse(readFileSync(valuesPath, "utf8"));
} catch (e) {
  fail(EXIT.USAGE, `error: cannot read --values JSON ${valuesPath}: ${e?.message ?? e}`);
}
if (values === null || typeof values !== "object" || Array.isArray(values)) {
  fail(EXIT.USAGE, `error: --values JSON must be an object {fieldName: value, ...}`);
}

const targets = resolveOrExit(values);

if (dryRun) {
  process.stdout.write(
    JSON.stringify({
      ok: true,
      input: inputPath,
      dryRun: true,
      wouldFill: targets.map((t) => ({ key: t.key, name: t.name, occurrence: t.occurrence, value: t.value })),
    }) + "\n",
  );
  process.exit(EXIT.OK);
}

const { applied, prefilledWarned, result } = await saveFilled(doc, targets, output);

process.stdout.write(
  JSON.stringify({
    ok: true,
    input: inputPath,
    outputPath: result.outputPath,
    applied,
    prefilledWarned,
    bytesWritten: result.bytesWritten,
    verified: result.verified,
  }) + "\n",
);
