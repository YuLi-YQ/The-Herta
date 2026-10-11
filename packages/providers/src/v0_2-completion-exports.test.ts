import { describe, expect, it } from "vitest";
import * as providers from "./index.js";

describe("@herta/providers v0.2 completion exports", () => {
  it("exports deepseekCompletionProvider function", () => {
    expect(typeof providers.deepseekCompletionProvider).toBe("function");
  });

  it("exports OpenAICompatibleCompletionProvider class", () => {
    expect(typeof providers.OpenAICompatibleCompletionProvider).toBe(
      "function",
    );
  });

  it("OpenAICompatibleCompletionProvider can be constructed", () => {
    const p = new providers.OpenAICompatibleCompletionProvider({
      baseUrl: "https://x",
      apiKey: "k",
      path: "/c",
    });
    expect(typeof p.streamCompletion).toBe("function");
  });
});
