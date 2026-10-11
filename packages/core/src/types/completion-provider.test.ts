import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  CompletionEvent,
  CompletionProviderAdapter,
  CompletionRequest,
} from "./completion-provider.js";

describe("CompletionRequest", () => {
  it("requires model, prompt, and stop[]; optional maxTokens and temperature", () => {
    const req: CompletionRequest = {
      model: "deepseek-v4-completion",
      prompt: "HertaBio\n...\n\n（我 说）",
      stop: ["（/我 说）", "｜>"],
    };
    expect(req.model).toBe("deepseek-v4-completion");
    expect(req.stop).toContain("（/我 说）");
    expect(req.stop).toContain("｜>");
  });

  it("accepts optional maxTokens and temperature", () => {
    const req: CompletionRequest = {
      model: "x",
      prompt: "y",
      stop: ["z"],
      maxTokens: 256,
      temperature: 0.7,
    };
    expect(req.maxTokens).toBe(256);
    expect(req.temperature).toBe(0.7);
  });
});

describe("CompletionEvent", () => {
  it("is a discriminated union of text-delta and finish", () => {
    const delta: CompletionEvent = { type: "text-delta", text: "你好" };
    const finish: CompletionEvent = { type: "finish", reason: "stop" };
    expect(delta.type).toBe("text-delta");
    expect(finish.type).toBe("finish");
  });

  it("finish reason narrows to stop | length | error", () => {
    expectTypeOf<
      Extract<CompletionEvent, { type: "finish" }>["reason"]
    >().toEqualTypeOf<"stop" | "length" | "error">();
  });
});

describe("CompletionProviderAdapter", () => {
  it("streamCompletion takes a request and a REQUIRED AbortSignal", () => {
    expectTypeOf<CompletionProviderAdapter>().toMatchTypeOf<{
      streamCompletion(
        request: CompletionRequest,
        signal: AbortSignal,
      ): AsyncIterable<CompletionEvent>;
    }>();
  });
});
