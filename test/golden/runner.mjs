// Shared machinery for the golden baseline: how a case is RUN and how its
// output is ENCODED. Both the recorder and the test import this, so a case can
// never be recorded one way and replayed another.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "..", "..");
export const GOLDEN_PATH = join(HERE, "golden.json");

// Streams longer than this are stored as a digest instead of verbatim text: a
// 300 KB SVG in a JSON baseline is unreviewable, and the sha256 pins it just as
// tightly. head/tail stay readable so a failure says WHAT changed, not only that
// something did.
const INLINE_MAX = 4000;
const CONTEXT = 300;

export function sha256(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

// Encode one stream. Short → the literal string. Long → {sha256,length,head,tail}.
export function encodeStream(text) {
  const s = String(text ?? "");
  if (s.length <= INLINE_MAX) return s;
  return {
    sha256: sha256(s),
    length: s.length,
    head: s.slice(0, CONTEXT),
    tail: s.slice(-CONTEXT),
  };
}

// Compare a live stream against a recorded encoding. Returns null when they
// agree, else a human-readable reason.
export function diffStream(label, recorded, actual) {
  const s = String(actual ?? "");
  if (typeof recorded === "string") {
    if (recorded === s) return null;
    return `${label} changed:\n--- recorded ---\n${clip(recorded)}\n--- actual ---\n${clip(s)}`;
  }
  if (recorded && typeof recorded === "object") {
    if (recorded.sha256 === sha256(s)) return null;
    return (
      `${label} digest changed (recorded ${recorded.length} chars / ${recorded.sha256.slice(0, 12)}…,` +
      ` actual ${s.length} chars / ${sha256(s).slice(0, 12)}…)\n` +
      `--- recorded head ---\n${recorded.head}\n--- actual head ---\n${s.slice(0, CONTEXT)}`
    );
  }
  return `${label}: malformed golden entry`;
}

function clip(s) {
  return s.length > 1500 ? s.slice(0, 1500) + `\n…(+${s.length - 1500} chars)` : s;
}

// Run one case exactly as an agent would: node <script> <argv…> from the repo
// root. The environment is pinned so a caller's locale or a stray HWP_* knob
// cannot shift the recorded output.
export function runCase(c) {
  const r = spawnSync(process.execPath, [c.script, ...c.argv], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      LC_ALL: "C.UTF-8",
      TZ: "UTC",
      NO_COLOR: "1",
      HWP_CORPUS_DIR: "",
      HWP_TRACKED_FIXTURE: "",
    },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
