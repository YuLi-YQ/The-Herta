import { describe, expect, it, vi } from "vitest";
import { validateDeepSeekKey } from "./validate-deepseek-key.js";

function fetchReturning(status: number): typeof fetch {
  return vi.fn(
    async (_url, _init) =>
      new Response(status === 200 ? '{"data":[]}' : "nope", { status }),
  ) as unknown as typeof fetch;
}

describe("validateDeepSeekKey", () => {
  it("returns 'valid' on a 200", async () => {
    const fetchImpl = fetchReturning(200);
    expect(await validateDeepSeekKey("sk-good", { fetchImpl })).toBe("valid");
  });

  it("returns 'rejected' on a 401", async () => {
    expect(
      await validateDeepSeekKey("sk-bad", { fetchImpl: fetchReturning(401) }),
    ).toBe("rejected");
  });

  it("returns 'rejected' on a 403", async () => {
    expect(
      await validateDeepSeekKey("sk-bad", { fetchImpl: fetchReturning(403) }),
    ).toBe("rejected");
  });

  it("returns 'rejected' for an empty/whitespace key without any call", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect(await validateDeepSeekKey("   ", { fetchImpl })).toBe("rejected");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns 'unreachable' on a 5xx (not a definitive rejection)", async () => {
    expect(
      await validateDeepSeekKey("sk-x", { fetchImpl: fetchReturning(503) }),
    ).toBe("unreachable");
  });

  it("returns 'unreachable' on a network error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await validateDeepSeekKey("sk-x", { fetchImpl })).toBe(
      "unreachable",
    );
  });

  it("sends the key as a Bearer token to {baseUrl}/models", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("{}", { status: 200 }),
    ) as unknown as typeof fetch;
    await validateDeepSeekKey("sk-abc", {
      fetchImpl,
      baseUrl: "https://example.test",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://example.test/models",
      expect.objectContaining({
        method: "GET",
        headers: { authorization: "Bearer sk-abc" },
      }),
    );
  });
});
