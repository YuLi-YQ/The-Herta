import type { RecordEvent } from "@herta/app-server";
import { describe, expect, it } from "vitest";
import type { SpeechControlEvent } from "./bridge-types.js";
import { createMockHertaBridge } from "./mock-bridge.js";

describe("createMockHertaBridge", () => {
  it("delivers emitted record events to subscribers and stops after unsubscribe", () => {
    const mock = createMockHertaBridge();
    const seen: RecordEvent[] = [];
    const unsub = mock.bridge.onRecord((e) => seen.push(e));
    const ev: RecordEvent = {
      kind: "block",
      blockId: "b1",
      block: { kind: "user", text: "hi" },
    };
    mock.emitRecord(ev);
    expect(seen).toEqual([ev]);
    unsub();
    mock.emitRecord(ev);
    expect(seen).toEqual([ev]); // no second delivery
  });

  it("delivers emitted speech control events to onSpeech subscribers", () => {
    const mock = createMockHertaBridge();
    const seen: SpeechControlEvent[] = [];
    const unsub = mock.bridge.onSpeech((e) => seen.push(e));
    const ev: SpeechControlEvent = { kind: "retract" };
    mock.emitSpeech(ev);
    expect(seen).toEqual([ev]);
    unsub();
    mock.emitSpeech(ev);
    expect(seen).toEqual([ev]); // no second delivery
  });

  it("records command calls and returns scripted results", async () => {
    const mock = createMockHertaBridge({
      submitTextResult: { turnId: "t-42" },
    });
    const r = await mock.bridge.submitText("hello");
    expect(r).toEqual({ turnId: "t-42" });
    expect(mock.calls.submitText).toEqual(["hello"]);
  });

  it("submitText can return needsKey", async () => {
    const mock = createMockHertaBridge({
      submitTextResult: { needsKey: true },
    });
    expect(await mock.bridge.submitText("hi")).toEqual({ needsKey: true });
  });

  it("DeepSeek key commands round-trip the masked status", async () => {
    const mock = createMockHertaBridge();
    expect(await mock.bridge.getDeepSeekKeyStatus()).toEqual({
      set: false,
      hint: null,
      encrypted: false,
    });
    const set = await mock.bridge.setDeepSeekKey("sk-abcd1234");
    expect(mock.calls.setDeepSeekKey).toEqual(["sk-abcd1234"]);
    if (!set.ok) throw new Error("expected the key to be accepted");
    expect(set.status).toEqual({ set: true, hint: "1234", encrypted: true });
    // The seeded status now reflects the set key.
    expect(await mock.bridge.getDeepSeekKeyStatus()).toEqual({
      set: true,
      hint: "1234",
      encrypted: true,
    });
    const cleared = await mock.bridge.clearDeepSeekKey();
    expect(mock.calls.clearDeepSeekKey).toBe(1);
    expect(cleared.status.set).toBe(false);
  });

  it("setDeepSeekKey can reject a key (and leaves the status unchanged)", async () => {
    const mock = createMockHertaBridge({ rejectDeepSeekKey: true });
    const r = await mock.bridge.setDeepSeekKey("sk-wrong");
    expect(r).toEqual({ ok: false, reason: "rejected" });
    expect((await mock.bridge.getDeepSeekKeyStatus()).set).toBe(false);
  });

  it("emitReset delivers to onReset subscribers", () => {
    const mock = createMockHertaBridge();
    const seen: unknown[] = [];
    mock.bridge.onReset((e) => seen.push(e));
    mock.emitReset({
      sessionId: "s",
      workspaceRoot: "/r",
      record: [],
      overlay: null,
      backendWorkspace: "/r",
      backendWorkspaceIsDefault: true,
    });
    expect(seen).toHaveLength(1);
  });
});
