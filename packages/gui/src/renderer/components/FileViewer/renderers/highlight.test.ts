import { describe, expect, it } from "vitest";
import { CODE_LANGUAGE_IDS } from "../viewer-kind.js";
import {
  hasLanguage,
  highlightToHtml,
  MAX_HIGHLIGHT_CHARS,
  REGISTERED_LANGUAGE_IDS,
} from "./highlight.js";

describe("viewer highlighter (ADR 0054 §4)", () => {
  it("registers exactly the ids the extension map can name, plus markdown for the source view", () => {
    expect(REGISTERED_LANGUAGE_IDS).toEqual(
      [...CODE_LANGUAGE_IDS, "markdown"].sort(),
    );
  });

  it("knows the common fence aliases through highlight.js's own alias table", () => {
    for (const alias of ["ts", "js", "py", "sh", "yml", "html", "zsh"])
      expect(hasLanguage(alias), alias).toBe(true);
    expect(hasLanguage("no-such-language")).toBe(false);
  });

  it("tokenizes into hljs spans and escapes the source", () => {
    const html = highlightToHtml('const a = "<b>";', "typescript");
    expect(html).toContain('class="hljs-keyword"');
    expect(html).toContain("&lt;b&gt;");
    expect(html).not.toContain("<b>");
  });

  it("answers null for an unknown language or an oversize file (plain text path)", () => {
    expect(highlightToHtml("x", "no-such-language")).toBeNull();
    expect(
      highlightToHtml("x".repeat(MAX_HIGHLIGHT_CHARS + 1), "json"),
    ).toBeNull();
  });
});
