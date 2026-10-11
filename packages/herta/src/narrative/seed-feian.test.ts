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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROMPT_ASSETS, PROMPT_ASSETS_EN } from "./prompt-assets.generated.js";
import { materializeSeedFeian } from "./seed-feian.js";

describe("materializeSeedFeian (M-prompts-1)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "herta-seed-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const narrativeDir = () => join(root, ".herta", "narrative");

  it("writes all compiled seeds into a fresh workspace (creating the dir)", async () => {
    await materializeSeedFeian(root);
    const files = readdirSync(narrativeDir());
    for (const name of Object.keys(PROMPT_ASSETS.feianSeeds)) {
      expect(files).toContain(name);
    }
    // 8 originals + the two consolidated 远程办公 entries (废案_08/09,
    // ADR 0053 folded 其七–其十一 into two longer conversations) + 其九
    // (废案_13, the credit-and-blame ledger — 2026-09-02 register slice).
    expect(Object.keys(PROMPT_ASSETS.feianSeeds).length).toBe(11);
  });

  it("is idempotent — a second call changes nothing", async () => {
    await materializeSeedFeian(root);
    const before = readdirSync(narrativeDir()).sort();
    await materializeSeedFeian(root);
    expect(readdirSync(narrativeDir()).sort()).toEqual(before);
  });

  it("adds missing seeds to a LIVING workspace, but never resurrects archived ones (2026-07-19)", async () => {
    // A workspace whose memory lifecycle has begun: one dream-era 废案 live,
    // one seed legitimately cap-evicted into the dream archive. A newly-
    // shipped seed must still arrive; the evicted one must stay evicted.
    mkdirSync(narrativeDir(), { recursive: true });
    writeFileSync(
      join(narrativeDir(), "### 废案_12：某个梦.txt"),
      "### 废案_12：某个梦\n正文。\n\n---\n\n（我 说）\n嗯。\n（/我 说）\n",
      "utf-8",
    );
    const seedNames = Object.keys(PROMPT_ASSETS.feianSeeds);
    const evicted = seedNames[3] as string; // an evictable seed example
    const archiveDir = join(root, ".herta", "dream", "archive");
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(join(archiveDir, evicted), "archived body", "utf-8");

    await materializeSeedFeian(root);
    const files = readdirSync(narrativeDir());
    // The dream-era page is untouched, every non-archived seed arrived...
    expect(files).toContain("### 废案_12：某个梦.txt");
    for (const name of seedNames) {
      if (name === evicted) continue;
      expect(files).toContain(name);
    }
    // ...and the evicted seed was NOT resurrected.
    expect(files).not.toContain(evicted);
  });

  // The seed-revision upgrade path (ADR 0052), exercised through the test
  // seam so the cases stay self-contained (no dependency on git history or
  // on which bodies the real registry currently lists).
  const OLD_BODY = "### 废案_03：旧版\n\n---\n\n旧的正文。\n";
  const NEW_BODY = "### 废案_03：新版\n\n---\n\n修订后的正文。\n";
  const seedName = "### 废案_03：远程办公的一百种无聊方式.txt";
  const sha1Of = async (s: string) => {
    const { createHash } = await import("node:crypto");
    return createHash("sha1").update(s, "utf8").digest("hex");
  };
  const bundle = async () => ({
    feianSeeds: { [seedName]: NEW_BODY },
    supersededFeianSha1: [await sha1Of(OLD_BODY)],
  });

  it("UPGRADES a live file whose body is a registered superseded seed version (ADR 0052)", async () => {
    mkdirSync(narrativeDir(), { recursive: true });
    writeFileSync(join(narrativeDir(), seedName), OLD_BODY, "utf-8");

    await materializeSeedFeian(root, "zh", await bundle());
    expect(readFileSync(join(narrativeDir(), seedName), "utf-8")).toBe(
      NEW_BODY,
    );
  });

  it("NEVER overwrites a live seed file whose hash is not registered — a user edit stays (D7)", async () => {
    const edited = "### 废案_03：用户自己改过的版本\n\n---\n\n改动内容。\n";
    mkdirSync(narrativeDir(), { recursive: true });
    writeFileSync(join(narrativeDir(), seedName), edited, "utf-8");

    await materializeSeedFeian(root, "zh", await bundle());
    expect(readFileSync(join(narrativeDir(), seedName), "utf-8")).toBe(edited);
  });

  it("a CRLF-mangled stale copy still hashes as superseded (LF normalization)", async () => {
    mkdirSync(narrativeDir(), { recursive: true });
    writeFileSync(
      join(narrativeDir(), seedName),
      OLD_BODY.replace(/\n/g, "\r\n"),
      "utf-8",
    );

    await materializeSeedFeian(root, "zh", await bundle());
    expect(readFileSync(join(narrativeDir(), seedName), "utf-8")).toBe(
      NEW_BODY,
    );
  });

  it("ARCHIVES a retired seed whose content still matches a shipped body (ADR 0053 consolidation)", async () => {
    const retiredName = "### 废案_10：远程办公的一百种无聊方式.txt";
    const retiredBody = "### 废案_10：旧的独立篇\n\n---\n\n已并入其它废案。\n";
    mkdirSync(narrativeDir(), { recursive: true });
    writeFileSync(join(narrativeDir(), retiredName), retiredBody, "utf-8");

    await materializeSeedFeian(root, "zh", {
      feianSeeds: { [seedName]: NEW_BODY },
      supersededFeianSha1: [],
      retiredFeian: { [retiredName]: [await sha1Of(retiredBody)] },
    });

    // Gone from the live corpus, but recoverable — archived, not deleted.
    expect(readdirSync(narrativeDir())).not.toContain(retiredName);
    expect(readdirSync(join(root, ".herta", "dream", "archive"))).toContain(
      retiredName,
    );
  });

  it("a retired FILENAME with user-edited content is left alone (D7)", async () => {
    const retiredName = "### 废案_10：远程办公的一百种无聊方式.txt";
    const edited = "### 废案_10：我自己改的\n\n---\n\n别动我的。\n";
    mkdirSync(narrativeDir(), { recursive: true });
    writeFileSync(join(narrativeDir(), retiredName), edited, "utf-8");

    await materializeSeedFeian(root, "zh", {
      feianSeeds: { [seedName]: NEW_BODY },
      supersededFeianSha1: [],
      // The hash registered is some OTHER shipped body, not this edit.
      retiredFeian: { [retiredName]: [await sha1Of("something else")] },
    });

    expect(readFileSync(join(narrativeDir(), retiredName), "utf-8")).toBe(
      edited,
    );
  });

  it("the shipped retirement registry names only files that no longer ship", () => {
    for (const name of Object.keys(PROMPT_ASSETS.retiredFeian)) {
      expect(Object.keys(PROMPT_ASSETS.feianSeeds)).not.toContain(name);
    }
    for (const hashes of Object.values(PROMPT_ASSETS.retiredFeian)) {
      expect(hashes.length).toBeGreaterThan(0);
      for (const h of hashes) expect(h).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it("the REAL registry recognizes the pre-revision bodies: every registered hash is 40-hex and the revised seeds' own hashes are NOT registered", async () => {
    // Sanity over the shipped registry (not history-dependent): the current
    // bundle bodies must never hash as superseded — that would make
    // materialization rewrite fresh files forever.
    expect(PROMPT_ASSETS.supersededFeianSha1.length).toBeGreaterThan(0);
    for (const h of PROMPT_ASSETS.supersededFeianSha1) {
      expect(h).toMatch(/^[0-9a-f]{40}$/);
    }
    for (const body of Object.values(PROMPT_ASSETS.feianSeeds)) {
      expect(PROMPT_ASSETS.supersededFeianSha1).not.toContain(
        await sha1Of(body.replace(/\r\n/g, "\n")),
      );
    }
  });

  it('lang: "en" materializes the EN seeds into narrative-en, leaving the zh dir untouched', async () => {
    // Per-language corpora (EN-dream slice): EN seeds its OWN
    // `.herta/narrative-en` dir, wholly isolated from the zh `.herta/narrative`
    // — no more shared-dir mixing, so EN now grows real on-disk memory.
    await materializeSeedFeian(root, "en");
    const enDir = join(root, ".herta", "narrative-en");
    const files = readdirSync(enDir);
    for (const name of Object.keys(PROMPT_ASSETS_EN.feianSeeds)) {
      expect(files).toContain(name);
    }
    expect(existsSync(narrativeDir())).toBe(false); // zh dir never created
  });

  it("seeding one language never touches the other's corpus (separate dirs)", async () => {
    await materializeSeedFeian(root, "zh");
    const [name] = Object.keys(PROMPT_ASSETS.feianSeeds);
    const before = readFileSync(join(narrativeDir(), name as string), "utf-8");
    await materializeSeedFeian(root, "en"); // writes to narrative-en, not narrative
    const after = readFileSync(join(narrativeDir(), name as string), "utf-8");
    expect(after).toBe(before); // zh seeds untouched — no mixing
  });
});
