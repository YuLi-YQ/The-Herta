import type { TerminalRecord } from "@herta/core";
import { describe, expect, it } from "vitest";
import { extractUserMessages } from "./backend-user-history.js";

describe("extractUserMessages — what 板砖 is told the user asked", () => {
  it("a 继续 block is the harness's own turn, not a task the user set (review 2026-09-30)", () => {
    const record = [
      { kind: "user", text: "修 parser" },
      { kind: "herta", surface: "speech", text: "好。" },
      { kind: "user", text: "继续", resume: true },
      { kind: "user", text: "再跑一遍测试" },
    ] as unknown as TerminalRecord;
    expect(extractUserMessages(record).messages.map((m) => m.text)).toEqual([
      "修 parser",
      "再跑一遍测试",
    ]);
  });
});

// F02 design 2.8 (R121): where the host attaches the delegation's pictures to the executor's
// request itself, a picture's line names it as a picture and says where it is.
describe("extractUserMessages — a picture the host attaches to the request", () => {
  const PATH = ".herta/attachments/s1/screen-ab12cd34.png";
  const picture = (over: Record<string, unknown> = {}) =>
    [
      {
        kind: "system",
        label: "系统",
        body: `附件 screen.png · ${PATH}`,
        digest: {
          kind: "attachment",
          name: "screen.png",
          path: PATH,
          lines: 0,
          chars: 0,
          image: { format: "png", width: 1, height: 1 },
          ...over,
        },
      },
      { kind: "user", text: "按截图改" },
    ] as unknown as TerminalRecord;
  const lineOf = (
    record: TerminalRecord,
    lang: "zh" | "en",
    picturesAttached?: boolean,
  ) =>
    extractUserMessages(
      record,
      lang,
      picturesAttached === undefined ? undefined : { picturesAttached },
    ).messages[0]?.text;

  it("names a picture with a stored copy as a picture that file tools cannot show, and says where a sent one is", () => {
    // Delivered to models (the personal build), or stored without a caption.
    for (const over of [
      {},
      { unreadable: "no_caption" },
      { unreadable: "too_large" },
    ]) {
      expect(lineOf(picture(over), "zh", true)).toBe(
        `〔附件〕开拓者提供了图片：screen.png，位于 ${PATH}（相对工作区根目录）。文件工具无法显示图片。若它发给了你，就附在本次对话开头的用户消息中；那里没有附带它，就是没有发给你。`,
      );
      expect(lineOf(picture(over), "en", true)).toBe(
        `[attachment] The Trailblazer provided a picture: screen.png — at ${PATH} (relative to the workspace root). File tools cannot show you a picture. If it was sent to you, it is attached to one of the user messages that open this conversation; if it is not attached there, it was not sent to you.`,
      );
    }
  });

  it("keeps the file line as before when the host does not attach pictures (the legacy stack mounts view_image)", () => {
    for (const attached of [undefined, false]) {
      expect(lineOf(picture(), "zh", attached)).toBe(
        `〔附件〕开拓者提供了文件：screen.png，位于 ${PATH}（相对工作区根目录）。任务需要时用文件工具自行读取。`,
      );
      expect(
        lineOf(picture({ unreadable: "no_caption" }), "en", attached),
      ).toBe(
        `[attachment] The Trailblazer provided a file: screen.png — at ${PATH} (relative to the workspace root). The harness took no excerpt from it (no_caption); it is on disk and you may still search it.`,
      );
    }
  });

  it("changes nothing for a picture with no copy to send, or for any other attachment", () => {
    const records = [
      picture({ unreadable: "removed" }),
      picture({ path: "", unreadable: "denied" }),
      picture({ path: "", unreadable: "read_error" }),
      picture({ image: undefined, name: "notes.txt", lines: 3, chars: 40 }),
      picture({ image: undefined, unreadable: "binary" }),
    ];
    for (const record of records)
      for (const lang of ["zh", "en"] as const)
        expect(lineOf(record, lang, true)).toBe(lineOf(record, lang));
    expect(lineOf(records[0]!, "zh", true)).toContain("随后又撤回了它");
    expect(lineOf(records[3]!, "en", true)).toContain(
      "Read it with your file tools if the task needs it.",
    );
  });
});
