import { describe, expect, it } from "vitest";
import { cleanText, isBoilerplate } from "./clean-text.js";

describe("clean-text", () => {
  it("collapses inner whitespace and trims", () => {
    expect(cleanText("  hello   黑塔\n\nworld  ")).toBe("hello 黑塔 world");
  });

  it("returns empty for nothing-but-whitespace", () => {
    expect(cleanText("\n\t  \n")).toBe("");
  });

  it.each([
    "如果是第一次来,请阅读使用说明",
    "本Wiki著作权归原作者所有",
    "编辑    历史    讨论",
    "目录",
    "查看源代码",
    "导航",
    "最近更改",
    "Copyright (c) 2024 Anonymous",
  ])("flags wiki boilerplate: %s", (s) => {
    expect(isBoilerplate(s)).toBe(true);
  });

  it("does NOT flag canon content", () => {
    expect(isBoilerplate("黑塔本人坐在椅子上。")).toBe(false);
    expect(isBoilerplate("黑塔：你以为这种事我会感兴趣？")).toBe(false);
  });

  it.each([
    "目录学:模拟宇宙",
    "导航员的故事",
    "最近更改了什么",
    "讨论:不可能",
    "编辑器的工作方式",
  ])("does NOT flag canon line beginning with a nav-word stem: %s", (s) => {
    expect(isBoilerplate(s)).toBe(false);
  });
});
