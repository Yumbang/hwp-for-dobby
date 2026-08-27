// Strict argv parsing, shared by every script.
//
// Promoted verbatim (behavior-wise) from extract_tables.mjs, which had the only
// version that fails LOUDLY. The other scripts used `argv[i+1]` with no
// validation, so `--format` at the end of the line silently became `undefined`
// and `--table --format markdown` silently parsed "--format" as the table index.
// For a tool whose whole job is not to corrupt a document quietly, an option
// that mis-parses in silence is the wrong default: a flag given without a value
// is a USAGE error, not a fallback to the default.
//
// Every helper takes the argv array explicitly (defaulting to process.argv) so
// tests can drive them without spawning a process.

import { EXIT, fail } from "./exit-codes.mjs";

// A value that itself starts with "--" is treated as a missing value, not as a
// value. This is the rule that catches `--table --format markdown`.
function valueAt(argv, i) {
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? undefined : v;
}

// String option. Absent → dflt. Present without a value → exit USAGE.
export function strArg(name, dflt, argv = process.argv) {
  const i = argv.indexOf(name);
  if (i < 0) return dflt;
  const v = valueAt(argv, i);
  if (v === undefined) fail(EXIT.USAGE, `error: ${name} requires a value`);
  return v;
}

// Non-negative integer option. Rejects floats, signs, whitespace padding and
// anything that does not round-trip through String(parseInt(v)) — "3.5", "-1"
// and "3abc" are all usage errors rather than a silently truncated 3.
export function intArg(name, dflt, argv = process.argv) {
  const i = argv.indexOf(name);
  if (i < 0) return dflt;
  const raw = argv[i + 1];
  const v = valueAt(argv, i);
  const n = v !== undefined ? Number.parseInt(v, 10) : NaN;
  if (!Number.isInteger(n) || n < 0 || String(n) !== v.trim()) {
    fail(
      EXIT.USAGE,
      `error: ${name} requires a non-negative integer (got ${raw === undefined ? "nothing" : JSON.stringify(raw)})`,
    );
  }
  return n;
}

export function flag(name, argv = process.argv) {
  return argv.includes(name);
}

// One-of option: like strArg but constrained to a known set, with the allowed
// values in the error. Used for --format / --mode / --op style switches so each
// script does not re-spell the same validation.
export function enumArg(name, allowed, dflt, argv = process.argv) {
  const v = strArg(name, dflt, argv);
  if (v !== undefined && !allowed.includes(v)) {
    fail(EXIT.USAGE, `unknown ${name}: ${v} (expected ${allowed.join("|")})`);
  }
  return v;
}

// The leading positional input path. Rejects a missing path and a first
// argument that is actually a flag (`read.mjs --memos` with no file), both of
// which would otherwise be read as a filename later and fail as a confusing
// LOAD error instead of a usage error.
export function inputPath(usage, argv = process.argv) {
  const p = argv[2];
  if (!p || p.startsWith("--")) fail(EXIT.USAGE, usage);
  return p;
}

// A set of paragraph indices: "6", "6-9", "6,8,11", or any mix of those.
// Batch formatting (bullets, indent levels) is the point of the whole feature —
// a user fixing a 개조식 list is fixing twenty paragraphs, not one — so the
// selector has to be first class rather than a shell loop around --paragraph.
//
// Returns a sorted, de-duplicated array. Ranges are INCLUSIVE at both ends,
// because "6-9" reads as four paragraphs to everyone who is not a programmer,
// and this string is written by a person or by an agent quoting a person.
// Refuses a descending range rather than silently returning nothing.
export function paragraphSet(name, raw, usage) {
  if (raw === undefined || raw === null || raw === "") {
    fail(EXIT.USAGE, `error: ${name} is required (e.g. ${name} 6, ${name} 6-9, ${name} 6,8,11)\n${usage ?? ""}`);
  }
  const out = new Set();
  for (const piece of String(raw).split(",")) {
    const part = piece.trim();
    if (part === "") continue;
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    if (m) {
      const lo = Number.parseInt(m[1], 10);
      const hi = Number.parseInt(m[2], 10);
      if (hi < lo) {
        fail(EXIT.USAGE, `error: ${name} range "${part}" is descending (${lo} > ${hi}); write it as ${hi}-${lo}`);
      }
      for (let i = lo; i <= hi; i++) out.add(i);
      continue;
    }
    if (!/^\d+$/.test(part)) {
      fail(
        EXIT.USAGE,
        `error: ${name} could not parse "${part}" — use N, N-M (inclusive) or a comma-separated list\n${usage ?? ""}`,
      );
    }
    out.add(Number.parseInt(part, 10));
  }
  if (out.size === 0) fail(EXIT.USAGE, `error: ${name} selected no paragraphs (got ${JSON.stringify(raw)})`);
  return [...out].sort((a, b) => a - b);
}
