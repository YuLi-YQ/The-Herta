import type { TerminalRecordBlock } from "@herta/core";
import { describe, expect, it } from "vitest";
import { selectEpisodes } from "./select-episodes.js";
import type { Episode } from "./types.js";

const h = (text: string): TerminalRecordBlock => ({
  kind: "herta",
  surface: "speech",
  text,
});
const u = (text: string): TerminalRecordBlock => ({ kind: "user", text });

const ep = (blocks: TerminalRecordBlock[], settled = true): Episode => ({
  sessionId: "s",
  episodeHash: blocks
    .map((b) => (b.kind === "system" ? b.body : b.text))
    .join("|"),
  blocks,
  startIndex: 0,
  endIndex: blocks.length,
  settled,
});

const OPTS = { minHertaBlocks: 2, minEpisodeChars: 10 };

describe("selectEpisodes", () => {
  it("accepts a non-coding episode with enough Herta voice", () => {
    const e = ep([u("聊聊"), h("阮·梅又在搞事。"), h("不过这次我懒得管。")]);
    expect(selectEpisodes([e], OPTS)).toEqual([e]);
  });
  it("rejects an episode with too few Herta blocks", () => {
    expect(selectEpisodes([ep([u("hi"), h("嗯。")])], OPTS)).toEqual([]);
  });
  it("rejects a too-short episode", () => {
    expect(
      selectEpisodes([ep([h("a"), h("b")])], { ...OPTS, minEpisodeChars: 100 }),
    ).toEqual([]);
  });
  it("rejects an unsettled (in-progress) trailing episode", () => {
    expect(
      selectEpisodes([ep([u("x"), h("yy"), h("zz")], false)], OPTS),
    ).toEqual([]);
  });
  it("does NOT require a coding outcome", () => {
    const e = ep([u("闲聊"), h("终端外面又有噪声。"), h("我假装没听见。")]);
    expect(selectEpisodes([e], OPTS)).toContain(e);
  });
  it("does not count live-work chrome bodies toward the char floor", () => {
    const chrome: TerminalRecordBlock = {
      kind: "system",
      label: "差分协处理器",
      body: `todo list (3):\n${"[ ] 一个非常长的待办事项描述\n".repeat(20)}`,
      digest: { kind: "todo", total: 3, completed: 0 },
    };
    // Herta text alone is far under the floor; only the chrome body could
    // push it over — and it must not.
    const e = ep([u("x"), h("嗯。"), h("好。"), chrome]);
    expect(selectEpisodes([e], { ...OPTS, minEpisodeChars: 100 })).toEqual([]);
  });
  it("counts only the conversation toward the char floor — 板砖's rows are evidence, not voice (dream review 2026-09-22, finding 16)", () => {
    // The head chunk of a long run: a short ask, a dispatch, and a page of
    // op rows. It used to clear the floor on the rows and cost a worthiness
    // call to be rejected as a task ledger.
    const rows: TerminalRecordBlock[] = Array.from({ length: 40 }, (_, i) => ({
      kind: "system",
      label: "差分协处理器",
      body: `Reading packages/core/src/module-${i}.ts`,
      digest: {
        kind: "op",
        verb: "Reading",
        arg: `packages/core/src/module-${i}.ts`,
      },
    }));
    const marker: TerminalRecordBlock = {
      kind: "system",
      label: "差分协处理器",
      body: `完成 · 1 个文件 · ${"证据".repeat(60)}`,
      role: "done-marker",
    };
    const thin = ep([
      u("修一下"),
      h("嗯。"),
      h("@板砖 去修。"),
      ...rows,
      marker,
    ]);
    expect(selectEpisodes([thin], { ...OPTS, minEpisodeChars: 100 })).toEqual(
      [],
    );
    // The same run with Herta actually saying something passes.
    const voiced = ep([
      u("修一下 parser 的游标，昨天那个回归"),
      h("又是游标。上次就是它在多字节字符上少走一格。"),
      h("@板砖 去修，改完跑定向测试，别碰别的。"),
      ...rows,
      marker,
      h("修好了。只跑了定向测试，全量没跑，别拿去当全绿。"),
    ]);
    expect(
      selectEpisodes([voiced], { ...OPTS, minEpisodeChars: 60 }),
    ).toContain(voiced);
  });
  it("rejects an episode with only herta thought blocks (no speech)", () => {
    const t = (text: string): TerminalRecordBlock => ({
      kind: "herta",
      surface: "thought",
      text,
    });
    const e = ep([
      u("x 这是一段足够长的内容"),
      t("内心独白其一"),
      t("内心独白其二"),
    ]);
    expect(selectEpisodes([e], OPTS)).toEqual([]);
  });
});
