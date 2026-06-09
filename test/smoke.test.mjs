// Engine-behavior smoke / regression baseline for the vendored rhwp build.
//
// Purpose: lock down the behaviors the skill DEPENDS ON, so that an engine
// bump (e.g. 0.7.15 → next) can't silently change them. Two kinds of check:
//
//   • GUARANTEES we rely on — these MUST stay true (hard assert):
//       - a genuine .hwp reads + exposes its tables
//       - insertTextInCell round-trips (survives save→reload) on a .hwp
//       - replaceAll round-trips on a .hwpx-SOURCED document
//
//   • the KNOWN BUG we route around — replaceAll silently drops edits on a
//     genuine .hwp (raw_stream fast-path). Asserted as currently-broken so
//     that if upstream ever fixes it, THIS test flips and tells us we can
//     simplify lib/verify + the safe-replace routing. See spec/rhwp-behavior.md.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadDocument } from "../src/lib/_bootstrap.mjs";
import { exportVerify, probeTextCount } from "../src/lib/verify.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const HWP = join(ROOT, "samples", "fixture-table.hwp"); // genuine HWP, has a table cell "△1,802"
const HWPX = join(ROOT, "samples", "fixture-table.hwpx"); // HWPX, cell "65,063,026,600"

let TMP;
const out = (name) => join(TMP, name);
test.before(() => {
  TMP = mkdtempSync(join(tmpdir(), "hwp-smoke-"));
});
test.after(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
});

// Find the control index of the (only) table on a given paragraph.
function tableControlIdx(doc, sec, para) {
  for (let k = 0; k < 8; k++) {
    try {
      doc.getTextInCell(sec, para, k, 0, 0, 0, 1);
      return k;
    } catch {
      /* not a table control */
    }
  }
  return -1;
}

test("GUARANTEE: a genuine .hwp loads, reports source format, and exposes a table", async () => {
  const doc = await loadDocument(HWP);
  assert.equal(doc.getSourceFormat(), "hwp");
  const ctrl = tableControlIdx(doc, 0, 4);
  assert.ok(ctrl >= 0, "expected a table control on section 0 / paragraph 4");
  const dims = JSON.parse(doc.getTableDimensions(0, 4, ctrl));
  assert.ok(dims.rowCount > 1 && dims.colCount > 1);
});

test("GUARANTEE: insertTextInCell survives save→reload on a genuine .hwp", async () => {
  const doc = await loadDocument(HWP);
  const ctrl = tableControlIdx(doc, 0, 4);
  doc.insertTextInCell(0, 4, ctrl, 0, 0, 0, "SMOKECELL");
  const r = await exportVerify(doc, out("cell.hwp"), {
    expectPresent: ["SMOKECELL"],
  });
  assert.equal(
    r.verified,
    true,
    "insertTextInCell must round-trip on .hwp — the safe edit path depends on it",
  );
});

test("GUARANTEE: replaceAll round-trips on an HWPX-sourced document", async () => {
  const doc = await loadDocument(HWPX);
  assert.equal(doc.getSourceFormat(), "hwpx");
  const n = JSON.parse(doc.replaceAll("65,063,026,600", "SMOKEHWPX", true)).count;
  assert.ok(n > 0, "fixture should contain the probed cell value");
  const r = await exportVerify(doc, out("hwpx.hwp"), {
    expectPresent: ["SMOKEHWPX"],
    expectAbsent: ["65,063,026,600"],
  });
  assert.equal(
    r.verified,
    true,
    "HWPX-sourced docs have no raw_stream cache, so even replaceAll must survive",
  );
});

test("KNOWN BUG (baseline): replaceAll is silently DROPPED on a genuine .hwp", async () => {
  const doc = await loadDocument(HWP);
  const reported = JSON.parse(doc.replaceAll("△1,802", "SMOKEDROP", true)).count;
  assert.ok(reported > 0, "engine should report an in-memory match");
  // Export + reload and check the replacement did NOT survive.
  const r = await exportVerify(doc, out("drop.hwp"), {
    expectPresent: ["SMOKEDROP"],
  });
  assert.equal(
    r.verified,
    false,
    "REGRESSION/GOOD-NEWS: replaceAll now survives on .hwp — the upstream raw_stream " +
      "bug appears fixed. Revisit lib/verify + safe-replace routing and update spec.",
  );
});
