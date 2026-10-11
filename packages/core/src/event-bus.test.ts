import { describe, expect, it, vi } from "vitest";
import { InMemoryEventBus, publishWithLayer } from "./event-bus.js";
import type { AgentEvent } from "./types/events.js";

describe("InMemoryEventBus", () => {
  it("dispatches by event type to matching handlers", () => {
    const bus = new InMemoryEventBus<AgentEvent>();
    const onDelta = vi.fn();
    const onFinished = vi.fn();
    bus.on("assistant.delta", onDelta);
    bus.on("turn.finished", onFinished);

    bus.publish({ type: "assistant.delta", layer: "backend", text: "hi" });
    expect(onDelta).toHaveBeenCalledWith({
      type: "assistant.delta",
      layer: "backend",
      text: "hi",
    });
    expect(onFinished).not.toHaveBeenCalled();
  });

  it("calls multiple handlers in registration order", () => {
    const bus = new InMemoryEventBus<AgentEvent>();
    const calls: string[] = [];
    bus.on("assistant.delta", () => calls.push("a"));
    bus.on("assistant.delta", () => calls.push("b"));
    bus.publish({ type: "assistant.delta", layer: "backend", text: "x" });
    expect(calls).toEqual(["a", "b"]);
  });

  it("returns an unsubscribe function from on()", () => {
    const bus = new InMemoryEventBus<AgentEvent>();
    const handler = vi.fn();
    const off = bus.on("assistant.delta", handler);
    bus.publish({ type: "assistant.delta", layer: "backend", text: "x" });
    off();
    bus.publish({ type: "assistant.delta", layer: "backend", text: "y" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("delivers every event to onAny subscribers", () => {
    const bus = new InMemoryEventBus<AgentEvent>();
    const seen: AgentEvent[] = [];
    bus.onAny((e) => seen.push(e));
    bus.publish({ type: "assistant.delta", layer: "backend", text: "a" });
    bus.publish({
      type: "turn.failed",
      layer: "backend",
      error: { kind: "internal", message: "x" },
    });
    expect(seen).toHaveLength(2);
    expect(seen[0]?.type).toBe("assistant.delta");
    expect(seen[1]?.type).toBe("turn.failed");
  });

  it("isolates errors thrown by handlers", () => {
    const bus = new InMemoryEventBus<AgentEvent>();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const sane = vi.fn();
    bus.on("assistant.delta", () => {
      throw new Error("boom");
    });
    bus.on("assistant.delta", sane);
    expect(() =>
      bus.publish({ type: "assistant.delta", layer: "backend", text: "x" }),
    ).not.toThrow();
    expect(sane).toHaveBeenCalledOnce();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("dispatches synchronously (no microtask hop)", () => {
    const bus = new InMemoryEventBus<AgentEvent>();
    let observed = "before";
    bus.on("assistant.delta", () => {
      observed = "during";
    });
    bus.publish({ type: "assistant.delta", layer: "backend", text: "x" });
    expect(observed).toBe("during");
  });
});

describe("publishWithLayer", () => {
  it("adds layer to events that don't already have one", () => {
    const bus = new InMemoryEventBus<AgentEvent>();
    const seen: AgentEvent[] = [];
    bus.onAny((e) => seen.push(e));

    publishWithLayer(bus, "actor", {
      type: "turn.started",
      userText: "hi",
    } as Omit<AgentEvent, "layer"> & {
      type: "turn.started";
      userText: string;
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.layer).toBe("actor");
  });

  it("preserves existing layer when event already has one", () => {
    const bus = new InMemoryEventBus<AgentEvent>();
    const seen: AgentEvent[] = [];
    bus.onAny((e) => seen.push(e));

    publishWithLayer(bus, "actor", {
      type: "turn.started",
      layer: "backend",
      userText: "hi",
    });

    expect(seen[0]?.layer).toBe("backend");
  });

  it("works for events with multiple fields", () => {
    const bus = new InMemoryEventBus<AgentEvent>();
    const seen: AgentEvent[] = [];
    bus.onAny((e) => seen.push(e));

    publishWithLayer(bus, "backend", {
      type: "tool.call.started",
      id: "c1",
      tool: "read_file",
      inputSummary: "{}",
    } as Omit<AgentEvent, "layer"> & {
      type: "tool.call.started";
      id: string;
      tool: string;
      inputSummary: string;
    });

    expect(seen[0]).toMatchObject({
      type: "tool.call.started",
      layer: "backend",
      id: "c1",
    });
  });
});
