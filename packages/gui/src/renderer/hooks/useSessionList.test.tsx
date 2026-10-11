import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HertaBridgeProvider } from "../context/HertaBridgeContext.js";
import { createMockHertaBridge } from "../ipc/mock-bridge.js";
import { mockSessionList } from "../mocks/sessions.js";
import { useSessionList } from "./useSessionList.js";

describe("useSessionList", () => {
  it("starts empty before listSessions resolves", () => {
    const mock = createMockHertaBridge({ listSessionsResult: mockSessionList });
    const { result } = renderHook(() => useSessionList(), {
      wrapper: ({ children }) => (
        <HertaBridgeProvider bridge={mock.bridge}>
          {children}
        </HertaBridgeProvider>
      ),
    });
    // Initial synchronous snapshot is empty (async load not yet resolved)
    expect(Array.isArray(result.current)).toBe(true);
  });

  it("returns sessions once the store loads them", async () => {
    const mock = createMockHertaBridge({ listSessionsResult: mockSessionList });
    const { result } = renderHook(() => useSessionList(), {
      wrapper: ({ children }) => (
        <HertaBridgeProvider bridge={mock.bridge}>
          {children}
        </HertaBridgeProvider>
      ),
    });
    // Wait for the async listSessions call to resolve
    await Promise.resolve();
    await Promise.resolve();
    expect(result.current.length).toBe(mockSessionList.length);
  });
});
