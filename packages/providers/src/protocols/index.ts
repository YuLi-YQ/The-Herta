import type {
  ModelEvent,
  ModelPage,
  ModelRequest,
  ProtocolAdapter,
  ProviderConfig,
} from "../contracts.js";
import { ProviderError } from "../errors.js";
import {
  assertRequest,
  count,
  endpoint,
  failure,
  type Json,
  object,
  parse,
  sse,
  string,
  Transport,
} from "./common.js";
import { citedOutput } from "./search-citations.js";
import { encode } from "./encode.js";
import { webSource } from "../web-search.js";
import { nativeOverrides, completedNative } from "./native.js";

function uniqueNativeTools(items: unknown[]): unknown[] {
  const ids = new Set<string>();
  return items.filter((raw) => {
    const item = object(raw);
    const id =
      item.type === "function_call"
        ? string(item.call_id)
        : item.type === "tool_use"
          ? string(item.id)
          : null;
    if (id === null) return true;
    if (ids.has(id)) return false;
    ids.add(id);
    return true;
  });
}

import { validatedCall } from "./schema.js";

interface Pending {
  id: string;
  name: string;
  args: string;
  complete: boolean;
}
type FinishReason = "stop" | "tool-calls" | "length";
type AnthropicEvent =
  | ModelEvent
  | { type: "search-paused"; text: string; wire: unknown[] };
const MODEL_LIST_MAX_BYTES = 2 * 1024 * 1024;
/** Bound untrusted model metadata before JSON parsing or array allocation. */
async function modelListJson(
  response: Response,
  signal: AbortSignal,
): Promise<Json> {
  if (!response.body) throw failure("Model list response body is missing");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MODEL_LIST_MAX_BYTES)
        throw failure("Model list response exceeds 2 MiB limit");
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return object(JSON.parse(text));
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ProviderError) throw error;
    throw failure("Malformed model list");
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
function reason(
  raw: unknown,
  protocol: ProviderConfig["protocol"],
): FinishReason {
  if (raw === "tool_calls" || raw === "tool_use") return "tool-calls";
  if (raw === "length" || raw === "max_tokens" || raw === "max_output_tokens")
    return "length";
  if (
    raw === "stop" ||
    raw === "end_turn" ||
    raw === "stop_sequence" ||
    raw === "completed"
  )
    return "stop";
  throw failure(`Unsupported ${protocol} stop reason`);
}
function usage(raw: unknown): ModelEvent {
  const value = object(raw);
  return {
    type: "usage",
    inputTokens: usageCount(value.input_tokens ?? value.prompt_tokens),
    outputTokens: usageCount(value.output_tokens ?? value.completion_tokens),
    ...(value.prompt_cache_hit_tokens !== undefined ||
    value.input_tokens_details !== undefined ||
    value.prompt_tokens_details !== undefined
      ? {
          cacheHitInputTokens: usageCount(
            value.prompt_cache_hit_tokens ??
              object(value.input_tokens_details ?? value.prompt_tokens_details)
                .cached_tokens,
          ),
        }
      : {}),
  };
}
function usageCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}
function addArgs(call: Pending, delta: string): ModelEvent {
  if (call.complete) throw failure("Arguments arrived after tool completion");
  call.args += delta;
  if (call.args.length > 1_048_576)
    throw failure("Tool arguments exceed limit", "tool-limit");
  return {
    type: "tool-arguments-delta",
    callId: call.id,
    tool: call.name,
    delta,
  };
}
/** One isolated adapter owns one immutable connection. No retry or tool execution. */
export function createProtocolAdapter(
  config: ProviderConfig,
  apiKey: string | null,
  options?: { fetch?: typeof fetch },
): ProtocolAdapter {
  const frozen = structuredClone(config);
  const transport = new Transport(frozen, apiKey, options?.fetch);
  return {
    protocol: frozen.protocol,
    async listModels(input): Promise<ModelPage> {
      const timer = transport.timed(input.signal);
      try {
        const url = endpoint(frozen, "models");
        if (input.cursor)
          url.searchParams.set(
            frozen.protocol === "anthropic-messages" ? "after_id" : "after",
            input.cursor,
          );
        const response = await transport.request(url, timer.signal);
        const data = await modelListJson(response, timer.signal);
        if (!Array.isArray(data.data))
          throw failure("Model list is missing data");
        const seen = new Set<string>();
        const models = data.data.map((value) => {
          const model = object(value),
            id = string(model.id);
          if (!id || seen.has(id))
            throw failure("Invalid or duplicate model ID");
          seen.add(id);
          return {
            id,
            ...(typeof model.display_name === "string"
              ? { alias: model.display_name }
              : {}),
          };
        });
        const cursor =
          data.has_more === true
            ? string(data.last_id ?? models.at(-1)?.id)
            : null;
        if (
          cursor === input.cursor ||
          (data.has_more === true && !models.length)
        )
          throw failure("Model pagination did not advance");
        return { models, nextCursor: cursor };
      } finally {
        timer.dispose();
      }
    },
    async *stream(request): AsyncGenerator<ModelEvent> {
      assertRequest(request, frozen);
      const timer = transport.timed(request.signal);
      try {
        const path =
          frozen.protocol === "openai-responses"
            ? "responses"
            : frozen.protocol === "openai-chat-completions"
              ? "chat/completions"
              : "messages";
        let current = request;
        let text = "";
        const wire: unknown[] = [];
        const calls: import("@herta/core").ToolCallRequest[] = [];
        let remaining = request.options.webSearch
          ? (request.options.maxWebSearchUses ?? 3)
          : 0;
        const total = {
          inputTokens: 0 as number | null,
          outputTokens: 0 as number | null,
          cacheHitInputTokens: 0 as number | null,
        };
        for (let continuation = 0; ; continuation++) {
          timer.signal.throwIfAborted();
          const response = await transport.request(
            endpoint(frozen, path),
            timer.signal,
            encode(current, frozen),
          );
          const events = sse(response, timer.signal);
          if (frozen.protocol === "openai-responses") {
            yield* responses(events, current, frozen);
            return;
          }
          if (frozen.protocol === "openai-chat-completions") {
            yield* chat(events, current, frozen);
            return;
          }
          let paused = false;
          const seen = new Set<string>();
          for await (const event of anthropic(events, current, frozen)) {
            if (
              event.type === "web-search" &&
              event.status === "searching" &&
              !seen.has(event.id)
            ) {
              seen.add(event.id);
              if (remaining <= 0)
                throw new ProviderError({
                  code: "search-limit",
                  message: "Search budget exhausted",
                  retryable: false,
                });
              remaining--;
            }
            if (event.type === "text-delta") text += event.text;
            if (event.type === "tool-call-ready") calls.push(event.call);
            if (event.type === "usage") {
              for (const key of [
                "inputTokens",
                "outputTokens",
                "cacheHitInputTokens",
              ] as const)
                total[key] =
                  total[key] === null || event[key] == null
                    ? null
                    : total[key]! + event[key]!;
              yield continuation === 0 ? event : { type: "usage", ...total };
              continue;
            }
            if (event.type === "search-paused") {
              paused = true;
              wire.push(...event.wire);
              if (continuation >= 2 || remaining <= 0)
                throw new ProviderError({
                  code: "search-limit",
                  message: "Search continuation limit reached",
                  retryable: false,
                });
              const assistant = {
                role: "assistant" as const,
                text,
                toolCalls: [],
              };
              current = {
                ...request,
                messages: [...request.messages, assistant],
                nativeContext: completedNative(
                  frozen,
                  request,
                  text,
                  [],
                  [...wire],
                ),
                options: { ...request.options, maxWebSearchUses: remaining },
              };
              continue;
            }
            if (
              event.type === "finished" &&
              continuation > 0 &&
              event.nativeContext
            ) {
              const transcript = [
                ...current.messages,
                {
                  role: "assistant" as const,
                  text: text.slice(
                    current.messages.length > request.messages.length
                      ? (current.messages.at(-1) as { text: string }).text
                          .length
                      : 0,
                  ),
                  toolCalls: calls,
                },
              ];
              const blocks = nativeOverrides({
                ...current,
                messages: transcript,
                nativeContext: event.nativeContext,
              }).get(current.messages.length);
              if (!Array.isArray(blocks))
                throw failure("Missing search continuation content");
              yield {
                ...event,
                nativeContext: completedNative(frozen, request, text, calls, [
                  ...wire,
                  ...blocks,
                ]),
              };
            } else if (event.type === "web-search" && continuation > 0) {
              yield {
                ...event,
                id: `continuation-${continuation}:${event.id}`,
              };
            } else yield event;
          }
          if (!paused) return;
        }
      } finally {
        timer.dispose();
      }
    },
  };
}
type Frames = AsyncIterable<{ data: string; id: string | null }>;
/** Repeated SSE IDs / Responses sequence numbers are ignored, conflicting ones fail. */
async function* unique(frames: Frames): AsyncGenerator<Json | string> {
  const seen = new Map<string, string>();
  for await (const frame of frames) {
    if (frame.data === "[DONE]") {
      yield frame.data;
      continue;
    }
    const value = parse(frame.data);
    const key =
      frame.id !== null
        ? `id:${frame.id}`
        : typeof value.sequence_number === "number"
          ? `seq:${value.sequence_number}`
          : null;
    if (key !== null) {
      const before = seen.get(key);
      if (before !== undefined) {
        if (before !== frame.data)
          throw failure("Conflicting duplicate stream event");
        continue;
      }
      if (seen.size >= 100_000) throw failure("Stream event limit exceeded");
      seen.set(key, frame.data);
    }
    if (
      value.error ||
      value.type === "error" ||
      value.type === "response.failed"
    )
      throw failure("Provider reported a stream error");
    yield value;
  }
}
function ready(
  call: Pending,
  request: ModelRequest,
  emitted: Map<string, string>,
): ModelEvent | null {
  const parsed = validatedCall(call.id, call.name, call.args, request.tools);
  const signature = JSON.stringify({ tool: parsed.tool, input: parsed.input });
  const previous = emitted.get(call.id);
  if (previous !== undefined) {
    if (previous !== signature)
      throw failure(
        "Duplicate tool ID with conflicting arguments",
        "tool-args",
      );
    return null;
  }
  emitted.set(call.id, signature);
  call.complete = true;
  return { type: "tool-call-ready", call: parsed };
}
async function* chat(
  frames: Frames,
  request: ModelRequest,
  config: ProviderConfig,
): AsyncGenerator<ModelEvent> {
  const calls = new Map<number, Pending>(),
    emitted = new Map<string, string>();
  let text = "",
    reasoning = "",
    finish: FinishReason | null = null,
    done = false;
  for await (const event of unique(frames)) {
    request.signal.throwIfAborted();
    if (event === "[DONE]") {
      done = true;
      break;
    }
    if (typeof event === "string") throw failure("Unexpected stream marker");
    if (event.usage) yield usage(event.usage);
    if (!Array.isArray(event.choices))
      throw failure("Chat stream is missing choices");
    for (const raw of event.choices) {
      const choice = object(raw);
      if (choice.index !== 0) continue;
      const delta = object(choice.delta ?? {});
      if (typeof delta.reasoning_content === "string") {
        reasoning += delta.reasoning_content;
        yield {
          type: "public-reasoning-delta",
          text: delta.reasoning_content,
          format: "text",
        };
      }
      if (typeof delta.refusal === "string" && delta.refusal)
        throw failure("Provider refused this request");
      if (typeof delta.content === "string" && delta.content) {
        if (finish) throw failure("Text after completion");
        text += delta.content;
        yield { type: "text-delta", text: delta.content };
      }
      if (delta.tool_calls !== undefined) {
        if (!Array.isArray(delta.tool_calls) || finish)
          throw failure("Invalid chat tool delta");
        for (const value of delta.tool_calls) {
          const tool = object(value),
            index = tool.index;
          if (
            typeof index !== "number" ||
            !Number.isInteger(index) ||
            index < 0
          )
            throw failure("Tool index is missing");
          let call = calls.get(index);
          const fn = object(tool.function ?? {});
          if (!call) {
            call = {
              id: string(tool.id),
              name: string(fn.name),
              args: "",
              complete: false,
            };
            calls.set(index, call);
          } else if (
            (tool.id !== undefined && tool.id !== call.id) ||
            (fn.name !== undefined && fn.name !== call.name)
          )
            throw failure("Tool identity changed mid-stream");
          if (typeof fn.arguments === "string")
            yield addArgs(call, fn.arguments);
        }
      }
      if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
        const next = reason(choice.finish_reason, "openai-chat-completions");
        if (finish && finish !== next)
          throw failure("Conflicting completion reasons");
        finish = next;
      }
    }
  }
  request.signal.throwIfAborted();
  if (!done || !finish) throw failure("Chat stream ended before completion");
  if (calls.size && finish !== "tool-calls")
    throw failure(
      "Chat tools were not completed",
      finish === "length" ? "tool-truncated" : "sse",
    );
  const validated = [...calls.values()].map((call) =>
    ready(call, request, emitted),
  );
  for (const event of validated) if (event) yield event;
  if (finish === "tool-calls" && !calls.size)
    throw failure("Tool completion contains no calls");
  const toolCalls = validated.flatMap((event) =>
    event?.type === "tool-call-ready" ? [event.call] : [],
  );
  const wire = {
    role: "assistant",
    content: text || null,
    ...(reasoning ? { reasoning_content: reasoning } : {}),
    ...(toolCalls.length
      ? {
          tool_calls: toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: {
              name: call.tool,
              arguments: JSON.stringify(call.input),
            },
          })),
        }
      : {}),
  };
  yield {
    type: "finished",
    reason: finish,
    nativeContext: completedNative(config, request, text, toolCalls, wire),
  };
}
async function* responses(
  frames: Frames,
  request: ModelRequest,
  config: ProviderConfig,
): AsyncGenerator<ModelEvent> {
  const calls = new Map<string, Pending>(),
    emitted = new Map<string, string>();
  let completed = false,
    text = "";
  const output = new Map<string, unknown>();
  const searches = new Map<string, string>();
  let released = false;
  const searchEnabled =
    request.options.webSearch === true &&
    request.options.maxWebSearchUses !== 0;
  function* searchItem(item: Json): Generator<ModelEvent> {
    if (item.type !== "web_search_call") return;
    if (!searchEnabled) throw failure("Unsolicited Responses search");
    const id = string(item.id);
    const action =
      item.action && typeof item.action === "object" ? object(item.action) : {};
    const status =
      item.status === "completed"
        ? "completed"
        : item.status === "failed"
          ? "failed"
          : "searching";
    if (!searches.has(id)) {
      if (searches.size >= (request.options.maxWebSearchUses ?? 3))
        throw new ProviderError({
          code: "search-limit",
          message: "Search budget exceeded",
          retryable: false,
        });
      searches.set(id, "searching");
      yield { type: "web-search", id, status: "searching" };
    }
    const signature = JSON.stringify(item);
    if (searches.get(id) === signature) return;
    searches.set(id, signature);
    const query =
      typeof action.query === "string"
        ? action.query
        : Array.isArray(action.queries)
          ? action.queries.filter((q) => typeof q === "string").join(" · ")
          : typeof action.url === "string"
            ? action.url
            : "";
    yield {
      type: "web-search",
      id,
      status,
      query: query.slice(0, 1000),
      sources: (Array.isArray(action.sources) ? action.sources : [])
        .slice(0, 20)
        .flatMap((raw) => {
          const source = webSource(raw);
          return source ? [source] : [];
        }),
      ...(status === "failed" ? { error: "search_failed" } : {}),
    };
  }
  try {
    for await (const event of unique(frames)) {
      request.signal.throwIfAborted();
      if (typeof event === "string") continue;
      const type = event.type;
      if (type === "response.refusal.delta" || type === "response.refusal.done")
        throw failure("Provider refused this request");
      if (
        type === "response.reasoning_summary_text.delta" ||
        type === "response.reasoning_text.delta"
      ) {
        yield {
          type: "public-reasoning-delta",
          text: string(event.delta),
          format:
            type === "response.reasoning_summary_text.delta"
              ? "summary"
              : "text",
        };
      } else if (type === "response.output_text.delta") {
        const delta = string(event.delta);
        text += delta;
        if (!searchEnabled) yield { type: "text-delta", text: delta };
      } else if (type === "response.output_item.added") {
        const item = object(event.item);
        yield* searchItem(item);
        if (item.type === "function_call") {
          const key = string(item.id),
            call = {
              id: string(item.call_id),
              name: string(item.name),
              args: typeof item.arguments === "string" ? item.arguments : "",
              complete: false,
            };
          const old = calls.get(key);
          if (old && (old.id !== call.id || old.name !== call.name))
            throw failure("Conflicting function item");
          if (!old) calls.set(key, call);
        }
      } else if (
        typeof type === "string" &&
        type.startsWith("response.web_search_call.")
      ) {
        yield* searchItem({
          type: "web_search_call",
          id: string(event.item_id),
          status: type.endsWith(".completed")
            ? "completed"
            : type.endsWith(".failed")
              ? "failed"
              : "in_progress",
        });
      } else if (type === "response.function_call_arguments.delta") {
        const call = calls.get(string(event.item_id));
        if (!call) throw failure("Arguments have no function item");
        yield addArgs(call, string(event.delta));
      } else if (type === "response.function_call_arguments.done") {
        const call = calls.get(string(event.item_id));
        if (!call) throw failure("Completed arguments have no function item");
        const args = string(event.arguments);
        if (call.args && call.args !== args)
          throw failure(
            "Completed tool arguments conflict with deltas",
            "tool-args",
          );
        call.args = args;
      } else if (type === "response.output_item.done") {
        const item = object(event.item);
        yield* searchItem(item);
        if (typeof item.id === "string") output.set(item.id, item);
        if (item.type === "function_call") {
          const key = string(item.id),
            old = calls.get(key),
            call = {
              id: string(item.call_id),
              name: string(item.name),
              args: string(item.arguments),
              complete: false,
            };
          if (
            old &&
            (old.id !== call.id ||
              old.name !== call.name ||
              (old.args && old.args !== call.args))
          )
            throw failure(
              "Completed function item conflicts with deltas",
              "tool-args",
            );
          calls.set(key, call);
          // Wait for whole response completion before granting any executable call.
          call.complete = true;
        }
      } else if (
        type === "response.completed" ||
        type === "response.incomplete"
      ) {
        const response = object(event.response);
        if (
          type === "response.incomplete" &&
          object(response.incomplete_details).reason !== "max_output_tokens"
        )
          throw failure("Response incomplete");
        if (
          type === "response.completed" &&
          response.status !== undefined &&
          response.status !== "completed"
        )
          throw failure("Invalid response completion status");
        if (Array.isArray(response.output))
          for (const raw of response.output) {
            const item = object(raw);
            yield* searchItem(item);
            if (item.type !== "function_call") continue;
            const key = string(item.id),
              call = {
                id: string(item.call_id),
                name: string(item.name),
                args: string(item.arguments),
                complete: true,
              },
              old = calls.get(key);
            if (
              old &&
              (old.id !== call.id ||
                old.name !== call.name ||
                (old.args && old.args !== call.args))
            )
              throw failure(
                "Final output conflicts with tool deltas",
                "tool-args",
              );
            calls.set(key, call);
          }
        if (searchEnabled) {
          const finalItems =
            Array.isArray(response.output) && response.output.length
              ? response.output
              : [...output.values()];
          const rendered = citedOutput(finalItems);
          text = rendered.text || text;
          released = true;
          for (const citation of rendered.citations) yield citation;
          if (text) yield { type: "text-delta", text };
        }
        if (response.usage) yield usage(response.usage);
        if (type === "response.incomplete" && calls.size)
          throw failure("Tool response truncated", "tool-truncated");
        const validated = [...calls.values()].map((call) => {
          if (!call.complete) throw failure("Function item never completed");
          return ready(call, request, emitted);
        });
        for (const value of validated) if (value) yield value;
        request.signal.throwIfAborted();
        yield {
          type: "finished",
          nativeContext: completedNative(
            config,
            request,
            text,
            validated.flatMap((event) =>
              event?.type === "tool-call-ready" ? [event.call] : [],
            ),
            uniqueNativeTools(
              Array.isArray(response.output) && response.output.length
                ? response.output
                : [...output.values()].length
                  ? [...output.values()]
                  : [{ role: "assistant", content: text }],
            ),
          ),
          reason:
            type === "response.incomplete"
              ? "length"
              : calls.size
                ? "tool-calls"
                : "stop",
        };
        completed = true;
        break;
      }
    }
    if (!completed) throw failure("Responses stream ended before completion");
  } catch (error) {
    if (searchEnabled && !released && text) yield { type: "text-delta", text };
    throw error;
  }
}
async function* anthropic(
  frames: Frames,
  request: ModelRequest,
  config: ProviderConfig,
): AsyncGenerator<AnthropicEvent> {
  const calls = new Map<number, Pending>(),
    blocks = new Set<number>(),
    closed = new Set<number>(),
    emitted = new Map<string, string>();
  const content = new Map<number, Json>();
  const searches = new Map<number, Pending>();
  let text = "",
    stop: FinishReason | "pause_turn" | null = null,
    start = false,
    complete = false,
    inputTokens: number | null = null,
    outputTokens: number | null = null,
    cacheHitInputTokens: number | null = null;
  for await (const event of unique(frames)) {
    request.signal.throwIfAborted();
    if (typeof event === "string")
      throw failure("Unexpected Anthropic stream marker");
    if (event.type === "message_start") {
      if (start) throw failure("Duplicate message_start");
      start = true;
      const data = object(object(event.message).usage ?? {});
      inputTokens =
        usageCount(data.input_tokens) === null
          ? null
          : count(data.input_tokens) +
            count(data.cache_read_input_tokens) +
            count(data.cache_creation_input_tokens);
      outputTokens = usageCount(data.output_tokens);
      cacheHitInputTokens = usageCount(data.cache_read_input_tokens);
    } else if (event.type === "content_block_start") {
      const index = event.index;
      if (
        typeof index !== "number" ||
        !Number.isInteger(index) ||
        index < 0 ||
        !start ||
        blocks.has(index) ||
        closed.has(index)
      )
        throw failure("Invalid Anthropic block index");
      const block = object(event.content_block);
      blocks.add(index);
      content.set(index, structuredClone(block));
      if (request.options.webSearch && Array.isArray(block.citations)) {
        for (const citation of block.citations.slice(0, 20)) {
          const source = webSource(citation);
          if (source)
            yield {
              type: "web-search",
              id: `citation-${source.url}`,
              status: "citation",
              sources: [source],
            };
        }
      }
      if (block.type === "server_tool_use") {
        if (!request.options.webSearch || block.name !== "web_search")
          throw failure("Unexpected server tool");
        const call = {
          id: string(block.id),
          name: "web_search",
          args: JSON.stringify(block.input ?? {}),
          complete: false,
        };
        searches.set(index, call);
        yield { type: "web-search", id: call.id, status: "searching" };
      } else if (block.type === "web_search_tool_result") {
        if (!request.options.webSearch)
          throw failure("Unexpected search result");
        const sources = Array.isArray(block.content)
          ? block.content.slice(0, 20).flatMap((raw) => {
              const source = webSource(raw);
              return source ? [source] : [];
            })
          : [];
        const error = !Array.isArray(block.content)
          ? object(block.content ?? {}).error_code
          : null;
        yield {
          type: "web-search",
          id: string(block.tool_use_id),
          status: error ? "failed" : "completed",
          sources,
          ...(typeof error === "string" ? { error: error.slice(0, 100) } : {}),
        };
      } else if (block.type === "tool_use")
        calls.set(index, {
          id: string(block.id),
          name: string(block.name),
          args: JSON.stringify(block.input ?? {}),
          complete: false,
        });
      else if (
        block.type === "thinking" &&
        typeof block.thinking === "string" &&
        block.thinking
      ) {
        yield {
          type: "public-reasoning-delta",
          text: block.thinking,
          format: "text",
        };
      } else if (
        block.type === "text" &&
        typeof block.text === "string" &&
        block.text
      ) {
        text += block.text;
        yield { type: "text-delta", text: block.text };
      }
    } else if (event.type === "content_block_delta") {
      const delta = object(event.delta),
        index = event.index;
      if (typeof index !== "number" || !blocks.has(index) || closed.has(index))
        throw failure("Delta references closed content block");
      const block = content.get(index);
      if (!block) throw failure("Missing content block");
      if (delta.type === "text_delta") {
        const piece = string(delta.text);
        text += piece;
        block.text = String(block.text ?? "") + piece;
        yield { type: "text-delta", text: piece };
      } else if (delta.type === "thinking_delta") {
        block.thinking = String(block.thinking ?? "") + string(delta.thinking);
        yield {
          type: "public-reasoning-delta",
          text: string(delta.thinking),
          format: "text",
        };
      } else if (delta.type === "signature_delta")
        block.signature =
          String(block.signature ?? "") + string(delta.signature);
      else if (delta.type === "citations_delta") {
        const source = webSource(delta.citation);
        if (source && request.options.webSearch) {
          const citations = Array.isArray(block.citations)
            ? block.citations
            : [];
          block.citations = [...citations, delta.citation];
          yield {
            type: "web-search",
            id: `citation-${source.url}`,
            status: "citation",
            sources: [source],
          };
        }
      } else if (delta.type === "input_json_delta") {
        const search = searches.get(index);
        if (search) {
          if (search.args === "{}") search.args = "";
          search.args += string(delta.partial_json);
          if (search.args.length > 65536)
            throw failure("Search query too large");
          continue;
        }
        const call = calls.get(index);
        if (!call) throw failure("Tool delta without tool block");
        if (call.args === "{}") call.args = "";
        yield addArgs(call, string(delta.partial_json));
      }
    } else if (event.type === "content_block_stop") {
      if (typeof event.index !== "number" || !blocks.has(event.index))
        throw failure("Block stop index missing");
      closed.add(event.index);
      const search = searches.get(event.index);
      if (search) {
        const input = object(parse(search.args));
        const block = content.get(event.index);
        if (block) block.input = input;
        yield {
          type: "web-search",
          id: search.id,
          status: "searching",
          query:
            typeof input.query === "string"
              ? input.query.slice(0, 1000)
              : undefined,
        };
      }
      const call = calls.get(event.index);
      if (call) call.complete = true;
    } else if (event.type === "message_delta") {
      const delta = object(event.delta);
      if (delta.stop_reason !== undefined && delta.stop_reason !== null)
        stop =
          delta.stop_reason === "pause_turn" && request.options.webSearch
            ? "pause_turn"
            : reason(delta.stop_reason, "anthropic-messages");
      if (event.usage) {
        const value = object(event.usage);
        if (value.input_tokens !== undefined)
          inputTokens =
            usageCount(value.input_tokens) === null
              ? null
              : count(value.input_tokens) +
                count(value.cache_read_input_tokens) +
                count(value.cache_creation_input_tokens);
        if (value.output_tokens !== undefined)
          outputTokens = usageCount(value.output_tokens);
        if (value.cache_read_input_tokens !== undefined)
          cacheHitInputTokens = usageCount(value.cache_read_input_tokens);
      }
    } else if (event.type === "message_stop") {
      if ([...searches.keys()].some((index) => !closed.has(index)))
        throw failure("Search block never stopped");
      if (!start || !stop) throw failure("Incomplete Anthropic message");
      if (calls.size && stop !== "tool-calls")
        throw failure(
          "Anthropic tools did not complete",
          stop === "length" ? "tool-truncated" : "sse",
        );
      if (stop === "tool-calls" && !calls.size)
        throw failure("Tool completion without tool calls");
      const validated = [...calls.values()].map((call) => {
        if (!call.complete) throw failure("Tool block never stopped");
        return ready(call, request, emitted);
      });
      for (const [index, call] of calls) {
        const block = content.get(index);
        if (block) block.input = JSON.parse(call.args);
      }
      for (const value of validated) if (value) yield value;
      yield {
        type: "usage",
        inputTokens,
        outputTokens,
        ...(cacheHitInputTokens !== null ? { cacheHitInputTokens } : {}),
      };
      request.signal.throwIfAborted();
      if (stop === "pause_turn") {
        yield { type: "search-paused", text, wire: [...content.values()] };
        complete = true;
        break;
      }
      yield {
        type: "finished",
        reason: stop,
        nativeContext: completedNative(
          config,
          request,
          text,
          validated.flatMap((event) =>
            event?.type === "tool-call-ready" ? [event.call] : [],
          ),
          uniqueNativeTools([...content.values()]),
        ),
      };
      complete = true;
      break;
    }
  }
  if (!complete) throw failure("Anthropic stream ended before completion");
}
