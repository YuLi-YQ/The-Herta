import { describe, expect, it } from "vitest";
import {
  extractTrailblazerLines,
  validateUserLines,
} from "./user-line-gate.js";

const ZWSP = "​";

describe("extractTrailblazerLines", () => {
  it("pulls every （开拓者 说） block body, trimmed", () => {
    const feian = [
      "### 废案_09：某夜",
      "",
      "叙述开场。",
      "",
      "---",
      "",
      "（开拓者 说）",
      "第一句话。",
      "（/开拓者 说）",
      "",
      "（我 说）",
      "我的回答。",
      "（/我 说）",
      "",
      "（开拓者 说）",
      "第二句话，跨了",
      "两行。",
      "（/开拓者 说）",
    ].join("\n");
    expect(extractTrailblazerLines(feian)).toEqual([
      "第一句话。",
      "第二句话，跨了\n两行。",
    ]);
  });

  it("returns [] for a narration-only page", () => {
    expect(
      extractTrailblazerLines("### 废案_10：无对白\n\n只有叙述。"),
    ).toEqual([]);
  });
});

describe("validateUserLines", () => {
  const SOURCE = [
    "黑塔女士，我把 josephus.mjs 翻了个底朝天，没有那行 console.log 啊。是它改完又自己删了，还是我看漏了？",
    "行，链表版我自己重写，写完再来对答案。",
  ];

  const page = (userBlocks: readonly string[]): string =>
    [
      "### 废案_11：测试页",
      "",
      "叙述。",
      "",
      "---",
      "",
      ...userBlocks.flatMap((b) => ["（开拓者 说）", b, "（/开拓者 说）", ""]),
    ].join("\n");

  it("passes verbatim quotation", () => {
    expect(validateUserLines(page([SOURCE[0] as string]), SOURCE).ok).toBe(
      true,
    );
  });

  it("passes truncation of a real line", () => {
    expect(
      validateUserLines(
        page(["黑塔女士，我把 josephus.mjs 翻了个底朝天"]),
        SOURCE,
      ).ok,
    ).toBe(true);
  });

  it("passes whitespace / zero-width divergence (escapeUserText plants ZWSPs)", () => {
    const sourceWithZwsp = [`我能 @${ZWSP}板砖 一下吗？这个问题很长很具体。`];
    const dreamed = page(["我能 @板砖 一下吗？这个问题很长很具体。"]);
    expect(validateUserLines(dreamed, sourceWithZwsp).ok).toBe(true);
  });

  it("passes a long line elided in the MIDDLE, line by line", () => {
    const dreamed = page([
      "黑塔女士，我把 josephus.mjs 翻了个底朝天\n是它改完又自己删了，还是我看漏了？",
    ]);
    expect(validateUserLines(dreamed, SOURCE).ok).toBe(true);
  });

  it("ignores tiny interjections (below the fragment floor)", () => {
    expect(validateUserLines(page(["嗯。"]), SOURCE).ok).toBe(true);
  });

  it("REJECTS invented dialogue — the counterfeit 废案_10 shape (persona E2E 2026-08-11)", () => {
    // Four user turns the 开拓者 never typed, passed by the LLM faithfulness
    // critique because they "fit the theme". The structural gate is exactly
    // what catches them.
    const counterfeit = page([
      "它还带自己删代码的？这算不算……越权？",
      "所以工具比我聪明，我该习惯了？",
      "那我下次写「板砖改完代码后保留调试语句」？",
      "懂了。那我去删掉自己加的调试行了。今晚交作业，谢谢黑塔女士。",
    ]);
    const result = validateUserLines(counterfeit, SOURCE);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(4);
    expect(result.errors[0]).toContain("不存在的开拓者台词");
    expect(result.errors[0]).toContain("越权");
  });

  it("REJECTS paraphrase — quotation is the contract, not similarity", () => {
    const paraphrased = page([
      "黑塔女士，我把那个约瑟夫环文件整个翻遍了也没找到打印语句。",
    ]);
    expect(validateUserLines(paraphrased, SOURCE).ok).toBe(false);
  });

  it("a mixed page fails on its invented block only", () => {
    const mixed = page([
      SOURCE[1] as string,
      "这句是编出来的，记录里从来没有过。",
    ]);
    const result = validateUserLines(mixed, SOURCE);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
  });

  it("passes a narration-only page (nothing quoted, nothing invented)", () => {
    expect(
      validateUserLines("### 废案_12：无对白\n\n只有叙述。", SOURCE).ok,
    ).toBe(true);
  });
});
