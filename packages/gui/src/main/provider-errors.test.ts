import { expect, it } from "vitest";
import { safeProviderFailure } from "./provider-errors.js";

it.each([
  [{ status: 401 }, "authentication", "request"],
  [{ status: 403 }, "authentication", "request"],
  [{ status: 404 }, "model-not-found", "request"],
  [{ status: 429 }, "rate-limit", "request"],
  [{ code: "stall" }, "timeout", "request"],
  [{ name: "TimeoutError" }, "timeout", "request"],
  [{ providerCode: "sse" }, "stream-interrupted", "stream"],
  [{ code: "tool-args" }, "protocol-incompatible", "stream"],
  [{ name: "AbortError" }, "cancelled", "request"],
  [{ code: "network-tls" }, "network", "request"],
  [{ code: "network" }, "network", "request"],
  [null, "service-unavailable", "request"],
] as const)("returns a finite safe classification for %j", (error, code, stage) => {
  expect(safeProviderFailure(error)).toMatchObject({ code, stage });
});
it("never returns remote messages, bodies, headers or invalid status values", () => {
  const secret = "synthetic-secret-do-not-leak";
  const result = safeProviderFailure({
    status: Infinity,
    message: secret,
    body: secret,
    headers: { authorization: secret },
    code: secret,
  });
  expect(result.status).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(safeProviderFailure({ status: 401, message: secret }).status).toBe(
    401,
  );
});
it.each([
  "tool-json", "tool-schema", "tool-unknown", "tool-limit", "tool-identity", "tool-truncated",
  "authentication",
  "model-not-found",
  "rate-limit",
  "timeout",
  "stream-interrupted",
  "protocol-incompatible",
  "cancelled",
  "network",
  "service-unavailable",
] as const)("preserves normalized %s across main process forwarding", (code) => {
  expect(
    safeProviderFailure({ code, message: "untrusted-remote-message" }).code,
  ).toBe(code);
});
