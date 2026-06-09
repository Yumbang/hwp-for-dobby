// Unified exit-code taxonomy for every hwp-skill script.
//
// A single, documented contract so an agent (or a wrapping tool) can react
// to *why* a script failed, not just that it did. Every script imports EXIT
// and uses `fail()` instead of bare `process.exit(N)`.
//
//   0 OK           success
//   1 LOAD         input could not be loaded/parsed (corrupt or wrong format)
//   2 USAGE        bad arguments / unsupported output target (e.g. .hwpx out)
//   3 NOT_FOUND    requested target absent (query, field name, file path)
//   4 UNSUPPORTED  operation not available in this environment/engine
//                  (e.g. an `enhanced/` script needs the native CLI and it
//                   isn't installed → tell the agent to run on Claude Code)
//   5 CORRUPTION   engine-detected corruption OR round-trip verify failed
//                  (the edit didn't survive save→reload — see lib/verify.mjs)

export const EXIT = Object.freeze({
  OK: 0,
  LOAD: 1,
  USAGE: 2,
  NOT_FOUND: 3,
  UNSUPPORTED: 4,
  CORRUPTION: 5,
});

const NAME = Object.freeze({
  0: "OK",
  1: "LOAD",
  2: "USAGE",
  3: "NOT_FOUND",
  4: "UNSUPPORTED",
  5: "CORRUPTION",
});

// Print `message` to stderr (newline-terminated) and exit with `code`.
// Pass an EXIT.* constant. Never use a bare process.exit() in scripts.
export function fail(code, message) {
  if (message) {
    const m = String(message);
    process.stderr.write(m.endsWith("\n") ? m : m + "\n");
  }
  process.exit(code);
}

export function exitName(code) {
  return NAME[code] ?? String(code);
}
