import { describe, expect, it } from "vitest";
import { ProviderError } from "./errors.js";

describe("ProviderError", () => {
  it("carries code, retryable, optional status", () => {
    const e = new ProviderError({
      code: "http",
      message: "Unauthorized",
      retryable: false,
      status: 401,
    });
    expect(e.code).toBe("http");
    expect(e.retryable).toBe(false);
    expect(e.status).toBe(401);
    expect(e.message).toBe("Unauthorized");
    expect(e instanceof Error).toBe(true);
    expect(e.name).toBe("ProviderError");
  });

  it("permits status omission", () => {
    const e = new ProviderError({
      code: "missing-key",
      message: "no key",
      retryable: false,
    });
    expect(e.status).toBeUndefined();
  });
});
