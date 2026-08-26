#!/usr/bin/env node
// Usage:
//   node src/core/image.mjs <input> --op list [--format json|text]
//   node src/core/image.mjs <input> --op insert --file <img> --section N --paragraph N
//        [--offset N] [--width HWPUNIT] [--caption "..."] [--float] --output <out.hwp>
//   node src/core/image.mjs <input> --op replace --index N --file <img>
//        [--caption "..."] --output <out.hwp>
//   node src/core/image.mjs <input> --op remove --index N --output <out.hwp>
//
// Put images into an HWP, replace them, or take them out, WITHOUT destroying the
// page layout. Detail and traps: reference/images.md.
//
// CORE-TIER: WASM-only. Identical on claude.ai / cowork / Claude Code.
//
// ── WHY THIS SCRIPT EXISTS ────────────────────────────────────────────────
//
// The engine's own defaults are the layout bug. A picture inserted the obvious
// way comes out FLOATING and pinned to the paper's top-left corner:
//
//   treatAsChar : false          not part of the text
//   vertRelTo   : "Paper"        anchored to the sheet, not the paragraph
//   horzRelTo   : "Paper"
//   vert/horzOffset : 0, 0       so every image piles up in the same corner
//   textWrap    : "Square"       and shoves the body text around
//
// And `width`/`height` are HWPUNIT (1/7200 inch), NOT pixels. Passing an image's
// pixel size puts a 1600px image on the page at 1600 HWPUNIT — a 5.6 mm stamp.
// "Converting" it at 96 dpi gives 120000 HWPUNIT against an A4 usable width of
// 42520 — 2.8x the page. Both calls look successful.
//
// So this script inverts the defaults:
//   • inserts are treatAsChar (inline, flows with the text) unless --float
//   • sizes are computed against the real page geometry, never guessed
//   • a --width that cannot fit is REFUSED, not silently clamped
//   • --op replace swaps only the bytes and puts back what the engine drops
//
// Every write goes through exportVerify (universal edit contract) and both
// data-loss guards (memo, tracked changes).

import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { loadDocument } from "../lib/_bootstrap.mjs";
import { enumArg, flag, inputPath, intArg, strArg } from "../lib/argv.mjs";
import { controlOffsets, eachParagraph } from "../lib/doc_walk.mjs";
import { EXIT, fail } from "../lib/exit-codes.mjs";
import { describeFit, fitToWidth, hwpUnitToMm, usableWidth } from "../lib/image_layout.mjs";
import { assertMemoSafe } from "../lib/memo.mjs";
import { assertTrackChangeSafe } from "../lib/trackchange.mjs";
import { exportVerify } from "../lib/verify.mjs";

const USAGE =
  "usage: image.mjs <input> --op list [--format json|text]\n" +
  "       image.mjs <input> --op insert --file <img> --section N --paragraph N\n" +
  "                 [--width HWPUNIT] [--caption \"...\"] [--float] --output <out.hwp>\n" +
  "       image.mjs <input> --op replace --index N --file <img> [--caption \"...\"] --output <out.hwp>\n" +
  "       image.mjs <input> --op remove --index N --output <out.hwp>";

const input = inputPath(USAGE);
const op = enumArg("--op", ["list", "insert", "replace", "remove"], null);
if (!op) fail(EXIT.USAGE, `error: --op is required\n${USAGE}`);

const format = enumArg("--format", ["json", "text"], "text");
const file = strArg("--file", null);
const output = strArg("--output", null);
const caption = strArg("--caption", null);
const asFloat = flag("--float");
const section = intArg("--section", null);
const paragraph = intArg("--paragraph", null);
// --offset is deliberately NOT an option. The engine IGNORES char_offset for a
// body-inline insert: requesting 0, 5 or 9 into a 16-character paragraph all
// put the picture at 16, the end, and the returned logicalOffset (17) does not
// even match where the control lands (16). Accepting the flag and quietly
// appending anyway would be exactly the kind of silent lie this skill refuses,
// so a caller who passes it is told instead. Placement is per PARAGRAPH; make a
// slot with edit_text.mjs --op insert-paragraph. (spec rule 55)
if (flag("--offset")) {
  fail(
    EXIT.USAGE,
    "error: --offset is not supported: the engine ignores char_offset for a body\n" +
      "       image and always appends it to the end of the target paragraph.\n" +
      "       Choose the PARAGRAPH instead — insert an empty one where you want the\n" +
      "       image with:  node src/core/edit_text.mjs <in> --op insert-paragraph …",
  );
}
const width = intArg("--width", null);
const index = intArg("--index", null);

if (op !== "list" && !output) fail(EXIT.USAGE, `error: --op ${op} requires --output <out.hwp>`);
if ((op === "insert" || op === "replace") && !file) {
  fail(EXIT.USAGE, `error: --op ${op} requires --file <image>`);
}
if (op === "insert" && (section === null || paragraph === null)) {
  fail(EXIT.USAGE, "error: --op insert requires --section N and --paragraph N");
}
if ((op === "replace" || op === "remove") && index === null) {
  fail(EXIT.USAGE, `error: --op ${op} requires --index N (see --op list)`);
}

// ── reading the image file ────────────────────────────────────────────────
// insertPicture needs the image's NATURAL pixel size, and it is the caller's
// job to supply it — the engine does not decode the file to find out. Getting
// it wrong distorts the aspect ratio, so the dimensions are read from the
// file's own header rather than assumed.

const SUPPORTED = new Set(["png", "jpg", "jpeg", "gif", "bmp"]);

function imageSize(buf) {
  // PNG: IHDR width/height are big-endian u32 at 16 and 20.
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), kind: "png" };
  }
  // GIF: little-endian u16 at 6 and 8.
  if (buf.length > 10 && buf.toString("ascii", 0, 3) === "GIF") {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), kind: "gif" };
  }
  // BMP: little-endian i32 at 18 and 22 (height may be negative = top-down).
  if (buf.length > 26 && buf.toString("ascii", 0, 2) === "BM") {
    return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)), kind: "bmp" };
  }
  // JPEG: walk the marker segments to a Start-Of-Frame, which carries the size.
  if (buf.length > 4 && buf.readUInt16BE(0) === 0xffd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      // SOF0..SOF15, excluding the non-frame markers DHT/JPG/DAC.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5), kind: "jpg" };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

function loadImageOrExit(path) {
  const ext = extname(path).slice(1).toLowerCase();
  if (!SUPPORTED.has(ext)) {
    fail(
      EXIT.USAGE,
      `error: unsupported image type ".${ext}" — supported: ${[...SUPPORTED].join(", ")}`,
    );
  }
  let buf;
  try {
    buf = readFileSync(path);
  } catch (e) {
    fail(EXIT.LOAD, `error: cannot read image ${path}: ${e?.message ?? e}`);
  }
  const size = imageSize(buf);
  if (!size || !(size.width > 0) || !(size.height > 0)) {
    fail(
      EXIT.LOAD,
      `error: could not read the pixel dimensions of ${path}.\n` +
        `       The engine needs the image's natural size and does not decode the file itself,\n` +
        `       so a header we cannot parse means the image would be inserted distorted.`,
    );
  }
  return { bytes: new Uint8Array(buf), ext: ext === "jpeg" ? "jpg" : ext, size, byteLength: buf.length };
}

// ── enumerating pictures ──────────────────────────────────────────────────

function listPictures(doc) {
  const out = [];
  for (const { s, p } of eachParagraph(doc)) {
    const offsets = controlOffsets(doc, s, p);
    for (let c = 0; c < offsets.length; c++) {
      let props;
      try {
        props = JSON.parse(doc.getPictureProperties(s, p, c));
      } catch {
        continue; // not a picture
      }
      out.push({
        index: out.length,
        section: s,
        paragraph: p,
        controlIndex: c,
        charOffset: offsets[c],
        props,
      });
    }
  }
  return out;
}

function pictureAt(doc, idx) {
  const all = listPictures(doc);
  const hit = all.find((x) => x.index === idx);
  if (!hit) {
    fail(
      EXIT.NOT_FOUND,
      `error: no image with --index ${idx} (document has ${all.length}).\n` +
        `       list them: node src/core/image.mjs "${input}" --op list`,
    );
  }
  return hit;
}

// ── captions ──────────────────────────────────────────────────────────────
// A caption is addressed like a TABLE CELL hanging off the picture control:
// cell 0, paragraph 0. `setPictureProperties({hasCaption:true})` returns a
// `captionCharOffset`, and writing there with insertText would land in the
// BODY — verified: "앞 문단" became "앞 문단그림 1. 캡션". Always use the
// ByPath cell API. (reference/images.md)

const captionPath = (controlIndex, cellParaIndex = 0) =>
  JSON.stringify([{ controlIndex, cellIndex: 0, cellParaIndex }]);

function readCaption(doc, s, p, c) {
  try {
    const len = doc.getCellParagraphLengthByPath(s, p, captionPath(c));
    if (!(len > 0)) return "";
    return String(doc.getTextInCellByPath(s, p, captionPath(c), 0, len)).normalize("NFC");
  } catch {
    return null; // no caption list on this control
  }
}

function writeCaption(doc, s, p, c, text) {
  // Enabling a caption auto-creates the default text "그림  ", so clear it
  // before writing or the result reads "그림  그림 1. …".
  doc.setPictureProperties(s, p, c, JSON.stringify({ hasCaption: true }));
  try {
    const len = doc.getCellParagraphLengthByPath(s, p, captionPath(c));
    if (len > 0) doc.deleteTextInCellByPath(s, p, captionPath(c), 0, len);
  } catch {
    /* nothing to clear */
  }
  if (text) doc.insertTextInCellByPath(s, p, captionPath(c), 0, text);
}

// ── layout hazards, for `list` ────────────────────────────────────────────
// What makes an existing image a layout problem. Reported, never auto-fixed:
// silently re-anchoring somebody's deliberately-placed logo would be its own
// kind of damage.

function hazardsOf(props, usable) {
  const h = [];
  if (props.treatAsChar === false) h.push("floating (not treated as a character)");
  if (props.vertRelTo === "Paper" || props.horzRelTo === "Paper") {
    h.push("anchored to the PAPER, not the paragraph");
  }
  if (usable > 0 && props.width > usable) {
    h.push(`wider than the text area (${props.width} > ${usable} HWPUNIT)`);
  }
  return h;
}

function pageUsable(doc, s) {
  try {
    return usableWidth(JSON.parse(doc.getPageDef(s)));
  } catch {
    return 0;
  }
}

// ── load ──────────────────────────────────────────────────────────────────

async function loadOrExit(path) {
  try {
    return await loadDocument(path);
  } catch (e) {
    fail(EXIT.LOAD, `error: cannot read ${path}: ${e?.message ?? e}`);
  }
}

// Write ops only: refuse a document whose memos or tracked changes the engine
// would silently destroy (CLAUDE.md rules 4 and 5).
if (op !== "list") {
  assertMemoSafe(input, process.argv);
  assertTrackChangeSafe(input, process.argv);
}

const doc = await loadOrExit(input);

// ── op: list ──────────────────────────────────────────────────────────────

if (op === "list") {
  const pics = listPictures(doc);
  const rows = pics.map((x) => {
    const usable = pageUsable(doc, x.section);
    return {
      index: x.index,
      section: x.section,
      paragraph: x.paragraph,
      controlIndex: x.controlIndex,
      charOffset: x.charOffset,
      width: x.props.width,
      height: x.props.height,
      widthMm: Number(hwpUnitToMm(x.props.width).toFixed(1)),
      heightMm: Number(hwpUnitToMm(x.props.height).toFixed(1)),
      naturalWidth: x.props.originalWidth,
      naturalHeight: x.props.originalHeight,
      treatAsChar: x.props.treatAsChar,
      vertRelTo: x.props.vertRelTo,
      horzRelTo: x.props.horzRelTo,
      textWrap: x.props.textWrap,
      description: x.props.description ?? "",
      hasCaption: x.props.hasCaption,
      caption: x.props.hasCaption ? readCaption(doc, x.section, x.paragraph, x.controlIndex) : "",
      usableWidth: usable,
      hazards: hazardsOf(x.props, usable),
    };
  });

  if (format === "json") {
    process.stdout.write(
      JSON.stringify({ input, sourceFormat: doc.getSourceFormat(), imageCount: rows.length, images: rows }, null, 2) + "\n",
    );
  } else if (!rows.length) {
    process.stdout.write("(no images)\n");
  } else {
    for (const r of rows) {
      process.stdout.write(
        `[${r.index}] section ${r.section}, paragraph ${r.paragraph}, control ${r.controlIndex}\n` +
          `      size ${r.width}x${r.height} HWPUNIT (${r.widthMm}x${r.heightMm} mm), ` +
          `${r.treatAsChar ? "inline (treatAsChar)" : "FLOATING"}\n` +
          (r.description ? `      description: ${r.description}\n` : "") +
          (r.hasCaption ? `      caption: ${JSON.stringify(r.caption)}\n` : "") +
          (r.hazards.length ? `      ⚠ ${r.hazards.join("; ")}\n` : ""),
      );
    }
  }
  const risky = rows.filter((r) => r.hazards.length).length;
  if (risky) {
    process.stderr.write(
      `NOTE: ${risky} of ${rows.length} image(s) sit outside the text flow (floating or ` +
        `paper-anchored, or wider than the text area). They are reported, not changed — ` +
        `re-anchoring a deliberately placed image would be its own kind of damage.\n`,
    );
  }
  process.exit(EXIT.OK);
}

// ── write ops ─────────────────────────────────────────────────────────────

const summary = { ok: true, op, input };

if (op === "insert") {
  const img = loadImageOrExit(file);
  let paragraphEnd = 0;
  try {
    paragraphEnd = doc.getParagraphLength(section, paragraph);
  } catch {
    paragraphEnd = 0; // out-of-range indices are caught by the insert below
  }
  const usable = pageUsable(doc, section);
  const fit = fitToWidth({
    naturalWidthPx: img.size.width,
    naturalHeightPx: img.size.height,
    maxWidth: usable,
    requestedWidth: width,
  });
  if (!fit.ok) {
    fail(
      EXIT.USAGE,
      `error: ${fit.error}\n` +
        `       The image would run past the text area and push the layout apart.\n` +
        `       Omit --width to have it scaled to fit automatically.`,
    );
  }
  process.stderr.write(`${describeFit(fit)}\n`);

  let placed;
  try {
    // cell_path_json "" = insert into the BODY at (section, paragraph, offset).
    placed = JSON.parse(
      // Ask for the end explicitly rather than passing a position the engine
      // would silently move: char_offset is ignored and the picture is
      // appended regardless.
      doc.insertPicture(
        section, paragraph, paragraphEnd, "",
        img.bytes, fit.width, fit.height,
        img.size.width, img.size.height,
        img.ext, strArg("--description", "") ?? "",
        null, null,
      ),
    );
  } catch (e) {
    fail(
      EXIT.CORRUPTION,
      `error: insert failed at section ${section}, paragraph ${paragraph}: ${e?.message ?? e}\n` +
        `       (check the section/paragraph indices are in range)`,
    );
  }
  // Use the control index the ENGINE reports. Paragraph 0 of a section also
  // carries invisible SectionDef/ColumnDef controls, so index 0 is never a
  // safe guess.
  const ctrl = placed.controlIdx;
  const para = placed.paraIdx ?? paragraph;

  if (!asFloat) {
    // The whole point: make it behave like a character so it flows with the
    // text instead of hovering over the page.
    //
    // vertRelTo/horzRelTo are set EXPLICITLY and that is not redundant.
    // Setting treatAsChar alone flips them to "Para" in memory — and they
    // revert to "Paper" on save→reload. Only an explicit set persists.
    // Measured; it is why this command checks the SAVED file rather than
    // trusting the in-memory read. (reference/images.md, spec rule 55.)
    doc.setPictureProperties(
      section, para, ctrl,
      JSON.stringify({ treatAsChar: true, vertRelTo: "Para", horzRelTo: "Para" }),
    );
  } else {
    process.stderr.write(
      "WARNING: --float keeps the engine's default anchoring (floating, relative to the\n" +
        "         PAPER at offset 0,0). Several floating images stack in the same corner and\n" +
        "         push body text around. Use it only when you mean it.\n",
    );
  }
  if (caption !== null) writeCaption(doc, section, para, ctrl, caption);

  Object.assign(summary, {
    section, paragraph: para, controlIndex: ctrl,
    width: fit.width, height: fit.height, fitted: fit.fitted,
    naturalWidth: img.size.width, naturalHeight: img.size.height,
    treatAsChar: !asFloat, caption: caption ?? null,
  });
}

if (op === "replace") {
  const img = loadImageOrExit(file);
  const target = pictureAt(doc, index);
  const { section: s, paragraph: p, controlIndex: c } = target;

  // assignPictureImage keeps width/height/treatAsChar/border/description, but it
  // REWRITES THE CROP — and not to zero. It recomputes it from the new image's
  // pixel dimensions against the stored box, so swapping a 1600x1200 picture for
  // a 200x150 one leaves cropRight=5000 cropBottom=3750 on a picture that had no
  // crop at all: a quarter of the new image is cut off. Only a replacement with
  // identical pixel dimensions comes back clean.
  //
  // So the crop is restored UNCONDITIONALLY, not just when there was one. "Keep
  // the formatting, swap the image" means the box and the crop are whatever they
  // were, and an all-zero crop is a real value meaning "show the whole image" —
  // skipping the restore because it looked like nothing is how the common case
  // (a replacement of a different size) ends up cropped.
  const before = target.props;
  const crop = {
    cropLeft: before.cropLeft, cropTop: before.cropTop,
    cropRight: before.cropRight, cropBottom: before.cropBottom,
  };

  try {
    JSON.parse(doc.assignPictureImage(s, p, "", c, img.bytes, img.size.width, img.size.height, img.ext));
  } catch (e) {
    fail(EXIT.CORRUPTION, `error: replace failed for image ${index}: ${e?.message ?? e}`);
  }
  doc.setPictureProperties(s, p, c, JSON.stringify(crop));
  if (caption !== null) writeCaption(doc, s, p, c, caption);

  Object.assign(summary, {
    index, section: s, paragraph: p, controlIndex: c,
    width: before.width, height: before.height,
    preserved: {
      treatAsChar: before.treatAsChar, width: before.width, height: before.height,
      crop, cropRestored: true,
    },
    caption: caption ?? null,
  });
}

if (op === "remove") {
  const target = pictureAt(doc, index);
  try {
    JSON.parse(doc.deletePictureControl(target.section, target.paragraph, target.controlIndex));
  } catch (e) {
    fail(EXIT.CORRUPTION, `error: remove failed for image ${index}: ${e?.message ?? e}`);
  }
  Object.assign(summary, { index, section: target.section, paragraph: target.paragraph });
}

// ── verify ────────────────────────────────────────────────────────────────

let result;
try {
  result = await exportVerify(doc, output, {});
} catch (e) {
  fail(EXIT.CORRUPTION, `error: export/verify failed: ${e?.message ?? e}`);
}
if (!result.verified) {
  process.stderr.write(JSON.stringify(result) + "\n");
  fail(EXIT.CORRUPTION, `error: round-trip verification failed — ${output} did not reload cleanly.`);
}

// Re-read from disk: the engine reports success for property writes it ignores,
// so the only honest confirmation is the saved file.
try {
  const reloaded = await loadDocument(result.outputPath);
  const after = listPictures(reloaded);
  summary.imageCount = after.length;
  if (op !== "remove") {
    const saved = after.find((x) => x.controlIndex === summary.controlIndex && x.paragraph === summary.paragraph);
    if (saved) {
      summary.confirmed = {
        treatAsChar: saved.props.treatAsChar,
        width: saved.props.width,
        height: saved.props.height,
        hasCaption: saved.props.hasCaption,
        caption: saved.props.hasCaption
          ? readCaption(reloaded, saved.section, saved.paragraph, saved.controlIndex)
          : "",
      };
      summary.confirmed.vertRelTo = saved.props.vertRelTo;
      summary.confirmed.crop = {
        cropLeft: saved.props.cropLeft, cropTop: saved.props.cropTop,
        cropRight: saved.props.cropRight, cropBottom: saved.props.cropBottom,
      };
      summary.confirmed.horzRelTo = saved.props.horzRelTo;
      if (
        op === "insert" && !asFloat &&
        (saved.props.vertRelTo === "Paper" || saved.props.horzRelTo === "Paper")
      ) {
        fail(
          EXIT.CORRUPTION,
          "error: the image is inline but still anchored to the PAPER on disk.\n" +
            "       Setting treatAsChar alone does not persist the anchor change; it must be\n" +
            "       written explicitly. The output is not safe to use as-is.",
        );
      }
      if (op === "replace" && JSON.stringify(summary.confirmed.crop) !== JSON.stringify(summary.preserved.crop)) {
        process.stderr.write(JSON.stringify({ wanted: summary.preserved.crop, got: summary.confirmed.crop }) + "\n");
        fail(
          EXIT.CORRUPTION,
          "error: the replacement changed the picture's CROP on disk.\n" +
            "       assignPictureImage recomputes the crop from the new image's pixel size,\n" +
            "       and the restore did not take — part of the new image would be cut off.",
        );
      }
      if (op === "insert" && !asFloat && saved.props.treatAsChar !== true) {
        fail(
          EXIT.CORRUPTION,
          "error: the image was inserted but did NOT become inline (treatAsChar) on disk.\n" +
            "       It is floating and anchored to the paper, which is the layout-breaking state\n" +
            "       this command exists to avoid. The output file is not safe to use as-is.",
        );
      }
      if (caption !== null && summary.confirmed.caption.trim() !== String(caption).trim()) {
        process.stderr.write(
          `WARNING: caption on disk is ${JSON.stringify(summary.confirmed.caption)}, ` +
            `not ${JSON.stringify(caption)}.\n`,
        );
      }
    }
  }
} catch {
  /* the clean round-trip above already passed */
}

summary.verified = true;
summary.outputPath = result.outputPath;
process.stdout.write(JSON.stringify(summary) + "\n");
