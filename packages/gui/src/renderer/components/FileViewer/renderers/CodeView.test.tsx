import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithLocale } from "../../../i18n/test-util.js";
import { CodeView } from "./CodeView.js";
import { LINES_PER_CHUNK } from "./highlight-chunks.js";

const source = (n: number, tag: string): string[] =>
  Array.from(
    { length: n },
    (_, i) => `const ${tag}${i} = ${i}; // line ${i + 1}`,
  );

describe("CodeView — the text as blocks, the tokens landing block by block (ADR 0068 §13)", () => {
  it("renders LINES_PER_CHUNK lines per block and colours every block in without moving a line", {
    timeout: 30_000,
  }, async () => {
    const lines = source(LINES_PER_CHUNK * 2 + 50, "v");
    const { container } = renderWithLocale(
      <CodeView
        content={lines.join("\n")}
        truncated={false}
        language="typescript"
      />,
    );
    const pre = container.querySelector(".file-viewer__text") as HTMLElement;
    const chunks = (): Element[] =>
      Array.from(pre.querySelectorAll(".file-viewer__chunk"));
    // Plain first: three blocks, the lines split between them, no newline
    // at a block's end (the block boundary is the line break).
    expect(chunks()).toHaveLength(3);
    expect(chunks()[0]?.textContent).toBe(
      lines.slice(0, LINES_PER_CHUNK).join("\n"),
    );
    expect(chunks()[1]?.textContent).toBe(
      lines.slice(LINES_PER_CHUNK, LINES_PER_CHUNK * 2).join("\n"),
    );
    expect(chunks()[2]?.textContent).toBe(
      lines.slice(LINES_PER_CHUNK * 2).join("\n"),
    );
    expect(chunks()[0]?.querySelector(".hljs-keyword")).toBeNull();
    // The gutter still counts every line once.
    expect(
      container.querySelector(".file-viewer__gutter")?.textContent?.split("\n"),
    ).toHaveLength(lines.length);
    // Then the tokens, in every block, the text unchanged. (jsdom's DOM is
    // slow under DOMPurify — seconds for three blocks — hence the bound.)
    await waitFor(
      () => {
        for (const c of chunks())
          expect(c.querySelector(".hljs-keyword")).not.toBeNull();
      },
      { timeout: 20_000 },
    );
    expect(chunks()).toHaveLength(3);
    expect(chunks()[1]?.textContent).toBe(
      lines.slice(LINES_PER_CHUNK, LINES_PER_CHUNK * 2).join("\n"),
    );
    expect(chunks()[2]?.textContent).toBe(
      lines.slice(LINES_PER_CHUNK * 2).join("\n"),
    );
  });

  it("a small file is one block, coloured in one step, its text intact to the trailing newline", async () => {
    const { container } = renderWithLocale(
      <CodeView
        content={"const a = 1;\n"}
        truncated={false}
        language="typescript"
      />,
    );
    const pre = container.querySelector(".file-viewer__text") as HTMLElement;
    expect(pre.querySelectorAll(".file-viewer__chunk")).toHaveLength(1);
    expect(pre.textContent).toBe("const a = 1;\n");
    await waitFor(() =>
      expect(pre.querySelector(".hljs-keyword")).not.toBeNull(),
    );
    expect(pre.textContent).toBe("const a = 1;\n");
  });

  it("new content rebuilds the blocks, and the old content's answer never lands on them", {
    timeout: 30_000,
  }, async () => {
    const first = source(LINES_PER_CHUNK + 10, "a");
    const second = source(LINES_PER_CHUNK + 10, "b");
    const view = (lines: string[]): JSX.Element => (
      <CodeView
        content={lines.join("\n")}
        truncated={false}
        language="typescript"
      />
    );
    const h = renderWithLocale(view(first));
    const pre = (): HTMLElement =>
      h.container.querySelector(".file-viewer__text") as HTMLElement;
    expect(pre().textContent).toContain("const a0 = 0;");
    // Swap the content before (or while) the first answer lands.
    h.rerender(view(second));
    expect(pre().querySelectorAll(".file-viewer__chunk")).toHaveLength(2);
    expect(pre().textContent).toContain("const b0 = 0;");
    expect(pre().textContent).not.toContain("const a0 = 0;");
    await waitFor(
      () => {
        for (const c of pre().querySelectorAll(".file-viewer__chunk"))
          expect(c.querySelector(".hljs-keyword")).not.toBeNull();
      },
      { timeout: 20_000 },
    );
    // Every block holds the SECOND content's lines, tokens included.
    expect(pre().textContent).toContain("const b0 = 0;");
    expect(pre().textContent).not.toContain("const a0 = 0;");
    expect(pre().querySelectorAll(".file-viewer__chunk")[1]?.textContent).toBe(
      second.slice(LINES_PER_CHUNK).join("\n"),
    );
  });
});
