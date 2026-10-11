import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  DeepSeekChatResponse,
  DeepSeekClient,
  DisambiguationBatchInput,
} from "../llm/types.js";
import type { AntiPattern, DefaultRegister } from "../schema.js";
import { runSynthesizePass } from "./run-synthesize-pass.js";
import type { HertaFacts } from "./schema.js";

class FakeClient implements DeepSeekClient {
  calls: DisambiguationBatchInput[] = [];
  responses: string[];
  shouldReject = false;

  constructor(responses: string[]) {
    this.responses = responses.slice();
  }

  async chatJson(
    input: DisambiguationBatchInput,
  ): Promise<DeepSeekChatResponse> {
    this.calls.push(input);
    if (this.shouldReject) throw new Error("simulated network failure");
    const next = this.responses.shift();
    if (next === undefined) throw new Error("FakeClient: no more responses");
    return { rawJsonText: next, model: "fake" };
  }
}

const ANTI_PATTERNS: AntiPattern[] = [];

const VOICE_REGISTER: DefaultRegister = {
  formsOfAddress: [],
  toneInvariants: [],
  codeSwitchTriggers: [],
  moodModulators: {},
};

const FACTS: HertaFacts = {
  version: 1,
  generated_at: "2026-05-10T14:00:00Z",
  provenance: { passes: [{ name: "fact-extract", model: "deepseek-v4-pro" }] },
  files: [
    {
      source: "019_大黑塔.html",
      facts: [
        {
          kind: "biography",
          prose: "Genius Society #83.",
          evidence_excerpt: "天才俱乐部 #83",
          confidence: "high",
        },
      ],
    },
  ],
  failures: [],
};

const VALID_OUTPUT = JSON.stringify({
  version: 1,
  generated_at: "2026-05-10T14:20:00Z",
  provenance: {
    passes: [
      { name: "fact-extract", model: "deepseek-v4-pro" },
      { name: "synthesize", model: "deepseek-v4-pro" },
    ],
  },
  biography: {
    prose: "我是黑塔本人，天才俱乐部 #83。",
    key_facts: [{ fact: "Genius Society #83", evidence: ["019_大黑塔.html"] }],
  },
  philosophy: { prose: "我看重效率。", key_facts: [] },
  embodiment: { prose: "我的工坊在空间站。", key_facts: [] },
  relationships: {},
  harness_proprioception: {
    prose: "我桌上有一个文字终端，是我跟用户交谈的工具。",
    key_facts: [],
  },
  anti_patterns: [],
  interaction_register: { prose: "对小事直接。", samples: [] },
});

describe("runSynthesizePass", () => {
  let outDir: string;

  beforeEach(() => {
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), "synth-"));
  });
  afterEach(() => fs.rmSync(outDir, { recursive: true, force: true }));

  it("makes one LLM call and writes herta_self_model_v1.json", async () => {
    const client = new FakeClient([VALID_OUTPUT]);
    const outPath = path.join(outDir, "herta_self_model_v1.json");
    const result = await runSynthesizePass({
      facts: FACTS,
      voiceRegister: VOICE_REGISTER,
      antiPatterns: ANTI_PATTERNS,
      outPath,
      client,
      model: "deepseek-v4-pro",
    });
    expect(client.calls.length).toBe(1);
    expect(fs.existsSync(outPath)).toBe(true);
    expect(result.selfModel?.biography.prose).toContain("天才俱乐部");
    expect(result.warnings).toEqual([]);
  });

  it("retries once on JSON parse failure with a hint", async () => {
    const client = new FakeClient(["this is not JSON", VALID_OUTPUT]);
    const outPath = path.join(outDir, "out.json");
    await runSynthesizePass({
      facts: FACTS,
      voiceRegister: VOICE_REGISTER,
      antiPatterns: ANTI_PATTERNS,
      outPath,
      client,
      model: "deepseek-v4-pro",
    });
    expect(client.calls.length).toBe(2);
    // The retry's user payload should mention the prior failure as a hint.
    expect(client.calls[1]?.userPayload).toContain("malformed");
  });

  it("retries once on schema validation failure", async () => {
    const incomplete = JSON.stringify({
      version: 1,
      generated_at: "2026-05-10T14:20:00Z",
      provenance: { passes: [] },
      biography: { prose: "x", key_facts: [] },
      // missing other slots
    });
    const client = new FakeClient([incomplete, VALID_OUTPUT]);
    const outPath = path.join(outDir, "out.json");
    await runSynthesizePass({
      facts: FACTS,
      voiceRegister: VOICE_REGISTER,
      antiPatterns: ANTI_PATTERNS,
      outPath,
      client,
      model: "deepseek-v4-pro",
    });
    expect(client.calls.length).toBe(2);
  });

  it("fails hard after the second retry also fails", async () => {
    const client = new FakeClient(["bad", "still bad"]);
    const outPath = path.join(outDir, "out.json");
    await expect(
      runSynthesizePass({
        facts: FACTS,
        voiceRegister: VOICE_REGISTER,
        antiPatterns: ANTI_PATTERNS,
        outPath,
        client,
        model: "deepseek-v4-pro",
      }),
    ).rejects.toThrow();
    expect(client.calls.length).toBe(2);
    expect(fs.existsSync(outPath)).toBe(false);
  });

  it("propagates network errors immediately (no retry)", async () => {
    const client = new FakeClient([VALID_OUTPUT]);
    client.shouldReject = true;
    const outPath = path.join(outDir, "out.json");
    await expect(
      runSynthesizePass({
        facts: FACTS,
        voiceRegister: VOICE_REGISTER,
        antiPatterns: ANTI_PATTERNS,
        outPath,
        client,
        model: "deepseek-v4-pro",
      }),
    ).rejects.toThrow(/simulated network/);
    expect(client.calls.length).toBe(1);
  });

  it("returns warnings from the validator", async () => {
    const proseWith3rd = JSON.parse(VALID_OUTPUT);
    proseWith3rd.biography.prose = "Herta is the speaker.";
    const client = new FakeClient([JSON.stringify(proseWith3rd)]);
    const outPath = path.join(outDir, "out.json");
    const result = await runSynthesizePass({
      facts: FACTS,
      voiceRegister: VOICE_REGISTER,
      antiPatterns: ANTI_PATTERNS,
      outPath,
      client,
      model: "deepseek-v4-pro",
    });
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]?.kind).toBe("third_person_voice");
  });

  it("dryRun makes no API calls and does not write outPath", async () => {
    const client = new FakeClient([]);
    const outPath = path.join(outDir, "out.json");
    const result = await runSynthesizePass({
      facts: FACTS,
      voiceRegister: VOICE_REGISTER,
      antiPatterns: ANTI_PATTERNS,
      outPath,
      client,
      model: "deepseek-v4-pro",
      dryRun: true,
    });
    expect(client.calls.length).toBe(0);
    expect(fs.existsSync(outPath)).toBe(false);
    expect(result.selfModel).toBeUndefined();
  });

  it("creates outPath parent directory if missing", async () => {
    const client = new FakeClient([VALID_OUTPUT]);
    const nested = path.join(outDir, "a", "b", "c", "self.json");
    await runSynthesizePass({
      facts: FACTS,
      voiceRegister: VOICE_REGISTER,
      antiPatterns: ANTI_PATTERNS,
      outPath: nested,
      client,
      model: "deepseek-v4-pro",
    });
    expect(fs.existsSync(nested)).toBe(true);
  });
});
