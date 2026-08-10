// Markdown rendering for an extracted table entry.
//
// Lifted out of extract_tables.mjs' output block so the section extractor can
// splice a real markdown grid into a section's text (blocks.mjs) instead of the
// "[table: use extract_tables.mjs for data]" placeholder. Byte-identical to
// what extract_tables.mjs printed before the move — test/golden pins that.

// Pipes would break the row; in-cell newlines would break the table.
export function escapeCell(text) {
  return String(text).replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

// Where the table sits, as the heading line reports it.
export function tableWhere(t) {
  return t.nestedIn !== undefined && t.nestedIn !== null
    ? `nested in table ${t.nestedIn}, cell [${t.hostCell.row},${t.hostCell.col}]`
    : `section ${t.section}, paragraph ${t.paragraph}`;
}

// Render one table entry (the shape tables.mjs' extractTables produces).
// `heading: false` drops the "### Table N — …" line, which is what an inline
// splice into section text wants.
export function renderTableMarkdown(t, { heading = true } = {}) {
  let out = "";
  if (heading) {
    const ft = t.formType ? ` [${t.formType}]` : "";
    out += `### Table ${t.index} — ${t.rowCount}×${t.colCount} (${tableWhere(t)})${ft}\n\n`;
  }
  // A 1-row table would otherwise render its only data row as a markdown
  // header; give it an empty header instead so the row stays a body row.
  if (t.rowCount === 1) {
    out += `|${"   |".repeat(t.colCount)}\n`;
    out += `|${" --- |".repeat(t.colCount)}\n`;
  }
  for (let r = 0; r < t.rowCount; r++) {
    const cells = [];
    for (let c = 0; c < t.colCount; c++) {
      const cell = t.grid[r][c];
      let txt = cell ? escapeCell(cell.text) : "";
      if (cell && cell.origin && cell.nestedTables) {
        txt += cell.nestedTables.map((n) => ` [nested table #${n}]`).join("");
      }
      cells.push(txt);
    }
    out += `| ${cells.join(" | ")} |\n`;
    if (r === 0 && t.rowCount > 1) out += `|${" --- |".repeat(t.colCount)}\n`;
  }
  return out;
}
