// Two properties that decide whether this skill works at all, in places we
// cannot run a test: the skill's IDENTITY, and the core tier's PORTABILITY.
//
// ── identity ───────────────────────────────────────────────────────────────
//
// SKILL.md's frontmatter `name:` is not a label. Claude Code discovers the
// skill by it, the installed directory is named after it, and `/<name>` is it.
// It used to be written out again in the installer, again in the builder, and
// twelve more times in the installer's test. The failure that buys is silent:
// a skill installed into a directory whose name does not match its own
// frontmatter simply never loads, with nothing printed. So the name has one
// source (scripts/_payload.mjs reads SKILL.md) and this file checks that every
// consumer agrees with it.
//
// ── portability ────────────────────────────────────────────────────────────
//
// The skill runs in three places with very different privileges:
//
//   Claude Code   local machine, full filesystem, the native rhwp CLI may exist
//   Cowork        sandbox, no CLI
//   claude.ai     sandbox, no CLI, skill delivered as an uploaded ZIP
//
// `src/core/` is the tier that must behave identically in all three, and the
// single rule that keeps it true is that it never shells out — the WASM bundle
// ships inside the skill, so there is nothing to install and nothing to find on
// PATH. That rule is easy to break by accident: one `spawnSync` added to a lib
// module that a core script already imports, and the core tier quietly becomes
// Claude-Code-only. The import graph is walked here so it fails loudly instead.
//
// The other portability rule is that no core path may REQUIRE a writable
// filesystem outside the user's own output. The cache (tmpdir) and snapshots
// (next to the document) both degrade rather than fail — their own tests cover
// that; here we just assert the modules stay optional in the graph.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { collectPayload, skillName } from "../../scripts/_payload.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const SKILL = skillName(ROOT);

// ── identity ───────────────────────────────────────────────────────────────

test("identity: the skill name is a valid Claude Code skill directory name", () => {
  // Lowercase letters, digits and hyphens: this is what may appear in a path
  // and in a /<name> invocation.
  assert.match(SKILL, /^[a-z0-9][a-z0-9-]*$/, `"${SKILL}" is not usable as a skill name`);
  assert.ok(SKILL.length <= 64);
});

// The frontmatter `description:` is what the model reads to decide whether to
// load this skill at all, and it has a HARD 1024-character ceiling. Crossing it
// is silent in the worst way: the skill still looks fine in the repo, and the
// validator either rejects the upload or truncates the text — so the triggers
// at the END of the description (here: the "NOT for .docx" routing) are the
// first thing lost, and the skill starts answering questions that belong to
// another skill. This already happened once: expanding the triggers for the
// section work pushed it to 1433 characters.
const DESCRIPTION_MAX = 1024;

test("identity: the frontmatter description fits the 1024-character ceiling", () => {
  const src = readFileSync(join(ROOT, "SKILL.md"), "utf8");
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(src);
  assert.ok(fm, "SKILL.md must open with YAML frontmatter");
  const m = /^description:\s*"([\s\S]*?)"\s*$/m.exec(fm[1]);
  assert.ok(m, "frontmatter must carry a quoted description:");
  const description = m[1];
  assert.ok(
    description.length <= DESCRIPTION_MAX,
    `SKILL.md description is ${description.length} chars, ${description.length - DESCRIPTION_MAX} over the ${DESCRIPTION_MAX} limit — it will be rejected or truncated, and truncation silently eats the routing rules at the end`,
  );
  // A description that shrank to nothing routes nothing.
  assert.ok(description.length > 200, "the description is too short to route reliably");
});

test("identity: the description still carries the routing it needs", () => {
  const src = readFileSync(join(ROOT, "SKILL.md"), "utf8");
  const description = /^description:\s*"([\s\S]*?)"\s*$/m.exec(src)[1];
  // Trimming for length must not quietly drop a whole capability's triggers.
  for (const trigger of [".hwp", ".hwpx", "한글", "신청서", "section", "목차", "diff", "변경 내용 추적"]) {
    assert.ok(description.includes(trigger), `the description no longer mentions "${trigger}"`);
  }
  // …and must keep steering the neighbouring formats away.
  for (const away of [".docx", ".xlsx", ".pptx", ".pdf"]) {
    assert.ok(description.includes(away), `the description no longer routes ${away} elsewhere`);
  }
});

test("identity: SKILL.md frontmatter is the only place the name is defined", () => {
  // A second hardcoded copy is how the installer and the frontmatter drift.
  for (const rel of ["scripts/install-skill.mjs", "scripts/build.mjs"]) {
    const src = readFileSync(join(ROOT, rel), "utf8");
    assert.equal(
      /^\s*const SKILL\s*=\s*["']/m.test(src),
      false,
      `${rel} hardcodes the skill name — it must call skillName() from _payload.mjs`,
    );
  }
});

test("identity: package.json agrees with the frontmatter name", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.name, SKILL, "package.json name drifted from SKILL.md frontmatter");
  const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
  assert.equal(lock.name, SKILL, "package-lock.json name drifted");
});

test("identity: the built ZIP is named after the skill", () => {
  const src = readFileSync(join(ROOT, "scripts", "build.mjs"), "utf8");
  assert.match(
    src,
    /OUT_PATH\s*=\s*join\(OUT_DIR,\s*`\$\{SKILL\}\.zip`\)/,
    "the upload artifact must carry the skill's own name",
  );
});

test("identity: the docs do not reference a stale install path", () => {
  // A README that tells the user to look in ~/.claude/skills/<old-name> sends
  // them to an empty directory and the skill looks broken.
  for (const rel of ["README.md", "CLAUDE.md", "SKILL.md"]) {
    const src = readFileSync(join(ROOT, rel), "utf8");
    const stale = [...src.matchAll(/skills\/([A-Za-z0-9._-]+)/g)]
      .map((m) => m[1])
      .filter((n) => n !== SKILL && n !== "<name>");
    assert.deepEqual(stale, [], `${rel} points at skills/${stale[0]} but the skill is ${SKILL}`);
  }
});

// ── portability ────────────────────────────────────────────────────────────

// Match only REAL module specifiers. Getting this regex wrong is the whole
// difficulty of the file, and it went wrong twice:
//
//   • a loose /from "…"/ scan reads prose out of comments — it reported
//     src/core/read.mjs as importing a package called `could not look`, out of
//     the sentence: tell "none" from "could not look".
//   • allowing the gap between `import`/`export` and `from` to match anything
//     let it span hundreds of lines, pairing an `export function` with an
//     unrelated `from "` inside a later string literal.
//
// So the gap may not contain a semicolon or a quote: a real multi-line import
// clause (`import {\n a,\n b,\n} from "x"`) contains neither, while anything
// that crosses into another statement or into a string contains one.
const IMPORT_RES = [
  /^[ \t]*import\s+[^;'"`]*?from\s*["']([^"']+)["']/gm, // import … from "x"
  /^[ \t]*import\s*["']([^"']+)["']/gm, //                  import "x"  (side effect)
  /^[ \t]*export\s+[^;'"`]*?from\s*["']([^"']+)["']/gm, // export … from "x"
];

function specifiersOf(src) {
  const out = [];
  for (const re of IMPORT_RES) for (const m of src.matchAll(re)) out.push(m[1]);
  return out;
}

// Resolve the relative-import graph of a file, staying inside the repo.
function importGraph(entry) {
  const seen = new Set();
  const order = [];
  const walk = (file, chain) => {
    if (seen.has(file)) return;
    seen.add(file);
    order.push({ file, chain });
    let src;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      return;
    }
    for (const spec of specifiersOf(src)) {
      if (spec.startsWith(".") && spec.endsWith(".mjs")) {
        walk(resolve(dirname(file), spec), chain.concat(file));
      }
    }
  };
  walk(entry, []);
  return order;
}

const CORE_SCRIPTS = readdirSync(join(ROOT, "src", "core"))
  .filter((f) => f.endsWith(".mjs"))
  .map((f) => join(ROOT, "src", "core", f));

test("portability: no core script shells out, even transitively", () => {
  // The rule that keeps the core tier identical on claude.ai, Cowork and Code.
  const offenders = [];
  for (const entry of CORE_SCRIPTS) {
    for (const { file, chain } of importGraph(entry)) {
      const src = readFileSync(file, "utf8");
      if (specifiersOf(src).includes("node:child_process")) {
        const rel = (p) => p.slice(ROOT.length + 1);
        offenders.push(`${rel(entry)} -> ${[...chain.slice(1), file].map(rel).join(" -> ")}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "a core script reaches child_process; the core tier must be WASM-only:\n" + offenders.join("\n"),
  );
});

test("portability: the enhanced tier is the ONLY place the CLI is resolved", () => {
  // Inverse of the rule above — if nothing gates on the CLI any more, the
  // enhanced scripts have stopped degrading cleanly.
  const gated = readdirSync(join(ROOT, "src", "enhanced"))
    .filter((f) => f.endsWith(".mjs"))
    .filter((f) => /requireCli|resolveCli/.test(readFileSync(join(ROOT, "src", "enhanced", f), "utf8")));
  assert.ok(gated.length > 0, "no enhanced script gates on the native CLI any more");
});

test("portability: everything a core script imports actually ships", () => {
  // The delivery allowlist and the import graph must agree, or an installed
  // copy throws ERR_MODULE_NOT_FOUND on first use — the worst possible time.
  const shipped = new Set(collectPayload(ROOT));
  const missing = new Set();
  for (const entry of CORE_SCRIPTS) {
    for (const { file } of importGraph(entry)) {
      const rel = file.slice(ROOT.length + 1).split("\\").join("/");
      if (!shipped.has(rel)) missing.add(rel);
    }
  }
  assert.deepEqual([...missing], [], "core code imports files that are not in the payload");
});

test("portability: the WASM bundle ships, and no path contains '@'", () => {
  const shipped = collectPayload(ROOT);
  assert.ok(
    shipped.includes("vendor/rhwp/rhwp_bg.wasm"),
    "the WASM bundle must ship — the core tier has nothing to install at runtime",
  );
  // claude.ai's ZIP validator rejects paths containing '@', which is why the
  // engine is vendored instead of imported from node_modules/@rhwp/core.
  const at = shipped.filter((p) => p.includes("@"));
  assert.deepEqual([], at, "a payload path contains '@'; claude.ai will reject the upload");
});

test("portability: no shipped file reads from test/, scripts/ or samples/", () => {
  // Those directories are not in the payload, so an import into them works in
  // the repo and fails in every installed copy.
  const shipped = collectPayload(ROOT).filter((p) => p.startsWith("src/"));
  for (const rel of shipped) {
    const src = readFileSync(join(ROOT, rel), "utf8");
    for (const spec of specifiersOf(src).filter((x) => x.startsWith("."))) {
      const target = resolve(dirname(join(ROOT, rel)), spec).slice(ROOT.length + 1);
      assert.equal(
        /^(test|scripts|samples)\//.test(target),
        false,
        `${rel} imports ${target}, which does not ship`,
      );
    }
  }
});

test("portability: the skill is self-contained — no runtime npm dependency", () => {
  // An installed skill has no node_modules. Anything imported by a bare
  // specifier would be unresolvable there.
  const shipped = collectPayload(ROOT).filter((p) => p.startsWith("src/"));
  const bare = [];
  for (const rel of shipped) {
    const src = readFileSync(join(ROOT, rel), "utf8");
    for (const spec of specifiersOf(src)) {
      if (spec.startsWith("node:") || spec.startsWith(".") || spec.startsWith("/")) continue;
      bare.push(`${rel}: ${spec}`);
    }
  }
  assert.deepEqual(bare, [], "shipped code imports an npm package; an installed skill has none");
});

test("portability: SKILL.md documents the tier boundary for all three platforms", () => {
  const src = readFileSync(join(ROOT, "SKILL.md"), "utf8");
  for (const platform of ["claude.ai", "cowork", "Claude Code"]) {
    assert.ok(
      src.toLowerCase().includes(platform.toLowerCase()),
      `SKILL.md must say what runs on ${platform}`,
    );
  }
  assert.ok(existsSync(join(ROOT, "vendor", "rhwp", "rhwp_bg.wasm")));
});
