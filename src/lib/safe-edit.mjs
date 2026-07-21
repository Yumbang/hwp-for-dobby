// Find/replace, in one place.
//
// History, because it explains why this seam exists at all: on engines up to
// 0.7.15 the HWP5 serializer emitted each section's cached `raw_stream` bytes
// verbatim, and `replaceAll()` did not null that cache. So on a genuine .hwp a
// replace reported an in-memory match and was then silently dropped on save —
// body text AND table cells alike. This module used to route around it by
// locating every hit with searchAllText and rewriting it with the delete/insert
// primitives, which do null raw_stream.
//
// Upstream fixed it in 0.7.16 (commit d0e866da / PR #1398, issue #1385:
// "replaceAll 치환 결과가 exportHwp 직렬화에서 유실 — raw_stream 캐시 무효화").
// Re-verified empirically on the pinned 0.7.19 before this was simplified: a
// real 2-section .hwp with 182 matches (99 of them inside table cells) kept all
// 182 after save→reload, where 0.7.15 lost all 182. See spec rule 9.
//
// So both formats now take the engine path. The seam stays because it is the
// single choke point where a future engine regression would be re-routed, and
// because `replaceAll` covers body, cells and textboxes in one call — wider
// coverage than the old searchAllText walk had.
//
// Mutates `doc` in place. The caller still owns exportVerify() — a replace is
// only "done" once the change is confirmed to survive save→reload. That gate,
// not this function, is what guarantees we never ship a silently-dropped edit.

// Replace all occurrences of `query` with `replacement`. Returns the match count.
export function safeReplaceAll(doc, query, replacement, caseSensitive = true) {
  if (!query) return 0;
  return JSON.parse(doc.replaceAll(query, replacement, caseSensitive)).count || 0;
}
