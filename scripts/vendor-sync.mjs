#!/usr/bin/env node
// vendor-sync.mjs — refresh vendor/rhwp/ from the installed @rhwp/core npm package.
//
// Why this exists: Claude.ai's skill-ZIP validator rejects '@' in paths, so we
// can't ship node_modules/@rhwp/core directly. We vendor a flattened copy under
// vendor/rhwp/ and verify it byte-for-byte against the package.
//
// What it does:
//   1. Copy {rhwp.js, rhwp_bg.wasm, rhwp.d.ts, rhwp_bg.wasm.d.ts, LICENSE}
//      from node_modules/@rhwp/core/ into vendor/rhwp/.
//   2. Write vendor/rhwp/VERSION with the package's version.
//   3. Re-read every copied file and assert its sha256 matches the source.
//      Any mismatch => EXIT.CORRUPTION.
//
// Output: a single JSON line { ok, version, files:[...], allMatch }.
// Idempotent: re-running when already in sync reports allMatch:true.

import { createHash } from "node:crypto";
import { readFileSync, copyFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { EXIT, fail } from "../src/lib/exit-codes.mjs";

const HERE = dirname(fileURLToPath(import.meta.url)); // .../hwp/scripts
const REPO = dirname(HERE); // .../hwp
const SRC_DIR = join(REPO, "node_modules", "@rhwp", "core");
const PKG_JSON = join(SRC_DIR, "package.json");
const DEST_DIR = join(REPO, "vendor", "rhwp");

// Files copied verbatim from the package into the vendor dir.
const COPY_FILES = [
  "rhwp.js",
  "rhwp_bg.wasm",
  "rhwp.d.ts",
  "rhwp_bg.wasm.d.ts",
  "LICENSE",
];

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function main() {
  // Resolve the package version up front; fail loudly if the package is absent.
  let version;
  try {
    version = JSON.parse(readFileSync(PKG_JSON, "utf8")).version;
  } catch (err) {
    fail(
      EXIT.NOT_FOUND,
      `cannot read @rhwp/core package.json at ${PKG_JSON}: ${err.message}\n` +
        `Run 'npm install' first so node_modules/@rhwp/core exists.`
    );
  }
  if (!version) {
    fail(EXIT.LOAD, `no "version" field in ${PKG_JSON}`);
  }

  mkdirSync(DEST_DIR, { recursive: true });

  const files = [];
  let allMatch = true;

  for (const name of COPY_FILES) {
    const src = join(SRC_DIR, name);
    const dest = join(DEST_DIR, name);

    let srcBuf;
    try {
      srcBuf = readFileSync(src);
    } catch (err) {
      fail(
        EXIT.NOT_FOUND,
        `source file missing: ${src} (${err.message})`
      );
    }

    copyFileSync(src, dest);

    // Verify the copy is byte-identical by hashing both sides.
    const srcHash = sha256(srcBuf);
    let destHash;
    try {
      destHash = sha256(readFileSync(dest));
    } catch (err) {
      fail(EXIT.CORRUPTION, `cannot re-read copied file ${dest}: ${err.message}`);
    }

    const match = srcHash === destHash;
    if (!match) allMatch = false;

    files.push({
      name,
      bytes: srcBuf.length,
      sha256: destHash,
      match,
    });

    if (!match) {
      fail(
        EXIT.CORRUPTION,
        `sha256 mismatch for ${name}: src=${srcHash} dest=${destHash}`
      );
    }
  }

  // Write VERSION last so a half-finished sync never leaves a stale-but-present
  // VERSION pointing at unverified bytes.
  const versionPath = join(DEST_DIR, "VERSION");
  writeFileSync(versionPath, version + "\n");
  // Confirm what landed on disk matches what we intended to write.
  const writtenVersion = readFileSync(versionPath, "utf8").trim();
  if (writtenVersion !== version) {
    allMatch = false;
    fail(
      EXIT.CORRUPTION,
      `VERSION mismatch after write: wrote ${version}, read ${writtenVersion}`
    );
  }
  files.push({
    name: "VERSION",
    bytes: Buffer.byteLength(version + "\n"),
    sha256: sha256(Buffer.from(version + "\n")),
    match: true,
  });

  process.stdout.write(
    JSON.stringify({ ok: true, version, files, allMatch }) + "\n"
  );
  process.exit(EXIT.OK);
}

main();
