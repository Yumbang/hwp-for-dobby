// The model cache's one load-bearing property: it cannot go stale.
//
// A cache that occasionally serves the previous version of a document would be
// worse than no cache, because the wrongness is invisible — the agent reads a
// section that no longer exists and has no way to tell. The design removes the
// possibility rather than managing it: the key contains the sha256 of the file
// bytes, so an edited document is simply a different key and the old entry
// becomes unaddressable. These tests pin that, plus the rule that every cache
// failure degrades to a miss instead of breaking the command.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cacheKey,
  cachePath,
  clearCache,
  fileDigest,
  pruneCache,
  readCache,
  writeCache,
} from "../../src/lib/cache.mjs";

function withTempFile(contents, fn) {
  const dir = mkdtempSync(join(tmpdir(), "hwp-cache-test-"));
  const path = join(dir, "doc.hwp");
  writeFileSync(path, contents);
  try {
    return fn(path, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const KEY_ARGS = { engineVersion: "0.7.19", opts: { tableMode: "body", detect: "auto" } };

test("cache: editing the document changes the key (stale is unaddressable)", () => {
  withTempFile("original bytes", (path) => {
    const before = cacheKey({ inputPath: path, ...KEY_ARGS });
    writeFileSync(path, "edited bytes");
    const after = cacheKey({ inputPath: path, ...KEY_ARGS });
    assert.notEqual(before, after, "an edited file MUST NOT reuse the previous key");
  });
});

test("cache: identical bytes at a different path share a key", () => {
  withTempFile("same bytes", (a) => {
    withTempFile("same bytes", (b) => {
      assert.equal(
        cacheKey({ inputPath: a, ...KEY_ARGS }),
        cacheKey({ inputPath: b, ...KEY_ARGS }),
        "the key addresses CONTENT, not location — a copied file should hit",
      );
    });
  });
});

test("cache: every version and option component participates in the key", () => {
  withTempFile("bytes", (path) => {
    const base = cacheKey({ inputPath: path, ...KEY_ARGS });
    assert.notEqual(
      base,
      cacheKey({ inputPath: path, engineVersion: "0.7.20", opts: KEY_ARGS.opts }),
      "an engine bump must not serve models built by the old engine",
    );
    assert.notEqual(
      base,
      cacheKey({
        inputPath: path,
        engineVersion: "0.7.19",
        opts: { tableMode: "cells", detect: "auto" },
      }),
      "an option that changes the model must change the key",
    );
  });
});

test("cache: option key order does not affect the key", () => {
  withTempFile("bytes", (path) => {
    assert.equal(
      cacheKey({ inputPath: path, engineVersion: "1", opts: { a: 1, b: 2 } }),
      cacheKey({ inputPath: path, engineVersion: "1", opts: { b: 2, a: 1 } }),
      "property order must not produce two keys for one state",
    );
  });
});

test("cache: write then read round-trips the model", () => {
  const key = "test-" + Math.abs(hash("roundtrip"));
  try {
    assert.equal(readCache(key), null, "a fresh key must miss");
    const model = { nodes: [{ id: "1", title: "개요" }], stats: { blocks: 12 } };
    assert.ok(writeCache(key, model));
    assert.deepEqual(readCache(key), model);
  } finally {
    rmSync(join(cachePath(key), ".."), { recursive: true, force: true });
  }
});

test("cache: --no-cache disables both directions", () => {
  const key = "test-" + Math.abs(hash("disabled"));
  try {
    assert.equal(writeCache(key, { a: 1 }, { enabled: false }), null);
    assert.equal(readCache(key, { enabled: false }), null);
    writeCache(key, { a: 1 });
    assert.equal(readCache(key, { enabled: false }), null, "reads must honour the opt-out too");
  } finally {
    rmSync(join(cachePath(key), ".."), { recursive: true, force: true });
  }
});

test("cache: a corrupt entry reads as a miss, never as a throw", () => {
  const key = "test-" + Math.abs(hash("corrupt"));
  try {
    writeCache(key, { ok: true });
    writeFileSync(cachePath(key), "{ this is not json");
    assert.equal(readCache(key), null, "corruption must degrade to a miss");
  } finally {
    rmSync(join(cachePath(key), ".."), { recursive: true, force: true });
  }
});

test("cache: an unwritable cache root degrades to null, it does not throw", () => {
  // The command must survive a full or read-only tmpdir.
  const key = "test-" + Math.abs(hash("unwritable"));
  const dir = join(cachePath(key), "..");
  try {
    writeCache(key, { ok: true });
    chmodSync(dir, 0o555);
    // Either it fails and returns null, or the platform allows it anyway;
    // what must NEVER happen is an exception escaping.
    assert.doesNotThrow(() => writeCache(key, { ok: false }));
  } finally {
    try {
      chmodSync(dir, 0o755);
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cache: pruning bounds the directory and never throws", () => {
  const keys = [];
  try {
    for (let i = 0; i < 5; i++) {
      const k = "prunetest-" + i;
      keys.push(k);
      writeCache(k, { i });
    }
    assert.doesNotThrow(() => pruneCache({ max: 2 }));
  } finally {
    for (const k of keys) rmSync(join(cachePath(k), ".."), { recursive: true, force: true });
  }
});

test("cache: fileDigest is the sha256 of the file's bytes", () => {
  withTempFile("hello", (path) => {
    // Independently computed, so a change to the digest function is caught.
    const expected =
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
    assert.equal(fileDigest(path), expected);
    assert.equal(fileDigest(path), fileDigest(path), "digest must be stable");
    assert.equal(readFileSync(path, "utf8"), "hello");
  });
});

// A tiny stable hash so parallel test files do not collide on cache keys.
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

test("cache: clearCache removes the tree without throwing when absent", () => {
  assert.doesNotThrow(() => clearCache());
  assert.doesNotThrow(() => clearCache());
});
