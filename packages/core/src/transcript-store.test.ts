import { describe, expect, it } from "vitest";
import { TranscriptStore } from "./transcript-store.js";

describe("TranscriptStore", () => {
  const T = new Date("2026-05-03T10:00:00.000Z");

  it("appends user messages and returns them via all()", () => {
    const t = new TranscriptStore();
    const msg = t.appendUser("hello", T);
    expect(msg.role).toBe("user");
    expect(msg.text).toBe("hello");
    expect(msg.ts).toBe(T.toISOString());
    expect(t.all()).toEqual([msg]);
  });

  it("appends assistant messages with tool calls", () => {
    const t = new TranscriptStore();
    const msg = t.appendAssistant(
      "thinking…",
      [{ id: "tc1", tool: "read_file", input: { path: "x" } }],
      T,
    );
    expect(msg.role).toBe("assistant");
    expect(msg.toolCalls).toHaveLength(1);
    expect(t.all()).toEqual([msg]);
  });

  it("appends tool messages", () => {
    const t = new TranscriptStore();
    const msg = t.appendTool("tc1", { ok: true, summary: "read 12 lines" }, T);
    expect(msg.role).toBe("tool");
    expect(msg.toolCallId).toBe("tc1");
  });

  it("preserves append order across mixed message kinds", () => {
    const t = new TranscriptStore();
    t.appendUser("u1", T);
    t.appendAssistant("a1", [], T);
    t.appendTool("tc1", { ok: true, summary: "ok" }, T);
    t.appendUser("u2", T);
    expect(t.all().map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "user",
    ]);
  });

  it("returns the last user message via lastUserMessage()", () => {
    const t = new TranscriptStore();
    expect(t.lastUserMessage()).toBeUndefined();
    t.appendUser("u1", T);
    t.appendAssistant("a1", [], T);
    t.appendUser("u2", T);
    expect(t.lastUserMessage()?.text).toBe("u2");
  });

  it("all() reflects further appends", () => {
    const t = new TranscriptStore();
    t.appendUser("u1", T);
    expect(t.all()).toHaveLength(1);
    t.appendUser("u2", T);
    expect(t.all()).toHaveLength(2);
  });

  it("clear() drops all messages", () => {
    const t = new TranscriptStore();
    t.appendUser("hi", T);
    t.appendAssistant("hello", [], T);
    expect(t.all()).toHaveLength(2);
    t.clear();
    expect(t.all()).toEqual([]);
  });

  it("dropOldest(n) removes the oldest n messages", () => {
    const t = new TranscriptStore();
    t.appendUser("a", T);
    t.appendUser("b", T);
    t.appendUser("c", T);
    t.dropOldest(2);
    expect(t.all()).toHaveLength(1);
    const remaining = t.all()[0];
    expect(remaining?.role).toBe("user");
    expect((remaining as { text: string }).text).toBe("c");
  });

  it("dropOldest(0) is a no-op", () => {
    const t = new TranscriptStore();
    t.appendUser("a", T);
    t.dropOldest(0);
    expect(t.all()).toHaveLength(1);
  });

  it("invokes onAppend after each append, in order, with the same message", () => {
    const seen: Array<{ role: string; text?: string }> = [];
    const t = new TranscriptStore({
      onAppend: (m) =>
        seen.push({
          role: m.role,
          text: m.role !== "tool" ? m.text : undefined,
        }),
    });
    const u = t.appendUser("hi", T);
    const a = t.appendAssistant("ok", [], T);
    const tool = t.appendTool("tc1", { ok: true, summary: "" }, T);
    expect(seen).toEqual([
      { role: "user", text: "hi" },
      { role: "assistant", text: "ok" },
      { role: "tool", text: undefined },
    ]);
    // The callback receives the same instance that's in `all()`.
    expect(t.all()).toEqual([u, a, tool]);
  });

  it("onAppend exceptions propagate to the caller", () => {
    const t = new TranscriptStore({
      onAppend: () => {
        throw new Error("disk full");
      },
    });
    expect(() => t.appendUser("hi", T)).toThrow(/disk full/);
  });

  it("works without onAppend (legacy zero-arg construction)", () => {
    const t = new TranscriptStore();
    t.appendUser("hi", T);
    expect(t.all()).toHaveLength(1);
  });
});
