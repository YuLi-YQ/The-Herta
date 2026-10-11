import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  PLACEHOLDERS,
  toSherpaText,
  lexiconHasPlaceholders,
  createSherpaTextMapper,
} = require("./sherpa-punctuation.cjs") as {
  PLACEHOLDERS: Record<string, string>;
  toSherpaText: (text: string) => string;
  lexiconHasPlaceholders: (lexicon: string) => boolean;
  createSherpaTextMapper: (opts: {
    lexiconZhText: string;
    lexiconEnText?: string;
  }) => {
    punctuation: boolean;
    english: boolean;
    phonemeRows: number;
    toSherpaText: (text: string) => string;
  };
};

const punctuationRows = Object.entries(PLACEHOLDERS)
  .map(([ch, syms]) => `${ch} ${syms}`)
  .join("\n");
/** A lexicon head the way the generator writes it: punctuation, space,
 *  dash, then phoneme rows — followed by real rows ending in "/". */
const PHONE: Record<string, string> = {
  p: "鿰",
  ˈ: "鿱",
  ɑ: "鿲",
  ɹ: "鿳",
  s: "鿴",
  ə: "鿵",
  ɛ: "鿶",
  k: "鿷",
  O: "鿸",
};
// The test's pool starts past the punctuation block, so the two sets never
// collide; in the real file the generator picks the code points.
const fullLexiconZh = [
  punctuationRows,
  `鿪 ␣`,
  `鿫 —`,
  ...Object.entries(PHONE).map(([sym, ch]) => `${ch} ${sym}`),
  "一 ㄧ 1 /",
  "版本 ㄅ ㄢ 2 ㄅ ㄣ 3 /",
].join("\n");
const lexiconEn = [
  "parser p ˈ ɑ ɹ s ə ɹ",
  "echo ˈ ɛ k O",
  "PORT p ˈ ɔ ɹ t",
].join("\n");

describe("sherpa punctuation placeholders", () => {
  it("uses ideographs inside sherpa's CJK run range, each carrying token symbols", () => {
    for (const [ch, syms] of Object.entries(PLACEHOLDERS)) {
      expect(/^[一-鿿]$/.test(ch), ch).toBe(true);
      expect(syms.split(" ").every((s) => s.length > 0)).toBe(true);
    }
    expect(Object.keys(PLACEHOLDERS)).toHaveLength(10);
  });

  it("substitutes full-width marks, keeps the words, and ends a unit on the bare mark", () => {
    expect(toSherpaText("嗯，这份记录的顺序有问题，把原始版本拿来。")).toBe(
      "嗯鿠这份记录的顺序有问题鿠把原始版本拿来鿧",
    );
    expect(toSherpaText("是你？挑这个时间点！先想：一、二；再说……")).toBe(
      "是你鿢挑这个时间点鿣先想鿥一鿠二鿤再说鿦鿦",
    );
    expect(toSherpaText("不要真去偷！")).toBe("不要真去偷鿩");
    expect(toSherpaText("是你？")).toBe("是你鿨");
  });

  it("substitutes ASCII marks only after a CJK character", () => {
    expect(toSherpaText("代码在 scripts merge sort 点 py，好。")).toBe(
      "代码在 scripts merge sort 点 py鿠好鿧",
    );
    expect(toSherpaText("版本 v1.2 不对.")).toBe("版本 v1.2 不对鿧");
    expect(toSherpaText("Hm, the order is wrong.")).toBe(
      "Hm, the order is wrong.",
    );
  });

  it("recognizes a lexicon only when the rows lead it", () => {
    expect(lexiconHasPlaceholders(`${punctuationRows}\n一 ㄧ 1 /\n`)).toBe(
      true,
    );
    expect(lexiconHasPlaceholders("一 ㄧ 1 /\n")).toBe(false);
    expect(lexiconHasPlaceholders("")).toBe(false);
  });
});

describe("the mapper with phoneme rows and an English lexicon", () => {
  const m = createSherpaTextMapper({
    lexiconZhText: fullLexiconZh,
    lexiconEnText: lexiconEn,
  });
  // the generator's rows in this fixture
  const parser = "鿰鿱鿲鿳鿴鿵鿳";
  const echo = "鿱鿶鿷鿸";
  const sp = "鿪";
  const dash = "鿫";

  it("reads the space, dash and phoneme rows back from the lexicon", () => {
    expect(m.punctuation).toBe(true);
    expect(m.english).toBe(true);
    expect(m.phonemeRows).toBe(Object.keys(PHONE).length);
  });

  it("spells a known English word in ideographs, set off by the space token", () => {
    expect(m.toSherpaText("行。板砖 去把 parser 的游标修了。")).toBe(
      `行鿡板砖${sp}去把${sp}${parser}${sp}的游标修了鿧`,
    );
    // no space in the source text: the space token is still inserted
    expect(m.toSherpaText("用parser处理。")).toBe(
      `用${sp}${parser}${sp}处理鿧`,
    );
  });

  it("leaves a word the lexicon lacks (or cannot spell) Latin, case-insensitively otherwise", () => {
    // PORT is in the lexicon but ɔ and t have no rows in this fixture
    expect(m.toSherpaText("设了 PORT，好。")).toBe(`设了${sp}PORT鿠好鿧`);
    expect(m.toSherpaText("跑 py 文件")).toBe(`跑${sp}py${sp}文件`);
    expect(m.toSherpaText("Echo 和 ECHO")).toBe(`${echo}${sp}和${sp}${echo}`);
  });

  it("turns dashes into the dash token and a space between Chinese words into the space token", () => {
    expect(m.toSherpaText("不用给——你已经设了")).toBe(
      `不用给${dash}${dash}你已经设了`,
    );
    expect(m.toSherpaText("不过 那个值")).toBe(`不过${sp}那个值`);
  });

  it("lets the punctuation row carry the space after a mark", () => {
    expect(m.toSherpaText("嗯， 板砖 去。")).toBe(`嗯鿠板砖${sp}去鿧`);
    expect(m.toSherpaText("Hm, the echo.")).toBe(`Hm,${sp}the${sp}${echo}鿧`);
  });

  it("degrades to punctuation only without an English lexicon or phoneme rows", () => {
    const noEn = createSherpaTextMapper({ lexiconZhText: fullLexiconZh });
    expect(noEn.english).toBe(false);
    expect(noEn.toSherpaText("去把 parser 的游标。")).toBe(
      "去把 parser 的游标鿧",
    );
    const bare = createSherpaTextMapper({
      lexiconZhText: `${punctuationRows}\n一 ㄧ 1 /\n`,
      lexiconEnText: lexiconEn,
    });
    expect(bare.english).toBe(false);
    expect(bare.punctuation).toBe(true);
    const none = createSherpaTextMapper({ lexiconZhText: "一 ㄧ 1 /\n" });
    expect(none.punctuation).toBe(false);
    expect(none.toSherpaText("嗯，好。")).toBe("嗯，好。");
  });
});
