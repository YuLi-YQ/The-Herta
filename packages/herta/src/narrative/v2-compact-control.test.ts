import {
  type AgentEvent,
  type CodingAgentRuntime,
  InMemoryEventBus,
} from "@herta/core";
import { afterEach, expect, it, vi } from "vitest";
import * as actorTurn from "./actor-turn.js";
import type { MetaThinkCorpus } from "./meta-think.js";
import * as recap from "./session-recap-runtime.js";
import { V2ActorDriver } from "./v2-actor-driver.js";

afterEach(() => vi.restoreAllMocks());
it("V2 consumes the desktop queue at the actual recap boundary and preserves the CLI's independent one-shot flag", async () => {
  const prepare = vi.spyOn(recap, "prepareTurnRecap");
  vi.spyOn(actorTurn, "runActorCompletionTurn").mockImplementation(
    async (state) => ({ record: state.record }),
  );
  let pending = true;
  const consume = vi.fn(() => {
    const was = pending;
    pending = false;
    return was;
  });
  const driver = new V2ActorDriver({
    provider: {
      async *streamCompletion() {
        yield { type: "finish", reason: "stop" };
      },
    },
    model: "synthetic",
    staticPrefix: { bio: "", env: "", fewShots: [] },
    bus: new InMemoryEventBus<AgentEvent>(),
    runtimeFactory: () => ({}) as CodingAgentRuntime,
    routerProvider: {
      async *streamChat() {
        yield { type: "text-delta", text: "不变" };
        yield { type: "finish", reason: "stop" };
      },
    },
    metaThinkCorpus: { preThink: {}, preSpeak: {} } as MetaThinkCorpus,
    speculativeThought: false,
    consumeCompactRequest: consume,
  });
  const signal = new AbortController().signal;
  await driver.runTurn("first", signal);
  await driver.runTurn("second", signal);
  driver.forceCompactNextTurn();
  await driver.runTurn("CLI force", signal);
  expect(prepare.mock.calls.map((call) => call[3])).toEqual([
    true,
    false,
    true,
  ]);
  expect(consume).toHaveBeenCalledTimes(3);
});
