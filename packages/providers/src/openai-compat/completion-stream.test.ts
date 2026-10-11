import type { CompletionEvent } from "@herta/core";
import { describe, expect, it } from "vitest";
import { ProviderError } from "../errors.js";
import { mapCompletionStream } from "./completion-stream.js";

async function* fromArray<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

async function collect(
  events: AsyncIterable<CompletionEvent>,
): Promise<CompletionEvent[]> {
  const out: CompletionEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe("mapCompletionStream", () => {
  it("emits text-delta for each non-empty choices[0].text", async () => {
    const signal = new AbortController().signal;
    const events = fromArray([
      { choices: [{ text: "你好", index: 0, finish_reason: null }] },
      { choices: [{ text: "，", index: 0, finish_reason: null }] },
      { choices: [{ text: "黑塔。", index: 0, finish_reason: null }] },
      { choices: [{ text: "", index: 0, finish_reason: "stop" }] },
    ]);
    const out = await collect(mapCompletionStream(events, signal));
    expect(out).toEqual([
      { type: "text-delta", text: "你好" },
      { type: "text-delta", text: "，" },
      { type: "text-delta", text: "黑塔。" },
      { type: "finish", reason: "stop" },
    ]);
  });

  it("skips empty/missing text fields", async () => {
    const events = fromArray([
      { choices: [{ text: "", index: 0, finish_reason: null }] },
      { choices: [{ index: 0, finish_reason: null }] }, // no text
      { choices: [{ text: "ok", index: 0, finish_reason: "stop" }] },
    ]);
    const out = await collect(
      mapCompletionStream(events, new AbortController().signal),
    );
    expect(out).toEqual([
      { type: "text-delta", text: "ok" },
      { type: "finish", reason: "stop" },
    ]);
  });

  it("maps finish_reason='length' to finish with reason='length'", async () => {
    const events = fromArray([
      { choices: [{ text: "x", index: 0, finish_reason: null }] },
      { choices: [{ text: "", index: 0, finish_reason: "length" }] },
    ]);
    const out = await collect(
      mapCompletionStream(events, new AbortController().signal),
    );
    expect(out[out.length - 1]).toEqual({ type: "finish", reason: "length" });
  });

  it("maps unknown finish_reason to error", async () => {
    const events = fromArray([
      { choices: [{ text: "", index: 0, finish_reason: "content_filter" }] },
    ]);
    const out = await collect(
      mapCompletionStream(events, new AbortController().signal),
    );
    expect(out).toEqual([{ type: "finish", reason: "error" }]);
  });

  it("THROWS when the stream ends mid-generation (audit 2026-07-24, 1.9)", async () => {
    // Previously this synthesized `finish: stop` — "the iterator ended" read
    // as "the model chose to stop". A truncated generation was then committed
    // as a finished （我 说）block: half a sentence in the durable record,
    // shown as a complete turn, no error and no retry.
    const events = fromArray([
      { choices: [{ text: "abc", index: 0, finish_reason: null }] },
    ]);
    await expect(
      collect(mapCompletionStream(events, new AbortController().signal)),
    ).rejects.toMatchObject({ code: "sse", retryable: true });
  });

  it("still finishes cleanly when the stream carried no text at all", async () => {
    // An empty stream is an unusual but benign shape the callers handle;
    // only text-then-silence indicates truncation.
    const events = fromArray([{ usage: { prompt_tokens: 10 } }]);
    const out = await collect(
      mapCompletionStream(events, new AbortController().signal),
    );
    expect(out).toEqual([{ type: "finish", reason: "stop" }]);
  });

  it("surfaces an error payload instead of skipping it for lacking choices", async () => {
    const events = fromArray([
      { choices: [{ text: "abc", index: 0, finish_reason: null }] },
      { error: { message: "upstream exploded" } },
    ]);
    await expect(
      collect(mapCompletionStream(events, new AbortController().signal)),
    ).rejects.toMatchObject({ code: "sse", retryable: true });
  });

  it("a benign `error: null` stamp does not kill the stream", async () => {
    // Some OpenAI-compatible gateways include `"error": null` on every
    // chunk; only a real payload is a failure.
    const events = fromArray([
      { error: null, choices: [{ text: "x", index: 0, finish_reason: null }] },
      { error: null, choices: [{ text: "", index: 0, finish_reason: "stop" }] },
    ]);
    const out = await collect(
      mapCompletionStream(events, new AbortController().signal),
    );
    expect(out).toEqual([
      { type: "text-delta", text: "x" },
      { type: "finish", reason: "stop" },
    ]);
  });

  it("ignores events with no choices", async () => {
    const events = fromArray([
      { usage: { prompt_tokens: 10 } }, // some providers emit usage chunks
      { choices: [{ text: "x", index: 0, finish_reason: "stop" }] },
    ]);
    const out = await collect(
      mapCompletionStream(events, new AbortController().signal),
    );
    expect(out).toEqual([
      { type: "text-delta", text: "x" },
      { type: "finish", reason: "stop" },
    ]);
  });

  it("propagates abort via signal.throwIfAborted between events", async () => {
    const ac = new AbortController();
    async function* events(): AsyncGenerator<unknown> {
      yield { choices: [{ text: "a", index: 0, finish_reason: null }] };
      ac.abort();
      yield { choices: [{ text: "b", index: 0, finish_reason: null }] };
    }
    const out: CompletionEvent[] = [];
    await expect(async () => {
      for await (const e of mapCompletionStream(events(), ac.signal)) {
        out.push(e);
      }
    }).rejects.toThrow();
    expect(out).toEqual([{ type: "text-delta", text: "a" }]);
  });

  it("throws ProviderError on malformed event shape (defensive)", async () => {
    const events = fromArray([
      {
        choices: [
          { text: 42, index: 0, finish_reason: null },
        ] as unknown as never,
      },
    ]);
    await expect(
      collect(mapCompletionStream(events, new AbortController().signal)),
    ).rejects.toBeInstanceOf(ProviderError);
  });
});
