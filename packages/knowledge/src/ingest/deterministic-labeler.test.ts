import { describe, expect, it } from "vitest";
import {
  HERTA_FORM_DOLL,
  HERTA_NAME_AMBIGUOUS,
  HERTA_PERSON_PRIME,
  HERTA_PLACE_SPACE_STATION,
  HERTA_WORK_MANUSCRIPT,
} from "../schema.js";
import { labelDocument, pageSubjectFor } from "./deterministic-labeler.js";

describe("pageSubjectFor", () => {
  it.each([
    ["data/角色图鉴/019_大黑塔.html", HERTA_PERSON_PRIME],
    ["data/角色图鉴/078_黑塔.html", HERTA_FORM_DOLL],
    ["data/star_rail_data/角色语音/019_大黑塔.html", HERTA_PERSON_PRIME],
    ["data/star_rail_data/角色语音/078_黑塔.html", HERTA_FORM_DOLL],
    ["data/星海纪闻/003_空间站「黑塔」.html", HERTA_PLACE_SPACE_STATION],
    ["data/book_html/013_黑塔的手稿.html", HERTA_WORK_MANUSCRIPT],
  ])("%s -> %s", (path, expected) => {
    expect(pageSubjectFor(path, "")).toBe(expected);
  });

  it("falls back to title scan when path is unknown", () => {
    expect(pageSubjectFor("data/other/x.html", "黑塔的手稿（节选）")).toBe(
      HERTA_WORK_MANUSCRIPT,
    );
  });

  it("returns undefined when no signal", () => {
    expect(pageSubjectFor("data/other/x.html", "无关标题")).toBeUndefined();
  });
});

describe("labelDocument", () => {
  const baseDoc = {
    id: "doc1",
    path: "data/plot_html/开拓续闻/001.html",
    title: "天才群星闪耀时",
    chunks: [
      {
        id: "c1",
        sectionPath: ["剧情内容", "与黑塔交谈"],
        speaker: "黑塔",
        text: "本人远程操纵此处的人偶。",
        isDialogue: true,
      },
      {
        id: "c2",
        sectionPath: ["剧情内容"],
        speaker: undefined,
        text: "空间站「黑塔」内灯火通明。",
        isDialogue: false,
      },
    ],
  } as const;

  it("maps speaker label '黑塔' to prime + doll embodiment when doll signals fire", () => {
    const out = labelDocument(baseDoc);
    const c1 = out.find((r) => r.chunkId === "c1");
    const speakerMention = c1?.mentions.find(
      (m) => m.surface === "黑塔" && m.speakerEntityId,
    );
    expect(speakerMention?.speakerEntityId).toBe(HERTA_PERSON_PRIME);
    expect(speakerMention?.embodimentEntityId).toBe(HERTA_FORM_DOLL);
    expect(c1?.isHertaVoiceEvidence).toBe(true);
  });

  it("maps speaker label '大黑塔' to prime voice evidence — no doll checks (alias gap found in herta.person.prime scenes, 2026-08-31)", () => {
    const out = labelDocument({
      id: "doc-amph",
      // A doll-signal path on purpose: the surface 大黑塔 is unambiguous and
      // must stay prime even where 黑塔 would earn a doll embodiment.
      path: "data/plot_html/模拟宇宙/x.html",
      title: "在第八日启程",
      chunks: [
        {
          id: "cd",
          sectionPath: ["剧情内容"],
          speaker: "大黑塔",
          text: "——何为「神性」？",
          isDialogue: true,
        },
      ],
    });
    const c = out.find((r) => r.chunkId === "cd");
    const m = c?.mentions.find((mn) => mn.speakerEntityId !== undefined);
    expect(m?.surface).toBe("大黑塔");
    expect(m?.speakerEntityId).toBe(HERTA_PERSON_PRIME);
    expect(m?.embodimentEntityId).toBeUndefined();
    expect(c?.isHertaVoiceEvidence).toBe(true);
  });

  it("maps '空间站「黑塔」' to the station, not the person", () => {
    const out = labelDocument(baseDoc);
    const c2 = out.find((r) => r.chunkId === "c2");
    const m = c2?.mentions.find((mn) => mn.surface === "空间站「黑塔」");
    expect(m?.referentEntityId).toBe(HERTA_PLACE_SPACE_STATION);
  });

  it("leaves bare '黑塔' ambiguous when no contextual signals", () => {
    const out = labelDocument({
      id: "doc-x",
      path: "data/other/y.html",
      title: "无关标题",
      chunks: [
        {
          id: "cx",
          sectionPath: [],
          speaker: undefined,
          text: "黑塔出现了。",
          isDialogue: false,
        },
      ],
    });
    const c = out.find((r) => r.chunkId === "cx");
    const m = c?.mentions.find((mn) => mn.surface === "黑塔");
    expect(m?.referentEntityId).toBe(HERTA_NAME_AMBIGUOUS);
    expect(m?.confidence).toBeLessThan(0.65);
  });
});

describe("Phase 2A heuristic tightening", () => {
  it("title with 「黑塔」 (no 空间站 prefix) maps to station page-subject", () => {
    expect(
      pageSubjectFor(
        "data/book_html/001_「黑塔」资产定损清单.html",
        "「黑塔」资产定损清单",
      ),
    ).toBe(HERTA_PLACE_SPACE_STATION);
  });

  it("title with 黑塔藏品间 maps to station page-subject", () => {
    expect(
      pageSubjectFor(
        "data/book_html/027_黑塔藏品间使用守则.html",
        "黑塔藏品间使用守则",
      ),
    ).toBe(HERTA_PLACE_SPACE_STATION);
  });

  it("emits a station mention for 「黑塔」 in text body (no 空间站 prefix)", () => {
    const out = labelDocument({
      id: "doc-x",
      path: "data/book_html/003_猎彗人来信.html",
      title: "猎彗人来信",
      chunks: [
        {
          id: "cx",
          sectionPath: ["猎彗人来信(一)"],
          speaker: undefined,
          text: "反物质军团包围「黑塔」这桩新闻仍未平息。",
          isDialogue: false,
        },
      ],
    });
    const m = out[0]?.mentions.find((mn) => mn.surface === "「黑塔」");
    expect(m?.referentEntityId).toBe(HERTA_PLACE_SPACE_STATION);
    expect(m?.confidence).toBeGreaterThanOrEqual(0.8);
    expect(m?.confidence).toBeLessThan(0.99);
    // No duplicate bare-黑塔 mention should be emitted alongside.
    expect(out[0]?.mentions.length).toBe(1);
  });

  it("「黑塔」 in text near prime-counter signal stays ambiguous", () => {
    const out = labelDocument({
      id: "doc-y",
      path: "data/other/y.html",
      title: "无关标题",
      chunks: [
        {
          id: "cy",
          sectionPath: [],
          speaker: undefined,
          text: "「黑塔」本人亲自现身。",
          isDialogue: false,
        },
      ],
    });
    const station = out[0]?.mentions.find(
      (mn) =>
        mn.surface === "「黑塔」" &&
        mn.referentEntityId === HERTA_PLACE_SPACE_STATION,
    );
    expect(station).toBeUndefined();
  });
});
