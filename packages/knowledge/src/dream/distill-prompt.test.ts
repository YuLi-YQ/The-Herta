import { describe, expect, it } from "vitest";
import {
  buildCritiquePrompt,
  buildGenerationPrompt,
  buildMergePreservationJudge,
  buildNotesAuditPrompt,
  buildNotesRefinePrompt,
  buildPairwiseVoiceJudge,
  buildReactivationGatePrompt,
  buildReconsolidationJudge,
  buildRedistillPrompt,
  buildRefinePrompt,
  buildSemanticizePrompt,
  buildWorthinessPrompt,
} from "./distill-prompt.js";

const exemplars = ["### 废案_00：终端外侧的噪声\n...正文..."];
const summaries = [
  {
    title: "终端外侧的噪声",
    tag: "dry-banter",
    summary: "阮·梅难得联系我，原来是想让我修她的代码。",
    occasion: "阮·梅发来一段无法验证来源的输入，让我判断真伪。",
  },
];
const occasionLines = [
  { id: "r0:aaaa1111", occasion: "开拓者讲述了他把测试跑挂后甩锅给环境的事。" },
  { id: "r0:bbbb2222", occasion: "阮·梅深夜发来一段她自己写崩的代码求修。" },
];
const sampleGuide =
  "黑塔人物指南：天才俱乐部#83，智识令使，空间站「黑塔」的真正主人。说话高效、不客套、爱吐槽。";
const sampleEnv =
  "黑塔的办公室在空间站顶层。板砖是差分算法并行协处理器，处理编码/文件/命令类任务。";

describe("distill prompts", () => {
  it("worthiness gate is two-sided and asks for JSON yes/no", () => {
    const p = buildWorthinessPrompt("digest text", summaries, sampleEnv);
    expect(p.systemPrompt).toContain("禁止收录清单");
    expect(p.systemPrompt).not.toContain("do-NOT-capture");
    expect(p.systemPrompt.toLowerCase()).toContain("json");
    expect(p.userPayload).toContain("digest text");
    // env injected into worthiness prompt
    expect(p.systemPrompt).toContain(sampleEnv);
  });
  it("worthiness gate extracts the occasion: JSON contract, factual framing, inline example (ADR 0021)", () => {
    const p = buildWorthinessPrompt("digest text", summaries, sampleEnv);
    expect(p.systemPrompt).toContain(
      '{"worthy": boolean, "reason": "string", "occasion": "string", "retellsKnownEvent": boolean, "mixedTopics": boolean}',
    );
    // The unworthy-retell reinforce loop (ADR 0021 §10): the flag is
    // independent of worthy, and the occasion fills even on unworthy calls.
    expect(p.systemPrompt).toContain("retellsKnownEvent");
    expect(p.systemPrompt).toContain("哪怕 worthy 为 false");
    // factual, not the literary angle — with the house-style inline example
    expect(p.systemPrompt).toContain("事实性");
    expect(p.systemPrompt).toContain("不是废案可能采用的文学角度");
    expect(p.systemPrompt).toContain(
      "开拓者讲述了他把 main 分支 force push 覆盖、熬夜用 reflog 恢复提交的事故",
    );
  });
  it("worthiness reject-#4 lists title (tag) ONLY — occasion identity belongs to the gate — and carves out retellings", () => {
    const withLegacy = [
      ...summaries,
      { title: "旧记录", tag: "legacy-tag", summary: "旧记录的开篇摘要。" },
    ];
    const p = buildWorthinessPrompt("digest text", withLegacy, sampleEnv);
    // title + tag present, WITHOUT the occasion line (2026-07-16 lab:
    // occasion-armed worthiness rejected retellings one gate early,
    // swallowing the reactivation signal).
    expect(p.systemPrompt).toContain('- "终端外侧的噪声"（dry-banter）');
    expect(p.systemPrompt).toContain('- "旧记录"（legacy-tag）');
    expect(p.systemPrompt).not.toContain(
      "阮·梅发来一段无法验证来源的输入，让我判断真伪",
    );
    expect(p.systemPrompt).not.toContain("旧记录的开篇摘要");
    // The retelling carve-out routes repeats to the reactivation gate.
    expect(p.systemPrompt).toContain("重述会**强化**既有记忆");
  });
  it("generation prompt carries guide, env, framing, format spec, exemplars, novelty steer, situation-tag ask", () => {
    const p = buildGenerationPrompt(
      "digest text",
      exemplars,
      summaries,
      sampleGuide,
      sampleEnv,
    );
    expect(p.systemPrompt).toContain(sampleGuide); // guide injected
    expect(p.systemPrompt).toContain(sampleEnv); // env injected
    // scene framing line present
    expect(p.systemPrompt).toContain("远程对话");
    expect(p.systemPrompt).toContain("星穹列车");
    expect(p.systemPrompt).toContain("终端外侧的噪声"); // exemplar/title steer
    expect(p.systemPrompt).toContain("废案"); // format spec
    expect(p.systemPrompt).toContain("situation"); // self-declared tag ask
    expect(p.userPayload).toContain("digest text");
    // format template uses 开拓者, not 角色名
    expect(p.systemPrompt).toContain("（开拓者 说）");
    expect(p.systemPrompt).not.toContain("（角色名 说）");
    // prompt strings use 黑塔, not English "Herta"
    expect(p.systemPrompt).toContain("黑塔");
    expect(p.systemPrompt).not.toContain("Herta");
    // no file reference wording
    expect(p.systemPrompt).not.toContain("static prefix");
    expect(p.systemPrompt).not.toContain("SPEC §17");
  });
  it("generation prompt uses guide fallback placeholder when guide is empty", () => {
    const p = buildGenerationPrompt(
      "digest text",
      exemplars,
      summaries,
      "",
      "",
    );
    expect(p.systemPrompt).toContain("黑塔指南缺失");
  });
  it("critique prompt carries guide and targets 黑塔's （我 说）/（我 想） lines and scores voice", () => {
    const p = buildCritiquePrompt("draft 废案 text", sampleGuide);
    expect(p.systemPrompt).toContain(sampleGuide); // guide injected
    expect(p.systemPrompt).toContain("（我 说）");
    expect(p.systemPrompt.toLowerCase()).toContain("voice");
    expect(p.systemPrompt).toContain("黑塔");
    expect(p.systemPrompt).not.toContain("Herta");
    expect(p.userPayload).toContain("draft 废案 text");
    // scene anchor: judges must know 板砖/远程对话 without EnvSet
    // (2026-07-09 review §〇之三)
    expect(p.systemPrompt).toContain("差分协处理器");
    // the novelty rubric must be self-contained — no reference to exemplars
    // or existing 废案 this prompt never receives
    expect(p.systemPrompt).not.toContain("与参考范例和已有废案都明显不同");
    // no signature-stuffing incentive on the voice score
    expect(p.systemPrompt).toContain("不要为了拉高语气分而建议堆砌招牌口头禅");
  });
  it("critique JSON contract carries charge with the calibration anchors (ADR 0023)", () => {
    const p = buildCritiquePrompt("draft 废案 text", sampleGuide);
    expect(p.systemPrompt).toContain(
      '{"voice": 0.0, "format": 0.0, "novelty": 0.0, "charge": 0.0, "fixes": ["问题描述"]}',
    );
    expect(p.systemPrompt).toContain("JSON 键 charge");
    // The calibration ladder: routine ≈ 0.1, real tension ≈ 0.5, ≈ 0.9 for
    // the revelation class — judged on the event, not the prose.
    expect(p.systemPrompt).toContain("日常拌嘴");
    expect(p.systemPrompt).toContain("真实的张力");
    expect(p.systemPrompt).toContain(
      "眼泪、恐惧、一个改变她看待对方方式的揭示",
    );
    expect(p.systemPrompt).toContain("不是文笔好坏");
    // the inline example
    expect(p.systemPrompt).toContain("开拓者例行汇报一次构建失败 ≈ 0.1");
  });

  it("refine prompt carries guide and threads the exact validator errors", () => {
    const p = buildRefinePrompt(
      "draft",
      ["missing `---` separator"],
      sampleGuide,
    );
    expect(p.userPayload).toContain("missing `---` separator");
    expect(p.systemPrompt).toContain(sampleGuide); // guide injected
    expect(p.systemPrompt).toContain("黑塔");
    expect(p.systemPrompt).not.toContain("Herta");
    // scene anchor injected (§〇之三)
    expect(p.systemPrompt).toContain("差分协处理器");
    // rule-1 scope: format fixes must not become blanket voice polish
    // (2026-07-09 review §4c' — the live anti-drift discipline)
    expect(p.systemPrompt).toContain("未被点名的句子保持逐字不变");
  });
  it("reactivation gate carries episode digest+occasion vs live id→occasion pairs (ADR 0021)", () => {
    const p = buildReactivationGatePrompt(
      { digest: "新片段 digest 全文", occasion: "开拓者又讲了一遍那次事故。" },
      occasionLines,
    );
    // episode digest + occasion and every live id→occasion pair land in the payload
    expect(p.userPayload).toContain("新片段 digest 全文");
    expect(p.userPayload).toContain("开拓者又讲了一遍那次事故。");
    expect(p.userPayload).toContain("r0:aaaa1111");
    expect(p.userPayload).toContain("甩锅给环境");
    expect(p.userPayload).toContain("r0:bbbb2222");
    // the reply is keyed on an ID, never a title
    expect(p.systemPrompt).toContain("matchedId");
    expect(p.systemPrompt).not.toContain("matchedTitle");
    expect(p.systemPrompt).toContain("绝不是标题");
    // ADR 0021 match semantics pinned: same real-life event re-told is a
    // match; the same lesson from different events is NOT
    expect(p.systemPrompt).toContain("同一件真实发生的事被再次讲述");
    expect(p.systemPrompt).toContain("不同的事即使带来同一个教训，也不算匹配");
    expect(p.systemPrompt).toContain("情节的丰富性是有意保留的");
    // default-false discipline
    expect(p.systemPrompt).toContain("默认 sameOccasion: false");
  });

  it("reactivation gate omits the occasion field when the extraction was absent", () => {
    const p = buildReactivationGatePrompt(
      { digest: "只有 digest" },
      occasionLines,
    );
    const payload = JSON.parse(p.userPayload) as {
      episode: { digest: string; occasion?: string };
    };
    expect(payload.episode.digest).toBe("只有 digest");
    expect(payload.episode.occasion).toBeUndefined();
  });

  it("merge preservation judge is content-only, default-conservative, and carries all three texts", () => {
    const p = buildMergePreservationJudge(
      "OLD 全文",
      "对阮·梅的判断更锐利",
      "MERGED 全文",
    );
    expect(p.systemPrompt).toContain("preservesOld");
    expect(p.systemPrompt).toContain("containsFacet");
    // content only — voice is the later pairwise gate's job
    expect(p.systemPrompt).toContain("不评语气好坏");
    // uncertain → false
    expect(p.systemPrompt).toContain("拿不准就对它回 false");
    expect(p.userPayload).toContain("OLD 全文");
    expect(p.userPayload).toContain("对阮·梅的判断更锐利");
    expect(p.userPayload).toContain("MERGED 全文");
  });

  it("reconsolidation judge is default-NO and carries OLD full text + the new digest", () => {
    const p = buildReconsolidationJudge(
      "### 废案_01：终端外侧的噪声\n...OLD 全文...",
      "digest of the new episode",
    );
    expect(p.systemPrompt).toContain("默认 false");
    expect(p.systemPrompt).toContain("addsUnderstanding");
    expect(p.systemPrompt).toContain("黑塔");
    expect(p.systemPrompt).not.toContain("Herta");
    // both inputs land in the payload
    expect(p.userPayload).toContain("OLD 全文");
    expect(p.userPayload).toContain("digest of the new episode");
  });

  it("re-distill prompt freezes facts, keeps OLD canonical, and carries the donor moment", () => {
    const p = buildRedistillPrompt(
      "### 废案_01：终端外侧的噪声\n...OLD 全文...",
      "她这次对阮·梅的判断更锐利：不只是懒得管，而是看穿了对方在试探。",
      sampleGuide,
    );
    // Rule 3 — the load-bearing fact-freeze across both sources (reworded for
    // the two-graft-kinds rework: growth is allowed, drift is not)
    expect(p.systemPrompt).toContain("绝不漂移事实");
    // The two graft kinds (matured judgment vs new development of the SAME
    // occasion — the memory may grow) + the acceptance contract
    expect(p.systemPrompt).toContain("成熟了的判断");
    expect(p.systemPrompt).toContain("同一件事的新进展");
    expect(p.systemPrompt).toContain("验收契约");
    // No problems section when no feedback is passed
    expect(p.systemPrompt).not.toContain("上一稿的问题");
    // OLD stays canonical
    expect(p.systemPrompt).toContain("以原废案为准");
    // reconsolidation may sharpen the interpretation layer but not invent
    // motives (website: 记忆是重构 ≠ 虚构)
    expect(p.systemPrompt).toContain("都没有依据的动机或温情解读");
    // guide injected + donor moment present
    expect(p.systemPrompt).toContain(sampleGuide);
    expect(p.systemPrompt).toContain("看穿了对方在试探");
    // scene anchor injected (§〇之三)
    expect(p.systemPrompt).toContain("差分协处理器");
    // OLD full text in the payload
    expect(p.userPayload).toContain("OLD 全文");
    expect(p.systemPrompt).not.toContain("Herta");
  });

  it("re-distill prompt uses a donor fallback when no explicit donor is given", () => {
    const p = buildRedistillPrompt("OLD 全文", "", sampleGuide);
    expect(p.systemPrompt).toContain("未给出具体待移植之处");
    expect(p.systemPrompt).toContain("禁止发明新的心理层次");
  });

  it("pairwise voice judge compares A vs B and asks for a winner", () => {
    const p = buildPairwiseVoiceJudge("A 全文", "B 全文", sampleGuide);
    expect(p.systemPrompt).toContain("winner");
    expect(p.systemPrompt).toContain(sampleGuide);
    expect(p.systemPrompt).toContain("黑塔");
    expect(p.systemPrompt).not.toContain("Herta");
    expect(p.userPayload).toContain("A 全文");
    expect(p.userPayload).toContain("B 全文");
    // scene anchor injected (§〇之三)
    expect(p.systemPrompt).toContain("差分协处理器");
    // the accept gate must not reward length — reconsolidation would
    // otherwise monotonically lengthen 废案 (2026-07-09 review §8a)
    expect(p.systemPrompt).toContain("清楚不等于更长");
  });
});

// EN interaction slice 3b: every builder takes lang ("zh" default). The EN
// variant instructs in English but teaches the SAME CN structural grammar —
// ### 废案 headers, （我 说）/（我 想） fences, @板砖, → 差分协处理器,
// 〔黑塔的自我更正：…〕 / 〔差分协处理器（已核实）：…〕 stay verbatim.
describe("distill prompts (lang)", () => {
  it('omitting lang is byte-identical to explicit "zh" for every builder', () => {
    expect(buildWorthinessPrompt("d", summaries, sampleEnv)).toEqual(
      buildWorthinessPrompt("d", summaries, sampleEnv, "zh"),
    );
    expect(
      buildGenerationPrompt("d", exemplars, summaries, sampleGuide, sampleEnv),
    ).toEqual(
      buildGenerationPrompt(
        "d",
        exemplars,
        summaries,
        sampleGuide,
        sampleEnv,
        "zh",
      ),
    );
    expect(buildCritiquePrompt("draft", sampleGuide)).toEqual(
      buildCritiquePrompt("draft", sampleGuide, "zh"),
    );
    expect(buildRefinePrompt("draft", ["e1"], sampleGuide)).toEqual(
      buildRefinePrompt("draft", ["e1"], sampleGuide, "zh"),
    );
    expect(
      buildReactivationGatePrompt(
        { digest: "d", occasion: "o" },
        occasionLines,
      ),
    ).toEqual(
      buildReactivationGatePrompt(
        { digest: "d", occasion: "o" },
        occasionLines,
        "zh",
      ),
    );
    expect(buildReconsolidationJudge("old", "new")).toEqual(
      buildReconsolidationJudge("old", "new", "zh"),
    );
    expect(buildMergePreservationJudge("old", "facet", "merged")).toEqual(
      buildMergePreservationJudge("old", "facet", "merged", "zh"),
    );
    expect(buildRedistillPrompt("old", "donor", sampleGuide)).toEqual(
      buildRedistillPrompt("old", "donor", sampleGuide, "zh"),
    );
    expect(buildPairwiseVoiceJudge("A", "B", sampleGuide)).toEqual(
      buildPairwiseVoiceJudge("A", "B", sampleGuide, "zh"),
    );
  });

  it("EN worthiness gate instructs in English and keeps the CN digest markers", () => {
    const p = buildWorthinessPrompt("digest text", summaries, sampleEnv, "en");
    expect(p.systemPrompt).toContain("Default to worthy: false");
    expect(p.systemPrompt).toContain("Do-not-capture list");
    // structural tokens stay CN
    expect(p.systemPrompt).toContain("废案");
    expect(p.systemPrompt).toContain("@板砖");
    expect(p.systemPrompt).toContain("（我 想）");
    expect(p.systemPrompt).toContain("〔黑塔的自我更正：…〕");
    // env + dedup titles still injected
    expect(p.systemPrompt).toContain(sampleEnv);
    expect(p.systemPrompt).toContain("终端外侧的噪声");
    expect(p.userPayload).toContain("digest text");
    // ADR 0021: the occasion joins the JSON contract with the EN inline
    // example; reject-#4 lists title (tag) only + the retelling carve-out.
    expect(p.systemPrompt).toContain(
      '{"worthy": boolean, "reason": "string", "occasion": "string", "retellsKnownEvent": boolean, "mixedTopics": boolean}',
    );
    expect(p.systemPrompt).toContain("NOT the literary angle");
    expect(p.systemPrompt).toContain(
      "force-pushed over the main branch and stayed up all night restoring the commits from the reflog",
    );
    expect(p.systemPrompt).toContain('- "终端外侧的噪声" (dry-banter)');
    expect(p.systemPrompt).not.toContain(
      "阮·梅发来一段无法验证来源的输入，让我判断真伪",
    );
    expect(p.systemPrompt).toContain("RETELLS an event already captured");
  });

  it("EN generation prompt teaches the CN 废案 grammar with English instructions", () => {
    const p = buildGenerationPrompt(
      "digest text",
      exemplars,
      summaries,
      sampleGuide,
      sampleEnv,
      "en",
    );
    expect(p.systemPrompt).toContain("voice invariants");
    expect(p.systemPrompt).toContain("Astral Express");
    // the format template keeps the CN structural grammar verbatim
    expect(p.systemPrompt).toContain("### 废案_NN：<title>");
    expect(p.systemPrompt).toContain("（开拓者 说）");
    expect(p.systemPrompt).toContain("（/我 说）");
    expect(p.systemPrompt).toContain("（我 想）");
    // evidence-grounding + self-correction digest markers stay CN, and the
    // outcome tags are explained (dream review 2026-09-22, finding 17)
    expect(p.systemPrompt).toContain("〔差分协处理器（…）：…〕");
    expect(p.systemPrompt).toContain(
      "（中断） a run stopped before it finished",
    );
    expect(p.systemPrompt).toContain("〔黑塔的自我更正：…〕");
    // guide/env/exemplars/novelty steer still injected
    expect(p.systemPrompt).toContain(sampleGuide);
    expect(p.systemPrompt).toContain(sampleEnv);
    expect(p.systemPrompt).toContain("终端外侧的噪声");
    // EN Herta register calibration: no CN-style dash drawls
    expect(p.systemPrompt).toContain("does NOT drawl");
    expect(p.userPayload).toContain("digest text");
  });

  it("explains the outcome tags in both languages: a run tagged anything but 已核实 did not complete (dream review 2026-09-22, finding 17)", () => {
    const zh = buildGenerationPrompt(
      "d",
      exemplars,
      summaries,
      sampleGuide,
      "",
    );
    expect(zh.systemPrompt).toContain("（中断）是没跑完就停下的运行");
    expect(zh.systemPrompt).toContain("绝不写成已完成或已通过");
    expect(zh.systemPrompt).toContain("〔系统（…）：…〕");
    const critique = buildCritiquePrompt("draft", sampleGuide, "zh", "digest");
    expect(critique.systemPrompt).toContain(
      "标着（失败）/（中断）/（受阻）/（部分完成）的运行写成已完成或已通过",
    );
  });

  it("an excerpt that mixes topics: worthiness flags it, and generation and critique focus on the one it named (dream review 2026-09-22, finding 22)", () => {
    for (const lang of ["zh", "en"] as const) {
      const w = buildWorthinessPrompt("d", summaries, "", lang);
      expect(w.systemPrompt).toContain('"mixedTopics": boolean');
      const focus = "开拓者复盘了一次数据库迁移失败。";
      const gen = buildGenerationPrompt(
        "d",
        exemplars,
        summaries,
        sampleGuide,
        "",
        lang,
        focus,
      );
      expect(gen.systemPrompt).toContain(focus);
      const crit = buildCritiquePrompt("draft", sampleGuide, lang, "d", focus);
      expect(crit.systemPrompt).toContain(focus);
      // Without a focus nothing changes.
      expect(
        buildGenerationPrompt("d", exemplars, summaries, sampleGuide, "", lang)
          .systemPrompt,
      ).not.toContain(lang === "zh" ? "取材范围" : "Scope of this 废案");
    }
  });

  it("EN critique/refine/redistill/pairwise carry the EN scene anchor with CN tokens", () => {
    for (const p of [
      buildCritiquePrompt("draft", sampleGuide, "en"),
      buildRefinePrompt("draft", ["e"], sampleGuide, "en"),
      buildRedistillPrompt("old", "donor", sampleGuide, "en"),
      buildPairwiseVoiceJudge("A", "B", sampleGuide, "en"),
    ]) {
      expect(p.systemPrompt).toContain("Scene background");
      expect(p.systemPrompt).toContain("@板砖");
      expect(p.systemPrompt).toContain("差分协处理器");
      expect(p.systemPrompt).toContain(sampleGuide);
    }
  });

  it("EN critique targets the CN fences and keeps the voice-score cap", () => {
    const p = buildCritiquePrompt("draft 废案 text", sampleGuide, "en");
    expect(p.systemPrompt).toContain("（我 说）");
    expect(p.systemPrompt).toContain("（我 想）");
    expect(p.systemPrompt).toContain("cap the voice score at 0.7");
    expect(p.systemPrompt).toContain(
      "do NOT suggest stuffing trademark catchphrases",
    );
    expect(p.userPayload).toContain("draft 废案 text");
  });

  it("EN critique carries the charge contract with the same calibration ladder (ADR 0023)", () => {
    const p = buildCritiquePrompt("draft", sampleGuide, "en");
    expect(p.systemPrompt).toContain(
      '{"voice": 0.0, "format": 0.0, "novelty": 0.0, "charge": 0.0, "fixes": ["problem description"]}',
    );
    expect(p.systemPrompt).toContain("Emotional-charge rubric");
    expect(p.systemPrompt).toContain("routine banter or task talk");
    expect(p.systemPrompt).toContain("a sharp confrontation, a rare admission");
    expect(p.systemPrompt).toContain(
      "a revelation that changes how she sees the person",
    );
    // judged on the event, not the prose — with the inline example
    expect(p.systemPrompt).toContain("not the quality of the prose");
    expect(p.systemPrompt).toContain("routinely reporting a failed build");
  });

  it("EN refine threads validator errors under an English list label and keeps the verbatim rule", () => {
    const p = buildRefinePrompt(
      "draft",
      ["missing `---` separator"],
      sampleGuide,
      "en",
    );
    expect(p.userPayload).toContain("Fixes required:");
    expect(p.userPayload).toContain("missing `---` separator");
    expect(p.systemPrompt).toContain(
      "Every sentence not named in the list stays verbatim",
    );
    expect(p.systemPrompt).toContain("targeted tests pass");
  });

  it("EN reactivation gate keys on matchedId and pins the ADR 0021 match semantics", () => {
    const p = buildReactivationGatePrompt(
      { digest: "new digest", occasion: "the same accident, retold" },
      occasionLines,
      "en",
    );
    expect(p.systemPrompt).toContain("matchedId");
    expect(p.systemPrompt).not.toContain("matchedTitle");
    expect(p.systemPrompt).toContain("never a title");
    // the ADR's verbatim semantics
    expect(p.systemPrompt).toContain(
      "Same occasion = the same real-life event re-told",
    );
    expect(p.systemPrompt).toContain(
      "The same LESSON arising from DIFFERENT events is NOT a match",
    );
    expect(p.systemPrompt).toContain("episodic richness is deliberate");
    expect(p.systemPrompt).toContain("Default to sameOccasion: false");
    expect(p.userPayload).toContain("r0:aaaa1111");
    expect(p.userPayload).toContain("the same accident, retold");
  });

  it("EN merge preservation judge stays content-only with the conservative default", () => {
    const p = buildMergePreservationJudge("old text", "facet", "merged", "en");
    expect(p.systemPrompt).toContain("preservesOld");
    expect(p.systemPrompt).toContain("containsFacet");
    expect(p.systemPrompt).toContain("do NOT judge voice quality");
    expect(p.systemPrompt).toContain("reply false");
    expect(p.userPayload).toContain("old text");
    expect(p.userPayload).toContain("merged");
  });

  it("EN reconsolidation judge stays default-NO", () => {
    const p = buildReconsolidationJudge("OLD 全文", "new digest", "en");
    expect(p.systemPrompt).toContain("Default to false");
    expect(p.systemPrompt).toContain("addsUnderstanding");
    expect(p.userPayload).toContain("OLD 全文");
  });

  it("EN re-distill freezes facts and keeps the donor fallback discipline", () => {
    const p = buildRedistillPrompt("OLD 全文", "", sampleGuide, "en");
    expect(p.systemPrompt).toContain("Never drift facts");
    expect(p.systemPrompt).toContain("A matured judgment");
    expect(p.systemPrompt).toContain("A new development of the same occasion");
    expect(p.systemPrompt).toContain("The acceptance contract");
    expect(p.systemPrompt).toContain("The original 废案 is canonical");
    expect(p.systemPrompt).toContain("do not invent new psychological layers");
    expect(p.userPayload).toContain("OLD 全文");
  });

  it("re-distill retry feedback renders the problems as a must-fix section (zh + en)", () => {
    const zh = buildRedistillPrompt("OLD", "facet", sampleGuide, "zh", [
      "合并稿丢掉了尾声的优先级判断",
    ]);
    expect(zh.systemPrompt).toContain("上一稿的问题");
    expect(zh.systemPrompt).toContain("合并稿丢掉了尾声的优先级判断");
    const en = buildRedistillPrompt("OLD", "facet", sampleGuide, "en", [
      "merged lost the epilogue judgment",
    ]);
    expect(en.systemPrompt).toContain("Problems in the previous attempt");
    expect(en.systemPrompt).toContain("merged lost the epilogue judgment");
  });

  it("EN pairwise judge keeps the no-length-reward rule", () => {
    const p = buildPairwiseVoiceJudge("A 全文", "B 全文", sampleGuide, "en");
    expect(p.systemPrompt).toContain("clearer does not mean longer");
    expect(p.systemPrompt).toContain("winner");
  });

  it("semanticize/notes-audit: omitting lang is byte-identical to zh; EN keeps the CN forbidden tokens", () => {
    const semArgs = {
      currentNotes: "现有认识若干。",
      dying: [{ file: "### 废案_07：t.txt", body: "正文" }],
      guide: sampleGuide,
      maxChars: 600,
    };
    expect(buildSemanticizePrompt(semArgs)).toEqual(
      buildSemanticizePrompt({ ...semArgs, lang: "zh" }),
    );
    const semEn = buildSemanticizePrompt({ ...semArgs, lang: "en" });
    expect(semEn.systemPrompt).toContain("Whole-page replacement");
    expect(semEn.systemPrompt).toContain("Hard length cap: 600 characters");
    // the forbidden-token list still names the CN grammar verbatim
    expect(semEn.systemPrompt).toContain("（我 说）");
    expect(semEn.systemPrompt).toContain("→ 系统 / → 差分协处理器");
    expect(semEn.userPayload).toContain("### 废案_07：t.txt");

    const auditArgs = {
      currentNotes: "现有认识若干。",
      living: [{ file: "### 废案_08：t.txt", body: "正文" }],
      guide: sampleGuide,
      maxChars: 600,
    };
    expect(buildNotesAuditPrompt(auditArgs)).toEqual(
      buildNotesAuditPrompt({ ...auditArgs, lang: "zh" }),
    );
    const auditEn = buildNotesAuditPrompt({ ...auditArgs, lang: "en" });
    expect(auditEn.systemPrompt).toContain("Default consistent");
    expect(auditEn.systemPrompt).toContain("No opportunistic polishing");
    expect(auditEn.systemPrompt).toContain("（X 说）/（X 想）");
    expect(auditEn.userPayload).toContain("### 废案_08：t.txt");
  });

  it("semanticize renders dying AND stabilized lists under DISTINCT headings (ADR 0023)", () => {
    const both = buildSemanticizePrompt({
      currentNotes: "现有认识若干。",
      dying: [{ file: "### 废案_07：将逝.txt", body: "将逝的正文" }],
      stabilized: [{ file: "### 废案_08：稳固.txt", body: "稳固的正文" }],
      guide: sampleGuide,
      maxChars: 600,
    });
    // Both headings, each with its own framing.
    expect(both.systemPrompt).toContain("## 即将被遗忘的记忆");
    expect(both.systemPrompt).toContain("## 已趋稳固的记忆");
    expect(both.systemPrompt).toContain("它们已被反复印证、趋于稳固");
    // Both lists reach the payload under distinct keys.
    expect(both.userPayload).toContain("即将被遗忘的废案");
    expect(both.userPayload).toContain("### 废案_07：将逝.txt");
    expect(both.userPayload).toContain("已趋稳固的废案");
    expect(both.userPayload).toContain("### 废案_08：稳固.txt");

    // Dying-only (the pre-ADR-0023 shape): no stabilized heading, no
    // stabilized payload key — and omitting `stabilized` equals passing [].
    const dyingOnly = buildSemanticizePrompt({
      currentNotes: "现有认识若干。",
      dying: [{ file: "### 废案_07：将逝.txt", body: "将逝的正文" }],
      guide: sampleGuide,
      maxChars: 600,
    });
    expect(dyingOnly.systemPrompt).not.toContain("已趋稳固的记忆");
    expect(dyingOnly.userPayload).not.toContain("已趋稳固的废案");
    expect(
      buildSemanticizePrompt({
        currentNotes: "现有认识若干。",
        dying: [{ file: "### 废案_07：将逝.txt", body: "将逝的正文" }],
        stabilized: [],
        guide: sampleGuide,
        maxChars: 600,
      }),
    ).toEqual(dyingOnly);

    // Stabilized-only: no dying heading.
    const stabilizedOnly = buildSemanticizePrompt({
      currentNotes: "现有认识若干。",
      dying: [],
      stabilized: [{ file: "### 废案_08：稳固.txt", body: "稳固的正文" }],
      guide: sampleGuide,
      maxChars: 600,
    });
    expect(stabilizedOnly.systemPrompt).not.toContain("即将被遗忘的记忆");
    expect(stabilizedOnly.systemPrompt).toContain("## 已趋稳固的记忆");

    // EN variant carries both headings too.
    const en = buildSemanticizePrompt({
      currentNotes: "some notes",
      dying: [{ file: "### 废案_07：将逝.txt", body: "dying text" }],
      stabilized: [{ file: "### 废案_08：稳固.txt", body: "stable text" }],
      guide: sampleGuide,
      maxChars: 600,
      lang: "en",
    });
    expect(en.systemPrompt).toContain("## Memories about to be forgotten");
    expect(en.systemPrompt).toContain("## Memories that have stabilized");
    expect(en.systemPrompt).toContain("have NOT faded");
    expect(en.userPayload).toContain("stabilized_feian");
  });

  it("notes-refine: omitting lang is byte-identical to zh; both variants scope to the listed errors", () => {
    const refineArgs = {
      failedBody: "被拒绝的一页正文。",
      errors: ["too long (>600 chars)", "leaked English structural marker"],
      maxChars: 600,
    };
    expect(buildNotesRefinePrompt(refineArgs)).toEqual(
      buildNotesRefinePrompt({ ...refineArgs, lang: "zh" }),
    );
    const zh = buildNotesRefinePrompt(refineArgs);
    expect(zh.systemPrompt).toContain("只修列出的错误");
    expect(zh.systemPrompt).toContain("长度硬上限 600 字符");
    expect(zh.userPayload).toContain("被拒绝的一页正文。");
    expect(zh.userPayload).toContain("too long (>600 chars)");

    const en = buildNotesRefinePrompt({ ...refineArgs, lang: "en" });
    expect(en.systemPrompt).toContain("Fix only the listed errors");
    expect(en.systemPrompt).toContain("Hard length cap: 600 characters");
    // the forbidden-token examples still name the CN grammar verbatim
    expect(en.systemPrompt).toContain("→ 系统 / → 差分协处理器");
    expect(en.userPayload).toContain("被拒绝的一页正文。");
    expect(en.userPayload).toContain("Validation errors to fix:");
  });
});
