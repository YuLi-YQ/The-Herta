import { describe, expect, it } from "vitest";
import { BuildScope } from "./build-scope.js";

describe("BuildScope (ADR 0057 §6.5)", () => {
  it("releases what the build owned, newest first, when the caller's signal aborted at a checkpoint", () => {
    const ac = new AbortController();
    const scope = new BuildScope(ac.signal);
    const order: string[] = [];
    scope.own(() => order.push("renderer"));
    scope.own(() => order.push("textures"));
    scope.checkpoint();
    expect(order).toEqual([]);
    ac.abort();
    expect(() => scope.checkpoint()).toThrow(/abort/i);
    expect(order).toEqual(["textures", "renderer"]);
    scope.release();
    expect(order).toEqual(["textures", "renderer"]); // idempotent
  });

  it("a failed build releases the same way; a landed build commits and releases nothing", () => {
    const order: string[] = [];
    const a = new BuildScope();
    a.own(() => order.push("a"));
    a.release();
    expect(order).toEqual(["a"]);
    const b = new BuildScope();
    b.own(() => order.push("b"));
    b.commit();
    b.release();
    expect(order).toEqual(["a"]);
  });

  it("adopt: one dispose stands for everything owned so far; one disposer's throw does not keep the rest alive", () => {
    const s = new BuildScope();
    const order: string[] = [];
    s.own(() => order.push("piece"));
    s.adopt(() => order.push("whole"));
    s.own(() => {
      throw new Error("boom");
    });
    s.own(() => order.push("late"));
    s.release();
    expect(order).toEqual(["late", "whole"]);
  });
});
