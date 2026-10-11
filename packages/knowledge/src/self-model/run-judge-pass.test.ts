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
import { runJudgePass } from "./run-judge-pass.js";
import type { HertaSelfModelV1 } from "./schema.js";

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
    if (next === undefined) throw new Error("FakeClient: no scripted response");
    return { rawJsonText: next, model: "fake" };
  }
}

const SELF_MODEL: HertaSelfModelV1 = {
  version: 1,
  generated_at: "2026-05-10T14:00:00Z",
  provenance: {
    passes: [
      { name: "fact-extract", model: "deepseek-v4-pro" },
      { name: "synthesize", model: "deepseek-v4-pro" },
    ],
  },
  biography: { prose: "我是黑塔。", key_facts: [] },
  philosophy: { prose: "我看重效率。", key_facts: [] },
  embodiment: { prose: "工坊在空间站。", key_facts: [] },
  relationships: {},
  harness_proprioception: {
    prose: "终端是桌上的工具。",
    key_facts: [],
  },
  anti_patterns: [],
  interaction_register: { prose: "直接。", samples: [] },
};

const VOICE: DefaultRegister = {
  formsOfAddress: [],
  toneInvariants: [],
  codeSwitchTriggers: [],
  moodModulators: {},
};

const ANTI_PATTERNS: AntiPattern[] = [];

function validJudgeOutput(): string {
  const slot = (_name: string) => ({
    in_voice: 4,
    canon_grounded: 5,
    coherent: 5,
    no_leakage: 5,
    concerns: [],
  });
  return JSON.stringify({
    version: 1,
    judged_at: "2026-05-10T15:00:00Z",
    model: "deepseek-v4-pro",
    scores: {
      biography: slot("biography"),
      philosophy: slot("philosophy"),
      embodiment: slot("embodiment"),
      relationships: slot("relationships"),
      harness_proprioception: slot("harness_proprioception"),
      anti_patterns: slot("anti_patterns"),
      interaction_register: slot("interaction_register"),
    },
  });
}

describe("runJudgePass", () => {
  let outDir: string;

  beforeEach(() => {
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), "judge-"));
  });
  afterEach(() => fs.rmSync(outDir, { recursive: true, force: true }));

  it("makes one LLM call and writes judge_report.json", async () => {
    const client = new FakeClient([validJudgeOutput()]);
    const outPath = path.join(outDir, "judge_report.json");
    const result = await runJudgePass({
      selfModel: SELF_MODEL,
      voiceRegister: VOICE,
      antiPatterns: ANTI_PATTERNS,
      outPath,
      client,
      model: "deepseek-v4-pro",
    });
    expect(client.calls.length).toBe(1);
    expect(fs.existsSync(outPath)).toBe(true);
    expect(result.report?.scores.biography?.in_voice).toBe(4);
  });

  it("returns aggregate min and avg scores", async () => {
    const out = JSON.parse(validJudgeOutput());
    out.scores.biography.in_voice = 2;
    out.scores.biography.no_leakage = 3;
    const client = new FakeClient([JSON.stringify(out)]);
    const result = await runJudgePass({
      selfModel: SELF_MODEL,
      voiceRegister: VOICE,
      antiPatterns: ANTI_PATTERNS,
      outPath: path.join(outDir, "out.json"),
      client,
      model: "deepseek-v4-pro",
    });
    expect(result.minScore).toBe(2);
    expect(result.avgScore).toBeGreaterThan(2);
    expect(result.avgScore).toBeLessThan(5);
  });

  it("retries once on JSON parse failure", async () => {
    const client = new FakeClient(["not json", validJudgeOutput()]);
    await runJudgePass({
      selfModel: SELF_MODEL,
      voiceRegister: VOICE,
      antiPatterns: ANTI_PATTERNS,
      outPath: path.join(outDir, "out.json"),
      client,
      model: "deepseek-v4-pro",
    });
    expect(client.calls.length).toBe(2);
    expect(client.calls[1]?.userPayload).toContain("malformed");
  });

  it("retries once on schema validation failure", async () => {
    const incomplete = JSON.stringify({
      version: 1,
      judged_at: "2026-05-10T15:00:00Z",
      model: "deepseek-v4-pro",
      scores: {
        biography: {
          in_voice: 4,
          canon_grounded: 5,
          coherent: 5,
          no_leakage: 6, // out of range
          concerns: [],
        },
      },
    });
    const client = new FakeClient([incomplete, validJudgeOutput()]);
    await runJudgePass({
      selfModel: SELF_MODEL,
      voiceRegister: VOICE,
      antiPatterns: ANTI_PATTERNS,
      outPath: path.join(outDir, "out.json"),
      client,
      model: "deepseek-v4-pro",
    });
    expect(client.calls.length).toBe(2);
  });

  it("fails hard after retry also fails", async () => {
    const client = new FakeClient(["nope", "still nope"]);
    await expect(
      runJudgePass({
        selfModel: SELF_MODEL,
        voiceRegister: VOICE,
        antiPatterns: ANTI_PATTERNS,
        outPath: path.join(outDir, "out.json"),
        client,
        model: "deepseek-v4-pro",
      }),
    ).rejects.toThrow();
  });

  it("propagates network errors immediately (no retry)", async () => {
    const client = new FakeClient([validJudgeOutput()]);
    client.shouldReject = true;
    await expect(
      runJudgePass({
        selfModel: SELF_MODEL,
        voiceRegister: VOICE,
        antiPatterns: ANTI_PATTERNS,
        outPath: path.join(outDir, "out.json"),
        client,
        model: "deepseek-v4-pro",
      }),
    ).rejects.toThrow(/simulated network/);
    expect(client.calls.length).toBe(1);
  });

  it("strips a markdown fence from the response", async () => {
    const wrapped = `\`\`\`json\n${validJudgeOutput()}\n\`\`\``;
    const client = new FakeClient([wrapped]);
    const result = await runJudgePass({
      selfModel: SELF_MODEL,
      voiceRegister: VOICE,
      antiPatterns: ANTI_PATTERNS,
      outPath: path.join(outDir, "out.json"),
      client,
      model: "deepseek-v4-pro",
    });
    expect(result.report?.version).toBe(1);
  });

  it("dryRun makes no API call and does not write outPath", async () => {
    const client = new FakeClient([]);
    const outPath = path.join(outDir, "out.json");
    const result = await runJudgePass({
      selfModel: SELF_MODEL,
      voiceRegister: VOICE,
      antiPatterns: ANTI_PATTERNS,
      outPath,
      client,
      model: "deepseek-v4-pro",
      dryRun: true,
    });
    expect(client.calls.length).toBe(0);
    expect(fs.existsSync(outPath)).toBe(false);
    expect(result.report).toBeUndefined();
  });

  it("creates outPath parent directory if missing", async () => {
    const client = new FakeClient([validJudgeOutput()]);
    const nested = path.join(outDir, "a", "b", "judge.json");
    await runJudgePass({
      selfModel: SELF_MODEL,
      voiceRegister: VOICE,
      antiPatterns: ANTI_PATTERNS,
      outPath: nested,
      client,
      model: "deepseek-v4-pro",
    });
    expect(fs.existsSync(nested)).toBe(true);
  });
});
