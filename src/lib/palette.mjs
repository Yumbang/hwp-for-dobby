// The formatting palette — what shapes a document uses, and where they disagree.
//
// WHY A PALETTE AT ALL. A document's formatting is too big to print per
// paragraph (39 character keys and 40 paragraph keys each) and too varied to
// summarise as one "document style": measured across 74 real documents, the
// most common paragraph shape covers a median of only 42%, and just 3 of 74
// have one covering 90%. So "baseline plus exceptions" does not compress —
// the exceptions would be most of the document. What DOES compress is the
// vocabulary: a median of 9 distinct paragraph shapes and 7 character shapes
// for a 57-paragraph document. Describe those once, reference them per
// paragraph, and the whole document fits.
//
// DESCRIBED IN THE VOCABULARY THAT WRITES. Every shape is reported using the
// same keys `format.mjs --props` accepts, so what an agent reads here goes
// straight back in with no translation. The `P1` labels are local to one
// report and are never stored in the document — this is deduplication of a
// report, not a new file format. That matters: an identifier we invented, that
// the document does not carry and no command accepts, would be a private
// standard with no way back. (The engine's own paraShapeId IS stable across a
// round trip — 23 of 24 documents, no renumbering — but charShapeId cannot be
// written at all, `setCharShapeId` being a no-op at every id, so exposing
// either as an address would hand out a read-only handle.)
//
// DESCRIPTIVE, NOT NORMATIVE — THE POINT OF THE `observations` LIST.
// A palette says what a document IS. It must not be mistaken for what the
// document SHOULD be. A draft whose level-2 items are ○, -, ◦ and * has four
// shapes, and three of them are mistakes; a palette that reported four
// conventions would launder the mess into a standard, and N agents editing
// against it would reproduce the inconsistency faithfully.
//
// So this file separates two things:
//   `shapes`       — what is there. Plain description, no judgement.
//   `observations` — evidence that something is inconsistent, WITH the reason,
//                    so a caller can disagree. Never a verdict, never a fix.
//
// Nothing here normalises anything. Deciding whether a deviation is a mistake
// or a deliberate choice is the caller's, and a tool that quietly "corrected"
// intentional variation would be the same silent-success failure this repo
// keeps closing.
//
// WHY THE SIGNALS ARE LADDER-FREE. The obvious way to spot a deviation is
// "same outline level, different shape", but the heading ladder cannot supply
// the level here: on the very document this was built for it adopts □ and the
// ○/◦ class and DROPS `-` and `*` for having too few lines — which are exactly
// the deviations. So the signals below use only what is on the page:
//
//   glyph-at-mixed-depths  one glyph used at two leading-space depths. Whatever
//                          the intended outline is, a glyph cannot be at two
//                          levels — so this is unambiguous without a ladder.
//   near-duplicate         two shapes differing in exactly one property, which
//                          is what a slip looks like (26.7 against 26.6).
//                          Glyph-only differences are excluded; see observe().
//   singleton              a shape used once. Deliberately NOT called a mistake
//                          — a title is used once too.

import { parseMarker } from "./bullets.mjs";

// The properties a shape is described BY. Deliberately the writable subset:
// reporting something that cannot be written back would be describing a
// contract no one can honour. `fontFamily` is the exception and is carried
// separately, marked read-only, because it is the single most common thing a
// reader needs to know and the one thing applyCharFormat cannot set (rule 60).
const PARA_SHAPE_KEYS = ["alignment", "lineSpacing", "marginLeft", "indent", "spacingBefore", "spacingAfter"];
const CHAR_SHAPE_KEYS = ["bold", "italic", "underline", "fontSize", "textColor"];

const num = (v) => (typeof v === "number" ? Math.round(v * 10) / 10 : v);

// One paragraph's observable shape, plus the read-only context a reader needs.
export function paragraphShape(doc, s, p) {
  const len = doc.getParagraphLength(s, p);
  let text = "";
  try {
    text = len > 0 ? doc.getTextRange(s, p, 0, len) : "";
  } catch {
    text = "";
  }
  let para = null;
  let char = null;
  try {
    para = JSON.parse(doc.getParaPropertiesAt(s, p));
  } catch {
    para = null;
  }
  if (len > 0) {
    try {
      char = JSON.parse(doc.getCharPropertiesAt(s, p, 0));
    } catch {
      char = null;
    }
  }
  let style = null;
  try {
    style = JSON.parse(doc.getStyleAt(s, p));
  } catch {
    style = null;
  }

  const paraProps = {};
  for (const k of PARA_SHAPE_KEYS) if (para && para[k] !== undefined) paraProps[k] = num(para[k]);
  const charProps = {};
  for (const k of CHAR_SHAPE_KEYS) if (char && char[k] !== undefined) charProps[k] = char[k];

  const marker = parseMarker(text);
  // 41% of character shapes do not have all seven language font slots
  // identical, so "the font of this paragraph" is a single value only
  // sometimes. Report the Hangul slot and say when the others disagree,
  // rather than picking one and being wrong 41% of the time.
  const fonts = Array.isArray(char?.fontFamilies) ? char.fontFamilies : [];
  const mixedLanguageFonts = new Set(fonts).size > 1;

  return {
    section: s,
    paragraph: p,
    length: len,
    empty: len === 0,
    text,
    paraProps,
    charProps,
    readOnly: {
      fontFamily: char?.fontFamily ?? null,
      mixedLanguageFonts,
      ...(mixedLanguageFonts ? { fontFamilies: fonts } : {}),
      style: style?.name ?? null,
    },
    ...(marker
      ? { marker: { glyph: marker.glyph, indentChars: marker.indent.length } }
      : {}),
  };
}

// The signature two paragraphs must share to be "the same shape". Marker glyph
// and depth are part of it: two paragraphs with identical geometry but
// different glyphs are not interchangeable in a 개조식 list.
export function shapeKey(sh) {
  return JSON.stringify({
    para: sh.paraProps,
    char: sh.charProps,
    marker: sh.marker ? { glyph: sh.marker.glyph, indentChars: sh.marker.indentChars } : null,
  });
}

// Collect every non-empty paragraph into shape groups, in document order.
export function buildPalette(doc, { section = null } = {}) {
  const shapes = new Map();
  const paragraphs = [];
  const sections = section === null ? [...Array(doc.getSectionCount()).keys()] : [section];
  for (const s of sections) {
    const n = doc.getParagraphCount(s);
    for (let p = 0; p < n; p++) {
      const sh = paragraphShape(doc, s, p);
      paragraphs.push(sh);
      if (sh.empty) continue; // an empty paragraph is spacing, not a shape
      const key = shapeKey(sh);
      if (!shapes.has(key)) {
        shapes.set(key, {
          id: `P${shapes.size + 1}`,
          count: 0,
          paragraphs: [],
          paraProps: sh.paraProps,
          charProps: sh.charProps,
          marker: sh.marker ?? null,
          readOnly: sh.readOnly,
        });
      }
      const g = shapes.get(key);
      g.count++;
      g.paragraphs.push({ section: sh.section, paragraph: sh.paragraph });
    }
  }
  const list = [...shapes.values()].sort((a, b) => b.count - a.count);
  return {
    paragraphs,
    shapes: list,
    markers: markerInventory(list),
    observations: observe(list, paragraphs),
  };
}

// The marker inventory: every glyph, how often, and at which depths. This is
// FACT, not an observation — it is what lets a reader judge a list without the
// tool pretending to know the outline level.
export function markerInventory(shapes) {
  const glyphs = new Map();
  for (const sh of shapes) {
    if (!sh.marker) continue;
    const g = sh.marker.glyph;
    if (!glyphs.has(g)) glyphs.set(g, { glyph: g, count: 0, depths: new Map() });
    const e = glyphs.get(g);
    e.count += sh.count;
    e.depths.set(sh.marker.indentChars, (e.depths.get(sh.marker.indentChars) ?? 0) + sh.count);
  }
  return [...glyphs.values()]
    .map((e) => ({
      glyph: e.glyph,
      count: e.count,
      depths: [...e.depths].sort((a, b) => a[0] - b[0]).map(([indentChars, count]) => ({ indentChars, count })),
    }))
    .sort((a, b) => b.count - a.count);
}

// Evidence of inconsistency. Each entry carries WHY, so a caller can overrule
// it. None is a verdict and none implies a fix.
//
// WHAT IS DELIBERATELY *NOT* HERE: "different glyphs share a leading-space
// depth". It reads like the right signal and is not, because half of all real
// marker paragraphs carry no indent at all — so at depth 0 it lumps a
// legitimate top-level □ together with level-2 items that merely lost their
// indent, and then names □ the majority. Acting on that would push the strays
// UP a level instead of fixing them. The glyph inventory reports the same facts
// without the false implication.
function observe(shapes, paragraphs) {
  const out = [];

  // 1. A glyph used at MORE THAN ONE depth. Self-inconsistency, and unambiguous:
  //    whatever the right level is, one glyph cannot be at two of them.
  for (const inv of markerInventory(shapes)) {
    if (inv.depths.length < 2) continue;
    const ranked = [...inv.depths].sort((a, b) => b.count - a.count);
    out.push({
      kind: "glyph-at-mixed-depths",
      glyph: inv.glyph,
      depths: inv.depths,
      majorityDepth: ranked[0].indentChars,
      why:
        `"${inv.glyph}" appears at ${inv.depths.length} different leading-space depths ` +
        `(${inv.depths.map((d) => `${d.indentChars}sp×${d.count}`).join(", ")}). One glyph ` +
        `marking two depths is inconsistent with itself whatever the intended outline is; ` +
        `${ranked[0].indentChars}sp is the more common.`,
    });
  }

  // 2. A rare shape one property away from a common one. Reported ONCE per rare
  //    shape, against its nearest more-common neighbour — comparing every pair
  //    restates a single problem O(n²) times and buries it.
  //
  //    A difference of ONLY the marker glyph is excluded. Naming a more common
  //    shape as the "nearest" implies conforming to it, and for glyphs that
  //    direction cannot be known from geometry: a level-2 item that lost its
  //    indent is identical, property for property, to a level-1 item with the
  //    wrong glyph. Reporting it here would smuggle back exactly the false
  //    implication the competing-glyphs signal was dropped for. The marker
  //    inventory already states the same facts without pointing anywhere.
  for (const small of shapes) {
    let best = null;
    for (const big of shapes) {
      if (big === small || big.count <= small.count) continue;
      if (small.count > big.count / 2) continue; // both well used: a real distinction
      const diff = differingKeys(small, big);
      if (diff.length !== 1) continue;
      if (diff[0] === "marker.glyph") continue; // see above
      if (!best || big.count > best.big.count) best = { big, diff };
    }
    if (!best) continue;
    out.push({
      kind: "near-duplicate",
      shape: small.id,
      nearest: best.big.id,
      differsIn: best.diff,
      why:
        `${small.id} (${small.count}) differs from ${best.big.id} (${best.big.count}) in ` +
        `exactly one property (${best.diff.join(", ")}). A single-property difference on a ` +
        `much smaller group is what a slip looks like — and also what a deliberate variant ` +
        `looks like.`,
    });
  }

  // 3. Shapes used once. Named, NOT judged: a title is used once too. Skipped
  //    when the shape is already reported as a near-duplicate, which says more.
  const reported = new Set(out.filter((o) => o.kind === "near-duplicate").map((o) => o.shape));
  for (const sh of shapes) {
    if (sh.count !== 1 || reported.has(sh.id)) continue;
    out.push({
      kind: "singleton",
      shape: sh.id,
      paragraph: sh.paragraphs[0],
      why:
        `${sh.id} is used by one paragraph. That is equally consistent with a ` +
        `deliberate one-off (a title) and with a slip — decide from the content.`,
    });
  }

  return out;
}

function differingKeys(a, b) {
  const keys = new Set([
    ...Object.keys(a.paraProps),
    ...Object.keys(b.paraProps),
    ...Object.keys(a.charProps),
    ...Object.keys(b.charProps),
  ]);
  const diff = [];
  for (const k of keys) {
    const av = a.paraProps[k] ?? a.charProps[k];
    const bv = b.paraProps[k] ?? b.charProps[k];
    if (JSON.stringify(av) !== JSON.stringify(bv)) diff.push(k);
  }
  const ag = a.marker?.glyph ?? null;
  const bg = b.marker?.glyph ?? null;
  if (ag !== bg) diff.push("marker.glyph");
  const ai = a.marker?.indentChars ?? null;
  const bi = b.marker?.indentChars ?? null;
  if (ai !== bi) diff.push("marker.indentChars");
  return diff;
}
