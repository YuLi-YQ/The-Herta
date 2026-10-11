import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeepSeekClient } from "../llm/types.js";
import { resolveDreamConfig } from "./config.js";
import {
  auditTrailblazerNotes,
  readTrailblazerNotesBody,
  semanticizeEvictions,
  TRAILBLAZER_NOTES_FILE,
  TRAILBLAZER_NOTES_FILE_EN,
  validateTrailblazerNotesBody,
  writeTrailblazerNotes,
} from "./semanticize.js";

const cfg = resolveDreamConfig();

function clientReturning(rawJsonText: string): DeepSeekClient {
  return {
    chatJson: vi.fn(async () => ({ rawJsonText, model: "m" })),
  } as unknown as DeepSeekClient;
}

/** Sequential replies: call N returns raws[N] (a thrown Error entry throws).
 *  For the refine-retry tests — first call the rejected draft, second call
 *  the refine outcome. */
function clientReturningSeq(raws: readonly (string | Error)[]): DeepSeekClient {
  let i = 0;
  return {
    chatJson: vi.fn(async () => {
      const raw = raws[Math.min(i, raws.length - 1)];
      i++;
      if (raw instanceof Error) throw raw;
      return { rawJsonText: raw ?? "", model: "m" };
    }),
  } as unknown as DeepSeekClient;
}

const DYING = [
  {
    file: "### 废案_07：全量与侥幸.txt",
    body: "### 废案_07：全量与侥幸\n那晚他想拿针对性测试当全量的挡箭牌……",
  },
] as const;

describe("validateTrailblazerNotesBody", () => {
  it("accepts clean first-person prose", () => {
    const body =
      "这位开拓者不把希望寄托在别人身上；他的直觉常常先于他的论证到位。";
    expect(validateTrailblazerNotesBody(body, 600)).toEqual([]);
  });

  it("rejects dialogue fences, headers, and record markers", () => {
    for (const bad of [
      "认识若干。（我 说）某句台词（/我 说）",
      "认识若干。\n### 一个标题行混了进来，这不该出现",
      "认识若干。→ 系统 Reading foo.ts —— 记录标记不该出现",
      "认识若干。（开拓者 说）某句话，栅栏不该出现",
      // 2026-07-09 review: the old literal list missed all of these —
      // a stray closer, another role's fence, a lone truncated closer.
      "认识若干。（/开拓者 说）一个流浪的闭栏也不该出现",
      "认识若干。（阮·梅 说）别的角色的栅栏也不该出现",
      "认识若干。（艾丝妲 想）别的角色的心想栅栏也不该出现",
      "认识若干。一个被截断的闭栏（/也不该出现",
    ]) {
      expect(validateTrailblazerNotesBody(bad, 600)).not.toEqual([]);
    }
  });

  it("rejects English structural markers (same rule as the 废案 gate — same prefix)", () => {
    for (const bad of [
      "认识若干。Verdict: 他修好了 —— 报告腔不该进这一页",
      "认识若干。verdict : 他修好了 —— 大小写与空格变体同样拦下",
      "认识若干。Summary：他还行 —— 全角冒号同样拦下",
    ]) {
      expect(validateTrailblazerNotesBody(bad, 600)).not.toEqual([]);
    }
  });

  it("accepts an innocent parenthetical about 开拓者 (no fence shape — the old literal list false-positived here)", () => {
    const body =
      "他嘴上抱怨，手上从不慢（开拓者的老毛病，改不掉）；这点姑且算优点。";
    expect(validateTrailblazerNotesBody(body, 600)).toEqual([]);
  });

  it("rejects too-short and over-budget bodies", () => {
    expect(validateTrailblazerNotesBody("太短", 600)).not.toEqual([]);
    expect(validateTrailblazerNotesBody("很".repeat(601), 600)).not.toEqual([]);
  });
});

describe("notes file roundtrip", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dream-notes-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes the fixed frame + body and reads the body back", () => {
    writeTrailblazerNotes(dir, "他从不把希望寄托在别人身上。", "r1");
    const full = readFileSync(join(dir, TRAILBLAZER_NOTES_FILE), "utf8");
    expect(full.startsWith("### 记录：关于开拓者\n")).toBe(true);
    expect(readTrailblazerNotesBody(dir)).toBe("他从不把希望寄托在别人身上。");
  });

  it("filename matches the static-prefix loader's ### 记录 prefix", () => {
    expect(TRAILBLAZER_NOTES_FILE.startsWith("### 记录")).toBe(true);
    expect(TRAILBLAZER_NOTES_FILE.endsWith(".txt")).toBe(true);
  });

  it("returns empty body when the page does not exist", () => {
    expect(readTrailblazerNotesBody(dir)).toBe("");
  });
});

describe("EN notes page (ADR 0017)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dream-notes-en-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes the EN frame + body and reads the body back", () => {
    const body = "He never leans on anyone else's hope.";
    writeTrailblazerNotes(dir, body, "r1", "en");
    const full = readFileSync(join(dir, TRAILBLAZER_NOTES_FILE_EN), "utf8");
    expect(full.startsWith("### 记录：About the Trailblazer\n")).toBe(true);
    expect(full).toContain("a few things have settled:");
    expect(readTrailblazerNotesBody(dir, "en")).toBe(body);
  });

  it("EN filename keeps the ### 记录 loader prefix and differs from zh", () => {
    expect(TRAILBLAZER_NOTES_FILE_EN.startsWith("### 记录")).toBe(true);
    expect(TRAILBLAZER_NOTES_FILE_EN.endsWith(".txt")).toBe(true);
    expect(TRAILBLAZER_NOTES_FILE_EN).not.toBe(TRAILBLAZER_NOTES_FILE);
  });

  it("en and zh pages are independent files that coexist in one dir", () => {
    writeTrailblazerNotes(dir, "他从不把希望寄托在别人身上。", "rz", "zh");
    writeTrailblazerNotes(dir, "He is blunt but usually right.", "re", "en");
    expect(readTrailblazerNotesBody(dir, "zh")).toBe(
      "他从不把希望寄托在别人身上。",
    );
    expect(readTrailblazerNotesBody(dir, "en")).toBe(
      "He is blunt but usually right.",
    );
    expect(existsSync(join(dir, TRAILBLAZER_NOTES_FILE))).toBe(true);
    expect(existsSync(join(dir, TRAILBLAZER_NOTES_FILE_EN))).toBe(true);
  });

  it("reads empty when only the other language's page is present", () => {
    writeTrailblazerNotes(dir, "只有中文页。这里写了一些认识。", "rz", "zh");
    expect(readTrailblazerNotesBody(dir, "en")).toBe("");
  });

  it("a clean English body passes validation (structural checks are language-agnostic)", () => {
    const body =
      "He never leans on anyone else's hope; his instinct tends to arrive before his argument does.";
    expect(validateTrailblazerNotesBody(body, 600)).toEqual([]);
  });

  it("folds a dying 废案 into a fresh EN page (updated), writing the EN file", async () => {
    const notes =
      "He now tells a targeted test from full coverage — though he still tries to skate on the difference.";
    const outcome = await semanticizeEvictions({
      narrativeDir: dir,
      client: clientReturning(JSON.stringify({ notes })),
      cfg,
      evicted: DYING,
      guide: "guide",
      runId: "r1",
      lang: "en",
    });
    expect(outcome).toBe("updated");
    expect(readTrailblazerNotesBody(dir, "en")).toBe(notes);
    // Wrote the EN page, not the zh one.
    expect(existsSync(join(dir, TRAILBLAZER_NOTES_FILE_EN))).toBe(true);
    expect(existsSync(join(dir, TRAILBLAZER_NOTES_FILE))).toBe(false);
  });

  it("audits and revises the EN page against a contradicting living dream", async () => {
    writeTrailblazerNotes(dir, "He is hopeless at concurrency.", "r0", "en");
    const revised = "He handles concurrency fine now; that judgment was stale.";
    const outcome = await auditTrailblazerNotes({
      narrativeDir: dir,
      client: clientReturning(
        JSON.stringify({ consistent: false, notes: revised }),
      ),
      cfg,
      living: DYING,
      guide: "guide",
      runId: "r1",
      lang: "en",
    });
    expect(outcome).toBe("revised");
    expect(readTrailblazerNotesBody(dir, "en")).toBe(revised);
  });
});

describe("semanticizeEvictions", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dream-notes-"));
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns none and writes nothing for an empty eviction list", async () => {
    const client = clientReturning(JSON.stringify({ notes: "x" }));
    const outcome = await semanticizeEvictions({
      narrativeDir: dir,
      client,
      cfg,
      evicted: [],
      guide: "guide",
      runId: "r1",
    });
    expect(outcome).toBe("none");
    expect(existsSync(join(dir, TRAILBLAZER_NOTES_FILE))).toBe(false);
    expect(client.chatJson).not.toHaveBeenCalled();
  });

  // An UNREADABLE page (a lock from AV/indexer/OneDrive, EMFILE in the
  // long-lived main process) used to read as "" = "she hasn't written
  // anything yet". The fold is a whole-page LLM regeneration that then
  // durably renames over the target and reports success — so one failed read
  // erased everything Herta had settled about the Trailblazer, and told her
  // it had gone fine. A directory at the page's path is the portable way to
  // get a non-ENOENT errno (EISDIR) out of readFileSync.
  const makeUnreadable = (d: string): void => {
    mkdirSync(join(d, TRAILBLAZER_NOTES_FILE), { recursive: true });
  };

  it("refuses to fold over a page it could not READ (audit 2026-07-24, 2.1)", async () => {
    makeUnreadable(dir);
    const client = clientReturning(JSON.stringify({ notes: "x".repeat(40) }));
    const outcome = await semanticizeEvictions({
      narrativeDir: dir,
      client,
      cfg,
      evicted: DYING,
      guide: "guide",
      runId: "r1",
    });
    expect(outcome).toBe("failed");
    // Never even asked the model to rewrite a page it can't see.
    expect(client.chatJson).not.toHaveBeenCalled();
  });

  it("an ABSENT page is still a legitimate blank slate", async () => {
    const notes = "他习惯先动手再论证；这一点已经反复得到印证，不必再问。";
    const outcome = await semanticizeEvictions({
      narrativeDir: dir,
      client: clientReturning(JSON.stringify({ notes })),
      cfg,
      evicted: DYING,
      guide: "guide",
      runId: "r1",
    });
    expect(outcome).toBe("updated");
  });

  it("folds a dying 废案 into a fresh page (updated)", async () => {
    const notes =
      "这位开拓者习惯先动手再论证；对全量与针对性的边界，他心里有数了。";
    const outcome = await semanticizeEvictions({
      narrativeDir: dir,
      client: clientReturning(JSON.stringify({ notes })),
      cfg,
      evicted: DYING,
      guide: "guide",
      runId: "r1",
    });
    expect(outcome).toBe("updated");
    expect(readTrailblazerNotesBody(dir)).toBe(notes);
  });

  it("a stabilized-only fold (no evictions) still rewrites the page (ADR 0023)", async () => {
    const notes = "他的直觉常常先于论证到位；这一点已经反复得到印证。";
    const outcome = await semanticizeEvictions({
      narrativeDir: dir,
      client: clientReturning(JSON.stringify({ notes })),
      cfg,
      evicted: [],
      stabilized: DYING, // structural twin — a LIVING record's text here
      guide: "guide",
      runId: "r1",
    });
    expect(outcome).toBe("updated");
    expect(readTrailblazerNotesBody(dir)).toBe(notes);
  });

  it("REWRITES the page rather than appending", async () => {
    writeTrailblazerNotes(dir, "旧的一页：他嗓门大，但推理通常站得住。", "r0");
    const notes = "新的一页：他的推理站得住，嗓门的事不值得记了。";
    const outcome = await semanticizeEvictions({
      narrativeDir: dir,
      client: clientReturning(JSON.stringify({ notes })),
      cfg,
      evicted: DYING,
      guide: "guide",
      runId: "r1",
    });
    expect(outcome).toBe("updated");
    const body = readTrailblazerNotesBody(dir);
    expect(body).toBe(notes);
    expect(body).not.toContain("旧的一页");
  });

  it("keeps the old page untouched when the LLM call throws (transport)", async () => {
    writeTrailblazerNotes(dir, "旧的一页：他从不把希望寄托在别人身上。", "r0");
    const client = {
      chatJson: vi.fn(async () => {
        throw new Error("ECONNRESET");
      }),
    } as unknown as DeepSeekClient;
    const outcome = await semanticizeEvictions({
      narrativeDir: dir,
      client,
      cfg,
      evicted: DYING,
      guide: "guide",
      runId: "r1",
    });
    expect(outcome).toBe("failed");
    expect(readTrailblazerNotesBody(dir)).toBe(
      "旧的一页：他从不把希望寄托在别人身上。",
    );
  });

  it("fails closed on unparseable replies and invalid bodies", async () => {
    writeTrailblazerNotes(dir, "旧的一页：他从不把希望寄托在别人身上。", "r0");
    for (const raw of [
      "not json at all",
      JSON.stringify({ wrong: "shape" }),
      JSON.stringify({ notes: "混入栅栏。（我 说）台词（/我 说）" }),
      JSON.stringify({ notes: "很".repeat(cfg.trailblazerNotesMaxChars + 1) }),
    ]) {
      const outcome = await semanticizeEvictions({
        narrativeDir: dir,
        client: clientReturning(raw),
        cfg,
        evicted: DYING,
        guide: "guide",
        runId: "r1",
      });
      expect(outcome).toBe("failed");
    }
    expect(readTrailblazerNotesBody(dir)).toBe(
      "旧的一页：他从不把希望寄托在别人身上。",
    );
  });

  // ONE validator-feedback refine retry (audit 2026-07-16): the zh-calibrated
  // LEAK_MARKERS match ordinary EN prose ("the plan: …") and the shared char
  // cap is tighter in information terms for EN, so a single validation
  // failure must not permanently lose the evicted dreams' gist.
  it("refines ONCE on a validation failure and writes the repaired body (updated)", async () => {
    const repaired =
      "He keeps himself honest without a written plan; the boundary between targeted and full coverage is settled for him now.";
    const client = clientReturningSeq([
      // First reply trips LEAK_MARKERS via ordinary EN prose ("the plan: …").
      JSON.stringify({
        notes:
          "He keeps himself honest; the plan: never let him skate on a targeted pass again.",
      }),
      JSON.stringify({ notes: repaired }),
    ]);
    const outcome = await semanticizeEvictions({
      narrativeDir: dir,
      client,
      cfg,
      evicted: DYING,
      guide: "guide",
      runId: "r1",
      lang: "en",
    });
    expect(outcome).toBe("updated");
    expect(client.chatJson).toHaveBeenCalledTimes(2);
    expect(readTrailblazerNotesBody(dir, "en")).toBe(repaired);
  });

  it("fails after the SECOND validation failure — exactly one refine, page untouched", async () => {
    writeTrailblazerNotes(dir, "旧的一页：他从不把希望寄托在别人身上。", "r0");
    const client = clientReturningSeq([
      JSON.stringify({ notes: "混入栅栏。（我 说）台词（/我 说）" }),
      JSON.stringify({ notes: "还是有栅栏。（我 想）内心（/我 想）" }),
    ]);
    const outcome = await semanticizeEvictions({
      narrativeDir: dir,
      client,
      cfg,
      evicted: DYING,
      guide: "guide",
      runId: "r1",
    });
    expect(outcome).toBe("failed");
    expect(client.chatJson).toHaveBeenCalledTimes(2); // no third attempt
    expect(readTrailblazerNotesBody(dir)).toBe(
      "旧的一页：他从不把希望寄托在别人身上。",
    );
  });

  it("a transport error DURING the refine returns failed, page untouched", async () => {
    writeTrailblazerNotes(dir, "旧的一页：他从不把希望寄托在别人身上。", "r0");
    const client = clientReturningSeq([
      JSON.stringify({ notes: "混入栅栏。（我 说）台词（/我 说）" }),
      new Error("ECONNRESET"), // jsonCall wraps this in DreamTransportError
    ]);
    const outcome = await semanticizeEvictions({
      narrativeDir: dir,
      client,
      cfg,
      evicted: DYING,
      guide: "guide",
      runId: "r1",
    });
    expect(outcome).toBe("failed");
    expect(readTrailblazerNotesBody(dir)).toBe(
      "旧的一页：他从不把希望寄托在别人身上。",
    );
  });
});

describe("auditTrailblazerNotes", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dream-audit-"));
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const LIVING = [
    {
      file: "### 废案_08：他修好了.txt",
      body: "### 废案_08：他修好了\n这次他自己把并发 bug 修掉了，没找我。",
    },
  ] as const;

  it("an unreadable page is 'failed', not 'none' (audit 2026-07-24, 2.1)", async () => {
    // "none" claims there was nothing to audit. An audit that could not open
    // the page it was meant to check is not entitled to that claim.
    mkdirSync(join(dir, TRAILBLAZER_NOTES_FILE), { recursive: true });
    const client = clientReturning(JSON.stringify({ consistent: true }));
    expect(
      await auditTrailblazerNotes({
        narrativeDir: dir,
        client,
        cfg,
        living: LIVING,
        guide: "g",
        runId: "r1",
      }),
    ).toBe("failed");
    expect(client.chatJson).not.toHaveBeenCalled();
  });

  it("returns none when there is no page or no living record", async () => {
    const client = clientReturning(JSON.stringify({ consistent: true }));
    expect(
      await auditTrailblazerNotes({
        narrativeDir: dir,
        client,
        cfg,
        living: LIVING,
        guide: "g",
        runId: "r1",
      }),
    ).toBe("none");
    writeTrailblazerNotes(dir, "他对并发一窍不通，碰到就躲。", "r0");
    expect(
      await auditTrailblazerNotes({
        narrativeDir: dir,
        client,
        cfg,
        living: [],
        guide: "g",
        runId: "r1",
      }),
    ).toBe("none");
    expect(client.chatJson).not.toHaveBeenCalled();
  });

  it("consistent: true costs no write — page byte-identical", async () => {
    writeTrailblazerNotes(dir, "他从不把希望寄托在别人身上。", "r0");
    const before = readFileSync(join(dir, TRAILBLAZER_NOTES_FILE), "utf8");
    const outcome = await auditTrailblazerNotes({
      narrativeDir: dir,
      client: clientReturning(
        JSON.stringify({ consistent: true, notes: null }),
      ),
      cfg,
      living: LIVING,
      guide: "g",
      runId: "r1",
    });
    expect(outcome).toBe("consistent");
    expect(readFileSync(join(dir, TRAILBLAZER_NOTES_FILE), "utf8")).toBe(
      before,
    );
  });

  it("revises the page when a claim is contradicted", async () => {
    writeTrailblazerNotes(
      dir,
      "他对并发一窍不通，碰到就躲；但直觉常常在线。",
      "r0",
    );
    const revised = "他的并发功底追上来了，不再绕着走；直觉常常在线。";
    const outcome = await auditTrailblazerNotes({
      narrativeDir: dir,
      client: clientReturning(
        JSON.stringify({ consistent: false, notes: revised }),
      ),
      cfg,
      living: LIVING,
      guide: "g",
      runId: "r1",
    });
    expect(outcome).toBe("revised");
    expect(readTrailblazerNotesBody(dir)).toBe(revised);
  });

  it("refines ONCE when the revision fails validation, then revises", async () => {
    writeTrailblazerNotes(dir, "他对并发一窍不通，碰到就躲。", "r0");
    const repaired = "他的并发功底追上来了，那句旧判断作废；直觉常常在线。";
    const client = clientReturningSeq([
      JSON.stringify({
        consistent: false,
        notes: "修订混入了栅栏。（我 说）台词（/我 说）",
      }),
      JSON.stringify({ notes: repaired }),
    ]);
    const outcome = await auditTrailblazerNotes({
      narrativeDir: dir,
      client,
      cfg,
      living: LIVING,
      guide: "g",
      runId: "r1",
    });
    expect(outcome).toBe("revised");
    expect(client.chatJson).toHaveBeenCalledTimes(2);
    expect(readTrailblazerNotesBody(dir)).toBe(repaired);
  });

  it("fails when the refine's reply is ALSO invalid — page untouched", async () => {
    writeTrailblazerNotes(dir, "他从不把希望寄托在别人身上。", "r0");
    const client = clientReturningSeq([
      JSON.stringify({
        consistent: false,
        notes: "修订混入了栅栏。（我 说）台词（/我 说）",
      }),
      JSON.stringify({ notes: "还是有栅栏。（我 想）内心（/我 想）" }),
    ]);
    const outcome = await auditTrailblazerNotes({
      narrativeDir: dir,
      client,
      cfg,
      living: LIVING,
      guide: "g",
      runId: "r1",
    });
    expect(outcome).toBe("failed");
    expect(client.chatJson).toHaveBeenCalledTimes(2);
    expect(readTrailblazerNotesBody(dir)).toBe("他从不把希望寄托在别人身上。");
  });

  it("fails closed: bad shape, invalid revision, transport — page untouched", async () => {
    writeTrailblazerNotes(dir, "他从不把希望寄托在别人身上。", "r0");
    for (const raw of [
      "not json",
      JSON.stringify({ notes: "缺 consistent 字段，判定无效" }),
      JSON.stringify({ consistent: false, notes: null }),
      JSON.stringify({
        consistent: false,
        notes: "（我 说）栅栏混入（/我 说）",
      }),
    ]) {
      expect(
        await auditTrailblazerNotes({
          narrativeDir: dir,
          client: clientReturning(raw),
          cfg,
          living: LIVING,
          guide: "g",
          runId: "r1",
        }),
      ).toBe("failed");
    }
    const throwing = {
      chatJson: vi.fn(async () => {
        throw new Error("ECONNRESET");
      }),
    } as unknown as DeepSeekClient;
    expect(
      await auditTrailblazerNotes({
        narrativeDir: dir,
        client: throwing,
        cfg,
        living: LIVING,
        guide: "g",
        runId: "r1",
      }),
    ).toBe("failed");
    expect(readTrailblazerNotesBody(dir)).toBe("他从不把希望寄托在别人身上。");
  });
});
