import type { TestRunSummary } from "@herta/core";

/**
 * Test-runner binaries that are unambiguous on their own, bare or behind a
 * runner wrapper (`npx vitest`, `pnpm exec jest`). Membership is the whole
 * test — a name here means "this program runs tests and nothing else".
 */
const RUNNER_BINARIES: ReadonlySet<string> = new Set([
  "vitest",
  "jest",
  "mocha",
  "ava",
  "jasmine",
  "pytest",
  "py.test",
  "rspec",
  "phpunit",
]);

/** Wrappers that execute a binary named in the NEXT argument. */
const EXEC_WRAPPERS: ReadonlySet<string> = new Set(["npx", "pnpx", "bunx"]);

/** Package managers whose `<pm> test` / `<pm> run test` runs the test script. */
const PACKAGE_MANAGERS: ReadonlySet<string> = new Set([
  "npm",
  "pnpm",
  "yarn",
  "bun",
]);

/** `test`, and the `test:unit` / `test:e2e` script convention. */
function isTestScriptName(name: string | undefined): boolean {
  return name !== undefined && (name === "test" || name.startsWith("test:"));
}

/**
 * Returns true if the argv matches a recognized test runner pattern.
 *
 * Deliberately excludes lint, build, install, and check commands: this
 * decides whether a command produced TEST EVIDENCE, and mislabelling a build
 * as a test would let a green build be narrated as a green test suite.
 *
 * Detection stays purely structural — argv shape only, never file names. An
 * earlier temptation was to treat `node test.mjs` as a test because a lab
 * used it, but `node <file>` is just "run a script", and `node test-server.mjs`
 * would then be logged as a passing test suite. A missed test is recoverable
 * (the model can state the command it ran); a fabricated one is not.
 *
 * Widened 2026-08-13. The previous list was pytest / cargo test / go test /
 * npm|pnpm test, which missed `node --test`, `vitest`, `jest`, `mocha`,
 * `bun test`, `deno test` and `yarn test` — so a passing suite left
 * `report.tests` empty and Herta had no evidence she was allowed to cite.
 * The gap was found by running the ADR 0025 lab, whose own planted project
 * uses `node --test`; this repo escaped it only because `pnpm test` wraps
 * vitest.
 *
 * NOTE: evidence only. Permission tiering is `classifier.ts`, which this must
 * never be wired into — widening what counts as a test must not widen what
 * runs without approval.
 */
export function isTestCommand(argv: readonly string[]): boolean {
  if (argv.length === 0) return false;
  const raw0 = argv[0];
  if (raw0 === undefined) return false;
  // Normalize argv[0] the way isRunnerBinary does — a path-qualified or
  // .cmd-shimmed program (`C:\...\node.exe`, `npx.cmd`) is the same program.
  const a0 = normalizeBinary(raw0);

  // `npx vitest`, `bunx jest`, `pnpm exec mocha`, `yarn dlx ava`
  if (EXEC_WRAPPERS.has(a0)) return isRunnerBinary(argv[1]);
  if (
    (a0 === "pnpm" || a0 === "npm" || a0 === "yarn") &&
    (argv[1] === "exec" || argv[1] === "dlx")
  ) {
    return isRunnerBinary(argv[2]);
  }
  // Direct-binary form: `pnpm vitest run`, `yarn jest`, `bun vitest` — these
  // three fall through to exec for an unknown script name. npm does NOT
  // (`npm vitest` is just an unknown-command error), and detecting it would
  // record a command that never ran tests as a failed suite.
  if (
    (a0 === "pnpm" || a0 === "yarn" || a0 === "bun") &&
    isRunnerBinary(argv[1])
  ) {
    return true;
  }

  if (isRunnerBinary(raw0)) return true;

  // Node's built-in runner. Only among LEADING flags, so a script that
  // happens to take a `--test` argument of its own is not misread.
  if (a0 === "node") {
    for (let i = 1; i < argv.length; i += 1) {
      const arg = argv[i];
      if (arg === undefined || !arg.startsWith("-")) break;
      if (arg === "--test") return true;
    }
    return false;
  }

  // `python -m pytest`, `python3 -m unittest`
  if (a0 === "python" || a0 === "python3" || a0 === "py") {
    if (argv[1] !== "-m") return false;
    const mod = argv[2];
    return mod === "pytest" || mod === "unittest";
  }

  // Toolchain subcommands that are literally named "test".
  if (a0 === "cargo") {
    if (argv[1] === "test") return true;
    return argv[1] === "nextest" && argv[2] === "run";
  }
  if (
    a0 === "go" ||
    a0 === "deno" ||
    a0 === "dotnet" ||
    a0 === "mvn" ||
    a0 === "gradle" ||
    a0 === "rake" ||
    a0 === "swift"
  ) {
    return argv[1] === "test";
  }

  // Package-manager script running. `bun test` is bun's own runner and is
  // covered by the same shape.
  if (PACKAGE_MANAGERS.has(a0)) {
    if (isTestScriptName(argv[1])) return true;
    if (argv[1] === "run" && isTestScriptName(argv[2])) return true;
  }
  return false;
}

/** Basename + Windows-shim suffix strip: a path-qualified or .cmd-shimmed
 *  program (`./node_modules/.bin/vitest`, `npx.cmd`, `node.exe`) is the same
 *  program. Evidence-only leniency — permission tiering never uses this. */
function normalizeBinary(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  return base.replace(/\.(cmd|exe|bat|ps1)$/, "");
}

function isRunnerBinary(name: string | undefined): boolean {
  if (name === undefined) return false;
  return RUNNER_BINARIES.has(normalizeBinary(name));
}

export interface TestRunInput {
  argv: readonly string[];
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
}

/**
 * Detects whether a run_command invocation was a test runner; if so,
 * returns a TestRunSummary derived from the exit code (exit 0 → passed,
 * else → failed). Returns null for non-test commands. The skipped /
 * not_run union members on TestRunSummary stay reachable for future
 * use cases (e.g., a planner that records "I planned tests but didn't
 * run them") but never fire on the run_command path.
 */
export function detectTestRun(input: TestRunInput): TestRunSummary | null {
  if (!isTestCommand(input.argv)) return null;
  const status: TestRunSummary["status"] =
    input.exitCode === 0 && !input.timedOut ? "passed" : "failed";
  const command = input.argv.join(" ");
  const summary = formatTestSummary(input);
  return { command, status, summary };
}

function formatTestSummary(input: TestRunInput): string {
  const sec = (input.durationMs / 1000).toFixed(2);
  const exitPart = input.timedOut
    ? "timed out"
    : `exit ${input.exitCode === null ? "null" : input.exitCode}`;
  return `${exitPart}, ${sec}s`;
}
