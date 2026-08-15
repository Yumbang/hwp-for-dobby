#!/usr/bin/env node
// Usage:
//   node src/core/extract_data.mjs <input.hwp|.hwpx> [--kind date|amount|number|all] [--limit N] [--format text|json]
//
// Pull dates, KRW amounts and unit-bearing quantities WITH their document
// address (section/paragraph/page, and table cell when the hit is in a grid).
// Running a regex on flattened text would lose "which page". 0 hits is exit 0.
// Unknown forms keep raw and set normalized: null — we do not guess a century
// for '26.8.2 or invent a day for 2026년 8월.
//
// CORE / WASM only.

import { loadDocument } from "../lib/_bootstrap.mjs";
import { eachParagraph, paragraphText } from "../lib/doc_walk.mjs";
import { enumArg, inputPath, intArg } from "../lib/argv.mjs";
import { EXIT, fail } from "../lib/exit-codes.mjs";
import { extractTables } from "../lib/tables.mjs";

const USAGE =
  "usage: extract_data.mjs <input.hwp|.hwpx> [--kind date|amount|number|all] [--limit N] [--format text|json]";

const input = inputPath(USAGE);
const kind = enumArg("--kind", ["date", "amount", "number", "all"], "all");
const limit = intArg("--limit", null);
if (limit === 0) fail(EXIT.USAGE, "error: --limit must be >= 1 (omit it for no cap)");
const format = enumArg("--format", ["text", "json"], "json");

let doc;
try {
  doc = await loadDocument(input);
} catch (e) {
  fail(EXIT.LOAD, `error: cannot read ${input}: ${e?.message ?? e}`);
}

function pageOf(sec, para) {
  try {
    const r = JSON.parse(doc.getPageOfPosition(sec, para));
    return r && r.ok === true && Number.isInteger(r.page) ? r.page : null;
  } catch {
    return null;
  }
}

function scanText(text, loc) {
  const s = String(text ?? "");
  const items = [];
  let i = 0;
  while (i < s.length) {
    // Skip statute ordinals so "제12조" is never a quantity.
    if (s.startsWith("제", i) && /^\d+[조장절관항호목편]/.test(s.slice(i + 1))) {
      const m = /제\d+[조장절관항호목편]/.exec(s.slice(i));
      i += m ? m[0].length : 1;
      continue;
    }

    const date = matchDate(s, i);
    if (date) {
      items.push({ kind: "date", ...date, ...loc });
      i = date.end;
      continue;
    }
    const amount = matchAmount(s, i);
    if (amount) {
      items.push({ kind: "amount", currency: "KRW", ...amount, ...loc });
      i = amount.end;
      continue;
    }
    const num = matchNumber(s, i);
    if (num) {
      items.push({ kind: "number", ...num, ...loc });
      i = num.end;
      continue;
    }
    i += 1;
  }
  return items;
}

function matchDate(s, i) {
  // 2026년 8월 2일[(월)]  /  2026년 8월
  const ko = /^(\d{4})\s*년\s*(\d{1,2})\s*월(?:\s*(\d{1,2})\s*일)?/.exec(s.slice(i));
  if (ko) {
    const y = Number(ko[1]);
    const m = Number(ko[2]);
    const d = ko[3] ? Number(ko[3]) : null;
    return {
      raw: ko[0],
      normalized: d != null ? iso(y, m, d) : `${pad(y, 4)}-${pad(m, 2)}`,
      charOffset: i,
      length: ko[0].length,
      end: i + ko[0].length,
    };
  }
  // 2026-08-02 / 2026/8/2 / 2026. 8. 2.
  const num = /^(\d{4})([./-])\s*(\d{1,2})\2\s*(\d{1,2})\.?/.exec(s.slice(i));
  if (num) {
    const y = Number(num[1]);
    const m = Number(num[3]);
    const d = Number(num[4]);
    return {
      raw: num[0],
      normalized: iso(y, m, d),
      charOffset: i,
      length: num[0].length,
      end: i + num[0].length,
    };
  }
  return null;
}

function matchAmount(s, i) {
  const m =
    /^(?:금\s*)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*(원정|원|백만원|천원)|^(?:₩|￦)\s*(\d{1,3}(?:,\d{3})+|\d+)/.exec(
      s.slice(i),
    );
  if (!m) return null;
  const raw = m[0];
  const digits = (m[1] || m[4] || "").replace(/,/g, "");
  const unit = m[2] || "원";
  let n = Number(digits);
  if (!Number.isFinite(n)) {
    return { raw, normalized: null, charOffset: i, length: raw.length, end: i + raw.length };
  }
  if (unit === "백만원") n *= 1_000_000;
  else if (unit === "천원") n *= 1_000;
  if (!Number.isInteger(n)) {
    return { raw, normalized: null, charOffset: i, length: raw.length, end: i + raw.length };
  }
  return { raw, normalized: n, charOffset: i, length: raw.length, end: i + raw.length };
}

function matchNumber(s, i) {
  // Unit required. Hangul units must be glued; latin/% may have one space.
  const m = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?:(개|명|건|대|회|곳|권|부|장)|(?:\s*)(%|kg|km|cm|mm))/.exec(
    s.slice(i),
  );
  if (!m) return null;
  const raw = m[0];
  const whole = m[1].replace(/,/g, "");
  const frac = m[2] ? `.${m[2]}` : "";
  const unit = m[3] || m[4];
  const n = Number(whole + frac);
  return {
    raw,
    normalized: Number.isFinite(n) ? n : null,
    unit,
    charOffset: i,
    length: raw.length,
    end: i + raw.length,
  };
}

function iso(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;
}
function pad(n, w) {
  return String(n).padStart(w, "0");
}

const all = [];
for (const { s, p } of eachParagraph(doc)) {
  const text = paragraphText(doc, s, p);
  if (!text) continue;
  for (const item of scanText(text, { section: s, paragraph: p, page: pageOf(s, p) })) {
    all.push(item);
  }
}

const tables = extractTables(doc, { noNested: false });
for (const t of tables) {
  if (!t.grid) continue;
  for (let r = 0; r < t.rowCount; r++) {
    for (let c = 0; c < t.colCount; c++) {
      const cell = t.grid[r][c];
      if (!cell || !cell.origin || !cell.text) continue;
      const loc = {
        section: t.section,
        paragraph: t.paragraph,
        page: pageOf(t.section, t.paragraph),
        cell: { table: t.index, row: r, col: c },
      };
      for (const item of scanText(cell.text, loc)) all.push(item);
    }
  }
}

const wanted = kind === "all" ? all : all.filter((x) => x.kind === kind);
const counts = {};
for (const it of wanted) counts[it.kind] = (counts[it.kind] ?? 0) + 1;

const totalItemCount = wanted.length;
const truncated = limit != null && wanted.length > limit;
const items = (truncated ? wanted.slice(0, limit) : wanted).map(({ end, ...rest }) => rest);

const envelope = {
  input,
  kind,
  itemCount: items.length,
  totalItemCount,
  truncated,
  counts,
  items,
};

if (format === "text") {
  if (!items.length) process.stdout.write("(no items)\n");
  for (const it of items) {
    const page = it.page != null ? `p${it.page + 1}` : `s${it.section}`;
    const cell = it.cell ? ` T${it.cell.table}(${it.cell.row},${it.cell.col})` : "";
    process.stdout.write(`${it.kind} ${page}${cell} ${it.raw} → ${it.normalized}\n`);
  }
} else {
  process.stdout.write(JSON.stringify(envelope, null, 2) + "\n");
}
