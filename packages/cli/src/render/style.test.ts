import { describe, expect, it } from "vitest";
import { makeStyle } from "./style.js";

describe("makeStyle", () => {
  it("returns identity helpers when enabled is false", () => {
    const s = makeStyle({ enabled: false });
    expect(s.dim("hi")).toBe("hi");
    expect(s.cyan("hi")).toBe("hi");
    expect(s.red("hi")).toBe("hi");
    expect(s.green("hi")).toBe("hi");
    expect(s.yellow("hi")).toBe("hi");
    expect(s.bright("hi")).toBe("hi");
    expect(s.bold("hi")).toBe("hi");
    expect(s.reset).toBe("");
    expect(s.enabled).toBe(false);
  });

  it("wraps with ANSI codes when enabled is true", () => {
    const s = makeStyle({ enabled: true });
    expect(s.cyan("hi")).toBe("\x1b[36mhi\x1b[0m");
    expect(s.red("hi")).toBe("\x1b[31mhi\x1b[0m");
    expect(s.green("hi")).toBe("\x1b[32mhi\x1b[0m");
    expect(s.yellow("hi")).toBe("\x1b[33mhi\x1b[0m");
    expect(s.dim("hi")).toBe("\x1b[2mhi\x1b[0m");
    expect(s.bright("hi")).toBe("\x1b[96mhi\x1b[0m");
    expect(s.bold("hi")).toBe("\x1b[1mhi\x1b[0m");
    expect(s.reset).toBe("\x1b[0m");
    expect(s.enabled).toBe(true);
  });
});
