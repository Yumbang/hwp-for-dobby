// Round-trip verification — the universal safety net for every edit.
//
// rhwp's HWP5 serializer has a "raw_stream fast path": if a section still
// holds its original parsed bytes, serialize_section() emits those verbatim
// and IGNORES IR edits (rhwp/src/serializer/body_text.rs). Edits survive
// only when the editing API nulled section.raw_stream. `replaceAll` does
// NOT null it, so its edits are silently dropped on .hwp save — in-memory
// success != on-disk success. The ONLY reliable check is: export, reload
// from disk, and confirm the change actually materialized.
//
// Every edit script routes its save through exportVerify(); a `verified:
// false` result is a FAILED task (exit CORRUPTION=5), never reported as
// success. Generalizes the pattern originally in scripts/replace.mjs.

import { loadDocument, atomicWriteFile, assertHwpOutput } from "./_bootstrap.mjs";

// Count occurrences of `query` in a document, covering body text AND table
// cells AND textboxes. Implementation note: we (ab)use replaceAll(q, q) —
// replacing a string with itself — purely for its match COUNT, because the
// engine's replaceAll search (search_all) walks the full document including
// cells, whereas searchText only covers the body. The mutation is a no-op
// content-wise and the document is a throwaway reload, so this is safe and
// gives us full-coverage presence/count probing for verification.
export function probeTextCount(doc, query, caseSensitive = true) {
  if (!query) return 0;
  try {
    return JSON.parse(doc.replaceAll(query, query, caseSensitive)).count || 0;
  } catch {
    return 0;
  }
}

// Export an edited document to .hwp, atomically write it, reload from disk,
// and verify the edit survived by checking expected text presence/absence.
//
//   opts.expectPresent : string[]  — must each appear at least once on reload
//   opts.expectAbsent  : string[]  — must each be gone on reload
//   opts.caseSensitive : bool      — default true
//
// Returns: { ok, outputPath, bytesWritten, verified, checks[] }
//   verified=false means the engine accepted the edit in memory but the
//   .hwp round-trip dropped it (or left stale text). Caller should treat
//   this as a hard failure and tell the user the engine can't do it.
export async function exportVerify(doc, outputPath, opts = {}) {
  const {
    expectPresent = [],
    expectAbsent = [],
    caseSensitive = true,
  } = opts;
  assertHwpOutput(outputPath);
  const bytes = doc.exportHwp();
  atomicWriteFile(outputPath, Buffer.from(bytes));

  const reloaded = await loadDocument(outputPath);
  const checks = [];
  let verified = true;
  for (const t of expectPresent) {
    const count = probeTextCount(reloaded, t, caseSensitive);
    const ok = count > 0;
    checks.push({ text: t, expect: "present", count, ok });
    if (!ok) verified = false;
  }
  for (const t of expectAbsent) {
    const count = probeTextCount(reloaded, t, caseSensitive);
    const ok = count === 0;
    checks.push({ text: t, expect: "absent", count, ok });
    if (!ok) verified = false;
  }
  return {
    ok: true,
    outputPath,
    bytesWritten: bytes.length,
    verified,
    checks,
  };
}
