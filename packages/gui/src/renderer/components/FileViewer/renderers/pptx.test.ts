import { readFileSync } from "node:fs";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import {
  type LineShape,
  type PictureShape,
  parseDeck,
  type TableShape,
  type TextShape,
} from "./pptx.js";

const fixture = new Uint8Array(
  readFileSync(join(import.meta.dirname, "__fixtures__", "fixture.pptx")),
);

const texts = (shapes: readonly { kind: string }[]): TextShape[] =>
  shapes.filter((s): s is TextShape => s.kind === "text");
const textOf = (s: TextShape): string =>
  s.paragraphs.map((p) => p.runs.map((r) => r.text).join("")).join("\n");

describe("pptx reader (ADR 0054 §4) — a pptxgenjs-written deck", () => {
  const media = vi.fn((path: string) => `blob:${path}`);
  const deck = parseDeck(fixture, media);

  it("reads the slide size in px and the slides in order, with a title each", () => {
    expect(deck.width).toBe(960);
    expect(deck.height).toBe(540);
    expect(deck.slides).toHaveLength(3);
    expect(deck.slides.map((s) => s.index)).toEqual([1, 2, 3]);
    expect(deck.slides[0]?.title).toContain("Deck fixture");
    expect(deck.slidesCapped).toBe(false);
  });

  it("title slide: the background color and a centered bold run at 36pt in its color", () => {
    const s = deck.slides[0];
    expect(s?.background).toEqual({ kind: "solid", color: "#f3f6fa" });
    const title = texts(s?.shapes ?? []).find((t) =>
      textOf(t).includes("Deck fixture"),
    );
    expect(title).toBeDefined();
    const run = title?.paragraphs[0]?.runs[0];
    expect(run?.size).toBeCloseTo(48, 1);
    expect(run?.bold).toBe(true);
    expect(run?.color).toBe("#1f2937");
    expect(title?.paragraphs[0]?.align).toBe("center");
    expect(title?.box.x).toBeCloseTo(48, 0);
    expect(title?.box.w).toBeCloseTo(864, 0);
  });

  it("bullets slide: bullet paragraphs with a deeper level, a filled rounded box with a line, a picture, a connector line", () => {
    const s = deck.slides[1];
    const list = texts(s?.shapes ?? []).find((t) => textOf(t).includes("one"));
    expect(list).toBeDefined();
    const paras =
      list?.paragraphs.filter((p) => p.runs.some((r) => r.text.length > 0)) ??
      [];
    expect(paras.length).toBeGreaterThanOrEqual(3);
    expect(paras.every((p) => p.bullet !== null)).toBe(true);
    const deeper = paras.find((p) =>
      p.runs.some((r) => r.text.includes("indent")),
    );
    const first = paras[0];
    expect(deeper && first && deeper.marL > first.marL).toBe(true);

    const box = texts(s?.shapes ?? []).find(
      (t) => t.fill?.kind === "solid" && t.fill.color === "#4472c4",
    );
    expect(box).toBeDefined();
    expect(box?.geometry).toBe("roundRect");
    expect(box?.line?.color).toBe("#1f3b73");
    expect(box?.line?.width).toBeCloseTo(2.67, 1);

    const pic = s?.shapes.find((x): x is PictureShape => x.kind === "picture");
    expect(pic?.src.startsWith("blob:ppt/media/")).toBe(true);
    expect(media).toHaveBeenCalledTimes(1);
    expect(pic?.box.w).toBeCloseTo(96, 0);

    const line = s?.shapes.find((x): x is LineShape => x.kind === "line");
    expect(line?.line.color).toBe("#9ca3af");
    expect(line?.box.w).toBeCloseTo(864, 0);
  });

  it("table slide: rows, cells, a header fill and CJK text", () => {
    const s = deck.slides[2];
    const table = s?.shapes.find((x): x is TableShape => x.kind === "table");
    expect(table).toBeDefined();
    expect(table?.rows).toHaveLength(3);
    expect(table?.rows[0]?.cells).toHaveLength(2);
    expect(table?.colWidths.map((w) => Math.round(w))).toEqual([288, 288]);
    expect(table?.rows[0]?.cells[0]?.fill).toEqual({
      kind: "solid",
      color: "#e5e7eb",
    });
    const cellText = (r: number, c: number): string =>
      table?.rows[r]?.cells[c]?.paragraphs
        .map((p) => p.runs.map((x) => x.text).join(""))
        .join("") ?? "";
    expect(cellText(0, 0)).toBe("Col A");
    expect(cellText(2, 0)).toBe("a2 中文");
  });
});

/** A hand-built package exercising what pptxgenjs never writes: a
 *  placeholder inheriting its box from the layout, theme colors through
 *  the master's color map, master decorations under the slide, a group
 *  transform, and a gradient background. */
function handBuilt(): Uint8Array {
  const NS = `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"`;
  const rel = (id: string, type: string, target: string): string =>
    `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
  const rels = (body: string): string =>
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`;
  return zipSync({
    "ppt/presentation.xml": strToU8(
      `<p:presentation ${NS}><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`,
    ),
    "ppt/_rels/presentation.xml.rels": strToU8(
      rels(rel("rId1", "slide", "slides/slide1.xml")),
    ),
    "ppt/slides/slide1.xml": strToU8(
      `<p:sld ${NS}><p:cSld><p:spTree>
        <p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="en"/><a:t>Inherited title</a:t></a:r></a:p></p:txBody></p:sp>
        <p:sp><p:nvSpPr><p:cNvPr id="3" name="Accent"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="914400" cy="457200"/></a:xfrm><a:prstGeom prst="rect"/><a:solidFill><a:schemeClr val="accent1"><a:lumMod val="50000"/></a:schemeClr></a:solidFill></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="en"><a:solidFill><a:schemeClr val="bg1"/></a:solidFill></a:rPr><a:t>on accent</a:t></a:r></a:p></p:txBody></p:sp>
        <p:grpSp><p:nvGrpSpPr><p:cNvPr id="4" name="G"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="1828800" y="1828800"/><a:ext cx="1828800" cy="914400"/><a:chOff x="0" y="0"/><a:chExt cx="914400" cy="457200"/></a:xfrm></p:grpSpPr>
          <p:sp><p:nvSpPr><p:cNvPr id="5" name="child"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="0"/><a:ext cx="457200" cy="457200"/></a:xfrm><a:prstGeom prst="ellipse"/><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></p:spPr></p:sp>
        </p:grpSp>
      </p:spTree></p:cSld></p:sld>`,
    ),
    "ppt/slides/_rels/slide1.xml.rels": strToU8(
      rels(rel("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml")),
    ),
    "ppt/slideLayouts/slideLayout1.xml": strToU8(
      `<p:sldLayout ${NS}><p:cSld><p:spTree>
        <p:sp><p:nvSpPr><p:cNvPr id="2" name="Title ph"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="228600"/><a:ext cx="8229600" cy="1143000"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle><a:lvl1pPr algn="ctr"><a:defRPr sz="4000"/></a:lvl1pPr></a:lstStyle><a:p/></p:txBody></p:sp>
      </p:spTree></p:cSld></p:sldLayout>`,
    ),
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels": strToU8(
      rels(rel("rId1", "slideMaster", "../slideMasters/slideMaster1.xml")),
    ),
    "ppt/slideMasters/slideMaster1.xml": strToU8(
      `<p:sldMaster ${NS}><p:cSld><p:bg><p:bgPr><a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="FFFFFF"/></a:gs><a:gs pos="100000"><a:schemeClr val="accent2"/></a:gs></a:gsLst><a:lin ang="5400000"/></a:gradFill></p:bgPr></p:bg><p:spTree>
        <p:sp><p:nvSpPr><p:cNvPr id="9" name="Footer band"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="6400800"/><a:ext cx="9144000" cy="457200"/></a:xfrm><a:prstGeom prst="rect"/><a:solidFill><a:schemeClr val="tx2"/></a:solidFill></p:spPr></p:sp>
        <p:sp><p:nvSpPr><p:cNvPr id="10" name="Title prompt"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:t>Click to add title</a:t></a:r></a:p></p:txBody></p:sp>
      </p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
      <p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4400" b="1"><a:solidFill><a:schemeClr val="tx2"/></a:solidFill></a:defRPr></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:buChar char="•"/><a:defRPr sz="2000"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`,
    ),
    "ppt/slideMasters/_rels/slideMaster1.xml.rels": strToU8(
      rels(rel("rId1", "theme", "../theme/theme1.xml")),
    ),
    "ppt/theme/theme1.xml": strToU8(
      `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="T"><a:themeElements><a:clrScheme name="T"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F3864"/></a:dk2><a:lt2><a:srgbClr val="EEEEEE"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme></a:themeElements></a:theme>`,
    ),
  });
}

describe("pptx reader — inheritance and theme (hand-built package)", () => {
  const deck = parseDeck(handBuilt(), (p) => `blob:${p}`);
  const slide = deck.slides[0];

  it("a placeholder without a box takes the layout's, and its text style from layout then master", () => {
    const title = texts(slide?.shapes ?? []).find(
      (t) => textOf(t) === "Inherited title",
    );
    expect(title).toBeDefined();
    expect(title?.box).toMatchObject({ x: 48, y: 24, w: 864, h: 120 });
    // Layout says 40pt centered; master's titleStyle says bold in tx2.
    expect(title?.paragraphs[0]?.align).toBe("center");
    expect(title?.paragraphs[0]?.runs[0]?.size).toBeCloseTo(53.33, 1);
    expect(title?.paragraphs[0]?.runs[0]?.bold).toBe(true);
    expect(title?.paragraphs[0]?.runs[0]?.color).toBe("#1f3864");
  });

  it("theme colors resolve through the color map, with luminance modifiers, and bg1 maps to lt1", () => {
    const accent = texts(slide?.shapes ?? []).find(
      (t) => textOf(t) === "on accent",
    );
    // accent1 4472C4 at lumMod 50% — Office's own "darker 50%" swatch.
    expect(accent?.fill).toEqual({ kind: "solid", color: "#203864" });
    expect(accent?.paragraphs[0]?.runs[0]?.color).toBe("#ffffff");
  });

  it("the master's decoration draws under the slide's shapes; its placeholder prompt does not", () => {
    const shapes = slide?.shapes ?? [];
    const band = texts(shapes).find(
      (t) => t.fill?.kind === "solid" && t.fill.color === "#1f3864",
    );
    expect(band).toBeDefined();
    expect(shapes.indexOf(band as TextShape)).toBe(0);
    expect(texts(shapes).some((t) => textOf(t).includes("Click to add"))).toBe(
      false,
    );
  });

  it("group children take the group's transform", () => {
    const circle = texts(slide?.shapes ?? []).find(
      (t) => t.geometry === "ellipse",
    );
    // Group at (192,192) size 192x96 over a 96x48 child space: the child at
    // (48,0) 48x48 lands at (288,192) 96x96.
    expect(circle?.box).toMatchObject({ x: 288, y: 192, w: 96, h: 96 });
  });

  it("a gradient background from the master becomes a CSS gradient", () => {
    expect(slide?.background?.kind).toBe("gradient");
    if (slide?.background?.kind === "gradient") {
      expect(slide.background.css).toBe(
        "linear-gradient(180deg, #ffffff 0%, #ed7d31 100%)",
      );
    }
  });

  it("refuses a package that is not a presentation", () => {
    expect(() =>
      parseDeck(zipSync({ "x.txt": strToU8("x") }), (p) => p),
    ).toThrow();
  });
});
