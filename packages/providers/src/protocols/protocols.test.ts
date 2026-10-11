import { encode } from "./encode.js";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import type {
  ModelEvent,
  ModelRequest,
  ProviderConfig,
  ProviderProtocol,
} from "../contracts.js";
import { createProtocolAdapter } from "./index.js";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function all<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const modes: ProviderProtocol[] = [
  "openai-responses",
  "openai-chat-completions",
  "anthropic-messages",
];
it("exposes Responses summary deltas without exposing encrypted continuation", async () => {
  const events = textEvents("openai-responses");
  events.unshift({
    type: "response.reasoning_summary_text.delta",
    delta: "A public summary",
  });
  const result = await collect("openai-responses", events);
  expect(result.filter((e) => e.type === "public-reasoning-delta")).toEqual([
    {
      type: "public-reasoning-delta",
      text: "A public summary",
      format: "summary",
    },
  ]);
});
it.each(
  modes,
)("%s accepts a configured 127.0.0.2 loopback root over an actual socket without remote HTTP consent", async (protocol) => {
  const urls: string[] = [];
  const server = createServer((req, res) => {
    urls.push(req.url ?? "");
    if (req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "manual-id" }] }));
      return;
    }
    const events =
      protocol === "openai-responses"
        ? [
            { type: "response.output_text.delta", delta: "loopback" },
            {
              type: "response.completed",
              response: { status: "completed", output: [] },
            },
          ]
        : protocol === "openai-chat-completions"
          ? [
              {
                choices: [
                  {
                    index: 0,
                    delta: { content: "loopback" },
                    finish_reason: null,
                  },
                ],
              },
              { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
              "[DONE]",
            ]
          : [
              {
                type: "message_start",
                message: { usage: { input_tokens: 1, output_tokens: 0 } },
              },
              {
                type: "content_block_start",
                index: 0,
                content_block: { type: "text", text: "" },
              },
              {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: "loopback" },
              },
              { type: "content_block_stop", index: 0 },
              { type: "message_delta", delta: { stop_reason: "end_turn" } },
              { type: "message_stop" },
            ];
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      events
        .map(
          (event) =>
            `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`,
        )
        .join(""),
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.2", done));
  try {
    const adapter = createProtocolAdapter(
      {
        ...config(protocol),
        baseURL: `http://127.0.0.2:${(server.address() as AddressInfo).port}/gateway/v1/`,
        authentication: "none",
        credentialRef: null,
      },
      null,
      { fetch },
    );
    expect(
      (await adapter.listModels({ signal: new AbortController().signal }))
        .models,
    ).toEqual([{ id: "manual-id" }]);
    const events = await all(adapter.stream(request()));
    expect(events).toContainEqual({ type: "text-delta", text: "loopback" });
    expect(events.at(-1)).toMatchObject({ type: "finished", reason: "stop" });
    expect(urls).toEqual([
      "/gateway/v1/models",
      protocol === "openai-responses"
        ? "/gateway/v1/responses"
        : protocol === "openai-chat-completions"
          ? "/gateway/v1/chat/completions"
          : "/gateway/v1/messages",
    ]);
  } finally {
    await close(server);
  }
});
function config(protocol: ProviderProtocol): ProviderConfig {
  return {
    id: "provider",
    name: "Gateway",
    protocol,
    baseURL: "https://gateway.invalid/prefix/v1/",
    authentication: "api-key",
    credentialRef: "ref",
    allowRemoteHTTP: false,
    models: [],
    defaults: { model: "manual-id", timeoutMs: 2000 },
    revision: 1,
  };
}
function request(): ModelRequest {
  return {
    sessionId: "session",
    turnId: "turn",
    modelId: "manual-id",
    system: "Neutral persona",
    messages: [{ role: "user", text: "hello" }],
    tools: [
      {
        name: "check",
        description: "No side effect",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string", minLength: 1 } },
          required: ["value"],
          additionalProperties: false,
        },
      },
    ],
    options: { maxOutputTokens: 128 },
    signal: new AbortController().signal,
  };
}
function response(events: unknown[], extra = ""): Response {
  const wire =
    events
      .map(
        (e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\r\n\r\n`,
      )
      .join("") + extra;
  // Deliberately split every UTF-8 byte, not just JS strings.
  const bytes = new TextEncoder().encode(wire);
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}
async function collect(
  protocol: ProviderProtocol,
  events: unknown[],
  req = request(),
): Promise<ModelEvent[]> {
  const adapter = createProtocolAdapter(
    config(protocol),
    "synthetic-fixture-key",
    { fetch: vi.fn(async () => response(events)) },
  );
  return all(adapter.stream(req));
}
function textEvents(protocol: ProviderProtocol): unknown[] {
  if (protocol === "openai-responses")
    return [
      { type: "response.output_text.delta", delta: "黑塔" },
      {
        type: "response.completed",
        response: {
          status: "completed",
          output: [],
          usage: { input_tokens: 3, output_tokens: 2 },
        },
      },
    ];
  if (protocol === "openai-chat-completions")
    return [
      {
        choices: [
          { index: 0, delta: { content: "黑塔" }, finish_reason: null },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } },
      "[DONE]",
    ];
  return [
    {
      type: "message_start",
      message: { usage: { input_tokens: 3, output_tokens: 0 } },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "黑塔" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 2 },
    },
    { type: "message_stop" },
  ];
}
function toolEvents(
  protocol: ProviderProtocol,
  args = '{"value":"ok"}',
): unknown[] {
  const cut = Math.floor(args.length / 2);
  if (protocol === "openai-responses")
    return [
      {
        type: "response.output_item.added",
        item: {
          type: "function_call",
          id: "item1",
          call_id: "call1",
          name: "check",
          arguments: "",
        },
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "item1",
        delta: args.slice(0, cut),
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "item1",
        delta: args.slice(cut),
      },
      {
        type: "response.function_call_arguments.done",
        item_id: "item1",
        arguments: args,
      },
      {
        type: "response.output_item.done",
        item: {
          type: "function_call",
          id: "item1",
          call_id: "call1",
          name: "check",
          arguments: args,
        },
      },
      {
        type: "response.completed",
        response: {
          status: "completed",
          output: [
            {
              type: "function_call",
              id: "item1",
              call_id: "call1",
              name: "check",
              arguments: args,
            },
          ],
        },
      },
    ];
  if (protocol === "openai-chat-completions")
    return [
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call1",
                  type: "function",
                  function: { name: "check", arguments: args.slice(0, cut) },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: args.slice(cut) } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      "[DONE]",
    ];
  return [
    { type: "message_start", message: { usage: { input_tokens: 4 } } },
    {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "call1",
        name: "check",
        input: {},
      },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: args.slice(0, cut) },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: args.slice(cut) },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 8 },
    },
    { type: "message_stop" },
  ];
}
describe.each(
  modes,
)("%s deterministic wire adapter (not real API acceptance)", (protocol) => {
  it("encodes prefix URL, own authentication and protocol request without prefill", async () => {
    const fetch = vi.fn(async () => response(textEvents(protocol)));
    const adapter = createProtocolAdapter(
      config(protocol),
      "synthetic-fixture-key",
      { fetch },
    );
    await all(adapter.stream(request()));
    const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.href).toBe(
      `https://gateway.invalid/prefix/v1/${protocol === "openai-responses" ? "responses" : protocol === "openai-chat-completions" ? "chat/completions" : "messages"}`,
    );
    expect(init.redirect).toBe("error");
    const headers = new Headers(init.headers);
    expect(
      headers.get(
        protocol === "anthropic-messages" ? "x-api-key" : "authorization",
      ),
    ).toBe(
      protocol === "anthropic-messages"
        ? "synthetic-fixture-key"
        : "Bearer synthetic-fixture-key",
    );
    expect(
      headers.has(
        protocol === "anthropic-messages" ? "authorization" : "x-api-key",
      ),
    ).toBe(false);
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("manual-id");
    expect(body.stream).toBe(true);
    expect(body.previous_response_id).toBeUndefined();
    expect(body.prompt).toBeUndefined();
  });
  it("streams split UTF-8 text and usage with real completion marker", async () => {
    const events = await collect(protocol, textEvents(protocol));
    expect(events).toContainEqual({ type: "text-delta", text: "黑塔" });
    expect(events).toContainEqual({
      type: "usage",
      inputTokens: 3,
      outputTokens: 2,
    });
    expect(events.at(-1)).toMatchObject({ type: "finished", reason: "stop" });
  });
  it("collects argument fragments and releases one schema-valid call", async () => {
    const events = await collect(protocol, toolEvents(protocol));
    expect(
      events.filter((e) => e.type === "tool-arguments-delta"),
    ).toHaveLength(2);
    expect(events.filter((e) => e.type === "tool-call-ready")).toEqual([
      {
        type: "tool-call-ready",
        call: { id: "call1", tool: "check", input: { value: "ok" } },
      },
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "finished",
      reason: "tool-calls",
    });
  });
  it.each([
    '{"value":',
    '{"wrong":"ok"}',
    '{"value":9}',
    '{"value":""}',
    '{"value":"ok","extra":true}',
  ])("rejects invalid JSON/schema %s", async (args) => {
    await expect(
      collect(protocol, toolEvents(protocol, args)),
    ).rejects.toMatchObject({ code: args === '{"value":' ? "tool-json" : "tool-schema", retryable: false });
  });
  it("does not authorize tools on stream loss", async () => {
    const events = toolEvents(protocol).slice(0, -2);
    const emitted: ModelEvent[] = [];
    const adapter = createProtocolAdapter(config(protocol), "fixture", {
      fetch: vi.fn(async () => response(events)),
    });
    await expect(
      (async () => {
        for await (const event of adapter.stream(request()))
          emitted.push(event);
      })(),
    ).rejects.toMatchObject({ code: "sse", retryable: false });
    expect(
      emitted.some(
        (e) => e.type === "tool-call-ready" || e.type === "finished",
      ),
    ).toBe(false);
  });
  it("encodes matched tool results for continuation", async () => {
    const req = {
      ...request(),
      messages: [
        { role: "user" as const, text: "check" },
        {
          role: "assistant" as const,
          text: "",
          toolCalls: [{ id: "call1", tool: "check", input: { value: "ok" } }],
        },
        {
          role: "tool" as const,
          toolCallId: "call1",
          result: { ok: true, summary: "done", modelText: "exact result" },
        },
      ],
    };
    const fetch = vi.fn(async () => response(textEvents(protocol)));
    await all(
      createProtocolAdapter(config(protocol), "fixture", { fetch }).stream(req),
    );
    const body = JSON.parse(
      (fetch.mock.calls[0] as unknown as [URL, RequestInit])[1].body as string,
    );
    expect(JSON.stringify(body)).toContain("call1");
    expect(JSON.stringify(body)).toContain("exact result");
    if (protocol === "anthropic-messages")
      expect(body.messages[2].content[0]).toMatchObject({
        type: "tool_result",
        tool_use_id: "call1",
        is_error: false,
      });
  });
  it("lists pagination without inferring generation or tool ability", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ id: "manual-id", display_name: "Alias" }],
            has_more: true,
            last_id: "manual-id",
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const page = await createProtocolAdapter(config(protocol), "fixture", {
      fetch,
    }).listModels({ cursor: "old", signal: new AbortController().signal });
    expect(page).toEqual({
      models: [{ id: "manual-id", alias: "Alias" }],
      nextCursor: "manual-id",
    });
    const url = (fetch.mock.calls[0] as unknown as [URL, RequestInit])[0];
    expect(url.pathname).toBe("/prefix/v1/models");
    expect(
      url.searchParams.get(
        protocol === "anthropic-messages" ? "after_id" : "after",
      ),
    ).toBe("old");
  });
  it.each([
    403, 404, 429, 500,
  ])("returns redacted HTTP %s with no retry", async (status) => {
    const fetch = vi.fn(
      async () => new Response("secret fixture body", { status }),
    );
    await expect(
      createProtocolAdapter(config(protocol), "fixture", { fetch }).listModels({
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      code: "http",
      status,
      message: `Provider HTTP ${status}`,
      retryable: false,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("rejects missing key without touching the transport", async () => {
    const fetch = vi.fn();
    await expect(
      all(
        createProtocolAdapter(config(protocol), null, { fetch }).stream(
          request(),
        ),
      ),
    ).rejects.toMatchObject({ code: "missing-key" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("allows configured no-auth local service without foreign headers", async () => {
    const fetch = vi.fn(async () => response(textEvents(protocol)));
    await all(
      createProtocolAdapter(
        {
          ...config(protocol),
          authentication: "none",
          baseURL: "http://127.0.0.1:1234/v1",
        },
        null,
        { fetch },
      ).stream(request()),
    );
    const headers = new Headers(
      (fetch.mock.calls[0] as unknown as [URL, RequestInit])[1].headers,
    );
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("x-api-key")).toBe(false);
  });
  it("abort during transport is not finished and never retried", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      controller.abort();
      init?.signal?.throwIfAborted();
      return response([]);
    });
    await expect(
      all(
        createProtocolAdapter(config(protocol), "fixture", { fetch }).stream({
          ...request(),
          signal: controller.signal,
        }),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("disallows another model/provider's native context before network", async () => {
    const fetch = vi.fn();
    const req = {
      ...request(),
      nativeContext: {
        providerId: "other",
        providerRevision: 1,
        protocol,
        modelId: "manual-id",
        opaque: { previous_response_id: "secret-id" },
      },
    };
    await expect(
      all(
        createProtocolAdapter(config(protocol), "fixture", { fetch }).stream(
          req,
        ),
      ),
    ).rejects.toMatchObject({ code: "sse" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    "https://gateway.invalid/prefix/v1/responses",
    "https://user:password@gateway.invalid/v1",
    "https://gateway.invalid/v1?key=x",
    "http://gateway.invalid/v1",
  ])("rejects unsafe API root %s", async (baseURL) => {
    const fetch = vi.fn();
    await expect(
      all(
        createProtocolAdapter({ ...config(protocol), baseURL }, "fixture", {
          fetch,
        }).stream(request()),
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(fetch).not.toHaveBeenCalled();
  });
});
describe("stream replay and completion boundaries", () => {
  it("classifies remote messages with static keywords and sent tool names only", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              message:
                "Invalid schema additionalProperties required for check, unknown_remote_tool, private-secret-payload",
            },
          }),
          { status: 400 },
        ),
    );
    await expect(
      all(
        createProtocolAdapter(config("openai-responses"), "fixture", {
          fetch,
        }).stream(request()),
      ),
    ).rejects.toMatchObject({
      message:
        "Provider HTTP 400 (diagnostic=field:schema|field:additionalProperties|field:required|tool:check)",
    });
  });
  it("exposes only allowlisted HTTP error identifiers, never remote messages or credentials", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "invalid_schema",
              type: "invalid_request_error",
              param: "tools[0].parameters",
              message: "remote-secret-message synthetic-fixture-key",
              request: "private",
            },
          }),
          { status: 400 },
        ),
    );
    await expect(
      all(
        createProtocolAdapter(
          config("openai-responses"),
          "synthetic-fixture-key",
          { fetch },
        ).stream(request()),
      ),
    ).rejects.toMatchObject({
      message:
        "Provider HTTP 400 (code=invalid_schema, type=invalid_request_error, param=tools[0].parameters)",
    });
    const secret = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "synthetic-fixture-key",
              type: "invalid request with spaces",
              param: "https://private.invalid/key?q=secret",
              message: "secret",
            },
          }),
          { status: 400 },
        ),
    );
    await expect(
      all(
        createProtocolAdapter(
          config("openai-responses"),
          "synthetic-fixture-key",
          { fetch: secret },
        ).stream(request()),
      ),
    ).rejects.toMatchObject({ message: "Provider HTTP 400" });
  });
  it.each(
    modes,
  )("keeps %s private reasoning on same-owner continuation only", async (protocol) => {
    const events = toolEvents(protocol);
    if (protocol === "openai-responses") {
      const last = events.at(-1) as { response: { output: unknown[] } };
      last.response.output.unshift({
        type: "reasoning",
        id: "reason1",
        summary: [],
        encrypted_content: "opaque-reasoning",
      });
    } else if (protocol === "openai-chat-completions") {
      const first = events[0] as {
        choices: { delta: Record<string, unknown> }[];
      };
      first.choices[0]!.delta.reasoning_content = "opaque-reasoning";
    } else
      events.splice(
        1,
        0,
        {
          type: "content_block_start",
          index: 7,
          content_block: { type: "thinking", thinking: "" },
        },
        {
          type: "content_block_delta",
          index: 7,
          delta: { type: "thinking_delta", thinking: "opaque-reasoning" },
        },
        {
          type: "content_block_delta",
          index: 7,
          delta: { type: "signature_delta", signature: "opaque-signature" },
        },
        { type: "content_block_stop", index: 7 },
      );
    const received = await collect(protocol, events);
    expect(received.filter((e) => e.type === "text-delta")).toHaveLength(0);
    const publicReasoning = received.filter(
      (e) => e.type === "public-reasoning-delta",
    );
    expect(publicReasoning).toHaveLength(
      protocol === "openai-responses" ? 0 : 1,
    );
    expect(JSON.stringify(publicReasoning)).not.toContain("opaque-signature");
    const finish = received.at(-1);
    if (finish?.type !== "finished") throw new Error("not finished");
    expect(finish.nativeContext).toMatchObject({
      providerId: "provider",
      providerRevision: 1,
      protocol,
      modelId: "manual-id",
    });
    const messages = [
      ...request().messages,
      {
        role: "assistant" as const,
        text: "",
        toolCalls: [{ id: "call1", tool: "check", input: { value: "ok" } }],
      },
      {
        role: "tool" as const,
        toolCallId: "call1",
        result: { ok: true, summary: "done" },
      },
    ];
    const fetch = vi.fn(async () => response(textEvents(protocol)));
    await all(
      createProtocolAdapter(config(protocol), "fixture", { fetch }).stream({
        ...request(),
        messages,
        nativeContext: finish.nativeContext,
      }),
    );
    const init = (fetch.mock.calls[0] as unknown as [URL, RequestInit])[1];
    expect(init.body).toContain("opaque-reasoning");
    if (protocol === "anthropic-messages")
      expect(init.body).toContain("opaque-signature");
    const noNative = vi.fn(async () => response(textEvents(protocol)));
    await all(
      createProtocolAdapter(config(protocol), "fixture", {
        fetch: noNative,
      }).stream({ ...request(), messages }),
    );
    expect(
      (noNative.mock.calls[0] as unknown as [URL, RequestInit])[1].body,
    ).not.toContain("opaque-reasoning");
    await expect(
      all(
        createProtocolAdapter({ ...config(protocol), revision: 2 }, "fixture", {
          fetch,
        }).stream({
          ...request(),
          messages,
          nativeContext: finish.nativeContext,
        }),
      ),
    ).rejects.toMatchObject({ code: "sse" });
    await expect(
      all(
        createProtocolAdapter(config(protocol), "fixture", { fetch }).stream({
          ...request(),
          messages: [{ role: "user", text: "changed" }, ...messages.slice(1)],
          nativeContext: finish.nativeContext,
        }),
      ),
    ).rejects.toMatchObject({ code: "sse" });
  });
  it("does not release any earlier valid call when a later call fails schema", async () => {
    const events = toolEvents("openai-chat-completions");
    events.splice(1, 0, {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 1,
                id: "call2",
                function: { name: "check", arguments: '{"wrong":"bad"}' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
    const emitted: ModelEvent[] = [];
    const adapter = createProtocolAdapter(
      config("openai-chat-completions"),
      "fixture",
      { fetch: vi.fn(async () => response(events)) },
    );
    await expect(
      (async () => {
        for await (const event of adapter.stream(request()))
          emitted.push(event);
      })(),
    ).rejects.toMatchObject({ code: "tool-schema" });
    expect(emitted.some((event) => event.type === "tool-call-ready")).toBe(
      false,
    );
  });
  it("deduplicates Responses sequence numbers and repeated completed item", async () => {
    const events = toolEvents("openai-responses");
    const delta = { ...(events[1] as object), sequence_number: 2 };
    events.splice(1, 1, delta, delta);
    const done = events.at(-2);
    events.splice(events.length - 1, 0, done);
    const collected = await collect("openai-responses", events);
    expect(collected.filter((e) => e.type === "tool-call-ready")).toHaveLength(
      1,
    );
  });
  it("conflicting duplicate Responses sequence numbers fail", async () => {
    await expect(
      collect("openai-responses", [
        { type: "response.output_text.delta", sequence_number: 1, delta: "a" },
        { type: "response.output_text.delta", sequence_number: 1, delta: "b" },
      ]),
    ).rejects.toMatchObject({ code: "sse" });
  });
  it("rejects conflicting duplicate call IDs instead of executing twice", async () => {
    const events = toolEvents("openai-chat-completions");
    events.splice(1, 0, {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 1,
                id: "call1",
                function: { name: "check", arguments: '{"value":"other"}' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
    await expect(
      collect("openai-chat-completions", events),
    ).rejects.toMatchObject({ code: "tool-args" });
  });
  it("does not release a truncated tool at length limit", async () => {
    const events = toolEvents("anthropic-messages");
    events[events.length - 2] = {
      type: "message_delta",
      delta: { stop_reason: "max_tokens" },
    };
    await expect(collect("anthropic-messages", events)).rejects.toMatchObject({
      code: "tool-truncated",
    });
  });
  it("rejects a frame cut in the middle, despite a valid earlier text delta", async () => {
    const fetch = vi.fn(async () =>
      response(
        [{ type: "response.output_text.delta", delta: "partial" }],
        'data: {"type":"response.completed"}',
      ),
    );
    await expect(
      all(
        createProtocolAdapter(config("openai-responses"), "fixture", {
          fetch,
        }).stream(request()),
      ),
    ).rejects.toMatchObject({ code: "sse" });
  });
  it("fails closed on unsupported tool-schema constraints", async () => {
    const req = {
      ...request(),
      tools: [
        {
          name: "check",
          description: "schema",
          inputSchema: { type: "object", unevaluatedProperties: false },
        },
      ],
    };
    await expect(
      collect("openai-responses", toolEvents("openai-responses"), req),
    ).rejects.toMatchObject({ code: "tool-args" });
  });
  it("timeout aborts stalled reader and never finishes", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(new ReadableStream({ start() {} }), {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    await expect(
      all(
        createProtocolAdapter(
          {
            ...config("openai-responses"),
            defaults: { model: "manual-id", timeoutMs: 20 },
          },
          "fixture",
          { fetch },
        ).stream(request()),
      ),
    ).rejects.toMatchObject({ code: "stall", retryable: false });
  });
});

describe.each(
  modes,
)("%s real local HTTP transport (deterministic fixture, not service acceptance)", (protocol) => {
  it("posts through a prefixed local root and streams bytes over a socket", async () => {
    const observed: {
      path?: string;
      authorization?: string;
      key?: string;
      body?: unknown;
    } = {};
    const server = createServer(async (req, res) => {
      observed.path = req.url;
      observed.authorization = req.headers.authorization;
      observed.key = req.headers["x-api-key"] as string | undefined;
      let body = "";
      for await (const piece of req) body += piece.toString();
      observed.body = JSON.parse(body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of textEvents(protocol))
        res.write(
          `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`,
        );
      res.end();
    });
    const url = await listen(server);
    try {
      const events = await all(
        createProtocolAdapter(
          { ...config(protocol), baseURL: `${url}/gateway/v1` },
          "synthetic-fixture-key",
          { fetch: globalThis.fetch },
        ).stream(request()),
      );
      expect(events.at(-1)).toMatchObject({ type: "finished", reason: "stop" });
      expect(observed.path).toBe(
        `/gateway/v1/${protocol === "openai-responses" ? "responses" : protocol === "openai-chat-completions" ? "chat/completions" : "messages"}`,
      );
      expect(observed.body).toMatchObject({ stream: true, model: "manual-id" });
      expect(
        protocol === "anthropic-messages"
          ? observed.key
          : observed.authorization,
      ).toBe(
        protocol === "anthropic-messages"
          ? "synthetic-fixture-key"
          : "Bearer synthetic-fixture-key",
      );
    } finally {
      await close(server);
    }
  });
  it("never follows a cross-origin redirect with a credential", async () => {
    let received = 0;
    const target = createServer((_req, res) => {
      received++;
      res.end("unexpected");
    });
    const targetURL = await listen(target);
    const origin = createServer((_req, res) => {
      res.writeHead(307, { location: `${targetURL}/capture` });
      res.end();
    });
    const originURL = await listen(origin);
    try {
      await expect(
        all(
          createProtocolAdapter(
            { ...config(protocol), baseURL: `${originURL}/v1` },
            "synthetic-fixture-key",
            { fetch: globalThis.fetch },
          ).stream(request()),
        ),
      ).rejects.toMatchObject({ code: "network", retryable: false });
      expect(received).toBe(0);
    } finally {
      await close(origin);
      await close(target);
    }
  });
});

it("exposes DeepSeek Responses public reasoning text separately from answer text", async () => {
  const events = textEvents("openai-responses");
  events.unshift({ type: "response.reasoning_text.delta", delta: "Public reasoning" });
  const result = await collect("openai-responses", events);
  expect(result.filter((e) => e.type === "public-reasoning-delta")).toEqual([
    { type: "public-reasoning-delta", text: "Public reasoning", format: "text" },
  ]);
  expect(result.filter((e) => e.type === "text-delta")).not.toContainEqual({ type: "text-delta", text: "Public reasoning" });
});

it.each(["api.deepseek.com", "api.moonshot.cn", "open.bigmodel.cn", "generativelanguage.googleapis.com", "dashscope.aliyuncs.com"])("uses documented Chat token limit for %s without changing custom gateways", (host) => {
  const req = { ...request(), options: { maxOutputTokens: 8192 } };
  const payload = encode(req, { ...config("openai-chat-completions"), baseURL: `https://${host}/v1` });
  expect(payload).toHaveProperty("max_tokens", 8192);
  expect(payload).not.toHaveProperty("max_completion_tokens");
  expect(encode(req, { ...config("openai-chat-completions"), baseURL: "https://gateway.example/v1" })).toHaveProperty("max_completion_tokens", 8192);
});
