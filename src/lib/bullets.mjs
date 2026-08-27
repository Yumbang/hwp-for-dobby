// Bulleted lists (개조식), which Korean documents write two different ways.
//
// THE MEASUREMENT THAT SHAPES THIS FILE. Across 70 real documents:
//
//   HWP's own bullet feature (headType "Bullet")   146 paragraphs, 4 documents
//   a glyph typed into the text ("□ 추진 배경")      274 paragraphs
//
// The feature the format has is the one people use LESS. Nearly twice as many
// bulleted lines are a literal `□`/`○`/`-` followed by a space, with depth
// carried by leading spaces. A tool that only drives headType would leave most
// real 개조식 lists untouched, and a tool that only rewrites text would corrupt
// the documents that do use the feature. So both are implemented, and `auto`
// picks the one the document already uses — the same principle the indent work
// arrived at: follow the document's convention, do not impose one.
//
// THE CALLING CONVENTION THAT WASTED A ROUND. `ensureDefaultBullet` takes a
// RAW STRING, not JSON. Passing '{"char":"●"}' does not error — it takes the
// first character and gives you a bullet that renders as `{`. That, plus the
// fact that an unreferenced bullet is pruned on save, is why an earlier survey
// recorded "bullets do not persist". They persist fine. See spec rule 64.
//
// The engine also crashes the WASM heap on a non-string argument (a number, an
// object) rather than throwing a normal error, so the type guard here is not
// defensive style, it is required.

import { EXIT, fail } from "./exit-codes.mjs";

// Glyphs that read as a bullet at the start of a Korean 개조식 line. Ordered
// roughly by the depth they conventionally mark, but nothing here depends on
// that order — depth is the caller's business.
export const BULLET_GLYPHS = Object.freeze([
  "□", "■", "○", "●", "◦", "▪", "▫", "◇", "◆", "△", "▲", "▷", "▶", "·", "ㅇ", "-", "–", "—", "*", "+",
]);

// A leading marker: optional whitespace, one glyph, then a space. The trailing
// space matters — "○○ 회사" is a company name, not a bullet, and "-5%" is a
// number. Requiring the separator is what keeps this from eating prose.
const LEADING_MARKER = new RegExp(
  `^([ \\t\\u00a0\\u3000]*)(${BULLET_GLYPHS.map((g) => g.replace(/[-*+^$.\\[\\]()|{}?]/g, "\\$&")).join("|")})([ \\t\\u3000]+)`,
);

// Split a paragraph's text into { indent, glyph, gap, body } when it already
// carries a marker, else null. Used both to avoid double-bulleting and to
// remove a bullet without eating the text.
export function parseMarker(text) {
  const m = LEADING_MARKER.exec(String(text ?? ""));
  if (!m) return null;
  return { indent: m[1], glyph: m[2], gap: m[3], body: String(text).slice(m[0].length), prefixLength: m[0].length };
}

// The literal text a `text`-mode bullet puts in front of the paragraph.
//
// Depth is leading SPACES. That is not a style choice — it is what the corpus
// does: of the whitespace that indents marker paragraphs, 1,137 characters were
// SPACE and 3 were TAB, and marginLeft is 0 in 85% of marker paragraphs. One
// space per level matches the observed ladder (□ at 1, ◦ at 2, ○ at 3).
export function textPrefix(glyph, level = 0) {
  return `${" ".repeat(Math.max(0, level))}${glyph} `;
}

// Reject the arguments that make ensureDefaultBullet crash or lie, BEFORE it is
// called. A number or an object takes down the WASM heap; an empty string
// produces an undefined bullet; a multi-character string silently keeps only
// the first character, which is how '{"char":"●"}' became a `{` bullet.
export function assertBulletChar(ch) {
  if (typeof ch !== "string") {
    fail(
      EXIT.USAGE,
      `error: --char must be a string, got ${typeof ch}. The engine's bullet API ` +
        `crashes the WASM heap on a non-string argument rather than reporting an error.`,
    );
  }
  const points = [...ch];
  if (points.length === 0) {
    fail(EXIT.USAGE, `error: --char is empty; there is no bullet character to set.`);
  }
  if (points.length > 1) {
    fail(
      EXIT.USAGE,
      `error: --char must be a single character, got ${JSON.stringify(ch)} ` +
        `(${points.length} characters). The engine keeps only the first and reports ` +
        `success, so "${points[0]}" would silently become the bullet.`,
    );
  }
  return points[0];
}

// Which mechanism does this document already use?
//
// `hwp` if any paragraph carries headType "Bullet" or the document defines a
// bullet at all; otherwise `text`. Deliberately biased: a document that has
// even one real bullet is one where writing glyphs into the text would produce
// two different-looking lists.
export function detectBulletMode(doc, { sections = null } = {}) {
  let definedBullets = 0;
  try {
    const list = JSON.parse(doc.getBulletList());
    definedBullets = Array.isArray(list) ? list.length : 0;
  } catch {
    definedBullets = 0;
  }
  let headTypeBullets = 0;
  let markerParagraphs = 0;
  const secCount = sections ?? doc.getSectionCount();
  for (let s = 0; s < secCount; s++) {
    const n = doc.getParagraphCount(s);
    for (let p = 0; p < n; p++) {
      let props;
      try {
        props = JSON.parse(doc.getParaPropertiesAt(s, p));
      } catch {
        continue;
      }
      if (props?.headType === "Bullet") headTypeBullets++;
      const len = doc.getParagraphLength(s, p);
      if (len > 0 && len < 400) {
        try {
          if (parseMarker(doc.getTextRange(s, p, 0, Math.min(len, 40)))) markerParagraphs++;
        } catch {
          /* a paragraph that will not yield text simply does not vote */
        }
      }
    }
  }
  return {
    mode: headTypeBullets > 0 || definedBullets > 0 ? "hwp" : "text",
    headTypeBullets,
    definedBullets,
    markerParagraphs,
  };
}
