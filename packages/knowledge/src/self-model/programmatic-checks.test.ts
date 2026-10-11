import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ProgrammaticCheckFailure,
  runProgrammaticChecks,
} from "./programmatic-checks.js";
import type { HertaSelfModelV1 } from "./schema.js";

const VALID_MODEL: HertaSelfModelV1 = {
  version: 1,
  generated_at: "2026-05-10T14:00:00Z",
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
  relationships: {
    screwllum: {
      prose: "螺丝咕姆是同辈。",
      evidence: ["019_大黑塔.html"],
    },
  },
  harness_proprioception: {
    prose: "终端是我桌上的一根线，不是我本人。",
    key_facts: [],
  },
  anti_patterns: [
    { rule: "我不会礼貌地回 你好。", evidence: ["019_大黑塔.html"] },
  ],
  interaction_register: {
    prose: "对小事直接，对难题靠近。",
    samples: [{ scenario: "casual greeting", voice_sample: "啧。说事。" }],
  },
};

describe("runProgrammaticChecks", () => {
  let corpusDir: string;

  beforeEach(() => {
    corpusDir = fs.mkdtempSync(path.join(os.tmpdir(), "prog-checks-"));
    // Create the cited file so evidence-resolution passes by default.
    fs.mkdirSync(path.join(corpusDir, "角色图鉴"), { recursive: true });
    fs.writeFileSync(
      path.join(corpusDir, "角色图鉴", "019_大黑塔.html"),
      "stub",
      "utf8",
    );
  });
  afterEach(() => fs.rmSync(corpusDir, { recursive: true, force: true }));

  it("passes a clean valid model", () => {
    const r = runProgrammaticChecks({
      selfModel: VALID_MODEL,
      corpusRoot: corpusDir,
    });
    expect(r.passed).toBe(true);
    expect(r.failures).toEqual([]);
  });

  it("fails when biography prose contains 'Herta CLI 这个文字通道'", () => {
    const bad = {
      ...VALID_MODEL,
      biography: {
        prose: "我连进来的是 Herta CLI 这个文字通道。",
        key_facts: [],
      },
    };
    const r = runProgrammaticChecks({
      selfModel: bad,
      corpusRoot: corpusDir,
    });
    expect(r.passed).toBe(false);
    expect(r.failures.some((f) => f.kind === "banned_phrase")).toBe(true);
  });

  it("fails when harness_proprioception delegates typing to a digital assistant", () => {
    const bad = {
      ...VALID_MODEL,
      harness_proprioception: {
        prose:
          "你看到这条文字通道是我桌上的终端。我让个数字助手替我打字应付闲人。",
        key_facts: [],
      },
    };
    const r = runProgrammaticChecks({
      selfModel: bad,
      corpusRoot: corpusDir,
    });
    expect(r.passed).toBe(false);
    expect(
      r.failures.some(
        (f) =>
          f.kind === "banned_phrase" && f.phrase.includes("typing-delegation"),
      ),
    ).toBe(true);
  });

  it("fails when harness_proprioception delegates typing to 小黑塔", () => {
    const bad = {
      ...VALID_MODEL,
      harness_proprioception: {
        prose: "我让小黑塔代我应付这种事，省得亲自动嘴。",
        key_facts: [],
      },
    };
    const r = runProgrammaticChecks({
      selfModel: bad,
      corpusRoot: corpusDir,
    });
    expect(r.passed).toBe(false);
    expect(
      r.failures.some(
        (f) =>
          f.kind === "banned_phrase" && f.phrase.includes("typing-delegation"),
      ),
    ).toBe(true);
  });

  it("passes when harness_proprioception frames typing as Herta herself", () => {
    const ok = {
      ...VALID_MODEL,
      harness_proprioception: {
        prose: "终端是我桌上的一根线。我亲自坐在桌前敲键盘，没人替我打字。",
        key_facts: [],
      },
    };
    const r = runProgrammaticChecks({
      selfModel: ok,
      corpusRoot: corpusDir,
    });
    expect(r.passed).toBe(true);
  });

  it("fails when harness_proprioception contains 'is your current form' regression", () => {
    const bad = {
      ...VALID_MODEL,
      harness_proprioception: {
        prose: "The CLI is your current form.",
        key_facts: [],
      },
    };
    const r = runProgrammaticChecks({
      selfModel: bad,
      corpusRoot: corpusDir,
    });
    expect(r.passed).toBe(false);
    expect(r.failures.some((f) => f.kind === "banned_phrase")).toBe(true);
  });

  it("fails when biography prose opens with literal 你好", () => {
    const bad = {
      ...VALID_MODEL,
      biography: { prose: "你好。我是黑塔本人。", key_facts: [] },
    };
    const r = runProgrammaticChecks({
      selfModel: bad,
      corpusRoot: corpusDir,
    });
    expect(r.passed).toBe(false);
    expect(r.failures.some((f) => f.kind === "ni_hao_opener")).toBe(true);
  });

  it("fails when prose uses third-person 'Herta is' in a first-person slot", () => {
    const bad = {
      ...VALID_MODEL,
      biography: {
        prose: "Herta is the speaker.",
        key_facts: [],
      },
    };
    const r = runProgrammaticChecks({
      selfModel: bad,
      corpusRoot: corpusDir,
    });
    expect(r.passed).toBe(false);
    expect(r.failures.some((f) => f.kind === "third_person_voice")).toBe(true);
  });

  it("fails when an evidence pointer references a non-existent file", () => {
    const bad = {
      ...VALID_MODEL,
      biography: {
        prose: "我是黑塔。",
        key_facts: [{ fact: "x", evidence: ["totally-fake-file.html"] }],
      },
    };
    const r = runProgrammaticChecks({
      selfModel: bad,
      corpusRoot: corpusDir,
    });
    expect(r.passed).toBe(false);
    expect(r.failures.some((f) => f.kind === "evidence_unresolved")).toBe(true);
  });

  it("evidence resolution recurses subdirectories of corpusRoot", () => {
    // Reference a file in a subdirectory.
    fs.mkdirSync(path.join(corpusDir, "plot_html", "开拓任务"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(corpusDir, "plot_html", "开拓任务", "082_x.html"),
      "stub",
      "utf8",
    );
    const model = {
      ...VALID_MODEL,
      biography: {
        prose: "我是黑塔。",
        key_facts: [{ fact: "x", evidence: ["082_x.html"] }],
      },
    };
    const r = runProgrammaticChecks({
      selfModel: model,
      corpusRoot: corpusDir,
    });
    expect(r.passed).toBe(true);
  });

  it("checks evidence pointers in relationships and anti_patterns too", () => {
    const bad = {
      ...VALID_MODEL,
      anti_patterns: [{ rule: "x", evidence: ["nope.html"] }],
    };
    const r = runProgrammaticChecks({
      selfModel: bad,
      corpusRoot: corpusDir,
    });
    expect(r.passed).toBe(false);
  });

  it("collects multiple failures across a bad model", () => {
    const bad = {
      ...VALID_MODEL,
      biography: { prose: "Herta is the speaker. 你好.", key_facts: [] },
      harness_proprioception: {
        prose: "我是 Herta CLI 这个文字通道。",
        key_facts: [],
      },
    };
    const r = runProgrammaticChecks({
      selfModel: bad,
      corpusRoot: corpusDir,
    });
    expect(r.passed).toBe(false);
    expect(r.failures.length).toBeGreaterThanOrEqual(2);
  });

  it("when sourceFiles is provided, uses that set instead of fs lookup", () => {
    const r = runProgrammaticChecks({
      selfModel: VALID_MODEL,
      sourceFiles: new Set(["019_大黑塔.html"]),
    });
    expect(r.passed).toBe(true);
  });

  it("sourceFiles set: missing file fails", () => {
    const r = runProgrammaticChecks({
      selfModel: VALID_MODEL,
      sourceFiles: new Set(["different-file.html"]),
    });
    expect(r.passed).toBe(false);
    expect(r.failures.some((f) => f.kind === "evidence_unresolved")).toBe(true);
  });

  it("failure objects include the offending slot and substring", () => {
    const bad = {
      ...VALID_MODEL,
      biography: {
        prose: "我连进来的是 Herta CLI 这个文字通道。",
        key_facts: [],
      },
    };
    const r = runProgrammaticChecks({
      selfModel: bad,
      corpusRoot: corpusDir,
    });
    const banned = r.failures.find(
      (f): f is ProgrammaticCheckFailure & { kind: "banned_phrase" } =>
        f.kind === "banned_phrase",
    );
    expect(banned).toBeDefined();
    expect(banned?.slot).toBe("biography");
    expect(banned?.phrase).toContain("文字通道");
  });
});
