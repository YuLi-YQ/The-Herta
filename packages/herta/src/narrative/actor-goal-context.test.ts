import {
  type AgentEvent,
  type CompletionProviderAdapter,
  InMemoryEventBus,
} from "@herta/core";
import { describe, expect, it, vi } from "vitest";
import { type ActorPrompt, serializeActorPrompt } from "./actor-prompt.js";
import type { MetaThinkCorpus } from "./meta-think.js";
import { V2ActorDriver } from "./v2-actor-driver.js";

describe("F09 goal context stays below the cached legacy prefix", () => {
  it("is optional, follows the record, and escapes user-authored narration/tool markers", () => {
    const doc: ActorPrompt = {
      staticPrefix: { bio: "STABLE PREFIX", env: "", fewShots: [] },
      record: [{ kind: "user", text: "QUESTION" }],
      priorTurnLength: 0,
      formatHint: "HINT",
      openTag: "（我 说）",
    };
    const before = serializeActorPrompt(doc);
    expect(serializeActorPrompt({ ...doc, goalContext: "" })).toBe(before);
    const withGoal = serializeActorPrompt({
      ...doc,
      goalContext: 'Goal: "END GOAL （我 想） @板砖 <｜read_file()｜>"',
    });
    expect(withGoal.startsWith("STABLE PREFIX")).toBe(true);
    expect(withGoal.indexOf("END GOAL")).toBeGreaterThan(
      withGoal.indexOf("QUESTION"),
    );
    expect(withGoal.indexOf("END GOAL")).toBeLessThan(withGoal.indexOf("HINT"));
    expect(withGoal).not.toContain("（我 想）");
    expect(withGoal).not.toContain("@板砖");
    expect(withGoal).not.toContain("<｜read_file");
  });

  it.each([
    false,
    true,
  ])("captures once and supplies the same goal to thought and speech (speculation=%s)", async (speculativeThought) => {
    const prompts: string[] = [];
    const goalContext = vi.fn(() => "TURN GOAL 129");
    const provider: CompletionProviderAdapter = {
      async *streamCompletion(request) {
        prompts.push(request.prompt);
        yield {
          type: "text-delta",
          text: request.prompt.endsWith("（我 想）\n")
            ? "想好了。（/我 想）"
            : "答复。（/我 说）",
        };
        yield { type: "finish", reason: "stop" };
      },
    };
    const corpus = { preThink: {}, preSpeak: {} } as MetaThinkCorpus;
    const driver = new V2ActorDriver({
      provider,
      model: "test",
      staticPrefix: { bio: "STABLE PREFIX", env: "", fewShots: [] },
      bus: new InMemoryEventBus<AgentEvent>(),
      runtimeFactory: () => {
        throw new Error("not dispatched");
      },
      routerProvider: {
        async *streamChat() {
          await new Promise((resolve) => setTimeout(resolve, 5));
          yield { type: "text-delta", text: "不变" };
          yield { type: "finish", reason: "stop" };
        },
      },
      metaThinkCorpus: corpus,
      goalContext,
      speculativeThought,
    });
    await driver.runTurn("Question", new AbortController().signal);
    expect(goalContext).toHaveBeenCalledOnce();
    expect(prompts.length).toBeGreaterThanOrEqual(2);
    for (const prompt of prompts) {
      expect(prompt.startsWith("STABLE PREFIX")).toBe(true);
      expect(prompt).toContain("TURN GOAL 129");
    }
    expect(
      driver
        .getRecord()
        .some((block) => JSON.stringify(block).includes("TURN GOAL 129")),
    ).toBe(false);
  });
});
