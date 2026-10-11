import { describe, expect, it } from "vitest";
import * as herta from "../index.js";

describe("@herta/herta beat exports", () => {
  it("exports BeatPolicy class", () => {
    expect(typeof herta.BeatPolicy).toBe("function");
  });

  it("exports classifyBeatTrigger function", () => {
    expect(typeof herta.classifyBeatTrigger).toBe("function");
  });

  it("BeatPolicy can be constructed with defaults", () => {
    const p = new herta.BeatPolicy();
    expect(p).toBeInstanceOf(herta.BeatPolicy);
  });
});
