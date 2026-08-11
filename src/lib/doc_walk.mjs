// Walking a document's paragraphs and classifying the controls inside them.
//
// This replaces three divergent copies of the same loop (read.mjs:144,
// extract_tables.mjs:424, _bootstrap.mjs:136), and fixes the classification
// they all shared, which could only ever answer "table or not".
//
// ── What the engine actually does (probed on the pinned 0.7.19) ────────────
//
// CONTROLS ARE ZERO-WIDTH. getControlTextPositions(s,p) returns one character
// offset per control, in the SAME coordinate system as getTextRange — inserting
// two equations and a footnote into a 20-character paragraph leaves it 20
// characters long, with positions [0,0,11,20,20]. That is what makes inline
// splicing (render_span in blocks.mjs) exact rather than approximate.
//
// EVERY SECTION'S FIRST PARAGRAPH CARRIES INVISIBLE CONTROLS at offset 0
// (SectionDef / ColumnDef). Treating every control as a renderable object puts
// phantom markers at position 0 of every section. They are classified as
// "other" here and dropped by callers.
//
// findNearestControlForward IS NOT AN ENUMERATOR. It looks like a cheap typed
// sweep — one call per control, type included — but it is cursor navigation for
// an editor, and it SKIPS controls. Measured on the repo fixtures: on
// fixture-form.hwp it reports 1 of 6 controls (jumping straight past the fields
// in paragraphs 2/4/6/8), and on fixture-table.hwpx, whose only table sits at
// (0,0,ci2), a forward sweep from (0,0,0) reports NOTHING at all while a
// backward sweep from the end finds it. Enumerating controls with it would drop
// tables silently, so this module enumerates with getControlTextPositions and
// classifies by probe. (spec/rhwp-behavior.md rule 31.)
//
// ── The probe, and the trap inside it ─────────────────────────────────────
//
// There is no "what kind of control is this" API, so a control's kind is the
// accessor that does NOT throw. The engine's error messages discriminate, and
// getting them wrong is how you lose data:
//
//   getTableDimensions(s,p,c)               → "지정된 컨트롤이 표가 아닙니다"
//   getEquationProperties(s,p,c,-1,-1)      → "지정된 컨트롤이 수식이 아닙니다"
//   getEquationProperties(s,p,c, 0, 0)      → "지정된 컨트롤이 표가 아닙니다"  ⚠
//   getFootnoteInfo(s,p,c)                  → "컨트롤 N은 각주/미주가 아닙니다"
//   any of the above with an out-of-range c → "컨트롤 인덱스 N 범위 초과"
//
// The ⚠ line is the trap. Passing cell indices (0,0) for a BODY equation routes
// the engine into its cell/table lookup, which reports "not a table" — the exact
// message the table probe uses to mean "skip this control". Port that naively
// and every equation in every document disappears without a single error. Body
// equations MUST be probed with cell_idx = cell_para_idx = -1.
// (spec/rhwp-behavior.md rules 32-33.)

const RE_NOT_TABLE = /표가 아닙니다/;
const RE_NOT_EQUATION = /수식이 아닙니다/;
const RE_NOT_NOTE = /각주\/미주가 아닙니다/;
const RE_OUT_OF_RANGE = /범위 초과/;

const msgOf = (e) => String(e?.message ?? e ?? "");

export const isNotTableError = (e) => RE_NOT_TABLE.test(msgOf(e));
export const isNotEquationError = (e) => RE_NOT_EQUATION.test(msgOf(e));
export const isNotNoteError = (e) => RE_NOT_NOTE.test(msgOf(e));
export const isOutOfRangeError = (e) => RE_OUT_OF_RANGE.test(msgOf(e));

// Body-equation sentinel. Never write a bare -1 at a call site: the whole point
// is that this value is load-bearing and a 0 slipped in here is silent data
// loss, so it gets a name and a single definition.
export const BODY_EQUATION_CELL = -1;

function parseOrNull(json) {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// ── enumeration ────────────────────────────────────────────────────────────

// Character offsets of the controls in paragraph (s,p), in control-index order.
// Index i of the returned array is control index i. Returns [] when the
// paragraph has no controls or the call fails.
export function controlOffsets(doc, s, p) {
  try {
    const v = JSON.parse(doc.getControlTextPositions(s, p));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// How many controls paragraph (s,p) holds.
export function controlCount(doc, s, p) {
  return controlOffsets(doc, s, p).length;
}

// Body text of paragraph (s,p), NFC-normalized (spec §21). Never throws.
export function paragraphText(doc, s, p) {
  try {
    return String(doc.getTextRange(s, p, 0, 0x7fffffff) ?? "").normalize("NFC");
  } catch {
    return "";
  }
}

// Iterate (section, paragraph) across the whole document.
export function* eachParagraph(doc) {
  const S = doc.getSectionCount();
  for (let s = 0; s < S; s++) {
    const P = doc.getParagraphCount(s);
    for (let p = 0; p < P; p++) yield { s, p };
  }
}

// ── classification ─────────────────────────────────────────────────────────

// Is control c of paragraph (s,p) a table? One WASM call. This is the cheap
// question — outline-style callers only ever need this one, and paying for full
// classification on every control of a 40-page document is the difference
// between snappy and sluggish.
export function isTableControl(doc, s, p, c) {
  try {
    doc.getTableDimensions(s, p, c);
    return true;
  } catch {
    return false;
  }
}

// Indices of the table controls in paragraph (s,p), in control order.
export function tableControlsInParagraph(doc, s, p) {
  const n = controlCount(doc, s, p);
  const out = [];
  for (let c = 0; c < n; c++) if (isTableControl(doc, s, p, c)) out.push(c);
  return out;
}

// Full classification of one control. Costs at most three WASM calls and is
// only worth paying inside a span the caller is actually rendering.
//
// Returns one of:
//   { kind: "table",    index, offset, dims: {rowCount, colCount, cellCount} }
//   { kind: "equation", index, offset, script, props }
//   { kind: "footnote", index, offset, number, texts, paraCount, totalTextLen }
//   { kind: "other",    index, offset }   ← pictures, shapes, fields, SectionDef…
export function classifyControl(doc, s, p, c, offset = null) {
  const base = { index: c, offset };

  try {
    const dims = JSON.parse(doc.getTableDimensions(s, p, c));
    return { ...base, kind: "table", dims };
  } catch (e) {
    // "not a table" is the expected miss; anything else (including an
    // out-of-range index) also falls through to the next probe, which reports
    // out-of-range distinctly.
    if (!isNotTableError(e) && !isOutOfRangeError(e)) {
      /* unknown failure — keep probing rather than guessing */
    }
  }

  try {
    // BODY_EQUATION_CELL, not 0 — see the trap in this file's header.
    const props = JSON.parse(
      doc.getEquationProperties(s, p, c, BODY_EQUATION_CELL, BODY_EQUATION_CELL),
    );
    return { ...base, kind: "equation", script: String(props?.script ?? ""), props };
  } catch (e) {
    if (isOutOfRangeError(e)) return { ...base, kind: "other", outOfRange: true };
  }

  try {
    const info = JSON.parse(doc.getFootnoteInfo(s, p, c));
    if (info && info.ok) {
      return {
        ...base,
        kind: "footnote",
        number: info.number,
        texts: Array.isArray(info.texts) ? info.texts : [],
        paraCount: info.paraCount,
        totalTextLen: info.totalTextLen,
      };
    }
  } catch {
    /* not a note */
  }

  return { ...base, kind: "other" };
}

// Classify every control of paragraph (s,p), carrying each one's text offset.
export function classifyParagraphControls(doc, s, p) {
  const offsets = controlOffsets(doc, s, p);
  return offsets.map((off, c) => classifyControl(doc, s, p, c, off));
}

// ── document-level probes ──────────────────────────────────────────────────

// Does this document contain at least one table? Short-circuits on the first
// hit. Kept as its own function (rather than counting) because read.mjs asks it
// once per run purely to decide whether to print its flattening warning.
export function documentHasTable(doc) {
  for (const { s, p } of eachParagraph(doc)) {
    const n = controlCount(doc, s, p);
    for (let c = 0; c < n; c++) if (isTableControl(doc, s, p, c)) return true;
  }
  return false;
}

export const _parseOrNull = parseOrNull;
