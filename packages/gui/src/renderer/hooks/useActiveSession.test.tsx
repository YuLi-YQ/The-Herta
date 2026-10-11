import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HertaBridgeProvider } from "../context/HertaBridgeContext.js";
import { createMockHertaBridge } from "../ipc/mock-bridge.js";
import { mockRecord } from "../mocks/record.js";
import { useActiveSession } from "./useActiveSession.js";

describe("useActiveSession", () => {
  it("starts with null sessionId, empty record, idle status", () => {
    const mock = createMockHertaBridge();
    const { result } = renderHook(() => useActiveSession(), {
      wrapper: ({ children }) => (
        <HertaBridgeProvider bridge={mock.bridge}>
          {children}
        </HertaBridgeProvider>
      ),
    });
    expect(result.current.sessionId).toBeNull();
    expect(result.current.record).toEqual([]);
    expect(result.current.status).toBe("idle");
    expect(result.current.overlay).toBeNull();
  });

  it("updates when a reset event is emitted", () => {
    const mock = createMockHertaBridge();
    const { result } = renderHook(() => useActiveSession(), {
      wrapper: ({ children }) => (
        <HertaBridgeProvider bridge={mock.bridge}>
          {children}
        </HertaBridgeProvider>
      ),
    });
    act(() => {
      mock.emitReset({
        sessionId: "s-1",
        workspaceRoot: "/r",
        record: mockRecord,
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
    });
    expect(result.current.sessionId).toBe("s-1");
    expect(result.current.record).toHaveLength(3);
    expect(result.current.status).toBe("idle");
  });

  it("transitions to thinking on turn started", () => {
    const mock = createMockHertaBridge();
    const { result } = renderHook(() => useActiveSession(), {
      wrapper: ({ children }) => (
        <HertaBridgeProvider bridge={mock.bridge}>
          {children}
        </HertaBridgeProvider>
      ),
    });
    act(() => {
      mock.emitTurn({ kind: "started", turnId: "t1" });
    });
    expect(result.current.status).toBe("thinking");
  });
});
