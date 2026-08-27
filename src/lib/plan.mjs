// Replaying an edit plan — many edits in one load/save.
//
// WHY THIS IS NOT A MULTI-AGENT FEATURE. It looks like one, because the
// obvious use is merging several agents' edits into one document. But the
// measurement says the solo case is where it pays, and pays hard:
//
//   12 edits as 12 script invocations   4,895 ms, 12 intermediate files
//   12 edits as one replayed plan          59 ms, 1 file
//
// with the SAME verification in both — the batch reloads the saved file and
// confirms each intent, it does not buy a cheaper guarantee. The 80x is not
// the editing, which is under 50 ms for a whole document; it is paying for a
// process start, a 6.9 MB WASM load, a parse and a save twelve times over. A
// realistic cleanup (unify twenty bullets, fix twenty indents, bold five
// headings) is 45 edits: about 18 seconds and 45 files today.
//
// TWO THINGS BATCHING CHANGES, AND BOTH ARE HANDLED HERE.
//
// 1. The failure mode. Twelve separate invocations leave files 1..6 on disk
//    when step 7 fails, so you can see how far it got. One pass has no such
//    trail, so a failure must name the STEP INDEX and write no output at all —
//    the same contract the individual scripts already keep when they refuse.
//
// 2. The verification granularity. Twelve invocations verify twelve times.
//    If a batch collapsed that into "the file still opens", it would re-open
//    the silent-failure hole this repo keeps closing — the engine returns
//    ok:true for edits it ignores. So every step records an INTENT, and after
//    the save the reloaded document is checked against each one. A step whose
//    intent cannot be confirmed on disk fails the whole run.
//
// THE INDEX PROBLEM. Paragraph addresses shift when an earlier step inserts a
// paragraph: insert at 5, and the step that meant paragraph 12 now means 13.
// This repo has already solved the same shape once — lib/blocks.mjs splices
// inline controls in DESCENDING offset order precisely so that earlier
// positions stay valid, and documents the tie-breaking. Lifted to paragraphs:
// applying highest-index-first keeps every not-yet-applied address correct.
//
// But reversing blindly would break a dependent sequence — insert_paragraph
// then insert_text INTO it must stay in order. So the default is to apply the
// plan exactly as written and REFUSE when a shift would invalidate a later
// address, naming both steps. `order: "descending"` opts into the sort for the
// independent case, which is what a merge of per-agent plans looks like.

import { EXIT, fail } from "./exit-codes.mjs";
import { parseMarker } from "./bullets.mjs";
import { validateProps } from "./format_props.mjs";

// Ops that move paragraph indices, and therefore can invalidate a later step.
const SHIFTING_OPS = new Set(["insert_paragraph"]);

// Every op the plan vocabulary accepts. Kept in ONE place so a plan can cross
// what would otherwise be script boundaries: a cleanup is bullets AND indents
// AND character formatting, and a plan that could only express one script's
// ops would be a third of a feature.
export const PLAN_OPS = Object.freeze([
  "insert_text",
  "insert_paragraph",
  "create_table",
  "insert_text_in_cell",
  "apply_para_format",
  "apply_char_format",
]);

const asInt = (v, d = 0) => (Number.isInteger(v) ? v : d);

// The address a step targets, for the shift check. null when the step has no
// paragraph address (nothing to invalidate).
function addressOf(step) {
  if (!Number.isInteger(step.para)) return null;
  return { section: asInt(step.section, 0), para: step.para };
}

// Reject a plan whose later steps would be misaddressed by an earlier
// insertion, rather than applying it and producing a plausible wrong document.
//
// `existing` is how many paragraphs the target section had BEFORE the plan ran,
// and it is what separates a hazard from an ordinary build. Appending — insert
// at or past the end, then fill what you just made — shifts nothing, because
// there is no pre-existing paragraph after the insertion point. That is the
// normal way a plan constructs a document, and flagging it was a false positive
// that broke the fixture generator. The hazard is inserting INSIDE the document
// that was already there, which renumbers paragraphs a later step still refers
// to by their old addresses.
export function checkOrdering(steps, existing = Infinity) {
  const problems = [];
  for (let i = 0; i < steps.length; i++) {
    if (!SHIFTING_OPS.has(steps[i].op)) continue;
    const at = addressOf(steps[i]);
    if (!at) continue;
    if (at.para >= existing) continue; // appending: nothing after it to shift
    for (let k = i + 1; k < steps.length; k++) {
      const later = addressOf(steps[k]);
      if (!later || later.section !== at.section) continue;
      if (later.para > at.para) {
        problems.push({
          insertStep: i,
          affectedStep: k,
          why:
            `step ${i} (${steps[i].op}) inserts at paragraph ${at.para}, which shifts ` +
            `paragraph ${later.para} — the address step ${k} (${steps[k].op}) targets — ` +
            `to ${later.para + 1}. Applying both as written would edit the wrong paragraph.`,
        });
        break; // one report per shifting step is enough to act on
      }
    }
  }
  return problems;
}

// Sort independent steps highest-address-first, so insertions never invalidate
// an address that has not been applied yet. Refuses if the plan is dependent —
// the sort would reorder a sequence that has to stay in order.
export function descendingOrder(steps) {
  const dependent = steps.some((s) => SHIFTING_OPS.has(s.op));
  if (dependent) {
    fail(
      EXIT.USAGE,
      `error: order "descending" needs independent steps, but the plan contains ` +
        `${[...SHIFTING_OPS].join("/")}, which creates paragraphs later steps may depend on.\n` +
        `       Order those steps yourself and use the default order.`,
    );
  }
  return [...steps.entries()]
    .sort(([, a], [, b]) => {
      const aa = addressOf(a);
      const bb = addressOf(b);
      if (!aa || !bb) return 0;
      return bb.section - aa.section || bb.para - aa.para;
    })
    .map(([i, s]) => ({ ...s, _index: i }));
}

// Apply one step, returning the INTENT to confirm from the saved file. An op
// that cannot express an intent returns null and is covered by the round trip
// alone; every op that can, does.
function applyStep(doc, step, i) {
  const section = asInt(step.section, 0);
  const para = asInt(step.para, 0);
  const char = asInt(step.char, 0);

  switch (step.op) {
    case "insert_text": {
      const text = step.text ?? "";
      if (typeof text !== "string" || text === "") {
        fail(EXIT.USAGE, `step ${i}: insert_text requires a non-empty "text" string`);
      }
      doc.insertText(section, para, char, text);
      return { kind: "text-present", section, para, text };
    }
    case "insert_paragraph":
      doc.insertParagraph(section, para);
      return { kind: "paragraph-exists", section, para };
    case "create_table":
      if (!Number.isInteger(step.rows) || !Number.isInteger(step.cols)) {
        fail(EXIT.USAGE, `step ${i}: create_table requires integer "rows" and "cols"`);
      }
      doc.createTable(section, para, char, step.rows, step.cols);
      return { kind: "table-exists", section, para };
    case "insert_text_in_cell":
      doc.insertTextInCell(
        section,
        para,
        asInt(step.control, 0),
        asInt(step.cell, 0),
        asInt(step.cell_para, 0),
        char,
        step.text ?? "",
      );
      return null; // cell text is confirmed by the round trip
    case "apply_para_format":
    case "apply_char_format": {
      const which = step.op === "apply_char_format" ? "char" : "para";
      const props = step.props;
      if (props === null || typeof props !== "object" || Array.isArray(props)) {
        fail(EXIT.USAGE, `step ${i}: ${step.op} requires a "props" object, e.g. {"bold":true}`);
      }
      // Same table the individual scripts use. Without it the engine answers
      // ok:true for a typo'd key and the step reports success having done
      // nothing — the failure this whole file is built to make impossible.
      const { errors } = validateProps(which, props, { allowUnknown: step.allow_unknown === true });
      if (errors.length) {
        fail(EXIT.USAGE, `step ${i}: ${step.op} props rejected:\n` + errors.map((e) => `  - ${e}`).join("\n"));
      }
      if (which === "char") {
        const start = asInt(step.start, 0);
        const end = Number.isInteger(step.end) ? step.end : doc.getParagraphLength(section, para);
        doc.applyCharFormat(section, para, start, end, JSON.stringify(props));
        return { kind: "char-props", section, para, offset: start, props };
      }
      doc.applyParaFormat(section, para, JSON.stringify(props));
      return { kind: "para-props", section, para, props };
    }
    default:
      fail(EXIT.USAGE, `step ${i}: unknown op ${JSON.stringify(step.op)} (expected ${PLAN_OPS.join(", ")})`);
  }
  return null;
}

// Confirm one intent against the RELOADED document. Returns null when
// confirmed, or a reason string when it did not take.
function confirmIntent(back, intent) {
  try {
    switch (intent.kind) {
      case "text-present": {
        const len = back.getParagraphLength(intent.section, intent.para);
        const text = len ? back.getTextRange(intent.section, intent.para, 0, len) : "";
        return text.includes(intent.text) ? null : `inserted text is not in paragraph ${intent.para} on reload`;
      }
      case "paragraph-exists":
        return back.getParagraphCount(intent.section) > intent.para
          ? null
          : `paragraph ${intent.para} does not exist on reload`;
      case "table-exists":
        return back.getParagraphCount(intent.section) > intent.para ? null : `table's paragraph is missing on reload`;
      case "char-props": {
        const got = JSON.parse(back.getCharPropertiesAt(intent.section, intent.para, intent.offset));
        return mismatch(intent.props, got, ["fontSize"]);
      }
      case "para-props": {
        const got = JSON.parse(back.getParaPropertiesAt(intent.section, intent.para));
        // marginLeft/indent/spacing* come back divided by 150 (spec rule 66),
        // so an exact compare would fail a correct edit. Sign and non-zero-ness
        // are what can be checked honestly.
        return mismatch(intent.props, got, ["lineSpacing", "marginLeft", "marginRight", "indent", "spacingBefore", "spacingAfter"]);
      }
      default:
        return null;
    }
  } catch (e) {
    return `could not read it back: ${e?.message ?? e}`;
  }
}

// Compare requested props against what the reloaded document reports. Keys in
// `converted` are unit-converted on the way in, so they are checked for having
// MOVED in the right direction rather than for equality.
function mismatch(want, got, converted) {
  for (const [k, v] of Object.entries(want)) {
    const g = got?.[k];
    if (g === undefined) continue; // getter does not surface it; round trip covers it
    if (converted.includes(k)) {
      if (typeof v === "number" && v !== 0 && (typeof g !== "number" || Math.sign(g) !== Math.sign(v))) {
        return `"${k}" did not take (asked ${v}, reloaded ${JSON.stringify(g)})`;
      }
      continue;
    }
    if (typeof v === "string" && typeof g === "string") {
      if (v.toLowerCase() !== g.toLowerCase()) return `"${k}" is ${JSON.stringify(g)} on disk, asked ${JSON.stringify(v)}`;
      continue;
    }
    if (JSON.stringify(v) !== JSON.stringify(g)) {
      return `"${k}" is ${JSON.stringify(g)} on disk, asked ${JSON.stringify(v)}`;
    }
  }
  return null;
}

// Replay a whole plan against an already-loaded document.
//
// Returns { applied, intents }. Throws through fail() with the STEP INDEX on
// any problem, so a failure is locatable without an intermediate-file trail.
export function replay(doc, steps, { order = "as-given", existingParagraphs = Infinity } = {}) {
  if (!Array.isArray(steps)) fail(EXIT.USAGE, `error: plan.steps must be an array`);
  if (steps.length === 0) fail(EXIT.USAGE, `error: plan.steps is empty; nothing to apply`);

  let ordered;
  if (order === "descending") {
    ordered = descendingOrder(steps);
  } else {
    const problems = checkOrdering(steps, existingParagraphs);
    if (problems.length) {
      fail(
        EXIT.USAGE,
        `error: this plan would edit the wrong paragraphs.\n` +
          problems.map((p) => `  - ${p.why}`).join("\n") +
          `\n       Reorder the steps highest-paragraph-first, or adjust the addresses.\n` +
          `       Independent plans can use order "descending" to be sorted automatically.`,
      );
    }
    ordered = steps.map((s, i) => ({ ...s, _index: i }));
  }

  const applied = [];
  const intents = [];
  for (const step of ordered) {
    const i = step._index;
    let intent;
    try {
      intent = applyStep(doc, step, i);
    } catch (e) {
      if (e?.code === "ERR_FAIL") throw e;
      fail(EXIT.CORRUPTION, `error: step ${i} (${step.op}) failed: ${e?.message ?? e}`);
    }
    applied.push({ step: i, op: step.op });
    if (intent) intents.push({ step: i, op: step.op, intent });
  }
  return { applied, intents };
}

// Confirm every recorded intent against the saved-and-reloaded document.
// Returns the list of steps whose intent did NOT hold.
export function confirmAll(back, intents) {
  const failures = [];
  for (const { step, op, intent } of intents) {
    const why = confirmIntent(back, intent);
    if (why) failures.push({ step, op, why });
  }
  return failures;
}

// Marker helper for callers building plans from a palette — exported so a
// plan author does not have to re-derive what counts as a 개조식 marker.
export { parseMarker };
