import { expect, it } from "vitest";
import { createProtocolAdapter } from "./protocols/index.js";
import { encode } from "./protocols/encode.js";
import { citedOutput } from "./protocols/search-citations.js";
import { webSearchSupport } from "./web-search.js";
import type { ModelRequest, ProviderConfig, ModelEvent } from "./contracts.js";
const config: ProviderConfig = {
  id: "p",
  name: "test",
  protocol: "openai-responses",
  baseURL: "https://api.openai.com/v1",
  authentication: "api-key",
  credentialRef: "x",
  allowRemoteHTTP: false,
  models: [],
  defaults: { model: "gpt-4.1", timeoutMs: 3000 },
  revision: 1,
};
const request = (): ModelRequest => ({
  sessionId: "s",
  turnId: "t",
  modelId: "gpt-4.1",
  system: "test",
  messages: [{ role: "user", text: "Search" }],
  tools: [],
  options: { webSearch: true },
  signal: new AbortController().signal,
});
const search = {
  type: "web_search_call",
  id: "w1",
  status: "completed",
  action: {
    type: "search",
    query: "Python",
    sources: [{ url: "https://python.org", title: "Python" }],
  },
};
const message = {
  type: "message",
  id: "m1",
  role: "assistant",
  content: [
    {
      type: "output_text",
      text: "Python [1]",
      annotations: [
        {
          type: "url_citation",
          start_index: 7,
          end_index: 10,
          url: "https://python.org",
          title: "Python",
        },
      ],
    },
  ],
};
const frames = () => [
  {
    type: "response.output_item.added",
    item: { type: "web_search_call", id: "w1", status: "in_progress" },
  },
  { type: "response.web_search_call.searching", item_id: "w1" },
  { type: "response.output_item.done", item: search },
  { type: "response.output_text.delta", delta: "Python [1]" },
  { type: "response.output_item.done", item: message },
  {
    type: "response.completed",
    response: {
      status: "completed",
      output: [search, message],
      usage: { input_tokens: 10, output_tokens: 4 },
    },
  },
];
async function collect(
  events: unknown[],
  req = request(),
  sink: ModelEvent[] = [],
) {
  const adapter = createProtocolAdapter(config, "synthetic", {
    fetch: async () =>
      new Response(
        events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } },
      ),
  });
  for await (const e of adapter.stream(req)) sink.push(e);
  return sink;
}
it("enables only official supported Responses models", () => {
  expect(webSearchSupport(config, "gpt-4.1")).toBe(true);
  for (const model of ["gpt-4.1-nano", "unknown", "deepseek-flash"])
    expect(webSearchSupport(config, model)).toBe(false);
  for (const baseURL of [
    "https://api.openai.com.evil/v1",
    "https://proxy.test/v1",
    "http://api.openai.com/v1",
  ])
    expect(webSearchSupport({ ...config, baseURL }, "gpt-4.1")).toBe(false);
  expect(encode(request(), config)).toMatchObject({
    tools: [{ type: "web_search" }],
    max_tool_calls: 3,
    include: ["reasoning.encrypted_content", "web_search_call.action.sources"],
  });
  expect(encode({ ...request(), options: {} }, config)).not.toHaveProperty(
    "max_tool_calls",
  );
  expect(
    encode(
      { ...request(), options: { webSearch: true, maxWebSearchUses: 0 } },
      config,
    ),
  ).not.toHaveProperty("tools");
});
it("returns inline citations, deduplicated search identity, and reusable native history", async () => {
  const events = await collect(frames());
  const text = events
    .filter((e) => e.type === "text-delta")
    .map((e) => e.text)
    .join("");
  expect(text).toBe("Python [来源1](<https://python.org/>)");
  expect(events.some((e) => e.type === "tool-call-ready")).toBe(false);
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "web-search",
      status: "completed",
      query: "Python",
    }),
  );
  const done = events.at(-1);
  expect(done).toMatchObject({ type: "finished", reason: "stop" });
  expect(() =>
    encode(
      {
        ...request(),
        messages: [
          ...request().messages,
          { role: "assistant", text, toolCalls: [] },
        ],
        nativeContext:
          done?.type === "finished" ? done.nativeContext : undefined,
      },
      config,
    ),
  ).not.toThrow();
});
it("rejects unsolicited search and over-budget calls", async () => {
  await expect(
    collect(frames(), { ...request(), options: {} }),
  ).rejects.toThrow();
  await expect(
    collect(
      [
        { type: "response.output_item.added", item: search },
        { type: "response.output_item.added", item: { ...search, id: "w2" } },
      ],
      { ...request(), options: { webSearch: true, maxWebSearchUses: 1 } },
    ),
  ).rejects.toMatchObject({ code: "search-limit" });
});
it("preserves partial text on stream loss and incomplete results", async () => {
  const saved: ModelEvent[] = [];
  await expect(
    collect(frames().slice(0, 4), request(), saved),
  ).rejects.toThrow();
  expect(saved).toContainEqual({ type: "text-delta", text: "Python [1]" });
  const events = frames();
  events[events.length - 1] = {
    type: "response.incomplete",
    response: {
      incomplete_details: { reason: "max_output_tokens" },
      output: [message],
    },
  } as any;
  expect((await collect(events)).at(-1)).toMatchObject({
    type: "finished",
    reason: "length",
  });
});
it("renders safe fallback citations without injecting titles or unsafe URLs", () => {
  const result = citedOutput([
    {
      ...message,
      content: [
        {
          type: "output_text",
          text: "Answer",
          annotations: [
            { type: "url_citation", url: "javascript:alert(1)" },
            {
              type: "url_citation",
              url: "https://example.com",
              title: "[evil](javascript:x)",
              start_index: 999,
              end_index: 1000,
            },
          ],
        },
      ],
    },
  ]);
  expect(result.text).toBe("Answer\n\n[来源1](<https://example.com/>)");
  expect(result.text).not.toContain("evil");
});
it("does not fabricate a search success from an incomplete search", async () => {
  const events = frames();
  events[2] = {
    type: "response.output_item.done",
    item: { ...search, status: "failed" },
  };
  events[events.length - 1] = {
    type: "response.completed",
    response: {
      status: "completed",
      output: [{ ...search, status: "failed" }, message],
    },
  } as any;
  expect(await collect(events)).toContainEqual(
    expect.objectContaining({
      type: "web-search",
      status: "failed",
      error: "search_failed",
    }),
  );
});
