// The picture-property table — the guard against a silently-ignored image edit.
//
// setPictureProperties returns {"ok":true} for every one of these and changes
// nothing: a typo'd key, the right key in the wrong case, a real-but-inert key,
// an invalid enum value, a wrong-typed value, a caption key without its
// companion, and `{}`. An image edit built on that answer reports success for a
// document it did not touch — and because a freshly inserted picture defaults
// to floating and pinned to the paper corner, "did not touch" means the layout
// stays broken in exactly the way the caller was trying to fix.
//
// The first half tests the validator directly (pure, no engine). The second
// half drives the ENGINE, because a property table nobody re-measures is a
// comfortable fiction: every supported key must still move through an
// export→reload, and every key called inert must still be inert. When the
// engine and this table disagree, the engine wins (CLAUDE.md rule 8).

import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { emptyDocument, loadDocumentFromBytes } from "../../src/lib/_bootstrap.mjs";
import {
  CAPTION_PROPS,
  INEFFECTIVE_PICTURE_PROPS,
  PICTURE_PROPS,
  classifyEffect,
  validatePictureProps,
} from "../../src/lib/image_props.mjs";

const errs = (props, opts) => validatePictureProps(props, opts).errors;

// ── the validator ──────────────────────────────────────────────────────────

test("validator: every documented key is accepted with a well-typed value", () => {
  assert.deepEqual(
    errs({
      treatAsChar: true,
      vertRelTo: "Para",
      horzRelTo: "Column",
      vertAlign: "Center",
      horzAlign: "Right",
      vertOffset: -5000, // offsets go both ways and a negative must be legal
      horzOffset: 4000,
      textWrap: "BehindText",
      restrictInPage: true,
      allowOverlap: false,
      sizeProtect: true,
      width: 12000,
      height: 9000,
      cropLeft: 100,
      cropTop: 100,
      cropRight: 100,
      cropBottom: 100,
      paddingLeft: 50,
      paddingTop: 50,
      paddingRight: 50,
      paddingBottom: 50,
      outerMarginLeft: 70,
      outerMarginTop: 70,
      outerMarginRight: 70,
      outerMarginBottom: 70,
      brightness: -30,
      contrast: 20,
      transparency: 50,
      effect: "GrayScale",
      horzFlip: true,
      vertFlip: false,
      rotationAngle: 90,
      borderColor: 255,
      borderWidth: 100,
      description: "설명",
      // The caption block only exists when hasCaption comes with it.
      hasCaption: true,
      captionDirection: "Left",
      captionVertAlign: "Center",
      captionWidth: 8000,
      captionSpacing: 300,
      captionIncludeMargin: true,
    }),
    [],
  );
});

test("validator: a typo'd key is refused and the nearest key is suggested", () => {
  const e = errs({ widht: 12000 });
  assert.equal(e.length, 1);
  assert.match(e[0], /unknown picture property "widht"/);
  assert.match(e[0], /did you mean "width"\?/);
  assert.match(e[0], /--allow-unknown-props/, "must document its own override");
});

test("validator: the right key in the wrong case is refused, not silently dropped", () => {
  // The commonest slip, and the engine's most convincing lie: {"WIDTH":12000}
  // returns ok:true and does nothing.
  for (const key of ["WIDTH", "Width", "widht"]) {
    const e = errs({ [key]: 12000 });
    assert.equal(e.length, 1, `${key} should be refused`);
    assert.match(e[0], /did you mean "width"\?/, `${key} should suggest width`);
  }
  assert.match(errs({ treataschar: true })[0], /did you mean "treatAsChar"\?/);
});

test("validator: a real-but-inert key is named as inert, not as unknown", () => {
  // These three are genuine fields in getPictureProperties' output. They are
  // accepted with ok:true and never applied — "unknown key" would be a lie.
  for (const key of Object.keys(INEFFECTIVE_PICTURE_PROPS)) {
    const e = errs({ [key]: key.startsWith("caption") ? 20000 : 15000 });
    assert.equal(e.length, 1, `${key} should produce exactly one error`);
    assert.match(e[0], /NO EFFECT/, `${key} should be reported as inert`);
    assert.doesNotMatch(e[0], /unknown picture property/);
  }
  assert.match(errs({ originalWidth: 15000 })[0], /insertPicture's width argument/);
  assert.match(errs({ captionMaxWidth: 20000 })[0], /derives it from the picture width/);
});

test("validator: wrong-typed values are refused per type", () => {
  assert.match(errs({ treatAsChar: "true" })[0], /must be true or false/);
  assert.match(errs({ treatAsChar: 1 })[0], /must be true or false/);
  assert.match(errs({ width: "12000" })[0], /must be an integer/);
  // A fraction is worse than a rejection: the engine truncates it and succeeds.
  assert.match(errs({ width: 12000.9 })[0], /TRUNCATES/);
  assert.match(errs({ description: 42 })[0], /must be a string/);
  assert.match(errs({ textWrap: 3 })[0], /must be one of/);
});

test("validator: borderColor is an INTEGER, and says so against the char table", () => {
  // The trap: format_props' `textColor` is "#RRGGBB", this one is a number, and
  // the engine ignores the string form while reporting success.
  for (const v of ["#FF0000", "255", "red", -1, 0x1000000]) {
    const e = errs({ borderColor: v });
    assert.equal(e.length, 1, `borderColor ${JSON.stringify(v)} should be refused`);
    assert.match(e[0], /integer color word/);
  }
  assert.match(errs({ borderColor: "#FF0000" })[0], /textColor/, "must point at the char table");
  assert.deepEqual(errs({ borderColor: 0 }), []);
  assert.deepEqual(errs({ borderColor: 0xffffff }), []);
});

test("validator: an invalid enum value lists the valid ones and suggests", () => {
  const e = errs({ textWrap: "banana" });
  assert.match(e[0], /"Square", "TopAndBottom", "BehindText", "InFrontOfText"/);
  // Case matters to the engine — "square" is ignored — so it must be caught.
  assert.match(errs({ textWrap: "square" })[0], /did you mean "Square"\?/);
  assert.match(errs({ vertAlign: "Middle" })[0], /must be one of/);
  assert.match(errs({ vertRelTo: "PARA" })[0], /did you mean "Para"\?/);
  // "Paragraph" is too far from "Para" for the shared nearest-match heuristic
  // to guess at, so the message has to carry the vocabulary itself.
  assert.match(errs({ vertRelTo: "Paragraph" })[0], /"Paper", "Page", "Para"/);
  // vertRelTo has no "Column"; horzRelTo does. A table that blurred them would
  // hand the caller a silent no-op.
  assert.equal(errs({ vertRelTo: "Column" }).length, 1);
  assert.deepEqual(errs({ horzRelTo: "Column" }), []);
});

test('validator: textWrap "Tight"/"Through" are refused as save-losses, not as typos', () => {
  // They pass the engine's parser and read back correctly IN MEMORY. Only the
  // .hwp round trip reveals that they became "Square".
  for (const v of ["Tight", "Through"]) {
    const e = errs({ textWrap: v });
    assert.equal(e.length, 1);
    assert.match(e[0], /does not survive a save/);
    assert.match(e[0], /downgrades it to Square/);
    assert.match(e[0], /IN MEMORY/);
  }
});

test("validator: an invalid effect says it would RESET, not merely be ignored", () => {
  // Unique among the enums: a bad value turns an existing effect off.
  const e = errs({ effect: "grayScale" });
  assert.match(e[0], /RESETS the picture to "RealPic"/);
  assert.match(e[0], /did you mean "GrayScale"\?/);
});

test("validator: ranges are enforced exactly where the engine corrupts the value", () => {
  assert.match(errs({ brightness: 500 })[0], /wraps/);
  assert.match(errs({ contrast: -129 })[0], /between -128 and 127/);
  assert.match(errs({ transparency: 255 })[0], /clamps/);
  assert.match(errs({ transparency: -1 })[0], /between 0 and 100/);
  assert.match(errs({ width: -1 })[0], />= 0/);
  assert.match(errs({ rotationAngle: 40000 })[0], /wraps/);
  // The boundaries themselves are legal.
  assert.deepEqual(errs({ brightness: 127, contrast: -128, transparency: 100 }), []);
  // And keys the engine stores verbatim are NOT range-checked — an invented
  // bound would refuse edits that work.
  assert.deepEqual(errs({ cropLeft: 400000, borderWidth: -100, vertOffset: -99999 }), []);
});

test("validator: a caption sub-key without its companion is refused", () => {
  for (const key of CAPTION_PROPS) {
    const value = PICTURE_PROPS[key].type === "boolean" ? true
      : PICTURE_PROPS[key].type === "integer" ? 300
      : PICTURE_PROPS[key].values[0];
    const e = errs({ [key]: value });
    assert.equal(e.length, 1, `${key} alone should be refused`);
    assert.match(e[0], /"hasCaption": true/);
    // With the companion present it is a legal edit.
    assert.deepEqual(errs({ hasCaption: true, [key]: value }), []);
  }
  // hasCaption:false is not the companion — it removes the caption.
  assert.match(errs({ hasCaption: false, captionDirection: "Top" })[0], /removes the caption/);
});

test("validator: an empty props object is refused", () => {
  assert.match(errs({})[0], /--props is empty/);
});

test("validator: a non-object never throws and never passes", () => {
  // JSON.parse happily returns these; Object.keys(null) would throw.
  for (const v of [null, [], [1, 2], "width", 5, true]) {
    const r = validatePictureProps(v);
    assert.equal(r.errors.length, 1, `${JSON.stringify(v)} should be refused`);
    assert.match(r.errors[0], /must be a JSON object/);
  }
});

test("validator: --allow-unknown-props downgrades unknown keys to a warning", () => {
  const r = validatePictureProps({ someFutureKey: 1 }, { allowUnknown: true });
  assert.deepEqual(r.errors, []);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /not a known picture property/);
  // But a KNOWN key with a bad value is still an error — the override is for
  // vocabulary the table has not learned yet, not for malformed requests.
  assert.equal(validatePictureProps({ width: "12000" }, { allowUnknown: true }).errors.length, 1);
  assert.equal(
    validatePictureProps({ captionDirection: "Top" }, { allowUnknown: true }).errors.length,
    1,
    "the caption companion rule is about a known key and survives the override",
  );
});

test("validator: reports every problem at once, not just the first", () => {
  const e = errs({ widht: 1, treatAsChar: "yes", borderColor: "#FF0000", effect: "gray" });
  assert.equal(e.length, 4, "an agent should be able to fix all of them in one edit");
});

test("validator: rotating and resizing in one call earns a warning, not an error", () => {
  // It is a legal edit that does something other than what it looks like.
  const r = validatePictureProps({ rotationAngle: 90, width: 12000, height: 9000 });
  assert.deepEqual(r.errors, []);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /applied LAST/);
  // Rotation alone, or sizing alone, is unremarkable.
  assert.deepEqual(validatePictureProps({ rotationAngle: 90 }).warnings, []);
  assert.deepEqual(validatePictureProps({ width: 12000 }).warnings, []);
});

// ── the effect classifier ──────────────────────────────────────────────────

test("classifyEffect: distinguishes changed / already-set / no-effect", () => {
  assert.equal(
    classifyEffect("treatAsChar", true, { treatAsChar: false }, { treatAsChar: true }),
    "changed",
  );
  assert.equal(
    classifyEffect("treatAsChar", true, { treatAsChar: true }, { treatAsChar: true }),
    "already-set",
  );
  // The dangerous one: the engine accepted it and nothing moved.
  assert.equal(
    classifyEffect("treatAsChar", true, { treatAsChar: false }, { treatAsChar: false }),
    "no-effect",
  );
  assert.equal(
    classifyEffect("textWrap", "BehindText", { textWrap: "Square" }, { textWrap: "Square" }),
    "no-effect",
  );
  assert.equal(
    classifyEffect("description", "설명", { description: "설명" }, { description: "설명" }),
    "already-set",
  );
});

test("classifyEffect: an unmoved number is 'unverifiable', never a false alarm", () => {
  // Picture numbers are not unit-converted, but transparency clamps, brightness
  // and contrast wrap, and rotationAngle rewrites width/height — so a requested
  // number that differs from the stored one is not evidence of a no-op.
  assert.equal(
    classifyEffect("transparency", 255, { transparency: 100 }, { transparency: 100 }),
    "unverifiable",
  );
  assert.equal(classifyEffect("width", 12000, { width: 12000 }, { width: 12000 }), "already-set");
  assert.equal(classifyEffect("madeUp", 1, {}, {}), "unexposed");
});

// ── the engine ─────────────────────────────────────────────────────────────

// A 4×3 solid-colour PNG built here rather than committed: insertPicture
// decodes the bytes, so the test needs a real image, and generating one keeps
// this file hermetic and out of the fixture-hash machinery.
const PNG = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  const crc32 = (b) => {
    let c = -1;
    for (let i = 0; i < b.length; i++) c = table[(c ^ b[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const [w, h] = [4, 3];
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // 8-bit depth
  ihdr[9] = 2; // truecolour RGB
  const raw = Buffer.alloc(h * (1 + w * 3), 0x40);
  for (let y = 0; y < h; y++) raw[y * (1 + w * 3)] = 0; // per-row filter: none
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
})();

async function pictureDoc() {
  const doc = await emptyDocument();
  doc.insertText(0, 0, 0, "그림 문단");
  const ins = JSON.parse(
    doc.insertPicture(0, 0, 0, "", PNG, 30000, 22500, 1600, 1200, "png", "", null, null),
  );
  return { doc, para: ins.paraIdx, ci: ins.controlIdx };
}

// Apply each props object in turn, then export→reload. `memory` is what the
// engine claims before the save and `after` is what actually survived it —
// keeping both is the only way to catch a value the serializer drops.
async function apply(...calls) {
  const { doc, para, ci } = await pictureDoc();
  const before = JSON.parse(doc.getPictureProperties(0, para, ci));
  const rets = calls.map((c) => doc.setPictureProperties(0, para, ci, JSON.stringify(c)));
  const memory = JSON.parse(doc.getPictureProperties(0, para, ci));
  const reloaded = await loadDocumentFromBytes(Buffer.from(doc.exportHwp()));
  const after = JSON.parse(reloaded.getPictureProperties(0, para, ci));
  return { before, memory, after, rets };
}

// One value per supported key, each different from the default so that "it
// moved" is unambiguous. The test below asserts this map and PICTURE_PROPS
// cover each other exactly: adding a key to the table without measuring it
// fails here rather than shipping an unverified promise.
const PROBE = {
  treatAsChar: true,
  vertRelTo: "Para",
  horzRelTo: "Column",
  vertAlign: "Bottom",
  horzAlign: "Right",
  vertOffset: 5000,
  horzOffset: -4000,
  textWrap: "BehindText",
  restrictInPage: true,
  allowOverlap: true,
  sizeProtect: true,
  width: 12000,
  height: 9000,
  cropLeft: 1000,
  cropTop: 1100,
  cropRight: 1200,
  cropBottom: 1300,
  paddingLeft: 500,
  paddingTop: 510,
  paddingRight: 520,
  paddingBottom: 530,
  outerMarginLeft: 700,
  outerMarginTop: 710,
  outerMarginRight: 720,
  outerMarginBottom: 730,
  brightness: 30,
  contrast: -20,
  transparency: 50,
  effect: "GrayScale",
  horzFlip: true,
  vertFlip: true,
  rotationAngle: 90,
  borderColor: 255,
  borderWidth: 100,
  description: "설명 텍스트",
  hasCaption: true,
  captionDirection: "Left",
  captionVertAlign: "Center",
  captionWidth: 8000,
  captionSpacing: 300,
  captionIncludeMargin: true,
};

test("engine: a fresh picture defaults to floating and pinned to the paper corner", async () => {
  // The default this whole feature exists to repair. If it ever changes, the
  // module's opening paragraph is wrong and the tests below lose their point.
  const { before } = await apply();
  assert.equal(before.treatAsChar, false);
  assert.equal(before.vertRelTo, "Paper");
  assert.equal(before.horzRelTo, "Paper");
  assert.equal(before.vertOffset, 0);
  assert.equal(before.horzOffset, 0);
  assert.equal(before.textWrap, "Square");
});

test("engine: the probe map and PICTURE_PROPS cover each other exactly", () => {
  assert.deepEqual(Object.keys(PROBE).sort(), Object.keys(PICTURE_PROPS).sort());
});

test("engine: EVERY supported key really moves through export→reload", async () => {
  for (const [key, value] of Object.entries(PROBE)) {
    // Caption sub-keys are only honoured beside hasCaption — that companion is
    // part of what the table promises, not a workaround for a broken test.
    const props = CAPTION_PROPS.includes(key) ? { hasCaption: true, [key]: value } : { [key]: value };
    const { before, after } = await apply(props);
    assert.notDeepEqual(
      after[key],
      before[key],
      `${key}: ${JSON.stringify(value)} did not survive the round trip ` +
        `(still ${JSON.stringify(after[key])}) — it does not belong in PICTURE_PROPS`,
    );
    // Enums, booleans and strings must land on the requested value exactly;
    // the numbers the engine recomputes (rotationAngle's bounding box) only
    // have to move.
    if (typeof value !== "number") {
      assert.deepEqual(after[key], value, `${key} should read back as sent`);
    }
  }
});

test("engine: every enum value in the table survives the round trip", async () => {
  for (const [key, spec] of Object.entries(PICTURE_PROPS)) {
    if (spec.type !== "enum") continue;
    for (const value of spec.values) {
      const props = CAPTION_PROPS.includes(key)
        ? { hasCaption: true, [key]: value }
        : { [key]: value };
      const { after } = await apply(props);
      assert.equal(after[key], value, `${key}: "${value}" should survive the save`);
    }
  }
});

test("engine: every INEFFECTIVE key really is inert", async () => {
  // The other half of the honesty check. If the engine learns to apply one of
  // these, this test goes red and the key moves into the supported table.
  for (const key of Object.keys(INEFFECTIVE_PICTURE_PROPS)) {
    const value = 15000;
    const { before, memory, after, rets } = await apply({ hasCaption: true, [key]: value });
    assert.match(rets[0], /"ok":true/, `${key} should be accepted — that is the whole problem`);
    assert.notEqual(after[key], value, `${key} accepted the value; it is no longer INEFFECTIVE`);
    assert.notEqual(memory[key], value, `${key} moved in memory only — reclassify it`);
    if (key !== "captionMaxWidth") {
      // captionMaxWidth is derived from the picture width, so enabling the
      // caption moves it on its own; the others must not move at all.
      assert.deepEqual(after[key], before[key], `${key} should not move`);
    }
  }
});

test('engine: textWrap "Tight"/"Through" are accepted, then lost on save', async () => {
  // The claim the validator makes in its error message, measured. This is the
  // in-memory-success / on-disk-failure shape CLAUDE.md rule 1 is about.
  for (const value of ["Tight", "Through"]) {
    const { memory, after, rets } = await apply({ textWrap: "TopAndBottom" }, { textWrap: value });
    assert.match(rets[1], /"ok":true/);
    assert.equal(memory.textWrap, value, "the engine claims it applied");
    assert.equal(after.textWrap, "Square", "and the save silently downgraded it");
  }
});

test("engine: an invalid effect RESETS to RealPic; other enums ignore it", async () => {
  const bad = await apply({ effect: "GrayScale" }, { effect: "grayScale" });
  assert.equal(bad.after.effect, "RealPic", "a bad effect turns the existing one off");
  for (const [key, pivot] of [
    ["textWrap", "BehindText"],
    ["vertRelTo", "Para"],
    ["horzRelTo", "Para"],
    ["vertAlign", "Bottom"],
    ["horzAlign", "Right"],
  ]) {
    const { after } = await apply({ [key]: pivot }, { [key]: "banana" });
    assert.equal(after[key], pivot, `${key} should ignore an invalid value, not reset`);
  }
});

test("engine: caption sub-keys are inert unless hasCaption rides along", async () => {
  // Setting the caption up and then adjusting it — the obvious way to write it
  // — changes nothing, ok:true throughout.
  const twoCalls = await apply({ hasCaption: true }, { captionDirection: "Top" });
  assert.match(twoCalls.rets[1], /"ok":true/);
  assert.equal(twoCalls.after.captionDirection, "Bottom", "the second call did nothing");

  const oneCall = await apply({ hasCaption: true, captionDirection: "Top" });
  assert.equal(oneCall.after.captionDirection, "Top");

  // Re-sending hasCaption is what makes a later adjustment stick.
  const readjusted = await apply(
    { hasCaption: true, captionDirection: "Top" },
    { hasCaption: true, captionDirection: "Left" },
  );
  assert.equal(readjusted.after.captionDirection, "Left");

  // And hasCaption:false is not a companion — it takes the caption away.
  const off = await apply({ hasCaption: false, captionDirection: "Top" });
  assert.equal(off.after.hasCaption, false);
  assert.equal(off.after.captionDirection, "Bottom");
});

test("engine: width/height are HWPUNIT and are NOT unit-converted on read-back", async () => {
  // Unlike paragraph margins (marginLeft 2000 reads back as 13.3), what goes in
  // comes out — which is why classifyEffect's numeric branch is conservative
  // for a different reason here than in format_props.
  const { after } = await apply({ width: 12000, height: 9000 });
  assert.equal(after.width, 12000);
  assert.equal(after.height, 9000);
});

test("engine: out-of-range numbers are corrupted, not refused", async () => {
  // The measurements behind the RANGES table.
  assert.equal((await apply({ brightness: 500 })).after.brightness, -12, "wraps in a signed byte");
  assert.equal((await apply({ brightness: -500 })).after.brightness, 12);
  assert.equal((await apply({ transparency: 255 })).after.transparency, 100, "clamps to percent");
  assert.equal((await apply({ rotationAngle: 32768 })).after.rotationAngle, -32768);
  // A negative size is dropped instead of mangled — still a silent no-op.
  const neg = await apply({ width: 12000 }, { width: -5000 });
  assert.equal(neg.after.width, 12000);
});

test("engine: rotationAngle is applied last and rewrites the size in the same call", async () => {
  // Whatever the key order, so a caller who sends both gets a size they did not
  // ask for — hence the validator's warning.
  for (const props of [
    { width: 12000, height: 9000, rotationAngle: 90 },
    { rotationAngle: 90, width: 12000, height: 9000 },
  ]) {
    const { after } = await apply(props);
    assert.equal(after.width, 9000);
    assert.equal(after.height, 12000);
  }
  // Rotating first and sizing second keeps the requested size.
  const split = await apply({ rotationAngle: 90 }, { width: 12000, height: 9000 });
  assert.equal(split.after.width, 12000);
  assert.equal(split.after.height, 9000);
});

test("engine: everything the validator refuses is accepted with ok:true", async () => {
  // The premise of the whole module. Each of these is a silent no-op the engine
  // reports as success — if any ever started failing loudly, the validator
  // could relax.
  const silent = [
    { widht: 12000 },
    { WIDTH: 12000 },
    { originalWidth: 15000 },
    { textWrap: "banana" },
    { treatAsChar: "true" },
    { borderColor: "#FF0000" },
    { captionDirection: "Top" },
    {},
  ];
  for (const props of silent) {
    const { before, after, rets } = await apply(props);
    assert.match(rets[0], /"ok":true/, `${JSON.stringify(props)} should be accepted`);
    assert.deepEqual(after, before, `${JSON.stringify(props)} should change nothing`);
    if (Object.keys(props).length > 0) {
      assert.ok(
        validatePictureProps(props).errors.length > 0,
        `${JSON.stringify(props)} must be refused by the validator`,
      );
    }
  }
});
