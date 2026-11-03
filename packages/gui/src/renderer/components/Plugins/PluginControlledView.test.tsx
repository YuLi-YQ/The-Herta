import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { parsePluginControlledView, type PluginControlledView as View } from "../../../shared/plugin-view.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { PluginControlledView } from "./PluginControlledView.js";

function fixture(): View {
  return { ...parsePluginControlledView(JSON.stringify({
    title: "资料检查结果",
    blocks: [
      { type: "text", text: '第一段\nhttps://example.invalid/ <img src=x onerror="bad()">' },
      { type: "code", language: "javascript", code: 'const value = "<script>bad()</script>";\n' },
      { type: "list", items: ["需要检查的项目", "<a href='javascript:bad()'>不是链接</a>"] },
      { type: "table", columns: ["文件", "行数"], rows: [["report.md", "0"], ["记录".repeat(100), "12"]] },
      { type: "status", tone: "warning", text: "尚有一项待确认。" },
      { type: "fields", items: [{ label: "来源", value: "临时测试资料" }, { label: "空值", value: "" }] },
    ], actions: [{ id: "inspect", label: "查看下一项", actionId: "inspect", inputJson: '{"name":"下一项"}' }],
  })), id: "view-one", revision: 1 };
}

describe("host-owned controlled plugin views", () => {
  it("renders all supported blocks with semantic, read-only data and no automatic operation", async () => {
    const onAction = vi.fn(), view = fixture();
    const { container } = renderWithLocale(<PluginControlledView view={view} disabled={false} onAction={onAction} />);
    expect(screen.getByRole("region", { name: view.title })).toBeTruthy();
    expect(screen.getByRole("heading", { name: view.title })).toBeTruthy();
    expect(screen.getByText("临时测试资料")).toBeTruthy();
    expect(screen.getByText("尚有一项待确认。")).toBeTruthy(); expect(screen.getByText("注意")).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "文件" })).toHaveAttribute("scope", "col");
    expect(screen.getByRole("cell", { name: "0" })).toBeTruthy();
    expect(container.querySelector("input,select,textarea")).toBeNull();
    expect(onAction).not.toHaveBeenCalled();
    const button = screen.getByRole("button", { name: "查看下一项" }); button.focus(); expect(document.activeElement).toBe(button);
    fireEvent.click(button); expect(onAction).toHaveBeenCalledExactlyOnceWith("inspect");
    await waitFor(() => expect(container.querySelector(".hljs-keyword")).not.toBeNull());
  });

  it("keeps URLs, markup, code, fields and button labels inert, including after highlighting", async () => {
    const view = fixture();
    const poisoned: View = { ...view, title: "<style>body{display:none}</style>", actions: [{ ...view.actions[0]!, label: "<svg onload=bad()>" }] };
    const { container } = renderWithLocale(<PluginControlledView view={poisoned} disabled={false} onAction={vi.fn()} />);
    expect(container.querySelector("img,a,iframe,style,script")).toBeNull();
    expect(container.querySelectorAll("svg")).toHaveLength(1); // Only the host-owned status icon.
    expect(screen.getByRole("button", { name: "<svg onload=bad()>" })).toBeTruthy();
    await waitFor(() => expect(container.querySelector(".hljs-string")).not.toBeNull());
    expect(container.querySelector(".file-viewer__text")?.textContent).toBe('const value = "<script>bad()</script>";\n');
    expect(container.querySelector("img,a,iframe,style,script")).toBeNull();
  });

  it("keeps a wide table independently keyboard-focusable with actual column headers and rows", () => {
    const columns = Array.from({ length: 12 }, (_, index) => `字段 ${index + 1}`);
    const view: View = { ...fixture(), blocks: [{ type: "table", columns, rows: [columns.map((_, index) => String(index))] }] };
    renderWithLocale(<PluginControlledView view={view} />);
    const scroller = screen.getByRole("region", { name: `${view.title} · 表格` }); scroller.focus();
    expect(document.activeElement).toBe(scroller);
    expect(within(scroller).getAllByRole("columnheader")).toHaveLength(12);
    expect(within(scroller).getAllByRole("row")).toHaveLength(2);
    expect(within(scroller).getByRole("cell", { name: "0" })).toBeTruthy();
    expect(within(scroller).getByRole("table")).toHaveStyle({ minWidth: "1344px" });
  });

  it.each(["info", "success", "warning", "error"] as const)("pairs a %s status with an icon and readable words", tone => {
    const view: View = { ...fixture(), blocks: [{ type: "status", tone, text: "明确的处理说明" }], actions: [] };
    const { container } = renderWithLocale(<PluginControlledView view={view} />);
    expect(screen.getByText({ info: "提示", success: "已完成", warning: "注意", error: "错误" }[tone])).toBeTruthy();
    expect(screen.getByText("明确的处理说明")).toBeTruthy();
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("defaults to a read-only result and does not dispatch disabled or absent callbacks", () => {
    const onAction = vi.fn(), view = fixture();
    const { rerender } = renderWithLocale(<PluginControlledView view={view} onAction={onAction} disabledReason="这份结果仅供阅读。" />);
    const button = screen.getByRole("button", { name: "查看下一项" }); expect(button).toBeDisabled(); fireEvent.click(button);
    expect(onAction).not.toHaveBeenCalled(); expect(screen.getByText("这份结果仅供阅读。")).toBeTruthy();
    rerender(<PluginControlledView view={view} disabled={false} />);
    expect(screen.getByRole("button", { name: "查看下一项" })).toBeDisabled();
  });

  it("uses plain code when the language is unavailable, preserving the original text", () => {
    const code = '<img src=x onerror="bad()">';
    const view: View = { ...fixture(), blocks: [{ type: "code", code, language: "unknown-language" }], actions: [] };
    const { container } = renderWithLocale(<PluginControlledView view={view} />);
    expect(container.querySelector(".file-viewer__text")?.textContent).toBe(code); expect(container.querySelector("img")).toBeNull();
  });
});
