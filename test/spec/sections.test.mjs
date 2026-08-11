// End-to-end tests for src/core/sections.mjs — the five ops, as an agent runs
// them.
//
// The unit-level judgement is tested in headings/inline/snapshot's own files.
// What this file is for is the WIRING: that a detected tree turns into the
// right span of text, that ids resolve, that the honesty block reaches stderr,
// that a missing section is NOT_FOUND rather than empty output, and that the
// snapshot lifecycle (first run → no changes → real change) behaves.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { emptyDocument } from "../../src/lib/_bootstrap.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const S = "src/core/sections.mjs";

function run(args, opts = {}) {
  return spawnSync(process.execPath, [S, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    ...opts,
  });
}

// Async-aware: a plain try/finally would rm the directory while an async body
// was still using it, which fails as a confusing ENOENT rather than as the
// assertion the test is actually about.
async function tmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), "hwp-sections-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── outline ───────────────────────────────────────────────────────────────

test("outline: learns the four-level marker chain on fixture-headings", () => {
  const r = run(["samples/fixture-headings.hwp", "--op", "outline", "--no-cache"]);
  assert.equal(r.status, 0, r.stderr);
  // Structure, not just presence: 1 → 1.1 → 1.1.1 → 1.1.1.1 must all appear,
  // which only happens if □ ○ - were learned as three distinct depths.
  for (const id of ["1  ", "1.1  ", "1.1.1  ", "1.1.1.1  "]) {
    assert.ok(r.stdout.includes(id), `outline is missing id ${id.trim()}:\n${r.stdout}`);
  }
  assert.match(r.stderr, /strategy=marker/);
  assert.match(r.stderr, /levels:.*NUM1→1.*BOX→2.*CIRCLE→3/);
});

test("outline: the false positives are absent from the tree", () => {
  const r = run(["samples/fixture-headings.hwp", "--op", "outline", "--no-cache"]);
  assert.equal(r.status, 0);
  // Each of these sits directly beside a real heading in the fixture.
  const mustNotBeHeadings = [
    "1. 사업 개요\t 2", // table of contents
    "1953. 10. 20. 제정", // date line
    "<표 1-1>", // table caption
    "※ 유의사항", // note marker
    "* 각주 성격", // footnote marker
  ];
  for (const bad of mustNotBeHeadings) {
    assert.equal(r.stdout.includes(bad), false, `"${bad}" must not be a heading:\n${r.stdout}`);
  }
  // …while its twin IS one.
  assert.ok(r.stdout.includes("1. 사업 개요"), "the heading twin must be present");
});

test("outline: the detection block reaches stderr and stdout stays the tree", () => {
  const r = run(["samples/fixture-headings.hwp", "--op", "outline", "--no-cache"]);
  assert.match(r.stderr, /^detection: strategy=/m);
  assert.match(r.stderr, /ladder \d+ \w+: (CHOSEN|rejected)/);
  assert.match(r.stderr, /filters:/);
  assert.match(r.stderr, /engine getStructure agreement:/);
  assert.equal(r.stdout.includes("detection:"), false, "the report must not pollute stdout");
});

test("outline: getStructure disagreement is reported, not hidden", () => {
  // The engine's own outline mode returns nothing for this document. That is
  // the finding that justifies having our own detector, so it must be visible.
  const r = run(["samples/fixture-headings.hwp", "--op", "outline", "--no-cache"]);
  assert.match(r.stderr, /engine getStructure agreement: engine reported 0 nodes/);
});

test("outline: clause documents nest 제N조 under 제N장 and expose refs", () => {
  const r = run(["samples/fixture-clause.hwp", "--op", "outline", "--no-cache"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /strategy=clause/);
  assert.match(r.stdout, /1\s+제1장 총칙\s+\[제1장\]/);
  assert.match(r.stdout, /1\.1\s+제1조\(목적\)\s+\[제1조\]/);
});

test("outline: a body-less document indexes its tables instead of returning nothing", () => {
  const r = run(["samples/fixture-table-only.hwp", "--op", "outline", "--no-cache"]);
  assert.equal(r.status, 0, "a table-only document is not an error");
  assert.match(r.stderr, /strategy=table/);
  assert.match(r.stderr, /confidence is LOW/, "and it must say the index is a fallback");
  assert.match(r.stdout, /\[T0\]/);
});

test("outline: --format json emits a parseable tree", () => {
  const r = run(["samples/fixture-clause.hwp", "--op", "outline", "--format", "json", "--no-cache"]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.strategy, "clause");
  assert.ok(Array.isArray(out.tree) && out.tree.length > 0);
  assert.ok(out.tree[0].children.length > 0, "the tree must actually nest");
});

// ── extract ───────────────────────────────────────────────────────────────

test("extract: --id returns that section's body, without repeating its title", () => {
  const r = run(["samples/fixture-headings.hwp", "--op", "extract", "--id", "1.1", "--no-cache"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.startsWith("# □ 추진 배경\n"), r.stdout);
  const body = r.stdout.split("\n").slice(2).join("\n");
  assert.equal(
    body.includes("□ 추진 배경"),
    false,
    "the heading line must not appear again inside its own body",
  );
  assert.ok(body.includes("○ 국내 현황"), "the subtree must be included by default");
});

test("extract: the breadcrumb says where the section sits", () => {
  const r = run(["samples/fixture-headings.hwp", "--op", "extract", "--id", "1.1.1", "--no-cache"]);
  assert.equal(r.status, 0, r.stderr);
  // Without this a subagent handed one chunk cannot tell what it is reading.
  assert.match(r.stdout, /<!-- 1\. 사업 개요 › □ 추진 배경 › ○ 국내 현황 — samples\/fixture-headings\.hwp -->/);
});

test("extract: a ref resolves as well as an id", () => {
  const byRef = run(["samples/fixture-clause.hwp", "--op", "extract", "--id", "제1조", "--no-cache"]);
  const byId = run(["samples/fixture-clause.hwp", "--op", "extract", "--id", "1.1", "--no-cache"]);
  assert.equal(byRef.status, 0, byRef.stderr);
  assert.equal(byId.status, 0, byId.stderr);
  assert.equal(byRef.stdout, byId.stdout, "제1조 and 1.1 name the same section");
});

test("extract: an inline clause heading is split from its body text", () => {
  const r = run(["samples/fixture-clause.hwp", "--op", "extract", "--id", "제1조", "--no-cache"]);
  assert.ok(r.stdout.startsWith("# 제1조(목적)\n"), r.stdout);
  assert.ok(
    r.stdout.includes("이 규정은 학교의 운영에 관한 사항을 정함을 목적으로 한다."),
    "the body that shared the paragraph must survive",
  );
  assert.equal(
    r.stdout.split("\n").slice(2).join("\n").includes("제1조(목적)"),
    false,
    "…and the title must not be duplicated into it",
  );
});

test("extract: --own-text excludes the subtree", () => {
  const withKids = run(["samples/fixture-headings.hwp", "--op", "extract", "--id", "1.1", "--no-cache"]);
  const own = run([
    "samples/fixture-headings.hwp",
    "--op",
    "extract",
    "--id",
    "1.1",
    "--own-text",
    "--no-cache",
  ]);
  assert.equal(own.status, 0, own.stderr);
  assert.ok(withKids.stdout.includes("○ 국내 현황"));
  assert.equal(own.stdout.includes("○ 국내 현황"), false, "--own-text must stop at the next heading");
});

test("extract: an unknown id is NOT_FOUND with a usable hint, not empty output", () => {
  const r = run(["samples/fixture-headings.hwp", "--op", "extract", "--id", "9.9.9", "--no-cache"]);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /no section "9\.9\.9"/);
  assert.match(r.stderr, /available ids include/);
  assert.match(r.stderr, /--op outline/);
});

test("extract: equations and footnotes are spliced into the section body", async () => {
  // fixture-inline.hwp is deliberately a single paragraph (that is what makes
  // its offset assertions crisp), so it has no section to extract. Build a
  // document that has both a heading and inline objects.
  await tmp(async (dir) => {
    const doc = await emptyDocument();
    // TWO numbered headings, not one: a marker class needs more than a single
    // line before the learner will treat it as a level (headings.mjs'
    // MIN_CLASS_SUPPORT). One heading is an anecdote, not an outline.
    const lines = ["1. 수식 절", "앞의 식과 뒤의 식은 같다", "2. 다음 절", "다음 절의 본문이다"];
    for (const [i, text] of lines.entries()) {
      if (i > 0) doc.insertParagraph(0, i);
      doc.insertText(0, i, 0, text);
    }
    doc.insertEquation(0, 1, 4, "x^2 + y^2", 10, 0);
    doc.insertFootnote(0, 1, 11);
    const path = join(dir, "eq.hwp");
    writeFileSync(path, Buffer.from(doc.exportHwp()));

    const r = run([path, "--op", "extract", "--id", "1", "--no-cache"]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(
      r.stdout.includes("x^2 + y^2"),
      `the equation must be rendered inline, not dropped:\n${r.stdout}`,
    );
    // Position matters: a splice at the wrong offset is as wrong as a drop.
    const body = r.stdout.slice(r.stdout.indexOf("-->") + 3);
    assert.ok(
      body.indexOf("앞의 식") < body.indexOf("x^2 + y^2"),
      `the equation landed in the wrong place:\n${body}`,
    );
  });
});

// ── split ─────────────────────────────────────────────────────────────────

test("split: one self-contained file per top-level section", async () => {
  await tmp(async (dir) => {
    const out = join(dir, "chunks");
    const r = run(["samples/fixture-headings.hwp", "--op", "split", "--out-dir", out, "--no-cache"]);
    assert.equal(r.status, 0, r.stderr);
    const files = readdirSync(out).sort();
    assert.equal(files.length, 3, `expected 3 top-level sections, got ${files.join(", ")}`);
    for (const f of files) {
      const text = readFileSync(join(out, f), "utf8");
      assert.ok(text.startsWith("# "), `${f} must open with its title`);
      assert.match(text, /<!--.*fixture-headings\.hwp -->/, `${f} must carry a breadcrumb`);
    }
    // The chunks must partition the document, not duplicate it: section 2's
    // content must not appear in section 1's file.
    const first = readFileSync(join(out, files[0]), "utf8");
    assert.equal(first.includes("□ 조직 구성"), false, "chunk 1 leaked chunk 2's content");
  });
});

// ── snapshot / diff ───────────────────────────────────────────────────────

test("snapshot/diff: first run creates a baseline, second reports no change", async () => {
  await tmp(async (dir) => {
    const snap = join(dir, "snaps");
    const a = run([
      "samples/fixture-headings.hwp",
      "--op",
      "snapshot",
      "--snapshot-dir",
      snap,
      "--no-cache",
    ]);
    assert.equal(a.status, 0, a.stderr);
    assert.match(a.stdout, /baseline: /, "the path must always be reported");
    assert.match(a.stdout, /section\(s\) recorded/);

    const b = run([
      "samples/fixture-headings.hwp",
      "--op",
      "diff",
      "--snapshot-dir",
      snap,
      "--no-cache",
    ]);
    assert.equal(b.status, 0, b.stderr);
    assert.match(b.stdout, /변경 없음/);
  });
});

test("diff: with no previous baseline it creates one and exits 0", async () => {
  await tmp(async (dir) => {
    const r = run([
      "samples/fixture-clause.hwp",
      "--op",
      "diff",
      "--snapshot-dir",
      join(dir, "snaps"),
      "--no-cache",
    ]);
    assert.equal(r.status, 0, "a missing baseline is not an error");
    assert.match(r.stdout, /baseline created/);
  });
});

test("diff: an edited section is reported, and only that section", async () => {
  await tmp(async (dir) => {
    const snap = join(dir, "snaps");
    const build = async (secondBody) => {
      const doc = await emptyDocument();
      const lines = ["1. 첫째 절", "첫째 절의 본문이다.", "2. 둘째 절", secondBody];
      for (const [i, text] of lines.entries()) {
        if (i > 0) doc.insertParagraph(0, i);
        doc.insertText(0, i, 0, text);
      }
      return Buffer.from(doc.exportHwp());
    };
    const path = join(dir, "doc.hwp");

    writeFileSync(path, await build("둘째 절의 본문이다."));
    const first = run([path, "--op", "snapshot", "--snapshot-dir", snap, "--no-cache"]);
    assert.equal(first.status, 0, first.stderr);

    writeFileSync(path, await build("둘째 절의 본문을 고쳤다."));
    const r = run([path, "--op", "diff", "--snapshot-dir", snap, "--no-cache"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^M 2\s/m, `section 2 should be reported as modified:\n${r.stdout}`);
    assert.equal(
      /^M 1\s/m.test(r.stdout),
      false,
      `section 1 was untouched and must not be reported:\n${r.stdout}`,
    );
  });
});

test("diff: a baseline from a different tableMode is REJECTED, not diffed", async () => {
  await tmp(async (dir) => {
    const snap = join(dir, "snaps");
    run([
      "samples/fixture-headings.hwp",
      "--op",
      "snapshot",
      "--snapshot-dir",
      snap,
      "--table-mode",
      "body",
      "--no-cache",
    ]);
    const r = run([
      "samples/fixture-headings.hwp",
      "--op",
      "diff",
      "--snapshot-dir",
      snap,
      "--table-mode",
      "cells",
      "--no-cache",
    ]);
    // Diffing across modes reports enormous change that never happened.
    assert.equal(r.status, 2, `expected USAGE(2), got ${r.status}:\n${r.stderr}`);
    assert.match(r.stderr, /not comparable/);
    assert.match(r.stderr, /--op snapshot/, "and it must say how to fix it");
  });
});

// ── usage ─────────────────────────────────────────────────────────────────

test("usage: missing and malformed arguments fail loudly", () => {
  assert.equal(run([]).status, 2);
  assert.equal(run(["samples/fixture-headings.hwp"]).status, 2); // no --op
  assert.equal(run(["samples/fixture-headings.hwp", "--op", "teleport"]).status, 2);
  assert.equal(run(["samples/fixture-headings.hwp", "--op", "extract"]).status, 2); // no --id
  assert.equal(run(["samples/fixture-headings.hwp", "--op", "split"]).status, 2); // no --out-dir
  const noRe = run(["samples/fixture-headings.hwp", "--op", "outline", "--detect", "regex"]);
  assert.equal(noRe.status, 2);
  assert.match(noRe.stderr, /--heading-regex/);
  const badJson = run([
    "samples/fixture-headings.hwp",
    "--op",
    "outline",
    "--marker-level",
    "{not json",
  ]);
  assert.equal(badJson.status, 2);
  assert.match(badJson.stderr, /--marker-level/);
});

test("usage: a missing file is a LOAD error", () => {
  const r = run(["samples/does-not-exist.hwp", "--op", "outline"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cannot read/);
});

test("overrides: --detect regex forces a pattern, and auto never picks it", () => {
  const forced = run([
    "samples/fixture-headings.hwp",
    "--op",
    "outline",
    "--detect",
    "regex",
    "--heading-regex",
    "^□",
    "--no-cache",
  ]);
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.stderr, /strategy=regex/);
  // Only the □ lines, so the numbered headings are gone.
  assert.equal(forced.stdout.includes("1. 사업 개요"), false);

  const auto = run(["samples/fixture-headings.hwp", "--op", "outline", "--no-cache"]);
  assert.equal(/strategy=regex/.test(auto.stderr), false, "auto must never select regex");
});

// ── cache ─────────────────────────────────────────────────────────────────

test("cache: a cached run produces byte-identical stdout to an uncached one", () => {
  const cold = run(["samples/fixture-headings.hwp", "--op", "outline", "--no-cache"]);
  const warm1 = run(["samples/fixture-headings.hwp", "--op", "outline"]);
  const warm2 = run(["samples/fixture-headings.hwp", "--op", "outline"]);
  assert.equal(warm1.status, 0, warm1.stderr);
  assert.equal(warm2.stdout, warm1.stdout, "a cache hit must not change the answer");
  assert.equal(cold.stdout, warm1.stdout, "…including against a cold run");
  // The report must survive caching too, or a cached run goes quiet about its
  // own uncertainty.
  assert.match(warm2.stderr, /engine getStructure agreement: engine reported 0 nodes/);
});

test("cache: editing the document is picked up immediately", async () => {
  await tmp(async (dir) => {
    const path = join(dir, "doc.hwp");
    const build = async (title) => {
      const doc = await emptyDocument();
      // Two headings, for the same MIN_CLASS_SUPPORT reason as above.
      const lines = [title, "본문 문장이 여기에 있다.", "2. 둘째 제목", "둘째 본문이다."];
      for (const [i, text] of lines.entries()) {
        if (i > 0) doc.insertParagraph(0, i);
        doc.insertText(0, i, 0, text);
      }
      return Buffer.from(doc.exportHwp());
    };
    writeFileSync(path, await build("1. 처음 제목"));
    const a = run([path, "--op", "outline"]);
    assert.equal(a.status, 0, a.stderr);
    assert.ok(a.stdout.includes("처음 제목"));

    writeFileSync(path, await build("1. 바뀐 제목"));
    const b = run([path, "--op", "outline"]);
    assert.equal(b.status, 0, b.stderr);
    assert.ok(b.stdout.includes("바뀐 제목"), `a stale cache entry was served:\n${b.stdout}`);
    assert.equal(b.stdout.includes("처음 제목"), false);
  });
});
