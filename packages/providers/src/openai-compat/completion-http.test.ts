import { describe, expect, it, vi } from "vitest";
import { ProviderError } from "../errors.js";
import { postCompletions } from "./completion-http.js";

function makeOkResponse(body = "data: {}\n\ndata: [DONE]\n\n"): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("postCompletions", () => {
  it("posts to baseUrl + path with auth header and JSON body", async () => {
    const fetchImpl = vi.fn(async () => makeOkResponse());
    const signal = new AbortController().signal;

    await postCompletions(
      {
        baseUrl: "https://api.example.com",
        apiKey: "sk-test",
        path: "/beta/completions",
        fetchImpl,
      },
      { model: "m", prompt: "p", stop: ["x"] },
      signal,
    );

    expect(fetchImpl).toHaveBeenCalledOnce();
    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    const [url, init] = calls[0] ?? ([] as unknown as [string, RequestInit]);
    expect(url).toBe("https://api.example.com/beta/completions");
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer sk-test");
    expect(headers.get("content-type")).toBe("application/json");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      model: "m",
      prompt: "p",
      stop: ["x"],
      stream: true,
    });
  });

  it("strips trailing slash from baseUrl", async () => {
    const fetchImpl = vi.fn(async () => makeOkResponse());
    await postCompletions(
      {
        baseUrl: "https://api.example.com/",
        apiKey: "k",
        path: "/completions",
        fetchImpl,
      },
      { model: "m", prompt: "p", stop: [] },
      new AbortController().signal,
    );
    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0]?.[0]).toBe("https://api.example.com/completions");
  });

  it("forwards optional max_tokens and temperature in the body", async () => {
    const fetchImpl = vi.fn(async () => makeOkResponse());
    await postCompletions(
      {
        baseUrl: "https://api.example.com",
        apiKey: "k",
        path: "/completions",
        fetchImpl,
      },
      {
        model: "m",
        prompt: "p",
        stop: ["s"],
        maxTokens: 128,
        temperature: 0.5,
      },
      new AbortController().signal,
    );
    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    const body = JSON.parse(calls[0]?.[1].body as string);
    expect(body.max_tokens).toBe(128);
    expect(body.temperature).toBe(0.5);
  });

  it("throws ProviderError with retryable=true on 5xx and exhausts retries", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("oops", {
          status: 503,
          statusText: "Service Unavailable",
        }),
    );
    const signal = new AbortController().signal;
    await expect(
      postCompletions(
        {
          baseUrl: "https://x",
          apiKey: "k",
          path: "/completions",
          fetchImpl,
          maxRetries: 1,
          retryBaseMs: 1,
        },
        { model: "m", prompt: "p", stop: [] },
        signal,
      ),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // initial + 1 retry
  });

  it("throws ProviderError with retryable=false on 4xx (no retry)", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('{"error":{"message":"bad model"}}', {
          status: 400,
          statusText: "Bad Request",
        }),
    );
    await expect(
      postCompletions(
        {
          baseUrl: "https://x",
          apiKey: "k",
          path: "/completions",
          fetchImpl,
          maxRetries: 3,
          retryBaseMs: 1,
        },
        { model: "m", prompt: "p", stop: [] },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ retryable: false });
    expect(fetchImpl).toHaveBeenCalledOnce(); // no retry on 4xx
  });

  it("propagates AbortError from the underlying fetch", async () => {
    const ac = new AbortController();
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      init.signal?.addEventListener("abort", () => {});
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    });
    ac.abort();
    await expect(
      postCompletions(
        {
          baseUrl: "https://x",
          apiKey: "k",
          path: "/completions",
          fetchImpl: fetchImpl as unknown as typeof fetch,
        },
        { model: "m", prompt: "p", stop: [] },
        ac.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("headers stall: retries then throws ProviderError{stall, retryable:true}", async () => {
    let attempts = 0;
    // A server that accepts the connection and never sends headers.
    const fetchImpl: typeof fetch = () => {
      attempts += 1;
      return new Promise<Response>(() => {});
    };
    await expect(
      postCompletions(
        {
          baseUrl: "https://x",
          apiKey: "k",
          path: "/completions",
          fetchImpl,
          maxRetries: 1,
          retryBaseMs: 1,
          headersTimeoutMs: 20,
        },
        { model: "m", prompt: "p", stop: [] },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      name: "ProviderError",
      code: "stall",
      retryable: true,
    });
    expect(attempts).toBe(2); // initial + 1 retry
  });
});
