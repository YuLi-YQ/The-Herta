import { afterEach, describe, expect, it } from "vitest";
import { ProviderError } from "./errors.js";
import { postCompletions } from "./openai-compat/completion-http.js";
import {
  isTlsOrProxyFailure,
  providerFetch,
  setProviderFetch,
} from "./transport.js";

afterEach(() => setProviderFetch(undefined));

describe("the installed transport (audit S3)", () => {
  it("defaults to the platform fetch", () => {
    expect(providerFetch()).toBe(globalThis.fetch);
  });

  it("is what a call site with no fetchImpl uses", async () => {
    const seen: string[] = [];
    setProviderFetch((async (url: unknown) => {
      seen.push(String(url));
      return new Response("data: [DONE]\n\n", { status: 200 });
    }) as typeof fetch);

    await postCompletions(
      {
        baseUrl: "https://api.deepseek.com",
        apiKey: "k",
        path: "/beta/completions",
      },
      { model: "m", prompt: "p", stop: [] },
      new AbortController().signal,
    );
    expect(seen).toEqual(["https://api.deepseek.com/beta/completions"]);
  });

  it("never overrides an explicit fetchImpl — the suite's fixtures win", async () => {
    let installedCalled = false;
    setProviderFetch((async () => {
      installedCalled = true;
      return new Response("", { status: 200 });
    }) as typeof fetch);

    await postCompletions(
      {
        baseUrl: "https://x",
        apiKey: "k",
        path: "/c",
        fetchImpl: async () => new Response("", { status: 200 }),
      },
      { model: "m", prompt: "p", stop: [] },
      new AbortController().signal,
    );
    expect(installedCalled).toBe(false);
  });
});

describe("isTlsOrProxyFailure", () => {
  it("recognizes Chromium's certificate and proxy errors", () => {
    for (const m of [
      "net::ERR_CERT_AUTHORITY_INVALID",
      "net::ERR_CERT_COMMON_NAME_INVALID",
      "net::ERR_PROXY_CONNECTION_FAILED",
      "net::ERR_TUNNEL_CONNECTION_FAILED",
      "net::ERR_SSL_PROTOCOL_ERROR",
    ]) {
      expect(isTlsOrProxyFailure(new Error(m)), m).toBe(true);
    }
  });

  it("recognizes Node's OpenSSL codes buried under undici's 'fetch failed'", () => {
    // This nesting is the real shape: undici reports a bare "fetch failed"
    // and the code that names the corporate root CA is two levels down.
    const root = Object.assign(new Error("unable to verify"), {
      code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    });
    const mid = new Error("socket error", { cause: root });
    expect(isTlsOrProxyFailure(new Error("fetch failed", { cause: mid }))).toBe(
      true,
    );
  });

  it("leaves ordinary DNS/connect failures alone", () => {
    for (const [msg, code] of [
      ["getaddrinfo ENOTFOUND api.deepseek.com", "ENOTFOUND"],
      ["connect ECONNREFUSED", "ECONNREFUSED"],
      ["socket hang up", "ECONNRESET"],
      ["net::ERR_INTERNET_DISCONNECTED", ""],
    ]) {
      const e = Object.assign(new Error(msg), { code });
      expect(isTlsOrProxyFailure(e), msg).toBe(false);
    }
  });

  it("terminates on a cyclic cause chain", () => {
    const a = new Error("a");
    Object.assign(a, { cause: a });
    expect(isTlsOrProxyFailure(a)).toBe(false);
  });
});

describe("a certificate failure is reported, not retried", () => {
  it("throws network-tls on the first attempt", async () => {
    let attempts = 0;
    const fetchImpl: typeof fetch = async () => {
      attempts += 1;
      throw new Error("net::ERR_CERT_AUTHORITY_INVALID");
    };
    const err = await postCompletions(
      {
        baseUrl: "https://x",
        apiKey: "k",
        path: "/c",
        fetchImpl,
        maxRetries: 2,
        retryBaseMs: 1,
      },
      { model: "m", prompt: "p", stop: [] },
      new AbortController().signal,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe("network-tls");
    expect((err as ProviderError).retryable).toBe(false);
    // The point of the whole thing: an intercepting proxy rejects attempt two
    // exactly like attempt one, so there is no attempt two.
    expect(attempts).toBe(1);
  });

  it("still retries an ordinary connect failure", async () => {
    let attempts = 0;
    const fetchImpl: typeof fetch = async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("connect ECONNREFUSED");
      return new Response("", { status: 200 });
    };
    const res = await postCompletions(
      {
        baseUrl: "https://x",
        apiKey: "k",
        path: "/c",
        fetchImpl,
        maxRetries: 3,
        retryBaseMs: 1,
      },
      { model: "m", prompt: "p", stop: [] },
      new AbortController().signal,
    );
    expect(res.status).toBe(200);
    expect(attempts).toBe(3);
  });
});
