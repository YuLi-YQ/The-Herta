import { mkdtemp, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { beginNeutralUsage, readNeutralMetrics } from "./neutral-usage.js";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
async function path() {
  const p = await mkdtemp(join(tmpdir(), "herta-usage-"));
  dirs.push(p);
  return join(p, "usage.jsonl");
}
const scope = {
  sessionId: "s",
  turnId: "t",
  protocol: "openai-chat-completions" as const,
  modelId: "anything",
  role: "persona" as const,
  baseURL: "https://api.deepseek.com",
};
it("deduplicates cumulative usage and counts cache only once", async () => {
  const p = await path();
  const tracker = beginNeutralUsage(p, scope);
  tracker.record({
    type: "usage",
    inputTokens: 100,
    outputTokens: 5,
    cacheHitInputTokens: 80,
  });
  tracker.record({
    type: "usage",
    inputTokens: 100,
    outputTokens: 10,
    cacheHitInputTokens: 80,
  });
  await tracker.finish();
  await tracker.finish();
  expect(await readNeutralMetrics(p, "s", ["t"])).toMatchObject({
    totalTokens: 110,
    cacheHitRate: 0.8,
    partial: false,
    contextUsed: 100,
    contextWindow: null,
    outputTokensPerSecond: null,
  });
});
it("does not trust model names or compatible proxy names", async () => {
  const p = await path();
  const t = beginNeutralUsage(p, {
    ...scope,
    baseURL: "https://api.deepseek.com.example.org",
    modelId: "deepseek-flash",
  });
  t.record({ type: "usage", inputTokens: 10, outputTokens: 5 });
  await t.finish();
  expect(await readNeutralMetrics(p, "s")).toMatchObject({
    totalTokens: null,
    partial: true,
  });
});
it("keeps mixed or interrupted usage incomplete and preserves actual zero", async () => {
  const p = await path();
  const t = beginNeutralUsage(p, scope);
  t.record({ type: "usage", inputTokens: 0, outputTokens: 0 });
  await t.finish();
  expect(await readNeutralMetrics(p, "s")).toMatchObject({
    totalTokens: 0,
    cacheHitRate: null,
    partial: false,
  });
  const missing = beginNeutralUsage(p, { ...scope, turnId: "other" });
  await missing.finish();
  expect(await readNeutralMetrics(p, "s")).toMatchObject({
    totalTokens: null,
    partial: true,
  });
  expect(await readNeutralMetrics(p, "s", ["t"])).toMatchObject({
    totalTokens: 0,
    partial: false,
  });
});
it("does not treat legacy records as a full total", async () => {
  const p = await path();
  const t = beginNeutralUsage(p, scope);
  t.record({ type: "usage", inputTokens: 1, outputTokens: 2 });
  await t.finish();
  await appendFile(
    p,
    JSON.stringify({ sessionId: "s", turnId: "t", prompt: 1, completion: 2 }) +
      "\n",
  );
  expect((await readNeutralMetrics(p, "s")).totalTokens).toBeNull();
});
