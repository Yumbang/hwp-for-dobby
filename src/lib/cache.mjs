// Content-addressed cache for the parsed section model.
//
// WHY. A realistic session is `outline` → look → `extract --id 4.3` → look →
// `extract --id 4.4`. Each run re-opens the .hwp, re-walks every paragraph and
// re-runs detection, and on a 40-page report that is the dominant cost — three
// times over, for a document that did not change.
//
// WHY IT CANNOT GO STALE. The key includes the sha256 of the FILE'S BYTES.
// Edit the document by any means — this skill, Hancom, a network share — and
// the key changes, so the old entry is simply never looked up again. There is
// no invalidation logic to get wrong, because there is no invalidation: a
// stale entry is unaddressable. Everything else that can change the model is
// in the key too (engine version, detector/render versions, and every option
// that alters the model), so a code change cannot serve yesterday's answer
// either. Bump the relevant *_VERSION constant when you change what a model
// contains and every cached entry becomes unreachable at once.
//
// WHERE. os.tmpdir(), NOT next to the document. A cache is our bookkeeping and
// the user should never have to see it, let alone clean it up or add it to a
// .gitignore. (Snapshots are the opposite — those are the user's artifact and
// live beside the document. See lib/snapshot.mjs.)
//
// Every failure here is non-fatal. A cache that breaks a command is worse than
// no cache at all, so every read/write is wrapped: on any error we behave
// exactly as if the entry were absent.

import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CACHE_ROOT = join(tmpdir(), "hwp-skill-cache");

// Bump when the shape or content of a cached model changes. Each is separate
// so a renderer change does not invalidate entries a detector-only consumer
// could still use.
export const DETECTOR_VERSION = 1;
export const RENDER_VERSION = 1;
export const EQN_VERSION = 1;
export const TABLE_RENDER_VERSION = 1;

// Keep the cache from growing without bound in a shared temp directory.
const MAX_ENTRIES = 64;

export function fileDigest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// Build the cache key. `opts` must contain EVERY option that can change the
// model — passing a subset is how a cache starts lying. Keys are sorted so
// object property order cannot produce two keys for one state.
export function cacheKey({ inputPath, digest, engineVersion, opts = {} }) {
  const stable = JSON.stringify(
    Object.fromEntries(Object.entries(opts).sort(([a], [b]) => (a < b ? -1 : 1))),
  );
  return createHash("sha256")
    .update(
      [
        digest ?? fileDigest(inputPath),
        `engine=${engineVersion}`,
        `detector=${DETECTOR_VERSION}`,
        `render=${RENDER_VERSION}`,
        `eqn=${EQN_VERSION}`,
        `tableRender=${TABLE_RENDER_VERSION}`,
        `opts=${stable}`,
      ].join("\n"),
    )
    .digest("hex");
}

export function cachePath(key) {
  return join(CACHE_ROOT, key, "model.json");
}

// Read a cached model. Returns null when absent, unreadable or corrupt —
// callers treat all three identically and just recompute.
export function readCache(key, { enabled = true } = {}) {
  if (!enabled) return null;
  try {
    return JSON.parse(readFileSync(cachePath(key), "utf8"));
  } catch {
    return null;
  }
}

// Write a model. Returns the path on success, null on any failure (a full or
// read-only tmpdir must not break the command).
export function writeCache(key, value, { enabled = true } = {}) {
  if (!enabled) return null;
  try {
    const path = cachePath(key);
    mkdirSync(join(CACHE_ROOT, key), { recursive: true });
    // Write via a unique temp name + rename so two concurrent runs cannot
    // interleave into one half-written file that later parses as garbage.
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value));
    rmSync(path, { force: true });
    writeFileSync(path, readFileSync(tmp));
    rmSync(tmp, { force: true });
    pruneCache();
    return path;
  } catch {
    return null;
  }
}

// Drop the oldest entries once the directory exceeds MAX_ENTRIES. Best-effort
// and silent: pruning is housekeeping, never a reason to fail a command.
export function pruneCache({ max = MAX_ENTRIES } = {}) {
  try {
    const entries = readdirSync(CACHE_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => {
        const dir = join(CACHE_ROOT, e.name);
        let mtime = 0;
        try {
          mtime = statSync(dir).mtimeMs;
        } catch {}
        return { dir, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const e of entries.slice(max)) rmSync(e.dir, { recursive: true, force: true });
  } catch {
    /* nothing here is worth failing over */
  }
}

// Remove the whole cache — for tests and for a user who wants a clean slate.
export function clearCache() {
  try {
    rmSync(CACHE_ROOT, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
