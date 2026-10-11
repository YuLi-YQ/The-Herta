import { describe, expect, it } from "vitest";
import {
  aliasBanzhuanPlain,
  aliasBrickInput,
  BANZHUAN_MENTION,
  dealiasBrickDraft,
  tokenizeBanzhuanMentions,
} from "./banzhuan-mention.js";

describe("tokenizeBanzhuanMentions", () => {
  it("keeps the literal in sync with the dispatch token", () => {
    // Mirrors BANZHUAN_TRIGGER in packages/herta/src/narrative/parse.ts.
    expect(BANZHUAN_MENTION).toBe("@板砖");
  });

  it("returns [] for empty text", () => {
    expect(tokenizeBanzhuanMentions("")).toEqual([]);
  });

  it("plain text becomes a single text node", () => {
    expect(tokenizeBanzhuanMentions("hello")).toEqual([
      { kind: "text", value: "hello" },
    ]);
  });

  it("a bare mention at the start is a mention node", () => {
    expect(tokenizeBanzhuanMentions("@板砖")).toEqual([
      { kind: "mention", value: "@板砖" },
    ]);
  });

  it("a mention after a space splits text + mention + text", () => {
    expect(tokenizeBanzhuanMentions("do @板砖 now")).toEqual([
      { kind: "text", value: "do " },
      { kind: "mention", value: "@板砖" },
      { kind: "text", value: " now" },
    ]);
  });

  it("a mention attached to a preceding char still chips (xxx@板砖)", () => {
    expect(tokenizeBanzhuanMentions("x@板砖")).toEqual([
      { kind: "text", value: "x" },
      { kind: "mention", value: "@板砖" },
    ]);
  });

  it("two adjacent mentions are two nodes", () => {
    expect(tokenizeBanzhuanMentions("@板砖@板砖")).toEqual([
      { kind: "mention", value: "@板砖" },
      { kind: "mention", value: "@板砖" },
    ]);
  });

  it("a partial @板 is plain text (no mention)", () => {
    expect(tokenizeBanzhuanMentions("@板")).toEqual([
      { kind: "text", value: "@板" },
    ]);
  });

  it("a backtick-quoted `@板砖` is NOT a mention", () => {
    const nodes = tokenizeBanzhuanMentions("use `@板砖` token");
    expect(nodes.some((n) => n.kind === "mention")).toBe(false);
    expect(nodes.map((n) => n.value).join("")).toBe("use `@板砖` token");
  });

  it("mixes a bare mention with a backticked one", () => {
    const nodes = tokenizeBanzhuanMentions("@板砖 vs `@板砖`");
    expect(nodes.filter((n) => n.kind === "mention")).toHaveLength(1);
    expect(nodes.map((n) => n.value).join("")).toBe("@板砖 vs `@板砖`");
  });
});

describe("tokenizeBanzhuanMentions — matchBrickInput (EN composer input form)", () => {
  it("does NOT chip a typed @brick by default (bubbles never see the input form)", () => {
    expect(tokenizeBanzhuanMentions("hand @brick this")).toEqual([
      { kind: "text", value: "hand @brick this" },
    ]);
  });

  it("chips a typed @brick with the LITERAL matched text, case preserved", () => {
    expect(
      tokenizeBanzhuanMentions("hand @Brick this", { matchBrickInput: true }),
    ).toEqual([
      { kind: "text", value: "hand " },
      { kind: "mention", value: "@Brick" },
      { kind: "text", value: " this" },
    ]);
    expect(
      tokenizeBanzhuanMentions("@brick", { matchBrickInput: true }),
    ).toEqual([{ kind: "mention", value: "@brick" }]);
  });

  it("boundary-safe: an embedded @brick or a suffixed @bricks never chips", () => {
    expect(
      tokenizeBanzhuanMentions("bob@brick.io and @bricks", {
        matchBrickInput: true,
      }),
    ).toEqual([{ kind: "text", value: "bob@brick.io and @bricks" }]);
  });

  it("chips the literal @板砖 AND a typed @brick side by side", () => {
    expect(
      tokenizeBanzhuanMentions("@板砖 or @brick", { matchBrickInput: true }),
    ).toEqual([
      { kind: "mention", value: "@板砖" },
      { kind: "text", value: " or " },
      { kind: "mention", value: "@brick" },
    ]);
  });

  it("a backtick-quoted `@brick` stays a code node (quotation, not a mention)", () => {
    const nodes = tokenizeBanzhuanMentions("use `@brick` here", {
      matchBrickInput: true,
    });
    expect(nodes.some((n) => n.kind === "mention")).toBe(false);
    expect(nodes.map((n) => n.value).join("")).toBe("use `@brick` here");
  });
});

describe("aliasBanzhuanPlain — plain-string 板砖→Brick alias", () => {
  it("maps @板砖→@Brick and bare 板砖→Brick in an EN string", () => {
    expect(aliasBanzhuanPlain("hand @板砖 the bug; 板砖 is idle", "en")).toBe(
      "hand @Brick the bug; Brick is idle",
    );
  });

  it("leaves a zh string byte-identical", () => {
    expect(aliasBanzhuanPlain("交给 @板砖，板砖 闲着", "zh")).toBe(
      "交给 @板砖，板砖 闲着",
    );
  });

  it("is a no-op when there is no 板砖", () => {
    expect(aliasBanzhuanPlain("just a normal message", "en")).toBe(
      "just a normal message",
    );
  });
});

describe("aliasBrickInput — submit-time @brick→@板砖 conversion", () => {
  it("converts a typed @brick (any case) to the wire token in EN", () => {
    expect(aliasBrickInput("hand @Brick the bug", "en")).toBe(
      "hand @板砖 the bug",
    );
    expect(aliasBrickInput("try @brick and @BRICK", "en")).toBe(
      "try @板砖 and @板砖",
    );
  });

  it("boundary-safe: embedded / suffixed forms never convert", () => {
    expect(aliasBrickInput("bob@brick.io and @bricks", "en")).toBe(
      "bob@brick.io and @bricks",
    );
  });

  // Code-span exemption (audit 2026-07-16): a backticked `@brick` is the
  // user QUOTING the token, not typing it. Kept in lockstep with the CLI's
  // aliasBrickInput (packages/cli/src/render/banzhuan-alias.ts).
  it("leaves a backticked `@brick` untouched", () => {
    expect(aliasBrickInput("how do I write `@brick` here?", "en")).toBe(
      "how do I write `@brick` here?",
    );
  });

  it("mixed line: converts outside a span, keeps the span verbatim", () => {
    expect(
      aliasBrickInput("ask @brick about `@brick --help` then @Brick", "en"),
    ).toBe("ask @板砖 about `@brick --help` then @板砖");
  });

  it("is a no-op for zh", () => {
    expect(aliasBrickInput("交给 @Brick 处理", "zh")).toBe("交给 @Brick 处理");
  });
});

describe("dealiasBrickDraft — rewind-restored composer draft (round-trip)", () => {
  it("maps ONLY the @ trigger form back to @Brick in EN", () => {
    expect(dealiasBrickDraft("hand @板砖 the bug; 板砖 is idle", "en")).toBe(
      "hand @Brick the bug; 板砖 is idle",
    );
  });

  it("leaves a zh draft byte-identical", () => {
    expect(dealiasBrickDraft("交给 @板砖，板砖 闲着", "zh")).toBe(
      "交给 @板砖，板砖 闲着",
    );
  });
});
