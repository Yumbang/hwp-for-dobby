// Safe find/replace — the keystone fix of the whole skill.
//
// The engine's replaceAll() does NOT null section.raw_stream, so on a genuine
// .hwp its edits are silently dropped on save (spec rule 9). The safe path is
// to LOCATE every match and rewrite it with the delete+insert primitives,
// which DO null raw_stream and therefore survive the round-trip (spec rules
// 10/11). We locate matches with searchAllText(include_cells=true) — the only
// search API that also covers table cells (plain searchText is body-only) —
// and rewrite each hit with the matching (cell vs body) delete/insert pair.
//
// Source-format dispatch (spec rules 9, 24):
//   • .hwpx input  → no raw_stream cache → replaceAll() is safe → one call.
//   • genuine .hwp → searchAllText + delete/insert per hit.
//
// Mutates `doc` in place. The caller is responsible for exportVerify() — a
// replace is only "done" once the change is confirmed to survive save→reload.

// Rewrite all occurrences of `query` with `replacement`. Returns the match
// count. Hits are applied in reverse document order so earlier char offsets
// in the same paragraph/cell are not disturbed by an earlier rewrite.
export function safeReplaceAll(doc, query, replacement, caseSensitive = true) {
  if (!query) return 0;

  // HWPX-sourced docs have no raw_stream fast-path; replaceAll materializes
  // from the IR and survives. Use it directly — it is the simplest correct
  // path and also covers cells/textboxes.
  if (doc.getSourceFormat() === "hwpx") {
    return JSON.parse(doc.replaceAll(query, replacement, caseSensitive)).count || 0;
  }

  // genuine .hwp — locate (body + cells) then delete+insert each hit.
  const hits = JSON.parse(doc.searchAllText(query, caseSensitive, true));
  // searchAllText returns hits in ascending document order; reversing keeps,
  // within each location, descending char offset (independent across
  // locations), so no offset bookkeeping is needed.
  for (let i = hits.length - 1; i >= 0; i--) {
    const h = hits[i];
    if (h.cellContext) {
      const c = h.cellContext;
      doc.deleteTextInCell(h.sec, c.parentPara, c.ctrlIdx, c.cellIdx, c.cellPara, h.charOffset, h.length);
      if (replacement)
        doc.insertTextInCell(h.sec, c.parentPara, c.ctrlIdx, c.cellIdx, c.cellPara, h.charOffset, replacement);
    } else {
      doc.deleteText(h.sec, h.para, h.charOffset, h.length);
      if (replacement) doc.insertText(h.sec, h.para, h.charOffset, replacement);
    }
  }
  return hits.length;
}
