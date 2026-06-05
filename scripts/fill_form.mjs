#!/usr/bin/env node
// Usage:
//   node scripts/fill_form.mjs <input> --list                 # JSON of fields
//   node scripts/fill_form.mjs <input> --values <values.json> --output <out>
//
// Korean public-sector forms ship as .hwp/.hwpx with named fields (한컴
// 웹기안기 호환). This script wraps the Field API:
//   - --list   → prints `getFieldList()` parsed JSON, so the agent can see
//                what fields exist before assigning values.
//   - --values → reads a JSON object {fieldName: value, ...} and applies
//                each via setFieldValueByName, then saves.
//
// Output is always HWP 5.0 binary — `.hwpx` output is refused (see
// assertHwpOutput in _bootstrap.mjs). `.hwpx` INPUT is fine.
//
// Field names that don't exist cause a non-zero exit and are reported in
// the error JSON, so partial fills never silently succeed.

import { assertHwpOutput, atomicWriteFile, loadDocument } from "./_bootstrap.mjs";
import { readFileSync } from "node:fs";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name) {
  return process.argv.includes(name);
}

const input = process.argv[2];
if (!input) {
  console.error(
    "usage: fill_form.mjs <input> --list   |   <input> --values <values.json> --output <out>",
  );
  process.exit(2);
}

const doc = await loadDocument(input);

if (flag("--list")) {
  process.stdout.write(JSON.stringify(JSON.parse(doc.getFieldList()), null, 2) + "\n");
  process.exit(0);
}

const valuesPath = arg("--values");
const output = arg("--output");
if (!valuesPath || !output) {
  console.error("missing --values <json> or --output <out.hwp>");
  process.exit(2);
}
assertHwpOutput(output);

const values = JSON.parse(readFileSync(valuesPath, "utf8"));
const applied = [];
const failed = [];
for (const [name, value] of Object.entries(values)) {
  try {
    doc.setFieldValueByName(name, String(value));
    applied.push(name);
  } catch (e) {
    failed.push({ name, error: String(e) });
  }
}

if (failed.length) {
  process.stderr.write(JSON.stringify({ applied, failed }, null, 2) + "\n");
  process.exit(3);
}

const bytes = doc.exportHwp();
atomicWriteFile(output, Buffer.from(bytes));
process.stdout.write(JSON.stringify({ input, output, applied }, null, 2) + "\n");
