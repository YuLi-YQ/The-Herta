import { describe, expect, it } from "vitest";
import { parseSpeakerLine } from "./speaker-parser.js";

describe("speaker-parser", () => {
  it("parses 'speaker：text' (fullwidth colon)", () => {
    expect(parseSpeakerLine("黑塔：你以为这种事我会感兴趣？")).toEqual({
      speaker: "黑塔",
      text: "你以为这种事我会感兴趣？",
    });
  });

  it("parses 'speaker: text' (halfwidth colon)", () => {
    expect(parseSpeakerLine("Herta: dismissive")).toEqual({
      speaker: "Herta",
      text: "dismissive",
    });
  });

  it("trims whitespace around speaker and text", () => {
    expect(parseSpeakerLine("  大黑塔 ：  本人到场。  ")).toEqual({
      speaker: "大黑塔",
      text: "本人到场。",
    });
  });

  it("returns null when no speaker delimiter", () => {
    expect(parseSpeakerLine("没有冒号的旁白")).toBeNull();
  });

  it("returns null when speaker side is empty", () => {
    expect(parseSpeakerLine("：text only")).toBeNull();
  });

  it("does not treat URLs as speaker lines", () => {
    expect(parseSpeakerLine("https://example.com/path")).toBeNull();
  });

  it("rejects suspiciously long 'speaker' (likely a sentence)", () => {
    const longLeft = "这是一段非常长的左边内容超过了说话人长度上限".repeat(2);
    expect(parseSpeakerLine(`${longLeft}：text`)).toBeNull();
  });
});
