// format.mjs' props validation — the guard against a silently-ignored edit.
//
// The engine returns {"ok":true} for every one of these and changes nothing:
// a typo'd key, the right key in the wrong case, a real-but-inert key, an
// invalid enum value, a wrong-typed value. Before the table in
// lib/format_props.mjs, format.mjs answered `ok:true, verified:true` for a
// document it had not touched — the caller's formatting silently did not
// happen and every signal said it did.
//
// The first half tests the validator directly (pure, no engine). The second
// half spawns format.mjs so the exit codes and messages an agent actually sees
// are what is pinned — a helpful message that never reaches stderr is not help.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadDocument } from "../../src/lib/_bootstrap.mjs";
import {
  CHAR_PROPS,
  PARA_PROPS,
  classifyEffect,
  suggestKey,
  validateProps,
} from "../../src/lib/format_props.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

const ok = (op, props, opts) => validateProps(op, props, opts).errors;

// ── the validator ──────────────────────────────────────────────────────────

test("validator: every documented key is accepted with a well-typed value", () => {
  assert.deepEqual(
    ok("char", {
      bold: true,
      italic: false,
      underline: true,
      strikethrough: true,
      superscript: true,
      subscript: false,
      emboss: true,
      engrave: false,
      fontSize: 1400,
      textColor: "#FF0000",
    }),
    [],
  );
  assert.deepEqual(
    ok("para", {
      alignment: "center",
      lineSpacing: 200,
      marginLeft: 2000,
      marginRight: 0,
      indent: -500, // a hanging indent is a negative indent — must be legal
      spacingBefore: 300,
      spacingAfter: 300,
      keepWithNext: true,
      pageBreakBefore: false,
      widowOrphan: true,
      keepLines: false,
    }),
    [],
  );
});

test("validator: a typo'd key is refused and the nearest key is suggested", () => {
  const errs = ok("para", { alignmnet: "center" });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /unknown --op para property "alignmnet"/);
  assert.match(errs[0], /did you mean "alignment"\?/);
  assert.match(errs[0], /--allow-unknown-props/, "must document its own override");
});

test("validator: the right key in the wrong case is refused, not silently dropped", () => {
  // The commonest slip, and the engine's most convincing lie: {"BOLD":true}
  // returns ok:true and does nothing.
  for (const key of ["BOLD", "Bold", "boldd"]) {
    const errs = ok("char", { [key]: true });
    assert.equal(errs.length, 1, `${key} should be refused`);
    assert.match(errs[0], /did you mean "bold"\?/, `${key} should suggest bold`);
  }
});

test("validator: a key belonging to the OTHER op says so", () => {
  const errs = ok("char", { alignment: "center" });
  assert.match(errs[0], /is a --op para property, not --op char/);
  assert.match(errs[0], /Re-run with --op para/);
  const back = ok("para", { bold: true });
  assert.match(back[0], /is a --op char property, not --op para/);
});

test("validator: a real-but-inert key is named as inert, not as unknown", () => {
  // fontFamily is a genuine field in the getter's output and was DOCUMENTED as
  // supported here. It does nothing: a font has to be registered through the
  // engine's font-id API first. "Unknown key" would be a misleading answer.
  const errs = ok("char", { fontFamily: "굴림" });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /NO EFFECT/);
  assert.match(errs[0], /font-id API/);
});

test("validator: wrong-typed values are refused per type", () => {
  assert.match(ok("char", { bold: "yes" })[0], /must be true or false/);
  assert.match(ok("char", { bold: 1 })[0], /must be true or false/);
  assert.match(ok("char", { fontSize: "big" })[0], /must be an integer/);
  assert.match(ok("char", { fontSize: 14.5 })[0], /must be an integer/);
  assert.match(ok("char", { textColor: "red" })[0], /"#RRGGBB"/);
  assert.match(ok("char", { textColor: "#F00" })[0], /"#RRGGBB"/);
  assert.match(ok("char", { textColor: "FF0000" })[0], /"#RRGGBB"/);
  assert.match(ok("para", { lineSpacing: "double" })[0], /must be an integer/);
});

test("validator: an invalid enum value lists the valid ones and suggests", () => {
  const errs = ok("para", { alignment: "banana" });
  assert.match(errs[0], /"left", "center", "right", "justify", "distribute"/);
  // Case matters to the engine — "Center" is ignored — so it must be caught.
  assert.match(ok("para", { alignment: "Center" })[0], /did you mean "center"\?/);
});

test("validator: an empty props object is refused", () => {
  // {"": …} would apply nothing while reporting success.
  assert.match(ok("para", {})[0], /--props is empty/);
});

test("validator: --allow-unknown-props downgrades unknown keys to a warning", () => {
  const r = validateProps("char", { someFutureKey: 1 }, { allowUnknown: true });
  assert.deepEqual(r.errors, []);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /not a known --op char property/);
  // But a KNOWN key with a bad value is still an error — the override is for
  // vocabulary the table has not learned yet, not for malformed requests.
  const bad = validateProps("char", { bold: "yes" }, { allowUnknown: true });
  assert.equal(bad.errors.length, 1);
});

test("validator: reports every problem at once, not just the first", () => {
  const errs = ok("char", { boldd: true, fontSize: "big", textColor: "red" });
  assert.equal(errs.length, 3, "an agent should be able to fix all of them in one edit");
});

// ── the 2026-08-27 correction ──────────────────────────────────────────────
//
// Six of the seven INEFFECTIVE entries were wrong. Nothing tested them, which
// is exactly why they survived: the table was asserted only where it was
// right. These tests pin the corrected judgements, and the engine-truth pass
// at the bottom of this file proves the judgements against the engine itself.

test("correction: lineSpacingType and underlineType are ACCEPTED — they work", () => {
  // Both were in INEFFECTIVE, so format.mjs refused them with USAGE(2) while
  // the engine applied them perfectly well.
  assert.deepEqual(ok("para", { lineSpacingType: "Fixed" }), []);
  assert.deepEqual(ok("para", { lineSpacingType: "Percent" }), []);
  assert.deepEqual(ok("char", { underlineType: "Bottom" }), []);
  assert.deepEqual(ok("char", { underlineType: "Top" }), []);
  assert.deepEqual(ok("char", { underlineType: "None" }), []);
});

test("correction: the values that FOOLED the old judgement are still refused", () => {
  // "AtLeast" and "Solid" are silently ignored by the engine and read back as
  // "Percent"/"None". Testing with these is what produced the wrong verdict.
  const ls = ok("para", { lineSpacingType: "AtLeast" });
  assert.match(ls[0], /must be one of "Percent", "Fixed"/);
  assert.deepEqual(ok("para", { lineSpacingType: "BetweenLines" }).length, 1);
  const ut = ok("char", { underlineType: "Solid" });
  assert.match(ut[0], /must be one of "None", "Bottom", "Top"/);
  assert.equal(ok("char", { underlineType: "Single" }).length, 1);
});

test("correction: a wrong-NAME key redirects to the working key", () => {
  // These named real features under names the engine does not have. Calling
  // them "unsupported" sent the caller away from a capability that exists.
  for (const [wrong, right] of [
    ["charSpacing", "spacings"],
    ["charWidth", "ratios"],
    ["bgColor", "shadeColor"],
    ["shadow", "shadowType"],
    ["outline", "outlineType"],
  ]) {
    const errs = ok("char", { [wrong]: 1 });
    assert.equal(errs.length, 1, `${wrong} should produce one error`);
    assert.match(errs[0], new RegExp(`the working key is "${right}"`), wrong);
    assert.match(errs[0], /--allow-unknown-props/, `${wrong} must offer the escape hatch`);
    assert.doesNotMatch(errs[0], /NO EFFECT/, `${wrong} is a rename, not an inert key`);
  }
});

test("correction: fontFamily stays inert but now names the route that works", () => {
  const errs = ok("char", { fontFamily: "굴림" });
  assert.match(errs[0], /NO EFFECT/);
  assert.match(errs[0], /applyStyle/, "the one working route must be named");
});

test("suggestKey: only suggests a genuinely close match", () => {
  assert.equal(suggestKey("bolditalic", Object.keys(CHAR_PROPS)), null);
  assert.equal(suggestKey("bld", Object.keys(CHAR_PROPS)), "bold");
  assert.equal(suggestKey("ALIGNMENT", Object.keys(PARA_PROPS)), "alignment");
});

// ── the effect classifier ──────────────────────────────────────────────────

test("classifyEffect: distinguishes changed / already-set / no-effect", () => {
  assert.equal(classifyEffect("bold", true, { bold: false }, { bold: true }), "changed");
  assert.equal(classifyEffect("bold", true, { bold: true }, { bold: true }), "already-set");
  // The dangerous one: the engine accepted it and nothing moved.
  assert.equal(classifyEffect("bold", true, { bold: false }, { bold: false }), "no-effect");
  assert.equal(
    classifyEffect("alignment", "center", { alignment: "left" }, { alignment: "left" }),
    "no-effect",
  );
  // Colors round-trip lower-cased, which is not a failure.
  assert.equal(
    classifyEffect("textColor", "#FF0000", { textColor: "#ff0000" }, { textColor: "#ff0000" }),
    "already-set",
  );
});

test("classifyEffect: unit-converted numbers are 'unverifiable', never a false alarm", () => {
  // marginLeft is sent in HWPUNIT and read back in points, so an unchanged
  // number cannot be told apart from a re-applied one. Reporting that as
  // "no-effect" would fail a correct edit.
  assert.equal(
    classifyEffect("marginLeft", 2000, { marginLeft: 13.3 }, { marginLeft: 13.3 }),
    "unverifiable",
  );
  assert.equal(classifyEffect("marginLeft", 0, { marginLeft: 0 }, { marginLeft: 0 }), "already-set");
  assert.equal(classifyEffect("madeUp", 1, {}, {}), "unexposed");
});

// ── end to end ─────────────────────────────────────────────────────────────

function runFormat(args) {
  return spawnSync(process.execPath, ["src/core/format.mjs", ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

// `await fn(...)`, not `return fn(...)`: a plain try/finally removes the
// directory while an async body is still using it, which surfaces as a
// confusing ENOENT instead of the assertion the test is about.
async function withOut(fn) {
  const dir = mkdtempSync(join(tmpdir(), "hwp-format-"));
  try {
    return await fn(join(dir, "out.hwp"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("format.mjs: a valid char edit still succeeds and reports its effect", async () => {
  await withOut(async (out) => {
    const r = runFormat([
      "samples/fixture-table.hwp", "--op", "char",
      "--section", "0", "--paragraph", "1", "--start", "0", "--end", "5",
      "--props", '{"bold":true}', "--output", out,
    ]);
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.verified, true);
    assert.equal(j.applied.bold, true);
    assert.equal(j.effect.bold, "changed");
    // And it is really on disk.
    const doc = await loadDocument(out);
    assert.equal(JSON.parse(doc.getCharPropertiesAt(0, 1, 0)).bold, true);
  });
});

test("format.mjs: a typo'd key exits USAGE(2) and writes NO output file", async () => {
  await withOut(async (out) => {
    const r = runFormat([
      "samples/fixture-table.hwp", "--op", "para",
      "--section", "0", "--paragraph", "1",
      "--props", '{"alignmnet":"center"}', "--output", out,
    ]);
    assert.equal(r.status, 2, `expected USAGE(2), got ${r.status}`);
    assert.match(r.stderr, /did you mean "alignment"\?/);
    // Refusing must not leave a half-formatted file behind.
    assert.equal(
      spawnSync("test", ["-f", out]).status,
      1,
      "a refused edit must not produce an output document",
    );
  });
});

test("format.mjs: every silent-failure shape is refused before the engine sees it", async () => {
  const cases = [
    ["char", '{"BOLD":true}', /did you mean "bold"/],
    ["char", '{"fontFamily":"굴림"}', /NO EFFECT/],
    ["char", '{"bold":"yes"}', /must be true or false/],
    ["char", '{"textColor":"red"}', /"#RRGGBB"/],
    ["para", '{"alignment":"banana"}', /must be one of/],
    ["para", "{}", /--props is empty/],
  ];
  for (const [op, props, expected] of cases) {
    await withOut(async (out) => {
      const args = [
        "samples/fixture-table.hwp", "--op", op,
        "--section", "0", "--paragraph", "1",
        ...(op === "char" ? ["--start", "0", "--end", "5"] : []),
        "--props", props, "--output", out,
      ];
      const r = runFormat(args);
      assert.equal(r.status, 2, `${op} ${props} should exit 2, got ${r.status}`);
      assert.match(r.stderr, expected);
    });
  }
});

test("format.mjs: --allow-unknown-props warns and proceeds", async () => {
  await withOut(async (out) => {
    const r = runFormat([
      "samples/fixture-table.hwp", "--op", "char",
      "--section", "0", "--paragraph", "1", "--start", "0", "--end", "5",
      "--props", '{"someFutureKey":1}', "--allow-unknown-props", "--output", out,
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /WARNING:/);
    assert.match(r.stderr, /check the result yourself/);
  });
});

test("format.mjs: the error names the valid keys, so a fix needs no docs", async () => {
  await withOut(async (out) => {
    const r = runFormat([
      "samples/fixture-table.hwp", "--op", "para",
      "--section", "0", "--paragraph", "1",
      "--props", '{"nope":1}', "--output", out,
    ]);
    for (const key of Object.keys(PARA_PROPS)) {
      assert.ok(r.stderr.includes(key), `the error should list "${key}"`);
    }
  });
});

// ── engine truth: the correction, proved against the engine ────────────────
//
// The validator tests above pin what WE claim. These pin what the ENGINE does,
// which is the thing the old table got wrong. Every assertion reads the value
// back from the SAVED file, never from memory — the whole class of bug this
// file exists to prevent comes from trusting an in-memory read.
//
// Paragraph 6 of fixture-headings.hwp is used because it has real text.
// Paragraph 5 is EMPTY, and character formatting on an empty paragraph is a
// silent no-op (spec rule 62) — a test written there would pass for the wrong
// reason, or fail for one.

const FIX = join(ROOT, "samples", "fixture-headings.hwp");
const S = 0;
const P = 6;

async function roundTrip(mutate) {
  const { writeFileSync } = await import("node:fs");
  const doc = await loadDocument(FIX);
  mutate(doc);
  return await withOut(async (out) => {
    writeFileSync(out, Buffer.from(doc.exportHwp()));
    return await loadDocument(out);
  });
}

test("engine: lineSpacingType really applies — the old table said it did not", async () => {
  const back = await roundTrip((d) =>
    d.applyParaFormat(S, P, JSON.stringify({ lineSpacingType: "Fixed" })),
  );
  assert.equal(JSON.parse(back.getParaPropertiesAt(S, P)).lineSpacingType, "Fixed");
});

test("engine: lineSpacing changes UNIT with lineSpacingType", async () => {
  // Under "Fixed" the value is HWPUNIT and reads back in points: 2400 -> 16pt.
  // Documenting it as "percent" unconditionally is how a caller gets 16pt
  // line spacing when they asked for 24x.
  const back = await roundTrip((d) =>
    d.applyParaFormat(S, P, JSON.stringify({ lineSpacingType: "Fixed", lineSpacing: 2400 })),
  );
  const p = JSON.parse(back.getParaPropertiesAt(S, P));
  assert.equal(p.lineSpacingType, "Fixed");
  assert.equal(p.lineSpacing, 16, "2400 HWPUNIT under Fixed reads back as 16pt");
});

test("engine: underlineType really applies, but only for Bottom/Top", async () => {
  const good = await roundTrip((d) =>
    d.applyCharFormat(S, P, 0, 10, JSON.stringify({ underline: true, underlineType: "Bottom" })),
  );
  assert.equal(JSON.parse(good.getCharPropertiesAt(S, P, 0)).underlineType, "Bottom");

  // The value that produced the wrong verdict: accepted, ignored, reads "None".
  const bad = await roundTrip((d) =>
    d.applyCharFormat(S, P, 0, 10, JSON.stringify({ underlineType: "Solid" })),
  );
  assert.equal(
    JSON.parse(bad.getCharPropertiesAt(S, P, 0)).underlineType,
    "None",
    'an unaccepted enum value is silently ignored — this is why "Solid" read as unsupported',
  );
});

test("engine: the renamed keys work under their REAL names", async () => {
  const back = await roundTrip((d) =>
    d.applyCharFormat(
      S, P, 0, 10,
      JSON.stringify({ shadeColor: "#123456", shadowType: 1, outlineType: 1 }),
    ),
  );
  const c = JSON.parse(back.getCharPropertiesAt(S, P, 0));
  assert.equal(c.shadeColor, "#123456", "bgColor was the wrong name for shadeColor");
  assert.equal(c.shadowType, 1, "shadow was the wrong name for shadowType");
  assert.equal(c.outlineType, 1, "outline was the wrong name for outlineType");
});

test("engine: fontFamily is genuinely unsettable, and applyStyle is the way", async () => {
  // The one INEFFECTIVE entry that was right.
  const direct = await roundTrip((d) => {
    d.findOrCreateFontId("굴림"); // registering first does NOT help
    d.applyCharFormat(S, P, 0, 10, JSON.stringify({ fontFamily: "굴림" }));
  });
  assert.equal(
    JSON.parse(direct.getCharPropertiesAt(S, P, 0)).fontFamily,
    "함초롬바탕",
    "applyCharFormat must not be believed when it reports success on a font",
  );

  // Style 17 (차례 제목) carries 함초롬돋움. Applying it moves the font.
  const viaStyle = await roundTrip((d) => d.applyStyle(S, P, 17));
  assert.equal(
    JSON.parse(viaStyle.getCharPropertiesAt(S, P, 0)).fontFamily,
    "함초롬돋움",
    "applyStyle carries the style's font — the only route that changes one",
  );
});
