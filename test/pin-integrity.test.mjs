// Version-pin integrity — the single highest-value robustness test
// (adopted from hop's tests/rhwp-baseline.test.mjs).
//
// The vendored WASM bundle is a MANUAL copy of the @rhwp/core npm package.
// Nothing else guarantees those stay in sync. If a `npm install` or a
// careless hand-copy leaves vendor/ at one version while package.json
// declares another, every behavioral assumption in spec/rhwp-behavior.md
// (which is version-specific) silently becomes a lie. This test fails CI
// the moment any of the four pinning surfaces disagree:
//
//   1. vendor/rhwp/VERSION        (the machine-readable pin we ship)
//   2. package.json @rhwp/core    (the declared, exact-pinned dependency)
//   3. package-lock.json          (the resolved install)
//   4. WASM version()             (what the actual bytes report at runtime)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ensureInit, version } from "../src/lib/_bootstrap.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const json = (p) => JSON.parse(read(p));

test("vendor/rhwp/VERSION matches package.json @rhwp/core", () => {
  const vendored = read("vendor/rhwp/VERSION").trim();
  const declared = json("package.json").dependencies["@rhwp/core"];
  assert.equal(
    declared,
    vendored,
    `package.json @rhwp/core (${declared}) must be exact-pinned to vendored VERSION (${vendored})`,
  );
});

test("package-lock.json resolves @rhwp/core to the pinned version", () => {
  const vendored = read("vendor/rhwp/VERSION").trim();
  const lock = json("package-lock.json");
  const node = lock.packages?.["node_modules/@rhwp/core"];
  assert.ok(node, "package-lock.json must contain node_modules/@rhwp/core");
  assert.equal(node.version, vendored);
});

test("WASM version() matches vendored VERSION", async () => {
  const vendored = read("vendor/rhwp/VERSION").trim();
  await ensureInit();
  assert.equal(
    version(),
    vendored,
    `the actual WASM bytes report version() ${version()}, expected ${vendored} — vendor/ is out of sync`,
  );
});
