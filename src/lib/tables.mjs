// Table addressing, cell reading and grid reconstruction.
//
// Moved out of extract_tables.mjs so the section extractor can render a table
// inline (blocks.mjs) without re-deriving the address scheme — and so there is
// exactly one implementation of the merge-origin rebuild that spec rule 1 is
// about. Nothing here prints; callers decide the output shape.
//
// ── ADDRESSING ─────────────────────────────────────────────────────────────
// A table location is `loc = {s, p, steps}` where `steps` is a non-empty array
// of {controlIndex, cellIndex, cellParaIndex}. The LAST entry's controlIndex
// addresses the table itself; that entry's cellIndex/cellParaIndex are ignored
// for the table, but the engine's path parser requires all three keys on every
// entry. Top-level tables (steps.length === 1) use the plain APIs; nested ones
// the *ByPath variants.
//
// ── THE RULE THIS FILE EXISTS FOR (spec rules 1-2) ────────────────────────
// A merged cell's text is stored ONCE, at its top-left origin; covered
// positions hold no cell at all, and `cellCount` counts origins only — so
// cellCount < rowCount*colCount whenever merges exist. Reading cells in
// storage order and laying them out sequentially therefore glues a merged
// value onto whichever cell serializes next, silently misattributing data
// across records. The grid is rebuilt from {row,col} + {rowSpan,colSpan}
// instead, and every covered position points back at its origin.

const NESTED_PROBE_MAX = 8;

export const isFlat = (loc) => loc.steps.length === 1;
export const flatCtrl = (loc) => loc.steps[0].controlIndex;

// A top-level table at control `c` of paragraph (s,p).
export function flatLoc(s, p, c) {
  return { s, p, steps: [{ controlIndex: c, cellIndex: 0, cellParaIndex: 0 }] };
}

// Path JSON addressing cell `cellIdx` (paragraph `cellParaIdx`) of `loc`'s table.
export function cellPathJson(loc, cellIdx, cellParaIdx = 0) {
  const steps = loc.steps.slice(0, -1);
  const last = loc.steps[loc.steps.length - 1];
  steps.push({ controlIndex: last.controlIndex, cellIndex: cellIdx, cellParaIndex: cellParaIdx });
  return JSON.stringify(steps);
}

// ── accessor shims (flat vs ByPath) ────────────────────────────────────────

export function tableDims(doc, loc) {
  const j = isFlat(loc)
    ? doc.getTableDimensions(loc.s, loc.p, flatCtrl(loc))
    : doc.getTableDimensionsByPath(loc.s, loc.p, JSON.stringify(loc.steps));
  return JSON.parse(j);
}

export function cellInfo(doc, loc, k) {
  const j = isFlat(loc)
    ? doc.getCellInfo(loc.s, loc.p, flatCtrl(loc), k)
    : doc.getCellInfoByPath(loc.s, loc.p, cellPathJson(loc, k));
  return JSON.parse(j); // {row, col, rowSpan, colSpan}
}

export function cellParaCount(doc, loc, k) {
  return isFlat(loc)
    ? doc.getCellParagraphCount(loc.s, loc.p, flatCtrl(loc), k)
    : doc.getCellParagraphCountByPath(loc.s, loc.p, cellPathJson(loc, k));
}

export function cellParaLen(doc, loc, k, cp) {
  return isFlat(loc)
    ? doc.getCellParagraphLength(loc.s, loc.p, flatCtrl(loc), k, cp)
    : doc.getCellParagraphLengthByPath(loc.s, loc.p, cellPathJson(loc, k, cp));
}

export function cellParaText(doc, loc, k, cp, len) {
  return isFlat(loc)
    ? doc.getTextInCell(loc.s, loc.p, flatCtrl(loc), k, cp, 0, len)
    : doc.getTextInCellByPath(loc.s, loc.p, cellPathJson(loc, k, cp), 0, len);
}

// A cell holds one or more inner paragraphs and there is no whole-cell getter,
// so read each paragraph and join with newline. NFC per spec §21.
export function readCellText(doc, loc, k) {
  let n = 0;
  try {
    n = cellParaCount(doc, loc, k);
  } catch {
    return "";
  }
  const parts = [];
  for (let cp = 0; cp < n; cp++) {
    let len = 0;
    try {
      len = cellParaLen(doc, loc, k, cp);
    } catch {
      len = 0;
    }
    parts.push(len > 0 ? cellParaText(doc, loc, k, cp, len) : "");
  }
  return parts.join("\n").normalize("NFC");
}

// ── grid reconstruction ────────────────────────────────────────────────────

// Rebuild the rowCount × colCount grid from origin cells and their span
// footprints. Each position is one of:
//   {text, rowSpan, colSpan, origin: true, nestedTables?}   ← origin
//   {text, origin: false, originRow, originCol}             ← covered
//   null                                                    ← nothing stored
// `fillMerged` replicates the origin's text into covered positions, which makes
// row-wise record grouping straightforward at the cost of duplicating values.
export function buildGrid(cells, rowCount, colCount, { fillMerged = false, mapText } = {}) {
  const grid = Array.from({ length: rowCount }, () => Array(colCount).fill(null));
  for (const c of cells) {
    const cellText = mapText ? mapText(c.text) : c.text;
    for (let dr = 0; dr < c.rowSpan; dr++) {
      for (let dc = 0; dc < c.colSpan; dc++) {
        const rr = c.row + dr;
        const cc = c.col + dc;
        if (rr >= rowCount || cc >= colCount) continue; // clamp malformed spans
        if (dr === 0 && dc === 0) {
          grid[rr][cc] = {
            text: cellText,
            rowSpan: c.rowSpan,
            colSpan: c.colSpan,
            origin: true,
            ...(c.nestedTables && c.nestedTables.length ? { nestedTables: c.nestedTables } : {}),
          };
        } else {
          grid[rr][cc] = {
            text: fillMerged ? cellText : "",
            origin: false,
            originRow: c.row,
            originCol: c.col,
          };
        }
      }
    }
  }
  return grid;
}

// ── discovery ──────────────────────────────────────────────────────────────

// Extract every table in `doc` into a flat array in discovery order (parents
// before children). Options:
//   noNested    skip nested-table discovery entirely (faster on huge docs)
//   maxDepth    nesting recursion cap (default 3)
//   fillMerged  see buildGrid
//   mapText     per-cell text transform (placeholder normalization etc.)
//   onlyAt      {s, p} — restrict the flat scan to one paragraph (the section
//               renderer needs one table, not all 40)
//
// Entries mirror the extract_tables.mjs output shape exactly:
//   {index, section, paragraph, controlIndex | (nestedIn, hostCell),
//    rowCount, colCount, cellCount, grid}
export function extractTables(doc, opts = {}) {
  const { noNested = false, maxDepth = 3, fillMerged = false, mapText, onlyAt } = opts;
  const tables = [];

  function extractOne(loc, nestedIn, hostCell, depth) {
    const index = tables.length;
    let dim;
    try {
      dim = tableDims(doc, loc);
    } catch {
      return -1; // not a table / vanished — the caller probed speculatively
    }
    const entry = {
      index,
      section: loc.s,
      paragraph: loc.p,
      ...(isFlat(loc) ? { controlIndex: flatCtrl(loc) } : { nestedIn, hostCell }),
      rowCount: dim.rowCount,
      colCount: dim.colCount,
      cellCount: dim.cellCount,
      grid: null,
    };
    tables.push(entry);

    // 1. read every stored cell (origins only — covered positions have none)
    const cells = [];
    for (let k = 0; k < dim.cellCount; k++) {
      let info;
      try {
        info = cellInfo(doc, loc, k);
      } catch {
        break; // defensive: malformed table — keep what we have
      }
      cells.push({ k, ...info, text: readCellText(doc, loc, k), nestedTables: [] });
    }

    // 2. discover nested tables per cell paragraph (parents-first order). No
    //    API counts controls inside a cell paragraph, so indices
    //    0..NESTED_PROBE_MAX-1 are probed; tables behind a higher control index
    //    are not discoverable (spec rule 3).
    if (!noNested && depth < maxDepth) {
      for (const c of cells) {
        let nPara = 0;
        try {
          nPara = cellParaCount(doc, loc, c.k);
        } catch {
          nPara = 0;
        }
        for (let cp = 0; cp < nPara; cp++) {
          for (let j = 0; j < NESTED_PROBE_MAX; j++) {
            const steps = loc.steps.slice(0, -1);
            const last = loc.steps[loc.steps.length - 1];
            steps.push({ controlIndex: last.controlIndex, cellIndex: c.k, cellParaIndex: cp });
            steps.push({ controlIndex: j, cellIndex: 0, cellParaIndex: 0 });
            const childIdx = extractOne(
              { s: loc.s, p: loc.p, steps },
              index,
              { row: c.row, col: c.col },
              depth + 1,
            );
            if (childIdx >= 0) c.nestedTables.push(childIdx);
          }
        }
      }
    }

    // 3. rebuild the grid from addresses + span footprints
    entry.grid = buildGrid(cells, dim.rowCount, dim.colCount, { fillMerged, mapText });
    return index;
  }

  // Flat scan: probe EVERY control index — tables can sit behind non-table
  // controls, and one paragraph can host several tables.
  const scan = (s, p) => {
    const n = (() => {
      try {
        return JSON.parse(doc.getControlTextPositions(s, p)).length;
      } catch {
        return 0;
      }
    })();
    for (let c = 0; c < n; c++) extractOne(flatLoc(s, p, c), null, null, 0);
  };

  if (onlyAt) {
    scan(onlyAt.s, onlyAt.p);
  } else {
    for (let s = 0; s < doc.getSectionCount(); s++) {
      for (let p = 0; p < doc.getParagraphCount(s); p++) scan(s, p);
    }
  }
  return tables;
}

export { NESTED_PROBE_MAX };
