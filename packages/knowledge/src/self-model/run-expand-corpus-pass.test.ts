import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runExpandCorpusPass } from "./run-expand-corpus-pass.js";
import { corpusManifestSchema } from "./schema.js";

describe("runExpandCorpusPass", () => {
  let corpusDir: string;
  let outDir: string;

  beforeEach(() => {
    corpusDir = fs.mkdtempSync(path.join(os.tmpdir(), "expand-corpus-"));
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), "expand-corpus-out-"));
    fs.mkdirSync(path.join(corpusDir, "角色图鉴"), { recursive: true });
    fs.writeFileSync(
      path.join(corpusDir, "角色图鉴", "019_大黑塔.html"),
      "<html><body><p>大黑塔是天才俱乐部 #83。</p></body></html>",
      "utf8",
    );
  });
  afterEach(() => {
    fs.rmSync(corpusDir, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  function manifestPath(): string {
    return path.join(outDir, "corpus-manifest.json");
  }

  it("creates a manifest at the expected path", async () => {
    await runExpandCorpusPass({
      corpusRoot: corpusDir,
      manifestPath: manifestPath(),
    });
    expect(fs.existsSync(manifestPath())).toBe(true);
  });

  it("manifest validates against corpusManifestSchema", async () => {
    await runExpandCorpusPass({
      corpusRoot: corpusDir,
      manifestPath: manifestPath(),
    });
    const raw = JSON.parse(fs.readFileSync(manifestPath(), "utf8")) as unknown;
    expect(() => corpusManifestSchema.parse(raw)).not.toThrow();
  });

  it("default candidates have accepted: false", async () => {
    const result = await runExpandCorpusPass({
      corpusRoot: corpusDir,
      manifestPath: manifestPath(),
    });
    expect(result.candidates[0]?.accepted).toBe(false);
  });

  it("preserves existing accepted=true flags across re-runs", async () => {
    // First run — defaults to accepted: false.
    await runExpandCorpusPass({
      corpusRoot: corpusDir,
      manifestPath: manifestPath(),
    });
    // Simulate human flipping the flag.
    const first = JSON.parse(fs.readFileSync(manifestPath(), "utf8"));
    first.candidates[0].accepted = true;
    fs.writeFileSync(manifestPath(), JSON.stringify(first), "utf8");

    // Second run — should keep accepted: true.
    const second = await runExpandCorpusPass({
      corpusRoot: corpusDir,
      manifestPath: manifestPath(),
    });
    expect(second.candidates[0]?.accepted).toBe(true);
  });

  it("drops candidates from previous manifest that no longer have mentions", async () => {
    // Pre-seed a manifest with a stale entry pointing to a non-existent file.
    const stale = {
      version: 1,
      candidates: [
        {
          path: path.join(corpusDir, "stale.html"),
          mention_count: 5,
          snippet_previews: [],
          accepted: true,
          category: "character_page",
        },
      ],
    };
    fs.writeFileSync(manifestPath(), JSON.stringify(stale), "utf8");

    const result = await runExpandCorpusPass({
      corpusRoot: corpusDir,
      manifestPath: manifestPath(),
    });
    expect(
      result.candidates.find((c) => c.path.endsWith("stale.html")),
    ).toBeUndefined();
  });

  it("creates parent directories of manifestPath if missing", async () => {
    const nested = path.join(outDir, "a", "b", "c", "manifest.json");
    await runExpandCorpusPass({
      corpusRoot: corpusDir,
      manifestPath: nested,
    });
    expect(fs.existsSync(nested)).toBe(true);
  });
});
