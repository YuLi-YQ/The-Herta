import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractFromBrStructure } from "./br-fallback-extractor.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "__fixtures__");

describe("extractFromBrStructure", () => {
  it("returns the document title from <h1>", () => {
    const html = "<html><body><h1>测试标题</h1></body></html>";
    const doc = extractFromBrStructure(html);
    expect(doc.title).toBe("测试标题");
  });

  it("falls back to <title> when no <h1>", () => {
    const html = "<html><head><title>页头</title></head><body></body></html>";
    const doc = extractFromBrStructure(html);
    expect(doc.title).toBe("页头");
  });

  it("converts <br/> and <br> to paragraph breaks", () => {
    const html =
      "<html><body><div>第一行<br/>第二行<br>第三行</div></body></html>";
    const doc = extractFromBrStructure(html);
    const texts = doc.blocks.map((b) => b.text);
    expect(texts).toContain("第一行");
    expect(texts).toContain("第二行");
    expect(texts).toContain("第三行");
  });

  it("strips script and style content", () => {
    const html =
      "<html><body><script>alert(1)</script><style>body{}</style><div>实际内容<br/></div></body></html>";
    const doc = extractFromBrStructure(html);
    const allText = doc.blocks.map((b) => b.text).join("\n");
    expect(allText).not.toContain("alert");
    expect(allText).not.toContain("body{}");
    expect(allText).toContain("实际内容");
  });

  it("filters empty / whitespace-only segments", () => {
    const html =
      "<html><body><div>有内容<br/><br/>   <br/>更多内容</div></body></html>";
    const doc = extractFromBrStructure(html);
    const texts = doc.blocks.map((b) => b.text);
    expect(texts).toContain("有内容");
    expect(texts).toContain("更多内容");
    expect(texts).not.toContain("");
    expect(texts).not.toContain("   ");
  });

  it("emits blocks as paragraph kind with empty sectionPath", () => {
    const html = "<html><body><div>x<br/>y</div></body></html>";
    const doc = extractFromBrStructure(html);
    expect(doc.blocks.length).toBeGreaterThan(0);
    for (const b of doc.blocks) {
      expect(b.kind).toBe("paragraph");
      expect(b.sectionPath).toEqual([]);
    }
  });

  it("on the div-br fixture: extracts the dialogue lines", () => {
    const html = fs.readFileSync(
      path.join(FIXTURES, "div-br-structure.html"),
      "utf8",
    );
    const doc = extractFromBrStructure(html);
    const allText = doc.blocks.map((b) => b.text).join(" ");
    expect(allText).toContain("黑塔");
    expect(allText).toContain("天才俱乐部#83");
    expect(allText).toContain("第一句对话");
    expect(allText).toContain("第二句对话");
  });

  it("returns empty blocks for an empty body", () => {
    const html = "<html><body></body></html>";
    const doc = extractFromBrStructure(html);
    expect(doc.blocks).toEqual([]);
  });

  it("collapses runs of whitespace within a segment", () => {
    const html =
      "<html><body><div>foo    bar\n\n\nbaz<br/></div></body></html>";
    const doc = extractFromBrStructure(html);
    expect(doc.blocks[0]?.text).toBe("foo bar baz");
  });
});
