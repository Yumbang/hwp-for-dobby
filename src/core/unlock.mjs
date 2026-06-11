#!/usr/bin/env node
// Usage: node src/core/unlock.mjs <input.hwp|.hwpx> --output <out.hwp>
//
// Unlocks a 배포용(distribution / read-only) HWP document — the variety
// Hancom ships with editing disabled so recipients can fill but not alter
// the body — and re-saves it as a normal, fully editable .hwp. The work is
// a single engine call, convertToEditable(), followed by the universal
// export→reload verification every editing script must pass.
//
// What convertToEditable() does (engine 0.7.15): strips the distribution /
// read-only protection record from DocInfo and returns JSON
//   {"ok":true,"converted":true}   — document WAS locked, now editable
//   {"ok":true,"converted":false}  — document was NOT locked (no-op)
// Either way the document is editable afterward; `converted` just reports
// whether anything had to change. Most fixtures (and most documents the
// agent meets) are not locked, so converted:false is a normal, successful
// outcome — NOT an error.
//
// No protection-flag GETTER:
// The engine surface (vendor/rhwp/rhwp.d.ts) exposes convertToEditable()
// but no isReadOnly()/getProtection() getter to re-assert the cleared flag
// after reload. So "success" here is defined operationally, the same way
// every other edit script defines it (spec §2):
//   1. convertToEditable() returned ok.
//   2. The document exports to .hwp and RE-OPENS cleanly from disk with its
//      body content intact (a known body string still present on reload).
// That round-trip is what exportVerify() confirms. A locked document that
// silently failed to convert would still re-open as locked, but the engine
// reports ok/converted truthfully and there is no in-WASM getter to probe
// further; the round-trip proves the file is well-formed and lossless.
//
// Output is ALWAYS .hwp — .hwpx output is refused (Hancom Office rejects
// rhwp-produced HWPX as 파일 손상; see assertHwpOutput). .hwpx INPUT is fine:
// exportHwp() runs the engine's HWPX→HWP adapter for HWPX-sourced docs.
//
// CORE-TIER: WASM-only. No rhwp CLI, no capabilities/requireCli. Behaves
// identically on claude.ai / cowork / code.

import { loadDocument } from "../lib/_bootstrap.mjs";
import { EXIT, fail } from "../lib/exit-codes.mjs";
import { assertMemoSafe } from "../lib/memo.mjs";
import { exportVerify } from "../lib/verify.mjs";

const USAGE = "usage: unlock.mjs <input.hwp|.hwpx> --output <out.hwp>";

// Minimal option parsing in the style of the port sources: one positional
// input path plus a required --output. Mirrors info.mjs / replace.mjs.
function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

let inputPath = null;
const output = arg("--output");
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === "-h" || a === "--help") {
    process.stdout.write(USAGE + "\n");
    process.exit(EXIT.OK);
  } else if (a === "--output") {
    i++; // value consumed by arg() above
  } else if (a.startsWith("-")) {
    fail(EXIT.USAGE, `error: unknown option ${a}\n${USAGE}`);
  } else if (inputPath === null) {
    inputPath = a;
  } else {
    fail(EXIT.USAGE, `error: unexpected argument ${a}\n${USAGE}`);
  }
}
if (!inputPath || !output) {
  fail(EXIT.USAGE, USAGE);
}

// Refuse a memo-bearing input (the engine drops memos on save) unless the
// caller passed --allow-memo-loss. No-op on memo-free inputs.
assertMemoSafe(inputPath, process.argv);

let doc;
try {
  doc = await loadDocument(inputPath);
} catch (e) {
  fail(EXIT.LOAD, `error: could not load ${inputPath}: ${e?.message ?? e}`);
}

// Pull a non-empty body string from the ORIGINAL document BEFORE converting,
// so the round-trip check has something concrete to confirm survived. We
// walk body paragraphs with getTextRange (the same body accessor read.mjs
// uses) and take the first run of text that's long enough to be a distinctive
// probe. If the document is entirely empty (or all content lives in tables),
// we fall back to no expectPresent — the export→reload still has to succeed,
// which on its own proves the file is well-formed.
function firstBodyProbe(d) {
  const sections = d.getSectionCount();
  for (let s = 0; s < sections; s++) {
    const paras = d.getParagraphCount(s);
    for (let p = 0; p < paras; p++) {
      let txt = "";
      try {
        txt = d.getTextRange(s, p, 0, 0x7fffffff);
      } catch {
        txt = "";
      }
      const trimmed = (txt || "").trim();
      // A few chars is enough to be a meaningful presence probe; very short
      // fragments (e.g. a stray "1") risk colliding with unrelated text and
      // weaken the assertion, so prefer a longer run when one exists.
      if (trimmed.length >= 2) return trimmed.slice(0, 24);
    }
  }
  return null;
}

const probe = firstBodyProbe(doc);

// The unlock itself: returns {"ok":..,"converted":..}. ok:false means the
// engine refused the operation outright — a hard failure.
let conv;
try {
  conv = JSON.parse(doc.convertToEditable());
} catch (e) {
  fail(EXIT.UNSUPPORTED, `error: convertToEditable failed on ${inputPath}: ${e?.message ?? e}`);
}
if (!conv || conv.ok !== true) {
  fail(
    EXIT.UNSUPPORTED,
    `error: convertToEditable did not succeed on ${inputPath}: ${JSON.stringify(conv)}`,
  );
}

// Save → reload → confirm the body survived (clean, lossless round-trip).
// exportVerify calls assertHwpOutput, so a .hwpx --output fails fast here.
const result = await exportVerify(doc, output, {
  expectPresent: probe ? [probe] : [],
});

if (!result.verified) {
  // The export accepted the edit in memory but the .hwp round-trip dropped
  // body content (or the file did not re-open intact). Per the universal
  // contract this is a FAILED task — never reported as success.
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  fail(
    EXIT.CORRUPTION,
    `error: round-trip verification failed — ${output} did not re-open with its body intact after unlock.`,
  );
}

// One-line JSON success summary (ok:true, key fields, verified:true).
const summary = {
  ok: true,
  input: inputPath,
  outputPath: result.outputPath,
  wasLocked: conv.converted === true,
  converted: conv.converted === true,
  bytesWritten: result.bytesWritten,
  verified: result.verified,
};
process.stdout.write(JSON.stringify(summary) + "\n");
