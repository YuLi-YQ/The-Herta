import { describe, expect, it } from "vitest";
import * as herta from "../index.js";

describe("@herta/herta actor-turn exports", () => {
  it("exports buildStaticHertaPrefix function", () => {
    expect(typeof herta.buildStaticHertaPrefix).toBe("function");
  });

  it("exports invokeBanzhuanBridge function", () => {
    expect(typeof herta.invokeBanzhuanBridge).toBe("function");
  });

  it("exports projectBackendEvent function", () => {
    expect(typeof herta.projectBackendEvent).toBe("function");
  });

  it("exports runActorCompletionTurn function", () => {
    expect(typeof herta.runActorCompletionTurn).toBe("function");
  });
});
