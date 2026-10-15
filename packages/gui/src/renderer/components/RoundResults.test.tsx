import type { RoundFileContent, RoundSummary } from "@herta/app-server";
import { act, fireEvent, render as renderUI, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoundReader, roundDiffRows } from "./RoundReader.js";
import { cleanToolText, RoundResults } from "./RoundResults.js";
import type { ReactElement, ReactNode } from "react";
import { HertaBridgeProvider } from "../context/HertaBridgeContext.js";
import { createMockHertaBridge } from "../ipc/mock-bridge.js";

function render(element: ReactElement) {
  const { bridge } = createMockHertaBridge();
  return renderUI(element, { wrapper: ({ children }: { children: ReactNode }) =>
    <HertaBridgeProvider bridge={bridge}>{children}</HertaBridgeProvider> });
}


const file: RoundFileContent = { roundId: "r", fileId: "f", path: "src/main.ts", before: "const old = 1;", after: "const next = 2;", diff: "--- before\n+++ after\n-const old = 1;\n+const next = 2;", sourceLabel: "本轮净变化" };
const round: RoundSummary = { schemaVersion: 1, id: "r", sessionId: "s", attemptIds: ["a"], recordStart: 0, startedAt: "2026-10-07T00:00:00Z", endedAt: "2026-10-07T00:01:03Z", durationMs: 63000, status: "completed", files: [{ id: "f", path: file.path, kind: "modified", added: 1, removed: 1, confidence: "tool" }], activities: [
  { id: "t1", attemptId: "a", kind: "command", title: "检查代码", status: "failed", durationMs: 1200, summary: "测试未通过", command: "node check.js", exitCode: 1, detail: "[stdout]\nchecked\n[stderr]\nSyntax error", files: [] },
  { id: "t2", attemptId: "a", kind: "edit", title: "修改代码", status: "succeeded", durationMs: 100, summary: "", files: [{ fileId: "f", path: file.path }] },
], metrics: { totalTokens: null, cacheHitRate: null, outputTokensPerSecond: null, contextUsed: null, contextWindow: null, partial: true }, limitations: [] };

afterEach(() => vi.useRealTimers());
describe("round result evidence UI", () => {
  it("keeps completed turns with failed tools visibly mixed and filters without changing totals", () => {
    render(<RoundResults round={round} onRead={vi.fn()} loadFile={vi.fn()} />);
    expect(screen.getByText("已结束 · 有失败项")).toBeInTheDocument();
    expect(screen.getByText("用时 1分3秒")).toBeInTheDocument();
    fireEvent.click(screen.getByText("查看过程"));
    fireEvent.click(screen.getByRole("button", { name: "仅失败" }));
    const process = document.querySelector(".round-tools") as HTMLElement;
    expect(within(process).getByText("检查代码")).toBeInTheDocument();
    expect(within(process).queryByText("修改代码")).not.toBeInTheDocument();
    expect(screen.getByText("2 步 · 1 成功 · 1 失败")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "涉及文件" }));
    expect(within(process).getByText("修改代码")).toBeInTheDocument();
    expect(within(process).queryByText("检查代码")).not.toBeInTheDocument();
    expect(screen.getByText(/本轮用量 -- tokens/)).toBeInTheDocument();
  });
  it("uses separate file links and does not invent expandable empty tool details", () => {
    const read = vi.fn();
    render(<RoundResults round={round} onRead={read} loadFile={vi.fn()} />);
    const edit = document.querySelectorAll(".round-tool")[1] as HTMLElement;
    expect(edit.querySelector("details")).toBeNull();
    fireEvent.click(within(edit).getByRole("button", { name: file.path }));
    expect(read).toHaveBeenCalledWith("r", "f", undefined);
    expect(screen.getByText("退出码 1", { exact: false })).toBeInTheDocument();
  });
  it("does not let a slower hover result replace the current file, and Escape dismisses", async () => {
    vi.useFakeTimers();
    let resolveFirst!: (value: RoundFileContent) => void;
    const load = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; })).mockResolvedValueOnce({ ...file, fileId: "g", path: "second.ts" });
    render(<RoundResults round={{ ...round, activities: [], files: [...round.files, { ...round.files[0]!, id: "g", path: "second.ts" }] }} onRead={vi.fn()} loadFile={load} />);
    fireEvent.mouseEnter(screen.getByRole("button", { name: file.path }));
    await act(async () => { vi.advanceTimersByTime(350); });
    fireEvent.mouseEnter(screen.getByRole("button", { name: "second.ts" }));
    await act(async () => { vi.advanceTimersByTime(350); });
    await act(async () => { resolveFirst(file); });
    expect(within(screen.getByLabelText("文件悬停预览")).getByText("second.ts")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByLabelText("文件悬停预览")).not.toBeInTheDocument();
  });
  it("does not display final file/task claims while waiting for input", () => {
    render(<RoundResults round={{ ...round, status: "waiting" }} onRead={vi.fn()} loadFile={vi.fn()} />);
    expect(screen.getByText("等待回复或审批")).toBeInTheDocument();
    expect(screen.queryByLabelText("本轮修改文件")).not.toBeInTheDocument();
    expect(screen.queryByText("本轮任务结果")).not.toBeInTheDocument();
  });
  it("renders command output as text and strips terminal controls", () => {
    expect(cleanToolText("\u001b[31mfailed\u001b[0m\u0007")).toBe("failed");
    render(<RoundResults round={{ ...round, activities: [{ ...round.activities[0]!, detail: '<script>alert(1)</script>\n<img src=x onerror=alert(1)>' }] }} onRead={vi.fn()} loadFile={vi.fn()} />);
    expect(document.querySelector(".round-tool-output script")).toBeNull();
    expect(document.querySelector(".round-tool-output img")).toBeNull();
    expect(screen.getByText(/<script>alert/)).toBeInTheDocument();
  });
});
describe("frozen file reader", () => {
  it("preserves deletion/addition roles including text beginning with diff header characters", () => {
    const rows = roundDiffRows("--- before\n+++ after\n---divider\n+++counter\n\\ 12 unchanged lines omitted\n last");
    expect(rows[0]).toMatchObject({ kind: "del", text: "--divider", oldLine: 1 });
    expect(rows[1]).toMatchObject({ kind: "add", text: "++counter", newLine: 1 });
    expect(rows[3]).toMatchObject({ oldLine: 14, newLine: 14 });
  });
  it("switches historical versions, highlights code, and never reads a live file", () => {
    render(<RoundReader content={file} loading={false} onClose={vi.fn()} />);
    expect(document.querySelector(".round-code-row.is-del")).toHaveTextContent("old");
    expect(document.querySelector(".round-code-row.is-add")).toHaveTextContent("next");
    expect(document.querySelector(".hljs-keyword")).toHaveTextContent("const");
    fireEvent.click(screen.getByRole("button", { name: "修改前全文" }));
    expect(screen.getByLabelText("只读代码")).toHaveTextContent("old");
    expect(screen.getByLabelText("只读代码")).not.toHaveTextContent("next");
    fireEvent.click(screen.getByRole("button", { name: "修改后全文" }));
    expect(screen.getByLabelText("只读代码")).toHaveTextContent("next");
  });
  it("supports deleted files and explains absent snapshots", () => {
    render(<RoundReader content={{ ...file, after: null, unavailable: "删除后无文件" }} loading={false} onClose={vi.fn()} />);
    expect(screen.getByRole("button", { name: "修改后全文" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "修改前全文" })).not.toBeDisabled();
    expect(screen.getByText("删除后无文件")).toBeInTheDocument();
  });
});
it("opens the target page and highlights a search line, including another hit in the same file",()=>{
 const content={...file,sourceLabel:"当次搜索后的文件快照（读取视图）",after:Array.from({length:400},(_,i)=>`const value${i+1} = ${i+1};`).join("\n"),targetLine:250};
 const {rerender}=render(<RoundReader content={content} loading={false} onClose={vi.fn()}/>);
 expect(screen.getByText("定位至第 250 行")).toBeInTheDocument();
 expect(document.querySelector('.is-target-line')?.textContent).toContain("value250");
 expect(screen.getByText(/2 \/ 3/)).toBeInTheDocument();
 rerender(<RoundReader content={{...content,targetLine:390}} loading={false} onClose={vi.fn()}/>);
 expect(document.querySelector('.is-target-line')?.textContent).toContain("value390");
 expect(screen.getByText(/3 \/ 3/)).toBeInTheDocument();
});

it("passes the clicked search hit line separately from its shared snapshot id",()=>{
 const read=vi.fn();
 render(<RoundResults round={{...round,activities:[{...round.activities[1]!,kind:"search_text",files:[{fileId:"f",path:file.path,line:250},{fileId:"f",path:file.path,line:390}]}]}} onRead={read} loadFile={vi.fn()}/>);
 fireEvent.click(screen.getByRole("button",{name:`${file.path} · 第 390 行`}));
 expect(read).toHaveBeenCalledWith("r","f",390);
});

it("hides empty task results and routine execution disclaimers", () => {
 render(<RoundResults round={{...round,activities:[],files:[],limitations:[]}} onRead={vi.fn()} loadFile={vi.fn()} />);
 expect(screen.queryByText("本轮任务结果")).not.toBeInTheDocument();
 expect(screen.queryByText("本轮没有可核验的工具工作项。")).not.toBeInTheDocument();
 expect(screen.queryByText(/执行成功不代表/)).not.toBeInTheDocument();
});

it.each(["cancelled", "interrupted"] as const)("preserves changed files for review after %s without claiming completion", status => {
 const read = vi.fn();
 render(<RoundResults round={{...round,status,activities:[{...round.activities[1]!,status:status === "cancelled" ? "cancelled" : "unknown"}]}} onRead={read} loadFile={vi.fn()}/>);
 expect(screen.queryByText("已完成")).not.toBeInTheDocument();
 expect(screen.getByLabelText("本轮修改文件")).toBeInTheDocument();
 const files=screen.getByLabelText("本轮修改文件");
 fireEvent.click(within(files).getByRole("button",{name:file.path}));
 expect(read).toHaveBeenCalledWith("r","f",undefined);
 const process=document.querySelector(".round-tools") as HTMLElement;
 expect(within(process).getByText(status === "cancelled" ? "已取消" : "结果未确认")).toBeInTheDocument();
 expect(within(process).queryByText("执行成功")).not.toBeInTheDocument();
});
