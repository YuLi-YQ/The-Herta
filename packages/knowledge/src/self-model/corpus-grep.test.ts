import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { categorizeFromPath, grepCorpusForHerta } from "./corpus-grep.js";

describe("categorizeFromPath", () => {
  it("data/角色图鉴/ → character_page", () => {
    expect(categorizeFromPath("data/角色图鉴/019_大黑塔.html")).toBe(
      "character_page",
    );
  });
  it("data/book_html/ → book", () => {
    expect(categorizeFromPath("data/book_html/013_黑塔的手稿.html")).toBe(
      "book",
    );
  });
  it("data/plot_html/ → mission", () => {
    expect(categorizeFromPath("data/plot_html/开拓任务/082_x.html")).toBe(
      "mission",
    );
  });
  it("data/星海纪闻/ → station_lore", () => {
    expect(categorizeFromPath("data/星海纪闻/003_空间站「黑塔」.html")).toBe(
      "station_lore",
    );
  });
  it("data/编年史/ → chronicle", () => {
    expect(categorizeFromPath("data/编年史/001_银河编年史.html")).toBe(
      "chronicle",
    );
  });
  it("data/plot_html/模拟宇宙/ → sim_universe", () => {
    expect(categorizeFromPath("data/plot_html/模拟宇宙/x.html")).toBe(
      "sim_universe",
    );
  });
  it("unrecognized location → incidental_mention", () => {
    expect(categorizeFromPath("/random/path.html")).toBe("incidental_mention");
  });
});

describe("grepCorpusForHerta", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "corpus-grep-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function write(rel: string, content: string): string {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
    return abs;
  }

  it("counts Herta mentions across the trigger phrases", async () => {
    write(
      "角色图鉴/019_大黑塔.html",
      "<html><body><p>大黑塔是天才俱乐部 #83。</p><p>黑塔本人。</p></body></html>",
    );
    const candidates = await grepCorpusForHerta({ root: dir });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.mention_count).toBeGreaterThanOrEqual(2);
  });

  it("excludes files with zero mentions", async () => {
    write(
      "角色图鉴/三月七.html",
      "<html><body><p>三月七是列车成员。</p></body></html>",
    );
    const candidates = await grepCorpusForHerta({ root: dir });
    expect(candidates).toHaveLength(0);
  });

  it("emits up to N snippet previews per file", async () => {
    write(
      "角色图鉴/019_大黑塔.html",
      `<html><body>${"<p>大黑塔做实验</p>".repeat(20)}</body></html>`,
    );
    const candidates = await grepCorpusForHerta({
      root: dir,
      maxPreviewsPerFile: 3,
    });
    expect(candidates[0]?.snippet_previews.length).toBeLessThanOrEqual(3);
  });

  it("traverses nested subdirectories", async () => {
    write(
      "plot_html/开拓任务/082_x.html",
      "<html><body><p>大黑塔出现在这里。</p></body></html>",
    );
    write(
      "plot_html/开拓任务/099_y.html",
      "<html><body><p>无关。</p></body></html>",
    );
    const candidates = await grepCorpusForHerta({ root: dir });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.path).toContain("082_x.html");
  });

  it("classifies path-based category", async () => {
    write(
      "book_html/013_黑塔的手稿.html",
      "<html><body><p>大黑塔的手稿内容。</p></body></html>",
    );
    const candidates = await grepCorpusForHerta({ root: dir });
    expect(candidates[0]?.category).toBe("book");
  });

  it("default accepted=false (human reviews and flips)", async () => {
    write(
      "角色图鉴/019_大黑塔.html",
      "<html><body><p>大黑塔。</p></body></html>",
    );
    const candidates = await grepCorpusForHerta({ root: dir });
    expect(candidates[0]?.accepted).toBe(false);
  });

  it("ignores non-HTML files", async () => {
    write("notes.txt", "大黑塔");
    const candidates = await grepCorpusForHerta({ root: dir });
    expect(candidates).toHaveLength(0);
  });
});
