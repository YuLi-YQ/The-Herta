import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCleanPass } from "./run-clean-pass.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "__fixtures__");

describe("runCleanPass", () => {
  let outDir: string;
  beforeEach(() => {
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), "self-model-clean-"));
  });
  afterEach(() => fs.rmSync(outDir, { recursive: true, force: true }));

  it("writes one cleaned .txt per input HTML", async () => {
    const result = await runCleanPass({
      sources: [path.join(FIXTURES, "herta-direct.html")],
      outDir,
      cacheDir: outDir,
    });
    expect(result.cleaned).toHaveLength(1);
    const written = fs.readFileSync(
      path.join(outDir, "herta-direct.txt"),
      "utf8",
    );
    expect(written).toContain("== 大黑塔 ==");
    expect(written).toContain("天才俱乐部 #83");
    expect(written).toMatch(/\[黑塔\]\s+你也来看实验/);
  });

  it("returns cache_hit when source content unchanged across runs", async () => {
    const sources = [path.join(FIXTURES, "herta-direct.html")];
    const first = await runCleanPass({ sources, outDir, cacheDir: outDir });
    expect(first.cleaned[0]?.cacheHit).toBe(false);

    const second = await runCleanPass({ sources, outDir, cacheDir: outDir });
    expect(second.cleaned[0]?.cacheHit).toBe(true);
  });

  it("re-cleans when source content changes", async () => {
    const tmpHtml = path.join(outDir, "tmp.html");
    fs.writeFileSync(tmpHtml, "<html><body><h1>A</h1></body></html>", "utf8");
    const first = await runCleanPass({
      sources: [tmpHtml],
      outDir,
      cacheDir: outDir,
    });
    expect(first.cleaned[0]?.cacheHit).toBe(false);

    fs.writeFileSync(tmpHtml, "<html><body><h1>B</h1></body></html>", "utf8");
    const second = await runCleanPass({
      sources: [tmpHtml],
      outDir,
      cacheDir: outDir,
    });
    expect(second.cleaned[0]?.cacheHit).toBe(false);
  });

  it("creates outDir if it does not exist", async () => {
    const newOutDir = path.join(outDir, "nested", "deeper");
    await runCleanPass({
      sources: [path.join(FIXTURES, "herta-direct.html")],
      outDir: newOutDir,
      cacheDir: outDir,
    });
    expect(fs.existsSync(path.join(newOutDir, "herta-direct.txt"))).toBe(true);
  });

  it("handles multiple sources", async () => {
    const sources = [
      path.join(FIXTURES, "herta-direct.html"),
      path.join(FIXTURES, "no-mention.html"),
    ];
    const result = await runCleanPass({ sources, outDir, cacheDir: outDir });
    expect(result.cleaned).toHaveLength(2);
    expect(fs.existsSync(path.join(outDir, "herta-direct.txt"))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "no-mention.txt"))).toBe(true);
  });

  it("activates the br-fallback when parseHtmlDocument returns 0 blocks", async () => {
    const result = await runCleanPass({
      sources: [path.join(FIXTURES, "div-br-structure.html")],
      outDir,
      cacheDir: outDir,
    });
    expect(result.cleaned[0]?.usedFallback).toBe(true);
    const written = fs.readFileSync(
      path.join(outDir, "div-br-structure.txt"),
      "utf8",
    );
    expect(written).toContain("黑塔");
    expect(written).toContain("第一句对话");
    expect(written).toContain("第二句对话");
  });

  it("does NOT activate the fallback for canonical p/li/td/blockquote files", async () => {
    const result = await runCleanPass({
      sources: [path.join(FIXTURES, "herta-direct.html")],
      outDir,
      cacheDir: outDir,
    });
    expect(result.cleaned[0]?.usedFallback).toBe(false);
  });
});
