import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HertaBridgeProvider } from "../context/HertaBridgeContext.js";
import { createMockHertaBridge } from "../ipc/mock-bridge.js";
import { mockRecord } from "../mocks/record.js";
import { useDisconnected } from "./useDisconnected.js";

describe("useDisconnected", () => {
  it("is false before any reset (fresh / not bootstrapped)", () => {
    const mock = createMockHertaBridge();
    const { result } = renderHook(() => useDisconnected(), {
      wrapper: ({ children }) => (
        <HertaBridgeProvider bridge={mock.bridge}>
          {children}
        </HertaBridgeProvider>
      ),
    });
    expect(result.current).toBe(false);
  });

  it("is false after a session reset (bootstrapped but sessionId set)", () => {
    const mock = createMockHertaBridge();
    const { result } = renderHook(() => useDisconnected(), {
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
    expect(result.current).toBe(false);
  });

  it("is true after a session reset then emitSessionDeleted of that session", () => {
    const mock = createMockHertaBridge();
    const { result } = renderHook(() => useDisconnected(), {
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
    act(() => {
      mock.emitSessionDeleted({ sessionId: "s-1" });
    });
    expect(result.current).toBe(true);
  });
});
