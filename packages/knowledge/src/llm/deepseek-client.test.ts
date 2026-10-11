import { describe, expect, it } from "vitest";
import { RealDeepSeekClient } from "./deepseek-client.js";
import { DeepSeekHttpError, DeepSeekShapeError } from "./types.js";

interface FakeFetchCall {
  url: string;
  init: RequestInit;
}

function makeFakeFetch(
  responses: ReadonlyArray<
    { status: number; body: unknown } | { networkError: true }
  >,
): { fetch: typeof fetch; calls: FakeFetchCall[] } {
  const calls: FakeFetchCall[] = [];
  let i = 0;
  const fakeFetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses[i++];
    if (r === undefined) throw new Error("fake fetch ran out of responses");
    if ("networkError" in r) {
      throw new TypeError("fetch failed");
    }
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetch: fakeFetch, calls };
}

describe("RealDeepSeekClient", () => {
  it("posts to /v1/chat/completions with Bearer auth and json_object response_format", async () => {
    const { fetch, calls } = makeFakeFetch([
      {
        status: 200,
        body: {
          choices: [{ message: { content: '{"chunks":[]}' } }],
          model: "deepseek-chat",
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        },
      },
    ]);
    const client = new RealDeepSeekClient({
      apiKey: "sk-xxx",
      model: "deepseek-chat",
      fetch,
    });
    const out = await client.chatJson({
      systemPrompt: "system json",
      userPayload: '{"x":1}',
      model: "deepseek-chat",
    });
    expect(calls).toHaveLength(1);
    const c = calls[0];
    expect(c?.url).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(c?.init.method).toBe("POST");
    const headers = c?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-xxx");
    expect(headers["content-type"]).toBe("application/json");
    const body = JSON.parse(c?.init.body as string);
    expect(body.model).toBe("deepseek-chat");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages).toEqual([
      { role: "system", content: "system json" },
      { role: "user", content: '{"x":1}' },
    ]);
    expect(out.rawJsonText).toBe('{"chunks":[]}');
    expect(out.model).toBe("deepseek-chat");
    expect(out.usage?.totalTokens).toBe(30);
  });

  it("tells onUsage each call's counts, the cache split included — and a throwing observer never breaks the call (dream review 2026-09-22, finding 4)", async () => {
    const { fetch } = makeFakeFetch([
      {
        status: 200,
        body: {
          choices: [{ message: { content: "{}" } }],
          model: "deepseek-v4-pro",
          usage: {
            prompt_tokens: 4000,
            completion_tokens: 900,
            total_tokens: 4900,
            prompt_cache_hit_tokens: 3000,
            prompt_cache_miss_tokens: 1000,
          },
        },
      },
      {
        status: 200,
        body: {
          choices: [{ message: { content: "{}" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        },
      },
    ]);
    const seen: unknown[] = [];
    const client = new RealDeepSeekClient({
      apiKey: "sk-xxx",
      model: "deepseek-v4-pro",
      fetch,
      onUsage: (u) => {
        seen.push(u);
        throw new Error("a broken observer");
      },
    });
    const input = {
      systemPrompt: "s",
      userPayload: "{}",
      model: "deepseek-v4-pro",
    };
    await expect(client.chatJson(input)).resolves.toMatchObject({
      rawJsonText: "{}",
    });
    await client.chatJson(input);
    expect(seen).toEqual([
      {
        model: "deepseek-v4-pro",
        promptTokens: 4000,
        completionTokens: 900,
        cacheHitTokens: 3000,
        cacheMissTokens: 1000,
      },
      {
        model: "deepseek-v4-pro",
        promptTokens: 10,
        completionTokens: 5,
        cacheHitTokens: null,
        cacheMissTokens: null,
      },
    ]);
  });

  it("throws DeepSeekHttpError on 4xx without retry", async () => {
    const { fetch, calls } = makeFakeFetch([
      { status: 401, body: { error: { message: "Unauthorized" } } },
    ]);
    const client = new RealDeepSeekClient({
      apiKey: "sk-xxx",
      model: "deepseek-chat",
      fetch,
    });
    await expect(
      client.chatJson({
        systemPrompt: "s",
        userPayload: "{}",
        model: "deepseek-chat",
      }),
    ).rejects.toBeInstanceOf(DeepSeekHttpError);
    expect(calls).toHaveLength(1);
  });

  it("retries on 5xx and succeeds within maxRetries", async () => {
    const { fetch, calls } = makeFakeFetch([
      { status: 500, body: { error: "transient" } },
      { status: 503, body: { error: "transient" } },
      {
        status: 200,
        body: {
          choices: [{ message: { content: "{}" } }],
          model: "deepseek-chat",
        },
      },
    ]);
    const client = new RealDeepSeekClient({
      apiKey: "sk-xxx",
      model: "deepseek-chat",
      fetch,
      maxRetries: 3,
      backoffMs: 1,
    });
    const out = await client.chatJson({
      systemPrompt: "s",
      userPayload: "{}",
      model: "deepseek-chat",
    });
    expect(calls).toHaveLength(3);
    expect(out.rawJsonText).toBe("{}");
  });

  it("retries on network error and succeeds", async () => {
    const { fetch, calls } = makeFakeFetch([
      { networkError: true },
      {
        status: 200,
        body: {
          choices: [{ message: { content: "{}" } }],
          model: "deepseek-chat",
        },
      },
    ]);
    const client = new RealDeepSeekClient({
      apiKey: "sk-xxx",
      model: "deepseek-chat",
      fetch,
      maxRetries: 2,
      backoffMs: 1,
    });
    const out = await client.chatJson({
      systemPrompt: "s",
      userPayload: "{}",
      model: "deepseek-chat",
    });
    expect(calls).toHaveLength(2);
    expect(out.rawJsonText).toBe("{}");
  });

  it("gives up after maxRetries on persistent 5xx", async () => {
    const { fetch, calls } = makeFakeFetch([
      { status: 500, body: { error: "x" } },
      { status: 500, body: { error: "x" } },
      { status: 500, body: { error: "x" } },
    ]);
    const client = new RealDeepSeekClient({
      apiKey: "sk-xxx",
      model: "deepseek-chat",
      fetch,
      maxRetries: 3,
      backoffMs: 1,
    });
    await expect(
      client.chatJson({
        systemPrompt: "s",
        userPayload: "{}",
        model: "deepseek-chat",
      }),
    ).rejects.toBeInstanceOf(DeepSeekHttpError);
    expect(calls).toHaveLength(3);
  });

  it("throws DeepSeekShapeError when response has no choices[0].message.content", async () => {
    const { fetch } = makeFakeFetch([
      { status: 200, body: { choices: [], model: "deepseek-chat" } },
    ]);
    const client = new RealDeepSeekClient({
      apiKey: "sk-xxx",
      model: "deepseek-chat",
      fetch,
    });
    await expect(
      client.chatJson({
        systemPrompt: "s",
        userPayload: "{}",
        model: "deepseek-chat",
      }),
    ).rejects.toBeInstanceOf(DeepSeekShapeError);
  });

  it("API key never appears in DeepSeekHttpError body excerpt", async () => {
    const { fetch } = makeFakeFetch([
      {
        status: 401,
        body: { error: "Unauthorized: token sk-xxx-leaked-in-body" },
      },
    ]);
    const client = new RealDeepSeekClient({
      apiKey: "sk-xxx-leaked-in-body",
      model: "deepseek-chat",
      fetch,
    });
    let caught: unknown;
    try {
      await client.chatJson({
        systemPrompt: "s",
        userPayload: "{}",
        model: "deepseek-chat",
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DeepSeekHttpError);
    const msg = (caught as Error).message;
    expect(msg).not.toContain("Authorization");
    expect(msg).not.toContain("Bearer ");
  });
});

describe("RealDeepSeekClient.chatJson — reasoning_effort", () => {
  it("sends thinking + reasoning_effort when reasoningEffort is set, keeps json mode", async () => {
    let sentBody: Record<string, unknown> = {};
    const fakeFetch = (async (_url: string, init: { body: string }) => {
      sentBody = JSON.parse(init.body) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          model: "deepseek-v4-pro",
          choices: [{ message: { content: '{"ok":true}' } }],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const client = new RealDeepSeekClient({
      apiKey: "k",
      model: "deepseek-v4-pro",
      fetch: fakeFetch,
    });
    const out = await client.chatJson({
      systemPrompt: "sys",
      userPayload: "u",
      model: "deepseek-v4-pro",
      reasoningEffort: "max",
    });
    expect(out.rawJsonText).toBe('{"ok":true}');
    expect((sentBody.response_format as { type: string }).type).toBe(
      "json_object",
    );
    expect(sentBody.reasoning_effort).toBe("max");
    expect((sentBody.thinking as { type: string }).type).toBe("enabled");
  });

  it("omits thinking when reasoningEffort is unset (back-compat with existing callers)", async () => {
    let sentBody: Record<string, unknown> = {};
    const fakeFetch = (async (_url: string, init: { body: string }) => {
      sentBody = JSON.parse(init.body) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          model: "m",
          choices: [{ message: { content: "{}" } }],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    await new RealDeepSeekClient({
      apiKey: "k",
      model: "m",
      fetch: fakeFetch,
    }).chatJson({ systemPrompt: "s", userPayload: "u", model: "m" });
    expect(sentBody.reasoning_effort).toBeUndefined();
    expect(sentBody.thinking).toBeUndefined();
  });
});
