import type { CompletionEvent } from "@herta/core";
import { describe, expect, it } from "vitest";
import { OpenAICompatibleCompletionProvider } from "./completion-provider.js";

function sseResponse(chunks: string[]): Response {
  const body = `${chunks.map((c) => `data: ${c}\n\n`).join("")}data: [DONE]\n\n`;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function collect(
  events: AsyncIterable<CompletionEvent>,
): Promise<CompletionEvent[]> {
  const out: CompletionEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe("OpenAICompatibleCompletionProvider", () => {
  it("streams text deltas and a finish event end-to-end", async () => {
    const fetchImpl = async (): Promise<Response> =>
      sseResponse([
        JSON.stringify({
          choices: [{ text: "你好", index: 0, finish_reason: null }],
        }),
        JSON.stringify({
          choices: [{ text: "黑塔。", index: 0, finish_reason: null }],
        }),
        JSON.stringify({
          choices: [{ text: "", index: 0, finish_reason: "stop" }],
        }),
      ]);

    const provider = new OpenAICompatibleCompletionProvider({
      baseUrl: "https://api.example.com",
      apiKey: "sk",
      path: "/completions",
      fetchImpl,
    });

    const out = await collect(
      provider.streamCompletion(
        {
          model: "m",
          prompt: "p",
          stop: ["（/我 说）", "（/我 想）"],
        },
        new AbortController().signal,
      ),
    );

    expect(out).toEqual([
      { type: "text-delta", text: "你好" },
      { type: "text-delta", text: "黑塔。" },
      { type: "finish", reason: "stop" },
    ]);
  });

  it("sends multi-stop array in the request body", async () => {
    let capturedBody: unknown;
    const fetchImpl = async (
      _url: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedBody = JSON.parse((init?.body ?? "null") as string);
      return sseResponse([
        JSON.stringify({
          choices: [{ text: "x", index: 0, finish_reason: "stop" }],
        }),
      ]);
    };

    const provider = new OpenAICompatibleCompletionProvider({
      baseUrl: "https://api.example.com",
      apiKey: "k",
      path: "/completions",
      fetchImpl,
    });

    await collect(
      provider.streamCompletion(
        {
          model: "deepseek-v4-completion",
          prompt: "（开拓者 说）...（/开拓者 说）\n\n（我 说）",
          stop: ["（/我 说）", "（/我 想）"],
        },
        new AbortController().signal,
      ),
    );

    expect(capturedBody).toMatchObject({
      model: "deepseek-v4-completion",
      stop: ["（/我 说）", "（/我 想）"],
      stream: true,
    });
  });

  it("forwards model from CompletionRequest to wire body", async () => {
    let captured: { model?: string } | undefined;
    const fetchImpl = async (
      _u: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      captured = JSON.parse((init?.body ?? "null") as string);
      return sseResponse([
        JSON.stringify({
          choices: [{ text: "", index: 0, finish_reason: "stop" }],
        }),
      ]);
    };

    const provider = new OpenAICompatibleCompletionProvider({
      baseUrl: "https://x",
      apiKey: "k",
      path: "/completions",
      fetchImpl,
    });

    await collect(
      provider.streamCompletion(
        { model: "request-model", prompt: "p", stop: [] },
        new AbortController().signal,
      ),
    );

    expect(captured?.model).toBe("request-model");
  });

  it("propagates abort during streaming", async () => {
    const ac = new AbortController();
    let pullCount = 0;
    const fetchImpl = async (): Promise<Response> => {
      const stream = new ReadableStream({
        pull(controller) {
          pullCount += 1;
          if (pullCount === 1) {
            // First pull: emit one chunk then abort.
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ choices: [{ text: "a", index: 0, finish_reason: null }] })}\n\n`,
              ),
            );
            ac.abort();
          } else {
            // Subsequent pulls: signal already aborted, error the stream.
            controller.error(new DOMException("aborted", "AbortError"));
          }
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };

    const provider = new OpenAICompatibleCompletionProvider({
      baseUrl: "https://x",
      apiKey: "k",
      path: "/completions",
      fetchImpl,
    });

    await expect(async () => {
      for await (const _e of provider.streamCompletion(
        { model: "m", prompt: "p", stop: [] },
        ac.signal,
      )) {
        // consume
      }
    }).rejects.toBeDefined();
    expect(ac.signal.aborted).toBe(true);
  });
});
