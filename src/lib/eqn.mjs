// HWP equation scripts: normalization, and a best-effort LaTeX mapping.
//
// ── WHY THERE IS NO PANDOC HERE ────────────────────────────────────────────
//
// The reflex for "document format → equations" is OMML → pandoc → LaTeX. HWP
// does not use OMML. `getEquationProperties(s, p, c, -1, -1).script` hands back
// Hancom's own equation script — `sqrt {a over b}`, `x^2 + y^2 = z^2` — in one
// WASM call, already parsed out of the record stream. There is nothing to shell
// out to and nothing to convert on the way in. Everything below operates on
// that string.
//
// ── THE HONESTY RULE ───────────────────────────────────────────────────────
//
// HWP's script language is TeX-ish but not TeX. `over` is TeX's `\over`,
// `sqrt` is `\sqrt`, but `matrix`, `pile`, `cases`, `root … of …` and the
// stacking operators have no one-token equivalent, and HWP's spacing atoms
// (`~`, backquote) mean something specific. A translator that maps the tokens
// it knows and passes the rest through produces output that LOOKS like LaTeX,
// compiles, and is WRONG — a formula silently changed is worse than a formula
// left untranslated, because nothing downstream can tell.
//
// So `equationToLatex` never claims more than it did:
//
//   { latex, complete: boolean, unmapped: string[] }
//
// `complete: false` means "some token in here was not understood, and `latex`
// is a draft, not a translation". Renderers must fall back to the raw script on
// `complete: false` — blocks.mjs does exactly that. Multi-letter latin words
// that are not in the keyword tables are treated as NOT understood rather than
// as variable names, because that is the direction in which being wrong is
// cheap: a flagged `dx` costs a fallback, an unflagged `matrix` costs a
// corrupted formula.
//
// LaTeX is opt-in for the same reason. The default rendering path uses the
// normalized HWP script verbatim.

// Zero-width and BOM characters. HWP scripts pick these up from copy/paste out
// of the equation editor and they survive the round-trip invisibly.
const RE_ZERO_WIDTH = /[\u200b-\u200f\u2060\ufeff]/g;
// C0/C1 controls. Any real line structure has already become a space by the
// time this runs (RE_WHITESPACE runs after, and \s covers \t\r\n).
const RE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const RE_WHITESPACE = /[\s\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]+/g;

// Does `s` consist of exactly one brace group wrapping everything? `{a} over
// {b}` must answer no: its first `{` closes at index 2, not at the end. A
// backslash escapes the next character so an escaped brace cannot unbalance the
// scan.
function isFullyWrapped(s) {
  if (s.length < 2 || s[0] !== "{" || s[s.length - 1] !== "}") return false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\") {
      i++; // skip the escaped character
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i === s.length - 1;
      if (depth < 0) return false; // malformed — leave it alone
    }
  }
  return false;
}

// Canonical form of an HWP equation script.
//
// Collapses every flavour of whitespace to single spaces, drops invisible
// characters, and peels off redundant enclosing braces — `{{x^2}}` and ` x^2 `
// are the same equation and must compare equal, because callers diff scripts
// (snapshot/track-change) and a whitespace-only difference reported as a change
// is a false positive in every one of them.
//
// Idempotent by construction: the brace peel runs to a fixed point, and after
// one pass there is no whitespace or wrapper left for a second pass to remove.
// Never throws — a non-string, null or undefined input yields "".
export function normalizeEquationScript(script) {
  let s;
  try {
    s = String(script ?? "");
  } catch {
    return ""; // an object with a hostile toString
  }
  s = s
    .replace(RE_ZERO_WIDTH, "")
    .replace(RE_CONTROL, " ")
    .normalize("NFC")
    .replace(RE_WHITESPACE, " ")
    .trim();
  // Peel to a fixed point. `{{x}}` → `{x}` → `x`; one pass would leave `{x}`
  // and break idempotence.
  while (isFullyWrapped(s)) s = s.slice(1, -1).trim();
  return s;
}

// ── the keyword tables ─────────────────────────────────────────────────────
//
// Everything a token can be. A latin word NOT in one of these (and longer than
// one character) is reported unmapped — see the honesty rule above.

// Prefix operators that swallow exactly one following atom.
const PREFIX1 = {
  sqrt: "\\sqrt",
  rm: "\\mathrm",
  it: "\\mathit",
  bold: "\\mathbf",
  vec: "\\vec",
  hat: "\\hat",
  bar: "\\overline",
  tilde: "\\tilde",
  dot: "\\dot",
  ddot: "\\ddot",
  acute: "\\acute",
  grave: "\\grave",
  check: "\\check",
  breve: "\\breve",
};

// Large operators. These are the ones `from`/`to` attach limits to.
const BIG = {
  sum: "\\sum",
  prod: "\\prod",
  int: "\\int",
  iint: "\\iint",
  iiint: "\\iiint",
  oint: "\\oint",
  lim: "\\lim",
  coprod: "\\coprod",
  bigcup: "\\bigcup",
  bigcap: "\\bigcap",
};

// Named functions — upright in LaTeX, so they need the command form.
const FUNCTIONS = [
  "sin", "cos", "tan", "sec", "csc", "cot",
  "sinh", "cosh", "tanh", "coth",
  "arcsin", "arccos", "arctan",
  "log", "ln", "exp", "det", "deg", "gcd", "max", "min", "sup", "inf",
];

const GREEK_LOWER = [
  "alpha", "beta", "gamma", "delta", "epsilon", "varepsilon", "zeta", "eta",
  "theta", "vartheta", "iota", "kappa", "lambda", "mu", "nu", "xi", "pi",
  "varpi", "rho", "varrho", "sigma", "varsigma", "tau", "upsilon", "phi",
  "varphi", "chi", "psi", "omega",
];

// HWP writes capital Greek in ALL CAPS (`GAMMA`), LaTeX in title case.
const GREEK_UPPER = [
  "GAMMA", "DELTA", "THETA", "LAMBDA", "XI", "PI", "SIGMA", "UPSILON", "PHI",
  "PSI", "OMEGA",
];

// Leaf symbols: relations, binary operators, arrows, set notation.
const SYMBOLS = {
  times: "\\times",
  div: "\\div",
  cdot: "\\cdot",
  pm: "\\pm",
  mp: "\\mp",
  ast: "\\ast",
  star: "\\star",
  circ: "\\circ",
  bullet: "\\bullet",
  oplus: "\\oplus",
  otimes: "\\otimes",
  leq: "\\leq",
  le: "\\leq",
  geq: "\\geq",
  ge: "\\geq",
  neq: "\\neq",
  ne: "\\neq",
  approx: "\\approx",
  equiv: "\\equiv",
  sim: "\\sim",
  simeq: "\\simeq",
  cong: "\\cong",
  propto: "\\propto",
  ll: "\\ll",
  gg: "\\gg",
  infty: "\\infty",
  inf: "\\infty", // HWP spells it `inf`; the LaTeX \inf function is `inf` too,
  // but in HWP scripts the infinity reading is overwhelmingly the intended one.
  partial: "\\partial",
  nabla: "\\nabla",
  forall: "\\forall",
  exists: "\\exists",
  in: "\\in",
  notin: "\\notin",
  ni: "\\ni",
  subset: "\\subset",
  supset: "\\supset",
  subseteq: "\\subseteq",
  supseteq: "\\supseteq",
  cup: "\\cup",
  cap: "\\cap",
  emptyset: "\\emptyset",
  angle: "\\angle",
  perp: "\\perp",
  parallel: "\\parallel",
  therefore: "\\therefore",
  because: "\\because",
  to: "\\to", // only when it is NOT a limit marker — see parseSequence
  rightarrow: "\\rightarrow",
  leftarrow: "\\leftarrow",
  leftrightarrow: "\\leftrightarrow",
  Rightarrow: "\\Rightarrow",
  Leftarrow: "\\Leftarrow",
  ldots: "\\ldots",
  cdots: "\\cdots",
  vdots: "\\vdots",
  ddots: "\\ddots",
  dots: "\\dots",
  prime: "\\prime",
  degree: "^{\\circ}",
  equal: "=",
};

for (const g of GREEK_LOWER) SYMBOLS[g] = "\\" + g;
for (const g of GREEK_UPPER) SYMBOLS[g] = "\\" + g[0] + g.slice(1).toLowerCase();
for (const f of FUNCTIONS) SYMBOLS[f] = "\\" + f;

// Multi-character operators, longest first so `<=` never tokenizes as `<`.
const OPERATORS2 = { "<=": "\\leq", ">=": "\\geq", "<>": "\\neq", "!=": "\\neq", "+-": "\\pm", "-+": "\\mp" };

// Single characters that pass through, or map to a spacing/relation command.
const OPERATORS1 = {
  "+": "+", "-": "-", "*": "*", "/": "/", "=": "=", "<": "<", ">": ">",
  "(": "(", ")": ")", "[": "[", "]": "]", "|": "|", ",": ",", ".": ".",
  ";": ";", ":": ":", "!": "!", "'": "'",
  "~": "\\ ", // HWP full space
  "`": "\\,", // HWP half space
};

// Delimiter map for LEFT/RIGHT. `.` is TeX's "no delimiter".
const DELIMS = { "(": "(", ")": ")", "[": "[", "]": "]", "{": "\\{", "}": "\\}", "|": "|", ".": "." };

// Literal Unicode maths that HWP scripts carry verbatim, because the equation
// editor accepts a pasted `×` or `≤` and stores it as itself rather than as the
// keyword. Without this table every such character would be reported unmapped
// and drag an otherwise perfectly translatable formula down to complete:false.
const UNICODE_SYMBOLS = {
  "×": "\\times", "÷": "\\div", "±": "\\pm", "∓": "\\mp", "·": "\\cdot",
  "≤": "\\leq", "≥": "\\geq", "≠": "\\neq", "≈": "\\approx", "≡": "\\equiv",
  "∞": "\\infty", "∂": "\\partial", "∇": "\\nabla", "∑": "\\sum", "∏": "\\prod",
  "∫": "\\int", "√": "\\sqrt", "∈": "\\in", "∉": "\\notin", "⊂": "\\subset",
  "⊃": "\\supset", "∪": "\\cup", "∩": "\\cap", "∅": "\\emptyset",
  "∀": "\\forall", "∃": "\\exists", "→": "\\to", "←": "\\leftarrow",
  "↔": "\\leftrightarrow", "⇒": "\\Rightarrow", "∠": "\\angle", "⊥": "\\perp",
  "∴": "\\therefore", "∵": "\\because", "°": "^{\\circ}", "′": "'", "″": "''",
};
// U+03B1..U+03C9 in code-point order, and the capitals HWP actually emits.
const GREEK_GLYPHS =
  "αβγδεζηθικλμνξοπρςστυφχψω:alpha,beta,gamma,delta,epsilon,zeta,eta,theta," +
  "iota,kappa,lambda,mu,nu,xi,omicron,pi,rho,varsigma,sigma,tau,upsilon,phi," +
  "chi,psi,omega|ΓΔΘΛΞΠΣΦΨΩ:Gamma,Delta,Theta,Lambda,Xi,Pi,Sigma,Phi,Psi,Omega";
for (const chunk of GREEK_GLYPHS.split("|")) {
  const [glyphs, names] = chunk.split(":");
  [...glyphs].forEach((ch, i) => {
    UNICODE_SYMBOLS[ch] ??= "\\" + names.split(",")[i];
  });
}

export const HWP_EQUATION_KEYWORDS = Object.freeze({
  PREFIX1: Object.freeze({ ...PREFIX1 }),
  BIG: Object.freeze({ ...BIG }),
  SYMBOLS: Object.freeze({ ...SYMBOLS }),
});

// ── tokenizer ──────────────────────────────────────────────────────────────

const isWordStart = (ch) => /[A-Za-z]/.test(ch);
const isWordChar = (ch) => /[A-Za-z0-9]/.test(ch);
const isDigit = (ch) => /[0-9]/.test(ch);

// HWP writes these in caps; accept either case.
const isLeftWord = (w) => w === "LEFT" || w === "left";
const isRightWord = (w) => w === "RIGHT" || w === "right";

// Token: {k: "word"|"num"|"op"|"lbrace"|"rbrace"|"sup"|"sub"|"unknown", v}
function tokenize(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === " ") {
      i++;
      continue;
    }
    if (ch === "{") {
      out.push({ k: "lbrace", v: "{" });
      i++;
    } else if (ch === "}") {
      out.push({ k: "rbrace", v: "}" });
      i++;
    } else if (ch === "^") {
      out.push({ k: "sup", v: "^" });
      i++;
    } else if (ch === "_") {
      out.push({ k: "sub", v: "_" });
      i++;
    } else if (isWordStart(ch)) {
      let j = i + 1;
      while (j < s.length && isWordChar(s[j])) j++;
      out.push({ k: "word", v: s.slice(i, j) });
      i = j;
    } else if (isDigit(ch)) {
      let j = i + 1;
      while (j < s.length && (isDigit(s[j]) || (s[j] === "." && isDigit(s[j + 1] ?? "")))) j++;
      out.push({ k: "num", v: s.slice(i, j) });
      i = j;
    } else if (OPERATORS2[s.slice(i, i + 2)]) {
      out.push({ k: "op", v: s.slice(i, i + 2) });
      i += 2;
    } else if (OPERATORS1[ch]) {
      out.push({ k: "op", v: ch });
      i++;
    } else if (UNICODE_SYMBOLS[ch]) {
      out.push({ k: "op", v: ch });
      i++;
    } else if (ch.charCodeAt(0) > 0x7f) {
      // A run of non-ASCII — Korean labels inside a formula, most often. Kept
      // whole rather than split per character so `unmapped` names the word that
      // needs a human, not four meaningless code points.
      let j = i + 1;
      while (j < s.length && s[j].charCodeAt(0) > 0x7f && !UNICODE_SYMBOLS[s[j]]) j++;
      out.push({ k: "unknown", v: s.slice(i, j) });
      i = j;
    } else {
      // `#`, `&`, `\`, anything else. Kept so the draft still shows it,
      // reported so nobody trusts the draft.
      out.push({ k: "unknown", v: ch });
      i++;
    }
  }
  return out;
}

// ── parser ─────────────────────────────────────────────────────────────────
//
// Recursive descent over the token stream, producing LaTeX fragments directly.
// Three structures need more than a token swap:
//
//   `over`    — TeX's \over: everything before it in the current scope is the
//               numerator, everything after is the denominator. Handled at
//               sequence level, not as an atom.
//   LEFT/RIGHT— a delimiter pair OPENS A SCOPE. `LEFT ( x over y RIGHT )` is
//               `\left( \frac{x}{y} \right)`; parsing LEFT as a plain atom lets
//               the `over` split reach across the delimiters and produce
//               `\frac{\left( x}{y \right)}`, which is a different formula that
//               still compiles. Delimiters bound the scope for that reason.
//   from/to   — `sum from{i=1} to{n}` are the limits of the preceding large
//               operator, so they become `_{...}` / `^{...}` on that atom rather
//               than free-standing symbols. Outside that position `to` is \to.

class Parser {
  constructor(tokens) {
    this.t = tokens;
    this.i = 0;
    this.unmapped = [];
  }

  peek() {
    return this.t[this.i];
  }

  next() {
    return this.t[this.i++];
  }

  flag(tok) {
    if (!this.unmapped.includes(tok)) this.unmapped.push(tok);
  }

  // A sequence of atoms up to the end of the current scope, with `over` applied
  // at this level. `stop` names the scope's terminator: "brace" for a `{…}`
  // group, "right" for the inside of a LEFT/RIGHT pair, null for top level.
  // Returns a LaTeX string.
  parseSequence(stop) {
    const parts = [];
    while (this.i < this.t.length) {
      const tok = this.peek();
      if (stop === "brace" && tok.k === "rbrace") break;
      if (stop === "right" && tok.k === "word" && isRightWord(tok.v)) break;

      if (tok.k === "word" && tok.v === "over") {
        this.next();
        // TeX \over semantics: the whole left side over the whole right side.
        const denom = this.parseSequence(stop);
        return `\\frac{${parts.join(" ")}}{${denom}}`;
      }

      const atom = this.parseAtom(parts);
      // null means the atom folded itself into the sibling before it (from/to).
      // Pushing "" instead would leave an empty string as the last sibling and
      // break the NEXT limit's search for the operator it belongs to.
      if (atom !== null) parts.push(atom);
    }
    return parts.join(" ");
  }

  // One atom, including any trailing ^/_ scripts. `siblings` is the sequence
  // built so far, which from/to need in order to retro-fit limits onto the
  // large operator that precedes them.
  parseAtom(siblings) {
    const tok = this.next();
    if (!tok) return "";

    let tex;

    switch (tok.k) {
      case "lbrace":
        tex = `{${this.parseSequence("brace")}}`;
        if (this.peek()?.k === "rbrace") this.next();
        else this.flag("{"); // unclosed group — the script is malformed
        break;

      case "rbrace":
        // Only reachable at top level: a `}` with no `{`.
        this.flag("}");
        tex = "}";
        break;

      case "num":
        tex = tok.v;
        break;

      case "op":
        tex = OPERATORS2[tok.v] ?? OPERATORS1[tok.v] ?? UNICODE_SYMBOLS[tok.v] ?? tok.v;
        break;

      case "unknown":
        this.flag(tok.v);
        tex = tok.v;
        break;

      case "sup":
      case "sub":
        // A script with nothing to attach to (`^2` at the start of a group).
        tex = `${tok.v}{${this.argument()}}`;
        break;

      case "word":
        tex = this.word(tok, siblings);
        break;

      default:
        this.flag(String(tok.v));
        tex = String(tok.v);
    }

    if (tex === null) return null; // from/to folded itself into a sibling

    // Postfix scripts. A large operator keeps them as limits, which in LaTeX is
    // the same syntax, so no special case is needed here.
    while (this.peek()?.k === "sup" || this.peek()?.k === "sub") {
      const mark = this.next().v;
      tex += `${mark}{${this.argument()}}`;
    }
    return tex;
  }

  // The operand of a prefix operator or a script: one atom, unwrapped if it is
  // a brace group (so `sqrt {x}` is `\sqrt{x}`, never `\sqrt{{x}}`).
  argument() {
    const tok = this.peek();
    if (!tok) return "";
    if (tok.k === "lbrace") {
      this.next();
      const inner = this.parseSequence("brace");
      if (this.peek()?.k === "rbrace") this.next();
      else this.flag("{");
      return inner;
    }
    return this.parseAtom([]) ?? "";
  }

  // One word token → its LaTeX, or null when the word folded itself into the
  // sibling before it.
  word(tok, siblings) {
    const w = tok.v;

    if (PREFIX1[w]) return `${PREFIX1[w]}{${this.argument()}}`;

    if (BIG[w]) return BIG[w];

    // `from` / `to` as limits of the large operator immediately to the left.
    // `to` is only a limit in that position; elsewhere it is the arrow.
    if ((w === "from" || w === "to") && siblings.length) {
      const prev = siblings[siblings.length - 1];
      const isLimitHost = Object.values(BIG).some(
        (b) => prev === b || prev.startsWith(b + "_") || prev.startsWith(b + "^"),
      );
      if (isLimitHost) {
        siblings[siblings.length - 1] = prev + (w === "from" ? "_" : "^") + `{${this.argument()}}`;
        return null;
      }
    }

    if (isLeftWord(w)) return this.delimited(w);

    // A `RIGHT` that parseSequence did not stop at has no `LEFT` to close.
    if (isRightWord(w)) {
      this.flag(w);
      const d = this.next();
      return d ? String(DELIMS[d.v] ?? d.v) : "";
    }

    if (SYMBOLS[w]) return SYMBOLS[w];

    // A single latin letter is a variable. Anything longer that reached here is
    // a keyword we do not know — `matrix`, `pile`, `cases`, `root`, `binom` —
    // and guessing "it must be a variable name" is exactly the silent
    // corruption this module refuses to produce.
    if (w.length === 1) return w;
    this.flag(w);
    return w;
  }

  // `LEFT ( … RIGHT )`. The contents parse as their own scope so `over` inside
  // the delimiters cannot escape them.
  delimited(word) {
    const d = this.next();
    const open = d ? DELIMS[d.v] : undefined;
    if (open === undefined) {
      // No delimiter followed — treat LEFT as noise rather than swallowing the
      // next atom, which would drop a term.
      this.flag(`${word} ${d?.v ?? ""}`.trim());
      if (d) this.i--;
      return "";
    }
    const inner = this.parseSequence("right");
    const r = this.peek();
    if (r && r.k === "word" && isRightWord(r.v)) {
      this.next();
      const d2 = this.next();
      const close = d2 ? DELIMS[d2.v] : undefined;
      if (close === undefined) {
        this.flag(`RIGHT ${d2?.v ?? ""}`.trim());
        if (d2) this.i--;
        return `\\left${open} ${inner} \\right.`;
      }
      return `\\left${open} ${inner} \\right${close}`;
    }
    // `\left` without `\right` does not compile, so close it with the null
    // delimiter and say the script was malformed.
    this.flag(`${word} without RIGHT`);
    return `\\left${open} ${inner} \\right.`;
  }
}

// Best-effort HWP script → LaTeX.
//
// Returns `{ latex, complete, unmapped }`. `latex` is ALWAYS a string and this
// function ALWAYS returns — a malformed script yields `complete: false` rather
// than an exception, because it runs inside a document render where one bad
// formula must not take out the page.
//
// `complete: false` is a hard signal: the caller must not present `latex` as a
// translation. blocks.mjs falls back to the raw script.
export function equationToLatex(script) {
  const normalized = normalizeEquationScript(script);
  if (normalized === "") return { latex: "", complete: true, unmapped: [] };
  try {
    const p = new Parser(tokenize(normalized));
    const latex = p.parseSequence(false);
    return { latex, complete: p.unmapped.length === 0, unmapped: p.unmapped };
  } catch (e) {
    // Defence in depth: a parser bug degrades to "untranslated", never to a
    // thrown error or, worse, a plausible-looking wrong formula.
    return {
      latex: normalized,
      complete: false,
      unmapped: [`<parse-error: ${String(e?.message ?? e)}>`],
    };
  }
}
