// Spec tests for section snapshots and diffing — src/lib/snapshot.mjs.
//
// The module is deliberately document-free: it takes an already-built section
// tree plus each node's own text and owns everything downstream (baseline
// files, matching, word diff, the meta.json safety gate). So every tree here is
// written out literally — no .hwp is opened, nothing depends on the engine, and
// a failure points at the rule it broke rather than at a parser.
//
// The properties these tests exist to defend, in order of how easy they are to
// lose in a refactor:
//
//   1. OWN TEXT ONLY. Editing one leaf must report exactly ONE changed section.
//      The moment a node's fingerprint includes its descendants, one edited
//      sentence is reported once per ancestor and the report becomes noise.
//   2. THE META GATE. sourceFormat / tableMode mismatches must REJECT, because
//      the same document read two ways diffs as ~100% changed — a confident
//      lie. Everything else warns and continues.
//   3. MEMO LOSS IS LOUD. A memo count that dropped between baselines is a
//      data-loss signal (CLAUDE.md rule 4), not a cosmetic difference.
//   4. DETERMINISM. Two writes of the same baseline are byte-identical, or the
//      snapshot directory itself becomes a source of phantom diffs.
//   5. A BASELINE IS ALWAYS FINDABLE. A read-only document directory falls back
//      to the tmpdir and says where it went; it never fails the command.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ELISION,
  META_FILE,
  NO_CHANGES_LINE,
  SECTIONS_FILE,
  SNAPSHOT_ROOT,
  buildBaseline,
  checkMeta,
  diffBaselines,
  fallbackSnapshotDir,
  hasChanges,
  normalizeTitle,
  readBaseline,
  snapshotDir,
  wordDiff,
  writeBaseline,
} from "../../src/lib/snapshot.mjs";

// ── fixtures ────────────────────────────────────────────────────────────────

// Build a node in the tree shape the caller (the section-tree module) produces.
const node = (id, title, opts = {}) => ({
  id,
  ref: opts.ref ?? null,
  title,
  level: opts.level ?? id.split(".").length,
  blockIndex: opts.blockIndex ?? 0,
  headEnd: opts.headEnd ?? 0,
  markerClass: opts.markerClass ?? "num-dot",
  children: opts.children ?? [],
});

// A small three-level document, used by most of the matching tests.
function sampleTree() {
  return [
    node("1", "1. 서론", {
      children: [node("1.1", "1.1 배경"), node("1.2", "1.2 목적")],
    }),
    node("2", "2. 본문", {
      children: [node("2.1", "2.1 방법", { children: [node("2.1.1", "2.1.1 절차")] })],
    }),
  ];
}

const sampleText = () => ({
  1: "서론 단락입니다.",
  "1.1": "배경 단락입니다.",
  "1.2": "목적 단락입니다.",
  2: "본문 도입부입니다.",
  "2.1": "방법 개요입니다.",
  "2.1.1": "절차는 다음과 같이 수행한다.",
});

const META = () => ({
  sourceFormat: "hwp",
  tableMode: "body",
  detect: "auto",
  engineVersion: "0.7.19",
  renderVersion: "md-1",
  memos: { digest: "abc123", count: 2 },
});

const build = (nodes = sampleTree(), ownText = sampleText(), meta = META()) =>
  buildBaseline({ nodes, ownText, meta });

// Find a matched pair by its new-side id, in whichever bucket it landed in.
const pair = (diff, id) =>
  [...diff.changed, ...diff.moved, ...diff.unchanged].find((e) => e.id === id) ?? null;
const ids = (list) => list.map((e) => e.id).sort();

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), "hwp-snapshot-test-"));
  try {
    return fn(dir);
  } finally {
    try {
      chmodSync(dir, 0o755); // a read-only-dir test must not block cleanup
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
}

// Baselines land in the OS tmpdir on the EACCES path; clean those up by hand.
const cleanFallback = (docPath) => rmSync(fallbackSnapshotDir(docPath), { recursive: true, force: true });

// ── baseline location ───────────────────────────────────────────────────────

test("snapshotDir: baselines live next to the document, in .hwp-snapshots/<stem>/", () => {
  // Next to the document, not in a temp dir: a snapshot is a user-owned
  // artifact they can see, commit and delete — unlike a cache.
  const d = snapshotDir("/docs/2026 보고서.hwp");
  assert.equal(d, join("/docs", SNAPSHOT_ROOT, "2026 보고서"));
});

test("snapshotDir: an override replaces the ROOT but keeps the per-document stem", () => {
  // Keeping the stem is what stops two documents pointed at one shared
  // --snapshot-dir from silently overwriting each other's baselines.
  const a = snapshotDir("/docs/a.hwp", "/shared/snaps");
  const b = snapshotDir("/elsewhere/b.hwpx", "/shared/snaps");
  assert.equal(a, join("/shared/snaps", "a"));
  assert.equal(b, join("/shared/snaps", "b"));
  assert.notEqual(a, b);
});

test("fallbackSnapshotDir: same-named documents in different directories do not collide", () => {
  const a = fallbackSnapshotDir("/one/report.hwp");
  const b = fallbackSnapshotDir("/two/report.hwp");
  assert.notEqual(a, b, "the fallback must key on the absolute path, not the stem");
  assert.equal(a, fallbackSnapshotDir("/one/report.hwp"), "and it must be stable across runs");
});

// ── round trip ──────────────────────────────────────────────────────────────

test("round trip: write then read gives back an equal baseline", () =>
  withTmp((dir) => {
    const doc = join(dir, "report.hwp");
    writeFileSync(doc, "");
    const baseline = build();
    const w = writeBaseline(doc, baseline, { onWarn: null });
    assert.equal(w.written, true);
    assert.equal(w.path, join(dir, SNAPSHOT_ROOT, "report"));
    assert.deepEqual(readBaseline(doc, { onWarn: null }), baseline);
  }));

test("round trip honours a --snapshot-dir override on both write and read", () =>
  withTmp((dir) => {
    const doc = join(dir, "report.hwp");
    const override = join(dir, "snaps");
    const baseline = build();
    const w = writeBaseline(doc, baseline, { dir: override, onWarn: null });
    assert.equal(w.path, join(override, "report"));
    assert.equal(readBaseline(doc, { onWarn: null }), null, "the default location must still be empty");
    assert.deepEqual(readBaseline(doc, { dir: override, onWarn: null }), baseline);
  }));

test("readBaseline: a missing baseline is null, not an error (this is the first run)", () =>
  withTmp((dir) => {
    assert.equal(readBaseline(join(dir, "never-seen.hwp"), { onWarn: null }), null);
  }));

test("readBaseline: a corrupt baseline degrades to a first run with a warning", () =>
  withTmp((dir) => {
    const doc = join(dir, "report.hwp");
    const snaps = join(dir, SNAPSHOT_ROOT, "report");
    mkdirSync(snaps, { recursive: true });
    writeFileSync(join(snaps, META_FILE), "{not json");
    writeFileSync(join(snaps, SECTIONS_FILE), "{not json");
    const warnings = [];
    // Refusing to run because a snapshot file got truncated would make the tool
    // less useful than having no snapshots at all.
    assert.equal(readBaseline(doc, { onWarn: (m) => warnings.push(m) }), null);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /unreadable/);
  }));

test("readBaseline: an incomplete baseline (sections.json only) reads as no baseline", () =>
  withTmp((dir) => {
    const doc = join(dir, "report.hwp");
    const snaps = join(dir, SNAPSHOT_ROOT, "report");
    mkdirSync(snaps, { recursive: true });
    writeFileSync(join(snaps, SECTIONS_FILE), JSON.stringify({ version: 1, nodes: [] }));
    assert.equal(readBaseline(doc, { onWarn: null }), null, "meta.json is the commit marker");
  }));

test("readBaseline: a torn baseline (meta.json from another run) reads as no baseline", () =>
  withTmp((dir) => {
    const doc = join(dir, "report.hwp");
    const w = writeBaseline(doc, build(), { onWarn: null });
    // Simulate a crash between the two atomic renames: sections.json is from
    // this run, meta.json from the last one. Comparing them would check the
    // wrong safety record against the right sections.
    const text = sampleText();
    text["1.1"] = "다른 내용.";
    writeFileSync(w.sectionsPath, JSON.stringify({ version: 1, nodes: build(sampleTree(), text).nodes }));
    const warnings = [];
    assert.equal(readBaseline(doc, { onWarn: (m) => warnings.push(m) }), null);
    assert.match(warnings[0], /inconsistent/);
  }));

test("determinism: two writes of the same baseline produce identical bytes", () =>
  withTmp((dir) => {
    const doc = join(dir, "report.hwp");
    const baseline = build();
    const w1 = writeBaseline(doc, baseline, { onWarn: null });
    const first = [readFileSync(w1.metaPath), readFileSync(w1.sectionsPath)];
    const w2 = writeBaseline(doc, build(), { onWarn: null });
    const second = [readFileSync(w2.metaPath), readFileSync(w2.sectionsPath)];
    // A timestamp or an absolute path in the payload would make the snapshot
    // directory itself churn on every run — noise in the user's git history,
    // and a false "something changed" every time.
    assert.deepEqual(second[0], first[0], "meta.json is not byte-stable");
    assert.deepEqual(second[1], first[1], "sections.json is not byte-stable");
    const text = first[0].toString() + first[1].toString();
    assert.equal(/\d{4}-\d{2}-\d{2}T/.test(text), false, "payload must not contain a timestamp");
    assert.equal(text.includes(dir), false, "payload must not contain an absolute path");
  }));

// ── own text only ───────────────────────────────────────────────────────────

test("OWN TEXT ONLY: editing a leaf reports exactly one changed node", () => {
  const before = build();
  const text = sampleText();
  text["2.1.1"] = "절차는 다음과 같이 개정한다.";
  const after = build(sampleTree(), text);
  const d = diffBaselines(before, after);

  assert.deepEqual(ids(d.changed), ["2.1.1"], "exactly one section may be reported as changed");
  assert.deepEqual(d.added, []);
  assert.deepEqual(d.removed, []);
  assert.deepEqual(d.moved, []);
});

test("OWN TEXT ONLY: the edited leaf's ancestors are reported as unchanged", () => {
  // The property most easily lost in a refactor: if a node ever stores its
  // subtree, "2.1" and "2" light up too and one edit reads as three.
  const text = sampleText();
  text["2.1.1"] = "절차는 다음과 같이 개정한다.";
  const d = diffBaselines(build(), build(sampleTree(), text));

  for (const ancestor of ["2", "2.1"]) {
    assert.equal(
      d.changed.some((e) => e.id === ancestor),
      false,
      `${ancestor} is an ancestor of the edited node and must NOT be reported as changed`,
    );
    assert.ok(
      d.unchanged.some((e) => e.id === ancestor),
      `${ancestor} must be reported as unchanged`,
    );
  }
  assert.deepEqual(ids(d.unchanged), ["1", "1.1", "1.2", "2", "2.1"]);
});

test("OWN TEXT ONLY: a parent's own paragraph changes the parent, not its children", () => {
  const text = sampleText();
  text["2"] = "본문 도입부를 새로 썼다.";
  const d = diffBaselines(build(), build(sampleTree(), text));
  assert.deepEqual(ids(d.changed), ["2"]);
});

test("no changes at all: every node is unchanged and hasChanges() is false", () => {
  const d = diffBaselines(build(), build());
  assert.deepEqual(d.changed, []);
  assert.deepEqual(d.added, []);
  assert.deepEqual(d.removed, []);
  assert.deepEqual(d.moved, []);
  assert.equal(d.unchanged.length, 6);
  assert.equal(hasChanges(d), false, `the caller prints "${NO_CHANGES_LINE}" on this`);
});

// ── added / removed / changed / moved ───────────────────────────────────────

test("added: a brand-new section is reported as added, nothing else moves", () => {
  const tree = sampleTree();
  tree[0].children.push(node("1.3", "1.3 범위"));
  const text = { ...sampleText(), "1.3": "이 문서의 적용 범위." };
  const d = diffBaselines(build(), build(tree, text));
  assert.deepEqual(ids(d.added), ["1.3"]);
  assert.deepEqual(d.removed, []);
  assert.deepEqual(d.changed, []);
  assert.deepEqual(d.moved, [], "appending a sibling must not report the others as moved");
});

test("removed: a deleted section is reported as removed, with its old identity", () => {
  const tree = sampleTree();
  tree[0].children = [tree[0].children[0]]; // drop 1.2
  const d = diffBaselines(build(), build(tree, sampleText()));
  assert.deepEqual(ids(d.removed), ["1.2"]);
  assert.equal(d.removed[0].title, "1.2 목적");
  assert.deepEqual(d.added, []);
});

test("changed entries carry a word diff of the section's own text", () => {
  const text = sampleText();
  text["1.1"] = "배경 문단입니다.";
  const d = diffBaselines(build(), build(sampleTree(), text));
  assert.equal(d.changed.length, 1);
  // The shared leading 어절 stays as context; only the word that actually
  // changed is bracketed.
  assert.equal(d.changed[0].diff, "배경 [-단락입니다.-] {+문단입니다.+}");
});

test("withDiff:false skips the word diff but still classifies the change", () => {
  const text = sampleText();
  text["1.1"] = "배경 문단입니다.";
  const d = diffBaselines(build(), build(sampleTree(), text), { withDiff: false });
  assert.equal(d.changed.length, 1);
  assert.equal(d.changed[0].diff, undefined);
});

test("moved: a reparented section is reported as moved, not as remove + add", () => {
  // 1.2 목적 moves under chapter 2.
  const tree = sampleTree();
  const target = tree[0].children.pop(); // 1.2 목적
  target.id = "2.2";
  tree[1].children.push(target);
  const text = { ...sampleText(), "2.2": sampleText()["1.2"] };

  const d = diffBaselines(build(), build(tree, text));
  assert.deepEqual(ids(d.moved), ["2.2"]);
  assert.deepEqual(d.added, [], "a move must not surface as an addition");
  assert.deepEqual(d.removed, [], "a move must not surface as a removal");
  assert.equal(d.moved[0].old.id, "1.2");
  assert.equal(d.moved[0].matchedBy, "title-global", "matched by title outside its old parent");
  assert.equal(d.moved[0].changed, false, "it moved but its text did not change");
});

test("moved: swapping two siblings reports the one that jumped, not both", () => {
  // 1.1 and 1.2 trade places (ids follow position, so both ids stay 1.1/1.2).
  const tree = sampleTree();
  tree[0].children = [node("1.1", "1.1 목적"), node("1.2", "1.2 배경")];
  const text = { ...sampleText(), "1.1": sampleText()["1.2"], "1.2": sampleText()["1.1"] };
  const d = diffBaselines(build(), build(tree, text));
  assert.equal(d.added.length, 0);
  assert.equal(d.removed.length, 0);
  assert.equal(d.changed.length, 0, "the text travelled with the sections; nothing was edited");
  // Blaming every sibling for one section jumping would bury the actual move,
  // so only what falls outside the longest increasing run is flagged.
  assert.equal(d.moved.length, 1);
  assert.equal(d.moved[0].moved, true);
});

test("moved + changed: a relocated AND edited section appears in both lists", () => {
  const tree = sampleTree();
  const target = tree[0].children.pop(); // 1.2 목적
  target.id = "2.2";
  tree[1].children.push(target);
  const text = { ...sampleText(), "2.2": "목적을 다시 썼습니다." };
  const d = diffBaselines(build(), build(tree, text));
  // moved and changed are orthogonal on purpose: collapsing them into one
  // bucket would force the report to drop half of what the co-author did.
  assert.deepEqual(ids(d.moved), ["2.2"]);
  assert.deepEqual(ids(d.changed), ["2.2"]);
  assert.equal(d.changed[0].moved, true);
  assert.equal(d.moved[0].changed, true);
  assert.deepEqual(d.unchanged.some((e) => e.id === "2.2"), false, "unchanged means nothing happened");
});

// ── matching precedence ─────────────────────────────────────────────────────

test("PRECEDENCE: ref wins over id when the two disagree", () => {
  // A new 제5조 is inserted at the top, so 제12조 slides from ordinal 1 to 2.
  // Matching by id would pair the NEW article with the old 제12조 and report
  // both as rewritten; ref is document-unique and must win.
  const before = buildBaseline({
    nodes: [node("1", "제12조(정의)", { ref: "제12조" })],
    ownText: { 1: "이 규정에서 사용하는 용어의 뜻은 다음과 같다." },
    meta: META(),
  });
  const after = buildBaseline({
    nodes: [
      node("1", "제5조(적용)", { ref: "제5조" }),
      node("2", "제12조(정의)", { ref: "제12조" }),
    ],
    ownText: {
      1: "이 규정은 전 부서에 적용한다.",
      2: "이 규정에서 사용하는 용어의 뜻은 다음과 같다.",
    },
    meta: META(),
  });

  const d = diffBaselines(before, after);
  const p = pair(d, "2");
  assert.ok(p, "제12조 must be matched to its old self");
  assert.equal(p.matchedBy, "ref", "ref must win over the ordinal id");
  assert.equal(p.old.id, "1");
  assert.equal(p.new.id, "2");
  assert.equal(p.changed, false, "its text is untouched");
  assert.deepEqual(ids(d.added), ["1"], "the inserted article is the only addition");
  assert.deepEqual(d.removed, []);
});

test("PRECEDENCE: id matches when nothing moved", () => {
  const text = sampleText();
  text["1.2"] = "목적을 조금 고쳤다.";
  const d = diffBaselines(build(), build(sampleTree(), text));
  assert.equal(pair(d, "1.2").matchedBy, "id");
});

test("PRECEDENCE: renumbering falls through to title-within-parent, not to a bogus id pair", () => {
  // Insert a new first chapter: every later chapter's ordinal shifts by one.
  // Bare id matching would pair new "1" (개요) with old "1" (서론) and report
  // the whole document as rewritten, hiding the actual insertion.
  const tree = [node("1", "1. 개요"), node("2", "2. 서론"), node("3", "3. 본문")];
  const before = buildBaseline({
    nodes: [node("1", "1. 서론"), node("2", "2. 본문")],
    ownText: { 1: "서론 단락입니다.", 2: "본문 도입부입니다." },
    meta: META(),
  });
  const after = buildBaseline({
    nodes: tree,
    ownText: { 1: "개요 단락입니다.", 2: "서론 단락입니다.", 3: "본문 도입부입니다." },
    meta: META(),
  });

  const d = diffBaselines(before, after);
  assert.deepEqual(ids(d.added), ["1"], "the inserted chapter is the only addition");
  assert.deepEqual(d.removed, [], "nothing was removed");
  assert.deepEqual(d.changed, [], "no section text changed — only the numbering did");
  assert.equal(pair(d, "2").matchedBy, "title-in-parent");
  assert.equal(pair(d, "2").old.id, "1");
  assert.deepEqual(d.moved, [], "pure renumbering is not a move — reporting it as one is noise");
});

test("PRECEDENCE: a marker-only title change still matches (normalizeTitle strips the marker)", () => {
  assert.equal(normalizeTitle("2. 배경"), normalizeTitle("3. 배경"));
  assert.equal(normalizeTitle("2026년 계획"), "2026년 계획", "a bare year is not an enumeration marker");
});

test("PRECEDENCE: a section retitled AND rewritten in place still matches by bare id", () => {
  // Last resort (pass 5). Without it, an in-place rewrite reads as a removal
  // plus an addition, which hides that section 2 is the same slot.
  const before = buildBaseline({
    nodes: [node("1", "1. 서론"), node("2", "2. 본문")],
    ownText: { 1: "서론.", 2: "본문 도입부입니다." },
    meta: META(),
  });
  const after = buildBaseline({
    nodes: [node("1", "1. 서론"), node("2", "2. 결론")],
    ownText: { 1: "서론.", 2: "완전히 다른 내용을 담았다." },
    meta: META(),
  });
  const d = diffBaselines(before, after);
  assert.deepEqual(ids(d.changed), ["2"]);
  assert.equal(d.changed[0].matchedBy, "id-weak");
  assert.deepEqual(d.added, []);
  assert.deepEqual(d.removed, []);
});

test("ambiguity: two siblings with the same title pair with nobody rather than at random", () => {
  // Both sides have two "(목적)" clauses with no ref. A wrong pairing produces
  // a confident, wrong diff; falling through to add/remove is honest.
  const mk = (t1, t2) =>
    buildBaseline({
      nodes: [node("1", "제1장", { children: [node("1.1", "(목적)"), node("1.2", "(목적)")] })],
      ownText: { 1: "", "1.1": t1, "1.2": t2 },
      meta: META(),
    });
  const d = diffBaselines(mk("가", "나"), mk("가", "다"));
  // 1.1 still pairs by id+digest (its text is unchanged); 1.2 changed on both
  // axes and must not steal 1.1's counterpart.
  assert.equal(d.changed.length + d.added.length + d.removed.length > 0, true);
  assert.equal(
    d.moved.length,
    0,
    "an ambiguous title must never be resolved into a fabricated move",
  );
});

// ── first run / re-baseline ─────────────────────────────────────────────────

test("first run: no baseline exists, one gets created, and nothing errors", () =>
  withTmp((dir) => {
    const doc = join(dir, "report.hwp");
    assert.equal(readBaseline(doc, { onWarn: null }), null);

    const baseline = build();
    const d = diffBaselines(null, baseline);
    // A missing baseline is not an error — the caller reports "baseline
    // created" and exits 0.
    assert.equal(d.firstRun, true);
    assert.equal(d.added.length, 6);
    assert.deepEqual(d.removed, []);
    assert.deepEqual(d.changed, []);
    assert.deepEqual(d.safety.reject, [], "there is nothing to be inconsistent with yet");

    const w = writeBaseline(doc, baseline, { onWarn: null });
    assert.equal(w.written, true);
    assert.deepEqual(readBaseline(doc, { onWarn: null }), baseline);
  }));

test("re-baseline: writing after a report makes the next diff show nothing", () =>
  withTmp((dir) => {
    const doc = join(dir, "report.hwp");
    writeBaseline(doc, build(), { onWarn: null });

    const text = sampleText();
    text["1.1"] = "배경을 고쳤다.";
    const current = build(sampleTree(), text);
    assert.equal(hasChanges(diffBaselines(readBaseline(doc, { onWarn: null }), current)), true);

    // "diff" means "since the last diff", so the report re-baselines.
    writeBaseline(doc, current, { onWarn: null });
    assert.equal(hasChanges(diffBaselines(readBaseline(doc, { onWarn: null }), current)), false);
  }));

test("--no-update: the old baseline stays in place and the path is still reported", () =>
  withTmp((dir) => {
    const doc = join(dir, "report.hwp");
    const original = build();
    writeBaseline(doc, original, { onWarn: null });

    const text = sampleText();
    text["1.1"] = "배경을 고쳤다.";
    const w = writeBaseline(doc, build(sampleTree(), text), { update: false, onWarn: null });

    assert.equal(w.written, false);
    assert.equal(w.skipped, "no-update");
    assert.equal(w.path, join(dir, SNAPSHOT_ROOT, "report"), "every run must report a path");
    assert.deepEqual(readBaseline(doc, { onWarn: null }), original, "the baseline must be untouched");
  }));

// ── EACCES fallback ─────────────────────────────────────────────────────────

test("EACCES: a read-only document directory falls back to the tmpdir and says so", {
  skip: process.getuid?.() === 0 ? "running as root: the permission bit would not bite" : false,
}, () =>
  withTmp((dir) => {
    const docDir = join(dir, "readonly");
    mkdirSync(docDir);
    const doc = join(docDir, "report.hwp");
    writeFileSync(doc, "");
    chmodSync(docDir, 0o555); // a mounted share / a read-only checkout

    const warnings = [];
    try {
      const w = writeBaseline(doc, build(), { onWarn: (m) => warnings.push(m) });
      // Never fail the whole command over a baseline location…
      assert.equal(w.written, true);
      assert.equal(w.fallback, true);
      assert.equal(w.reason, "EACCES");
      // …and never write silently somewhere the user cannot find.
      assert.equal(w.path, fallbackSnapshotDir(doc));
      assert.ok(w.path.startsWith(tmpdir()), `fallback must be under the tmpdir: ${w.path}`);
      assert.equal(warnings.length, 1, "the fallback must be announced on stderr");
      assert.match(warnings[0], /EACCES/);
      assert.ok(warnings[0].includes(w.path), "the warning must name the path actually used");
      // And the fallback baseline must be findable again on the next run —
      // including a run that names a (still empty) --snapshot-dir, since a
      // location we write to but refuse to read from loses a baseline per run.
      assert.deepEqual(readBaseline(doc, { onWarn: null }), build());
      assert.deepEqual(readBaseline(doc, { dir: join(dir, "elsewhere"), onWarn: null }), build());
    } finally {
      chmodSync(docDir, 0o755);
      cleanFallback(doc);
    }
  }));

// ── word diff ───────────────────────────────────────────────────────────────

test("wordDiff: substitution renders as [-old-] {+new+}", () => {
  const out = wordDiff("the quick brown fox", "the quick red fox");
  assert.equal(out, "the quick [-brown-] {+red+} fox");
});

test("wordDiff: identical text yields the empty string, not an empty diff block", () => {
  assert.equal(wordDiff("동일한 문장입니다.", "동일한 문장입니다."), "");
  assert.equal(wordDiff("", ""), "");
  // Whitespace-only churn is not a change: extracted text is not byte-stable
  // across renderer versions, and a report that cries wolf is never read again.
  assert.equal(wordDiff("한 줄  입니다", "한 줄 입니다"), "");
});

test("wordDiff: pure insertion and pure deletion", () => {
  assert.equal(wordDiff("", "새로 쓴 문장"), "{+새로 쓴 문장+}");
  assert.equal(wordDiff("지운 문장", ""), "[-지운 문장-]");
});

test("wordDiff: context window keeps ~4 words around a change", () => {
  const a = "w1 w2 w3 w4 w5 w6 w7 w8 TARGET w9 w10 w11 w12 w13 w14 w15";
  const out = wordDiff(a, a.replace("TARGET", "CHANGED"));
  assert.match(out, /\[-TARGET-\] \{\+CHANGED\+\}/);
  assert.match(out, /w5 w6 w7 w8 \[-TARGET-\]/, "four words of leading context");
  assert.match(out, /\{\+CHANGED\+\} w9 w10 w11 w12/, "four words of trailing context");
  assert.equal(out.includes("w1 "), false, "distant context must be elided, not printed");
});

test("wordDiff: long unchanged stretches are elided with ' … '", () => {
  const words = Array.from({ length: 40 }, (_, i) => `w${i}`);
  const before = words.join(" ");
  const after = words.map((w, i) => (i === 20 ? "EDIT" : w)).join(" ");
  const out = wordDiff(before, after);
  assert.ok(out.startsWith(`${ELISION} `), `leading elision expected: ${out}`);
  assert.ok(out.endsWith(` ${ELISION}`), `trailing elision expected: ${out}`);
  assert.ok(out.length < before.length, "the diff must be shorter than reprinting the section");
});

test("wordDiff: a middle stretch between two changes is elided from both ends", () => {
  const mid = Array.from({ length: 30 }, (_, i) => `m${i}`).join(" ");
  const out = wordDiff(`A ${mid} Z`, `A2 ${mid} Z2`);
  assert.match(out, /m0 m1 m2 m3 … m26 m27 m28 m29/);
});

test("wordDiff: context is configurable", () => {
  const a = "a b c d e f g TARGET h i j k l m n";
  const out = wordDiff(a, a.replace("TARGET", "X"), { context: 1 });
  assert.match(out, /… g \[-TARGET-\] \{\+X\+\} h …/);
});

test("wordDiff: a pathological pair degrades to a summary instead of hanging", () => {
  // O(n·m) with no guard is how a 200-page appendix wedges the CPU. The counts
  // are still true; the answer just arrives in constant time.
  const a = Array.from({ length: 400 }, (_, i) => `a${i}`).join(" ");
  const b = Array.from({ length: 400 }, (_, i) => `b${i}`).join(" ");
  const out = wordDiff(a, b, { maxCells: 1000 });
  assert.match(out, /too large/);
  assert.match(out, /\[-400 words removed-\]/);
  assert.match(out, /\{\+400 words added\+\}/);
});

test("wordDiff: the guard does not fire on a small edit inside a huge section", () => {
  // Trimming the common head and tail before the DP is what keeps a one-word
  // edit in a 5000-word section under the guard.
  const words = Array.from({ length: 5000 }, (_, i) => `w${i}`);
  const before = words.join(" ");
  const after = words.map((w, i) => (i === 2500 ? "EDIT" : w)).join(" ");
  const out = wordDiff(before, after);
  assert.match(out, /\[-w2500-\] \{\+EDIT\+\}/);
  assert.equal(out.includes("too large"), false);
});

// ── the meta.json safety gate ───────────────────────────────────────────────

test("checkMeta: identical meta produces neither a reject nor a warn", () => {
  assert.deepEqual(checkMeta(META(), META()), { reject: [], warn: [] });
});

test("checkMeta: a sourceFormat mismatch REJECTS", () => {
  // The same document read from .hwp and from .hwpx extracts different text and
  // diffs as ~100% changed. Reporting that is a lie, not a diff.
  const r = checkMeta(META(), { ...META(), sourceFormat: "hwpx" });
  assert.equal(r.reject.length, 1);
  assert.equal(r.reject[0].key, "sourceFormat");
  assert.equal(r.reject[0].old, "hwp");
  assert.equal(r.reject[0].new, "hwpx");
  assert.match(r.reject[0].message, /hwp/);
});

test("checkMeta: a tableMode mismatch REJECTS", () => {
  const r = checkMeta(META(), { ...META(), tableMode: "cells" });
  assert.deepEqual(
    r.reject.map((e) => e.key),
    ["tableMode"],
  );
});

test("checkMeta: renderVersion / detect / engineVersion only WARN", () => {
  // A renderer or detection change makes the diff noisy, but a noisy diff still
  // contains the answer — blocking on it would strand the user.
  for (const key of ["renderVersion", "detect", "engineVersion"]) {
    const r = checkMeta(META(), { ...META(), [key]: "something-else" });
    assert.deepEqual(r.reject, [], `${key} must not reject`);
    assert.deepEqual(
      r.warn.map((e) => e.key),
      [key],
    );
    assert.equal(r.warn[0].loud, undefined, `${key} is not a data-loss signal`);
  }
});

test("checkMeta: a changed heading regex or learned ladder warns (deep-compared)", () => {
  const withLadder = (ladder) => ({ ...META(), ladder });
  assert.deepEqual(checkMeta(withLadder(["제N조", "1."]), withLadder(["제N조", "1."])).warn, []);
  const r = checkMeta(withLadder(["제N조", "1."]), withLadder(["제N조", "가."]));
  assert.deepEqual(
    r.warn.map((e) => e.key),
    ["ladder"],
  );
});

test("checkMeta: a DROPPED memo count is a LOUD warn, not a quiet one", () => {
  // CLAUDE.md rule 4: the engine cannot preserve memos through an edit; it
  // deletes them silently on save. Someone who diffs and then edits is standing
  // exactly where that happens, so this must be impossible to miss.
  const r = checkMeta(META(), { ...META(), memos: { digest: "zzz", count: 0 } });
  assert.deepEqual(r.reject, [], "memo loss warns loudly; it does not block the diff");
  const loud = r.warn.filter((w) => w.loud === true);
  assert.equal(loud.length, 1, "the dropped memo count must produce exactly one loud entry");
  assert.equal(loud[0].key, "memos");
  assert.equal(loud[0].old, 2);
  assert.equal(loud[0].new, 0);
  assert.match(loud[0].message, /메모|memo/i);
  assert.match(loud[0].message, /--memos/, "it must point at how to read what is left");
});

test("checkMeta: a memo count that ROSE warns without the loud flag", () => {
  const r = checkMeta(META(), { ...META(), memos: { digest: "zzz", count: 5 } });
  assert.equal(r.warn.length, 1);
  assert.equal(r.warn[0].key, "memos");
  assert.notEqual(r.warn[0].loud, true, "adding memos is not a data-loss signal");
});

test("checkMeta: memo edits at a steady count warn (memos are invisible to the diff)", () => {
  const r = checkMeta(META(), { ...META(), memos: { digest: "different", count: 2 } });
  assert.deepEqual(
    r.warn.map((e) => e.key),
    ["memos"],
  );
  assert.notEqual(r.warn[0].loud, true);
});

test("checkMeta: a changed trackChange state warns", () => {
  const a = { ...META(), trackChange: { enabled: true, count: 3 } };
  const b = { ...META(), trackChange: { enabled: false, count: 3 } };
  assert.deepEqual(checkMeta(a, a).warn, []);
  assert.deepEqual(
    checkMeta(a, b).warn.map((e) => e.key),
    ["trackChange"],
  );
});

test("checkMeta: an unverifiable REJECT key warns instead of stranding the user", () => {
  // An older baseline that never recorded sourceFormat must not become an
  // unfixable exit 2 — but the silence itself is worth saying out loud.
  const older = { ...META() };
  delete older.sourceFormat;
  const r = checkMeta(older, META());
  assert.deepEqual(r.reject, []);
  assert.deepEqual(
    r.warn.map((e) => e.key),
    ["sourceFormat"],
  );
  assert.match(r.warn[0].message, /could not be verified/);
});

test("diffBaselines carries the safety verdict so a caller cannot forget the gate", () => {
  const before = build();
  const after = buildBaseline({
    nodes: sampleTree(),
    ownText: sampleText(),
    meta: { ...META(), sourceFormat: "hwpx" },
  });
  const d = diffBaselines(before, after);
  assert.equal(d.safety.reject.length, 1, "the caller maps a non-empty reject to EXIT.USAGE (2)");
  assert.equal(d.safety.reject[0].key, "sourceFormat");
});

test("checkMeta: a missing meta record on either side never throws", () => {
  assert.deepEqual(checkMeta(undefined, undefined), { reject: [], warn: [] });
  assert.deepEqual(checkMeta(null, META()).reject, []);
});
