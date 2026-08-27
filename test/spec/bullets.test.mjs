// Bullets — the two mechanisms Korean documents actually use.
//
// Measured across 70 real documents: HWP's own bullet feature (headType
// "Bullet") appears in 146 paragraphs across 4 documents, while a glyph typed
// straight into the text ("□ 추진 배경") appears in 274. The format's own
// feature is the one used LESS, so driving only headType would leave most real
// 개조식 lists untouched. Both are implemented; `auto` follows the document.
//
// The unit half tests the policy with no engine at all. The end-to-end half
// spawns format.mjs, because the traps here are in the calling convention:
// ensureDefaultBullet takes a raw string and crashes the WASM heap on anything
// else, and a bullet nobody references is pruned on save (spec rule 64).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadDocument } from "../../src/lib/_bootstrap.mjs";
import { paragraphSet } from "../../src/lib/argv.mjs";
import { parseMarker, textPrefix, BULLET_GLYPHS } from "../../src/lib/bullets.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const FIX = join(ROOT, "samples", "fixture-headings.hwp");

let TMP;
const out = (n) => join(TMP, n);
test.before(() => {
  TMP = mkdtempSync(join(tmpdir(), "hwp-bullets-"));
});
test.after(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
});

const run = (args) =>
  spawnSync(process.execPath, [join("src", "core", "format.mjs"), ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });

function bulletOk(args, label) {
  const r = run(args);
  assert.equal(r.status, 0, `${label}: exit ${r.status}\n${r.stderr}`);
  const j = JSON.parse(r.stdout);
  assert.equal(j.verified, true, `${label}: not verified`);
  return j;
}

async function textOf(path, para) {
  const d = await loadDocument(path);
  const len = d.getParagraphLength(0, para);
  return len > 0 ? d.getTextRange(0, para, 0, len) : "";
}

// ── the marker parser ─────────────────────────────────────────────────────

test("parseMarker: recognises real 개조식 markers", () => {
  assert.deepEqual(parseMarker("□ 추진 배경"), {
    indent: "", glyph: "□", gap: " ", body: "추진 배경", prefixLength: 2,
  });
  assert.equal(parseMarker("  ○ 국내 현황").indent, "  ");
  assert.equal(parseMarker("  ○ 국내 현황").prefixLength, 4);
  assert.equal(parseMarker("　◦ 전각공백").glyph, "◦", "an ideographic space still indents");
});

test("parseMarker: does NOT eat prose that merely starts with a glyph", () => {
  // The separator is what keeps this from mangling ordinary text. Each of
  // these begins with a bullet glyph and is not a bullet.
  for (const t of ["○○ 회사는", "-5% 감소", "*표시 항목", "1. 사업 개요", "-", "□"]) {
    assert.equal(parseMarker(t), null, `${JSON.stringify(t)} must not parse as a marker`);
  }
});

test("textPrefix: depth is leading SPACES, one per level", () => {
  // Not a style choice: of the whitespace indenting marker paragraphs in the
  // corpus, 1,137 characters were SPACE and 3 were TAB, and marginLeft is 0 in
  // 85% of them. The observed ladder is □ at 1, ◦ at 2, ○ at 3.
  assert.equal(textPrefix("□", 0), "□ ");
  assert.equal(textPrefix("□", 2), "  □ ");
  assert.equal(textPrefix("○", 3), "   ○ ");
  assert.ok(BULLET_GLYPHS.includes("□") && BULLET_GLYPHS.includes("○"));
});

test("paragraphSet: batch selection is inclusive and refuses nonsense", () => {
  assert.deepEqual(paragraphSet("--paragraphs", "6"), [6]);
  assert.deepEqual(paragraphSet("--paragraphs", "6-9"), [6, 7, 8, 9], "ranges are inclusive");
  assert.deepEqual(paragraphSet("--paragraphs", "1-3,7,10-11"), [1, 2, 3, 7, 10, 11]);
  assert.deepEqual(paragraphSet("--paragraphs", "5,5,5"), [5], "de-duplicated");
});

// ── end to end ────────────────────────────────────────────────────────────

test("bullet text mode: sets the marker and REPLACES an existing one", async () => {
  // Paragraph 11 is "○ 국내 현황" and 12 is "- 시장 규모…" — both already
  // marked. Prefixing without replacing would give "  ○ ○ 국내 현황".
  const dst = out("set-text.hwp");
  const j = bulletOk(
    [FIX, "--op", "bullet", "--section", "0", "--paragraphs", "11-13",
     "--char", "○", "--level", "2", "--output", dst],
    "set text bullets",
  );
  assert.equal(j.mode, "text", "a document with no HWP bullets gets the glyph convention");
  assert.equal(j.modeSource, "auto");
  assert.equal(j.changes.find((c) => c.paragraph === 11).replaced, "○");
  assert.equal(j.changes.find((c) => c.paragraph === 12).replaced, "-");
  assert.equal(j.changes.find((c) => c.paragraph === 13).replaced, null);

  assert.equal(await textOf(dst, 11), "  ○ 국내 현황");
  assert.equal(await textOf(dst, 12), "  ○ 시장 규모 연 12% 성장");
  // Untargeted neighbours are untouched.
  assert.equal(await textOf(dst, 10), "□ 추진 배경");
  assert.equal(await textOf(dst, 14), "- 주요 사업자 현황");
});

test("bullet hwp mode: the definition survives the save because it is referenced", async () => {
  // An unreferenced bullet is pruned on export — which is why an earlier survey
  // recorded "ensureDefaultBullet does not persist". Applying it to a paragraph
  // is what keeps it.
  const dst = out("set-hwp.hwp");
  const j = bulletOk(
    [FIX, "--op", "bullet", "--section", "0", "--paragraphs", "11-12",
     "--char", "●", "--mode", "hwp", "--level", "1", "--output", dst],
    "set hwp bullets",
  );
  assert.equal(j.mode, "hwp");
  assert.equal(j.modeSource, "explicit");

  const back = await loadDocument(dst);
  const list = JSON.parse(back.getBulletList());
  const entry = list.find((b) => b.id === j.bulletId);
  assert.ok(entry, "the bullet definition is on disk");
  assert.equal(entry.char, "●", "and it is the requested glyph, not the first char of some JSON");
  for (const p of [11, 12]) {
    const pp = JSON.parse(back.getParaPropertiesAt(0, p));
    assert.equal(pp.headType, "Bullet");
    assert.equal(pp.numberingId, j.bulletId);
    assert.equal(pp.paraLevel, 1);
  }
});

test("bullet --remove clears BOTH mechanisms, not just the selected one", async () => {
  // The false-success this guards: "headType is no longer Bullet" is trivially
  // true of a paragraph whose bullet is a typed glyph, so clearing only the
  // mode's own mechanism would leave a visible ○ and report success.
  const withText = out("both-1.hwp");
  bulletOk(
    [FIX, "--op", "bullet", "--section", "0", "--paragraphs", "11-12",
     "--char", "○", "--output", withText], "text bullets first",
  );
  const withBoth = out("both-2.hwp");
  bulletOk(
    [withText, "--op", "bullet", "--section", "0", "--paragraphs", "11-12",
     "--char", "●", "--mode", "hwp", "--output", withBoth], "then hwp bullets on top",
  );
  // Precondition: paragraph 11 now carries a text glyph AND a headType bullet.
  const mid = await loadDocument(withBoth);
  assert.ok(parseMarker(await textOf(withBoth, 11)), "precondition: text marker present");
  assert.equal(JSON.parse(mid.getParaPropertiesAt(0, 11)).headType, "Bullet");

  const cleared = out("both-3.hwp");
  const j = bulletOk(
    [withBoth, "--op", "bullet", "--section", "0", "--paragraphs", "11-12",
     "--remove", "--output", cleared], "remove",
  );
  const c11 = j.changes.find((c) => c.paragraph === 11);
  assert.equal(c11.removedText, "○");
  assert.equal(c11.removedHwpBullet, true);

  const back = await loadDocument(cleared);
  assert.equal(parseMarker(await textOf(cleared, 11)), null, "the glyph is gone");
  assert.notEqual(JSON.parse(back.getParaPropertiesAt(0, 11)).headType, "Bullet", "and so is headType");
});

test("bullet --remove warns when nothing was bulleted", () => {
  // Confirmation alone is satisfied by a paragraph that never had a bullet, so
  // a mis-typed range would otherwise report a clean success.
  const r = run([FIX, "--op", "bullet", "--section", "0", "--paragraphs", "0-2",
    "--remove", "--output", out("remove-none.hwp")]);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /none of the selected paragraphs had a bullet/);
  assert.match(r.stderr, /0, 1, 2/, "the warning names the range so it can be fixed");
});

test("bullet: the arguments that crash or lie are refused", () => {
  const bad = [
    // The engine crashes the WASM heap on a non-string, and keeps only the
    // first character of a longer one — which is how '{"char":"●"}' produced a
    // bullet that renders as `{`.
    [["--char", "●●"], /single character/],
    [["--char", ""], /empty/],
    [["--char", '{"char":"●"}'], /single character/],
    [["--remove", "--char", "○"], /mutually exclusive/],
    [[], /requires --char/],
    [["--char", "○", "--level", "-1"], /--level must be a non-negative integer/],
    [["--char", "○", "--mode", "nope"], /--mode must be auto\|hwp\|text/],
    [["--char", "○", "--props", '{"bold":true}'], /does not take --props/],
  ];
  for (const [extra, expected] of bad) {
    const dst = out("bad.hwp");
    const r = run([FIX, "--op", "bullet", "--section", "0", "--paragraphs", "11", ...extra, "--output", dst]);
    assert.equal(r.status, 2, `${JSON.stringify(extra)} should exit USAGE(2), got ${r.status}`);
    assert.match(r.stderr, expected);
    assert.equal(existsSync(dst), false, "a refused edit writes no file");
  }
});

test("bullet: --paragraphs is validated before the document is touched", () => {
  for (const [spec, expected] of [
    ["9-6", /descending/],
    ["abc", /could not parse/],
    ["9999", /out of range/],
  ]) {
    const dst = out("bad-range.hwp");
    const r = run([FIX, "--op", "bullet", "--section", "0", "--paragraphs", spec,
      "--char", "○", "--output", dst]);
    assert.notEqual(r.status, 0, `${spec} must not succeed`);
    assert.match(r.stderr, expected);
    assert.equal(existsSync(dst), false);
  }
});
