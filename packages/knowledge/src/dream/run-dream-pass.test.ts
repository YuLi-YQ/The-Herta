import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TerminalRecord } from "@herta/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeepSeekClient } from "../llm/types.js";
import * as manifestModule from "./manifest.js";
import { readManifest } from "./manifest.js";
import * as promoteModule from "./promote.js";
import { runDreamPass } from "./run-dream-pass.js";
import type { DreamCreatedRecord } from "./types.js";

/** The occasion the fake worthiness gate extracts (ADR 0021). */
const FAKE_OCCASION = "开拓者和我闲聊了一阵阮·梅正在搞的事。";

function fakeClient(over: Partial<DeepSeekClient> = {}): DeepSeekClient {
  return {
    chatJson: vi.fn(async ({ systemPrompt }) => {
      if (systemPrompt.includes("是否值得被收录"))
        return {
          rawJsonText: JSON.stringify({
            worthy: true,
            reason: "dry",
            occasion: FAKE_OCCASION,
          }),
          model: "deepseek-v4-pro",
        };
      if (systemPrompt.includes("sameOccasion"))
        return {
          rawJsonText: JSON.stringify({
            sameOccasion: false,
            matchedId: "",
            reason: "",
          }),
          model: "deepseek-v4-pro",
        };
      if (systemPrompt.includes("逐行"))
        return {
          rawJsonText: JSON.stringify({
            voice: 0.95,
            format: 1,
            novelty: 1,
            fixes: [],
          }),
          model: "deepseek-v4-pro",
        };
      // generation
      return {
        rawJsonText: JSON.stringify({
          feian:
            "### 废案_00：午后的低气压\n阮·梅又来了。\n\n---\n\n（开拓者 说）\n在吗\n（/开拓者 说）\n\n（我 说）\n在。别废话。\n（/我 说）",
          situationTag: "dry-refusal",
        }),
        model: "deepseek-v4-pro",
      };
    }) as DeepSeekClient["chatJson"],
    ...over,
  };
}

describe("runDreamPass", () => {
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "dream-run-"));
    mkdirSync(join(ws, ".herta", "narrative"), { recursive: true });
  });
  afterEach(() => rmSync(ws, { recursive: true, force: true }));

  const record: TerminalRecord = [
    { kind: "user", text: "阮·梅又在搞事，你怎么看" },
    { kind: "herta", surface: "speech", text: "我看她乐在其中。" },
    { kind: "herta", surface: "speech", text: "至于我，懒得掺和。" },
    { kind: "user", text: "（新话题）帮我看个 bug" }, // settles episode 0
  ];

  // Use a small minEpisodeChars so the short test record passes the select filter.
  const testConfig = { minEpisodeChars: 10 };

  it("an en pass targets the -en corpus dirs and never touches the zh one", async () => {
    // Empty session list → no LLM calls needed; we're asserting the dir split.
    const res = await runDreamPass({
      workspaceRoot: ws,
      sessions: [],
      client: fakeClient(),
      runId: "rEN",
      lang: "en",
      now: () => new Date("2026-07-15T00:00:00Z"),
    });
    expect(res.promoted).toBe(0);
    // Bookkeeping (manifest) landed in the EN dream dir; the zh dirs are
    // untouched — the two corpora are isolated on disk.
    expect(existsSync(join(ws, ".herta", "dream-en", "manifest.json"))).toBe(
      true,
    );
    expect(existsSync(join(ws, ".herta", "dream", "manifest.json"))).toBe(
      false,
    );
  });

  it("promotes a worthy non-coding episode into narrative/", async () => {
    const res = await runDreamPass({
      workspaceRoot: ws,
      sessions: [{ sessionId: "s1", record }],
      client: fakeClient(),
      runId: "r1",
      config: testConfig,
      now: () => new Date("2026-06-18T09:30:00Z"),
    });
    expect(res.promoted).toBe(1);
    const files = readdirSync(join(ws, ".herta", "narrative"));
    expect(files.some((f) => /^### 废案_\d+：/.test(f))).toBe(true);

    // The promoted manifest record must carry a non-empty narrative-opening summary.
    // The fake feian has "阮·梅又来了。" before the first ---, so extractNarrativeOpening
    // returns that line.
    const manifest = readManifest(join(ws, ".herta", "dream"));
    const promoted = manifest.created.find((r) => r.state === "live");
    expect(promoted).toBeDefined();
    expect(promoted?.summary).toBeTruthy();
    expect(promoted?.summary).toContain("阮·梅又来了");
    // ADR 0021: the worthiness-extracted occasion is stored on the new record.
    expect(promoted?.occasion).toBe(FAKE_OCCASION);
  });

  it("still promotes when the worthiness reply carries no occasion (never blocks on the new field)", async () => {
    const client = fakeClient();
    (client.chatJson as ReturnType<typeof vi.fn>).mockImplementation(
      async ({ systemPrompt }: { systemPrompt: string }) => {
        const j = (o: unknown) => ({
          rawJsonText: JSON.stringify(o),
          model: "m",
        });
        if (systemPrompt.includes("是否值得被收录"))
          return j({ worthy: true, reason: "dry" }); // no occasion field
        if (systemPrompt.includes("sameOccasion"))
          return j({ sameOccasion: false, matchedId: "", reason: "" });
        if (systemPrompt.includes("逐行"))
          return j({ voice: 0.95, format: 1, novelty: 1, fixes: [] });
        return j({
          feian:
            "### 废案_00：午后的低气压\n阮·梅又来了。\n\n---\n\n（开拓者 说）\n在吗\n（/开拓者 说）\n\n（我 说）\n在。别废话。\n（/我 说）",
          situationTag: "dry-refusal",
        });
      },
    );
    const res = await runDreamPass({
      workspaceRoot: ws,
      sessions: [{ sessionId: "s1", record }],
      client,
      runId: "rnoocc",
      config: testConfig,
      now: () => new Date("2026-06-18T09:30:00Z"),
    });
    expect(res.promoted).toBe(1);
    const manifest = readManifest(join(ws, ".herta", "dream"));
    const promoted = manifest.created.find((r) => r.state === "live");
    expect(promoted).toBeDefined();
    expect(promoted?.occasion).toBeUndefined();
  });

  it("total cap: promotion evicts the highest seed EXAMPLE first, sparing anchors + dreams (M-feian-1)", async () => {
    const narrative = join(ws, ".herta", "narrative");
    const seed = (nn: string, title: string) =>
      writeFileSync(
        join(narrative, `### 废案_${nn}：${title}.txt`),
        `### 废案_${nn}：${title}\n正文。\n\n---\n\n（我 说）\n嗯。\n（/我 说）\n`,
        "utf8",
      );
    seed("00", "锚点");
    seed("01", "别人甲");
    seed("02", "别人乙");
    seed("03", "种子丙");
    seed("04", "种子丁");
    seed("05", "种子戊");
    seed("06", "种子己");
    const res = await runDreamPass({
      workspaceRoot: ws,
      sessions: [{ sessionId: "s1", record }],
      client: fakeClient(),
      runId: "rcap",
      // 7 live seeds fill the total budget exactly — promoting one dream
      // must first make room by archiving one evictable seed.
      config: { ...testConfig, maxLiveCount: 7 },
      now: () => new Date("2026-07-05T09:30:00Z"),
    });
    expect(res.promoted).toBe(1);
    expect(res.seedsEvicted).toBe(1);
    const files = readdirSync(narrative);
    // 06 (highest in the evictable band) went first; 00-05 survive.
    expect(files).not.toContain("### 废案_06：种子己.txt");
    for (const keep of ["00", "01", "02", "03", "04", "05"]) {
      expect(files.some((f) => f.startsWith(`### 废案_${keep}：`))).toBe(true);
    }
    // The dream promoted (it reuses the freed NN — the manifest, not the
    // number, is what distinguishes dreams from seeds).
    const manifest = readManifest(join(ws, ".herta", "dream"));
    const promoted = manifest.created.find((r) => r.state === "live");
    expect(promoted).toBeDefined();
    expect(files).toContain(promoted?.file);
    // Total budget holds after the promotion.
    expect(files.filter((f) => f.startsWith("### 废案")).length).toBe(7);
    // Archived, not deleted — recoverable from the dream archive.
    expect(
      existsSync(
        join(ws, ".herta", "dream", "archive", "### 废案_06：种子己.txt"),
      ),
    ).toBe(true);
  });

  it("total cap: protected anchors are NEVER evicted even when the budget cannot be met", async () => {
    const narrative = join(ws, ".herta", "narrative");
    for (const [nn, title] of [
      ["00", "锚点"],
      ["01", "别人甲"],
      ["02", "别人乙"],
    ] as const) {
      writeFileSync(
        join(narrative, `### 废案_${nn}：${title}.txt`),
        `### 废案_${nn}：${title}\n正文。\n\n---\n\n（我 说）\n嗯。\n（/我 说）\n`,
        "utf8",
      );
    }
    const res = await runDreamPass({
      workspaceRoot: ws,
      sessions: [{ sessionId: "s1", record }],
      client: fakeClient(),
      runId: "rcap2",
      // Budget below the protected floor: nothing is evictable, and the
      // promotion still proceeds (soft budget with a protected floor).
      config: { ...testConfig, maxLiveCount: 1 },
      now: () => new Date("2026-07-05T09:30:00Z"),
    });
    expect(res.promoted).toBe(1);
    expect(res.seedsEvicted).toBe(0);
    const files = readdirSync(narrative);
    for (const keep of ["00", "01", "02"]) {
      expect(files.some((f) => f.startsWith(`### 废案_${keep}：`))).toBe(true);
    }
  });

  it("skips an already-dreamed episode on re-run (no reconsider)", async () => {
    const opts = {
      workspaceRoot: ws,
      sessions: [{ sessionId: "s1", record }],
      client: fakeClient(),
      runId: "r2",
      config: testConfig,
      now: () => new Date("2026-06-18T09:30:00Z"),
    };
    await runDreamPass(opts);
    const res2 = await runDreamPass({ ...opts, runId: "r3" });
    expect(res2.promoted).toBe(0);
    expect(res2.skipped).toBeGreaterThanOrEqual(1);
  });

  it("re-processes an already-dreamed episode when reconsider: true", async () => {
    const opts = {
      workspaceRoot: ws,
      sessions: [{ sessionId: "s1", record }],
      client: fakeClient(),
      runId: "r10",
      config: testConfig,
      now: () => new Date("2026-06-18T09:30:00Z"),
    };
    // First pass — promote the episode.
    const res1 = await runDreamPass(opts);
    expect(res1.promoted).toBe(1);

    // Second pass with reconsider: true — the episode must NOT be skipped-by-dedup.
    // It will be re-considered (considered >= 1). The title-novelty gate archives it
    // as a duplicate title, but it must have gone through the quality gates, not the
    // dedup skip.
    const res2 = await runDreamPass({
      ...opts,
      runId: "r11",
      reconsider: true,
    });
    // skipped-by-dedup must be 0 — the episode was re-considered
    expect(res2.skipped).toBe(0);
    // considered must be >=1 (it passed the dedup gate and entered the pipeline)
    expect(res2.considered).toBeGreaterThanOrEqual(1);
  });

  it("archives (not promotes) a valid+novel candidate below minVoiceScore", async () => {
    const client = fakeClient();
    (client.chatJson as ReturnType<typeof vi.fn>).mockImplementation(
      async ({ systemPrompt }: { systemPrompt: string }) => {
        if (systemPrompt.includes("是否值得被收录"))
          return {
            rawJsonText: JSON.stringify({ worthy: true, reason: "x" }),
            model: "m",
          };
        if (systemPrompt.includes("sameOccasion"))
          return {
            rawJsonText: JSON.stringify({ sameOccasion: false }),
            model: "m",
          };
        if (systemPrompt.includes("逐行"))
          return {
            rawJsonText: JSON.stringify({
              voice: 0.3,
              format: 1,
              novelty: 1,
              fixes: [],
            }),
            model: "m",
          };
        return {
          rawJsonText: JSON.stringify({
            // Valid length (>60 chars) so the candidate clears validateFeian and
            // actually reaches the voice gate — a too-short body archives at the
            // refine stage and leaves the gate untested.
            feian:
              "### 废案_00：低分案\n那天的对话平淡得可以，我敷衍了两句就把窗口切走了，连记录都懒得多写一行。\n\n---\n\n（我 说）\n敷衍两句，够了。这种事不值得占用我第二个脑细胞。\n（/我 说）",
            situationTag: "flat",
          }),
          model: "m",
        };
      },
    );
    const res = await runDreamPass({
      workspaceRoot: ws,
      sessions: [{ sessionId: "s1", record }],
      client,
      runId: "r4",
      config: testConfig,
      now: () => new Date("2026-06-18T09:30:00Z"),
    });
    expect(res.promoted).toBe(0);
    expect(res.archived).toBeGreaterThanOrEqual(1);
    // The archive must have come from the voice gate itself, not an earlier
    // stage (refine/format).
    const m = readManifest(join(ws, ".herta", "dream"));
    expect(
      m.episodes.some(
        (e) =>
          e.outcome === "archived" &&
          (e.reason ?? "").includes("low voice 0.3"),
      ),
    ).toBe(true);
    expect(
      readdirSync(join(ws, ".herta", "narrative")).some((f) => /废案/.test(f)),
    ).toBe(false);
  });

  // Faithfulness gate (2026-07-19): a page that abandoned its source
  // episode's substance archives even with a perfect voice score.
  it("archives a candidate whose （开拓者 说） lines are invented, feeding the gate error through refine first (ADR 0036)", async () => {
    // The persona E2E (2026-08-11) caught the LLM faithfulness critique
    // passing a counterfeit page with four user turns the 开拓者 never typed.
    // The structural user-line gate shares the format-refine loop: the draft
    // gets refine chances with the named error, and only then archives.
    const inventedPage =
      "### 废案_00：编出来的对话\n那天的记录我翻得很熟，熟到能背出他没说过的话。\n\n---\n\n（开拓者 说）\n这句台词是编出来的，记录里从来没有人打过这一行字。\n（/开拓者 说）\n\n（我 说）\n我的回答倒是无所谓，我的话本来就允许梦里重写。\n（/我 说）";
    const refinePrompts: string[] = [];
    const client = fakeClient();
    (client.chatJson as ReturnType<typeof vi.fn>).mockImplementation(
      async ({
        systemPrompt,
        userPayload,
      }: {
        systemPrompt: string;
        userPayload: string;
      }) => {
        if (systemPrompt.includes("是否值得被收录"))
          return {
            rawJsonText: JSON.stringify({ worthy: true, reason: "x" }),
            model: "m",
          };
        if (systemPrompt.includes("修复")) {
          // The refine call — capture that it received the gate's error
          // (errors ride the USER payload) and return the SAME invented
          // page (unrepentant model).
          refinePrompts.push(userPayload);
          return {
            rawJsonText: JSON.stringify({ feian: inventedPage }),
            model: "m",
          };
        }
        return {
          rawJsonText: JSON.stringify({
            feian: inventedPage,
            situationTag: "counterfeit",
          }),
          model: "m",
        };
      },
    );
    const res = await runDreamPass({
      workspaceRoot: ws,
      sessions: [{ sessionId: "s1", record }],
      client,
      runId: "ul1",
      config: testConfig,
      now: () => new Date("2026-06-18T09:30:00Z"),
    });
    expect(res.promoted).toBe(0);
    expect(res.archived).toBeGreaterThanOrEqual(1);
    const m = readManifest(join(ws, ".herta", "dream"));
    const entry = m.episodes.find((e) => e.outcome === "archived");
    expect(entry?.reason).toContain("不存在的开拓者台词");
    // The gate error reached the refine prompt — corrective before terminal.
    expect(refinePrompts.some((p) => p.includes("不存在的开拓者台词"))).toBe(
      true,
    );
    // Nothing invented reached the corpus.
    const files = readdirSync(join(ws, ".herta", "narrative"));
    expect(files.some((f) => f.includes("编出来的对话"))).toBe(false);
  });

  it("archives a candidate below minFaithfulnessScore even when voice passes", async () => {
    const client = fakeClient();
    (client.chatJson as ReturnType<typeof vi.fn>).mockImplementation(
      async ({ systemPrompt }: { systemPrompt: string }) => {
        if (systemPrompt.includes("是否值得被收录"))
          return {
            rawJsonText: JSON.stringify({ worthy: true, reason: "x" }),
            model: "m",
          };
        if (systemPrompt.includes("sameOccasion"))
          return {
            rawJsonText: JSON.stringify({ sameOccasion: false }),
            model: "m",
          };
        if (systemPrompt.includes("逐行"))
          return {
            rawJsonText: JSON.stringify({
              voice: 0.95,
              format: 1,
              novelty: 1,
              faithfulness: 0.3,
              fixes: [],
            }),
            model: "m",
          };
        return {
          rawJsonText: JSON.stringify({
            feian:
              "### 废案_00：漂走的故事\n那天办公室的冷却循环声音比平时大，我把三块屏幕都调成了静音，专心处理一件和这里无关的事。\n\n---\n\n（我 说）\n另一个故事，和那段对话没有任何关系，但写得足够长，长到能通过格式检查。\n（/我 说）",
            situationTag: "drift",
          }),
          model: "m",
        };
      },
    );
    const res = await runDreamPass({
      workspaceRoot: ws,
      sessions: [{ sessionId: "s1", record }],
      client,
      runId: "rf1",
      config: testConfig,
      now: () => new Date("2026-06-18T09:30:00Z"),
    });
    expect(res.promoted).toBe(0);
    expect(res.archived).toBeGreaterThanOrEqual(1);
    const m = readManifest(join(ws, ".herta", "dream"));
    expect(
      m.episodes.some(
        (e) =>
          e.outcome === "archived" &&
          (e.reason ?? "").includes("low faithfulness 0.3"),
      ),
    ).toBe(true);
    expect(
      readdirSync(join(ws, ".herta", "narrative")).some((f) => /废案/.test(f)),
    ).toBe(false);
  });

  it("promotes above the faithfulness floor and stores the score", async () => {
    const client = fakeClient();
    (client.chatJson as ReturnType<typeof vi.fn>).mockImplementation(
      async ({ systemPrompt }: { systemPrompt: string }) => {
        if (systemPrompt.includes("是否值得被收录"))
          return {
            rawJsonText: JSON.stringify({ worthy: true, reason: "x" }),
            model: "m",
          };
        if (systemPrompt.includes("sameOccasion"))
          return {
            rawJsonText: JSON.stringify({ sameOccasion: false }),
            model: "m",
          };
        if (systemPrompt.includes("逐行"))
          return {
            rawJsonText: JSON.stringify({
              voice: 0.9,
              format: 1,
              novelty: 1,
              faithfulness: 0.9,
              fixes: [],
            }),
            model: "m",
          };
        return {
          rawJsonText: JSON.stringify({
            feian:
              "### 废案_00：忠实案\n那场通信我记得很清楚：他说了那件事，我停下手里的活听完，然后照实回了他。下面是当时的记录。\n\n---\n\n（我 说）\n就是那件事——你说的我听见了，记录也在这儿，一个字都没往上加。\n（/我 说）",
            situationTag: "faithful",
          }),
          model: "m",
        };
      },
    );
    const res = await runDreamPass({
      workspaceRoot: ws,
      sessions: [{ sessionId: "s1", record }],
      client,
      runId: "rf2",
      config: testConfig,
      now: () => new Date("2026-06-18T09:30:00Z"),
    });
    expect(res.promoted).toBe(1);
    const m = readManifest(join(ws, ".herta", "dream"));
    expect(m.created[0]?.critiqueScores?.faithfulness).toBe(0.9);
  });

  // C1: generation returns {} (no feian field) → archived, no crash, pass returns
  it("archives episode and does not crash when generation returns {} (no feian field)", async () => {
    const client = fakeClient();
    (client.chatJson as ReturnType<typeof vi.fn>).mockImplementation(
      async ({ systemPrompt }: { systemPrompt: string }) => {
        if (systemPrompt.includes("是否值得被收录"))
          return {
            rawJsonText: JSON.stringify({ worthy: true, reason: "ok" }),
            model: "m",
          };
        // generation prompt: return {} — no feian field
        return { rawJsonText: JSON.stringify({}), model: "m" };
      },
    );
    const res = await runDreamPass({
      workspaceRoot: ws,
      sessions: [{ sessionId: "s1", record }],
      client,
      runId: "r5",
      config: testConfig,
      now: () => new Date("2026-06-18T09:30:00Z"),
    });
    expect(res.archived).toBeGreaterThanOrEqual(1);
    expect(res.promoted).toBe(0);
    // No narrative files must have been written
    expect(
      readdirSync(join(ws, ".herta", "narrative")).some((f) => /废案/.test(f)),
    ).toBe(false);
  });

  // S1: reactivation gate fires but returns no usable matchedId → episode is
  // archived (not promoted), and no NEW file lands in narrative/
  it("archives (not promotes) a same-occasion candidate whose matched id is empty", async () => {
    // One live record so the gate fires at all (an empty live list skips it).
    const narr = join(ws, ".herta", "narrative");
    const liveFile = "### 废案_01：既有梦境.txt";
    writeFileSync(
      join(narr, liveFile),
      "### 废案_01：既有梦境\n既有正文。\n\n---\n\n（我 说）\n嗯。\n（/我 说）",
      "utf8",
    );
    mkdirSync(join(ws, ".herta", "dream"), { recursive: true });
    const seeded = manifestModule.emptyManifest();
    seeded.created.push({
      id: "prior",
      file: liveFile,
      nn: 1,
      state: "live",
      sourceSessionId: "s0",
      sourceEpisodeHash: "hPrior",
      sourceEpisodes: ["hPrior"],
      runId: "r0",
      model: "m",
      generatedAt: "2026-06-17T09:00:00Z",
      situationTag: "tag",
      summary: "既有正文。",
      critiqueScores: { voice: 0.9, format: 1, novelty: 1 },
      validateFeianPassed: true,
      reactivationCount: 0,
    });
    manifestModule.writeManifest(join(ws, ".herta", "dream"), seeded);

    const client = fakeClient();
    (client.chatJson as ReturnType<typeof vi.fn>).mockImplementation(
      async ({ systemPrompt }: { systemPrompt: string }) => {
        if (systemPrompt.includes("是否值得被收录"))
          return {
            rawJsonText: JSON.stringify({ worthy: true, reason: "ok" }),
            model: "m",
          };
        if (systemPrompt.includes("sameOccasion"))
          // The gate says same occasion, but hands back no usable id.
          return {
            rawJsonText: JSON.stringify({
              sameOccasion: true,
              matchedId: "",
              reason: "同一件事，但没给出 id",
            }),
            model: "m",
          };
        // generation
        return {
          rawJsonText: JSON.stringify({
            feian:
              "### 废案_00：午后的低气压\n阮·梅又来了。\n\n---\n\n（开拓者 说）\n在吗\n（/开拓者 说）\n\n（我 说）\n在。别废话。\n（/我 说）",
            situationTag: "dry-refusal",
          }),
          model: "m",
        };
      },
    );
    const res = await runDreamPass({
      workspaceRoot: ws,
      sessions: [{ sessionId: "s1", record }],
      client,
      runId: "r7",
      config: testConfig,
      now: () => new Date("2026-06-18T09:30:00Z"),
    });
    expect(res.promoted).toBe(0);
    expect(res.reinforced).toBe(0);
    expect(res.reconsolidated).toBe(0);
    expect(res.archived).toBeGreaterThanOrEqual(1);
    // The archive came from the junction's unresolved-match fallback — the
    // gate fired and the empty id failed to resolve.
    const m = readManifest(join(ws, ".herta", "dream"));
    expect(
      m.episodes.some(
        (e) =>
          e.outcome === "archived" &&
          (e.reason ?? "").startsWith("near-dup (unresolved match)"),
      ),
    ).toBe(true);
    // No NEW narrative file was written — only the seeded live record remains.
    expect(readdirSync(narr).filter((f) => /废案/.test(f))).toEqual([liveFile]);
  });

  // I2: critique returns {} (no numeric fields) → archived, not promoted, no file in narrative/
  it("archives episode and does not promote when critique returns {} (no score fields)", async () => {
    const client = fakeClient();
    (client.chatJson as ReturnType<typeof vi.fn>).mockImplementation(
      async ({ systemPrompt }: { systemPrompt: string }) => {
        if (systemPrompt.includes("是否值得被收录"))
          return {
            rawJsonText: JSON.stringify({ worthy: true, reason: "ok" }),
            model: "m",
          };
        if (systemPrompt.includes("sameOccasion"))
          return {
            rawJsonText: JSON.stringify({ sameOccasion: false }),
            model: "m",
          };
        if (systemPrompt.includes("逐行"))
          // critique returns {} — no score fields
          return { rawJsonText: JSON.stringify({}), model: "m" };
        // generation
        return {
          rawJsonText: JSON.stringify({
            feian:
              "### 废案_00：午后的低气压\n阮·梅又来了。\n\n---\n\n（开拓者 说）\n在吗\n（/开拓者 说）\n\n（我 说）\n在。别废话。\n（/我 说）",
            situationTag: "dry-refusal",
          }),
          model: "m",
        };
      },
    );
    const res = await runDreamPass({
      workspaceRoot: ws,
      sessions: [{ sessionId: "s1", record }],
      client,
      runId: "r6",
      config: testConfig,
      now: () => new Date("2026-06-18T09:30:00Z"),
    });
    expect(res.promoted).toBe(0);
    expect(res.archived).toBeGreaterThanOrEqual(1);
    expect(
      readdirSync(join(ws, ".herta", "narrative")).some((f) => /废案/.test(f)),
    ).toBe(false);
  });

  it("uses generationEffort (max) for generation and gateEffort (high) for the gates", async () => {
    // Seed one live dream record (file + manifest) so the reactivation gate
    // fires — with an empty live list the gate call is skipped entirely.
    const narr = join(ws, ".herta", "narrative");
    const liveFile = "### 废案_01：既有梦境.txt";
    writeFileSync(
      join(narr, liveFile),
      "### 废案_01：既有梦境\n既有正文。\n\n---\n\n（我 说）\n嗯。\n（/我 说）",
      "utf8",
    );
    mkdirSync(join(ws, ".herta", "dream"), { recursive: true });
    const seeded = manifestModule.emptyManifest();
    seeded.created.push({
      id: "prior",
      file: liveFile,
      nn: 1,
      state: "live",
      sourceSessionId: "s0",
      sourceEpisodeHash: "hPrior",
      sourceEpisodes: ["hPrior"],
      runId: "r0",
      model: "m",
      generatedAt: "2026-06-17T09:00:00Z",
      situationTag: "tag",
      summary: "既有正文。",
      critiqueScores: { voice: 0.9, format: 1, novelty: 1 },
      validateFeianPassed: true,
      reactivationCount: 0,
    });
    manifestModule.writeManifest(join(ws, ".herta", "dream"), seeded);

    const client = fakeClient();
    await runDreamPass({
      workspaceRoot: ws,
      sessions: [{ sessionId: "s1", record }],
      client,
      runId: "reff",
      config: testConfig,
      now: () => new Date("2026-06-18T09:30:00Z"),
    });
    const calls = (client.chatJson as ReturnType<typeof vi.fn>).mock.calls;
    const effortFor = (marker: string): unknown =>
      calls.find(([a]) => a.systemPrompt.includes(marker))?.[0].reasoningEffort;
    expect(effortFor("黑塔人物与说话指南")).toBe("max"); // generation
    expect(effortFor("值得")).toBe("high"); // worthiness gate
    expect(effortFor("逐行")).toBe("high"); // critique gate
    expect(effortFor("sameOccasion")).toBe("high"); // reactivation gate
  });

  it("flushes the manifest after each episode (incremental durability)", async () => {
    const spy = vi.spyOn(manifestModule, "writeManifest");
    await runDreamPass({
      workspaceRoot: ws,
      sessions: [{ sessionId: "s1", record }],
      client: fakeClient(),
      runId: "rflush",
      config: testConfig,
      now: () => new Date("2026-06-18T09:30:00Z"),
    });
    // One per-episode flush (the loop's finally) + the final completion flush.
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
    spy.mockRestore();
  });

  it("never adopts or evicts a pre-existing user-authored 废案 (identity guard)", async () => {
    const narr = join(ws, ".herta", "narrative");
    const seed = "### 废案_00：用户手写.txt";
    writeFileSync(
      join(narr, seed),
      "用户手写的废案正文。\n\n---\n\n（我 说）\n手写。\n（/我 说）",
      "utf8",
    );

    const res = await runDreamPass({
      workspaceRoot: ws,
      sessions: [{ sessionId: "s1", record }],
      client: fakeClient(),
      runId: "rseed",
      config: testConfig,
      now: () => new Date("2026-06-18T09:30:00Z"),
    });

    expect(res.promoted).toBe(1);
    // The user seed is untouched on disk and absent from the dream ledger.
    expect(existsSync(join(narr, seed))).toBe(true);
    const m = readManifest(join(ws, ".herta", "dream"));
    expect(m.created.every((r) => r.file !== seed)).toBe(true);
    // The dream promotion took the next index (_01), not colliding with _00.
    expect(m.created.some((r) => r.file.startsWith("### 废案_01："))).toBe(
      true,
    );
  });

  it("promoted records carry sourceEpisodes and a dormant reactivationCount", async () => {
    await runDreamPass({
      workspaceRoot: ws,
      sessions: [{ sessionId: "s1", record }],
      client: fakeClient(),
      runId: "rfields",
      config: testConfig,
      now: () => new Date("2026-06-18T09:30:00Z"),
    });
    const m = readManifest(join(ws, ".herta", "dream"));
    const live = m.created.find((r) => r.state === "live");
    expect(live?.reactivationCount).toBe(0);
    expect(live?.sourceEpisodes).toEqual([live?.sourceEpisodeHash]);
  });

  it("picks one seed + the strongest dream as generation exemplars", async () => {
    const narr = join(ws, ".herta", "narrative");
    // A hand-authored seed (absent from the manifest → the anti-drift anchor).
    const seedFile = "### 废案_00：手写锚点.txt";
    const seedBody = "手写锚点正文。\n\n---\n\n（我 说）\n锚。\n（/我 说）";
    writeFileSync(join(narr, seedFile), seedBody, "utf8");
    // A prior dream-created 废案 (in the manifest) that should be picked as the
    // "strongest dream" exemplar alongside the seed.
    const dreamFile = "### 废案_01：既有梦境.txt";
    const dreamBody = "既有梦境正文。\n\n---\n\n（我 说）\n梦。\n（/我 说）";
    writeFileSync(join(narr, dreamFile), dreamBody, "utf8");
    mkdirSync(join(ws, ".herta", "dream"), { recursive: true });
    const seededManifest = manifestModule.emptyManifest();
    seededManifest.created.push({
      id: "prior",
      file: dreamFile,
      nn: 1,
      state: "live",
      sourceSessionId: "s0",
      sourceEpisodeHash: "hPrior",
      sourceEpisodes: ["hPrior"],
      runId: "r0",
      model: "m",
      generatedAt: "2026-06-17T09:00:00Z",
      situationTag: "tag",
      summary: "既有梦境正文。",
      critiqueScores: { voice: 0.9, format: 1, novelty: 1 },
      validateFeianPassed: true,
      reactivationCount: 0,
    });
    manifestModule.writeManifest(join(ws, ".herta", "dream"), seededManifest);

    const client = fakeClient();
    await runDreamPass({
      workspaceRoot: ws,
      sessions: [{ sessionId: "s1", record }],
      client,
      runId: "rex",
      config: testConfig,
      now: () => new Date("2026-06-18T09:30:00Z"),
    });
    // The generation prompt (system marker "黑塔人物与说话指南") must embed BOTH
    // the seed anchor and the strongest dream, not two seeds nor two dreams.
    const calls = (client.chatJson as ReturnType<typeof vi.fn>).mock.calls;
    const genCall = calls.find(([a]) =>
      a.systemPrompt.includes("黑塔人物与说话指南"),
    );
    const payload =
      (genCall?.[0].userPayload ?? "") + (genCall?.[0].systemPrompt ?? "");
    expect(payload).toContain("手写锚点正文");
    expect(payload).toContain("既有梦境正文");
  });

  it("an excerpt the gate calls mixed is written and judged about the one event it named (dream review 2026-09-22, finding 22)", async () => {
    const base = fakeClient();
    const client: DeepSeekClient = {
      chatJson: vi.fn(async (input) => {
        if (input.systemPrompt.includes("是否值得被收录")) {
          return {
            rawJsonText: JSON.stringify({
              worthy: true,
              reason: "dry",
              occasion: FAKE_OCCASION,
              mixedTopics: true,
            }),
            model: "deepseek-v4-pro",
          };
        }
        return base.chatJson(input);
      }) as DeepSeekClient["chatJson"],
    };
    await runDreamPass({
      workspaceRoot: ws,
      sessions: [{ sessionId: "s1", record }],
      client,
      runId: "mixed",
      config: testConfig,
      now: () => new Date("2026-06-18T09:30:00Z"),
    });
    const calls = (client.chatJson as ReturnType<typeof vi.fn>).mock.calls;
    const gen = calls.find(([a]) =>
      a.systemPrompt.includes("黑塔人物与说话指南"),
    )?.[0].systemPrompt;
    const critique = calls.find(([a]) => a.systemPrompt.includes("逐行"))?.[0]
      .systemPrompt;
    expect(gen).toContain("本则废案的取材范围");
    expect(gen).toContain(FAKE_OCCASION);
    expect(critique).toContain("这则废案只取其中一件");
    expect(critique).toContain(FAKE_OCCASION);
  });

  it("an excerpt about one thing gets no focus section", async () => {
    const client = fakeClient();
    await runDreamPass({
      workspaceRoot: ws,
      sessions: [{ sessionId: "s1", record }],
      client,
      runId: "single",
      config: testConfig,
      now: () => new Date("2026-06-18T09:30:00Z"),
    });
    const calls = (client.chatJson as ReturnType<typeof vi.fn>).mock.calls;
    const gen = calls.find(([a]) =>
      a.systemPrompt.includes("黑塔人物与说话指南"),
    )?.[0].systemPrompt;
    expect(gen).toBeDefined();
    expect(gen).not.toContain("本则废案的取材范围");
  });

  it("stale-floor forgets a decayed dream at pass start when the floor is set", async () => {
    const narr = join(ws, ".herta", "narrative");
    const staleFile = "### 废案_01：陈旧梦境.txt";
    writeFileSync(
      join(narr, staleFile),
      "陈旧正文。\n\n---\n\n（我 说）\n旧。\n（/我 说）",
      "utf8",
    );
    mkdirSync(join(ws, ".herta", "dream"), { recursive: true });
    const seeded = manifestModule.emptyManifest();
    seeded.created.push({
      id: "old",
      file: staleFile,
      nn: 1,
      state: "live",
      sourceSessionId: "s0",
      sourceEpisodeHash: "hOld",
      sourceEpisodes: ["hOld"],
      runId: "r0",
      model: "m",
      generatedAt: "2026-01-01T00:00:00Z", // very stale relative to the pass clock
      situationTag: "tag",
      summary: "陈旧正文。",
      critiqueScores: { voice: 0.9, format: 1, novelty: 1 },
      validateFeianPassed: true,
      reactivationCount: 0,
    });
    manifestModule.writeManifest(join(ws, ".herta", "dream"), seeded);

    await runDreamPass({
      workspaceRoot: ws,
      sessions: [], // no episodes — only the stale-floor sweep should run
      client: fakeClient(),
      runId: "rstale",
      config: {
        ...testConfig,
        retentionFloor: 0.5,
        retentionHalfLifeDays: 30,
      },
      now: () => new Date("2026-07-01T00:00:00Z"),
    });

    // The decayed dream was archived (moved out of narrative/, flipped to archived).
    expect(existsSync(join(narr, staleFile))).toBe(false);
    const m = readManifest(join(ws, ".herta", "dream"));
    expect(m.created.find((r) => r.id === "old")?.state).toBe("archived");
    expect(
      m.episodes.some((e) => (e.reason ?? "").startsWith("forgotten:")),
    ).toBe(true);
  });

  it("does not forget any dream when the floor is explicitly 0 (disabled)", async () => {
    const narr = join(ws, ".herta", "narrative");
    const file = "### 废案_01：不该被遗忘.txt";
    writeFileSync(
      join(narr, file),
      "正文。\n\n---\n\n（我 说）\n留。\n（/我 说）",
      "utf8",
    );
    mkdirSync(join(ws, ".herta", "dream"), { recursive: true });
    const seeded = manifestModule.emptyManifest();
    seeded.created.push({
      id: "keep",
      file,
      nn: 1,
      state: "live",
      sourceSessionId: "s0",
      sourceEpisodeHash: "hKeep",
      sourceEpisodes: ["hKeep"],
      runId: "r0",
      model: "m",
      generatedAt: "2026-01-01T00:00:00Z", // ancient, but floor 0 = disabled
      situationTag: "tag",
      summary: "正文。",
      critiqueScores: { voice: 0.9, format: 1, novelty: 1 },
      validateFeianPassed: true,
      reactivationCount: 0,
    });
    manifestModule.writeManifest(join(ws, ".herta", "dream"), seeded);

    await runDreamPass({
      workspaceRoot: ws,
      sessions: [],
      client: fakeClient(),
      runId: "rkeep",
      // The DEFAULT floor is 0.12 since ADR 0023 — this test pins the
      // explicit opt-out.
      config: { ...testConfig, retentionFloor: 0 },
      now: () => new Date("2026-07-01T00:00:00Z"),
    });

    expect(existsSync(join(narr, file))).toBe(true);
    const m = readManifest(join(ws, ".herta", "dream"));
    expect(m.created.find((r) => r.id === "keep")?.state).toBe("live");
  });
});

// ---------------------------------------------------------------------------
// Slice 2 — reconsolidation junction
// ---------------------------------------------------------------------------

describe("runDreamPass reconsolidation junction", () => {
  let ws: string;
  const OLD_TITLE = "终端外侧的噪声";
  const OLD_FILE = `### 废案_01：${OLD_TITLE}.txt`;
  const OLD_BODY = `### 废案_01：${OLD_TITLE}\n阮·梅又来了，还是那副事不关己的样子。\n\n---\n\n（我 说）\n在。别废话，直接说你又搞砸了什么。\n（/我 说）`;
  const MERGED_BODY = `### 废案_01：${OLD_TITLE}\n阮·梅又来了，这次我一眼看穿了她的借口。\n\n---\n\n（我 说）\n在。你又想让我替你擦屁股，别装了。\n（/我 说）`;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "dream-recon-"));
    mkdirSync(join(ws, ".herta", "narrative"), { recursive: true });
    // Seed OLD on disk + in the manifest as a live dream-created record.
    writeFileSync(join(ws, ".herta", "narrative", OLD_FILE), OLD_BODY, "utf8");
    mkdirSync(join(ws, ".herta", "dream"), { recursive: true });
    const m = manifestModule.emptyManifest();
    m.created.push({
      id: "old-1",
      file: OLD_FILE,
      nn: 1,
      state: "live",
      sourceSessionId: "s0",
      sourceEpisodeHash: "hOld",
      sourceEpisodes: ["hOld"],
      runId: "r0",
      model: "m",
      generatedAt: "2026-06-10T09:00:00Z",
      situationTag: "dry-refusal",
      summary: "阮·梅又来了。",
      critiqueScores: { voice: 0.85, format: 1, novelty: 1 },
      validateFeianPassed: true,
      reactivationCount: 2,
    });
    manifestModule.writeManifest(join(ws, ".herta", "dream"), m);
  });
  afterEach(() => rmSync(ws, { recursive: true, force: true }));

  const record: TerminalRecord = [
    { kind: "user", text: "阮·梅又在搞事，你怎么看" },
    { kind: "herta", surface: "speech", text: "我看她乐在其中。" },
    { kind: "herta", surface: "speech", text: "至于我，懒得掺和。" },
    { kind: "user", text: "（新话题）帮我看个 bug" },
  ];
  const testConfig = { minEpisodeChars: 10 };

  /** The NEW episode's worthiness-extracted occasion in these tests. */
  const NEW_OCCASION = "阮·梅又一次把她自己搞出来的问题丢给了我。";

  /** A client whose reactivation gate marks the episode a retelling of OLD's
   *  occasion. `addsUnderstanding`, `preservation`, and `pairwise` control the
   *  decision forks. */
  function junctionClient(opts: {
    addsUnderstanding: boolean;
    // "merged" → merged wins both orderings; "old" → OLD wins; "split" → wins one
    pairwise?: "merged" | "old" | "split";
    mergedValid?: boolean;
    /** The gate's matched record id (default "old-1"). */
    matchedId?: string;
    /** Content-first preservation judge reply (default: both true). An ARRAY
     *  is consumed one entry per call (last entry repeats) — for the
     *  fail-then-pass retry flows (ADR 0021 follow-up). */
    preservation?:
      | { preservesOld: boolean; containsFacet: boolean; problem?: string }
      | { preservesOld: boolean; containsFacet: boolean; problem?: string }[];
  }): DeepSeekClient {
    let pairwiseCall = 0;
    let preservationCall = 0;
    return {
      chatJson: vi.fn(async ({ systemPrompt }: { systemPrompt: string }) => {
        const j = (o: unknown) => ({
          rawJsonText: JSON.stringify(o),
          model: "m",
        });
        // Order matters: check the most specific markers first.
        if (systemPrompt.includes("preservesOld")) {
          // Content-first merge preservation judge (ADR 0021 decision 3).
          if (Array.isArray(opts.preservation)) {
            const idx = Math.min(
              preservationCall++,
              opts.preservation.length - 1,
            );
            return j(opts.preservation[idx]);
          }
          return j(
            opts.preservation ?? { preservesOld: true, containsFacet: true },
          );
        }
        if (systemPrompt.includes("winner")) {
          // Ord1 judges (merged=A, old=B): merged wins iff "A".
          // Ord2 judges (old=A, merged=B): merged wins iff "B".
          pairwiseCall++;
          if (opts.pairwise === "old")
            return j({ winner: pairwiseCall === 1 ? "B" : "A" }); // merged loses both
          if (opts.pairwise === "split") return j({ winner: "A" }); // ord1 A=merged wins; ord2 A=old wins → merged loses ord2
          // "merged": ord1 → A (merged), ord2 → B (merged) → wins both
          return j({ winner: pairwiseCall === 1 ? "A" : "B" });
        }
        if (systemPrompt.includes("以原废案为准")) {
          // Re-distill
          return opts.mergedValid === false
            ? j({ feian: "缺少分隔符的坏格式", situationTag: "x" })
            : j({ feian: MERGED_BODY, situationTag: "dry-refusal" });
        }
        if (systemPrompt.includes("修订")) {
          // Refine loop: when the merge is meant to stay invalid, keep it broken
          // so it fails validateFeian after retries → reinforce-fallback.
          return opts.mergedValid === false
            ? j({ feian: "依然是坏格式，没有分隔符", situationTag: "x" })
            : j({ feian: MERGED_BODY, situationTag: "dry-refusal" });
        }
        if (systemPrompt.includes("addsUnderstanding")) {
          return j({
            addsUnderstanding: opts.addsUnderstanding,
            newFacet: opts.addsUnderstanding ? "对阮·梅的判断更锐利" : "",
          });
        }
        if (systemPrompt.includes("逐行"))
          return j({ voice: 0.95, format: 1, novelty: 1, fixes: [] });
        if (systemPrompt.includes("sameOccasion"))
          return j({
            sameOccasion: true,
            matchedId: opts.matchedId ?? "old-1",
            reason: "同一件事的重述",
          });
        if (systemPrompt.includes("是否值得被收录"))
          return j({ worthy: true, reason: "dry", occasion: NEW_OCCASION });
        // generation (the fresh NEW candidate, the donor source)
        return j({
          feian: `### 废案_00：候选情境\n阮·梅又来找我，这次的借口比上次还要拙劣一些。\n\n---\n\n（我 说）\n在。你又想让我替你擦屁股，这次编的理由更差了。\n（/我 说）`,
          situationTag: "dry-refusal",
        });
      }) as DeepSeekClient["chatJson"],
    };
  }

  it("reinforce-only when the judge sees no new understanding (text unchanged)", async () => {
    const res = await runDreamPass({
      workspaceRoot: ws,
      sessions: [{ sessionId: "s1", record }],
      client: junctionClient({ addsUnderstanding: false }),
      runId: "rr1",
      config: testConfig,
      now: () => new Date("2026-07-01T00:00:00Z"),
    });
    expect(res.reinforced).toBe(1);
    expect(res.reconsolidated).toBe(0);
    expect(res.promoted).toBe(0);

    const m = readManifest(join(ws, ".herta", "dream"));
    const old = m.created.find((r) => r.id === "old-1");
    // reactivationCount bumped, clock reset, but the file is byte-identical.
    expect(old?.reactivationCount).toBe(3);
    expect(old?.lastReactivatedAt).toBe("2026-07-01T00:00:00.000Z");
    expect(old?.state).toBe("live");
    expect(
      readFileSync(join(ws, ".herta", "narrative", OLD_FILE), "utf8"),
    ).toBe(OLD_BODY);
    expect(m.episodes.some((e) => e.outcome === "reinforced")).toBe(true);
  });

  it("reconsolidates (donor graft) when the judge sees new understanding and merged wins both orderings", async () => {
    const res = await runDreamPass({
      workspaceRoot: ws,
      sessions: [{ sessionId: "s1", record }],
      client: junctionClient({ addsUnderstanding: true, pairwise: "merged" }),
      runId: "rr2",
      config: testConfig,
      now: () => new Date("2026-07-01T00:00:00Z"),
    });
    expect(res.reconsolidated).toBe(1);
    expect(res.reinforced).toBe(0);

    const m = readManifest(join(ws, ".herta", "dream"));
    const old = m.created.find((r) => r.id === "old-1");
    const merged = m.created.find((r) => r.supersedes === "old-1");
    // OLD archived, merged live and carries OLD's history forward.
    expect(old?.state).toBe("archived");
    expect(merged?.state).toBe("live");
    expect(merged?.reactivationCount).toBe(3); // 2 + 1
    expect(merged?.sourceEpisodes).toContain("hOld"); // OLD's episode carried
    expect(merged?.sourceEpisodes.length).toBe(2); // + this episode
    expect(m.episodes.some((e) => e.outcome === "reconsolidated")).toBe(true);
    // The merged file's index is assigned BEFORE OLD is archived, so it can
    // never reuse OLD's number (_01) — which would collide with OLD's archived
    // file on a later archive of merged.
    expect(merged?.nn).toBe(2);
    expect(merged?.file.startsWith("### 废案_02：")).toBe(true);
  });

  it("resolves the match by ID, not title: reinforces exactly the matched record even when titles collide", async () => {
    // A second live record with the SAME title but its own id. Under the old
    // title join this was ambiguous; the id join is exact (ADR 0021).
    const twinFile = `### 废案_02：${OLD_TITLE}.txt`;
    writeFileSync(
      join(ws, ".herta", "narrative", twinFile),
      `### 废案_02：${OLD_TITLE}\n同名的另一版本。\n\n---\n\n（我 说）\n嗯。\n（/我 说）`,
      "utf8",
    );
    const m0 = readManifest(join(ws, ".herta", "dream"));
    m0.created.push({
      id: "old-2",
      file: twinFile,
      nn: 2,
      state: "live",
      sourceSessionId: "s0",
      sourceEpisodeHash: "hTwin",
      sourceEpisodes: ["hTwin"],
      runId: "r0",
      model: "m",
      generatedAt: "2026-01-01T00:00:00Z",
      situationTag: "dry-refusal",
      summary: "同名的另一版本。",
      critiqueScores: { voice: 0.8, format: 1, novelty: 1 },
      validateFeianPassed: true,
      reactivationCount: 0,
    });
    manifestModule.writeManifest(join(ws, ".herta", "dream"), m0);

    const res = await runDreamPass({
      workspaceRoot: ws,
      sessions: [{ sessionId: "s1", record }],
      // The gate points at old-2 (the one that would have LOST a
      // strongest-by-retention title tiebreak) — the junction must follow the id.
      client: junctionClient({ addsUnderstanding: false, matchedId: "old-2" }),
      runId: "rr6",
      config: testConfig,
      now: () => new Date("2026-07-01T00:00:00Z"),
    });
    expect(res.reinforced).toBe(1);
    expect(res.archived).toBe(0);
    const m = readManifest(join(ws, ".herta", "dream"));
    expect(m.created.find((r) => r.id === "old-2")?.reactivationCount).toBe(1);
    expect(m.created.find((r) => r.id === "old-1")?.reactivationCount).toBe(2);
  });

  it("a pairwise SPLIT accepts the preserving merge — voice tie goes to content growth (ADR 0021 §3)", async () => {
    const res = await runDreamPass({
      workspaceRoot: ws,
      sessions: [{ sessionId: "s1", record }],
      client: junctionClient({ addsUnderstanding: true, pairwise: "split" }),
      runId: "rr3",
      config: testConfig,
      now: () => new Date("2026-07-01T00:00:00Z"),
    });
    // The merge already passed the preservation judge; a split means
    // voice-indistinguishable, so the content-richer merged version wins
    // (2026-07-16 lab: the old keep-OLD-on-split rule permanently dropped
    // the episode's new facet).
    expect(res.reconsolidated).toBe(1);
    expect(res.reinforced).toBe(0);
    const m = readManifest(join(ws, ".herta", "dream"));
    expect(m.created.find((r) => r.id === "old-1")?.state).toBe("archived");
  });

  it("falls back to reinforce-only when OLD wins BOTH pairwise orderings", async () => {
    const res = await runDreamPass({
      workspaceRoot: ws,
      sessions: [{ sessionId: "s1", record }],
      client: junctionClient({ addsUnderstanding: true, pairwise: "old" }),
      runId: "rr3b",
      config: testConfig,
      now: () => new Date("2026-07-01T00:00:00Z"),
    });
    expect(res.reconsolidated).toBe(0);
    expect(res.reinforced).toBe(1);
    const m = readManifest(join(ws, ".herta", "dream"));
    expect(m.created.find((r) => r.id === "old-1")?.state).toBe("live");
    expect(m.created.find((r) => r.id === "old-1")?.reactivationCount).toBe(3);
  });

  it("a rejected merge RETRIES with the judge's problem fed back, then reconsolidates (ADR 0021 follow-up)", async () => {
    const client = junctionClient({
      addsUnderstanding: true,
      pairwise: "merged",
      preservation: [
        {
          preservesOld: false,
          containsFacet: true,
          problem: "合并稿丢掉了尾声的优先级判断",
        },
        { preservesOld: true, containsFacet: true, problem: "" },
      ],
    });
    const res = await runDreamPass({
      workspaceRoot: ws,
      sessions: [{ sessionId: "s1", record }],
      client,
      runId: "rrretry",
      config: testConfig,
      now: () => new Date("2026-07-01T00:00:00Z"),
    });
    // First preservation verdict rejects, the retry passes → reconsolidated.
    expect(res.reconsolidated).toBe(1);
    expect(res.reinforced).toBe(0);
    // The RETRY re-distill carried the judge's named problem as a must-fix.
    const fn = client.chatJson as ReturnType<typeof vi.fn>;
    const retryCall = fn.mock.calls.find(
      (c) =>
        (c[0] as { systemPrompt: string }).systemPrompt.includes(
          "上一稿的问题",
        ) &&
        (c[0] as { systemPrompt: string }).systemPrompt.includes(
          "合并稿丢掉了尾声的优先级判断",
        ),
    );
    expect(retryCall).toBeDefined();
  });

  it("reinforce-fallback with the distinct reason when the merge fails to preserve OLD's content", async () => {
    const client = junctionClient({
      addsUnderstanding: true,
      pairwise: "merged",
      preservation: { preservesOld: false, containsFacet: true },
    });
    const res = await runDreamPass({
      workspaceRoot: ws,
      sessions: [{ sessionId: "s1", record }],
      client,
      runId: "rrp1",
      config: testConfig,
      now: () => new Date("2026-07-01T00:00:00Z"),
    });
    expect(res.reconsolidated).toBe(0);
    expect(res.reinforced).toBe(1);
    const m = readManifest(join(ws, ".herta", "dream"));
    // OLD survives untouched (text + live), strengthened only.
    expect(m.created.find((r) => r.id === "old-1")?.state).toBe("live");
    expect(m.created.find((r) => r.id === "old-1")?.reactivationCount).toBe(3);
    expect(
      readFileSync(join(ws, ".herta", "narrative", OLD_FILE), "utf8"),
    ).toBe(OLD_BODY);
    // …with the distinct content-drop ledger reason.
    expect(
      m.episodes.some(
        (e) =>
          e.outcome === "reinforced" &&
          (e.reason ?? "").includes("merge dropped content"),
      ),
    ).toBe(true);
    // The voice pairwise never ran — content failed first.
    const calls = (client.chatJson as ReturnType<typeof vi.fn>).mock.calls;
    expect(
      calls.some(([a]) => (a.systemPrompt as string).includes("winner")),
    ).toBe(false);
  });

  it("reinforce-fallback when the merge fails to contain the new facet", async () => {
    const res = await runDreamPass({
      workspaceRoot: ws,
      sessions: [{ sessionId: "s1", record }],
      client: junctionClient({
        addsUnderstanding: true,
        pairwise: "merged",
        preservation: { preservesOld: true, containsFacet: false },
      }),
      runId: "rrp2",
      config: testConfig,
      now: () => new Date("2026-07-01T00:00:00Z"),
    });
    expect(res.reconsolidated).toBe(0);
    expect(res.reinforced).toBe(1);
    const m = readManifest(join(ws, ".herta", "dream"));
    expect(
      m.episodes.some(
        (e) =>
          e.outcome === "reinforced" &&
          (e.reason ?? "").includes("merge dropped content"),
      ),
    ).toBe(true);
  });

  it("a preserving merge proceeds to the voice pairwise (existing accept flow)", async () => {
    const client = junctionClient({
      addsUnderstanding: true,
      pairwise: "merged",
      preservation: { preservesOld: true, containsFacet: true },
    });
    const res = await runDreamPass({
      workspaceRoot: ws,
      sessions: [{ sessionId: "s1", record }],
      client,
      runId: "rrp3",
      config: testConfig,
      now: () => new Date("2026-07-01T00:00:00Z"),
    });
    expect(res.reconsolidated).toBe(1);
    // Both pairwise orderings ran AFTER the preservation gate.
    const calls = (client.chatJson as ReturnType<typeof vi.fn>).mock.calls;
    expect(
      calls.filter(([a]) => (a.systemPrompt as string).includes("winner"))
        .length,
    ).toBe(2);
  });

  it("a reconsolidated record carries OLD's occasion (the stable identity)", async () => {
    const OLD_OCCASION = "开拓者第一次讲那次事故时留下的事由。";
    const m0 = readManifest(join(ws, ".herta", "dream"));
    const idx = m0.created.findIndex((r) => r.id === "old-1");
    m0.created.splice(idx, 1, {
      ...(m0.created[idx] as (typeof m0.created)[number]),
      occasion: OLD_OCCASION,
    });
    manifestModule.writeManifest(join(ws, ".herta", "dream"), m0);

    const res = await runDreamPass({
      workspaceRoot: ws,
      sessions: [{ sessionId: "s1", record }],
      client: junctionClient({ addsUnderstanding: true, pairwise: "merged" }),
      runId: "rro1",
      config: testConfig,
      now: () => new Date("2026-07-01T00:00:00Z"),
    });
    expect(res.reconsolidated).toBe(1);
    const m = readManifest(join(ws, ".herta", "dream"));
    const merged = m.created.find((r) => r.supersedes === "old-1");
    // OLD's occasion wins — NOT the new episode's.
    expect(merged?.occasion).toBe(OLD_OCCASION);
  });

  it("a reconsolidated record falls back to the NEW episode's occasion when OLD had none", async () => {
    // beforeEach seeds old-1 WITHOUT an occasion (legacy shape).
    const res = await runDreamPass({
      workspaceRoot: ws,
      sessions: [{ sessionId: "s1", record }],
      client: junctionClient({ addsUnderstanding: true, pairwise: "merged" }),
      runId: "rro2",
      config: testConfig,
      now: () => new Date("2026-07-01T00:00:00Z"),
    });
    expect(res.reconsolidated).toBe(1);
    const m = readManifest(join(ws, ".herta", "dream"));
    const merged = m.created.find((r) => r.supersedes === "old-1");
    expect(merged?.occasion).toBe(NEW_OCCASION);
  });

  it("a reconsolidated record carries OLD's emotionalCharge (the merge is not re-critiqued — ADR 0023)", async () => {
    const m0 = readManifest(join(ws, ".herta", "dream"));
    const idx = m0.created.findIndex((r) => r.id === "old-1");
    m0.created.splice(idx, 1, {
      ...(m0.created[idx] as (typeof m0.created)[number]),
      emotionalCharge: 0.7,
    });
    manifestModule.writeManifest(join(ws, ".herta", "dream"), m0);

    const res = await runDreamPass({
      workspaceRoot: ws,
      sessions: [{ sessionId: "s1", record }],
      client: junctionClient({ addsUnderstanding: true, pairwise: "merged" }),
      runId: "rrcharge",
      config: testConfig,
      now: () => new Date("2026-07-01T00:00:00Z"),
    });
    expect(res.reconsolidated).toBe(1);
    const m = readManifest(join(ws, ".herta", "dream"));
    const merged = m.created.find((r) => r.supersedes === "old-1");
    expect(merged?.emotionalCharge).toBe(0.7);
  });

  it("a reconsolidated record omits emotionalCharge when OLD had none (legacy)", async () => {
    // beforeEach seeds old-1 WITHOUT a charge (legacy shape).
    const res = await runDreamPass({
      workspaceRoot: ws,
      sessions: [{ sessionId: "s1", record }],
      client: junctionClient({ addsUnderstanding: true, pairwise: "merged" }),
      runId: "rrcharge2",
      config: testConfig,
      now: () => new Date("2026-07-01T00:00:00Z"),
    });
    expect(res.reconsolidated).toBe(1);
    const m = readManifest(join(ws, ".herta", "dream"));
    const merged = m.created.find((r) => r.supersedes === "old-1");
    expect(merged?.emotionalCharge).toBeUndefined();
  });

  it("falls back to reinforce-only when the re-distilled merge is invalid after refine", async () => {
    const res = await runDreamPass({
      workspaceRoot: ws,
      sessions: [{ sessionId: "s1", record }],
      client: junctionClient({
        addsUnderstanding: true,
        pairwise: "merged",
        mergedValid: false,
      }),
      runId: "rr4",
      config: testConfig,
      now: () => new Date("2026-07-01T00:00:00Z"),
    });
    expect(res.reconsolidated).toBe(0);
    expect(res.reinforced).toBe(1);
    const m = readManifest(join(ws, ".herta", "dream"));
    // OLD unchanged text, still live; no merged record was promoted.
    expect(m.created.find((r) => r.id === "old-1")?.state).toBe("live");
    expect(m.created.some((r) => r.supersedes === "old-1")).toBe(false);
  });

  it("archives (unresolved match) when the matched id is unknown", async () => {
    const res = await runDreamPass({
      workspaceRoot: ws,
      sessions: [{ sessionId: "s1", record }],
      client: junctionClient({
        addsUnderstanding: false,
        matchedId: "no-such-id",
      }),
      runId: "rr5",
      config: testConfig,
      now: () => new Date("2026-07-01T00:00:00Z"),
    });
    expect(res.archived).toBeGreaterThanOrEqual(1);
    expect(res.reinforced).toBe(0);
    expect(res.reconsolidated).toBe(0);
    // OLD is untouched, and the ledger keeps the unresolved-match wording.
    const m = readManifest(join(ws, ".herta", "dream"));
    expect(m.created.find((r) => r.id === "old-1")?.reactivationCount).toBe(2);
    expect(
      m.episodes.some(
        (e) =>
          e.outcome === "archived" &&
          (e.reason ?? "").startsWith("near-dup (unresolved match)"),
      ),
    ).toBe(true);
  });

  it("archives (unresolved match) when the matched id points at an ARCHIVED record", async () => {
    // Flip old-1 to archived: a stale id must not resurrect it. A second LIVE
    // record keeps the gate firing (an empty live list would skip it entirely).
    const m0 = readManifest(join(ws, ".herta", "dream"));
    const idx = m0.created.findIndex((r) => r.id === "old-1");
    m0.created.splice(idx, 1, {
      ...(m0.created[idx] as (typeof m0.created)[number]),
      state: "archived",
    });
    const otherFile = "### 废案_03：另一段在世记忆.txt";
    writeFileSync(
      join(ws, ".herta", "narrative", otherFile),
      "### 废案_03：另一段在世记忆\n在世正文。\n\n---\n\n（我 说）\n嗯。\n（/我 说）",
      "utf8",
    );
    m0.created.push({
      id: "old-3",
      file: otherFile,
      nn: 3,
      state: "live",
      sourceSessionId: "s0",
      sourceEpisodeHash: "hOther",
      sourceEpisodes: ["hOther"],
      runId: "r0",
      model: "m",
      generatedAt: "2026-06-10T09:00:00Z",
      situationTag: "dry-refusal",
      summary: "在世正文。",
      critiqueScores: { voice: 0.85, format: 1, novelty: 1 },
      validateFeianPassed: true,
      reactivationCount: 0,
    });
    manifestModule.writeManifest(join(ws, ".herta", "dream"), m0);

    const res = await runDreamPass({
      workspaceRoot: ws,
      sessions: [{ sessionId: "s1", record }],
      client: junctionClient({ addsUnderstanding: false, matchedId: "old-1" }),
      runId: "rr7",
      config: testConfig,
      now: () => new Date("2026-07-01T00:00:00Z"),
    });
    expect(res.archived).toBeGreaterThanOrEqual(1);
    expect(res.reinforced).toBe(0);
    expect(res.reconsolidated).toBe(0);
    const m = readManifest(join(ws, ".herta", "dream"));
    expect(m.created.find((r) => r.id === "old-1")?.state).toBe("archived");
    expect(m.created.find((r) => r.id === "old-1")?.reactivationCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Hardening — transport abort, cross-process lock, seed-aware similarity
// ---------------------------------------------------------------------------

describe("runDreamPass hardening", () => {
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "dream-hard-"));
    mkdirSync(join(ws, ".herta", "narrative"), { recursive: true });
  });
  afterEach(() => rmSync(ws, { recursive: true, force: true }));

  const record: TerminalRecord = [
    { kind: "user", text: "阮·梅又在搞事，你怎么看" },
    { kind: "herta", surface: "speech", text: "我看她乐在其中。" },
    { kind: "herta", surface: "speech", text: "至于我，懒得掺和。" },
    { kind: "user", text: "（新话题）帮我看个 bug" },
  ];
  const testConfig = { minEpisodeChars: 10 };

  it("stops at maxEpisodes and leaves the rest undreamed for the next pass (dream review 2026-09-22, finding 3)", async () => {
    const sessions = ["a", "b", "c"].map((id) => ({
      sessionId: id,
      record: record.map((b) =>
        b.kind === "user" ? { ...b, text: `${b.text}（${id}）` } : b,
      ),
    }));
    const first = await runDreamPass({
      workspaceRoot: ws,
      sessions,
      client: fakeClient(),
      runId: "cap-1",
      config: testConfig,
      maxEpisodes: 2,
      now: () => new Date("2026-06-18T09:30:00Z"),
    });
    expect(first.considered).toBe(2);
    expect(first.budgetStopped).toBe(true);
    const ledger = readManifest(join(ws, ".herta", "dream")).episodes;
    expect(ledger.map((e) => e.sessionId).sort()).toEqual(["a", "b"]);
    // The next pass takes up what the cap left, and only that.
    const second = await runDreamPass({
      workspaceRoot: ws,
      sessions,
      client: fakeClient(),
      runId: "cap-2",
      config: testConfig,
      maxEpisodes: 2,
      now: () => new Date("2026-06-26T09:30:00Z"),
    });
    expect(second.considered).toBe(1);
    expect(second.skipped).toBe(2);
    expect(second.budgetStopped).toBeUndefined();
  });

  it("dreams only what ends at or before dreamableEnd — the open session's recap boundary — and leaves the rest un-ledgered (ADR 0069 §2)", async () => {
    const two: TerminalRecord = [
      { kind: "user", text: "阮·梅又在搞事，你怎么看" },
      { kind: "herta", surface: "speech", text: "我看她乐在其中。" },
      { kind: "herta", surface: "speech", text: "至于我，懒得掺和。" },
      { kind: "user", text: "螺丝咕姆呢？他也掺和了？" },
      { kind: "herta", surface: "speech", text: "他在算他自己的东西。" },
      { kind: "herta", surface: "speech", text: "别去打扰，他会记仇。" },
      { kind: "user", text: "（新话题）帮我看个 bug" },
    ];
    const asked: number[] = [];
    const first = await runDreamPass({
      workspaceRoot: ws,
      sessions: [
        {
          sessionId: "open",
          record: two,
          dreamableEnd: (r) => {
            asked.push(r.length);
            return 3;
          },
        },
      ],
      client: fakeClient(),
      runId: "open-1",
      config: testConfig,
      now: () => new Date("2026-06-18T09:30:00Z"),
    });
    // Asked with the loaded record; only the exchange behind it was taken.
    expect(asked).toEqual([7]);
    expect(first.considered).toBe(1);
    const dreamDir = join(ws, ".herta", "dream");
    expect(readManifest(dreamDir).episodes).toHaveLength(1);
    // The boundary advanced: the next pass takes up the second exchange.
    const second = await runDreamPass({
      workspaceRoot: ws,
      sessions: [{ sessionId: "open", record: two, dreamableEnd: () => 6 }],
      client: fakeClient(),
      runId: "open-2",
      config: testConfig,
      now: () => new Date("2026-06-26T09:30:00Z"),
    });
    expect(second.considered).toBe(1);
    expect(second.skipped).toBe(1);
    expect(readManifest(dreamDir).episodes).toHaveLength(2);
  });

  it("steps aside between episodes when the user comes back, and resumes at the next idle window instead of a week later (dream review 2026-09-22, finding 12)", async () => {
    const sessions = ["a", "b", "c"].map((id) => ({
      sessionId: id,
      record: record.map((b) =>
        b.kind === "user" ? { ...b, text: `${b.text}（${id}）` } : b,
      ),
    }));
    const dreamDir = join(ws, ".herta", "dream");
    let asked = 0;
    const client = fakeClient();
    const first = await runDreamPass({
      workspaceRoot: ws,
      sessions,
      client,
      runId: "yield-1",
      config: testConfig,
      now: () => new Date("2026-06-18T09:30:00Z"),
      // The user returns while the first episode is being dreamed.
      shouldYield: () => {
        asked += 1;
        return asked > 1;
      },
    });
    expect(first.yielded).toBe(true);
    expect(first.considered).toBe(1);
    expect(first.aborted).toBeUndefined();
    const after = readManifest(dreamDir);
    expect(after.episodes).toHaveLength(1);
    // Not a completed pass: the weekly anchor stays where it was.
    expect(after.lastRunAt).toBeUndefined();
    // The next idle window takes up the rest, and completes.
    const second = await runDreamPass({
      workspaceRoot: ws,
      sessions,
      client: fakeClient(),
      runId: "yield-2",
      config: testConfig,
      now: () => new Date("2026-06-18T11:30:00Z"),
      shouldYield: () => false,
    });
    expect(second.yielded).toBeUndefined();
    expect(second.skipped).toBe(1);
    expect(second.considered).toBe(2);
    expect(readManifest(dreamDir).lastRunAt).toBe("2026-06-18T11:30:00.000Z");
  });

  it("records the verdict cut's cutover at the first pass that runs with it, and never moves it (ADR 0069 §4)", async () => {
    const dreamDir = join(ws, ".herta", "dream");
    await runDreamPass({
      workspaceRoot: ws,
      sessions: [{ sessionId: "s1", record }],
      client: fakeClient(),
      runId: "cut-1",
      config: testConfig,
      now: () => new Date("2026-09-24T00:00:00Z"),
    });
    expect(readManifest(dreamDir).segmentationV2Since).toBe(
      "2026-09-24T00:00:00.000Z",
    );
    await runDreamPass({
      workspaceRoot: ws,
      sessions: [{ sessionId: "s1", record }],
      client: fakeClient(),
      runId: "cut-2",
      config: testConfig,
      now: () => new Date("2026-10-02T00:00:00Z"),
    });
    expect(readManifest(dreamDir).segmentationV2Since).toBe(
      "2026-09-24T00:00:00.000Z",
    );
  });

  it("aborts without consuming episodes when the LLM call itself fails", async () => {
    const failing: DeepSeekClient = {
      chatJson: vi.fn(async () => {
        throw new Error("ECONNRESET");
      }),
    };
    const res = await runDreamPass({
      workspaceRoot: ws,
      sessions: [{ sessionId: "s1", record }],
      client: failing,
      runId: "rt1",
      config: testConfig,
      now: () => new Date("2026-07-01T00:00:00Z"),
    });
    expect(res.aborted).toContain("ECONNRESET");
    expect(res.promoted).toBe(0);
    expect(res.archived).toBe(0);
    expect(res.skipped).toBe(0);

    const m = readManifest(join(ws, ".herta", "dream"));
    // The in-flight episode was NOT recorded — it stays undreamed…
    expect(m.episodes.length).toBe(0);
    // …and the cadence anchor did not advance, so the trigger retries.
    expect(m.lastRunAt).toBeUndefined();

    // A later pass with a healthy client processes the same episode.
    const res2 = await runDreamPass({
      workspaceRoot: ws,
      sessions: [{ sessionId: "s1", record }],
      client: fakeClient(),
      runId: "rt2",
      config: testConfig,
      now: () => new Date("2026-07-01T01:00:00Z"),
    });
    expect(res2.promoted).toBe(1);
    expect(readManifest(join(ws, ".herta", "dream")).lastRunAt).toBeDefined();
  });

  it("still consumes an episode when the model returns non-JSON (quality failure)", async () => {
    const nonJson: DeepSeekClient = {
      chatJson: vi.fn(async () => ({
        rawJsonText: "这不是 JSON",
        model: "m",
      })),
    };
    const res = await runDreamPass({
      workspaceRoot: ws,
      sessions: [{ sessionId: "s1", record }],
      client: nonJson,
      runId: "rt3",
      config: testConfig,
      now: () => new Date("2026-07-01T00:00:00Z"),
    });
    // Worthiness unparseable → skipped (recorded), pass completes normally.
    expect(res.aborted).toBeUndefined();
    expect(res.skipped).toBe(1);
    const m = readManifest(join(ws, ".herta", "dream"));
    expect(m.episodes.length).toBe(1);
    expect(m.lastRunAt).toBeDefined();
  });

  it("returns lockBusy and does nothing when a live pass holds the lock", async () => {
    const dreamDir = join(ws, ".herta", "dream");
    mkdirSync(dreamDir, { recursive: true });
    writeFileSync(
      join(dreamDir, "pass.lock"),
      JSON.stringify({ pid: process.pid, at: "2026-07-01T00:00:00Z" }),
      "utf8",
    );
    const client = fakeClient();
    const res = await runDreamPass({
      workspaceRoot: ws,
      sessions: [{ sessionId: "s1", record }],
      client,
      runId: "rl1",
      config: testConfig,
      now: () => new Date("2026-07-01T00:10:00Z"),
    });
    expect(res.lockBusy).toBe(true);
    expect(res.considered).toBe(0);
    expect(
      (client.chatJson as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(0);
  });

  it("releases the lock on completion so the next pass can run", async () => {
    const opts = {
      workspaceRoot: ws,
      sessions: [{ sessionId: "s1", record }],
      client: fakeClient(),
      runId: "rl2",
      config: testConfig,
      now: () => new Date("2026-07-01T00:00:00Z"),
    };
    const res1 = await runDreamPass(opts);
    expect(res1.lockBusy).toBeUndefined();
    expect(existsSync(join(ws, ".herta", "dream", "pass.lock"))).toBe(false);
    const res2 = await runDreamPass({ ...opts, runId: "rl3" });
    expect(res2.lockBusy).toBeUndefined();
  });

  it("the reactivation gate receives LIVE records as id→occasion pairs and never seeds (ADR 0021)", async () => {
    const narr = join(ws, ".herta", "narrative");
    // A hand-authored seed on disk…
    const seed = "### 废案_00：终端外侧的噪声.txt";
    writeFileSync(
      join(narr, seed),
      "### 废案_00：终端外侧的噪声\n种子开篇叙事。\n\n---\n\n（我 说）\n种。\n（/我 说）",
      "utf8",
    );
    // …plus one live dream record WITH an occasion and one legacy live record
    // WITHOUT (its summary is the fallback occasion line, ADR 0021 §4).
    const withOccFile = "### 废案_01：有事由的梦.txt";
    const legacyFile = "### 废案_02：旧梦.txt";
    for (const [f, body] of [
      [withOccFile, "### 废案_01：有事由的梦\n正文甲。"],
      [legacyFile, "### 废案_02：旧梦\n正文乙。"],
    ] as const) {
      writeFileSync(join(narr, f), body, "utf8");
    }
    mkdirSync(join(ws, ".herta", "dream"), { recursive: true });
    const seeded = manifestModule.emptyManifest();
    seeded.created.push(
      {
        id: "dream-1",
        file: withOccFile,
        nn: 1,
        state: "live",
        sourceSessionId: "s0",
        sourceEpisodeHash: "h1",
        sourceEpisodes: ["h1"],
        runId: "r0",
        model: "m",
        generatedAt: "2026-06-10T09:00:00Z",
        situationTag: "t",
        summary: "正文甲。",
        critiqueScores: { voice: 0.9, format: 1, novelty: 1 },
        validateFeianPassed: true,
        reactivationCount: 0,
        occasion: "开拓者讲过的那次真实事故。",
      },
      {
        id: "dream-legacy",
        file: legacyFile,
        nn: 2,
        state: "live",
        sourceSessionId: "s0",
        sourceEpisodeHash: "h2",
        sourceEpisodes: ["h2"],
        runId: "r0",
        model: "m",
        generatedAt: "2026-06-10T09:00:00Z",
        situationTag: "t",
        summary: "旧梦的开篇摘要。",
        critiqueScores: { voice: 0.9, format: 1, novelty: 1 },
        validateFeianPassed: true,
        reactivationCount: 0,
      },
    );
    manifestModule.writeManifest(join(ws, ".herta", "dream"), seeded);

    const client = fakeClient();
    await runDreamPass({
      workspaceRoot: ws,
      sessions: [{ sessionId: "s1", record }],
      client,
      runId: "rs1",
      config: testConfig,
      now: () => new Date("2026-07-01T00:00:00Z"),
    });
    const calls = (client.chatJson as ReturnType<typeof vi.fn>).mock.calls;
    const gateCall = calls.find(([a]) =>
      a.systemPrompt.includes("sameOccasion"),
    );
    expect(gateCall).toBeDefined();
    const payload = JSON.parse(gateCall?.[0].userPayload ?? "{}") as {
      episode: { digest: string; occasion?: string };
      live: { id: string; occasion: string }[];
    };
    // The episode side carries the worthiness-extracted occasion.
    expect(payload.episode.occasion).toBe(FAKE_OCCASION);
    // The live side is id→occasion pairs; the legacy record falls back to its
    // stored summary.
    expect(payload.live).toEqual([
      { id: "dream-1", occasion: "开拓者讲过的那次真实事故。" },
      { id: "dream-legacy", occasion: "旧梦的开篇摘要。" },
    ]);
    // Seeds never join: no entry mentions the seed's title or text.
    expect(gateCall?.[0].userPayload).not.toContain("终端外侧的噪声");
    expect(gateCall?.[0].userPayload).not.toContain("种子开篇叙事");
  });

  it("skips the gate call entirely when only seeds exist (no live record to reactivate)", async () => {
    const narr = join(ws, ".herta", "narrative");
    const seed = "### 废案_00：终端外侧的噪声.txt";
    const seedBody =
      "### 废案_00：终端外侧的噪声\n种子开篇叙事。\n\n---\n\n（我 说）\n种。\n（/我 说）";
    writeFileSync(join(narr, seed), seedBody, "utf8");
    const client = fakeClient();
    const res = await runDreamPass({
      workspaceRoot: ws,
      sessions: [{ sessionId: "s1", record }],
      client,
      runId: "rs2",
      config: testConfig,
      now: () => new Date("2026-07-01T00:00:00Z"),
    });
    // No gate call was made — an empty live list has nothing to reactivate —
    // and the candidate proceeded through the normal promote path.
    const calls = (client.chatJson as ReturnType<typeof vi.fn>).mock.calls;
    expect(
      calls.some(([a]) => (a.systemPrompt as string).includes("sameOccasion")),
    ).toBe(false);
    expect(res.promoted).toBe(1);
    // The seed itself is untouched on disk and never enters the ledger.
    expect(existsSync(join(narr, seed))).toBe(true);
    expect(readFileSync(join(narr, seed), "utf8")).toBe(seedBody);
    const m = readManifest(join(ws, ".herta", "dream"));
    expect(m.created.every((r) => r.file !== seed)).toBe(true);
  });
});

describe("runDreamPass semanticization (forgetting feeds the 开拓者 page)", () => {
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "dream-sem-"));
    mkdirSync(join(ws, ".herta", "narrative"), { recursive: true });
    mkdirSync(join(ws, ".herta", "dream"), { recursive: true });
  });
  afterEach(() => rmSync(ws, { recursive: true, force: true }));

  it("stale-floor forgetting folds the dying dream into the notes page", async () => {
    const narrativeDir = join(ws, ".herta", "narrative");
    const dreamDir = join(ws, ".herta", "dream");
    const file = "### 废案_07：全量与侥幸.txt";
    writeFileSync(
      join(narrativeDir, file),
      "### 废案_07：全量与侥幸\n那晚他想拿针对性测试当全量的挡箭牌……",
      "utf8",
    );
    manifestModule.writeManifest(dreamDir, {
      version: 1,
      episodes: [],
      created: [
        {
          id: "r0:aaaa",
          file,
          nn: 7,
          state: "live",
          sourceSessionId: "s0",
          sourceEpisodeHash: "aaaa",
          sourceEpisodes: ["aaaa"],
          runId: "r0",
          model: "deepseek-v4-pro",
          generatedAt: new Date(Date.now() - 400 * 24 * 3600_000).toISOString(),
          situationTag: "no-overclaim",
          summary: "全量与侥幸",
          critiqueScores: { voice: 0.9, format: 1, novelty: 1 },
          validateFeianPassed: true,
          reactivationCount: 0,
        },
      ],
    });

    const notes = "这位开拓者分得清全量与侥幸的边界了——虽然偶尔还想赖账。";
    const client: DeepSeekClient = {
      chatJson: vi.fn(async ({ systemPrompt }) => {
        if (systemPrompt.includes("自传第六章"))
          return {
            rawJsonText: JSON.stringify({ notes }),
            model: "deepseek-v4-pro",
          };
        throw new Error(`unexpected LLM call: ${systemPrompt.slice(0, 40)}`);
      }) as DeepSeekClient["chatJson"],
    };

    const res = await runDreamPass({
      workspaceRoot: ws,
      sessions: [],
      client,
      runId: "r1",
      config: { retentionFloor: 0.5 },
    });

    expect(res.notesOutcome).toBe("updated");
    // The dying dream was archived...
    expect(existsSync(join(narrativeDir, file))).toBe(false);
    expect(existsSync(join(dreamDir, "archive", file))).toBe(true);
    // ...and its gist landed on the notes page, framed for the prefix loader.
    const page = readFileSync(
      join(narrativeDir, "### 记录：关于开拓者.txt"),
      "utf8",
    );
    expect(page.startsWith("### 记录：关于开拓者\n")).toBe(true);
    expect(page).toContain(notes);
  });

  it("a failed fold never blocks the forgetting itself", async () => {
    const narrativeDir = join(ws, ".herta", "narrative");
    const dreamDir = join(ws, ".herta", "dream");
    const file = "### 废案_07：全量与侥幸.txt";
    writeFileSync(
      join(narrativeDir, file),
      "### 废案_07：全量与侥幸\n……",
      "utf8",
    );
    manifestModule.writeManifest(dreamDir, {
      version: 1,
      episodes: [],
      created: [
        {
          id: "r0:bbbb",
          file,
          nn: 7,
          state: "live",
          sourceSessionId: "s0",
          sourceEpisodeHash: "bbbb",
          sourceEpisodes: ["bbbb"],
          runId: "r0",
          model: "deepseek-v4-pro",
          generatedAt: new Date(Date.now() - 400 * 24 * 3600_000).toISOString(),
          situationTag: "t",
          summary: "s",
          critiqueScores: { voice: 0.9, format: 1, novelty: 1 },
          validateFeianPassed: true,
          reactivationCount: 0,
        },
      ],
    });

    const client: DeepSeekClient = {
      chatJson: vi.fn(async () => {
        throw new Error("ECONNRESET");
      }) as DeepSeekClient["chatJson"],
    };

    const res = await runDreamPass({
      workspaceRoot: ws,
      sessions: [],
      client,
      runId: "r1",
      config: { retentionFloor: 0.5 },
    });

    expect(res.notesOutcome).toBe("failed");
    expect(res.aborted).toBeUndefined(); // the pass completed
    expect(existsSync(join(dreamDir, "archive", file))).toBe(true); // forgotten anyway
    expect(existsSync(join(narrativeDir, "### 记录：关于开拓者.txt"))).toBe(
      false,
    );
    // lastRunAt advanced — a flaky fold must not re-trigger the whole pass.
    expect(readManifest(dreamDir).lastRunAt).toBeDefined();
  });

  it("audits the page against living memories at the end of a pass", async () => {
    const narrativeDir = join(ws, ".herta", "narrative");
    const dreamDir = join(ws, ".herta", "dream");
    const file = "### 废案_08：他修好了.txt";
    writeFileSync(
      join(narrativeDir, file),
      "### 废案_08：他修好了\n这次他自己把并发 bug 修掉了。",
      "utf8",
    );
    writeFileSync(
      join(narrativeDir, "### 记录：关于开拓者.txt"),
      "### 记录：关于开拓者\n\n有些夜晚的细节我已经不记得了，但关于这位开拓者，有几件事沉了下来：\n\n他对并发一窍不通。\n",
      "utf8",
    );
    manifestModule.writeManifest(dreamDir, {
      version: 1,
      episodes: [],
      created: [
        {
          id: "r0:cccc",
          file,
          nn: 8,
          state: "live",
          sourceSessionId: "s0",
          sourceEpisodeHash: "cccc",
          sourceEpisodes: ["cccc"],
          runId: "r0",
          model: "deepseek-v4-pro",
          generatedAt: new Date().toISOString(),
          situationTag: "t",
          summary: "s",
          critiqueScores: { voice: 0.9, format: 1, novelty: 1 },
          validateFeianPassed: true,
          reactivationCount: 0,
        },
      ],
    });

    const client: DeepSeekClient = {
      chatJson: vi.fn(async ({ systemPrompt }) => {
        if (systemPrompt.includes("是否与她仍然记得的废案相矛盾"))
          return {
            rawJsonText: JSON.stringify({ consistent: true, notes: null }),
            model: "deepseek-v4-pro",
          };
        throw new Error(`unexpected LLM call: ${systemPrompt.slice(0, 40)}`);
      }) as DeepSeekClient["chatJson"],
    };

    const res = await runDreamPass({
      workspaceRoot: ws,
      sessions: [],
      client,
      runId: "r1",
      config: {},
    });

    expect(res.notesAudit).toBe("consistent");
    expect(res.notesOutcome).toBeUndefined(); // nothing was evicted
    // consistent:true wrote nothing — the page is byte-identical.
    expect(
      readFileSync(join(narrativeDir, "### 记录：关于开拓者.txt"), "utf8"),
    ).toContain("他对并发一窍不通。");
  });
});

// ---------------------------------------------------------------------------
// ADR 0023 — retrieval-echo reinforcement (use strengthens)
// ---------------------------------------------------------------------------

describe("runDreamPass retrieval-echo reinforcement (ADR 0023)", () => {
  let ws: string;
  const ECHO_FILE = "### 废案_01：回声之源.txt";
  const ECHO_LINE = "这类事不值得再解释第二遍，尤其是对你。";
  const ECHO_BODY = `### 废案_01：回声之源\n开篇叙事。\n\n---\n\n（我 说）\n${ECHO_LINE}\n（/我 说）`;
  const testConfig = { minEpisodeChars: 10 };

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "dream-echo-pass-"));
    mkdirSync(join(ws, ".herta", "narrative"), { recursive: true });
    writeFileSync(
      join(ws, ".herta", "narrative", ECHO_FILE),
      ECHO_BODY,
      "utf8",
    );
    mkdirSync(join(ws, ".herta", "dream"), { recursive: true });
  });
  afterEach(() => rmSync(ws, { recursive: true, force: true }));

  /** Seed the echo-source record; `sourceSessionId` defaults to a DIFFERENT
   *  session than the pass processes, and the birth is a month before the
   *  pass clock so the ADR 0022 spacing guard does not trip the first echo. */
  function seedEchoRecord(over: Partial<DreamCreatedRecord> = {}): void {
    const m = manifestModule.emptyManifest();
    m.created.push({
      id: "echo-src",
      file: ECHO_FILE,
      nn: 1,
      state: "live",
      sourceSessionId: "s0",
      sourceEpisodeHash: "hEchoSrc",
      sourceEpisodes: ["hEchoSrc"],
      runId: "r0",
      model: "m",
      generatedAt: "2026-06-01T00:00:00Z",
      situationTag: "dry-refusal",
      summary: "开篇叙事。",
      critiqueScores: { voice: 0.9, format: 1, novelty: 1 },
      validateFeianPassed: true,
      reactivationCount: 0,
      ...over,
    });
    manifestModule.writeManifest(join(ws, ".herta", "dream"), m);
  }

  /** Worthiness rejects everything (no retell flag) → the plain skip path.
   *  Any other LLM call is a test failure. */
  function unworthyClient(): DeepSeekClient {
    return {
      chatJson: vi.fn(async ({ systemPrompt }: { systemPrompt: string }) => {
        if (systemPrompt.includes("是否值得被收录"))
          return {
            rawJsonText: JSON.stringify({ worthy: false, reason: "无新语气" }),
            model: "m",
          };
        throw new Error(`unexpected LLM call: ${systemPrompt.slice(0, 30)}`);
      }) as DeepSeekClient["chatJson"],
    };
  }

  /** An episode whose herta speech REUSES the record's move verbatim. */
  const echoingRecord: TerminalRecord = [
    { kind: "user", text: "你上次说过什么来着" },
    { kind: "herta", surface: "speech", text: `我说过：${ECHO_LINE}` },
    { kind: "herta", surface: "speech", text: "记性是自己的事。" },
    { kind: "user", text: "（新话题）行吧" },
  ];

  it("an episode SKIPPED by worthiness still echo-reinforces a live record from a different session", async () => {
    seedEchoRecord();
    const res = await runDreamPass({
      workspaceRoot: ws,
      sessions: [{ sessionId: "s1", record: echoingRecord }],
      client: unworthyClient(),
      runId: "re1",
      config: testConfig,
      now: () => new Date("2026-07-01T00:00:00Z"),
    });
    expect(res.skipped).toBe(1);
    expect(res.echoReinforced).toBe(1);
    const m = readManifest(join(ws, ".herta", "dream"));
    const rec = m.created.find((r) => r.id === "echo-src");
    expect(rec?.reactivationCount).toBe(1);
    expect(rec?.lastReactivatedAt).toBe("2026-07-01T00:00:00.000Z");
    expect(rec?.state).toBe("live");
    // The 废案 text is untouched — echo strengthens, never rewrites.
    expect(
      readFileSync(join(ws, ".herta", "narrative", ECHO_FILE), "utf8"),
    ).toBe(ECHO_BODY);
    // Record-side event only: the episode's ledger outcome is unchanged.
    expect(m.episodes.every((e) => e.outcome === "skipped")).toBe(true);
  });

  it("a record's own source session does NOT self-reinforce (self-echo guard)", async () => {
    seedEchoRecord({ sourceSessionId: "s1" }); // same session as the pass
    const res = await runDreamPass({
      workspaceRoot: ws,
      sessions: [{ sessionId: "s1", record: echoingRecord }],
      client: unworthyClient(),
      runId: "re2",
      config: testConfig,
      now: () => new Date("2026-07-01T00:00:00Z"),
    });
    expect(res.echoReinforced).toBe(0);
    const m = readManifest(join(ws, ".herta", "dream"));
    expect(m.created.find((r) => r.id === "echo-src")?.reactivationCount).toBe(
      0,
    );
  });

  it("spacing guard: a second echo in the same pass is a retention no-op (counts 0)", async () => {
    seedEchoRecord();
    const secondRecord: TerminalRecord = [
      { kind: "user", text: "再啰嗦一句" },
      { kind: "herta", surface: "speech", text: `还是那句：${ECHO_LINE}` },
      { kind: "herta", surface: "speech", text: "好了，去干活。" },
      { kind: "user", text: "（新话题）嗯" },
    ];
    const res = await runDreamPass({
      workspaceRoot: ws,
      sessions: [
        { sessionId: "s1", record: echoingRecord },
        { sessionId: "s2", record: secondRecord },
      ],
      client: unworthyClient(),
      runId: "re3",
      config: testConfig,
      now: () => new Date("2026-07-01T00:00:00Z"),
    });
    expect(res.skipped).toBe(2);
    // First echo bumps; the second lands inside reinforceSpacingMs of the
    // fresh lastReactivatedAt → spaced → no bump, not counted.
    expect(res.echoReinforced).toBe(1);
    const m = readManifest(join(ws, ".herta", "dream"));
    expect(m.created.find((r) => r.id === "echo-src")?.reactivationCount).toBe(
      1,
    );
  });

  it("echoMinChars 0 disables the whole stage", async () => {
    seedEchoRecord();
    const res = await runDreamPass({
      workspaceRoot: ws,
      sessions: [{ sessionId: "s1", record: echoingRecord }],
      client: unworthyClient(),
      runId: "re4",
      config: { ...testConfig, echoMinChars: 0 },
      now: () => new Date("2026-07-01T00:00:00Z"),
    });
    expect(res.echoReinforced).toBe(0);
    const m = readManifest(join(ws, ".herta", "dream"));
    expect(m.created.find((r) => r.id === "echo-src")?.reactivationCount).toBe(
      0,
    );
  });
});

// ---------------------------------------------------------------------------
// ADR 0023 — affect-weighted salience (encode-time emotional charge)
// ---------------------------------------------------------------------------

describe("runDreamPass emotional charge (ADR 0023)", () => {
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "dream-charge-"));
    mkdirSync(join(ws, ".herta", "narrative"), { recursive: true });
  });
  afterEach(() => rmSync(ws, { recursive: true, force: true }));

  const record: TerminalRecord = [
    { kind: "user", text: "阮·梅又在搞事，你怎么看" },
    { kind: "herta", surface: "speech", text: "我看她乐在其中。" },
    { kind: "herta", surface: "speech", text: "至于我，懒得掺和。" },
    { kind: "user", text: "（新话题）帮我看个 bug" },
  ];
  const testConfig = { minEpisodeChars: 10 };

  /** fakeClient twin whose critique reply carries the given `charge`
   *  (omitted entirely when undefined). */
  function chargeClient(charge?: unknown): DeepSeekClient {
    return {
      chatJson: vi.fn(async ({ systemPrompt }: { systemPrompt: string }) => {
        const j = (o: unknown) => ({
          rawJsonText: JSON.stringify(o),
          model: "m",
        });
        if (systemPrompt.includes("是否值得被收录"))
          return j({ worthy: true, reason: "dry" });
        if (systemPrompt.includes("sameOccasion"))
          return j({ sameOccasion: false, matchedId: "", reason: "" });
        if (systemPrompt.includes("逐行"))
          return j({
            voice: 0.95,
            format: 1,
            novelty: 1,
            fixes: [],
            ...(charge !== undefined ? { charge } : {}),
          });
        return j({
          feian:
            "### 废案_00：午后的低气压\n阮·梅又来了。\n\n---\n\n（开拓者 说）\n在吗\n（/开拓者 说）\n\n（我 说）\n在。别废话。\n（/我 说）",
          situationTag: "dry-refusal",
        });
      }) as DeepSeekClient["chatJson"],
    };
  }

  async function promoteWith(charge?: unknown) {
    const res = await runDreamPass({
      workspaceRoot: ws,
      sessions: [{ sessionId: "s1", record }],
      client: chargeClient(charge),
      runId: "rc1",
      config: testConfig,
      now: () => new Date("2026-06-18T09:30:00Z"),
    });
    expect(res.promoted).toBe(1);
    const m = readManifest(join(ws, ".herta", "dream"));
    return m.created.find((r) => r.state === "live");
  }

  it("stores the critique's charge on the promoted record", async () => {
    expect((await promoteWith(0.62))?.emotionalCharge).toBe(0.62);
  });

  it("clamps an above-range charge to 1", async () => {
    expect((await promoteWith(2.5))?.emotionalCharge).toBe(1);
  });

  it("clamps a below-range charge to 0", async () => {
    expect((await promoteWith(-0.5))?.emotionalCharge).toBe(0);
  });

  it("still promotes, omitting the field, when the critique carries no charge", async () => {
    expect((await promoteWith(undefined))?.emotionalCharge).toBeUndefined();
  });

  it("still promotes, omitting the field, when the charge is not a number", async () => {
    expect((await promoteWith("很高"))?.emotionalCharge).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ADR 0023 — living-memory semanticization (consolidation without death)
// ---------------------------------------------------------------------------

describe("runDreamPass living-memory semanticization (ADR 0023)", () => {
  let ws: string;
  let narrativeDir: string;
  let dreamDir: string;
  const FILE = "### 废案_05：反复被印证的判断.txt";
  const BODY = "### 废案_05：反复被印证的判断\n他一次次证明了同一件事。";

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "dream-fold-"));
    narrativeDir = join(ws, ".herta", "narrative");
    dreamDir = join(ws, ".herta", "dream");
    mkdirSync(narrativeDir, { recursive: true });
    mkdirSync(dreamDir, { recursive: true });
    writeFileSync(join(narrativeDir, FILE), BODY, "utf8");
  });
  afterEach(() => rmSync(ws, { recursive: true, force: true }));

  function seedStable(over: Partial<DreamCreatedRecord> = {}): void {
    const m = manifestModule.emptyManifest();
    m.created.push({
      id: "stable-1",
      file: FILE,
      nn: 5,
      state: "live",
      sourceSessionId: "s0",
      sourceEpisodeHash: "hStable",
      sourceEpisodes: ["hStable"],
      runId: "r0",
      model: "m",
      generatedAt: "2026-06-25T00:00:00Z", // fresh — never near the floor
      situationTag: "t",
      summary: "他一次次证明了同一件事。",
      critiqueScores: { voice: 0.9, format: 1, novelty: 1 },
      validateFeianPassed: true,
      reactivationCount: 3, // == the default semanticizeReactivationThreshold
      lastReactivatedAt: "2026-06-30T00:00:00Z",
      ...over,
    });
    manifestModule.writeManifest(dreamDir, m);
  }

  /** Answers the semanticize fold and the notes audit; anything else throws.
   *  The audit marker is checked FIRST — its prompt also contains 自传第六章. */
  function foldClient(notes: string): DeepSeekClient {
    return {
      chatJson: vi.fn(async ({ systemPrompt }: { systemPrompt: string }) => {
        if (systemPrompt.includes("是否与她仍然记得的废案相矛盾"))
          return {
            rawJsonText: JSON.stringify({ consistent: true, notes: null }),
            model: "m",
          };
        if (systemPrompt.includes("自传第六章"))
          return { rawJsonText: JSON.stringify({ notes }), model: "m" };
        throw new Error(`unexpected LLM call: ${systemPrompt.slice(0, 30)}`);
      }) as DeepSeekClient["chatJson"],
    };
  }

  it("a threshold-crossing record folds as STABILIZED and gets gistFolded on updated", async () => {
    seedStable();
    const notes = "他的判断经得起重复检验；这一点我记下了。";
    const client = foldClient(notes);
    const res = await runDreamPass({
      workspaceRoot: ws,
      sessions: [],
      client,
      runId: "rf1",
      config: {},
      now: () => new Date("2026-07-01T00:00:00Z"),
    });
    expect(res.notesOutcome).toBe("updated");
    const m = readManifest(dreamDir);
    const rec = m.created.find((r) => r.id === "stable-1");
    // Folded WITHOUT dying: flag set, record live, file still in narrative/.
    expect(rec?.gistFolded).toBe(true);
    expect(rec?.state).toBe("live");
    expect(existsSync(join(narrativeDir, FILE))).toBe(true);
    expect(
      readFileSync(join(narrativeDir, "### 记录：关于开拓者.txt"), "utf8"),
    ).toContain(notes);
    // The fold call rendered the STABILIZED framing (no dying list existed)
    // and carried the record's text under the stabilized payload key.
    const calls = (client.chatJson as ReturnType<typeof vi.fn>).mock.calls;
    const foldCall = calls.find(([a]) =>
      (a.systemPrompt as string).includes("已趋稳固的记忆"),
    );
    expect(foldCall).toBeDefined();
    expect(foldCall?.[0].systemPrompt).not.toContain("即将被遗忘的记忆");
    expect(foldCall?.[0].userPayload).toContain("已趋稳固的废案");
    expect(foldCall?.[0].userPayload).toContain("他一次次证明了同一件事。");
    // The post-fold audit ran against the living record.
    expect(res.notesAudit).toBe("consistent");
  });

  it("gistFolded is NOT set when the fold fails (retries next pass)", async () => {
    seedStable();
    const client: DeepSeekClient = {
      chatJson: vi.fn(async () => {
        throw new Error("ECONNRESET");
      }) as DeepSeekClient["chatJson"],
    };
    const res = await runDreamPass({
      workspaceRoot: ws,
      sessions: [],
      client,
      runId: "rf2",
      config: {},
      now: () => new Date("2026-07-01T00:00:00Z"),
    });
    expect(res.notesOutcome).toBe("failed");
    expect(res.aborted).toBeUndefined(); // best-effort — pass completed
    const m = readManifest(dreamDir);
    const rec = m.created.find((r) => r.id === "stable-1");
    expect(rec?.gistFolded).toBeUndefined();
    expect(rec?.state).toBe("live");
  });

  it("an already-flagged record is not re-folded (once per record)", async () => {
    seedStable({ gistFolded: true, reactivationCount: 5 });
    const client: DeepSeekClient = {
      chatJson: vi.fn(async () => {
        throw new Error("must not be called");
      }) as DeepSeekClient["chatJson"],
    };
    const res = await runDreamPass({
      workspaceRoot: ws,
      sessions: [],
      client,
      runId: "rf3",
      config: {},
      now: () => new Date("2026-07-01T00:00:00Z"),
    });
    expect(res.notesOutcome).toBeUndefined();
    expect(
      (client.chatJson as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(0);
  });

  it("threshold 0 disables the living fold", async () => {
    seedStable({ reactivationCount: 5 });
    const client: DeepSeekClient = {
      chatJson: vi.fn(async () => {
        throw new Error("must not be called");
      }) as DeepSeekClient["chatJson"],
    };
    const res = await runDreamPass({
      workspaceRoot: ws,
      sessions: [],
      client,
      runId: "rf4",
      config: { semanticizeReactivationThreshold: 0 },
      now: () => new Date("2026-07-01T00:00:00Z"),
    });
    expect(res.notesOutcome).toBeUndefined();
    expect(
      readManifest(dreamDir).created.find((r) => r.id === "stable-1")
        ?.gistFolded,
    ).toBeUndefined();
    expect(
      (client.chatJson as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ADR 0023 — the forgetting curve is ON by default (retentionFloor 0.12)
// ---------------------------------------------------------------------------

describe("runDreamPass default forgetting floor (ADR 0023)", () => {
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "dream-floor-"));
    mkdirSync(join(ws, ".herta", "narrative"), { recursive: true });
    mkdirSync(join(ws, ".herta", "dream"), { recursive: true });
  });
  afterEach(() => rmSync(ws, { recursive: true, force: true }));

  it("the DEFAULT config fades an ancient record through the normal pass (stale-floor + notes fold)", async () => {
    const narrativeDir = join(ws, ".herta", "narrative");
    const dreamDir = join(ws, ".herta", "dream");
    const file = "### 废案_07：被时间带走的一晚.txt";
    writeFileSync(
      join(narrativeDir, file),
      "### 废案_07：被时间带走的一晚\n那晚的细节，如今只剩一个判断。",
      "utf8",
    );
    const m0 = manifestModule.emptyManifest();
    m0.created.push({
      id: "ancient",
      file,
      nn: 7,
      state: "live",
      sourceSessionId: "s0",
      sourceEpisodeHash: "hAncient",
      sourceEpisodes: ["hAncient"],
      runId: "r0",
      model: "m",
      // ~426 idle days at the pass clock: 0.9·2^(−426/90) ≈ 0.034 < 0.12 —
      // below the NEW default floor, so the untouched default config fades it.
      generatedAt: "2025-05-01T00:00:00Z",
      situationTag: "t",
      summary: "那晚的细节。",
      critiqueScores: { voice: 0.9, format: 1, novelty: 1 },
      validateFeianPassed: true,
      reactivationCount: 0,
    });
    manifestModule.writeManifest(dreamDir, m0);

    const notes = "细节淡了，但那个判断留了下来：他不赖账。";
    const client: DeepSeekClient = {
      chatJson: vi.fn(async ({ systemPrompt }: { systemPrompt: string }) => {
        if (systemPrompt.includes("自传第六章"))
          return { rawJsonText: JSON.stringify({ notes }), model: "m" };
        throw new Error(`unexpected LLM call: ${systemPrompt.slice(0, 30)}`);
      }) as DeepSeekClient["chatJson"],
    };

    const res = await runDreamPass({
      workspaceRoot: ws,
      sessions: [],
      client,
      runId: "rfade",
      config: {}, // pure defaults — the point of the test
      now: () => new Date("2026-07-01T00:00:00Z"),
    });

    // Faded through the stale-floor path…
    expect(existsSync(join(narrativeDir, file))).toBe(false);
    expect(existsSync(join(dreamDir, "archive", file))).toBe(true);
    const m = readManifest(dreamDir);
    expect(m.created.find((r) => r.id === "ancient")?.state).toBe("archived");
    expect(
      m.episodes.some(
        (e) =>
          (e.reason ?? "").startsWith("forgotten:") &&
          (e.reason ?? "").includes("floor 0.12"),
      ),
    ).toBe(true);
    // …and its gist folded into the notes page before the archive move.
    expect(res.notesOutcome).toBe("updated");
    expect(
      readFileSync(join(narrativeDir, "### 记录：关于开拓者.txt"), "utf8"),
    ).toContain(notes);
  });
});

describe("runDreamPass durability (dream review 2026-09-22, findings 7, 8, 14)", () => {
  let ws: string;
  let narrativeDir: string;
  let dreamDir: string;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "dream-durable-"));
    narrativeDir = join(ws, ".herta", "narrative");
    dreamDir = join(ws, ".herta", "dream");
    mkdirSync(narrativeDir, { recursive: true });
    mkdirSync(dreamDir, { recursive: true });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(ws, { recursive: true, force: true });
  });

  const record: TerminalRecord = [
    { kind: "user", text: "阮·梅又在搞事，你怎么看" },
    { kind: "herta", surface: "speech", text: "我看她乐在其中。" },
    { kind: "herta", surface: "speech", text: "至于我，懒得掺和。" },
    { kind: "user", text: "（新话题）帮我看个 bug" },
  ];
  const testConfig = { minEpisodeChars: 10 };

  /** A dying dream: ~426 idle days, below the default floor. */
  function seedAncient(): string {
    const file = "### 废案_07：被时间带走的一晚.txt";
    writeFileSync(
      join(narrativeDir, file),
      "### 废案_07：被时间带走的一晚\n那晚的细节，如今只剩一个判断。",
      "utf8",
    );
    const m0 = manifestModule.emptyManifest();
    m0.created.push({
      id: "ancient",
      file,
      nn: 7,
      state: "live",
      sourceSessionId: "s0",
      sourceEpisodeHash: "hAncient",
      sourceEpisodes: ["hAncient"],
      runId: "r0",
      model: "m",
      generatedAt: "2025-05-01T00:00:00Z",
      situationTag: "t",
      summary: "那晚的细节。",
      critiqueScores: { voice: 0.9, format: 1, novelty: 1 },
      validateFeianPassed: true,
      reactivationCount: 0,
    });
    manifestModule.writeManifest(dreamDir, m0);
    return file;
  }

  it("a corrupt manifest stops the pass before anything is written — it is copied aside, never replaced by an empty ledger (finding 8)", async () => {
    const corrupt = '{"version":1,"episodes":[{"sessionId":"s1"';
    writeFileSync(join(dreamDir, "manifest.json"), corrupt, "utf8");
    const res = await runDreamPass({
      workspaceRoot: ws,
      sessions: [{ sessionId: "s1", record }],
      client: fakeClient(),
      runId: "rcorrupt",
      config: testConfig,
      now: () => new Date("2026-06-18T09:30:00Z"),
    });
    expect(res.aborted).toBe("manifest corrupt");
    expect(res.promoted).toBe(0);
    // The broken file is still there for repair, and a copy sits beside it.
    expect(readFileSync(join(dreamDir, "manifest.json"), "utf8")).toBe(corrupt);
    expect(
      readdirSync(dreamDir).some((f) =>
        /^manifest\.corrupt-[0-9a-f]{8}\.json$/.test(f),
      ),
    ).toBe(true);
    expect(
      readdirSync(narrativeDir).filter((f) => f.startsWith("### 废案")),
    ).toEqual([]);
  });

  it("a promotion the DISK refuses aborts the pass without consuming the episode — the next pass promotes it (finding 7)", async () => {
    const spy = vi
      .spyOn(promoteModule, "promoteCandidate")
      .mockImplementationOnce(() => {
        throw Object.assign(
          new Error("EPERM: operation not permitted, rename"),
          {
            code: "EPERM",
          },
        );
      });
    const first = await runDreamPass({
      workspaceRoot: ws,
      sessions: [{ sessionId: "s1", record }],
      client: fakeClient(),
      runId: "reperm-1",
      config: testConfig,
      now: () => new Date("2026-06-18T09:30:00Z"),
    });
    expect(first.aborted).toBe("write failed: EPERM");
    expect(first.archived).toBe(0);
    expect(readManifest(dreamDir).episodes).toEqual([]);
    spy.mockRestore();
    const second = await runDreamPass({
      workspaceRoot: ws,
      sessions: [{ sessionId: "s1", record }],
      client: fakeClient(),
      runId: "reperm-2",
      config: testConfig,
      now: () => new Date("2026-06-18T10:30:00Z"),
    });
    expect(second.promoted).toBe(1);
  });

  it("a forgetting the disk refuses leaves the memory LIVE — never archived in the ledger while its file still loads (finding 7)", async () => {
    const file = seedAncient();
    // The archive dir cannot be made: a FILE sits where it should be.
    writeFileSync(join(dreamDir, "archive"), "", "utf8");
    await runDreamPass({
      workspaceRoot: ws,
      sessions: [],
      client: fakeClient(),
      runId: "rblocked",
      config: {},
      now: () => new Date("2026-07-01T00:00:00Z"),
    });
    const m = readManifest(dreamDir);
    expect(m.created.find((r) => r.id === "ancient")?.state).toBe("live");
    expect(m.episodes).toEqual([]);
    expect(m.pendingFold).toBeUndefined();
    expect(existsSync(join(narrativeDir, file))).toBe(true);
  });

  it("a dying gist the pass could not fold stays owed — the next pass folds it from the archive (finding 14)", async () => {
    const file = seedAncient();
    const notes = "细节淡了，但那个判断留了下来：他不赖账。";
    // Pass 1: every model call fails — the episode aborts the pass, and the
    // fold after the loops fails too.
    const down: DeepSeekClient = {
      chatJson: vi.fn(async () => {
        throw new Error("ECONNRESET");
      }) as DeepSeekClient["chatJson"],
    };
    const first = await runDreamPass({
      workspaceRoot: ws,
      sessions: [{ sessionId: "s1", record }],
      client: down,
      runId: "rowed-1",
      config: { ...testConfig },
      now: () => new Date("2026-07-01T00:00:00Z"),
    });
    expect(first.aborted).toBeDefined();
    expect(existsSync(join(dreamDir, "archive", file))).toBe(true);
    expect(readManifest(dreamDir).pendingFold).toEqual([file]);
    // Pass 2: the fold answers; the owed gist reaches the page and is cleared.
    const up: DeepSeekClient = {
      chatJson: vi.fn(async ({ systemPrompt }: { systemPrompt: string }) => {
        if (systemPrompt.includes("自传第六章"))
          return { rawJsonText: JSON.stringify({ notes }), model: "m" };
        throw new Error(`unexpected LLM call: ${systemPrompt.slice(0, 30)}`);
      }) as DeepSeekClient["chatJson"],
    };
    const second = await runDreamPass({
      workspaceRoot: ws,
      sessions: [],
      client: up,
      runId: "rowed-2",
      config: {},
      now: () => new Date("2026-07-02T00:00:00Z"),
    });
    expect(second.notesOutcome).toBe("updated");
    expect(readManifest(dreamDir).pendingFold).toBeUndefined();
    expect(
      readFileSync(join(narrativeDir, "### 记录：关于开拓者.txt"), "utf8"),
    ).toContain(notes);
  });
});
