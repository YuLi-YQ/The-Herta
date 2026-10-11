import type { SystemBlock, TerminalRecordBlock } from "@herta/core";
import { describe, expect, it } from "vitest";
import {
  buildEpisodeDigest,
  DIGEST_EVIDENCE_BUDGET,
  DIGEST_MAX_SYSTEM_ROWS,
  dreamRelevantSystemBody,
} from "./digest.js";

const blocks: TerminalRecordBlock[] = [
  { kind: "user", text: "加个 --verbose" },
  { kind: "herta", surface: "thought", text: "又是 flag。" },
  { kind: "herta", surface: "speech", text: "@板砖 去加。" },
  {
    kind: "system",
    label: "差分协处理器",
    body: "完成 · 1 file",
    evidenceDetail: "↳ targeted test pass",
    role: "done-marker",
  },
  { kind: "herta", surface: "speech", text: "加好了，只跑了定向测试。" },
];

describe("buildEpisodeDigest — attachments (ADR 0033)", () => {
  // The ADR claims dreams need no new rule for attachments, because the
  // citation rides `body` and the document's text rides `evidenceDetail`,
  // which no dream ever reads. That is a claim about behaviour, so it is
  // pinned here rather than asserted in prose: she should be able to dream
  // that the 开拓者 handed her a spec, and never dream its contents.
  const withAttachment: TerminalRecordBlock[] = [
    { kind: "user", text: "看看这个" },
    {
      kind: "system",
      label: "系统",
      body: "附件 spec.md · 120 行 · 4.8K 字 · .herta/attachments/s1/spec.md",
      evidenceDetail: "↳ 附件 spec.md\nCONFIDENTIAL ROADMAP Q4 REVENUE TARGET",
      digest: {
        kind: "attachment",
        name: "spec.md",
        path: ".herta/attachments/s1/spec.md",
        lines: 120,
        chars: 4800,
      },
    },
    { kind: "herta", surface: "speech", text: "看完了。" },
  ];

  it("keeps the citation and never the document body", () => {
    const d = buildEpisodeDigest(withAttachment);
    expect(d).toContain("附件 spec.md");
    expect(d).not.toContain("CONFIDENTIAL");
    expect(d).not.toContain("REVENUE");
  });

  // ADR 0069 §5 (dream review 2026-09-22, finding 9): the same text came back
  // through 板砖's read lanes — the fold's own hint sends Herta to re-read the
  // document — and those rows kept their detail. Keyed on provenance now.
  const reread: TerminalRecordBlock[] = [
    { kind: "user", text: "再看看那份 spec 第三节" },
    { kind: "herta", surface: "speech", text: "@板砖 翻一下第三节。" },
    {
      kind: "system",
      label: "差分协处理器",
      body: "↳ excerpt .herta/attachments/s1/spec.md:40-60",
      digest: {
        kind: "excerpt",
        path: ".herta/attachments/s1/spec.md",
        from: 40,
        to: 60,
      },
      evidenceDetail:
        "↳ 摘录 .herta/attachments/s1/spec.md:40-60\nCONFIDENTIAL ROADMAP",
    },
    {
      kind: "system",
      label: "差分协处理器",
      body: "↳ 3 matches in 2 files",
      digest: {
        kind: "search",
        pattern: "TARGET",
        matches: 3,
        files: 2,
        truncated: false,
      },
      evidenceDetail: [
        "↳ 匹配 /TARGET/:",
        ".herta/attachments/s1/spec.md:12: Q4 REVENUE TARGET",
        "E:\\ws\\.herta\\attachments\\s1\\spec.md:13: REVENUE TARGET 2",
        "src/config.ts:4: const TARGET_FPS = 60;",
      ].join("\n"),
    },
    {
      kind: "system",
      label: "差分协处理器",
      body: "Running cat .herta/attachments/s1/spec.md",
      digest: {
        kind: "op",
        verb: "Running",
        arg: "cat .herta/attachments/s1/spec.md",
      },
    },
    {
      kind: "system",
      label: "差分协处理器",
      body: "↳ exit 0 · 120 lines",
      digest: { kind: "text", text: "↳ exit 0 · 120 lines" },
      evidenceDetail: "↳ 输出:\nCONFIDENTIAL APPENDIX",
    },
    {
      kind: "system",
      label: "差分协处理器",
      body: "Running npm test",
      digest: { kind: "op", verb: "Running", arg: "npm test" },
    },
    {
      kind: "system",
      label: "差分协处理器",
      body: "↳ exit 1 · 2 lines",
      digest: { kind: "text", text: "↳ exit 1 · 2 lines" },
      evidenceDetail: "↳ 输出:\nFAIL src/config.test.ts",
    },
    { kind: "herta", surface: "speech", text: "第三节说的是路线图。" },
  ];

  it("drops what 板砖 re-read from the attachment store and keeps what it read from the repo", () => {
    const d = buildEpisodeDigest(reread);
    for (const secret of ["CONFIDENTIAL", "REVENUE", "APPENDIX"]) {
      expect(d).not.toContain(secret);
    }
    // The citations stay: she remembers going back to the document.
    expect(d).toContain("↳ excerpt .herta/attachments/s1/spec.md:40-60");
    expect(d).toContain("Running cat .herta/attachments/s1/spec.md");
    // Repo evidence in the same episode is untouched.
    expect(d).toContain("src/config.ts:4: const TARGET_FPS = 60;");
    expect(d).toContain("FAIL src/config.test.ts");
  });
});

describe("buildEpisodeDigest", () => {
  it("includes user + herta lines and the verified outcome evidence", () => {
    const d = buildEpisodeDigest(blocks);
    expect(d).toContain("加个 --verbose");
    expect(d).toContain("我（内心独白）：又是 flag。"); // thought → 内心独白
    expect(d).toContain("@板砖 去加");
    expect(d).toContain("完成 · 1 file");
    expect(d).toContain("targeted test pass");
  });
  it("labels the outcome spine as verified backend evidence", () => {
    expect(buildEpisodeDigest(blocks)).toContain("差分协处理器");
  });
  it("omits an outcome spine when the episode has no coding system blocks", () => {
    const chat: TerminalRecordBlock[] = [
      { kind: "user", text: "闲聊" },
      { kind: "herta", surface: "speech", text: "终端外面有噪声。" },
    ];
    const d = buildEpisodeDigest(chat);
    expect(d).not.toContain("差分协处理器");
    expect(d).toContain("终端外面有噪声");
  });
  it("surfaces a supervisor self-correction as a labeled beat before the line", () => {
    const corrected: TerminalRecordBlock[] = [
      { kind: "user", text: "瓦尔特那边怎么说" },
      {
        kind: "herta",
        surface: "speech",
        text: "瓦尔特说再等等。",
        selfCorrection: "把瓦尔特说成了杨叔，已更正",
      },
    ];
    const d = buildEpisodeDigest(corrected);
    expect(d).toContain("〔黑塔的自我更正：把瓦尔特说成了杨叔，已更正〕");
    // the marker precedes the corrected speech line
    const lines = d.split("\n");
    const markerIdx = lines.findIndex((l) => l.includes("自我更正"));
    const speechIdx = lines.findIndex((l) => l.includes("瓦尔特说再等等"));
    expect(markerIdx).toBeGreaterThanOrEqual(0);
    expect(markerIdx).toBeLessThan(speechIdx);
  });
  it("adds no self-correction marker for a thought block or a plain speech", () => {
    const plain: TerminalRecordBlock[] = [
      { kind: "herta", surface: "speech", text: "在。" },
      { kind: "herta", surface: "thought", text: "随便他。" },
    ];
    expect(buildEpisodeDigest(plain)).not.toContain("自我更正");
  });
  it("drops live-work chrome: bg rows, todo layout, patch previews, 待办 roll-up", () => {
    const coding: TerminalRecordBlock[] = [
      { kind: "user", text: "修一下解析器" },
      { kind: "herta", surface: "speech", text: "@板砖 去。" },
      {
        kind: "system",
        label: "系统",
        body: "patch preview: a.ts\n\n```diff\n+++ b/a.ts\n+x\n```",
        digest: { kind: "skip" },
      },
      {
        kind: "system",
        label: "差分协处理器",
        body: "todo list (2):\n[ ] 修解析器\n[x] 读文件",
        digest: { kind: "todo", total: 2, completed: 1 },
      },
      {
        kind: "system",
        label: "差分协处理器",
        body: "↳ background bg-1: running",
        digest: { kind: "bg", id: "bg-1", state: "running" },
      },
      {
        kind: "system",
        label: "差分协处理器",
        body: "Writing a.ts",
        digest: { kind: "op", verb: "Writing", arg: "a.ts" },
      },
      {
        kind: "system",
        label: "差分协处理器",
        body: "完成 · 1 个文件",
        role: "done-marker",
        evidenceDetail: "↳ 改动文件: a.ts\n↳ 待办: 补测试",
      },
      { kind: "herta", surface: "speech", text: "改完了。" },
    ];
    const d = buildEpisodeDigest(coding);
    expect(d).not.toContain("```diff");
    expect(d).not.toContain("todo list");
    expect(d).not.toContain("background bg-1");
    expect(d).not.toContain("待办");
    // The outcome spine survives: op rows, the marker, its files roll-up.
    expect(d).toContain("Writing a.ts");
    expect(d).toContain("完成 · 1 个文件");
    expect(d).toContain("改动文件: a.ts");
  });
  it("keeps a background command's exit and its output — the verdict of a background test run — and drops its start, polls and stop (dream review 2026-09-22, finding 17)", () => {
    const bg = (
      state: "running" | "stopped" | "exited",
      extra: Pick<SystemBlock, "evidenceDetail"> = {},
    ): TerminalRecordBlock => ({
      kind: "system",
      label: "差分协处理器",
      body: `↳ background bg-1: ${state === "exited" ? "exited (1)" : state}`,
      digest: {
        kind: "bg",
        id: "bg-1",
        state,
        ...(state === "exited" ? { exitCode: 1 } : {}),
      },
      ...extra,
    });
    const run: TerminalRecordBlock[] = [
      {
        kind: "system",
        label: "差分协处理器",
        body: "Running npm test &",
        digest: { kind: "op", verb: "Running", arg: "npm test &" },
      },
      bg("running"),
      bg("running", { evidenceDetail: "↳ 输出:\nRUNS 12 suites" }),
      bg("exited", { evidenceDetail: "↳ 输出:\nFAIL parser.test.ts" }),
    ];
    const d = buildEpisodeDigest(run);
    expect(d).toContain("background bg-1: exited (1)");
    expect(d).toContain("FAIL parser.test.ts");
    expect(d).not.toContain("background bg-1: running");
    expect(d).not.toContain("RUNS 12 suites");
    // A background command that read the attachment store keeps its exit
    // row and loses the text (ADR 0069 §5).
    const fromStore = buildEpisodeDigest([
      {
        kind: "system",
        label: "差分协处理器",
        body: "Running cat .herta/attachments/s1/spec.md &",
        digest: {
          kind: "op",
          verb: "Running",
          arg: "cat .herta/attachments/s1/spec.md &",
        },
      },
      bg("running"),
      {
        kind: "system",
        label: "差分协处理器",
        body: "Reading bg-1 output",
        digest: { kind: "op", verb: "Reading", arg: "bg-1 output" },
      },
      bg("exited", { evidenceDetail: "↳ 输出:\nCONFIDENTIAL" }),
    ]);
    expect(fromStore).toContain("background bg-1: exited (1)");
    expect(fromStore).not.toContain("CONFIDENTIAL");
  });

  it("bounds a long run: its first and last rows, every marker, and a line saying how many were left out (ADR 0069 §7)", () => {
    const op = (i: number): TerminalRecordBlock => ({
      kind: "system",
      label: "差分协处理器",
      body: `Reading src/f${i}.ts`,
      digest: { kind: "op", verb: "Reading", arg: `src/f${i}.ts` },
    });
    const run: TerminalRecordBlock[] = [
      { kind: "user", text: "修 parser" },
      ...Array.from({ length: 50 }, (_, i) => op(i)),
      {
        kind: "system",
        label: "差分协处理器",
        body: "受阻 · 缺依赖",
        role: "done-marker",
      },
      ...Array.from({ length: 50 }, (_, i) => op(50 + i)),
      { kind: "herta", surface: "speech", text: "修好了。" },
    ];
    const d = buildEpisodeDigest(run);
    // The limit counts 板砖's rows; the marker stays on top of it.
    const kept = (d.match(/Reading src\/f\d+\.ts/g) ?? []).length;
    expect(kept).toBe(DIGEST_MAX_SYSTEM_ROWS);
    expect(d).toContain("Reading src/f0.ts");
    expect(d).toContain("Reading src/f99.ts");
    expect(d).toContain("受阻 · 缺依赖");
    expect(d).toContain(`此处略去 ${100 - kept} 条板砖操作记录`);
    expect(d).toContain("修好了。");
  });

  it("keeps run evidence within a budget, nearest the verdict first, and always the marker's own detail (ADR 0069 §7)", () => {
    const out = (i: number): TerminalRecordBlock => ({
      kind: "system",
      label: "差分协处理器",
      body: `↳ exit 0 · 40 lines (#${i})`,
      digest: { kind: "text", text: `↳ exit 0 · 40 lines (#${i})` },
      evidenceDetail: `↳ 输出:\nOUT${i} ${"x".repeat(1000)}`,
    });
    const d = buildEpisodeDigest([
      ...Array.from({ length: 12 }, (_, i) => out(i)),
      {
        kind: "system",
        label: "差分协处理器",
        body: "完成 · 1 个文件",
        role: "done-marker",
        evidenceDetail: "↳ 改动文件: a.ts",
      },
    ]);
    // Every body stays; only the last rows' outputs fit the budget.
    expect(d).toContain("(#0)");
    expect(d).not.toContain("OUT0 ");
    expect(d).toContain("OUT11 ");
    const outputs = (d.match(/OUT\d+ /g) ?? []).length;
    expect(outputs).toBeGreaterThan(0);
    expect(outputs * 1000).toBeLessThanOrEqual(DIGEST_EVIDENCE_BUDGET);
    expect(d).toContain("改动文件: a.ts");
  });

  it("tags each row by what it is — a failed call, a run that failed, stopped or stalled — instead of calling everything verified (dream review 2026-09-22, finding 17)", () => {
    const marker = (
      body: string,
      state?: "completed" | "failed" | "interrupted" | "blocked" | "partial",
    ): TerminalRecordBlock => ({
      kind: "system",
      label: "差分协处理器",
      body,
      role: "done-marker",
      ...(state !== undefined
        ? {
            markerSummary: {
              kind: "done" as const,
              state,
              fileCount: 0,
              riskCount: 0,
            },
          }
        : {}),
    });
    const d = buildEpisodeDigest([
      {
        kind: "system",
        label: "系统",
        body: "↳ edit_file failed: stale_read: file changed since read",
        digest: {
          kind: "tool-fail",
          tool: "edit_file",
          code: "stale_read",
        },
      },
      marker("中断 · 0 个文件", "interrupted"),
      marker("失败 · 运行异常中止", "failed"),
      marker("部分完成 · 1 个文件", "partial"),
      // Persisted before markerSummary existed: the body's state word.
      marker("受阻 · 缺依赖"),
      marker("完成 · 1 个文件", "completed"),
      {
        kind: "system",
        label: "差分协处理器",
        body: "↳ tests: 3 failed",
        digest: { kind: "tests", status: "failed", summary: "3 failed" },
      },
    ]);
    expect(d).toContain("〔系统（失败）：↳ edit_file failed");
    expect(d).toContain("〔差分协处理器（中断）：中断");
    expect(d).toContain("〔差分协处理器（失败）：失败 · 运行异常中止");
    expect(d).toContain("〔差分协处理器（部分完成）：部分完成");
    expect(d).toContain("〔差分协处理器（受阻）：受阻");
    expect(d).toContain("〔差分协处理器（已核实）：完成 · 1 个文件");
    // A failing test is a verified fact about the code, not a failed run.
    expect(d).toContain("〔差分协处理器（已核实）：↳ tests: 3 failed");
  });

  it("drops a patch preview in the shape the projector has emitted since 2026-08-25 — digest `patch`, the full diff in the body (dream review 2026-09-22, finding 1)", () => {
    const current: TerminalRecordBlock[] = [
      { kind: "herta", surface: "speech", text: "改。" },
      {
        kind: "system",
        label: "系统",
        body: "patch preview: a.ts (+2 -1)\n\n```diff\n--- a/a.ts\n+++ b/a.ts\n-x\n+y\n+z\n```",
        digest: { kind: "patch", files: ["a.ts"], add: 2, del: 1 },
      },
      {
        kind: "system",
        label: "差分协处理器",
        body: "Writing a.ts ↳ +2 −1",
        digest: { kind: "op", verb: "Writing", arg: "a.ts" },
      },
    ];
    const d = buildEpisodeDigest(current);
    expect(d).not.toContain("```diff");
    expect(d).not.toContain("patch preview");
    // The write row keeps the outcome and its magnitude.
    expect(d).toContain("Writing a.ts");
    const preview = current[1];
    if (preview?.kind !== "system") throw new Error("fixture");
    expect(dreamRelevantSystemBody(preview)).toBeNull();
  });

  it("drops a legacy pre-digest patch preview by body prefix", () => {
    const legacy: TerminalRecordBlock[] = [
      { kind: "herta", surface: "speech", text: "看。" },
      {
        kind: "system",
        label: "系统",
        body: "patch preview: old.ts\n\n```diff\n+y\n```",
      },
    ];
    expect(buildEpisodeDigest(legacy)).not.toContain("patch preview");
  });
});
