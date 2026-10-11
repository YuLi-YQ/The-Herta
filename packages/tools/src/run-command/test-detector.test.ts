import { describe, expect, it } from "vitest";
import { detectTestRun, isTestCommand } from "./test-detector.js";

describe("isTestCommand", () => {
  it("detects pnpm test", () => {
    expect(isTestCommand(["pnpm", "test"])).toBe(true);
  });

  // ── widened 2026-08-13 ────────────────────────────────────────────────
  // Everything below returned FALSE before the widening, so a green suite
  // left report.tests empty and Herta had no test evidence to cite. Found by
  // the ADR 0025 lab, whose planted project runs `node --test`.
  it("detects node's built-in runner", () => {
    expect(isTestCommand(["node", "--test"])).toBe(true);
    expect(isTestCommand(["node", "--test", "test/"])).toBe(true);
    expect(
      isTestCommand(["node", "--experimental-strip-types", "--test"]),
    ).toBe(true);
  });

  it("does NOT treat a plain node script as a test, even a test-ish name", () => {
    // `node <file>` is "run a script". Trusting the filename would log
    // `node test-server.mjs` as a passing suite — a fabricated green.
    expect(isTestCommand(["node", "test.mjs"])).toBe(false);
    expect(isTestCommand(["node", "test-server.mjs"])).toBe(false);
    // …and a script that takes its own --test flag is still not a test run.
    expect(isTestCommand(["node", "server.mjs", "--test"])).toBe(false);
  });

  it("detects the common JS runners, bare or wrapped", () => {
    expect(isTestCommand(["vitest", "run"])).toBe(true);
    expect(isTestCommand(["jest"])).toBe(true);
    expect(isTestCommand(["mocha", "spec/"])).toBe(true);
    expect(isTestCommand(["npx", "vitest", "run"])).toBe(true);
    expect(isTestCommand(["pnpm", "exec", "jest"])).toBe(true);
    expect(isTestCommand(["bunx", "ava"])).toBe(true);
  });

  it("detects a runner behind a path or a Windows shim", () => {
    expect(isTestCommand(["./node_modules/.bin/vitest", "run"])).toBe(true);
    expect(isTestCommand(["jest.cmd"])).toBe(true);
  });

  it("detects the pm direct-binary form (pnpm/yarn/bun fall through to exec)", () => {
    // Found in the post-ship re-check: `pnpm vitest run` was undetected —
    // the exact form a model most plausibly emits in a pnpm repo.
    expect(isTestCommand(["pnpm", "vitest", "run"])).toBe(true);
    expect(isTestCommand(["yarn", "jest"])).toBe(true);
    expect(isTestCommand(["bun", "vitest"])).toBe(true);
    // npm does NOT fall through to exec — `npm vitest` never runs tests, and
    // detecting it would record a failed suite for a command that ran nothing.
    expect(isTestCommand(["npm", "vitest"])).toBe(false);
  });

  it("normalizes argv[0] shims and paths for wrappers and toolchains too", () => {
    expect(isTestCommand(["npx.cmd", "vitest"])).toBe(true);
    expect(isTestCommand(["node.exe", "--test"])).toBe(true);
    expect(isTestCommand(["/usr/bin/python3", "-m", "pytest"])).toBe(true);
  });

  it("detects yarn / bun / deno test", () => {
    expect(isTestCommand(["yarn", "test"])).toBe(true);
    expect(isTestCommand(["bun", "test"])).toBe(true);
    expect(isTestCommand(["deno", "test"])).toBe(true);
  });

  it("detects the test:unit script convention", () => {
    expect(isTestCommand(["pnpm", "test:unit"])).toBe(true);
    expect(isTestCommand(["npm", "run", "test:e2e"])).toBe(true);
  });

  it("detects other toolchains' test subcommands", () => {
    expect(isTestCommand(["dotnet", "test"])).toBe(true);
    expect(isTestCommand(["mvn", "test"])).toBe(true);
    expect(isTestCommand(["gradle", "test"])).toBe(true);
    expect(isTestCommand(["cargo", "nextest", "run"])).toBe(true);
    expect(isTestCommand(["python", "-m", "pytest"])).toBe(true);
    expect(isTestCommand(["python3", "-m", "unittest"])).toBe(true);
  });

  it("still refuses non-test work that the widening could have swept in", () => {
    expect(isTestCommand(["npx", "eslint", "."])).toBe(false);
    expect(isTestCommand(["pnpm", "exec", "tsc"])).toBe(false);
    expect(isTestCommand(["yarn", "build"])).toBe(false);
    expect(isTestCommand(["bun", "run", "dev"])).toBe(false);
    expect(isTestCommand(["deno", "run", "main.ts"])).toBe(false);
    expect(isTestCommand(["dotnet", "build"])).toBe(false);
    expect(isTestCommand(["python", "-m", "http.server"])).toBe(false);
    expect(isTestCommand(["python", "manage.py", "test"])).toBe(false);
  });

  it("detects npm test", () => {
    expect(isTestCommand(["npm", "test"])).toBe(true);
  });

  it("detects pnpm run test", () => {
    expect(isTestCommand(["pnpm", "run", "test"])).toBe(true);
  });

  it("detects npm run test", () => {
    expect(isTestCommand(["npm", "run", "test"])).toBe(true);
  });

  it("detects pytest with no args", () => {
    expect(isTestCommand(["pytest"])).toBe(true);
  });

  it("detects pytest with args", () => {
    expect(isTestCommand(["pytest", "-x", "tests/foo.py"])).toBe(true);
  });

  it("detects cargo test", () => {
    expect(isTestCommand(["cargo", "test"])).toBe(true);
  });

  it("detects cargo test with flags", () => {
    expect(isTestCommand(["cargo", "test", "--release"])).toBe(true);
  });

  it("detects go test", () => {
    expect(isTestCommand(["go", "test", "./..."])).toBe(true);
  });

  it("rejects pnpm run lint", () => {
    expect(isTestCommand(["pnpm", "run", "lint"])).toBe(false);
  });

  it("rejects pnpm install", () => {
    expect(isTestCommand(["pnpm", "install"])).toBe(false);
  });

  it("rejects cargo build", () => {
    expect(isTestCommand(["cargo", "build"])).toBe(false);
  });

  it("rejects cargo check", () => {
    expect(isTestCommand(["cargo", "check"])).toBe(false);
  });

  it("rejects go build", () => {
    expect(isTestCommand(["go", "build"])).toBe(false);
  });

  it("rejects empty argv", () => {
    expect(isTestCommand([])).toBe(false);
  });

  it("rejects unrelated commands", () => {
    expect(isTestCommand(["echo", "hi"])).toBe(false);
    expect(isTestCommand(["git", "status"])).toBe(false);
  });
});

describe("detectTestRun", () => {
  it("returns passed for exit 0 on a test command", () => {
    const result = detectTestRun({
      argv: ["pnpm", "test"],
      exitCode: 0,
      durationMs: 1230,
      timedOut: false,
    });
    expect(result).not.toBeNull();
    expect(result?.command).toBe("pnpm test");
    expect(result?.status).toBe("passed");
    expect(result?.summary).toBe("exit 0, 1.23s");
  });

  it("returns failed for non-zero exit", () => {
    const result = detectTestRun({
      argv: ["pytest"],
      exitCode: 1,
      durationMs: 850,
      timedOut: false,
    });
    expect(result?.status).toBe("failed");
    expect(result?.summary).toBe("exit 1, 0.85s");
  });

  it("returns failed for null exit code (signal)", () => {
    const result = detectTestRun({
      argv: ["cargo", "test"],
      exitCode: null,
      durationMs: 500,
      timedOut: false,
    });
    expect(result?.status).toBe("failed");
    expect(result?.summary).toBe("exit null, 0.50s");
  });

  it("returns failed for timed-out runs", () => {
    const result = detectTestRun({
      argv: ["go", "test", "./..."],
      exitCode: null,
      durationMs: 120000,
      timedOut: true,
    });
    expect(result?.status).toBe("failed");
    expect(result?.summary).toBe("timed out, 120.00s");
    expect(result?.command).toBe("go test ./...");
  });

  it("returns null for non-test commands", () => {
    expect(
      detectTestRun({
        argv: ["echo", "hi"],
        exitCode: 0,
        durationMs: 5,
        timedOut: false,
      }),
    ).toBeNull();
  });

  it("returns null for empty argv", () => {
    expect(
      detectTestRun({
        argv: [],
        exitCode: 0,
        durationMs: 0,
        timedOut: false,
      }),
    ).toBeNull();
  });
});
