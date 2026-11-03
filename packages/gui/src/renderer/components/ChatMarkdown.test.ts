import { describe, expect, it } from "vitest";
import type { HertaChatMessage } from "../../shared/herta-chat.js";
import { buildChatMarkdown } from "./ChatMarkdown.js";

const NOW = new Date("2026-10-30T06:00:00Z");
const message = (
  over: Partial<HertaChatMessage> &
    Pick<HertaChatMessage, "id" | "role" | "text">,
): HertaChatMessage => ({
  at: "2026-10-30T01:00:00Z",
  status: "complete",
  ...over,
});

describe("buildChatMarkdown (F09 /export, R124)", () => {
  it("writes the chat as the window shows it: files by name and kind only, and where the 续聊范围 starts", () => {
    const markdown = buildChatMarkdown(
      {
        title: "  旅行\n计划 ",
        contextStart: 2,
        contextNote: "预算一万以内",
        messages: [
          message({
            id: "u1",
            role: "user",
            text: "看看这两份",
            attachments: [
              {
                name: "行程.pdf",
                text: "第一天：秘密内容",
                format: "pdf",
                pages: 3,
              },
              {
                name: "截图.png",
                text: "",
                imageDeferred: true,
                modelUse: "stopped",
              },
            ],
          }),
          message({
            id: "a1",
            role: "assistant",
            text: "收到。",
            reasoning: "先想一想",
            at: "2026-10-30T01:00:30Z",
          }),
          message({
            id: "u2",
            role: "user",
            text: "继续",
            at: "2026-10-30T02:00:00Z",
            attachments: [
              { name: "清单.docx", text: "清单内容", format: "docx" },
              { name: "note.txt", text: "笔记内容" },
            ],
          }),
          message({
            id: "a2",
            role: "assistant",
            text: "好的，",
            status: "cancelled",
            at: "2026-10-30T02:00:10Z",
          }),
        ],
      },
      { now: NOW, timeZone: "Asia/Tokyo" },
    );
    expect(markdown).toBe(
      `${[
        "# 旅行 计划",
        "开始于 2026-10-30 10:00 · 导出于 2026-10-30 15:00",
        "**你** · 2026-10-30 10:00\n\n附件：行程.pdf（PDF · 3 页）、截图.png（图片 · 不再发给模型）\n\n看看这两份",
        "**黑塔** · 2026-10-30 10:00\n\n收到。",
        "---",
        "*黑塔从这里开始参考；更早的内容只保留在记录中*",
        "**续聊要点**\n\n预算一万以内",
        "**你** · 2026-10-30 11:00\n\n附件：清单.docx（Word）、note.txt（文本）\n\n继续",
        "**黑塔** · 2026-10-30 11:00 · 已停止\n\n好的，",
      ].join("\n\n")}\n`,
    );
    // Never what a file says, nor the thinking.
    expect(markdown).not.toContain("秘密内容");
    expect(markdown).not.toContain("笔记内容");
    expect(markdown).not.toContain("先想一想");
  });

  it("marks the range after the last message when only the next one counts, and the 续聊要点 first when all of it does", () => {
    const messages = [
      message({ id: "u1", role: "user", text: "你好" }),
      message({ id: "a1", role: "assistant", text: "", status: "failed" }),
    ];
    const opts = { now: NOW, timeZone: "Asia/Tokyo" };
    expect(
      buildChatMarkdown(
        { title: " ", messages, contextStart: 2, contextNote: "" },
        opts,
      ).split("\n\n"),
    ).toEqual([
      "# 新聊天",
      "开始于 2026-10-30 10:00 · 导出于 2026-10-30 15:00",
      "**你** · 2026-10-30 10:00",
      "你好",
      "**黑塔** · 2026-10-30 10:00 · 回复未完成",
      "---",
      "*黑塔从这里开始参考；更早的内容只保留在记录中*\n",
    ]);
    const whole = buildChatMarkdown(
      { title: "t", messages, contextStart: 0, contextNote: " 要点 " },
      opts,
    );
    expect(whole).not.toContain("---");
    expect(whole.indexOf("**续聊要点**\n\n要点")).toBeGreaterThan(0);
    expect(whole.indexOf("**续聊要点**")).toBeLessThan(whole.indexOf("**你**"));
  });
});
