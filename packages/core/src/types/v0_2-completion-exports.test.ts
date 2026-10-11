import { describe, expectTypeOf, it } from "vitest";
import type {
  CompletionEvent,
  CompletionProviderAdapter,
  CompletionRequest,
} from "../index.js";

describe("@herta/core re-exports completion types", () => {
  it("CompletionEvent is reachable from package root", () => {
    expectTypeOf<CompletionEvent>().toEqualTypeOf<
      | { type: "text-delta"; text: string }
      | { type: "finish"; reason: "stop" | "length" | "error" }
    >();
  });

  it("CompletionRequest is reachable from package root", () => {
    expectTypeOf<CompletionRequest>().toMatchTypeOf<{
      readonly model: string;
      readonly prompt: string;
      readonly stop: readonly string[];
    }>();
  });

  it("CompletionProviderAdapter is reachable from package root", () => {
    expectTypeOf<CompletionProviderAdapter>().toMatchTypeOf<{
      streamCompletion(
        req: CompletionRequest,
        signal: AbortSignal,
      ): AsyncIterable<CompletionEvent>;
    }>();
  });
});
