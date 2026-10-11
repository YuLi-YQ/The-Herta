import { setTimeout as delay } from "node:timers/promises";
import { BackgroundHost } from "@herta/core";
import { describe, expect, it } from "vitest";
import { mkTmpWorkspace, type TmpWorkspace } from "../testing/tmp-workspace.js";
import { mkToolContext } from "../testing/tool-context.js";
import { commandOutputTool, commandStopTool } from "./background-tools.js";
import { runCommandTool } from "./index.js";

const noop = (): void => {};

async function pollForOutput(
  ctx: ReturnType<typeof mkToolContext>,
  bgId: string,
  needle: string,
  tries = 40,
): Promise<{ text: string; nextByte: number; running: boolean }> {
  let cursor = 0;
  let text = "";
  let running = true;
  for (let i = 0; i < tries; i += 1) {
    const r = await commandOutputTool().run(
      {
        id: `o${i}`,
        tool: "command_output",
        input: { backgroundId: bgId, sinceByte: cursor },
      },
      ctx,
      noop,
    );
    const data = r.data as {
      stdout: string;
      nextByte: number;
      running: boolean;
    };
    text += data.stdout;
    cursor = data.nextByte;
    running = data.running;
    if (text.includes(needle)) break;
    await delay(50);
  }
  return { text, nextByte: cursor, running };
}

describe("managed background commands (ADR 0025 slice 4)", () => {
  let ws: TmpWorkspace;

  it("start → poll output → stop; output/stop after stop reflect state", async () => {
    ws = await mkTmpWorkspace({});
    const bg = new BackgroundHost();
    const ctx = mkToolContext({ workspaceRoot: ws.root, bg });
    try {
      // A tiny long-lived process that prints a marker then idles.
      const start = await runCommandTool().run(
        {
          id: "s1",
          tool: "run_command",
          input: {
            argv: [
              process.execPath,
              "-e",
              "console.log('READY'); setInterval(()=>{}, 1000);",
            ],
            runInBackground: true,
          },
        },
        ctx,
        noop,
      );
      expect(start.ok).toBe(true);
      const bgId = (start.data as { backgroundId?: string }).backgroundId;
      expect(bgId).toBeDefined();
      expect((start.data as { running?: boolean }).running).toBe(true);
      expect(bg.list()).toHaveLength(1);
      if (bgId === undefined) return;

      const polled = await pollForOutput(ctx, bgId, "READY");
      expect(polled.text).toContain("READY");
      expect(polled.running).toBe(true);

      // sinceByte cursor: a read from the tail returns nothing new.
      const tailRead = await commandOutputTool().run(
        {
          id: "o-tail",
          tool: "command_output",
          input: { backgroundId: bgId, sinceByte: polled.nextByte },
        },
        ctx,
        noop,
      );
      expect((tailRead.data as { stdout: string }).stdout).toBe("");

      // Stop it.
      const stop = await commandStopTool().run(
        { id: "k1", tool: "command_stop", input: { backgroundId: bgId } },
        ctx,
        noop,
      );
      expect(stop.ok).toBe(true);
      expect(bg.get(bgId)?.isRunning()).toBe(false);

      // Stopping again is idempotent (already exited).
      const stopAgain = await commandStopTool().run(
        { id: "k2", tool: "command_stop", input: { backgroundId: bgId } },
        ctx,
        noop,
      );
      expect(stopAgain.ok).toBe(true);
      expect(stopAgain.summary).toContain("already exited");

      // Output now reports exited.
      const after = await commandOutputTool().run(
        {
          id: "o-after",
          tool: "command_output",
          input: { backgroundId: bgId },
        },
        ctx,
        noop,
      );
      expect((after.data as { running: boolean }).running).toBe(false);
    } finally {
      await bg.stopAll();
      await ws.cleanup();
    }
  });

  it("command_output / command_stop on an unknown id return not_found", async () => {
    ws = await mkTmpWorkspace({});
    const ctx = mkToolContext({ workspaceRoot: ws.root });
    try {
      const o = await commandOutputTool().run(
        { id: "o", tool: "command_output", input: { backgroundId: "bg-99" } },
        ctx,
        noop,
      );
      expect(o.ok).toBe(false);
      expect(o.error?.code).toBe("not_found");
      const s = await commandStopTool().run(
        { id: "s", tool: "command_stop", input: { backgroundId: "bg-99" } },
        ctx,
        noop,
      );
      expect(s.ok).toBe(false);
      expect(s.error?.code).toBe("not_found");
    } finally {
      await ws.cleanup();
    }
  });

  it("rejects an escalation-prone env key before spawning", async () => {
    ws = await mkTmpWorkspace({});
    const ctx = mkToolContext({ workspaceRoot: ws.root });
    try {
      const r = await runCommandTool().run(
        {
          id: "e1",
          tool: "run_command",
          input: {
            argv: [process.execPath, "-e", "0"],
            env: { NODE_OPTIONS: "--require ./evil.js" },
          },
        },
        ctx,
        noop,
      );
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe("env_key_denied");
    } finally {
      await ws.cleanup();
    }
  });
});
