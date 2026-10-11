import { describe, expect, it } from "vitest";
import {
  buildTriggerRecheckSystemPrompt,
  TRIGGER_RECHECK_SYSTEM_PROMPT,
} from "./trigger-recheck-system-prompt.js";

describe("buildTriggerRecheckSystemPrompt (EN interaction slice 3b)", () => {
  it('defaults to "zh" and returns the exact back-compat const', () => {
    expect(buildTriggerRecheckSystemPrompt()).toBe(
      TRIGGER_RECHECK_SYSTEM_PROMPT,
    );
    expect(buildTriggerRecheckSystemPrompt("zh")).toBe(
      TRIGGER_RECHECK_SYSTEM_PROMPT,
    );
  });

  it("zh variant is unchanged (spot-check pre-slice-3b phrases)", () => {
    const zh = buildTriggerRecheckSystemPrompt("zh");
    expect(zh.startsWith('你是一个"@板砖 调度复核员"。')).toBe(true);
    expect(zh).toContain("拿不准时偏向 OK");
    expect(zh).toContain("# 两步判断");
  });

  it('lang:"en" produces English instructional prose', () => {
    const en = buildTriggerRecheckSystemPrompt("en");
    expect(en).toContain("dispatch recheck officer");
    expect(en).toContain("Two-step judgment");
    expect(en).toContain("When unsure, lean OK");
    // Genuinely a different variant, not the zh text.
    expect(en).not.toBe(TRIGGER_RECHECK_SYSTEM_PROMPT);
  });

  it("en variant keeps the structural CN machine-contract tokens verbatim", () => {
    const en = buildTriggerRecheckSystemPrompt("en");
    // The dispatch trigger token and its inert form.
    expect(en).toContain("@板砖");
    expect(en).toContain('"板砖"');
    // The shared verdict grammar parsed by parseSupervisorVerdict,
    // with CN category tokens (范围 is matched by
    // isTriggerRelatedFinding; off-vocabulary categories are not).
    expect(en).toContain("OK");
    expect(en).toContain("BLOCK：触发：");
    expect(en).toContain("BLOCK：范围：");
    // The three user-message headers emitted (in CN) by
    // buildTriggerRecheckUserMessage.
    expect(en).toContain("### 最近的对话");
    expect(en).toContain("### 我刚才内心想的");
    expect(en).toContain("### 我刚才要说出口的话");
    // Narrative fences + the literal no-thought marker.
    expect(en).toContain("（开拓者 说）…（/开拓者 说）");
    expect(en).toContain("（我 说）…（/我 说）");
    expect(en).toContain("（这一回没想过，直接想说）");
  });

  it("en BLOCK reason examples name @板砖 (keeps isTriggerRelatedFinding matchable)", () => {
    const en = buildTriggerRecheckSystemPrompt("en");
    // Every example BLOCK line's first-person detail must mention the
    // token so a model imitating the examples produces findings that
    // isTriggerRelatedFinding recognizes.
    const blockLines = en
      .split("\n")
      .filter((l) => l.includes("BLOCK：") && !l.includes("<category>"));
    expect(blockLines.length).toBeGreaterThan(0);
    for (const line of blockLines) {
      expect(line).toContain("@板砖");
    }
  });
});
