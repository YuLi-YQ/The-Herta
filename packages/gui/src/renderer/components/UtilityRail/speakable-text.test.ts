import { describe, expect, it } from "vitest";
import { scanSpeakable } from "./speakable-text.js";

describe("scanSpeakable", () => {
  it("counts plain prose and reports the last speakable char", () => {
    const r = scanSpeakable("你好，世界。");
    expect(r.count).toBe(6);
    expect(r.last).toBe("。");
  });

  it("excludes fenced code blocks including the fence lines", () => {
    const text = "看这个：\n```ts\nconst x = 1;\n```\n就这样。";
    const r = scanSpeakable(text);
    // Speakable: "看这个：" (4) + "就这样。" (4) = 8.
    expect(r.count).toBe(8);
    expect(r.last).toBe("。");
  });

  it("excludes table rows", () => {
    const text = "结果：\n| a | b |\n| - | - |\n| 1 | 2 |\n完。";
    const r = scanSpeakable(text);
    expect(r.count).toBe(3 + 2); // "结果：" + "完。"
  });

  it("keeps inline code spans speakable", () => {
    const r = scanSpeakable("跑一下 `npm test` 再说。");
    expect(r.count).toBe([..."跑一下 `npm test` 再说。"].length);
  });

  it("resumes counting after the fence closes", () => {
    const open = scanSpeakable("说：\n```\ncode\n");
    const closed = scanSpeakable("说：\n```\ncode\n```\n续。");
    expect(open.count).toBe(2);
    expect(closed.count).toBe(4); // "说：" + "续。"
    expect(closed.last).toBe("。");
  });

  it("a partial fence line is transient prose — callers clamp negative deltas", () => {
    // While "``" is streaming it counts as prose; once "```" lands the line
    // reclassifies and the total DROPS. The hook clamps the delta at zero.
    const partial = scanSpeakable("好。\n``");
    const fenced = scanSpeakable("好。\n```");
    expect(partial.count).toBeGreaterThan(fenced.count);
    expect(fenced.count).toBe(2); // just "好。"
  });

  it("empty/null-ish input", () => {
    expect(scanSpeakable("")).toEqual({ count: 0, last: null });
  });
});
