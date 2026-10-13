import { describe, expect, it } from "vitest";
import { createProtocolAdapter } from "./protocols/index.js";
import { encode } from "./protocols/encode.js";
import {
  webSearchSupport,
  webSource,
  mergeSearchEvent,
  type WebSearchEvent,
} from "./web-search.js";
import type { ModelRequest, ProviderConfig } from "./contracts.js";
const config: ProviderConfig = {
  id: "p",
  name: "test",
  protocol: "anthropic-messages",
  baseURL: "https://api.deepseek.com/anthropic",
  authentication: "api-key",
  credentialRef: "x",
  allowRemoteHTTP: false,
  models: [],
  defaults: { model: "deepseek-flash", timeoutMs: 3000 },
  revision: 1,
};
const request = (): ModelRequest => ({
  sessionId: "s",
  turnId: "t",
  modelId: "deepseek-flash",
  system: "test",
  messages: [{ role: "user", text: "Search" }],
  tools: [],
  options: { webSearch: true },
  signal: new AbortController().signal,
});
const frames = (error = false) => [
  { type: "message_start", message: { usage: { input_tokens: 10 } } },
  {
    type: "content_block_start",
    index: 0,
    content_block: {
      type: "server_tool_use",
      id: "search1",
      name: "web_search",
      input: {},
    },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: '{"query":"hello"}' },
  },
  { type: "content_block_stop", index: 0 },
  {
    type: "content_block_start",
    index: 1,
    content_block: {
      type: "web_search_tool_result",
      tool_use_id: "search1",
      content: error
        ? { type: "web_search_tool_result_error", error_code: "unavailable" }
        : [
            {
              type: "web_search_result",
              url: "https://example.com",
              title: "Example",
              encrypted_content: "opaque",
            },
          ],
    },
  },
  { type: "content_block_stop", index: 1 },
  {
    type: "content_block_start",
    index: 2,
    content_block: { type: "text", text: "" },
  },
  {
    type: "content_block_delta",
    index: 2,
    delta: { type: "text_delta", text: "Answer" },
  },
  {
    type: "content_block_delta",
    index: 2,
    delta: {
      type: "citations_delta",
      citation: {
        type: "web_search_result_location",
        url: "https://example.com",
        title: "Example",
        encrypted_index: "opaque",
      },
    },
  },
  { type: "content_block_stop", index: 2 },
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { output_tokens: 5 },
  },
  { type: "message_stop" },
];
async function collect(events: unknown[], req = request()) {
  const adapter = createProtocolAdapter(config, "synthetic", {
    fetch: async () =>
      new Response(
        events.map((e) => "data: " + JSON.stringify(e) + "\n\n").join(""),
        { headers: { "content-type": "text/event-stream" } },
      ),
  });
  const result = [];
  for await (const event of adapter.stream(req)) result.push(event);
  return result;
}
describe("native search boundary", () => {
  it("supports only adapted official route and models", () => {
    expect(webSearchSupport(config, "deepseek-flash")).toBe(true);
    for (const baseURL of [
      "https://api.deepseek.com.evil/anthropic",
      "https://api.deepseek.com/Anthropic",
      "https://api.deepseek.com:444/anthropic",
      "https://user@api.deepseek.com/anthropic",
    ])
      expect(webSearchSupport({ ...config, baseURL }, "deepseek-flash")).toBe(
        false,
      );
    expect(
      webSearchSupport(
        { ...config, protocol: "openai-chat-completions" },
        "deepseek-flash",
      ),
    ).toBe(false);
    expect(webSearchSupport(config, "unknown")).toBe(false);
  });
  it("omits search when off and rejects unsupported on", () => {
    const req = request();
    expect(encode(req, config)).toMatchObject({
      tools: [{ type: "web_search_20250305", max_uses: 3 }],
    });
    expect(encode({ ...req, options: {} }, config)).not.toHaveProperty("tools");
    expect(() =>
      encode(req, { ...config, baseURL: "https://proxy.example" }),
    ).toThrow();
  });
  it("does not execute server tools; preserves private blocks for continuation", async () => {
    const result = await collect(frames());
    expect(
      result.some(
        (e) =>
          e.type === "tool-call-ready" || e.type === "tool-arguments-delta",
      ),
    ).toBe(false);
    const items: WebSearchEvent[] = [];
    for (const e of result)
      if (e.type === "web-search") mergeSearchEvent(items, e);
    expect(items[0]).toMatchObject({
      status: "completed",
      query: "hello",
      sources: [{ url: "https://example.com/", title: "Example" }],
    });
    const done = result.find((e) => e.type === "finished");
    expect(JSON.stringify(done)).toContain("encrypted_content");
    expect(JSON.stringify(items)).not.toContain("opaque");
  });
  it("rejects unsolicited search while off", async () => {
    await expect(
      collect(frames(), { ...request(), options: {} }),
    ).rejects.toThrow();
  });
  it("retains failed search separately from response completion", async () => {
    const r = await collect(frames(true));
    expect(r).toContainEqual(
      expect.objectContaining({
        type: "web-search",
        status: "failed",
        error: "unavailable",
      }),
    );
    expect(r.at(-1)).toMatchObject({ type: "finished", reason: "stop" });
  });
  it("rejects unsafe source schemes and credentials", () => {
    for (const url of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "https://key:secret@example.com",
    ])
      expect(webSource({ url })).toBeNull();
  });
});

const responseFor = (items: unknown[]) =>
  new Response(items.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
const paused = () =>
  frames().map((e) =>
    e.type === "message_delta"
      ? { ...e, delta: { stop_reason: "pause_turn" } }
      : e,
  );
it("continues pause with exact native blocks and combined usage/context", async () => {
  const bodies: any[] = [];
  const adapter = createProtocolAdapter(config, "synthetic", {
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return responseFor(
        bodies.length === 1
          ? paused()
          : frames().map((e) =>
              JSON.parse(JSON.stringify(e).replaceAll("search1", "search2")),
            ),
      );
    },
  });
  const events = [];
  for await (const e of adapter.stream(request())) events.push(e);
  expect(bodies).toHaveLength(2);
  expect(bodies[1].tools[0].max_uses).toBe(2);
  expect(
    bodies[1].messages.at(-1).content[1].content[0].encrypted_content,
  ).toBe("opaque");
  expect(
    events
      .filter((e) => e.type === "text-delta")
      .map((e) => e.text)
      .join(""),
  ).toBe("AnswerAnswer");
  expect(events.filter((e) => e.type === "finished")).toHaveLength(1);
  expect(events.filter((e) => e.type === "usage").at(-1)).toMatchObject({
    inputTokens: 20,
  });
  const done = events.at(-1);
  const next = {
    ...request(),
    messages: [
      ...request().messages,
      { role: "assistant" as const, text: "AnswerAnswer", toolCalls: [] },
    ],
    nativeContext: done?.type === "finished" ? done.nativeContext : undefined,
  };
  expect(() => encode(next, config)).not.toThrow();
  expect(JSON.stringify(encode(next, config))).toContain("encrypted_content");
});
it("stops bounded pauses and preserves partial text without a finished event", async () => {
  let n = 0;
  const seen: any[] = [];
  const adapter = createProtocolAdapter(config, "synthetic", {
    fetch: async () => {
      n++;
      return responseFor(paused());
    },
  });
  await expect(
    (async () => {
      for await (const e of adapter.stream(request())) seen.push(e);
    })(),
  ).rejects.toMatchObject({ code: "search-limit" });
  expect(n).toBe(3);
  expect(seen.filter((e) => e.type === "text-delta")).toHaveLength(3);
  expect(seen.some((e) => e.type === "finished")).toBe(false);
});
it("does not continue cancelled pauses or retry failed requests", async () => {
  const controller = new AbortController();
  let n = 0;
  const adapter = createProtocolAdapter(config, "synthetic", {
    fetch: async () => {
      n++;
      return responseFor(paused());
    },
  });
  await expect(
    (async () => {
      for await (const e of adapter.stream({
        ...request(),
        signal: controller.signal,
      })) {
        if (e.type === "usage") controller.abort();
      }
    })(),
  ).rejects.toThrow();
  expect(n).toBe(1);
  const failed = createProtocolAdapter(config, "synthetic", {
    fetch: async () => {
      n++;
      return new Response("no", { status: 503 });
    },
  });
  await expect(
    (async () => {
      for await (const _e of failed.stream(request())) {
      }
    })(),
  ).rejects.toThrow();
  expect(n).toBe(2);
});
it("omits exhausted search tool and validates budgets", () => {
  expect(
    encode(
      { ...request(), options: { webSearch: true, maxWebSearchUses: 0 } },
      config,
    ),
  ).not.toHaveProperty("tools");
  for (const maxWebSearchUses of [-1, 4, 1.5, NaN])
    expect(() =>
      encode(
        { ...request(), options: { webSearch: true, maxWebSearchUses } },
        config,
      ),
    ).toThrow();
});
