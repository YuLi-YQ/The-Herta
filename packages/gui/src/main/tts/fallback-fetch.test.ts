import { describe, expect, it } from "vitest";
import { createFallbackFetch } from "./fallback-fetch.js";
import type { FetchLike } from "./minimax-api.js";

const answer = (status = 200): Response =>
  new Response(JSON.stringify({ base_resp: { status_code: 0 } }), { status });

function stack(behaviour: (n: number) => "ok" | "http500" | "throw"): {
  fetch: FetchLike;
  calls: number;
} {
  const s = {
    calls: 0,
    fetch: (async () => {
      s.calls += 1;
      const b = behaviour(s.calls);
      if (b === "throw") throw new TypeError("net::ERR_CONNECTION_CLOSED");
      return answer(b === "http500" ? 500 : 200);
    }) as FetchLike,
  };
  return s;
}

describe("createFallbackFetch", () => {
  it("uses the first stack while it connects; the second is never touched", async () => {
    const a = stack(() => "ok");
    const b = stack(() => "ok");
    const f = createFallbackFetch([a.fetch, b.fetch]);
    await f("https://x", {});
    await f("https://x", {});
    expect(a.calls).toBe(2);
    expect(b.calls).toBe(0);
  });

  it("an HTTP answer of any status is the platform's word — no fallback on a 500", async () => {
    const a = stack(() => "http500");
    const b = stack(() => "ok");
    const f = createFallbackFetch([a.fetch, b.fetch]);
    const res = await f("https://x", {});
    expect(res.status).toBe(500);
    expect(b.calls).toBe(0);
  });

  it("a connection that never happened falls back, and the stack that answered is remembered", async () => {
    const a = stack(() => "throw");
    const b = stack(() => "ok");
    const lines: string[] = [];
    const f = createFallbackFetch([a.fetch, b.fetch], (l) => lines.push(l));
    expect((await f("https://x", {})).status).toBe(200);
    expect(a.calls).toBe(1);
    expect(b.calls).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("ERR_CONNECTION_CLOSED");
    // The next unit does not pay the first stack's failure again.
    await f("https://x", {});
    expect(a.calls).toBe(1);
    expect(b.calls).toBe(2);
  });

  it("when the remembered stack dies, the other is tried again", async () => {
    const a = stack((n) => (n === 1 ? "throw" : "ok"));
    const b = stack((n) => (n === 1 ? "ok" : "throw"));
    const f = createFallbackFetch([a.fetch, b.fetch]);
    await f("https://x", {}); // a fails, b answers → b preferred
    await f("https://x", {}); // b fails, a answers → a preferred
    expect(a.calls).toBe(2);
    expect(b.calls).toBe(2);
    await f("https://x", {});
    expect(a.calls).toBe(3);
    expect(b.calls).toBe(2);
  });

  it("both failing reports the first stack's error — the machine's usual path", async () => {
    const a = stack(() => "throw");
    const b = {
      calls: 0,
      fetch: (async () => {
        b.calls += 1;
        throw new TypeError("fetch failed");
      }) as FetchLike,
    };
    const f = createFallbackFetch([a.fetch, b.fetch]);
    await expect(f("https://x", {})).rejects.toThrow("ERR_CONNECTION_CLOSED");
    expect(b.calls).toBe(1);
  });

  it("an abort is the caller's — no fallback", async () => {
    const ctl = new AbortController();
    const a = {
      calls: 0,
      fetch: (async () => {
        a.calls += 1;
        ctl.abort();
        const e = new Error("aborted");
        e.name = "AbortError";
        throw e;
      }) as FetchLike,
    };
    const b = stack(() => "ok");
    const f = createFallbackFetch([a.fetch, b.fetch]);
    await expect(f("https://x", { signal: ctl.signal })).rejects.toThrow(
      "aborted",
    );
    expect(b.calls).toBe(0);
  });
});
