import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HertaBridgeProvider } from "../context/HertaBridgeContext.js";
import { createMockHertaBridge } from "../ipc/mock-bridge.js";
import {
  shallowEqualObjects,
  useSessionSelector,
} from "./useSessionSelector.js";

afterEach(cleanup);

const RESET = {
  sessionId: "s1",
  workspaceRoot: "/r",
  record: [],
  overlay: null,
  backendWorkspace: "/r",
  backendWorkspaceIsDefault: true,
} as const;

describe("useSessionSelector", () => {
  it("re-renders only when the selected value changes (not per streaming delta)", () => {
    const mock = createMockHertaBridge();
    let renders = 0;
    let seen: string | null = null;
    function Probe(): null {
      renders += 1;
      seen = useSessionSelector((s) => s.sessionId);
      return null;
    }
    render(
      <HertaBridgeProvider bridge={mock.bridge}>
        <Probe />
      </HertaBridgeProvider>,
    );
    act(() => {
      mock.emitReset({ ...RESET, record: [{ kind: "user", text: "hi" }] });
      mock.emitTurn({ kind: "started", turnId: "t1" });
    });
    expect(seen).toBe("s1");
    const after = renders;
    // Streaming deltas mutate streamingText — the snapshot identity changes on
    // every one, but the SELECTED field does not. The whole point of the hook:
    // no re-render.
    act(() => {
      mock.emitAgent({
        kind: "agent",
        event: {
          type: "assistant.delta",
          layer: "actor",
          text: "token",
        } as never,
      });
      mock.emitAgent({
        kind: "agent",
        event: {
          type: "assistant.delta",
          layer: "actor",
          text: " token",
        } as never,
      });
    });
    expect(renders).toBe(after);
    // A genuine change of the selected field re-renders.
    act(() => {
      mock.emitReset({ ...RESET, sessionId: "s2" });
    });
    expect(seen).toBe("s2");
    expect(renders).toBeGreaterThan(after);
  });

  it("object selections with shallowEqualObjects stay stable across emits", () => {
    const mock = createMockHertaBridge();
    let renders = 0;
    function Probe(): null {
      renders += 1;
      useSessionSelector(
        (s) => ({ id: s.sessionId, title: s.title }),
        shallowEqualObjects,
      );
      return null;
    }
    render(
      <HertaBridgeProvider bridge={mock.bridge}>
        <Probe />
      </HertaBridgeProvider>,
    );
    act(() => {
      mock.emitReset(RESET);
      mock.emitTurn({ kind: "started", turnId: "t1" });
    });
    const after = renders;
    act(() => {
      mock.emitAgent({
        kind: "agent",
        event: {
          type: "assistant.delta",
          layer: "actor",
          text: "token",
        } as never,
      });
    });
    // A fresh object per selection, but shallow-equal → no re-render.
    expect(renders).toBe(after);
  });
});

describe("shallowEqualObjects", () => {
  it("compares one level of keys", () => {
    expect(shallowEqualObjects({ a: 1, b: "x" }, { a: 1, b: "x" })).toBe(true);
    expect(shallowEqualObjects({ a: 1 }, { a: 2 })).toBe(false);
    expect(
      shallowEqualObjects(
        { a: 1, b: undefined } as Record<string, unknown>,
        { a: 1 } as Record<string, unknown>,
      ),
    ).toBe(false);
  });
});
