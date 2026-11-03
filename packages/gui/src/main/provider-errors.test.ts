import { expect, it } from "vitest";
import { safeProviderFailure } from "./provider-errors.js";

it.each([
  [{ code: "search-limit" }, "search-limit", "stream"],
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
  [{ providerCode: "image-rejected", status: 400 }, "image-rejected", "request"],
  [{ code: "image-too-large", status: 413 }, "image-too-large", "request"],
  // R110: a status alone says nothing about pictures; only the driver's or chat's code does.
  [{ status: 400 }, "service-unavailable", "request"],
  [{ status: 413 }, "service-unavailable", "request"],
  [{ status: 415 }, "service-unavailable", "request"],
  [{ status: 422 }, "service-unavailable", "request"],
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
  "image-rejected",
  "image-too-large",
] as const)("preserves normalized %s across main process forwarding", (code) => {
  expect(
    safeProviderFailure({ code, message: "untrusted-remote-message" }).code,
  ).toBe(code);
});
it("words a refused request with pictures without claiming why, and keeps its status (R110)", () => {
  const rejected = safeProviderFailure({ providerCode: "image-rejected", status: 422 });
  expect(rejected).toMatchObject({ code: "image-rejected", status: 422, action: "configure" });
  expect(rejected.message).toContain("原因未确认");
  expect(rejected.message).toContain("识图能力没有被自动更改");
  expect(rejected.message).toContain("重新测试识图");
  expect(rejected.message).toContain("不会自动重发");
  expect(rejected.message).not.toMatch(/不支持识图|未通过识图/);
  const large = safeProviderFailure({ providerCode: "image-too-large", status: 413 });
  expect(large).toMatchObject({ code: "image-too-large", status: 413, action: "retry" });
  expect(large.message).toContain("这不说明模型不支持识图");
});
it("words a workbench message stopped because neither model can read its pictures (F02 design 2.8)", () => {
  const stopped = safeProviderFailure({ code: "image-unsupported" });
  expect(stopped).toMatchObject({
    code: "image-unsupported",
    action: "configure",
  });
  expect(stopped.message).toContain("黑塔对话模型和执行模型都未通过识图检测");
  expect(stopped.message).toContain(
    "若只有执行模型通过，图片随委派发给执行模型，黑塔看不到",
  );
  expect(stopped.message).toContain("直接再发一次将不附带图片");
});
it("directs a local goal read failure to goal recovery without copying raw file details", () => {
  const result = safeProviderFailure({ code: "goal-damaged", message: "private goal data" });
  expect(result).toMatchObject({ code: "goal-damaged", stage: "configuration", action: "goal" });
  expect(result.message).toContain("/goal");
  expect(result.message).not.toContain("private goal data");
});
