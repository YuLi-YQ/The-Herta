import { describe, expect, it } from "vitest";
import {
  mockEmptyRecord,
  mockIdleOverlay,
  mockRecord,
  mockSessionList,
} from "./index.js";

describe("@herta/gui — mocks", () => {
  it("exports a non-empty session list", () => {
    expect(mockSessionList.length).toBeGreaterThan(0);
    for (const s of mockSessionList) {
      expect(typeof s.sessionId).toBe("string");
      expect(typeof s.workspaceRoot).toBe("string");
    }
  });

  it("exports a non-empty record matching the reference conversation", () => {
    expect(mockRecord.length).toBe(3);
    expect(mockRecord[0]?.kind).toBe("user");
    expect(mockRecord[1]?.kind).toBe("herta");
    expect(mockRecord[2]?.kind).toBe("user");
  });

  it("exports an empty-record fallback", () => {
    expect(mockEmptyRecord).toEqual([]);
  });

  it("exports an idle overlay fixture", () => {
    expect(mockIdleOverlay.kind).toBe("idle");
  });
});
