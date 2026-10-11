import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseHtmlDocument } from "./parse-html.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = join(__dirname, "..", "testing", "fixtures");

function fixture(name: string): string {
  return readFileSync(join(FIX, name), "utf8");
}

describe("parseHtmlDocument", () => {
  it("extracts title and source URL from character profile", () => {
    const d = parseHtmlDocument(fixture("character-profile-doll.html"));
    expect(d.title).toBe("黑塔");
    expect(d.url).toBe("https://wiki.example.com/page/078");
  });

  it("extracts blocks under their section paths and drops boilerplate", () => {
    const d = parseHtmlDocument(fixture("character-profile-doll.html"));
    const story = d.blocks.find((b) => b.text.includes("人偶"));
    expect(story?.sectionPath).toEqual(["角色故事"]);
    expect(d.blocks.some((b) => b.text.includes("著作权归原作者"))).toBe(false);
  });

  it("parses dialogue list items into speaker blocks", () => {
    const d = parseHtmlDocument(fixture("mission-dialogue.html"));
    const lines = d.blocks.filter((b) => b.kind === "dialogue");
    expect(lines.length).toBeGreaterThanOrEqual(3);
    const herta = lines.find(
      (b) => b.speaker === "黑塔" && b.text.includes("远程操纵"),
    );
    expect(herta?.sectionPath).toEqual(["剧情内容", "与黑塔交谈"]);
  });

  it("returns paragraph blocks for world-lore pages", () => {
    const d = parseHtmlDocument(fixture("world-lore-station.html"));
    expect(
      d.blocks.some(
        (b) => b.kind === "paragraph" && b.text.includes("天才俱乐部"),
      ),
    ).toBe(true);
  });
});
