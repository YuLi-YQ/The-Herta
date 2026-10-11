import { describe, expect, it } from "vitest";
import {
  type BackendErrorClass,
  type BackendErrorReason,
  BackendRetryState,
  classifyBackendInferenceError,
  MAX_HARD_RETRIES,
} from "./backend-error-policy.js";

/** A structural ProviderError stand-in (core can't import @herta/providers). */
function providerError(
  code: string,
  opts: { status?: number; retryable?: boolean } = {},
): unknown {
  return {
    name: "ProviderError",
    code,
    retryable: opts.retryable ?? false,
    ...(opts.status !== undefined ? { status: opts.status } : {}),
    message: `${code} error`,
  };
}

describe("classifyBackendInferenceError", () => {
  it("classifies transient provider codes as retryable named reasons", () => {
    expect(classifyBackendInferenceError(providerError("sse"))).toMatchObject({
      reason: "stream-dropped",
      retryable: true,
    });
    expect(
      classifyBackendInferenceError(providerError("network")),
    ).toMatchObject({ reason: "network", retryable: true });
    expect(
      classifyBackendInferenceError(providerError("http", { status: 429 })),
    ).toMatchObject({ reason: "rate-limited", retryable: true });
    expect(
      classifyBackendInferenceError(providerError("http", { status: 503 })),
    ).toMatchObject({ reason: "server-error", retryable: true });
  });

  it("classifies a 4xx as terminal even when the provider flags it retryable (provider-patterns win)", () => {
    // A content-filter / safety block arrives as a 400; it must NEVER be
    // downgraded to a retryable transient error.
    const cls = classifyBackendInferenceError(
      providerError("http", { status: 400, retryable: true }),
    );
    expect(cls).toMatchObject({ reason: "bad-request", retryable: false });
  });

  it("classifies auth/key failures as terminal", () => {
    expect(
      classifyBackendInferenceError(providerError("missing-key")),
    ).toMatchObject({ reason: "missing-key", retryable: false });
    expect(
      classifyBackendInferenceError(providerError("http", { status: 403 })),
    ).toMatchObject({ reason: "bad-request", retryable: false });
  });

  it("classifies malformed tool-args as terminal", () => {
    expect(
      classifyBackendInferenceError(providerError("tool-args")),
    ).toMatchObject({ reason: "malformed-tool-args", retryable: false });
  });

  it("falls back to the retryable flag only for an http error with no status", () => {
    expect(
      classifyBackendInferenceError(providerError("http", { retryable: true })),
    ).toMatchObject({ reason: "server-error", retryable: true });
    expect(
      classifyBackendInferenceError(
        providerError("http", { retryable: false }),
      ),
    ).toMatchObject({ reason: "bad-request", retryable: false });
  });

  it("treats a non-ProviderError as terminal unknown (never blind-retried)", () => {
    expect(classifyBackendInferenceError(new Error("boom"))).toMatchObject({
      reason: "unknown",
      retryable: false,
    });
    expect(classifyBackendInferenceError("nope")).toMatchObject({
      reason: "unknown",
      retryable: false,
    });
  });
});

describe("BackendRetryState", () => {
  const transient = (
    reason: BackendErrorReason,
    base = 800,
  ): BackendErrorClass => ({ reason, retryable: true, baseBackoffMs: base });

  it("surfaces a terminal class immediately", () => {
    const rs = new BackendRetryState(() => 0.5);
    expect(
      rs.decide({ reason: "bad-request", retryable: false, baseBackoffMs: 0 }),
    ).toEqual({ kind: "surface", detail: "not retryable" });
  });

  it("gives each distinct reason one FREE retry that does not spend the hard cap", () => {
    const rs = new BackendRetryState(() => 0.5);
    expect(rs.decide(transient("network")).kind).toBe("retry");
    expect(rs.decide(transient("rate-limited", 2000)).kind).toBe("retry");
    // Both were free (distinct reasons) — the hard cap is still untouched, so a
    // third distinct reason also retries free.
    expect(rs.decide(transient("server-error")).kind).toBe("retry");
  });

  it("bounds repeated same-reason failures by the hard cap, then surfaces", () => {
    const rs = new BackendRetryState(() => 0.5);
    // 1 free + MAX_HARD_RETRIES hard = MAX_HARD_RETRIES+1 retries, then surface.
    for (let i = 0; i < MAX_HARD_RETRIES + 1; i += 1) {
      expect(rs.decide(transient("rate-limited", 2000)).kind).toBe("retry");
    }
    const last = rs.decide(transient("rate-limited", 2000));
    expect(last.kind).toBe("surface");
    if (last.kind === "surface") {
      expect(last.detail).toContain(`${MAX_HARD_RETRIES}`);
    }
  });

  it("grows the backoff across attempts (jittered, deterministic with injected random)", () => {
    const rs = new BackendRetryState(() => 0.5); // jitter factor 0.75
    const first = rs.decide(transient("network", 800));
    const second = rs.decide(transient("network", 800));
    expect(first.kind).toBe("retry");
    expect(second.kind).toBe("retry");
    if (first.kind === "retry" && second.kind === "retry") {
      // attempt 1: 800 * 2^0 * 0.75 = 600; attempt 2: 800 * 2^1 * 0.75 = 1200.
      expect(first.backoffMs).toBe(600);
      expect(second.backoffMs).toBe(1200);
    }
  });
});
