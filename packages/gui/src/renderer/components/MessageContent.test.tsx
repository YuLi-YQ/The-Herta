import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageContent } from "./MessageContent.js";
import { CODE_PAGE_SIZE, codePage, exactCode } from "./message-content.js";

const openExternal = vi.fn(async () => {});
vi.mock("../context/HertaBridgeContext.js", () => ({
  useHertaBridge: () => ({ bridge: { openExternal } }),
}));
afterEach(() => vi.clearAllMocks());
function clipboard() {
  const writeText = vi.fn(async (_text: string) => {});
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}
describe("message reading", () => {
  it("renders markdown without executing HTML, images or dangerous URLs", () => {
    const { container } = render(
      <MessageContent
        text={
          '**bold**\n\n<script>alert(1)</script>\n\n<img src="https://bad.test/tracker">\n\n![remote](https://bad.test/image)\n\n[x](javascript:alert(1))\n\n[site](https://example.com/ok)'
        }
      />,
    );
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("script,img,iframe")).toBeNull();
    expect(container.querySelectorAll("a")).toHaveLength(1);
    fireEvent.click(screen.getByText("site"));
    expect(openExternal).toHaveBeenCalledWith("https://example.com/ok");
  });
  it("copies each exact fenced body and the complete original", () => {
    const write = clipboard();
    const text =
      "说明\n\n```js\n  const x = '中文';\n\n```\n\n~~~txt\nsecond\n~~~";
    render(<MessageContent text={text} />);
    const buttons = screen.getAllByText("复制代码");
    fireEvent.click(buttons[0] as HTMLElement);
    fireEvent.click(buttons[1] as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "复制原文" }));
    expect(write.mock.calls.map((call) => call[0])).toEqual([
      "  const x = '中文';\n\n",
      "second\n",
      text,
    ]);
  });
  it("keeps an unfinished fence as code across streaming updates without replacing its pre", () => {
    const { container, rerender } = render(
      <MessageContent streaming text={"```js\nconst x"} />,
    );
    const pre = container.querySelector("pre");
    expect(pre?.textContent).toBe("const x");
    rerender(<MessageContent streaming text={"```js\nconst x = 1;\n```"} />);
    expect(container.querySelector("pre")).toBe(pre);
    expect(pre?.textContent).toBe("const x = 1;\n");
  });
  it("bounds million-character code layout and preserves all page characters", () => {
    const code = "中😀\n".repeat(250000);
    const { container } = render(
      <MessageContent text={`\`\`\`txt\n${code}\`\`\``} />,
    );
    expect(
      container.querySelector("pre")?.textContent?.length,
    ).toBeLessThanOrEqual(1000);
    fireEvent.click(screen.getByText("展开代码"));
    expect(
      container.querySelector("pre")?.textContent?.length,
    ).toBeLessThanOrEqual(CODE_PAGE_SIZE);
    const stitched = Array.from(
      { length: Math.ceil(code.length / CODE_PAGE_SIZE) },
      (_, i) => codePage(code, i),
    ).join("");
    expect(stitched).toBe(code);
  });
  it("fence extraction preserves CRLF, final blank lines and unclosed content", () => {
    expect(exactCode("```ts\r\n  x\r\n\r\n```\r\n", "wrong")).toBe(
      "  x\r\n\r\n",
    );
    expect(exactCode("~~~txt\nabc", "wrong")).toBe("abc");
  });
  it("copies original CRLF through marked's normalization", () => {
    const write = clipboard();
    render(
      <MessageContent text={"before\r\n\r\n```ts\r\n  x\r\n\r\n```\r\n"} />,
    );
    fireEvent.click(screen.getByText("复制代码"));
    expect(write).toHaveBeenCalledWith("  x\r\n\r\n");
  });
  it("preserves code line endings inside quotes and lists without container markers", () => {
    const write = clipboard();
    render(
      <MessageContent
        text={
          "> ```js\r\n>   x\r\n> \r\n> ```\r\n\r\n- ```ts\r\n  y\r\n  ```\r\n"
        }
      />,
    );
    for (const button of screen.getAllByText("复制代码"))
      fireEvent.click(button);
    expect(write.mock.calls.map((call) => call[0])).toEqual([
      "  x\r\n\r\n",
      "y\r\n",
    ]);
  });
  it("highlights known-language keywords while copying exact original code", () => {
    const write = clipboard();
    const body = "const answer = 42;\nreturn '中文';\n";
    const { container } = render(
      <MessageContent text={`\`\`\`js\n${body}\`\`\``} />,
    );
    expect(container.querySelector(".hljs-keyword")?.textContent).toBe("const");
    expect(container.querySelector("code")?.textContent).toBe(body);
    fireEvent.click(screen.getByText("复制代码"));
    expect(write).toHaveBeenCalledWith(body);
  });
  it("keeps malicious code literal and unknown-language code plain", () => {
    const body =
      '</code><script>alert(1)</script><img src="https://bad.test">\n';
    const { container, rerender } = render(
      <MessageContent text={`\`\`\`html\n${body}\`\`\``} />,
    );
    expect(container.querySelector("script,img")).toBeNull();
    expect(container.querySelector("code")?.textContent).toBe(body);
    rerender(
      <MessageContent text={`\`\`\`herta-unknown\nconst x = 1;\n\`\`\``} />,
    );
    expect(container.querySelector("code span")).toBeNull();
    expect(container.querySelector("code")?.textContent).toBe("const x = 1;\n");
  });
  it("defers syntax retokenization until streaming ends, keeping pre and text node stable", () => {
    const { container, rerender } = render(
      <MessageContent streaming text={"```js\nconst"} />,
    );
    const pre = container.querySelector("pre");
    const textNode = container.querySelector("code")?.firstChild;
    expect(container.querySelector(".hljs-keyword")).toBeNull();
    rerender(<MessageContent streaming text={"```js\nconst answer = 42;"} />);
    expect(container.querySelector("pre")).toBe(pre);
    expect(container.querySelector("code")?.firstChild).toBe(textNode);
    rerender(<MessageContent text={"```js\nconst answer = 42;\n```"} />);
    expect(container.querySelector("pre")).toBe(pre);
    expect(container.querySelector(".hljs-keyword")?.textContent).toBe("const");
  });
});
