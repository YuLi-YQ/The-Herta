import { describe, expect, it } from "vitest";
import { CODE_LANGUAGE_IDS, needsBytes, viewerKindFor } from "./viewer-kind.js";

describe("viewerKindFor (ADR 0054 §1)", () => {
  it("maps the rich kinds by extension, case-insensitively, on any path spelling", () => {
    expect(viewerKindFor("docs/notes.md").kind).toBe("markdown");
    expect(viewerKindFor("README.MARKDOWN").kind).toBe("markdown");
    expect(viewerKindFor("E:\\repo\\report.PDF").kind).toBe("pdf");
    expect(viewerKindFor("a/b/c.docx").kind).toBe("docx");
    expect(viewerKindFor("data.xlsx").kind).toBe("xlsx");
    expect(viewerKindFor("macro.xlsm").kind).toBe("xlsx");
    expect(viewerKindFor("deck.pptx").kind).toBe("pptx");
    expect(viewerKindFor("rows.csv").kind).toBe("csv");
    expect(viewerKindFor("rows.tsv").kind).toBe("csv");
    expect(viewerKindFor("shot.png").kind).toBe("image");
    expect(viewerKindFor("logo.svg").kind).toBe("image");
  });

  it("maps code by extension with a highlighter language, bare Dockerfile/Makefile included", () => {
    expect(viewerKindFor("src/a.ts")).toEqual({
      kind: "code",
      language: "typescript",
    });
    expect(viewerKindFor("x.tsx").language).toBe("typescript");
    expect(viewerKindFor("index.mjs").language).toBe("javascript");
    expect(viewerKindFor("main.py").language).toBe("python");
    expect(viewerKindFor("Dockerfile")).toEqual({
      kind: "code",
      language: "dockerfile",
    });
    expect(viewerKindFor("build/Makefile").language).toBe("makefile");
    expect(viewerKindFor("index.html").language).toBe("xml");
    expect(viewerKindFor("run.ps1").language).toBe("powershell");
  });

  it("everything else — unknown extensions, no extension, a trailing dot — is text (ADR 0050 behaviour)", () => {
    expect(viewerKindFor("notes.txt")).toEqual({ kind: "text" });
    expect(viewerKindFor("LICENSE")).toEqual({ kind: "text" });
    expect(viewerKindFor("weird.")).toEqual({ kind: "text" });
    expect(viewerKindFor("archive.zip")).toEqual({ kind: "text" });
    // The attachment store's extracted text keeps the source name plus
    // .txt — it is text, not a PDF.
    expect(viewerKindFor(".herta/attachments/s/report.pdf.txt")).toEqual({
      kind: "text",
    });
  });

  it("needsBytes names exactly the kinds that leave the text read", () => {
    expect(needsBytes("image")).toBe(true);
    expect(needsBytes("pdf")).toBe(true);
    expect(needsBytes("docx")).toBe(true);
    expect(needsBytes("xlsx")).toBe(true);
    expect(needsBytes("pptx")).toBe(true);
    for (const k of ["markdown", "code", "text", "csv"] as const)
      expect(needsBytes(k), k).toBe(false);
  });

  it("the language id list is deduplicated and sorted (the highlighter pins itself to it)", () => {
    expect(CODE_LANGUAGE_IDS).toEqual([...new Set(CODE_LANGUAGE_IDS)].sort());
    expect(CODE_LANGUAGE_IDS).toContain("typescript");
    expect(CODE_LANGUAGE_IDS).toContain("diff");
  });
});
