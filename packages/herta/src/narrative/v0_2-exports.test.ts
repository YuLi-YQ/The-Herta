import { describe, expect, it } from "vitest";
import * as herta from "../index.js";

describe("@herta/herta narrative exports", () => {
  it("exports escapeUserText function", () => {
    expect(typeof herta.escapeUserText).toBe("function");
  });

  it("exports FORBIDDEN_USER_PATTERNS constant", () => {
    expect(Array.isArray(herta.FORBIDDEN_USER_PATTERNS)).toBe(true);
    expect(herta.FORBIDDEN_USER_PATTERNS).toContain("@板砖");
  });

  it("exports serializeBlock function", () => {
    expect(typeof herta.serializeBlock).toBe("function");
  });

  it("exports serializeTerminalRecord function", () => {
    expect(typeof herta.serializeTerminalRecord).toBe("function");
  });

  it("exports parseHertaBlock function", () => {
    expect(typeof herta.parseHertaBlock).toBe("function");
  });

  it("serializeTerminalRecord([]) returns empty string", () => {
    expect(herta.serializeTerminalRecord([])).toBe("");
  });

  it("parseHertaBlock('') returns empty parsed shape", () => {
    const parsed = herta.parseHertaBlock("");
    expect(parsed.text).toBe("");
    expect(parsed.hasBanzhuanTrigger).toBe(false);
  });
});
