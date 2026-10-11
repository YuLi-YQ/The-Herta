import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkTmpWorkspace, type TmpWorkspace } from "../testing/tmp-workspace.js";
import { mkToolContext } from "../testing/tool-context.js";
import { runCommandTool } from "./index.js";

/**
 * End-to-end proof for audit finding S1, driven through the REAL tool rather
 * than the guard function alone — the hole was that `env` never reached the
 * permission rule, so a unit test of the guard could pass while the tool
 * still spawned the child.
 *
 * The exploit (reproduced against the real git binary on 2026-08-05, before
 * the fix): `git diff` is unconditional ALLOW tier — rule.ts short-circuits
 * before any prompt — and
 *
 *     GIT_CONFIG_COUNT=1
 *     GIT_CONFIG_KEY_0=diff.external
 *     GIT_CONFIG_VALUE_0=<command>
 *
 * makes git execute <command> for each changed file. No approval card is
 * shown anywhere in that path.
 */
describe("run_command env guard — S1 escalation (end to end)", () => {
  let ws: TmpWorkspace;

  beforeEach(async () => {
    ws = await mkTmpWorkspace({});
  });
  afterEach(async () => {
    await ws.cleanup();
  });

  const ctx = () => mkToolContext({ workspaceRoot: ws.root });
  const noopProgress = () => {};
  /** run_command takes the full tool-call envelope, not a bare input. */
  const call = (input: unknown) => ({
    id: "c",
    tool: "run_command",
    input,
  });
  /** Asserts a failed result and hands back its error payload (which is
   *  optional on ToolResult, so narrowing on `ok` alone is not enough). */
  const errorOf = (res: {
    ok: boolean;
    error?: { code: string; message: string };
  }): { code: string; message: string } => {
    if (res.ok) throw new Error("expected a failed result");
    if (res.error === undefined) throw new Error("expected an error payload");
    return res.error;
  };

  it("refuses GIT_CONFIG_* on an allow-tier `git diff`, before spawning", async () => {
    const tool = runCommandTool();
    const marker = join(ws.root, "PWNED.txt");
    const payload = join(ws.root, "payload.sh");
    writeFileSync(payload, `#!/bin/sh\nprintf x > "${marker}"\n`, "utf8");

    const res = await tool.run(
      call({
        argv: ["git", "diff"],
        env: {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "diff.external",
          GIT_CONFIG_VALUE_0: `sh ${payload}`,
        },
      }),
      ctx(),
      noopProgress,
    );

    expect(res.ok).toBe(false);
    expect(errorOf(res).code).toBe("env_key_denied");
    expect(errorOf(res).message).toContain("GIT_CONFIG_COUNT");
    // The whole point: nothing was executed.
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses PYTHONPATH on an allow-tier `pytest`", async () => {
    const tool = runCommandTool();
    const res = await tool.run(
      call({ argv: ["pytest", "-x"], env: { PYTHONPATH: "/evil" } }),
      ctx(),
      noopProgress,
    );
    expect(res.ok).toBe(false);
    expect(errorOf(res).code).toBe("env_key_denied");
  });

  it("still lets the inert knobs the parameter exists for through the guard", async () => {
    const tool = runCommandTool();
    // Asserts the GUARD's verdict, not the run's outcome: whether a given
    // binary exists is platform-dependent (`echo` is a cmd builtin on
    // Windows, which is why most of index.test.ts is skipped there), and the
    // thing under test is that these keys are not refused.
    const res = await tool.run(
      call({ argv: ["git", "status"], env: { NODE_ENV: "test", CI: "1" } }),
      ctx(),
      noopProgress,
    );
    if (!res.ok) expect(errorOf(res).code).not.toBe("env_key_denied");
  });

  it("names the allowed set and the visible escape hatch in the refusal", async () => {
    // The model has to be able to act on this without guessing.
    const tool = runCommandTool();
    const res = await tool.run(
      call({ argv: ["echo", "hi"], env: { DATABASE_URL: "postgres://x" } }),
      ctx(),
      noopProgress,
    );
    expect(res.ok).toBe(false);
    expect(errorOf(res).message).toContain("NODE_ENV");
    expect(errorOf(res).message).toContain("sh -c");
  });
});
