#!/usr/bin/env node
// Usage:
//   node src/core/format.mjs <input> --op char|para --section N --paragraph N \
//     [--start N --end N] --props '<json>' --output <out.hwp>
//
// Apply character or paragraph formatting to one paragraph and save as .hwp.
//
//   --op char  → applyCharFormat(sec, para, start, end, props)   needs --start/--end
//   --op para  → applyParaFormat(sec, para, props)               whole paragraph
//
// CORE-TIER: WASM-only. No rhwp CLI, no capabilities/requireCli. Behaves
// identically on claude.ai / cowork / code.
//
// PROPS — validated against a verified table before anything is applied.
//   char: bold, italic, underline, strikethrough, superscript, subscript,
//         emboss, engrave (boolean); underlineType ("None"|"Bottom"|"Top");
//         fontSize (integer HWPUNIT, 1400 = 14pt); textColor ("#RRGGBB").
//   para: alignment ("left"|"center"|"right"|"justify"|"distribute");
//         lineSpacingType ("Percent"|"Fixed"); lineSpacing (integer — PERCENT
//         under "Percent", HWPUNIT under "Fixed"; the unit follows the type);
//         marginLeft / marginRight / indent / spacingBefore / spacingAfter
//         (integer HWPUNIT, negative allowed for a hanging indent);
//         keepWithNext, pageBreakBefore, widowOrphan, keepLines (boolean).
//   Every key in that list was confirmed by applying it alone and reading the
//   value back after an export→reload. See lib/format_props.mjs.
//
//   WHY THE TABLE EXISTS: the engine is completely permissive. A typo'd key
//   ({"boldd":true}), the right key in the wrong case ({"BOLD":true}), a real
//   key it does not act on ({"fontFamily":"굴림"} — only applyStyle can change
//   a font), a key that is the WRONG NAME for a working feature
//   ({"bgColor":...}, whose real name is shadeColor), an invalid enum value
//   ({"alignment":"banana"}) and a wrong-typed value ({"bold":"yes"}) ALL return
//   {"ok":true} and change nothing. Before this table, format.mjs answered
//   `ok:true, verified:true` for a document it had not altered at all — the
//   formatting silently did not happen and every signal said it did. Unknown or
//   ill-typed props are now a USAGE error naming the nearest valid key;
//   --allow-unknown-props sends them anyway (with a warning) so a future engine
//   version's new key is never blocked by our list.
//
//   The ORIGINAL --props string is still what reaches the engine, unchanged, so
//   the engine always sees exactly what the caller wrote.
//
// VERIFICATION (universal edit contract 2): formatting is NOT text-probeable, so
// exportVerify is called with NO expectPresent/expectAbsent — it still exports,
// atomically writes, reloads from disk, and a `verified:false` would mean the
// engine flagged a corrupt round-trip. On top of that clean-round-trip check we
// RE-READ the applied property from the reloaded document via the engine's shape
// getters (getCharPropertiesAt / getParaPropertiesAt) and report each requested
// key's reloaded value under `applied[]`, so the caller gets positive
// confirmation the property actually stuck on disk — not just an in-memory ok.
// (Visual confirmation — how it RENDERS — still belongs to Phase 3 enhanced/.)
//
// Output is ALWAYS .hwp (exportVerify → assertHwpOutput refuses .hwpx, since
// Hancom Office rejects rhwp-produced HWPX). .hwpx INPUT is fine — exportHwp runs
// the engine's HWPX→HWP adapter for HWPX-sourced docs.
//
// Prints a one-line JSON result on success:
//   {"ok":true,"op":"char","section":0,"paragraph":7,"props":{...},
//    "applied":{"bold":true},"verified":true,"outputPath":"..."}

import { loadDocument } from "../lib/_bootstrap.mjs";
import { EXIT, fail } from "../lib/exit-codes.mjs";
import { paragraphSet } from "../lib/argv.mjs";
import { cellParagraphs, hasCellAddress, resolveCellAddress } from "../lib/cell_addr.mjs";
import {
  BULLET_GLYPHS,
  assertBulletChar,
  detectBulletMode,
  parseMarker,
  textPrefix,
} from "../lib/bullets.mjs";
import { classifyEffect, validateProps } from "../lib/format_props.mjs";
import { buildPalette } from "../lib/palette.mjs";
import {
  detectIndentScheme,
  hangingIndentFor,
  marginForLevel,
  reindentText,
} from "../lib/indent.mjs";
import { assertMemoSafe } from "../lib/memo.mjs";
import { assertTrackChangeSafe } from "../lib/trackchange.mjs";
import { exportVerify } from "../lib/verify.mjs";

const USAGE =
  "usage: format.mjs <input> --op char|para --section N --paragraph N " +
  "[--start N --end N] --props '<json>' [--allow-unknown-props] --output <out.hwp>\n" +
  "       format.mjs <input> --op bullet --section N --paragraphs 6-9 " +
  "[--char '□'] [--level N] [--mode auto|hwp|text] [--remove] --output <out.hwp>\n" +
  "       format.mjs <input> --op indent --section N --paragraphs 6-9 --level N " +
  "[--scheme auto|space|margin] [--no-hanging] --output <out.hwp>\n" +
  "       format.mjs <input> --op list [--section N] [--format text|json]   (read-only, no --output)\n" +
  "  IN A TABLE CELL: add (--table N | --section N --paragraph N --control N) and (--cell N | --row R --col C).\n" +
  "  --paragraphs then addresses the paragraphs INSIDE that cell.";

// Option parsing in the style of the sibling core scripts (replace.mjs): one
// positional input plus named flags. Kept small.
function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name) {
  return process.argv.includes(name);
}
// Parse an integer flag; returns undefined when absent, NaN when present but
// non-numeric (caller rejects NaN as a usage error).
function intArg(name) {
  const v = arg(name);
  if (v === undefined) return undefined;
  return Number.parseInt(v, 10);
}

const input = process.argv[2];
const op = arg("--op");
const section = intArg("--section");
const paragraph = intArg("--paragraph");
const start = intArg("--start");
const end = intArg("--end");
const propsRaw = arg("--props");
const output = arg("--output");
const paragraphsRaw = arg("--paragraphs");
const bulletChar = arg("--char");
const bulletLevel = intArg("--level");
const bulletMode = arg("--mode");
const bulletRemove = flag("--remove");
const indentScheme = arg("--scheme");
const noHanging = flag("--no-hanging");
// Cell addressing (edit_cell.mjs's convention, unchanged). Opt-in: without any
// of these flags every command behaves exactly as before, on body paragraphs.
const inCell = hasCellAddress();
const cellTable = intArg("--table");
const cellIdx = intArg("--cell");
const cellRow = intArg("--row");
const cellCol = intArg("--col");
const cellControl = intArg("--control");

if (flag("-h") || flag("--help")) {
  process.stdout.write(USAGE + "\n");
  process.exit(EXIT.OK);
}

// --- argument validation -----------------------------------------------------
if (!input || input.startsWith("-")) fail(EXIT.USAGE, USAGE);
if (op !== "list" && !output) fail(EXIT.USAGE, USAGE);
if (op === "list" && output) {
  fail(EXIT.USAGE, `error: --op list is read-only and writes no document; drop --output\n${USAGE}`);
}
if (op !== "char" && op !== "para" && op !== "bullet" && op !== "indent" && op !== "list")
  fail(EXIT.USAGE, `error: --op must be 'char', 'para', 'bullet', 'indent' or 'list'\n${USAGE}`);
if (op !== "list" && !inCell && (!Number.isInteger(section) || section < 0))
  fail(EXIT.USAGE, `error: --section must be a non-negative integer\n${USAGE}`);
if (op === "list" && section !== undefined && (!Number.isInteger(section) || section < 0))
  fail(EXIT.USAGE, `error: --section must be a non-negative integer\n${USAGE}`);
if (op !== "bullet" && op !== "indent" && op !== "list") {
  // With a cell address, --paragraph names the paragraph HOSTING the table and
  // is resolved by lib/cell_addr (or supplied by --table), so it is not
  // required here; the target paragraphs are inside the cell.
  if (!inCell && (!Number.isInteger(paragraph) || paragraph < 0))
    fail(EXIT.USAGE, `error: --paragraph must be a non-negative integer\n${USAGE}`);
  if (propsRaw === undefined)
    fail(EXIT.USAGE, `error: --props <json> is required\n${USAGE}`);
}

// bullet takes --paragraphs (a set), and either a --char to set or --remove.
let bulletTargets = null;
let bulletGlyph = null;
if (op === "bullet") {
  bulletTargets = paragraphSet("--paragraphs", paragraphsRaw, USAGE);
  if (bulletRemove) {
    if (bulletChar !== undefined) {
      fail(EXIT.USAGE, `error: --remove and --char are mutually exclusive\n${USAGE}`);
    }
  } else {
    if (bulletChar === undefined) {
      fail(
        EXIT.USAGE,
        `error: --op bullet requires --char '<glyph>' (or --remove).\n` +
          `       Common 개조식 glyphs, outermost first: ${BULLET_GLYPHS.slice(0, 8).join(" ")}\n${USAGE}`,
      );
    }
    bulletGlyph = assertBulletChar(bulletChar);
  }
  if (bulletLevel !== undefined && (!Number.isInteger(bulletLevel) || bulletLevel < 0)) {
    fail(EXIT.USAGE, `error: --level must be a non-negative integer\n${USAGE}`);
  }
  if (bulletMode !== undefined && !["auto", "hwp", "text"].includes(bulletMode)) {
    fail(EXIT.USAGE, `error: --mode must be auto|hwp|text (got ${JSON.stringify(bulletMode)})\n${USAGE}`);
  }
}

// indent takes the same paragraph set as bullet, plus a required --level.
let indentTargets = null;
if (op === "indent") {
  indentTargets = paragraphSet("--paragraphs", paragraphsRaw, USAGE);
  if (bulletLevel === undefined) {
    fail(EXIT.USAGE, `error: --op indent requires --level N (0 is the outermost level)\n${USAGE}`);
  }
  if (!Number.isInteger(bulletLevel) || bulletLevel < 0) {
    fail(EXIT.USAGE, `error: --level must be a non-negative integer\n${USAGE}`);
  }
  if (indentScheme !== undefined && !["auto", "space", "margin"].includes(indentScheme)) {
    fail(EXIT.USAGE, `error: --scheme must be auto|space|margin (got ${JSON.stringify(indentScheme)})\n${USAGE}`);
  }
  if (propsRaw !== undefined) {
    fail(EXIT.USAGE, `error: --op indent does not take --props; use --level and --scheme\n${USAGE}`);
  }
}

// char needs an explicit [start, end) range; para applies to the whole paragraph.
// Inside a CELL the range defaults to the whole cell paragraph, because the
// caller has already named the paragraph by index and asking them to look its
// length up first would be busywork the command can do itself.
if (op === "char" && !inCell) {
  if (!Number.isInteger(start) || start < 0)
    fail(EXIT.USAGE, `error: --op char requires --start (non-negative integer)\n${USAGE}`);
  if (!Number.isInteger(end) || end < 0)
    fail(EXIT.USAGE, `error: --op char requires --end (non-negative integer)\n${USAGE}`);
  if (end < start)
    fail(EXIT.USAGE, `error: --end (${end}) must be >= --start (${start})`);
}

// Validate --props on OUR side: it must parse to a plain JSON object. The engine
// itself silently accepts garbage (unknown keys, empty, even malformed strings —
// all return ok:true), so this is the only guard against a typo'd or non-object
// payload. We pass the ORIGINAL string through to the engine unchanged.
// --op bullet and --op indent carry no --props: their vocabulary is
// --char/--level/--mode and --level/--scheme respectively.
let props;
if (op !== "bullet" && op !== "indent" && op !== "list") {
  try {
    props = JSON.parse(propsRaw);
  } catch (e) {
    fail(EXIT.USAGE, `error: --props is not valid JSON: ${e?.message ?? e}\n${USAGE}`);
  }
  if (props === null || typeof props !== "object" || Array.isArray(props))
    fail(EXIT.USAGE, `error: --props must be a JSON object, e.g. '{"bold":true}'\n${USAGE}`);

  // Then check the KEYS and VALUES against the verified table. This is the only
  // thing standing between a typo and a confident "verified:true" on a document
  // that was never changed — the engine reports success either way.
  const { errors, warnings } = validateProps(op, props, {
    allowUnknown: flag("--allow-unknown-props"),
  });
  for (const w of warnings) process.stderr.write(`WARNING: ${w}\n`);
  if (errors.length) {
    fail(
      EXIT.USAGE,
      errors.map((e) => `error: ${e}`).join("\n") + `\n${USAGE}`,
    );
  }
} else if (op === "bullet" && propsRaw !== undefined) {
  fail(
    EXIT.USAGE,
    `error: --op bullet does not take --props; use --char '<glyph>' and --level N\n${USAGE}`,
  );
}

// Refuse a memo-bearing input (the engine drops memos on save) unless the
// caller passed --allow-memo-loss. No-op on memo-free inputs.
if (op !== "list") assertMemoSafe(input, process.argv);
// Same contract for tracked changes (변경 내용 추적): the engine does not model
// them either, so an edit destroys every recorded change AND the original text
// each deletion still holds. Override: --allow-trackchange-loss.
if (op !== "list") assertTrackChangeSafe(input, process.argv);

// --- load --------------------------------------------------------------------
let doc;
try {
  doc = await loadDocument(input);
} catch (e) {
  fail(EXIT.LOAD, `error: could not load ${input}: ${e?.message ?? e}`);
}

// --- formatting INSIDE a table cell -------------------------------------------
//
// Korean form documents keep their content in tables — 22% of real documents
// have no body paragraphs at all, and on one real 성과요약 form a single cell
// carries 5,086 characters across ~70 paragraphs. Addressing only body
// paragraphs means "centre this paragraph" cannot be done on such a document,
// which is what this branch fixes.
//
// The engine has modelled cell paragraphs all along (applyParaFormatInCell,
// applyCharFormatInCell, getCellParaPropertiesAt — all verified through disk);
// the gap was our addressing stopping at the table. Everything below is
// deliberately the same shape as the body path, so the two do not drift.
if (inCell) {
  if (op === "list") {
    // Read-only: what paragraphs does this cell hold, and what shape is each?
    const addr = resolveCellAddress(
      doc,
      { table: cellTable, section, paragraph, control: cellControl, cell: cellIdx, row: cellRow, col: cellCol },
      USAGE,
    );
    const paras = cellParagraphs(doc, addr);
    const rows = paras.map((cp) => {
      let pp = {};
      let cc = {};
      try {
        pp = JSON.parse(doc.getCellParaPropertiesAt(addr.section, addr.paragraph, addr.control, addr.cell, cp.cellPara));
      } catch { /* a paragraph that will not answer simply reports nothing */ }
      if (cp.length > 0) {
        try {
          cc = JSON.parse(
            doc.getCellCharPropertiesAt(addr.section, addr.paragraph, addr.control, addr.cell, cp.cellPara, 0),
          );
        } catch { /* same */ }
      }
      return {
        cellPara: cp.cellPara,
        length: cp.length,
        text: cp.text,
        alignment: pp.alignment,
        indent: pp.indent,
        marginLeft: pp.marginLeft,
        bold: cc.bold,
        fontSize: cc.fontSize,
      };
    });
    const listFormat = arg("--format") ?? "text";
    if (listFormat === "json") {
      process.stdout.write(JSON.stringify({ input, cell: addr, paragraphs: rows }, null, 2) + "\n");
    } else {
      process.stdout.write(
        `cell (section ${addr.section}, paragraph ${addr.paragraph}, control ${addr.control}, cell ${addr.cell}) — ` +
          `${rows.length} paragraph(s)\n` +
          rows
            .map(
              (r) =>
                `  cp${String(r.cellPara).padStart(3)} len=${String(r.length).padStart(4)} ` +
                `${(r.alignment ?? "?").padEnd(8)} ${r.bold ? "B" : "-"} ${JSON.stringify(r.text.slice(0, 46))}`,
            )
            .join("\n") +
          "\n",
      );
    }
    process.exit(EXIT.OK);
  }

  if (op !== "char" && op !== "para") {
    fail(
      EXIT.USAGE,
      `error: --op ${op} does not support cell addressing yet; --op char and --op para do.\n` +
        `       For bullets and indents inside a cell, use --op para with the props directly.\n${USAGE}`,
    );
  }

  const addr = resolveCellAddress(
    doc,
    { table: cellTable, section, paragraph, control: cellControl, cell: cellIdx, row: cellRow, col: cellCol },
    USAGE,
  );
  const paras = cellParagraphs(doc, addr);
  // --paragraphs now means CELL paragraphs. One vocabulary, one meaning per
  // context, rather than a second flag that means almost the same thing.
  const targets =
    paragraphsRaw !== undefined
      ? paragraphSet("--paragraphs", paragraphsRaw, USAGE)
      : [intArg("--cell-para") ?? 0];
  const oob = targets.filter((t) => t >= paras.length);
  if (oob.length) {
    fail(
      EXIT.NOT_FOUND,
      `error: cell paragraph ${oob.join(", ")} out of range — this cell has ${paras.length} ` +
        `(valid 0..${paras.length - 1}). Run --op list with the same cell address to see them.`,
    );
  }

  const before = [];
  for (const cp of targets) {
    try {
      before.push(
        op === "char"
          ? JSON.parse(doc.getCellCharPropertiesAt(addr.section, addr.paragraph, addr.control, addr.cell, cp, 0))
          : JSON.parse(doc.getCellParaPropertiesAt(addr.section, addr.paragraph, addr.control, addr.cell, cp)),
      );
    } catch {
      before.push(null);
    }
  }

  const applied = [];
  for (const [i, cp] of targets.entries()) {
    // Character formatting on an EMPTY paragraph is a silent no-op (rule 62),
    // and inside a cell that is easy to hit because empty spacer paragraphs are
    // common. Refuse rather than report a success that did nothing.
    if (op === "char" && paras[cp].length === 0) {
      fail(
        EXIT.USAGE,
        `error: cell paragraph ${cp} is empty; character formatting on it is silently ignored ` +
          `by the engine. Use --op para for a paragraph-level property, or pick a paragraph with text.`,
      );
    }
    let r;
    try {
      r =
        op === "char"
          ? JSON.parse(
              doc.applyCharFormatInCell(
                addr.section, addr.paragraph, addr.control, addr.cell, cp,
                Number.isInteger(start) ? start : 0,
                Number.isInteger(end) ? end : paras[cp].length,
                propsRaw,
              ),
            )
          : JSON.parse(
              doc.applyParaFormatInCell(addr.section, addr.paragraph, addr.control, addr.cell, cp, propsRaw),
            );
    } catch (e) {
      fail(EXIT.CORRUPTION, `error: cell paragraph ${cp}: ${e?.message ?? e}`);
    }
    if (!r || r.ok !== true) {
      fail(EXIT.CORRUPTION, `error: engine reported failure for cell paragraph ${cp}: ${JSON.stringify(r)}`);
    }
    applied.push({ cellPara: cp, beforeIndex: i });
  }

  let cResult;
  try {
    cResult = await exportVerify(doc, output, {});
  } catch (e) {
    fail(EXIT.CORRUPTION, `error: export/verify failed: ${e?.message ?? e}`);
  }
  if (!cResult.verified) {
    process.stderr.write(JSON.stringify(cResult) + "\n");
    fail(EXIT.CORRUPTION, `error: round-trip verification failed — ${output} did not reload cleanly.`);
  }

  // Confirm from the SAVED file, per paragraph — the same contract the body
  // path keeps. The engine answers ok:true for properties it ignores.
  const back = await loadDocument(cResult.outputPath);
  const effects = [];
  const dead = [];
  for (const { cellPara: cp, beforeIndex } of applied) {
    let after = null;
    try {
      after =
        op === "char"
          ? JSON.parse(back.getCellCharPropertiesAt(addr.section, addr.paragraph, addr.control, addr.cell, cp, 0))
          : JSON.parse(back.getCellParaPropertiesAt(addr.section, addr.paragraph, addr.control, addr.cell, cp));
    } catch { /* fall through to a no-effect verdict */ }
    const eff = {};
    for (const [k, want] of Object.entries(props)) {
      eff[k] = classifyEffect(k, want, before[beforeIndex], after);
      if (eff[k] === "no-effect") dead.push(`cell paragraph ${cp}: "${k}"`);
    }
    effects.push({ cellPara: cp, effect: eff });
  }
  if (dead.length) {
    process.stdout.write(JSON.stringify({ ...cResult, effects }) + "\n");
    fail(
      EXIT.CORRUPTION,
      `error: the formatting did NOT take on disk for ${dead.join(", ")}.\n` +
        `       The engine reported success. Do not deliver ${output}.`,
    );
  }

  process.stdout.write(
    JSON.stringify({
      ok: true,
      op,
      target: "cell",
      cell: addr,
      cellParagraphs: targets,
      props,
      effects,
      verified: true,
      bytesWritten: cResult.bytesWritten,
      outputPath: cResult.outputPath,
    }) + "\n",
  );
  process.exit(EXIT.OK);
}

// --- --op bullet -------------------------------------------------------------
//
// Self-contained: bullets act on a SET of paragraphs and have two mechanisms,
// so they do not fit the single-address char/para flow above. Everything below
// this branch is the char/para path, untouched.
if (op === "bullet") {
  const secCount = doc.getSectionCount();
  if (section >= secCount) {
    fail(EXIT.NOT_FOUND, `error: section ${section} out of range (document has ${secCount})`);
  }
  const paraCount = doc.getParagraphCount(section);
  const oob = bulletTargets.filter((p) => p >= paraCount);
  if (oob.length) {
    fail(
      EXIT.NOT_FOUND,
      `error: paragraph ${oob.join(", ")} out of range for section ${section} (valid 0..${paraCount - 1})`,
    );
  }

  // Which mechanism? `auto` follows the document. A file that already uses
  // HWP bullets gets HWP bullets; everything else gets the glyph convention,
  // which is what ~2x more real 개조식 paragraphs actually use.
  const detected = detectBulletMode(doc);
  const mode = bulletMode === undefined || bulletMode === "auto" ? detected.mode : bulletMode;
  const level = bulletLevel === undefined ? 0 : bulletLevel;

  const changes = [];
  let bulletId = null;

  if (!bulletRemove && mode === "hwp") {
    // RAW STRING, not JSON — see lib/bullets.mjs. And the definition only
    // survives the save if a paragraph references it, so this is followed by
    // the applyParaFormat below for every target.
    try {
      bulletId = JSON.parse(doc.ensureDefaultBullet(bulletGlyph));
    } catch (e) {
      fail(EXIT.CORRUPTION, `error: could not define bullet ${JSON.stringify(bulletGlyph)}: ${e?.message ?? e}`);
    }
    if (!Number.isInteger(bulletId)) {
      fail(EXIT.CORRUPTION, `error: the engine did not return a bullet id (got ${JSON.stringify(bulletId)})`);
    }
  }

  for (const p of bulletTargets) {
    const len = doc.getParagraphLength(section, p);
    const text = len > 0 ? doc.getTextRange(section, p, 0, len) : "";
    const existing = parseMarker(text);

    // REMOVAL CLEARS BOTH MECHANISMS, whatever --mode says. A document can
    // carry a headType bullet on one paragraph and a typed glyph on the next,
    // and "remove the bullet" has only one sensible meaning. Clearing only the
    // selected mechanism would leave a visible □ behind while reporting
    // success, because "headType is no longer Bullet" is trivially true of a
    // paragraph that never had one.
    if (bulletRemove) {
      const pp = JSON.parse(doc.getParaPropertiesAt(section, p));
      const hadHwp = pp.headType === "Bullet";
      const hadText = existing !== null;
      if (hadText) doc.deleteText(section, p, 0, existing.prefixLength);
      if (hadHwp) {
        const r = JSON.parse(
          doc.applyParaFormat(
            section,
            p,
            JSON.stringify({ headType: "None", numberingId: 0, paraLevel: 0 }),
          ),
        );
        if (!r || r.ok !== true) {
          fail(EXIT.CORRUPTION, `error: could not clear the bullet on paragraph ${p}: ${JSON.stringify(r)}`);
        }
      }
      changes.push({
        paragraph: p,
        removedText: hadText ? existing.glyph : null,
        removedHwpBullet: hadHwp,
        hadBullet: hadText || hadHwp,
      });
      continue;
    }

    if (mode === "text") {
      // Replace an existing marker rather than stacking a second one in front
      // of it — "□ □ 추진 배경" is the obvious bug here.
      const drop = existing ? existing.prefixLength : 0;
      if (drop > 0) doc.deleteText(section, p, 0, drop);
      const prefix = textPrefix(bulletGlyph, level);
      doc.insertText(section, p, 0, prefix);

      // The leading spaces in that prefix ARE an indent, so this owes the same
      // hanging indent --op indent sets. Without it a bullet long enough to
      // wrap sends its second line back to the marker's own column instead of
      // aligning under the text. That is not hypothetical: a test agent doing
      // the obvious thing — one --op bullet call to normalise glyph and depth —
      // produced exactly that break, and did not notice.
      let hangingIndent = null;
      if (!noHanging) {
        let fontSize;
        try {
          fontSize = len > 0 ? JSON.parse(doc.getCharPropertiesAt(section, p, 0)).fontSize : undefined;
        } catch {
          fontSize = undefined;
        }
        hangingIndent = hangingIndentFor(level, fontSize);
        const hr = JSON.parse(doc.applyParaFormat(section, p, JSON.stringify({ indent: hangingIndent })));
        if (!hr || hr.ok !== true) {
          fail(EXIT.CORRUPTION, `error: hanging indent failed at paragraph ${p}: ${JSON.stringify(hr)}`);
        }
      }
      changes.push({
        paragraph: p,
        mode,
        prefix,
        replaced: existing ? existing.glyph : null,
        hangingIndent,
      });
      continue;
    }

    // mode === "hwp"
    const props = { headType: "Bullet", numberingId: bulletId, paraLevel: level };
    let r;
    try {
      r = JSON.parse(doc.applyParaFormat(section, p, JSON.stringify(props)));
    } catch (e) {
      fail(EXIT.CORRUPTION, `error: bullet apply failed at paragraph ${p}: ${e?.message ?? e}`);
    }
    if (!r || r.ok !== true) {
      fail(EXIT.CORRUPTION, `error: engine reported failure for paragraph ${p}: ${JSON.stringify(r)}`);
    }
    changes.push({ paragraph: p, mode, bulletId, level });
  }

  let bResult;
  try {
    bResult = await exportVerify(doc, output, {});
  } catch (e) {
    fail(EXIT.CORRUPTION, `error: export/verify failed: ${e?.message ?? e}`);
  }
  if (!bResult.verified) {
    process.stderr.write(JSON.stringify(bResult) + "\n");
    fail(EXIT.CORRUPTION, `error: round-trip verification failed — ${output} did not reload cleanly.`);
  }

  // Confirm from the SAVED file. Neither mechanism is provable in memory: a
  // bullet definition nobody references is pruned on save, and a text prefix
  // is only real if the reloaded paragraph starts with it.
  const back = await loadDocument(bResult.outputPath);
  const confirmed = [];
  for (const c of changes) {
    const len = back.getParagraphLength(section, c.paragraph);
    const text = len > 0 ? back.getTextRange(section, c.paragraph, 0, Math.min(len, 60)) : "";
    let ok;
    if (bulletRemove) {
      // Both mechanisms, for the reason given at the removal branch above.
      const pp = JSON.parse(back.getParaPropertiesAt(section, c.paragraph));
      ok = parseMarker(text) === null && pp.headType !== "Bullet";
    } else if (mode === "text") {
      ok = text.startsWith(c.prefix);
      if (ok && c.hangingIndent !== null && c.hangingIndent !== undefined) {
        ok = JSON.parse(back.getParaPropertiesAt(section, c.paragraph)).indent < 0;
      }
    } else {
      const pp = JSON.parse(back.getParaPropertiesAt(section, c.paragraph));
      ok = pp.headType === "Bullet" && pp.numberingId === bulletId;
    }
    confirmed.push({ ...c, confirmed: ok });
  }
  const failed = confirmed.filter((c) => !c.confirmed);
  if (failed.length) {
    process.stdout.write(JSON.stringify({ ...bResult, changes: confirmed }) + "\n");
    fail(
      EXIT.CORRUPTION,
      `error: the bullet did NOT take on disk for paragraph ` +
        `${failed.map((c) => c.paragraph).join(", ")}. Do not deliver ${output}.`,
    );
  }
  // "Removed" must not be reported for a paragraph that had nothing to remove.
  // The confirmation above is satisfied by a paragraph that was never bulleted,
  // so without this the command would answer success for a mis-typed range.
  if (bulletRemove) {
    const untouched = confirmed.filter((c) => !c.hadBullet).map((c) => c.paragraph);
    if (untouched.length === confirmed.length) {
      process.stderr.write(
        `WARNING: none of the selected paragraphs had a bullet — nothing was removed. ` +
          `Check --paragraphs (${bulletTargets.join(", ")}).\n`,
      );
    } else if (untouched.length) {
      process.stderr.write(`WARNING: paragraph ${untouched.join(", ")} had no bullet; left unchanged.\n`);
    }
  }
  if (mode === "hwp" && !bulletRemove) {
    const list = JSON.parse(back.getBulletList());
    const entry = Array.isArray(list) ? list.find((b) => b.id === bulletId) : null;
    if (!entry || entry.char !== bulletGlyph) {
      fail(
        EXIT.CORRUPTION,
        `error: the saved bullet is ${JSON.stringify(entry?.char)}, not ` +
          `${JSON.stringify(bulletGlyph)} — the definition did not survive the save.`,
      );
    }
  }

  process.stdout.write(
    JSON.stringify({
      ok: true,
      op: "bullet",
      section,
      mode,
      modeSource: bulletMode === undefined || bulletMode === "auto" ? "auto" : "explicit",
      detected,
      ...(bulletRemove ? { removed: true } : { char: bulletGlyph, level }),
      ...(mode === "hwp" && !bulletRemove ? { bulletId } : {}),
      changes: confirmed,
      verified: true,
      bytesWritten: bResult.bytesWritten,
      outputPath: bResult.outputPath,
    }) + "\n",
  );
  process.exit(EXIT.OK);
}

// --- --op list ---------------------------------------------------------------
//
// Read-only. Reports the shapes the document uses, described in the same keys
// --props accepts, plus evidence of where they disagree with each other.
//
// It does NOT decide which shape is correct. A draft whose level-2 items are
// ○, -, ◦ and * has four shapes and three mistakes, and a report that called
// all four "the document's style" would turn the mess into a standard. So the
// observations carry their reasoning and stop there — see lib/palette.mjs.
if (op === "list") {
  const listFormat = arg("--format") ?? "text";
  if (listFormat !== "text" && listFormat !== "json") {
    fail(EXIT.USAGE, `error: --format must be text|json (got ${JSON.stringify(listFormat)})\n${USAGE}`);
  }
  const secCount = doc.getSectionCount();
  if (section !== undefined && section >= secCount) {
    fail(EXIT.NOT_FOUND, `error: section ${section} out of range (document has ${secCount})`);
  }
  const pal = buildPalette(doc, { section: section === undefined ? null : section });

  if (listFormat === "json") {
    process.stdout.write(
      JSON.stringify(
        {
          input,
          sectionCount: secCount,
          paragraphCount: pal.paragraphs.length,
          shapes: pal.shapes,
          markers: pal.markers,
          observations: pal.observations,
        },
        null,
        2,
      ) + "\n",
    );
    process.exit(EXIT.OK);
  }

  const L = [];
  const described = (sh) => {
    const bits = [];
    if (sh.marker) bits.push(`"${sh.marker.glyph}" +${sh.marker.indentChars}sp`);
    for (const [k, v] of Object.entries(sh.charProps)) if (v !== false) bits.push(`${k}=${JSON.stringify(v)}`);
    for (const [k, v] of Object.entries(sh.paraProps)) if (v !== 0) bits.push(`${k}=${JSON.stringify(v)}`);
    return bits.join(" · ") || "(document defaults)";
  };
  L.push(`shapes in ${input} — ${pal.shapes.length} distinct, ${pal.paragraphs.length} paragraphs`);
  L.push("");
  for (const sh of pal.shapes) {
    const where = sh.paragraphs.slice(0, 6).map((x) => x.paragraph).join(",");
    const more = sh.paragraphs.length > 6 ? `,+${sh.paragraphs.length - 6}` : "";
    L.push(`  ${sh.id.padEnd(4)} ${String(sh.count).padStart(3)}x  ${described(sh)}`);
    L.push(`       paragraphs ${where}${more}`);
    const ro = sh.readOnly ?? {};
    if (ro.fontFamily) {
      L.push(
        `       font ${ro.fontFamily}${ro.mixedLanguageFonts ? " (+ different fonts in other language slots)" : ""}` +
          `  — READ-ONLY, applyCharFormat cannot set a font`,
      );
    }
    if (ro.style && ro.style !== "바탕글") L.push(`       style ${ro.style}`);
  }
  if (pal.markers.length) {
    L.push("");
    L.push("marker glyphs (fact, not judgement):");
    for (const m of pal.markers) {
      L.push(
        `  ${m.glyph}  ${String(m.count).padStart(3)}x  at depth ` +
          m.depths.map((d) => `${d.indentChars}sp×${d.count}`).join(", "),
      );
    }
  }
  if (pal.observations.length) {
    L.push("");
    L.push(`observations (${pal.observations.length}) — evidence, NOT verdicts:`);
    for (const o of pal.observations) {
      const head =
        o.kind === "glyph-at-mixed-depths"
          ? `"${o.glyph}" used at ${o.depths.length} depths`
          : o.kind === "near-duplicate"
            ? `near-duplicate ${o.shape} ~ ${o.nearest} (differs in ${o.differsIn.join(", ")})`
            : `singleton ${o.shape} at paragraph ${o.paragraph.paragraph}`;
      L.push(`  • ${head}`);
      L.push(`    ${o.why}`);
    }
    L.push("");
    L.push(
      "Deciding whether a deviation is a mistake or a deliberate choice is yours.\n" +
        "Nothing here was changed, and nothing normalises automatically.",
    );
  }
  process.stdout.write(L.join("\n") + "\n");
  process.exit(EXIT.OK);
}

// --- --op indent -------------------------------------------------------------
//
// Depth, on a set of paragraphs. Two schemes, because real documents use two
// and `marginLeft` is the MINORITY one — see lib/indent.mjs for the counts.
if (op === "indent") {
  const secCount = doc.getSectionCount();
  if (section >= secCount) {
    fail(EXIT.NOT_FOUND, `error: section ${section} out of range (document has ${secCount})`);
  }
  const paraCount = doc.getParagraphCount(section);
  const oob = indentTargets.filter((p) => p >= paraCount);
  if (oob.length) {
    fail(
      EXIT.NOT_FOUND,
      `error: paragraph ${oob.join(", ")} out of range for section ${section} (valid 0..${paraCount - 1})`,
    );
  }

  const detected = detectIndentScheme(doc, { section });
  const scheme = indentScheme === undefined || indentScheme === "auto" ? detected.scheme : indentScheme;
  const level = bulletLevel;
  const changes = [];

  for (const p of indentTargets) {
    const len = doc.getParagraphLength(section, p);
    const text = len > 0 ? doc.getTextRange(section, p, 0, len) : "";
    // The paragraph's own font size sizes the hang; a 14pt list needs a wider
    // hang than a 10pt one for the wrapped lines to land in the same place.
    let fontSize;
    try {
      fontSize = len > 0 ? JSON.parse(doc.getCharPropertiesAt(section, p, 0)).fontSize : undefined;
    } catch {
      fontSize = undefined;
    }

    if (scheme === "margin") {
      const marginLeft = marginForLevel(level, fontSize);
      const r = JSON.parse(doc.applyParaFormat(section, p, JSON.stringify({ marginLeft })));
      if (!r || r.ok !== true) {
        fail(EXIT.CORRUPTION, `error: indent failed at paragraph ${p}: ${JSON.stringify(r)}`);
      }
      changes.push({ paragraph: p, scheme, level, marginLeft });
      continue;
    }

    // scheme === "space"
    const next = reindentText(text, level);
    if (next.dropped > 0) doc.deleteText(section, p, 0, next.dropped);
    const prefix = next.text.slice(0, next.text.length - (text.length - next.dropped));
    if (prefix.length > 0) doc.insertText(section, p, 0, prefix);

    // The hang is not optional decoration. Leading spaces without it wrap the
    // continuation lines back to column 0; in the corpus, 91% of space-indented
    // paragraphs long enough to wrap set one. Only a marker paragraph gets it —
    // a hanging indent on ordinary prose is just a broken first line.
    let hangingIndent = null;
    if (next.hasMarker && !noHanging) {
      hangingIndent = hangingIndentFor(level, fontSize);
      const r = JSON.parse(doc.applyParaFormat(section, p, JSON.stringify({ indent: hangingIndent })));
      if (!r || r.ok !== true) {
        fail(EXIT.CORRUPTION, `error: hanging indent failed at paragraph ${p}: ${JSON.stringify(r)}`);
      }
    }
    changes.push({ paragraph: p, scheme, level, prefix, hasMarker: next.hasMarker, hangingIndent });
  }

  let iResult;
  try {
    iResult = await exportVerify(doc, output, {});
  } catch (e) {
    fail(EXIT.CORRUPTION, `error: export/verify failed: ${e?.message ?? e}`);
  }
  if (!iResult.verified) {
    process.stderr.write(JSON.stringify(iResult) + "\n");
    fail(EXIT.CORRUPTION, `error: round-trip verification failed — ${output} did not reload cleanly.`);
  }

  // Confirm from the SAVED file. marginLeft comes back unit-converted (HWPUNIT
  // in, points out) so it is checked as "moved in the right direction and is
  // non-zero when it should be", not for an exact match — the same reason
  // classifyEffect reports converted numbers as unverifiable.
  const back = await loadDocument(iResult.outputPath);
  const confirmed = [];
  for (const c of changes) {
    const len = back.getParagraphLength(section, c.paragraph);
    const text = len > 0 ? back.getTextRange(section, c.paragraph, 0, Math.min(len, 80)) : "";
    const pp = JSON.parse(back.getParaPropertiesAt(section, c.paragraph));
    let ok;
    if (c.scheme === "margin") {
      ok = level === 0 ? pp.marginLeft === 0 : pp.marginLeft > 0;
    } else {
      ok = text.startsWith(c.prefix);
      if (ok && c.hangingIndent !== null) ok = pp.indent < 0;
    }
    confirmed.push({ ...c, confirmed: ok });
  }
  const bad = confirmed.filter((c) => !c.confirmed);
  if (bad.length) {
    process.stdout.write(JSON.stringify({ ...iResult, changes: confirmed }) + "\n");
    fail(
      EXIT.CORRUPTION,
      `error: the indent did NOT take on disk for paragraph ${bad.map((c) => c.paragraph).join(", ")}. ` +
        `Do not deliver ${output}.`,
    );
  }
  if (scheme === "space" && !noHanging && confirmed.every((c) => !c.hasMarker)) {
    process.stderr.write(
      `WARNING: none of the selected paragraphs carries a bullet marker, so no hanging ` +
        `indent was set — only the leading spaces changed. If these are list items, set ` +
        `the marker first with --op bullet.\n`,
    );
  }

  process.stdout.write(
    JSON.stringify({
      ok: true,
      op: "indent",
      section,
      scheme,
      schemeSource: indentScheme === undefined || indentScheme === "auto" ? "auto" : "explicit",
      detected,
      level,
      changes: confirmed,
      verified: true,
      bytesWritten: iResult.bytesWritten,
      outputPath: iResult.outputPath,
    }) + "\n",
  );
  process.exit(EXIT.OK);
}

// Snapshot the shape BEFORE the edit. Comparing it against the reloaded shape
// is what turns "the engine said ok" into "the value actually moved" — the
// engine says ok for requests it ignores entirely.
function readShape(d) {
  try {
    return JSON.parse(
      op === "char"
        ? d.getCharPropertiesAt(section, paragraph, start)
        : d.getParaPropertiesAt(section, paragraph),
    );
  } catch {
    return null;
  }
}
const beforeShape = readShape(doc);

// --- apply -------------------------------------------------------------------
// applyCharFormat / applyParaFormat return a JSON string {"ok":true}. An
// out-of-range section/paragraph makes the WASM call return `undefined`
// (Rust panic surfaced as a missing return), so JSON.parse throws — we treat
// any throw / non-ok as a hard failure rather than reporting a phantom success.
function applyFormat() {
  const raw =
    op === "char"
      ? doc.applyCharFormat(section, paragraph, start, end, propsRaw)
      : doc.applyParaFormat(section, paragraph, propsRaw);
  const r = JSON.parse(raw); // throws if raw is undefined (OOB index)
  if (!r || r.ok !== true) throw new Error(`engine returned ${raw}`);
}
try {
  applyFormat();
} catch (e) {
  fail(
    EXIT.CORRUPTION,
    `error: apply ${op} format failed at section ${section}, paragraph ${paragraph}` +
      `${op === "char" ? ` [${start},${end})` : ""}: ${e?.message ?? e}\n` +
      `       (check the section/paragraph indices are in range)`,
  );
}

// --- export + verify ---------------------------------------------------------
// No text to probe — exportVerify with empty expectations still exports,
// atomically writes, and reloads, so verified:false would flag a corrupt
// round-trip. We then re-read the applied property from the reloaded doc.
let result;
try {
  result = await exportVerify(doc, output, {});
} catch (e) {
  fail(EXIT.CORRUPTION, `error: export/verify failed: ${e?.message ?? e}`);
}

if (!result.verified) {
  // Clean-round-trip check failed — the engine flagged a corrupt save→reload.
  process.stderr.write(JSON.stringify(result) + "\n");
  fail(
    EXIT.CORRUPTION,
    `error: round-trip verification failed — the document did not reload cleanly from ${output}.`,
  );
}

// Getter confirmation: re-read the saved file and pull back the values of the
// keys the caller requested, so success is CONFIRMED on disk, not just claimed
// in memory. getCharPropertiesAt(sec,para,char) / getParaPropertiesAt(sec,para)
// return a rich JSON object; we surface only the requested keys under `applied`.
// If the getter or a key is unavailable we still succeed (the clean round-trip
// already passed) but note that visual confirmation needs Phase 3 render.
const applied = {};
const effect = {};
let confirmed = false;
let note;
try {
  const reloaded = await loadDocument(result.outputPath);
  const shape = readShape(reloaded);
  if (!shape) throw new Error("shape getter unavailable");
  for (const key of Object.keys(props)) {
    if (Object.prototype.hasOwnProperty.call(shape, key)) {
      applied[key] = shape[key];
      confirmed = true;
    }
    effect[key] = classifyEffect(key, props[key], beforeShape, shape);
  }

  // A key that came back "no-effect" was accepted by the engine and did
  // nothing — the exact silent failure this script exists to refuse. It is
  // reported as CORRUPTION rather than success, because "verified:true" on a
  // document that did not change is worse than an error.
  const dead = Object.keys(effect).filter((k) => effect[k] === "no-effect");
  if (dead.length) {
    process.stderr.write(JSON.stringify({ op, section, paragraph, props, effect }) + "\n");
    fail(
      EXIT.CORRUPTION,
      `error: the engine accepted ${dead.map((k) => `"${k}"`).join(", ")} and applied nothing —\n` +
        `       the value is unchanged on disk and does not match what was requested.\n` +
        `       This usually means the VALUE is not one the engine acts on.\n` +
        `       The output file at ${result.outputPath} is a clean copy WITHOUT that formatting.`,
    );
  }

  if (!confirmed)
    note =
      "applied + clean round-trip, but no requested key is exposed by the shape " +
      "getter — verify visually with enhanced/render (Phase 3).";
  else if (Object.values(effect).includes("unverifiable"))
    note =
      "some values are unit-converted by the engine (e.g. marginLeft HWPUNIT → pt), " +
      "so an unchanged number cannot be told apart from a re-applied one; the keys " +
      "marked 'unverifiable' in `effect` were sent but not independently confirmed.";
} catch {
  // Getter not available / threw — fall back to the clean-round-trip guarantee.
  // (fail() above exits the process outright, so it never lands here.)
  note =
    "applied + clean round-trip, but the shape getter was unavailable — verify " +
    "visually with enhanced/render (Phase 3).";
}

const summary = {
  ok: true,
  op,
  section,
  paragraph,
  ...(op === "char" ? { start, end } : {}),
  props,
  applied,
  effect, // per key: changed | already-set | unverifiable | unexposed
  verified: true,
  outputPath: result.outputPath,
};
if (note) summary.note = note;
process.stdout.write(JSON.stringify(summary) + "\n");
