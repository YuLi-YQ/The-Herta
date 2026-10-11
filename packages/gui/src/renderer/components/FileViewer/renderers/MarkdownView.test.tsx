import { configure, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// The diagram and highlighter passes wait on lazy chunks; under full-suite
// contention the default 1s async timeout has flaked (2026-09-03).
configure({ asyncUtilTimeout: 5000 });

import { LocaleProvider } from "../../../i18n/LocaleProvider.js";
import { MarkdownView } from "./MarkdownView.js";

vi.mock("./mermaid-render.js", () => ({
  renderMermaid: async (code: string) => {
    if (code.includes("broken")) throw new Error("parse error");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("data-diagram", "yes");
    return svg;
  },
}));

function ui(content: string): JSX.Element {
  return (
    <LocaleProvider locale="en" onLocaleChange={() => {}}>
      <MarkdownView content={content} truncated={false} />
    </LocaleProvider>
  );
}

describe("MarkdownView (ADR 0054 §4/§5)", () => {
  it("renders GFM — headings, a table, a task list — through the sanitizer", async () => {
    const { container } = render(
      ui(
        "# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n",
      ),
    );
    const doc = container.querySelector(".file-viewer__doc") as HTMLElement;
    expect(doc.querySelector("h1")?.textContent).toBe("Title");
    expect(doc.querySelectorAll("td")).toHaveLength(2);
    expect(doc.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    // marked's task-list checkboxes are inputs; the sanitizer forbids form
    // controls, so the items stay as text with their li intact.
    expect(doc.querySelectorAll("li")).toHaveLength(2);
    await waitFor(() => expect(doc.querySelector("h1")).not.toBeNull());
  });

  it("strips scripts and event handlers, and disarms links (href → data-href)", () => {
    // The raw-HTML line is a CommonMark HTML block (no inline parsing), so
    // the Markdown link sits in its own paragraph.
    const { container } = render(
      ui(
        '<script>alert(1)</script><img src="x" onerror="alert(1)"> <a href="javascript:alert(1)">j</a>\n\n[go](https://example.com)\n',
      ),
    );
    const doc = container.querySelector(".file-viewer__doc") as HTMLElement;
    expect(doc.querySelector("script")).toBeNull();
    expect(doc.querySelector("img")?.getAttribute("onerror")).toBeNull();
    const links = doc.querySelectorAll("a");
    expect(links.length).toBeGreaterThan(0);
    for (const a of links) {
      expect(a.getAttribute("href")).toBeNull();
    }
    expect(
      doc.querySelector('a[data-href="https://example.com"]'),
    ).not.toBeNull();
  });

  it("swaps a mermaid fence for the diagram and labels one that fails, keeping its source", async () => {
    const { container } = render(
      ui("```mermaid\ngraph TD; A-->B\n```\n\n```mermaid\nbroken\n```\n"),
    );
    const doc = container.querySelector(".file-viewer__doc") as HTMLElement;
    await waitFor(() =>
      expect(
        doc.querySelector("figure.file-viewer__diagram svg[data-diagram]"),
      ).not.toBeNull(),
    );
    await waitFor(() =>
      expect(doc.querySelector(".file-viewer__diagram-failed")).not.toBeNull(),
    );
    expect(
      doc.querySelector("pre > code.language-mermaid")?.textContent,
    ).toContain("broken");
  });

  it("tokenizes other fences with the highlighter once its chunk lands", async () => {
    const { container } = render(ui("```ts\nconst x: number = 1;\n```\n"));
    const doc = container.querySelector(".file-viewer__doc") as HTMLElement;
    await waitFor(() =>
      expect(
        doc.querySelector("code.language-ts .hljs-keyword"),
      ).not.toBeNull(),
    );
  });
});
