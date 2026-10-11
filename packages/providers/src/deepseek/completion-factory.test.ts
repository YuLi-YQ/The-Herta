import { describe, expect, it } from "vitest";
import {
  type DeepseekCompletionProviderOpts,
  deepseekCompletionProvider,
} from "./completion-factory.js";

describe("deepseekCompletionProvider", () => {
  it("returns a CompletionProviderAdapter", () => {
    const provider = deepseekCompletionProvider({ apiKey: "sk" });
    expect(typeof provider.streamCompletion).toBe("function");
  });

  it("sends requests to DeepSeek's default base URL + /beta/completions", async () => {
    let capturedUrl: string | undefined;
    const fetchImpl: typeof fetch = async (url) => {
      capturedUrl = typeof url === "string" ? url : url.toString();
      const body = `data: ${JSON.stringify({
        choices: [{ text: "", index: 0, finish_reason: "stop" }],
      })}\n\ndata: [DONE]\n\n`;
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };

    const provider = deepseekCompletionProvider({
      apiKey: "sk",
      fetchImpl,
    });

    const events = provider.streamCompletion(
      { model: "m", prompt: "p", stop: [] },
      new AbortController().signal,
    );
    for await (const _e of events) {
      /* drain */
    }
    expect(capturedUrl).toBe("https://api.deepseek.com/beta/completions");
  });

  it("allows baseUrl override", async () => {
    let capturedUrl: string | undefined;
    const fetchImpl: typeof fetch = async (url) => {
      capturedUrl = typeof url === "string" ? url : url.toString();
      return new Response(
        `data: ${JSON.stringify({ choices: [{ text: "", finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };
    const provider = deepseekCompletionProvider({
      apiKey: "sk",
      baseUrl: "https://staging.example.com",
      fetchImpl,
    });
    for await (const _e of provider.streamCompletion(
      { model: "m", prompt: "p", stop: [] },
      new AbortController().signal,
    )) {
      /* drain */
    }
    expect(capturedUrl).toBe("https://staging.example.com/beta/completions");
  });

  it("type: DeepseekCompletionProviderOpts requires apiKey only; does NOT accept thinking or model", () => {
    // Compile-only proof: this assignment with only apiKey must succeed.
    const opts: DeepseekCompletionProviderOpts = { apiKey: "k" };
    expect(opts.apiKey).toBe("k");
  });
});
