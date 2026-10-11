import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentEvent,
  BackendContextBuilder,
  CodingAgentRuntime,
  type HertaToAgentBrief,
  InMemoryEventBus,
  InMemoryToolRegistry,
  NoopMemoryManager,
  NoopPermissionEngine,
  type ProviderAdapter,
} from "@herta/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deepseekProvider } from "./index.js";

/**
 * Provider e2e: drives `CodingAgentRuntime.runBrief` with a real
 * `deepseekProvider` (over a fake fetch). The earlier version of this
 * file ran turns through the deterministic V1 actor wrapper; with V1
 * deleted, the actor added no signal — these assertions are about the
 * provider's SSE parsing producing the right `AgentEvent` shape — so we
 * drive the backend runtime directly.
 */

interface RuntimeHarness {
  runtime: CodingAgentRuntime;
  bus: InMemoryEventBus<AgentEvent>;
  tools: InMemoryToolRegistry;
}

const sampleBrief: HertaToAgentBrief = { taskId: "providers-e2e-1" };
const sampleUserMessages = [{ text: "hi" }];

// runBrief idempotently mkdir's workspaceRoot, so use a real tmp dir — a
// hardcoded "/repo" is EACCES on the Linux CI runner (non-root). Set per-test.
let wsRoot: string;

function mkRuntime(opts: { provider: ProviderAdapter }): RuntimeHarness {
  const tools = new InMemoryToolRegistry();
  const bus = new InMemoryEventBus<AgentEvent>();
  const backendBuilder = new BackendContextBuilder({ tools });
  const runtime = new CodingAgentRuntime({
    sessionId: "test",
    provider: opts.provider,
    tools,
    permissions: new NoopPermissionEngine(),
    backendBuilder,
    bus,
    clock: () => new Date("2026-05-08T00:00:00.000Z"),
    workspaceRoot: wsRoot,
    memory: new NoopMemoryManager(),
  });
  return { runtime, bus, tools };
}

describe("deepseekProvider end-to-end with CodingAgentRuntime", () => {
  beforeEach(() => {
    wsRoot = mkdtempSync(join(tmpdir(), "providers-e2e-ws-"));
  });
  afterEach(() => {
    rmSync(wsRoot, { recursive: true, force: true });
  });

  it("produces AgentEvent shape matching FakeProvider for a plain reply", async () => {
    const sse =
      `data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}\n\n` +
      `data: {"choices":[{"index":0,"delta":{"content":"Hello"}}]}\n\n` +
      `data: {"choices":[{"index":0,"delta":{"content":", world"}}]}\n\n` +
      `data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n` +
      `data: [DONE]\n\n`;

    const provider = deepseekProvider({
      apiKey: "sk-test",
      fetchImpl: async () =>
        new Response(sse, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    });

    const { runtime, bus } = mkRuntime({ provider });
    const types: AgentEvent["type"][] = [];
    let assistantText = "";
    bus.onAny((ev) => {
      types.push(ev.type);
      if (ev.type === "assistant.delta") assistantText += ev.text;
      if (ev.type === "assistant.final") {
        expect(ev.message.text).toBe("Hello, world");
      }
    });
    await runtime.runBrief(sampleBrief, { userMessages: sampleUserMessages });
    expect(types).toEqual([
      "turn.started",
      "assistant.delta",
      "assistant.delta",
      "assistant.final",
      "turn.finished",
    ]);
    expect(assistantText).toBe("Hello, world");
  });

  it("propagates HTTP 401 as turn.failed{kind:'provider_failed'}", async () => {
    const provider = deepseekProvider({
      apiKey: "sk-bad",
      fetchImpl: async () =>
        new Response('{"error":{"message":"bad key"}}', {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    });
    const { runtime, bus } = mkRuntime({ provider });
    const events: AgentEvent[] = [];
    bus.onAny((ev) => events.push(ev));
    await runtime.runBrief(sampleBrief, { userMessages: sampleUserMessages });
    const failed = events.find((e) => e.type === "turn.failed");
    expect(failed).toBeDefined();
    if (failed?.type === "turn.failed") {
      expect(failed.error.kind).toBe("provider_failed");
    }
  });
});
