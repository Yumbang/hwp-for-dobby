// Indent depth for 개조식 paragraphs — and why the obvious approach is wrong.
//
// THE ASSUMPTION THAT DOES NOT HOLD. Adjusting an indent level looks like it
// should mean moving `marginLeft`. Real documents mostly do not. Across 1,328
// marker paragraphs in 52 documents:
//
//   leading SPACES in the text, no marginLeft   37%
//   marginLeft, no leading spaces               12%
//   both                                         1%
//   neither                                     50%
//
// Spaces beat marginLeft three to one, marginLeft is 0 in 85% of marker
// paragraphs, and its median is 0 for every marker glyph. Half of all marker
// paragraphs carry no indent signal at all — depth is being read off the glyph
// itself (□ vs ○), with indentation as optional reinforcement. A tool that only
// moved marginLeft would have no visible effect on a third of documents.
//
// THE PART THAT IS EASY TO MISS. Leading spaces and a negative `indent` are not
// alternatives, they are a PAIR:
//
//   leading spaces AND hanging indent            50%
//   leading spaces, no hanging indent             8%
//   among space-indented paragraphs long enough
//   to wrap (>45 chars), share that also hang    91%
//
// They do different jobs. The spaces push the marker right; the negative indent
// pulls every wrapped line back under the text after the marker. Set the spaces
// without the hang and a long line wraps to column 0, which is a visible layout
// break — the same class of failure as dropping an image at paper coordinates.
// So `space` scheme always sets both.
//
// THE UNIT TRAP. `marginLeft` / `indent` go IN as HWPUNIT and come back out of
// the getter divided by 150 — measured exactly, across the whole range:
//
//   sent    150  300  1000  1500  2000  3000  4650  7200
//   read      1    2   6.7    10  13.3    20    31    48
//
// HWPUNIT is 1/7200 inch, so the getter's unit is 1/48 inch — that is 1.5
// POINTS, not one. Documentation in this repo (spec rule 54 among others) called
// it "pt", which is wrong by exactly that factor: 2000 HWPUNIT is 20pt, and the
// getter says 13.3. Anything derived from getter output and then sent back has
// to be multiplied by 150/100 = 1.5, and the first version of this file did not,
// so every hanging indent it produced was two thirds of the intended size.
//
// SIZING THE HANG. Measured across 407 hanging marker paragraphs, the hang is
// close to linear in the leading-space count. In TRUE ems (HWPUNIT over
// HWPUNIT, so the 1.5 is already folded in):
//
//   spaces  0     1     2     3     4     5
//   em      3.14  4.08  5.09  5.04  5.73  7.02
//
// which is a ~3.15em intercept (the glyph plus its gap) plus ~0.75em per space.
// Sending those constants reproduces the corpus medians within a few points.

import { parseMarker, textPrefix } from "./bullets.mjs";

// HWPUNIT per unit of getter output. See the unit trap above.
export const GETTER_UNIT_HWPUNIT = 150;

// Derived from the corpus, not from typographic theory — see the header.
// These are TRUE ems: multiply by fontSize (which is already HWPUNIT) to get a
// HWPUNIT value suitable for sending.
export const HANG_BASE_EM = 3.15;
export const HANG_PER_SPACE_EM = 0.75;

// One indent level in the `margin` scheme. Real marginLeft values cluster with
// no clean quantum — the commonest getter readings are 27.3, 16, 14 and 20 — so
// this is chosen rather than measured. Two ems puts level 1 at a reading of
// 13.3 and level 2 at 26.7 on a 10pt paragraph, and both of those appear in the
// corpus, which is the most a made-up constant can hope for.
export const MARGIN_PER_LEVEL_EM = 2;

// fontSize is in HWPUNIT (1400 = 14pt, and 1pt = 100 HWPUNIT because HWPUNIT is
// 1/7200 inch), so fontSize IS the em width in HWPUNIT and no conversion is
// needed on the way IN. Only getter output needs the 150.
export const DEFAULT_FONT_SIZE = 1000;

// The hanging indent that makes wrapped lines align under the text after the
// marker. Returns a NEGATIVE HWPUNIT value, which is what `indent` wants.
export function hangingIndentFor(level, fontSize = DEFAULT_FONT_SIZE) {
  const size = Number.isFinite(fontSize) && fontSize > 0 ? fontSize : DEFAULT_FONT_SIZE;
  const em = HANG_BASE_EM + HANG_PER_SPACE_EM * Math.max(0, level);
  return -Math.round(em * size);
}

// The marginLeft for `margin` scheme, in HWPUNIT.
export function marginForLevel(level, fontSize = DEFAULT_FONT_SIZE) {
  const size = Number.isFinite(fontSize) && fontSize > 0 ? fontSize : DEFAULT_FONT_SIZE;
  return Math.round(MARGIN_PER_LEVEL_EM * size * Math.max(0, level));
}

// Which convention does this document already use for depth?
//
// Deliberately asymmetric. marginLeft has to be clearly in use to win, because
// the fallback (spaces) is both the majority convention and the one our own
// reading side can see — read.mjs shows leading spaces, and headings.mjs learns
// depth partly from them, while marginLeft is invisible in every text output.
export function detectIndentScheme(doc, { section = null } = {}) {
  let spaced = 0;
  let margined = 0;
  let markers = 0;
  const secs = section === null ? doc.getSectionCount() : 1;
  const first = section === null ? 0 : section;
  for (let si = 0; si < secs; si++) {
    const s = first + si;
    const n = doc.getParagraphCount(s);
    for (let p = 0; p < n; p++) {
      const len = doc.getParagraphLength(s, p);
      if (len < 2 || len > 400) continue;
      let text;
      try {
        text = doc.getTextRange(s, p, 0, Math.min(len, 60));
      } catch {
        continue;
      }
      const m = parseMarker(text);
      if (!m) continue;
      markers++;
      let props;
      try {
        props = JSON.parse(doc.getParaPropertiesAt(s, p));
      } catch {
        continue;
      }
      if (m.indent.length > 0) spaced++;
      if (props?.marginLeft > 0) margined++;
    }
  }
  return {
    scheme: margined > spaced && margined > 0 ? "margin" : "space",
    spaced,
    margined,
    markers,
  };
}

// What one paragraph's text should become at `level` under the `space` scheme.
//
// A marker is preserved and re-indented rather than re-typed, so changing depth
// never changes which glyph the line uses. A paragraph with no marker simply
// gets its leading whitespace normalised to `level` spaces.
export function reindentText(text, level) {
  const m = parseMarker(text);
  if (m) {
    return { text: `${textPrefix(m.glyph, level)}${m.body}`, dropped: m.prefixLength, hasMarker: true };
  }
  const lead = /^[ \t 　]*/.exec(String(text ?? ""))[0];
  const body = String(text ?? "").slice(lead.length);
  return { text: `${" ".repeat(Math.max(0, level))}${body}`, dropped: lead.length, hasMarker: false };
}
