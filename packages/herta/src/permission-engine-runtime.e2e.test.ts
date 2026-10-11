import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentEvent,
  type AskResolver,
  BackendContextBuilder,
  CodingAgentRuntime,
  type HertaToAgentBrief,
  type HertaTool,
  InMemoryEventBus,
  InMemoryToolRegistry,
  NoopMemoryManager,
  RulePermissionEngine,
  type RuleVerdict,
} from "@herta/core";
import { FakeAskResolver, FakeProvider } from "@herta/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Permission-engine integration test. Drives `CodingAgentRuntime.runBrief`
 * directly with a synthesized brief — the test is about the rule-engine /
 * tool-loop integration, not the actor wrapper. The earlier version of
 * this test ran through the deterministic V1 actor; with V1 deleted the
 * actor wrapper added no signal here, so we drive the backend directly.
 */

const sampleBrief: HertaToAgentBrief = { taskId: "perm-e2e-1" };
const sampleUserMessages = [{ text: "write x.txt" }];

function fakeTool(name: string): HertaTool {
  return {
    name,
    schema: () => ({ name, description: "", inputSchema: {} }),
    run: async () => ({ ok: true, data: { wrote: true }, summary: "wrote" }),
  };
}

describe("RulePermissionEngine — runtime e2e", () => {
  // runBrief idempotently mkdir's workspaceRoot, so use a real tmp dir — a
  // hardcoded "/repo" is EACCES on the Linux CI runner (non-root).
  let wsRoot: string;
  beforeEach(() => {
    wsRoot = mkdtempSync(join(tmpdir(), "perm-e2e-ws-"));
  });
  afterEach(() => {
    rmSync(wsRoot, { recursive: true, force: true });
  });

  it("an ask-rule allowed by the user runs the tool and produces ok:true", async () => {
    const ask: AskResolver = new FakeAskResolver();
    const permissions = new RulePermissionEngine({ ask });
    permissions.registerRule(
      "writeable",
      (): RuleVerdict => ({
        kind: "ask",
        reason: "writes a file",
        risk: "workspace_write",
      }),
    );

    const tools = new InMemoryToolRegistry();
    tools.register(fakeTool("writeable"));

    const provider = new FakeProvider({
      turns: [
        [
          { type: "text-delta", text: "let me ask " },
          {
            type: "tool-call-request",
            call: { id: "c1", tool: "writeable", input: { path: "x.txt" } },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text-delta", text: "done" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });

    const bus = new InMemoryEventBus<AgentEvent>();
    const runtime = new CodingAgentRuntime({
      sessionId: "test",
      provider,
      tools,
      permissions,
      backendBuilder: new BackendContextBuilder({ tools }),
      bus,
      clock: () => new Date("2026-05-08T00:00:00.000Z"),
      workspaceRoot: wsRoot,
      memory: new NoopMemoryManager(),
    });

    const events: AgentEvent[] = [];
    bus.onAny((ev) => {
      events.push(ev);
      if (ev.type === "permission.requested") {
        (ask as FakeAskResolver).allow();
      }
    });

    await runtime.runBrief(sampleBrief, { userMessages: sampleUserMessages });

    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining([
        "turn.started",
        "permission.requested",
        "permission.resolved",
        "tool.call.started",
        "tool.call.finished",
        "turn.finished",
      ]),
    );

    const finished = events.find((e) => e.type === "tool.call.finished");
    expect(finished).toBeDefined();
    if (finished?.type !== "tool.call.finished") throw new Error();
    expect(finished.result.ok).toBe(true);
  });
});
