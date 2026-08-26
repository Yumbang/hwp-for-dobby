// Section snapshots and diffing — "what changed in this document since I last
// looked?", answered at SECTION granularity rather than at file granularity.
//
// The user-visible job: diff a 40-page report against last week's copy and see
// which sections a co-author actually touched, instead of "the file is
// different" (useless) or a byte diff of a compressed CFB container (worse than
// useless — an .hwp re-save changes bytes everywhere even when nothing was
// edited).
//
// ── What this module is NOT ────────────────────────────────────────────────
//
// It never opens an .hwp and never calls the engine. It takes an ALREADY-BUILT
// section tree plus each node's text from the caller, and owns three things:
// serializing that into a baseline on disk, comparing two baselines, and the
// safety gate that decides when a comparison would be a lie. Keeping the engine
// out is what makes every rule below testable without a single document.
//
// ── The three rules that carry the whole design ────────────────────────────
//
// 1. OWN TEXT ONLY, never subtree text. See buildBaseline().
// 2. The meta.json gate. Two baselines are only comparable if they were
//    produced the same way; when they were not, a diff reports enormous change
//    that never happened. checkMeta() splits that into REJECT (the diff would
//    be a lie — the caller exits USAGE=2) and WARN (the diff is noisy but
//    still informative). This module never calls process.exit; the caller maps
//    `reject` to the exit code, so the logic stays unit-testable.
// 3. Baselines are a USER-OWNED ARTIFACT, not a cache. They live next to the
//    document in `.hwp-snapshots/<stem>/` (mirroring the docx skill's
//    `.docx-snapshots/`) so the user can see, commit, delete or copy them.
//    A cache may vanish; a baseline vanishing means "everything changed".
//
// ── Determinism ────────────────────────────────────────────────────────────
//
// Nothing time-dependent or machine-dependent goes into the payload: no
// timestamps, no absolute paths, and object keys are emitted in sorted order.
// Two runs over an unchanged document must produce byte-identical files, or the
// snapshot directory itself becomes noise in the user's version control and the
// "did anything change?" question gets a false yes. The write time is already
// recorded by the filesystem (mtime); duplicating it in the payload buys
// nothing and costs determinism.

import { mkdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { atomicWriteFile } from "./_bootstrap.mjs";

// Snapshot payload schema version. Bump when the on-disk shape changes in a way
// an older reader would misread; readBaseline refuses a future version rather
// than diffing against fields it does not understand.
export const SNAPSHOT_VERSION = 1;

export const SNAPSHOT_ROOT = ".hwp-snapshots";
export const META_FILE = "meta.json";
export const SECTIONS_FILE = "sections.json";

// The one line the caller prints when a diff finds nothing. Exported so the
// exact string is pinned in one place (a test greps for it).
export const NO_CHANGES_LINE = "변경 없음";

// Elision marker for long unchanged stretches inside a word diff.
export const ELISION = "…";

const DEFAULT_CONTEXT = 4; // words of context kept around each change
// LCS is O(n·m) in time AND memory. 2M cells ≈ 8 MB of Uint32Array and a few
// hundred ms — past that we degrade to a coarse summary instead of hanging on
// somebody's 200-page appendix. Silence and a spinning CPU is the worst
// possible answer to "what changed?".
const DEFAULT_MAX_CELLS = 2_000_000;

const noop = () => {};
const defaultWarn = (m) => process.stderr.write(String(m).endsWith("\n") ? m : m + "\n");

// ── text normalization ──────────────────────────────────────────────────────

// The text a node is fingerprinted and diffed on.
//
// Whitespace is collapsed on purpose. Extracted text is NOT byte-stable across
// renderer versions or between the HWP5 and HWPX readers — spacing around
// controls, line-break handling and NBSP/ideographic-space usage all drift. If
// the fingerprint were byte-exact, a renderer upgrade would report every
// paragraph in the document as edited, and a report that cries wolf once is
// never read again. Word diffing works on word tokens anyway, so collapsing
// runs of whitespace loses nothing the report could have shown.
export function normalizeText(s) {
  return String(s ?? "")
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u200b-\u200d\ufeff]/g, "") // zero-width junk from extraction
    .replace(/[ \t\u00a0\u3000]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// A leading enumeration marker, stripped when normalizing a title for MATCHING
// (never for display). Renumbering is the single most common "change" in a
// Korean document: insert one clause and every following heading's printed
// number shifts. If the number stayed in the match key, that one insertion
// would read as N removals + N additions instead of one addition.
//
// Deliberately conservative — a bare number only counts as a marker when it is
// punctuated ("2." / "2)") or multi-level ("2.3.1"), so a title like
// "2026년 계획" keeps its year.
const LEADING_MARKER =
  /^(?:제\s*\d+\s*[조장절관항호목편]|\d+(?:\.\d+)+|\d+\s*[.)]|\(\s*\d+\s*\)|[가-힣]\s*[.)]|[IVXLC]+\s*[.)]|[A-Za-z]\s*[.)]|[①-⑳㉠-㉭]|§\s*\d+)\s*/;

// Title key used by match passes 3 and 4. Case-folded, whitespace-collapsed,
// marker-stripped. Falls back to the whole normalized title when stripping the
// marker would leave nothing (a heading that is *only* "제12조").
export function normalizeTitle(t) {
  const base = normalizeText(t).replace(/\s+/g, " ");
  const stripped = base.replace(LEADING_MARKER, "").trim();
  return (stripped || base).toLowerCase();
}

// Short content fingerprint. 16 hex chars of SHA-1 over the normalized text:
// collision-free enough for "did this section change?" and short enough that a
// human can eyeball sections.json.
function digestOf(normalized) {
  return createHash("sha1").update(normalized, "utf8").digest("hex").slice(0, 16);
}

// ── deterministic JSON ──────────────────────────────────────────────────────

// JSON.stringify with keys emitted in sorted order and `undefined` dropped, so
// two structurally equal baselines serialize to identical bytes regardless of
// the order the caller happened to build their objects in.
function stableStringify(value, indent = 2) {
  const seen = new WeakSet();
  const norm = (v) => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") {
      if (seen.has(v)) throw new TypeError("snapshot: cyclic value cannot be serialized");
      seen.add(v);
      const out = {};
      for (const k of Object.keys(v).sort()) if (v[k] !== undefined) out[k] = norm(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(norm(value), null, indent) + "\n";
}

// ── where baselines live ────────────────────────────────────────────────────

const stemOf = (p) => basename(String(p), extname(String(p))) || "document";

// Preferred baseline directory: `<document dir>/.hwp-snapshots/<stem>/`.
//
// `override` (the `--snapshot-dir` argument) replaces the ROOT only — the
// per-document stem subdirectory is always appended, so pointing two documents
// at one shared override directory cannot make them overwrite each other's
// baselines.
export function snapshotDir(inputPath, override) {
  const stem = stemOf(inputPath);
  const root = override ? resolve(String(override)) : join(resolve(dirname(String(inputPath))), SNAPSHOT_ROOT);
  return join(root, stem);
}

// Last-resort location, used when the document's own directory is not writable
// (a read-only mount, a document opened from a share). Keyed by a hash of the
// ABSOLUTE input path so two same-named documents from different directories
// never share a baseline — and stable across runs, so the fallback baseline is
// findable again tomorrow.
export function fallbackSnapshotDir(inputPath, tmpRoot = tmpdir()) {
  const abs = resolve(String(inputPath));
  const key = createHash("sha1").update(abs, "utf8").digest("hex").slice(0, 12);
  return join(tmpRoot, "hwp-snapshots", `${stemOf(inputPath)}-${key}`);
}

const NOT_WRITABLE = new Set(["EACCES", "EPERM", "EROFS"]);

// ── building a baseline ─────────────────────────────────────────────────────

// Flatten the caller's section tree into pre-order document order, resolving
// each node's own text.
//
// RULE 1, the one that is easiest to lose: a node stores ONLY ITS OWN TEXT —
// the text belonging to that node, excluding every descendant. If a node stored
// its whole subtree, one edited sentence deep in 3.2.4 would be reported as a
// change in 3.2.4 AND in 3.2 AND in 3 AND at the root: four "changed sections"
// for one edit, and the deeper the tree the louder the lie. Own text keeps the
// report honest — exactly one node changes per edited paragraph.
//
// `ownText` may be a Map(id → text), a plain object keyed by id, or a
// function(node) → text.
function flattenNodes(nodes, ownTextOf, objectsOf = () => []) {
  const out = [];
  const walk = (list, parentId) => {
    for (const node of list || []) {
      if (!node || typeof node !== "object") continue;
      const id = String(node.id ?? "");
      const title = String(node.title ?? "");
      const text = normalizeText(ownTextOf(node, id));
      out.push({
        id,
        ref: node.ref == null || node.ref === "" ? null : String(node.ref),
        title,
        norm: normalizeTitle(title),
        level: Number(node.level ?? 1),
        // blockIndex/headEnd are recorded so a report can point at WHERE a
        // section is. They deliberately take no part in matching: inserting one
        // paragraph at the top of a document shifts every index in it, and
        // matching on a shifted index would report the entire document as
        // rewritten.
        blockIndex: Number(node.blockIndex ?? -1),
        headEnd: Number(node.headEnd ?? -1),
        markerClass: node.markerClass == null ? null : String(node.markerClass),
        parentId,
        digest: digestOf(text),
        chars: text.length,
        // Image CONTENT, separately from the text. A rendered picture marker
        // describes the FRAME ("100% of text width · inline"), which is exactly
        // what an image swap is designed to preserve — so replacing a figure
        // leaves the section's text byte-identical and a text-only diff reports
        // "변경 없음" over a document whose figure changed. Digesting the image
        // bytes here, rather than putting a hash in the marker, keeps the noise
        // out of what a reader sees: the snapshot needs identity, the reader
        // needs description.
        objects: objectsOf(node, id),
        // The old text is stored, not just its digest: it is the only way to
        // show a word-level diff without re-opening (and re-parsing) whatever
        // the document looked like last week — which by then no longer exists.
        text,
      });
      if (Array.isArray(node.children) && node.children.length) walk(node.children, id);
    }
  };
  walk(nodes, null);
  return out;
}

function ownTextResolver(ownText) {
  if (typeof ownText === "function") return (node, id) => ownText(node, id);
  if (ownText instanceof Map) return (node, id) => ownText.get(id) ?? ownText.get(node) ?? "";
  if (ownText && typeof ownText === "object") return (_node, id) => ownText[id] ?? "";
  return () => "";
}

// Drop undefined-valued keys so a built baseline and a read-back baseline are
// deep-equal (JSON has no `undefined`).
function definedOnly(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) if (v !== undefined) out[k] = v;
  return out;
}

// Build the in-memory baseline. `nodes` is the section tree (array of roots,
// each with `children`); `meta` is the safety record checkMeta() will compare
// (see the meta.json schema in this file's checkMeta section).
export function buildBaseline({ nodes, ownText, objects, meta } = {}) {
  return {
    version: SNAPSHOT_VERSION,
    meta: definedOnly(meta),
    nodes: flattenNodes(nodes, ownTextResolver(ownText), objectsResolver(objects)),
  };
}

// Same shapes ownText accepts, resolving to an ARRAY of opaque per-object
// digests for the node. Absent means "not collected", which compares equal to
// absent — an old baseline without them must not read as "every image changed".
function objectsResolver(objects) {
  if (typeof objects === "function") return (node, id) => objects(node, id) ?? [];
  if (objects instanceof Map) return (node, id) => objects.get(id) ?? [];
  if (objects && typeof objects === "object") return (_node, id) => objects[id] ?? [];
  return () => [];
}

// ── reading / writing baselines ─────────────────────────────────────────────

// Write a baseline. Returns { path, ... } where `path` is the directory that
// was actually used — every run must be able to report where its baseline went,
// including the fallback case, because a baseline the user cannot find is the
// same as no baseline.
//
// opts: { dir, update = true, onWarn, tmpRoot }
//   update:false  → write nothing (the `--no-update` flag), but still report
//                   the path the baseline would have gone to.
export function writeBaseline(inputPath, baseline, opts = {}) {
  const warn = opts.onWarn === null ? noop : (opts.onWarn ?? defaultWarn);
  const primary = snapshotDir(inputPath, opts.dir);

  if (opts.update === false) {
    return { path: primary, dir: primary, written: false, skipped: "no-update", fallback: false };
  }

  const version = baseline.version ?? SNAPSHOT_VERSION;
  const sectionsBody = stableStringify({ version, nodes: baseline.nodes ?? [] });
  // The two files are written by two separate atomic renames, so a crash can
  // land between them and leave one file from this run beside one from the
  // last. meta.json therefore carries a digest of the sections payload it was
  // written with, and readBaseline refuses a pair that does not match: a torn
  // baseline reads as "no baseline" (first run) instead of quietly comparing
  // this week's sections against last week's safety record.
  const metaBody = stableStringify({
    version,
    sectionsDigest: digestOf(sectionsBody),
    meta: baseline.meta ?? {},
  });

  const attempt = (dir) => {
    mkdirSync(dir, { recursive: true });
    // meta.json is written LAST — it is the commit marker that names the
    // sections file it belongs to.
    atomicWriteFile(join(dir, SECTIONS_FILE), sectionsBody);
    atomicWriteFile(join(dir, META_FILE), metaBody);
    return {
      path: dir,
      dir,
      metaPath: join(dir, META_FILE),
      sectionsPath: join(dir, SECTIONS_FILE),
      written: true,
      bytes: Buffer.byteLength(metaBody) + Buffer.byteLength(sectionsBody),
    };
  };

  try {
    return { ...attempt(primary), fallback: false };
  } catch (e) {
    if (!NOT_WRITABLE.has(e?.code)) throw e;
    // A read-only document directory must never fail the whole command — the
    // user asked what changed, not to write a file. Fall back, and SAY SO:
    // writing silently somewhere the user was not told about is how a baseline
    // gets orphaned and every later diff reports the world as new.
    const fb = fallbackSnapshotDir(inputPath, opts.tmpRoot);
    const r = attempt(fb);
    warn(
      `warning: cannot write the snapshot next to the document (${e.code}: ${primary}).\n` +
        `         Baseline stored in the temp fallback instead: ${fb}\n` +
        `         Temp directories are cleared periodically — pass --snapshot-dir <writable path> to keep it.`,
    );
    return { ...r, fallback: true, reason: e.code, preferredPath: primary };
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// Read the baseline for a document, or null when there is none.
//
// A missing baseline is NOT an error — it is the first run. So is an unreadable
// or truncated one: refusing to work because a snapshot file got corrupted
// would make the tool less useful than not having snapshots at all. Both
// degrade to "first run", the corrupt case with a warning.
//
// The fallback directory is searched after the preferred one — ALWAYS, even
// when --snapshot-dir named somewhere else — because that is where writeBaseline
// lands when the preferred directory is not writable. A location we are willing
// to write to and not willing to read from would lose a baseline on every run.
export function readBaseline(inputPath, opts = {}) {
  const warn = opts.onWarn === null ? noop : (opts.onWarn ?? defaultWarn);
  const candidates = [snapshotDir(inputPath, opts.dir), fallbackSnapshotDir(inputPath, opts.tmpRoot)];

  for (const dir of candidates) {
    const metaPath = join(dir, META_FILE);
    const sectionsPath = join(dir, SECTIONS_FILE);
    let metaRaw;
    try {
      statSync(metaPath);
      statSync(sectionsPath);
      metaRaw = readJson(metaPath);
    } catch (e) {
      if (e?.code === "ENOENT") continue; // no baseline here — try the next place
      warn(`warning: snapshot at ${dir} is unreadable (${e.message}); treating this as a first run.`);
      continue;
    }
    let sections;
    let sectionsBody;
    try {
      sectionsBody = readFileSync(sectionsPath, "utf8");
      sections = JSON.parse(sectionsBody);
    } catch (e) {
      warn(`warning: ${sectionsPath} is unreadable (${e.message}); treating this as a first run.`);
      continue;
    }
    // Torn write: meta.json names the sections payload it was written with. A
    // mismatch means a crash landed between the two renames, so this week's
    // sections are sitting next to last week's safety record — comparing them
    // would silently check the wrong meta.
    if (metaRaw?.sectionsDigest && metaRaw.sectionsDigest !== digestOf(sectionsBody)) {
      warn(
        `warning: the snapshot at ${dir} is inconsistent (${META_FILE} does not match ${SECTIONS_FILE}, ` +
          `probably an interrupted write); treating this as a first run.`,
      );
      continue;
    }
    const version = Number(sections?.version ?? metaRaw?.version ?? 0);
    if (version > SNAPSHOT_VERSION) {
      warn(
        `warning: snapshot at ${dir} is version ${version}, newer than this skill understands ` +
          `(${SNAPSHOT_VERSION}); ignoring it rather than diffing against fields it does not know.`,
      );
      continue;
    }
    return {
      version,
      meta: metaRaw?.meta ?? {},
      nodes: Array.isArray(sections?.nodes) ? sections.nodes : [],
    };
  }
  return null;
}

// ── meta.json — the safety gate ─────────────────────────────────────────────
//
// meta.json is `{ version, sectionsDigest, meta: {...} }`; `version` and
// `sectionsDigest` are file plumbing (schema version, torn-write detection) and
// checkMeta never sees them. The `meta` record itself — every key optional, and
// unknown keys carried through and ignored so a sibling module can add one
// without breaking older baselines:
//
//   sourceFormat        "hwp" | "hwpx"      REJECT on mismatch
//   tableMode           "body" | "cells"    REJECT on mismatch
//   detect              heading detect mode          warn
//   headingRegex        the --heading-regex used     warn
//   ladder              learned marker ladder (any)  warn (deep-compared)
//   renderVersion       markdown renderer version    warn
//   eqnVersion          equation renderer version    warn
//   tableRenderVersion  table renderer version       warn
//   engineVersion       vendored rhwp version        warn
//   memos               { digest, count }            warn; LOUD when count DROPS
//   trackChange         any shape                    warn on change
//
// The two REJECTs are the ones where continuing produces a confident lie: the
// same document read as .hwp and as .hwpx diffs as ~100% changed, and so does
// one read with tableMode=body against tableMode=cells. Reporting "the whole
// document was rewritten" to someone who changed one sentence destroys trust in
// every future run, so the caller turns these into exit USAGE=2 and tells the
// user to re-baseline.
//
// Everything else warns and continues: a re-derived heading tree or a bumped
// renderer makes the diff noisy, but a noisy diff still contains the answer.

const REJECT_RULES = [
  {
    key: "sourceFormat",
    why:
      "the same document read from .hwp and from .hwpx extracts different text " +
      "and would diff as ~100% changed — that is a lie, not a diff",
  },
  {
    key: "tableMode",
    why:
      "body-text and per-cell table extraction produce different section text; " +
      "comparing them reports every table-bearing section as rewritten",
  },
];

const WARN_RULES = [
  { key: "detect", why: "the heading tree was derived differently, so sections may mass add/remove" },
  { key: "headingRegex", why: "a different heading regex re-derives the tree; expect phantom add/remove" },
  { key: "ladder", why: "the learned marker ladder changed, so section levels/ids may have shifted" },
  { key: "renderVersion", why: "a renderer change alters extracted text; expect phantom paragraph diffs" },
  { key: "eqnVersion", why: "equation rendering changed; equations will look edited when they are not" },
  { key: "tableRenderVersion", why: "table rendering changed; tables will look edited when they are not" },
  { key: "engineVersion", why: "the rhwp engine changed; extraction differences are expected" },
];

const sameValue = (a, b) =>
  a === b || (a && b && typeof a === "object" && typeof b === "object" && stableStringify(a, 0) === stableStringify(b, 0));

const present = (v) => v !== undefined && v !== null && v !== "";

// Compare two baselines' meta records.
//
// Returns { reject: [entry], warn: [entry] } with
//   entry = { key, old, new, message, loud? }
// and NEVER exits: the caller maps a non-empty `reject` to EXIT.USAGE (2). This
// separation is the whole point — a gate that calls process.exit cannot be
// unit-tested, and an untested gate is one refactor away from passing
// everything.
export function checkMeta(oldMeta, newMeta) {
  const o = oldMeta || {};
  const n = newMeta || {};
  const reject = [];
  const warn = [];

  for (const { key, why } of REJECT_RULES) {
    if (present(o[key]) && present(n[key])) {
      if (!sameValue(o[key], n[key])) {
        reject.push({
          key,
          old: o[key],
          new: n[key],
          message:
            `${key} changed since the baseline (${JSON.stringify(o[key])} → ${JSON.stringify(n[key])}): ${why}. ` +
            `Re-create the baseline instead of trusting this diff.`,
        });
      }
    } else if (present(o[key]) !== present(n[key])) {
      // One side does not record it at all (an older baseline). We cannot
      // verify, and silence on a REJECT key is exactly the dangerous case — but
      // stranding the user on an unfixable exit 2 is worse, so: warn.
      warn.push({
        key,
        old: o[key] ?? null,
        new: n[key] ?? null,
        message: `${key} is missing on one side, so it could not be verified: ${why}.`,
      });
    }
  }

  for (const { key, why } of WARN_RULES) {
    if (present(o[key]) && present(n[key]) && !sameValue(o[key], n[key])) {
      warn.push({
        key,
        old: o[key],
        new: n[key],
        message: `${key} changed since the baseline (${JSON.stringify(o[key])} → ${JSON.stringify(n[key])}): ${why}.`,
      });
    }
  }

  // Memos. CLAUDE.md rule 4: the engine cannot preserve memos through an edit —
  // it drops them silently on save. Someone who diffs a document and then edits
  // it is standing exactly where that happens, so a memo count that DROPPED
  // between two baselines is a data-loss signal, not a cosmetic difference: it
  // means memos have already been destroyed, or a memo-losing edit is in flight.
  // It is marked `loud` so the caller can print it where it cannot be missed.
  const om = o.memos;
  const nm = n.memos;
  if (om && nm && typeof om === "object" && typeof nm === "object") {
    const oc = Number(om.count ?? 0);
    const nc = Number(nm.count ?? 0);
    if (nc < oc) {
      warn.push({
        key: "memos",
        loud: true,
        old: oc,
        new: nc,
        message:
          `MEMO LOSS: the memo (메모/주석) count dropped ${oc} → ${nc} since the baseline. ` +
          `The rhwp engine CANNOT preserve memos through an edit — it deletes them silently on save. ` +
          `Read what is left before editing further:  node src/core/read.mjs <file> --memos`,
      });
    } else if (nc > oc) {
      warn.push({
        key: "memos",
        old: oc,
        new: nc,
        message: `memo count rose ${oc} → ${nc} since the baseline (memos added).`,
      });
    } else if (present(om.digest) && present(nm.digest) && om.digest !== nm.digest) {
      warn.push({
        key: "memos",
        old: om.digest,
        new: nm.digest,
        message:
          `memo contents changed while the count stayed at ${nc}. Memos are invisible to the section diff below.`,
      });
    }
  } else if (Boolean(om) !== Boolean(nm)) {
    warn.push({
      key: "memos",
      loud: Boolean(om) && !nm, // had a memo record, now has none → treat as loss-shaped
      old: om ?? null,
      new: nm ?? null,
      message: `the memo record is present on only one side, so memo loss could not be ruled out.`,
    });
  }

  // Tracked changes (변경 내용 추적). Same family of problem: whether revisions
  // are shown as accepted or rejected changes what "the text" even is, so a
  // flipped state makes an unrelated diff look like an edit — and, like memos,
  // it is a state a later edit can destroy.
  if (present(o.trackChange) && present(n.trackChange) && !sameValue(o.trackChange, n.trackChange)) {
    warn.push({
      key: "trackChange",
      old: o.trackChange,
      new: n.trackChange,
      message:
        `tracked-change state changed since the baseline ` +
        `(${JSON.stringify(o.trackChange)} → ${JSON.stringify(n.trackChange)}); ` +
        `accepted/rejected revisions change the extracted text under the diff.`,
    });
  }

  return { reject, warn };
}

// ── word diff ───────────────────────────────────────────────────────────────

// Whitespace-delimited tokens. For Korean this is the 어절, which is the unit a
// reader actually scans; for English it is the word. No dependency, no
// language-specific segmentation, and the same tokenization on both sides is
// all a diff needs.
function tokenize(s) {
  const t = normalizeText(s);
  return t ? t.split(/\s+/) : [];
}

// LCS over token arrays → a flat op list [{op:'='|'-'|'+', t}]. Backward DP so
// the forward backtrack below is a straight walk.
function lcsOps(a, b) {
  const n = a.length;
  const m = b.length;
  const W = m + 1;
  const dp = new Uint32Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * W + j] =
        a[i] === b[j] ? dp[(i + 1) * W + j + 1] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ op: "=", t: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) {
      ops.push({ op: "-", t: a[i++] });
    } else {
      ops.push({ op: "+", t: b[j++] });
    }
  }
  while (i < n) ops.push({ op: "-", t: a[i++] });
  while (j < m) ops.push({ op: "+", t: b[j++] });
  return ops;
}

// Collapse the op list into runs, then render with a context window and elide
// long unchanged stretches. Without the elision an "edited one word" report
// reprints the entire section and buries the answer.
function renderOps(ops, context) {
  const runs = [];
  for (const o of ops) {
    const last = runs[runs.length - 1];
    if (last && last.op === o.op) last.toks.push(o.t);
    else runs.push({ op: o.op, toks: [o.t] });
  }
  const parts = [];
  for (let k = 0; k < runs.length; k++) {
    const r = runs[k];
    if (r.op === "-") {
      parts.push(`[-${r.toks.join(" ")}-]`);
      continue;
    }
    if (r.op === "+") {
      parts.push(`{+${r.toks.join(" ")}+}`);
      continue;
    }
    const first = k === 0;
    const last = k === runs.length - 1;
    const t = r.toks;
    if (first && last) parts.push(t.join(" "));
    else if (first) parts.push(t.length > context ? `${ELISION} ${t.slice(-context).join(" ")}` : t.join(" "));
    else if (last) parts.push(t.length > context ? `${t.slice(0, context).join(" ")} ${ELISION}` : t.join(" "));
    else if (t.length > context * 2)
      parts.push(`${t.slice(0, context).join(" ")} ${ELISION} ${t.slice(-context).join(" ")}`);
    else parts.push(t.join(" "));
  }
  return parts.join(" ");
}

// Word-level diff of two texts, rendered as `[-deleted-] {+inserted+}` with
// roughly `context` words of surrounding text and ` … ` where an unchanged
// stretch was elided. Returns "" when the texts are equal — the caller should
// print nothing rather than an empty diff block.
//
// opts: { context = 4, maxCells = 2_000_000 }
export function wordDiff(oldText, newText, opts = {}) {
  const context = Number.isInteger(opts.context) && opts.context >= 0 ? opts.context : DEFAULT_CONTEXT;
  const maxCells = Number.isInteger(opts.maxCells) && opts.maxCells > 0 ? opts.maxCells : DEFAULT_MAX_CELLS;

  const a = tokenize(oldText);
  const b = tokenize(newText);

  // Trim the common head and tail before the DP. This is not just a speedup:
  // for the usual edit (a couple of words changed inside a long section) it
  // shrinks n·m by orders of magnitude and keeps us under the guard.
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;

  const midA = a.slice(s, a.length - e);
  const midB = b.slice(s, b.length - e);
  if (midA.length === 0 && midB.length === 0) return ""; // identical

  const cells = (midA.length + 1) * (midB.length + 1);
  if (cells > maxCells) {
    // Degrade, never hang. The counts are still true (they bound the change),
    // and the caller gets an answer in constant time instead of a wedged CPU.
    return (
      `(diff too large for word-level comparison: ${a.length} → ${b.length} words) ` +
      `[-${midA.length} words removed-] {+${midB.length} words added+}`
    );
  }

  const ops = [
    ...a.slice(0, s).map((t) => ({ op: "=", t })),
    ...lcsOps(midA, midB),
    ...a.slice(a.length - e).map((t) => ({ op: "=", t })),
  ];
  return renderOps(ops, context);
}

// ── diffing two baselines ───────────────────────────────────────────────────

const UNRESOLVED = Symbol("unresolved-parent");

// Index nodes by a key, but only where the key is UNAMBIGUOUS among the nodes
// still unmatched. A key that occurs twice is dropped: matching on an ambiguous
// key silently pairs the wrong sections, and a wrong pairing is worse than
// falling through to the next pass (which at worst reports add + remove).
function uniqueKeyIndex(nodes, matched, keyOf) {
  const m = new Map();
  for (let i = 0; i < nodes.length; i++) {
    if (matched[i]) continue;
    const k = keyOf(nodes[i], i);
    if (k == null || k === "") continue;
    m.set(k, m.has(k) ? -1 : i);
  }
  return m;
}

function lisKeepMask(seq) {
  const n = seq.length;
  if (n === 0) return [];
  const len = new Array(n).fill(1);
  const prev = new Array(n).fill(-1);
  let best = 0;
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < x; y++) {
      if (seq[y] < seq[x] && len[y] + 1 > len[x]) {
        len[x] = len[y] + 1;
        prev[x] = y;
      }
    }
    if (len[x] > len[best]) best = x;
  }
  const keep = new Array(n).fill(false);
  for (let x = best; x >= 0; x = prev[x]) {
    keep[x] = true;
    if (prev[x] < 0) break;
  }
  return keep;
}

const side = (n) => ({
  id: n.id,
  ref: n.ref ?? null,
  title: n.title,
  level: n.level,
  blockIndex: n.blockIndex,
  chars: n.chars,
});

// Compare two baselines.
//
// Returns { added, removed, changed, moved, unchanged, safety, firstRun? }.
//
// `moved` is ORTHOGONAL to `changed`, not exclusive with it: a section that was
// both relocated and edited appears in both lists (each entry carries `moved`
// and `changed` flags). `unchanged` means nothing at all happened — same
// content, same place. Collapsing move-and-edit into one bucket would force the
// report to drop half of what the co-author actually did.
//
// Node matching, in strict precedence order:
//   1. `ref`       — a document-unique typeable reference (제12조). Survives
//                    renumbering and retitling, so it wins over everything.
//   2. `id`        — the ordinal path (2.3.1), CORROBORATED by the title or the
//                    content digest. See the note below on why bare id here is
//                    a trap.
//   3. title within the SAME PARENT — catches the renumbering case 2 misses.
//   4. title globally → the section exists in both but somewhere else entirely:
//                    that is a MOVE, and reporting it as remove+add would hide
//                    the one fact the user wanted.
//   5. `id` alone  — last resort, after every title pass has had its chance.
//
// WHY 2 IS SPLIT ACROSS 2 AND 5. An ordinal path is a POSITION, not an
// identity. Insert one section at the top of a document and every id below it
// shifts by one: matching on bare id would then pair new §1 (the insertion)
// with old §1 (a different section entirely), new §2 with old §1's neighbour,
// and so on — one insertion reported as "every section in the document was
// rewritten", with the actual insertion nowhere in the report. Requiring the
// title or the digest to agree keeps id matching for the case it is good at
// (nothing moved) and lets the title passes handle the case it is bad at.
// Bare id survives as pass 5 so a section that was both retitled and rewritten
// in place still reads as one change instead of a remove plus an add.
export function diffBaselines(oldBaseline, newBaseline, opts = {}) {
  if (!newBaseline || !Array.isArray(newBaseline.nodes)) {
    throw new TypeError("diffBaselines: newBaseline must be a baseline from buildBaseline()");
  }
  const withDiff = opts.withDiff !== false;
  // The safety verdict travels WITH the diff so a caller cannot print the diff
  // and forget to check the gate. It is computed even when `reject` is
  // non-empty — the caller decides whether to show anything, but a rejected
  // comparison must never be presented as a result.
  const safety = checkMeta(oldBaseline?.meta, newBaseline.meta);

  const N = newBaseline.nodes;
  if (!oldBaseline || !Array.isArray(oldBaseline.nodes)) {
    return {
      firstRun: true,
      added: N.map((n) => ({ ...side(n), reason: "first-run" })),
      removed: [],
      changed: [],
      moved: [],
      unchanged: [],
      safety,
    };
  }
  const O = oldBaseline.nodes;

  const oMatched = new Array(O.length).fill(false);
  const nMatched = new Array(N.length).fill(false);
  const pairOf = new Array(N.length).fill(-1); // new index → old index
  const how = new Array(N.length).fill(null);

  const link = (i, j, label) => {
    oMatched[i] = true;
    nMatched[j] = true;
    pairOf[j] = i;
    how[j] = label;
  };

  // A key pass: pair nodes whose key is unambiguous on BOTH sides (a key that
  // occurs twice on either side pairs nobody), optionally requiring a
  // corroborating predicate before the pair is accepted.
  const keyPass = (keyOf, label, corroborate) => {
    const oldIdx = uniqueKeyIndex(O, oMatched, keyOf);
    const newIdx = uniqueKeyIndex(N, nMatched, keyOf); // insertion order = document order
    for (const [k, j] of newIdx) {
      if (j < 0 || nMatched[j]) continue;
      const i = oldIdx.get(k);
      if (i === undefined || i < 0 || oMatched[i]) continue;
      if (corroborate && !corroborate(O[i], N[j])) continue;
      link(i, j, label);
    }
  };

  // Pass 1 — ref.
  keyPass((n) => n.ref, "ref");
  // Pass 2 — ordinal id, but only where the title or the content agrees too.
  keyPass(
    (n) => n.id,
    "id",
    (on, nn) => (on.norm !== "" && on.norm === nn.norm) || on.digest === nn.digest,
  );

  const newById = new Map(N.map((n, i) => [n.id, i]));
  const childrenOf = (list) => {
    const m = new Map(); // parentId (or null) → [index]
    for (let i = 0; i < list.length; i++) {
      const key = list[i].parentId ?? null;
      if (!m.has(key)) m.set(key, []);
      m.get(key).push(i);
    }
    return m;
  };
  const oldChildren = childrenOf(O);
  const newChildren = childrenOf(N);

  // Pass 3 — same normalized title under the SAME parent. Walked in document
  // order so a parent matched here is already usable by its own children.
  for (let j = 0; j < N.length; j++) {
    if (nMatched[j]) continue;
    const npid = N[j].parentId ?? null;
    let oldParentId;
    if (npid === null) {
      oldParentId = null; // both roots hang off the same virtual root
    } else {
      const npi = newById.get(npid);
      const opi = npi === undefined ? -1 : pairOf[npi];
      if (opi === undefined || opi < 0) continue; // parent itself is new — no scope to search
      oldParentId = O[opi].id;
    }
    if (!N[j].norm) continue;
    // Both directions must be unambiguous: two unmatched siblings sharing a
    // title (two "(목적)" clauses under one chapter) pair with nobody rather
    // than with each other's counterpart at random.
    const rivals = (newChildren.get(npid) || []).filter((x) => !nMatched[x] && N[x].norm === N[j].norm);
    if (rivals.length !== 1) continue;
    const candidates = (oldChildren.get(oldParentId) || []).filter(
      (i) => !oMatched[i] && O[i].norm === N[j].norm,
    );
    if (candidates.length === 1) link(candidates[0], j, "title-in-parent");
  }

  // Pass 4 — same normalized title anywhere in the document. By definition the
  // section is somewhere else now, so these are reported as moves.
  keyPass((n) => n.norm || null, "title-global");

  // Pass 5 — bare ordinal id, last resort (see the header note on 2 vs 5).
  keyPass((n) => n.id, "id-weak");

  // ── position analysis ────────────────────────────────────────────────────
  //
  // "Moved" must mean something a reader cares about: re-parented, or reordered
  // among its siblings. It deliberately does NOT mean "its printed number
  // changed" — inserting one section renumbers everything below it, and
  // reporting fifty moves for one insertion is noise that hides the insertion.
  const oldIdToNewId = new Map();
  for (let j = 0; j < N.length; j++) if (pairOf[j] >= 0) oldIdToNewId.set(O[pairOf[j]].id, N[j].id);

  const movedFlag = new Array(N.length).fill(false);
  for (let j = 0; j < N.length; j++) {
    const i = pairOf[j];
    if (i < 0) continue;
    if (how[j] === "title-global") {
      movedFlag[j] = true; // matched only by a global title sweep: it relocated
      continue;
    }
    const oldPid = O[i].parentId ?? null;
    const expected =
      oldPid === null ? null : oldIdToNewId.has(oldPid) ? oldIdToNewId.get(oldPid) : UNRESOLVED;
    if (expected === UNRESOLVED || expected !== (N[j].parentId ?? null)) movedFlag[j] = true;
  }

  // Reordering: within each new-parent group, the matched old positions must be
  // increasing. Everything outside the longest increasing subsequence is what
  // actually moved (marking all of them would blame the whole group for one
  // section jumping to the top).
  const groups = new Map();
  for (let j = 0; j < N.length; j++) {
    if (pairOf[j] < 0 || movedFlag[j]) continue;
    const key = N[j].parentId ?? null; // a Map key may be null; no string id collides
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(j);
  }
  for (const idxs of groups.values()) {
    const keep = lisKeepMask(idxs.map((j) => pairOf[j]));
    idxs.forEach((j, x) => {
      if (!keep[x]) movedFlag[j] = true;
    });
  }

  // ── buckets ──────────────────────────────────────────────────────────────
  const added = [];
  const removed = [];
  const changed = [];
  const moved = [];
  const unchanged = [];

  for (let j = 0; j < N.length; j++) {
    const nn = N[j];
    const i = pairOf[j];
    if (i < 0) {
      added.push({ ...side(nn), reason: "added" });
      continue;
    }
    const on = O[i];
    const textChanged = on.digest !== nn.digest;
    // An old baseline has no `objects` at all; treat that as "not collected" so
    // a pre-upgrade snapshot does not report every figure as replaced.
    const oldObjs = Array.isArray(on.objects) ? on.objects : null;
    const newObjs = Array.isArray(nn.objects) ? nn.objects : null;
    const objectsChanged =
      oldObjs !== null && newObjs !== null && JSON.stringify(oldObjs) !== JSON.stringify(newObjs);
    const contentChanged = textChanged || objectsChanged;
    const entry = {
      ...side(nn),
      matchedBy: how[j],
      changed: contentChanged,
      moved: movedFlag[j],
      old: side(on),
      new: side(nn),
    };
    if (contentChanged) {
      entry.textChanged = textChanged;
      entry.objectsChanged = objectsChanged;
      if (withDiff) {
        const parts = [];
        if (textChanged) parts.push(wordDiff(on.text ?? "", nn.text ?? "", opts));
        if (objectsChanged) {
          // Say WHICH kind of change it was. "changed" with an empty word diff
          // reads like a bug in the differ.
          const before = oldObjs.length;
          const after = newObjs.length;
          parts.push(
            before === after
              ? `[image content changed: ${countDiff(oldObjs, newObjs)} of ${after}]`
              : `[images: ${before} → ${after}]`,
          );
        }
        entry.diff = parts.join("\n");
      }
      changed.push(entry);
    }
    if (movedFlag[j]) moved.push(entry);
    if (!contentChanged && !movedFlag[j]) unchanged.push(entry);
  }
  for (let i = 0; i < O.length; i++) if (!oMatched[i]) removed.push({ ...side(O[i]), reason: "removed" });

  return { added, removed, changed, moved, unchanged, safety };
}

// Did anything happen? A move with identical text still counts — the document
// changed even though no word did. Used by the caller to decide between the
// full report and the single `변경 없음` line.
// How many positions differ between two equal-length digest lists.
function countDiff(a, b) {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
}

export function hasChanges(diff) {
  if (!diff) return false;
  return Boolean(
    diff.added?.length || diff.removed?.length || diff.changed?.length || diff.moved?.length,
  );
}
