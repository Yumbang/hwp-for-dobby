// src/core/image.mjs end to end — the four ops as an agent runs them.
//
// The unit-level judgement lives in image-props / image-layout's own files.
// What this file guards is the BEHAVIOUR the feature exists for: an image put
// into a document must not destroy its layout, and replacing one must not
// quietly change anything but the pixels.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { deflateSync } from "node:zlib";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const FIXTURE = "samples/fixture-image.hwp";

function run(args) {
  return spawnSync(process.execPath, ["src/core/image.mjs", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
}

// A real PNG, built here so the test needs no binary asset.
function png(w, h, rgb = [10, 120, 200]) {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  const crc32 = (b) => {
    let crc = 0xffffffff;
    for (const x of b) crc = table[(crc ^ x) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * (1 + w * 3) + 1 + x * 3;
      raw[o] = rgb[0];
      raw[o + 1] = rgb[1];
      raw[o + 2] = rgb[2];
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), "hwp-image-"));
  try {
    const img = join(dir, "pic.png");
    writeFileSync(img, png(800, 600));
    return await fn({ dir, img, out: join(dir, "out.hwp") });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const listOf = (file) => JSON.parse(run([file, "--op", "list", "--format", "json"]).stdout);

// ── list ──────────────────────────────────────────────────────────────────

test("list: finds every picture and reports its anchoring state", () => {
  const r = run([FIXTURE, "--op", "list", "--format", "json"]);
  assert.equal(r.status, 0, r.stderr);
  const { images } = JSON.parse(r.stdout);
  assert.equal(images.length, 3, "the fixture carries three pictures");
  assert.equal(images.filter((i) => i.treatAsChar).length, 1, "one is inline");
  assert.equal(images.filter((i) => !i.treatAsChar).length, 2, "two are floating");
  assert.ok(images.some((i) => i.hasCaption && i.caption.includes("그림")), "one has a caption");
});

test("list: flags the layout hazards it finds, and changes nothing", () => {
  const r = run([FIXTURE, "--op", "list", "--format", "json"]);
  const { images } = JSON.parse(r.stdout);
  const floating = images.find((i) => !i.treatAsChar);
  assert.ok(floating.hazards.length > 0, "a floating image must be flagged");
  assert.ok(
    floating.hazards.some((h) => /paper/i.test(h)),
    `paper anchoring must be named: ${JSON.stringify(floating.hazards)}`,
  );
  assert.match(r.stderr, /reported, not changed/, "list must say it does not fix things");
});

test("list: a document with no images is exit 0, not an error", () => {
  const r = run(["samples/fixture-clause.hwp", "--op", "list"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /\(no images\)/);
});

// ── insert ────────────────────────────────────────────────────────────────

test("insert: an image becomes INLINE by default, not floating", async () => {
  // The whole point of the feature. A floating, paper-anchored image is what
  // wrecked real documents.
  await withTmp(async ({ img, out }) => {
    const r = run(["samples/fixture-clause.hwp", "--op", "insert", "--file", img,
      "--section", "0", "--paragraph", "3", "--output", out]);
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.treatAsChar, true);
    assert.equal(j.confirmed.treatAsChar, true, "…confirmed by re-reading the saved file");
    const { images } = listOf(out);
    assert.equal(images.length, 1);
    assert.equal(images[0].treatAsChar, true);
    assert.deepEqual(images[0].hazards, [], "an inline image has no layout hazard");
  });
});

test("insert: an oversized image is scaled to the text column, aspect kept", async () => {
  await withTmp(async ({ img, out }) => {
    // 800x600 at 96 dpi is 60000 HWPUNIT — wider than A4's 42520 usable width.
    const r = run(["samples/fixture-clause.hwp", "--op", "insert", "--file", img,
      "--section", "0", "--paragraph", "3", "--output", out]);
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.fitted, true, "it should have been scaled down");
    assert.ok(j.width <= 42520, `width ${j.width} must fit the text column`);
    // 800:600 is 4:3; the stored size must keep it within a rounding unit.
    assert.ok(Math.abs(j.width / j.height - 800 / 600) < 0.01, "aspect ratio must survive");
  });
});

test("insert: --width that cannot fit is REFUSED, never clamped", async () => {
  await withTmp(async ({ img, out }) => {
    const r = run(["samples/fixture-clause.hwp", "--op", "insert", "--file", img,
      "--section", "0", "--paragraph", "3", "--width", "99999", "--output", out]);
    assert.equal(r.status, 2, `expected USAGE(2), got ${r.status}`);
    assert.match(r.stderr, /exceeds the usable width/);
    assert.match(r.stderr, /42520/, "the error must name the width that would fit");
    assert.equal(existsSync(out), false, "a refused insert must not write a document");
  });
});

test("insert: --width that fits is honoured exactly", async () => {
  await withTmp(async ({ img, out }) => {
    const r = run(["samples/fixture-clause.hwp", "--op", "insert", "--file", img,
      "--section", "0", "--paragraph", "3", "--width", "20000", "--output", out]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).width, 20000, "a width that fits must not be re-fitted");
  });
});

test("insert: --caption writes the caption without touching the body", async () => {
  await withTmp(async ({ img, out }) => {
    const text = "그림 1. 캡션 테스트";
    const r = run(["samples/fixture-clause.hwp", "--op", "insert", "--file", img,
      "--section", "0", "--paragraph", "3", "--caption", text, "--output", out]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(JSON.parse(r.stdout).confirmed.caption.includes(text));
    // The trap this guards: writing at captionCharOffset lands in the BODY.
    const body = spawnSync(process.execPath, ["src/core/read.mjs", out, "--no-snapshot"],
      { cwd: ROOT, encoding: "utf8" }).stdout;
    assert.equal(body.includes(text), false, "caption text must NOT leak into the body");
  });
});

test("insert: --float keeps the engine default but says so loudly", async () => {
  await withTmp(async ({ img, out }) => {
    const r = run(["samples/fixture-clause.hwp", "--op", "insert", "--file", img,
      "--section", "0", "--paragraph", "3", "--float", "--output", out]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).treatAsChar, false);
    assert.match(r.stderr, /WARNING/, "opting into floating must warn");
  });
});

test("insert: an unsupported or unreadable image is refused before any edit", async () => {
  await withTmp(async ({ dir, out }) => {
    const bad = join(dir, "not.tiff");
    writeFileSync(bad, "nonsense");
    const r = run(["samples/fixture-clause.hwp", "--op", "insert", "--file", bad,
      "--section", "0", "--paragraph", "3", "--output", out]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unsupported image type/);

    const truncated = join(dir, "broken.png");
    writeFileSync(truncated, Buffer.from([137, 80, 78, 71]));
    const r2 = run(["samples/fixture-clause.hwp", "--op", "insert", "--file", truncated,
      "--section", "0", "--paragraph", "3", "--output", out]);
    assert.equal(r2.status, 1, "unreadable dimensions is a LOAD failure");
    assert.match(r2.stderr, /pixel dimensions/);
  });
});

// ── replace ───────────────────────────────────────────────────────────────

test("replace: swaps the pixels and keeps size and anchoring", async () => {
  // Requirement: "서식 그대로 유지한 채 이미지만 교체".
  await withTmp(async ({ img, out }) => {
    const before = listOf(FIXTURE).images.find((i) => i.treatAsChar);
    const r = run([FIXTURE, "--op", "replace", "--index", String(before.index),
      "--file", img, "--output", out]);
    assert.equal(r.status, 0, r.stderr);
    const after = listOf(out).images.find((i) => i.index === before.index);
    assert.equal(after.width, before.width, "width must be preserved");
    assert.equal(after.height, before.height, "height must be preserved");
    assert.equal(after.treatAsChar, before.treatAsChar, "anchoring must be preserved");
    assert.equal(after.description, before.description, "description must be preserved");
    assert.equal(listOf(out).imageCount, listOf(FIXTURE).imageCount, "count unchanged");
  });
});

test("replace: an unknown --index is NOT_FOUND with a pointer to list", async () => {
  await withTmp(async ({ img, out }) => {
    const r = run([FIXTURE, "--op", "replace", "--index", "99", "--file", img, "--output", out]);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /--op list/);
  });
});

// ── remove ────────────────────────────────────────────────────────────────

test("remove: deletes exactly one image and leaves the rest", async () => {
  await withTmp(async ({ out }) => {
    const before = listOf(FIXTURE);
    const r = run([FIXTURE, "--op", "remove", "--index", "0", "--output", out]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(listOf(out).imageCount, before.imageCount - 1);
  });
});

// ── guards and usage ──────────────────────────────────────────────────────

test("guards: a write op still refuses a memo-bearing document", async () => {
  await withTmp(async ({ img, out }) => {
    const r = run(["samples/fixture-memo.hwpx", "--op", "insert", "--file", img,
      "--section", "0", "--paragraph", "0", "--output", out]);
    assert.equal(r.status, 6, `expected UNSAFE(6), got ${r.status}`);
    assert.match(r.stderr, /--allow-memo-loss/);
  });
});

test("usage: missing arguments fail loudly", () => {
  assert.equal(run([]).status, 2);
  assert.equal(run([FIXTURE]).status, 2); // no --op
  assert.equal(run([FIXTURE, "--op", "insert"]).status, 2); // no --file
  assert.equal(run([FIXTURE, "--op", "replace", "--index", "0"]).status, 2); // no --file
  assert.equal(run([FIXTURE, "--op", "remove"]).status, 2); // no --index
  assert.equal(run([FIXTURE, "--op", "list", "--format", "xml"]).status, 2);
});

test("insert: --offset is refused, because the engine ignores char_offset", async () => {
  // Measured: offsets 0, 5 and 9 into a 16-character paragraph all land at 16.
  // Accepting the flag and appending anyway would be a silent lie.
  await withTmp(async ({ img, out }) => {
    const r = run(["samples/fixture-clause.hwp", "--op", "insert", "--file", img,
      "--section", "0", "--paragraph", "3", "--offset", "2", "--output", out]);
    assert.equal(r.status, 2, `expected USAGE(2), got ${r.status}`);
    assert.match(r.stderr, /ignores char_offset/);
    assert.match(r.stderr, /insert-paragraph/, "it must say how to control placement instead");
  });
});

test("insert: the picture lands at the END of the target paragraph", async () => {
  // The honest statement of the engine's behaviour, pinned so a future version
  // that starts honouring char_offset is noticed rather than assumed.
  await withTmp(async ({ img, out }) => {
    const r = run(["samples/fixture-clause.hwp", "--op", "insert", "--file", img,
      "--section", "0", "--paragraph", "3", "--output", out]);
    assert.equal(r.status, 0, r.stderr);
    const { images } = listOf(out);
    assert.equal(images.length, 1);
    const body = spawnSync(process.execPath, ["src/core/read.mjs", "samples/fixture-clause.hwp", "--no-snapshot"],
      { cwd: ROOT, encoding: "utf8" }).stdout.split("\n")[3] ?? "";
    assert.equal(
      images[0].charOffset, body.length,
      `the control should sit at the paragraph end (${body.length}), not ${images[0].charOffset}`,
    );
  });
});

test("caption: the engine's trailing space is not treated as a mismatch", async () => {
  // Saving appends one U+0020 to caption text. A verifier comparing raw
  // strings would report a failure that is not one.
  await withTmp(async ({ img, out }) => {
    const text = "그림 9. 공백 확인";
    const r = run(["samples/fixture-clause.hwp", "--op", "insert", "--file", img,
      "--section", "0", "--paragraph", "3", "--caption", text, "--output", out]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr.includes("caption on disk is"), false, "no spurious mismatch warning");
    const saved = listOf(out).images[0].caption;
    assert.notEqual(saved, text, "the engine really does append a space");
    assert.equal(saved.trimEnd(), text, "…and trimEnd makes them equal");
  });
});
