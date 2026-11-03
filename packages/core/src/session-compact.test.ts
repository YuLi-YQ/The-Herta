import { describe, expect, it } from "vitest";
import { parseCompactAction } from "./session-compact.js";

describe("compact actions", () => {
  it("accepts only the two explicit single-field actions", () => {
    expect(parseCompactAction({ type: "schedule" })).toEqual({
      type: "schedule",
    });
    expect(parseCompactAction({ type: "cancel" })).toEqual({ type: "cancel" });
    for (const value of [
      null,
      [],
      {},
      { type: "delete" },
      { type: "schedule", extra: true },
      Object.assign(Object.create({ type: "schedule" }), { extra: true }),
    ])
      expect(parseCompactAction(value)).toBeNull();
  });
});
