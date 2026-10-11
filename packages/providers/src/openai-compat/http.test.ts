import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ProviderError } from "../errors.js";
import { postChatCompletions } from "./http.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, "__fixtures__");

function jsonResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

const baseOpts = {
  baseUrl: "https://example.test",
  apiKey: "sk-test",
  model: "deepseek-v4-pro",
};

describe("postChatCompletions — error-body deadline (audit finding 18)", () => {
  it("a non-OK response whose BODY stalls does not park forever", async () => {
    // 500 headers arrive, then the body never produces data nor closes.
    // Pre-fix the bare res.text() had no watchdog — the headers deadline had
    // already settled and the SSE idle watchdog wraps only the OK path — so
    // this parked forever (reopening the H1 hang class).
    const stalled = new Response(new ReadableStream({ start() {} }), {
      status: 500,
    });
    const fetchImpl: typeof fetch = async () => stalled;
    await expect(
      postChatCompletions(
        { ...baseOpts, fetchImpl, maxRetries: 0, headersTimeoutMs: 50 },
        {},
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      name: "ProviderError",
      code: "http",
      status: 500,
    });
  });

  it("an abort raised mid-body-read surfaces as AbortError, not an HTTP error", async () => {
    // Pre-fix `.catch(() => "")` swallowed the AbortError and the interrupt
    // was misclassified as a plain HTTP failure.
    const abortErr = Object.assign(new Error("aborted"), {
      name: "AbortError",
    });
    const erroring = new Response(
      new ReadableStream({
        start(controller) {
          setTimeout(() => controller.error(abortErr), 10);
        },
      }),
      { status: 500 },
    );
    const fetchImpl: typeof fetch = async () => erroring;
    await expect(
      postChatCompletions(
        { ...baseOpts, fetchImpl, maxRetries: 0 },
        {},
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("postChatCompletions", () => {
  it("posts to /chat/completions with bearer auth + JSON body", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fetchImpl: typeof fetch = async (url, init) => {
      captured = { url: String(url), init: init ?? {} };
      return new Response("ok", { status: 200 });
    };
    const ctl = new AbortController();
    const res = await postChatCompletions(
      { ...baseOpts, fetchImpl },
      { hello: "world" },
      ctl.signal,
    );
    expect(res.status).toBe(200);
    expect(captured?.url).toBe("https://example.test/chat/completions");
    expect(captured?.init.method).toBe("POST");
    const headers = new Headers(captured?.init.headers);
    expect(headers.get("authorization")).toBe("Bearer sk-test");
    expect(headers.get("content-type")).toBe("application/json");
    expect(captured?.init.body).toBe('{"hello":"world"}');
  });

  it("merges custom headers", async () => {
    let captured: RequestInit | undefined;
    const fetchImpl: typeof fetch = async (_url, init) => {
      captured = init ?? {};
      return new Response("ok", { status: 200 });
    };
    await postChatCompletions(
      { ...baseOpts, headers: { "x-test": "1" }, fetchImpl },
      {},
      new AbortController().signal,
    );
    expect(new Headers(captured?.headers).get("x-test")).toBe("1");
  });

  it("throws ProviderError{http, retryable:false} on 401", async () => {
    const body = await readFile(join(FIXTURE_DIR, "http-401.json"), "utf8");
    const fetchImpl: typeof fetch = async () => jsonResponse(401, body);
    await expect(
      postChatCompletions(
        { ...baseOpts, fetchImpl },
        {},
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      name: "ProviderError",
      code: "http",
      status: 401,
      retryable: false,
      message: expect.stringContaining("Authentication Fails"),
    });
  });

  it("throws ProviderError{http, retryable:false} on 422 even without parseable body", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("not json", { status: 422 });
    await expect(
      postChatCompletions(
        { ...baseOpts, fetchImpl },
        {},
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      name: "ProviderError",
      code: "http",
      status: 422,
      retryable: false,
    });
  });

  it("throws ProviderError{http, retryable:true} on 429 (no retries configured)", async () => {
    const body = await readFile(join(FIXTURE_DIR, "http-429.json"), "utf8");
    const fetchImpl: typeof fetch = async () => jsonResponse(429, body);
    await expect(
      postChatCompletions(
        { ...baseOpts, fetchImpl, maxRetries: 0 },
        {},
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      name: "ProviderError",
      code: "http",
      status: 429,
      retryable: true,
    });
  });

  it("throws ProviderError{http, retryable:true} on 503 (no retries configured)", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("overloaded", { status: 503 });
    await expect(
      postChatCompletions(
        { ...baseOpts, fetchImpl, maxRetries: 0 },
        {},
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      name: "ProviderError",
      code: "http",
      status: 503,
      retryable: true,
    });
  });

  it("wraps non-abort fetch rejections as ProviderError{network, retryable:true} (no retries)", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(
      postChatCompletions(
        { ...baseOpts, fetchImpl, maxRetries: 0 },
        {},
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      name: "ProviderError",
      code: "network",
      retryable: true,
    });
  });

  it("rethrows AbortError unchanged (not wrapped as ProviderError)", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new DOMException("aborted", "AbortError");
    };
    let caught: unknown;
    try {
      await postChatCompletions(
        { ...baseOpts, fetchImpl, maxRetries: 0 },
        {},
        new AbortController().signal,
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DOMException);
    expect((caught as DOMException).name).toBe("AbortError");
    expect(caught instanceof ProviderError).toBe(false);
  });

  // --- Retry behavior tests ---

  it("retries on transient fetch failure and succeeds on subsequent attempt", async () => {
    let attempts = 0;
    const fetchImpl: typeof fetch = async () => {
      attempts += 1;
      if (attempts < 2) throw new TypeError("fetch failed");
      return new Response("ok", { status: 200 });
    };
    const res = await postChatCompletions(
      { ...baseOpts, fetchImpl, maxRetries: 3, retryBaseMs: 1 },
      {},
      new AbortController().signal,
    );
    expect(res.status).toBe(200);
    expect(attempts).toBe(2);
  });

  it("retries on 503 and succeeds on subsequent attempt", async () => {
    let attempts = 0;
    const fetchImpl: typeof fetch = async () => {
      attempts += 1;
      if (attempts < 3) {
        return new Response("overloaded", { status: 503 });
      }
      return new Response("ok", { status: 200 });
    };
    const res = await postChatCompletions(
      { ...baseOpts, fetchImpl, maxRetries: 3, retryBaseMs: 1 },
      {},
      new AbortController().signal,
    );
    expect(res.status).toBe(200);
    expect(attempts).toBe(3);
  });

  it("does NOT retry on 401 (non-retryable HTTP)", async () => {
    let attempts = 0;
    const fetchImpl: typeof fetch = async () => {
      attempts += 1;
      return new Response("unauthorized", { status: 401 });
    };
    await expect(
      postChatCompletions(
        { ...baseOpts, fetchImpl, maxRetries: 3, retryBaseMs: 1 },
        {},
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      name: "ProviderError",
      status: 401,
      retryable: false,
    });
    expect(attempts).toBe(1);
  });

  it("exhausts retries on persistent failure and throws the last error", async () => {
    let attempts = 0;
    const fetchImpl: typeof fetch = async () => {
      attempts += 1;
      throw new TypeError("fetch failed");
    };
    await expect(
      postChatCompletions(
        { ...baseOpts, fetchImpl, maxRetries: 2, retryBaseMs: 1 },
        {},
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      name: "ProviderError",
      code: "network",
      retryable: true,
    });
    expect(attempts).toBe(3); // initial + 2 retries
  });

  it("headers stall: retries then throws ProviderError{stall, retryable:true}", async () => {
    let attempts = 0;
    // A server that accepts the connection and never sends headers.
    const fetchImpl: typeof fetch = () => {
      attempts += 1;
      return new Promise<Response>(() => {});
    };
    await expect(
      postChatCompletions(
        {
          ...baseOpts,
          fetchImpl,
          maxRetries: 1,
          retryBaseMs: 1,
          headersTimeoutMs: 20,
        },
        {},
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      name: "ProviderError",
      code: "stall",
      retryable: true,
    });
    expect(attempts).toBe(2); // initial + 1 retry
  });

  it("headers stall on attempt 1 recovers on the retry", async () => {
    let attempts = 0;
    const fetchImpl: typeof fetch = () => {
      attempts += 1;
      if (attempts === 1) return new Promise<Response>(() => {});
      return Promise.resolve(new Response("ok", { status: 200 }));
    };
    const res = await postChatCompletions(
      {
        ...baseOpts,
        fetchImpl,
        maxRetries: 1,
        retryBaseMs: 1,
        headersTimeoutMs: 20,
      },
      {},
      new AbortController().signal,
    );
    expect(res.status).toBe(200);
    expect(attempts).toBe(2);
  });

  it("aborts mid-retry-backoff when signal aborts", async () => {
    let attempts = 0;
    const fetchImpl: typeof fetch = async () => {
      attempts += 1;
      throw new TypeError("fetch failed");
    };
    const ac = new AbortController();
    const promise = postChatCompletions(
      { ...baseOpts, fetchImpl, maxRetries: 5, retryBaseMs: 100 },
      {},
      ac.signal,
    );
    // Wait briefly to let the first attempt fail and enter the backoff sleep.
    await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(attempts).toBeLessThanOrEqual(2);
  });
});
