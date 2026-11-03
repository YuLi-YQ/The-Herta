import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { parseExecutablePluginManifest } from "../../../shared/executable-plugins.js";
import { parsePluginControlledView } from "../../../shared/plugin-view.js";
import type { ExecutablePluginReply, ExecutablePluginRequest, ExecutablePluginRunView, ExecutablePluginSnapshot } from "../../../shared/executable-plugin-management.js";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { ExecutablePluginActions, type ExecutablePluginActionsProps } from "./ExecutablePluginActions.js";
import { PromptActionPicker } from "./PromptActionPicker.js";

const manifest = parseExecutablePluginManifest(JSON.stringify({
  schemaVersion: 2, apiVersion: 1, id: "local.organize", name: "黑塔工具箱", version: "1.0.0", description: "整理资料", entry: "main.js",
  capabilities: [{ name: "storage.get" }, { name: "draft.append" }], actions: [{ id: "organize", title: "整理资料", scope: "both", export: "run", capabilities: ["storage.get", "draft.append"],
    inputs: [{ id: "text", label: "资料", type: "text", required: true, maxLength: 100, default: "默认资料" },
      { id: "count", label: "数量", type: "number", required: true, min: 0, max: 10, integer: true, default: 0 },
      { id: "format", label: "格式", type: "select", required: true, options: ["简洁", "详细"], default: "简洁" },
      { id: "include", label: "包含标题", type: "boolean", required: false, default: false }] }],
}));
const snapshot: ExecutablePluginSnapshot = { revision: 1, hostRevision: 1, items: [{ manifest, contentHash: "a".repeat(64), enabled: true, grantRevision: 1, grantedCapabilities: manifest.capabilities, history: [], installedAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z" }] };
const list: ExecutablePluginReply = { ok: true, snapshot, availableCapabilities: ["storage.get", "draft.append"] };
const completed: ExecutablePluginRunView = { id: "run-one", scope: "chat", target: "one", draftRevision: 1, status: "completed", startedAt: "2026-11-01T00:00:00Z", endedAt: "2026-11-01T00:00:02Z", result: { ok: true, valueJson: '"已整理"' }, draftProposal: "整理后的资料", logs: [{ level: "info", message: "读取已完成" }] };
const running = { ...completed, status: "running" as const, result: undefined, draftProposal: undefined, endedAt: undefined };
function setup(request: (input: ExecutablePluginRequest) => Promise<ExecutablePluginReply>, extra: Partial<ExecutablePluginActionsProps> = {}) {
  const bridge = createMockHertaBridge().bridge; bridge.executablePlugins = vi.fn(request);
  const insert = vi.fn(), props: ExecutablePluginActionsProps = { scope: "chat", target: "one", draft: "已有草稿", draftRevision: 1, onInsert: insert, ...extra };
  const wrap = (patch: Partial<ExecutablePluginActionsProps> = {}) => <HertaBridgeProvider bridge={bridge}><ExecutablePluginActions {...props} {...patch} /></HertaBridgeProvider>;
  const rendered = renderWithLocale(wrap());
  return { ...rendered, bridge, insert, change: (patch: Partial<ExecutablePluginActionsProps>) => rendered.rerender(wrap(patch)) };
}
async function choose() {
  fireEvent.click(screen.getByRole("button", { name: /运行插件/ }));
  fireEvent.click(await screen.findByRole("button", { name: /整理资料/ }));
  await screen.findByRole("button", { name: "开始运行" });
}
const quick = async (input: ExecutablePluginRequest): Promise<ExecutablePluginReply> => input.kind === "run" || input.kind === "status" ? { ok: true, run: completed } : list;

function approvalPicker(request: (input: ExecutablePluginRequest) => Promise<ExecutablePluginReply>) {
  const bridge = createMockHertaBridge().bridge;
  bridge.promptPlugins = vi.fn(async () => ({ ok: true as const, snapshot: { revision: 0, items: [] } }));
  bridge.executablePlugins = vi.fn(request);
  const view = (target = "one", disabled = false, suspended = false) => <HertaBridgeProvider bridge={bridge}>
    <PromptActionPicker scope="workbench" target={target} executionTarget={target} draft="" draftRevision={1} disabled={disabled} suspended={suspended} onInsert={vi.fn()} />
    {/* A host control outside the menu. This tests focus ownership, not a network permission decision. */}
    <button type="button">工作台确认</button>
  </HertaBridgeProvider>;
  const rendered = renderWithLocale(view());
  return { ...rendered, bridge, change: (target: string, disabled = false, suspended = false) => rendered.rerender(view(target, disabled, suspended)) };
}
const workRun = { ...running, scope: "workbench" as const };
const workDone = { ...completed, scope: "workbench" as const };
async function startInPicker() {
  fireEvent.click(screen.getByRole("button", { name: "快捷操作" })); await choose();
  fireEvent.click(screen.getByRole("button", { name: "开始运行" }));
}
it("R140 suspension hides the menu for host approval without unmounting or cancelling its pending run", async () => {
  let finish!: (reply: ExecutablePluginReply) => void;
  const { bridge, change } = approvalPicker(input => input.kind === "run" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(list));
  await startInPicker();
  const menu = screen.getByLabelText("快捷操作"); change("one", false, true);
  expect(menu).toBeInTheDocument(); expect(menu).not.toBeVisible(); expect(menu).toHaveAttribute("hidden"); expect(menu).toHaveStyle({ display: "none" });
  const host = screen.getByRole("button", { name: "工作台确认" }); fireEvent.pointerDown(host); host.focus();
  expect(document.activeElement).toBe(host);
  expect(bridge.executablePlugins).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "cancel" }));
  await act(async () => finish({ ok: true, run: workDone })); change("one");
  expect(menu).toBeVisible(); expect(screen.getByRole("button", { name: "追加到草稿" })).toBeVisible();
  expect(bridge.executablePlugins).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "cancel" }));
});
it("R140 keeps host controls usable throughout start/running and restores outside close on completion", async () => {
  let finish!: (reply: ExecutablePluginReply) => void;
  const { bridge } = approvalPicker(input => input.kind === "run" ? new Promise(resolve => { finish = resolve; })
    : Promise.resolve(input.kind === "status" ? { ok: true, run: workDone } : list));
  await startInPicker();
  const host = screen.getByRole("button", { name: "工作台确认" });
  fireEvent.pointerDown(host); fireEvent.focusIn(host); fireEvent.blur(window);
  expect(screen.getByLabelText("快捷操作")).toBeTruthy();
  await act(async () => finish({ ok: true, run: workRun }));
  host.focus(); fireEvent.pointerDown(host); fireEvent.blur(window);
  expect(document.activeElement).toBe(host); expect(screen.getByLabelText("插件运行结果")).toBeTruthy();
  expect(bridge.executablePlugins).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "cancel" }));
  await screen.findByRole("button", { name: "追加到草稿" });
  fireEvent.pointerDown(host); expect(screen.queryByLabelText("快捷操作")).toBeNull();
});
it.each(["close", "Escape"] as const)("R140 explicit %s still cancels a running plugin", async how => {
  const { bridge } = approvalPicker(async input => input.kind === "run" || input.kind === "status" ? { ok: true, run: workRun } : list);
  await startInPicker(); await screen.findByLabelText("插件运行结果");
  if (how === "close") fireEvent.click(screen.getByRole("button", { name: "关闭" })); else fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByLabelText("快捷操作")).toBeNull();
  expect(bridge.executablePlugins).toHaveBeenCalledWith({ kind: "cancel", runId: workRun.id });
});
it("R140 owner/disabled changes cancel runs while an old reply cannot clear a newer running guard", async () => {
  let oldFinish!: (reply: ExecutablePluginReply) => void, newFinish!: (reply: ExecutablePluginReply) => void;
  const { bridge, change } = approvalPicker(input => input.kind === "run" ? new Promise(resolve => {
    if (input.target === "one") oldFinish = resolve; else newFinish = resolve;
  }) : Promise.resolve(list));
  await startInPicker(); change("two"); expect(screen.queryByLabelText("快捷操作")).toBeNull();
  await startInPicker();
  await act(async () => oldFinish({ ok: true, run: workRun }));
  fireEvent.pointerDown(screen.getByRole("button", { name: "工作台确认" })); fireEvent.blur(window);
  expect(screen.getByLabelText("快捷操作")).toBeTruthy();
  expect(bridge.executablePlugins).toHaveBeenCalledWith({ kind: "cancel", runId: workRun.id });
  const newer = { ...workRun, target: "two", id: "newer-run" };
  await act(async () => newFinish({ ok: true, run: newer })); change("two", true);
  expect(screen.queryByLabelText("快捷操作")).toBeNull();
  expect(bridge.executablePlugins).toHaveBeenCalledWith({ kind: "cancel", runId: newer.id });
});

function durableRun(kind: "artifact" | "proposal", draftProposal?: string): ExecutablePluginRunView {
  const producer = { id: manifest.id, name: manifest.name, version: manifest.version, contentHash: "a".repeat(64), grantRevision: 1 };
  return { ...completed, draftProposal, result: { ok: true, valueJson: kind === "artifact" ? '{"artifactId":"saved-file"}' : '"已保存修改提案。"' },
    ...(kind === "artifact" ? { artifacts: [{ id: "saved-file", name: "notes.txt", mime: "text/plain" as const, bytes: 1, sha256: "b".repeat(64), producer, runId: completed.id, createdAt: completed.startedAt }] }
      : { proposals: [{ id: "saved-proposal", path: "notes.txt", baseHash: null, nextHash: "b".repeat(64), producer, runId: completed.id, createdAt: completed.startedAt, status: "pending" as const, additions: 1, deletions: 0 }] }) };
}
it.each(["artifact", "proposal"] as const)("keeps %s receipts out of implicit draft insertion", async kind => {
  const output = durableRun(kind), onOpenOutputs = vi.fn();
  const { insert } = setup(async input => input.kind === "run" || input.kind === "status" ? { ok: true, run: output } : list, { onOpenOutputs });
  await choose(); fireEvent.click(screen.getByRole("button", { name: "开始运行" }));
  await screen.findByRole("button", { name: "查看已保存文件与提案" });
  expect(screen.queryByRole("button", { name: "追加到草稿" })).toBeNull(); expect(insert).not.toHaveBeenCalled();
});
it.each(["artifact", "proposal"] as const)("still permits an explicit draft accompanying a %s after fresh status validation", async kind => {
  const output = durableRun(kind, "明确的可编辑草稿");
  const { insert, bridge } = setup(async input => input.kind === "run" || input.kind === "status" ? { ok: true, run: output } : list);
  await choose(); fireEvent.click(screen.getByRole("button", { name: "开始运行" }));
  fireEvent.click(await screen.findByRole("button", { name: "追加到草稿" }));
  await waitFor(() => expect(insert).toHaveBeenCalledExactlyOnceWith("已有草稿\n\n明确的可编辑草稿", 1));
  expect(bridge.executablePlugins).toHaveBeenCalledWith({ kind: "status", runId: completed.id });
});
it("invalidates an implicit draft if fresh status reveals durable output", async () => {
  const output = durableRun("artifact"), initial = { ...output, artifacts: undefined };
  const { insert } = setup(async input => input.kind === "run" ? { ok: true, run: initial } : input.kind === "status" ? { ok: true, run: output } : list);
  await choose(); fireEvent.click(screen.getByRole("button", { name: "开始运行" }));
  fireEvent.click(await screen.findByRole("button", { name: "追加到草稿" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("结果已变化"); expect(insert).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "追加到草稿" })).toBeNull();
});
it("retains legacy plain-text insertion when there are no controlled or durable outputs", async () => {
  const output = { ...completed, draftProposal: undefined, artifacts: [], proposals: [] };
  const { insert } = setup(async input => input.kind === "run" || input.kind === "status" ? { ok: true, run: output } : list);
  await choose(); fireEvent.click(screen.getByRole("button", { name: "开始运行" }));
  fireEvent.click(await screen.findByRole("button", { name: "追加到草稿" }));
  await waitFor(() => expect(insert).toHaveBeenCalledExactlyOnceWith("已有草稿\n\n已整理", 1));
});

it("opens persisted output after a failed run without treating it as a successful result", async () => {
  const onOpenOutputs=vi.fn();
  const failed: ExecutablePluginRunView={...completed,status:"failed",result:{ok:false,code:"guest-error"},draftProposal:undefined,artifacts:[{id:"artifact-one",name:"notes.txt",mime:"text/plain",bytes:1,sha256:"b".repeat(64),createdAt:completed.startedAt,runId:completed.id,producer:{id:manifest.id,name:manifest.name,version:manifest.version,contentHash:"a".repeat(64),grantRevision:1}}]};
  setup(async input=>input.kind==="run"?{ok:true,run:failed}:list,{onOpenOutputs});
  await choose();fireEvent.click(screen.getByRole("button",{name:"开始运行"}));
  fireEvent.click(await screen.findByRole("button",{name:"查看已保存文件与提案"}));expect(onOpenOutputs).toHaveBeenCalledOnce();
  expect(screen.getByRole("alert")).toHaveTextContent("插件处理失败");expect(screen.queryByRole("button",{name:"追加到草稿"})).toBeNull();
});

it("does not run on selection or insert/send on completion; insertion is a separate explicit action", async () => {
  const { bridge, insert } = setup(quick); await choose();
  expect(bridge.executablePlugins).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "run" }));
  fireEvent.click(screen.getByRole("button", { name: "开始运行" }));
  await screen.findByRole("button", { name: "追加到草稿" }); expect(insert).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "追加到草稿" }));
  await waitFor(() => expect(insert).toHaveBeenCalledExactlyOnceWith("已有草稿\n\n整理后的资料", 1));
  expect(bridge.executablePlugins).toHaveBeenCalledWith(expect.objectContaining({ kind: "run", scope: "chat", target: "one", draftRevision: 1, contentHash: "a".repeat(64) }));
});

it("collects typed inputs, preserves false/zero and rejects an invalid required field", async () => {
  const { bridge } = setup(quick); await choose();
  fireEvent.change(screen.getByLabelText("资料 *"), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "开始运行" })); expect(await screen.findByRole("alert")).toHaveTextContent("必填参数");
  expect(bridge.executablePlugins).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "run" }));
  fireEvent.change(screen.getByLabelText("资料 *"), { target: { value: "我的资料" } });
  fireEvent.change(screen.getByLabelText("格式 *"), { target: { value: "详细" } });
  fireEvent.click(screen.getByRole("button", { name: "开始运行" }));
  await waitFor(() => expect(bridge.executablePlugins).toHaveBeenCalledWith(expect.objectContaining({ kind: "run", inputJson: '{"text":"我的资料","count":0,"format":"详细","include":false}' })));
});

it("keeps scope eligibility, grants and unavailable capabilities visible without offering a runnable button", async () => {
  const noGrant = { ...snapshot, items: [{ ...snapshot.items[0]!, grantedCapabilities: [] }] };
  const { bridge } = setup(async () => ({ ok: true, snapshot: noGrant, availableCapabilities: [] }));
  fireEvent.click(screen.getByRole("button", { name: /运行插件/ }));
  const action = await screen.findByRole("button", { name: /整理资料/ }); expect(action).toBeDisabled(); expect(action).toHaveTextContent("尚未允许：准备聊天草稿");
  expect(bridge.executablePlugins).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "run" }));
});

it("names a currently unsupported capability even when it was previously granted", async () => {
  setup(async () => ({ ok: true, snapshot, availableCapabilities: ["storage.get"] }));
  fireEvent.click(screen.getByRole("button", { name: /运行插件/ }));
  const action = await screen.findByRole("button", { name: /整理资料/ });
  expect(action).toBeDisabled(); expect(action).toHaveTextContent("暂不支持：准备聊天草稿");
});

it("does not offer actions of disabled plugins or workbench-only actions in chat", async () => {
  const outside = { ...snapshot, items: [{ ...snapshot.items[0]!, enabled: false }, { ...snapshot.items[0]!, manifest: { ...manifest, id: "other.plugin", actions: [{ ...manifest.actions[0]!, scope: "workbench" as const }] } }] };
  setup(async () => ({ ok: true, snapshot: outside, availableCapabilities: ["storage.get", "draft.append"] }));
  fireEvent.click(screen.getByRole("button", { name: /运行插件/ }));
  expect(await screen.findByText(/暂无可用操作/)).toBeTruthy(); expect(screen.queryByRole("button", { name: /整理资料/ })).toBeNull();
});

it("does not start without a real execution target", () => {
  const { bridge } = setup(quick, { target: "" });
  expect(screen.getByRole("button", { name: /运行插件/ })).toBeDisabled(); expect(bridge.executablePlugins).not.toHaveBeenCalled();
});

it("cancels a start reply that arrives after switching conversation", async () => {
  let finish!: (reply: ExecutablePluginReply) => void;
  const { bridge, change, insert } = setup(input => input.kind === "run" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(list));
  await choose(); fireEvent.click(screen.getByRole("button", { name: "开始运行" })); change({ target: "two" });
  await act(async () => finish({ ok: true, run: running }));
  expect(bridge.executablePlugins).toHaveBeenCalledWith({ kind: "cancel", runId: running.id }); expect(insert).not.toHaveBeenCalled();
  expect(screen.queryByLabelText("插件运行结果")).toBeNull();
});

it("cancels a start reply after the picker unmounts", async () => {
  let finish!: (reply: ExecutablePluginReply) => void;
  const { bridge, unmount } = setup(input => input.kind === "run" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(list));
  await choose(); fireEvent.click(screen.getByRole("button", { name: "开始运行" })); unmount();
  await act(async () => finish({ ok: true, run: running }));
  expect(bridge.executablePlugins).toHaveBeenCalledWith({ kind: "cancel", runId: running.id });
});

it("invalidates completed proposals on an ABA draft edit even when text is unchanged", async () => {
  const { bridge, change, insert } = setup(quick); await choose(); fireEvent.click(screen.getByRole("button", { name: "开始运行" }));
  await screen.findByRole("button", { name: "追加到草稿" }); change({ draft: "已有草稿", draftRevision: 3 });
  expect(screen.queryByRole("button", { name: "追加到草稿" })).toBeNull(); expect(insert).not.toHaveBeenCalled();
  expect(bridge.executablePlugins).toHaveBeenCalledWith({ kind: "cancel", runId: completed.id });
});

it("polls a running action and discards a late status after stopping", async () => {
  let finish!: (reply: ExecutablePluginReply) => void;
  const { bridge, insert } = setup(input => input.kind === "run" ? Promise.resolve({ ok: true, run: running })
    : input.kind === "status" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(list));
  await choose(); fireEvent.click(screen.getByRole("button", { name: "开始运行" }));
  await waitFor(() => expect(bridge.executablePlugins).toHaveBeenCalledWith({ kind: "status", runId: running.id }));
  fireEvent.click(screen.getByRole("button", { name: "停止运行" }));
  await act(async () => finish({ ok: true, run: completed }));
  expect(screen.queryByRole("button", { name: "追加到草稿" })).toBeNull(); expect(insert).not.toHaveBeenCalled();
  expect(bridge.executablePlugins).toHaveBeenCalledWith({ kind: "cancel", runId: running.id });
});

it("finishes polling on completion and shows actual progress and failure details", async () => {
  const failed: ExecutablePluginRunView = { ...completed, status: "failed", result: { ok: false, code: "capability-denied" }, draftProposal: undefined };
  const { bridge } = setup(async input => input.kind === "run" ? { ok: true, run: { ...running, progress: { message: "读取选定资料", value: 0 } } }
    : input.kind === "status" ? { ok: true, run: failed } : list);
  await choose(); fireEvent.click(screen.getByRole("button", { name: "开始运行" }));
  expect(await screen.findByRole("progressbar", { name: "插件进度" })).toHaveAttribute("value", "0");
  expect(await screen.findByRole("alert")).toHaveTextContent("未获得所需权限");
  expect(screen.queryByRole("button", { name: "追加到草稿" })).toBeNull();
  expect(bridge.executablePlugins).toHaveBeenCalledWith({ kind: "status", runId: running.id });
});

it("renders structured results as inert text and guards excessive draft length", async () => {
  const malicious = { ...completed, draftProposal: undefined, result: { ok: true as const, valueJson: JSON.stringify({ text: "<img src=x onerror=evil()>" }) } };
  const { container } = setup(async input => input.kind === "run" ? { ok: true, run: malicious } : list, { draft: "x".repeat(32000) });
  await choose(); fireEvent.click(screen.getByRole("button", { name: "开始运行" }));
  const insert = await screen.findByRole("button", { name: "追加到草稿" }); expect(insert).toBeDisabled();
  expect(container.querySelector("img")).toBeNull(); expect(screen.getByText(/<img src=x onerror=evil\(\)>/)).toBeTruthy();
});

it("moves focus to a parameter and back to the action list without sending on Enter", async () => {
  const { bridge, insert } = setup(quick); await choose();
  const field = screen.getByLabelText("资料 *"); expect(document.activeElement).toBe(field);
  fireEvent.keyDown(field, { key: "Enter", isComposing: true });
  fireEvent.keyDown(field, { key: "Enter" });
  expect(bridge.executablePlugins).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "run" })); expect(insert).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "返回插件列表" }));
  expect(document.activeElement).toBe(screen.getByRole("button", { name: /整理资料/ }));
});

it("keeps stale actions hidden when the next list refresh fails", async () => {
  let reads = 0;
  setup(async () => ++reads === 1 ? list : { ok: false, message: "未能读取插件" });
  fireEvent.click(screen.getByRole("button", { name: /运行插件/ })); await screen.findByRole("button", { name: /整理资料/ });
  fireEvent.click(screen.getByRole("button", { name: "返回快捷操作" })); fireEvent.click(screen.getByRole("button", { name: /运行插件/ }));
  await screen.findByRole("alert"); expect(screen.queryByRole("button", { name: /整理资料/ })).toBeNull();
});

it("uses the owner's real execution session, not the workbench draft-storage key", async () => {
  const bridge = createMockHertaBridge().bridge;
  bridge.promptPlugins = vi.fn(async () => ({ ok: true as const, snapshot: { revision: 0, items: [] } }));
  bridge.executablePlugins = vi.fn(async (input: ExecutablePluginRequest): Promise<ExecutablePluginReply> => input.kind === "run"
    ? { ok: true, run: { ...completed, scope: "workbench", target: "session-real", draftRevision: 4 } } : list);
  renderWithLocale(<HertaBridgeProvider bridge={bridge}><PromptActionPicker scope="workbench" target="draft:storage-key" executionTarget="session-real" draft="" draftRevision={4} onInsert={vi.fn()} /></HertaBridgeProvider>);
  fireEvent.click(screen.getByRole("button", { name: "快捷操作" }));
  await screen.findByRole("button", { name: /运行插件/ }); await choose();
  fireEvent.click(screen.getByRole("button", { name: "开始运行" }));
  await waitFor(() => expect(bridge.executablePlugins).toHaveBeenCalledWith(expect.objectContaining({ kind: "run", target: "session-real", scope: "workbench", draftRevision: 4 })));
});

it("rechecks a completed preview on the insertion click and refuses a revoked configuration", async () => {
  const { bridge, insert } = setup(async input => input.kind === "run" ? { ok: true, run: completed }
    : input.kind === "status" ? { ok: false, message: "插件配置已变化，请重新运行。" } : list);
  await choose(); fireEvent.click(screen.getByRole("button", { name: "开始运行" }));
  fireEvent.click(await screen.findByRole("button", { name: "追加到草稿" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("插件配置已变化");
  expect(bridge.executablePlugins).toHaveBeenCalledWith({ kind: "status", runId: completed.id });
  expect(insert).not.toHaveBeenCalled(); expect(screen.queryByRole("button", { name: "追加到草稿" })).toBeNull();
});

it("accepts the owner's immediate draft-version veto without overwriting a newer edit", async () => {
  const ownerInsert = vi.fn(() => false);
  setup(quick, { onInsert: ownerInsert }); await choose(); fireEvent.click(screen.getByRole("button", { name: "开始运行" }));
  fireEvent.click(await screen.findByRole("button", { name: "追加到草稿" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("草稿已变化");
  expect(ownerInsert).toHaveBeenCalledExactlyOnceWith("已有草稿\n\n整理后的资料", 1);
  expect(screen.queryByRole("button", { name: "追加到草稿" })).toBeNull();
});

it("requires a fresh confirmation when the displayed result changes before insertion", async () => {
  const newer = { ...completed, draftProposal: "更新后的资料" };
  const { insert } = setup(async input => input.kind === "run" ? { ok: true, run: completed }
    : input.kind === "status" ? { ok: true, run: newer } : list);
  await choose(); fireEvent.click(screen.getByRole("button", { name: "开始运行" }));
  fireEvent.click(await screen.findByRole("button", { name: "追加到草稿" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("结果已变化"); expect(insert).not.toHaveBeenCalled();
  expect(screen.getByText("更新后的资料")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "追加到草稿" }));
  await waitFor(() => expect(insert).toHaveBeenCalledExactlyOnceWith("已有草稿\n\n更新后的资料", 1));
});

it("uses one popover view for the plugin form and restores the existing quick-action menu on back", async () => {
  const bridge = createMockHertaBridge().bridge;
  bridge.promptPlugins = vi.fn(async () => ({ ok: true as const, snapshot: { revision: 0, items: [] } }));
  bridge.executablePlugins = vi.fn(quick);
  renderWithLocale(<HertaBridgeProvider bridge={bridge}><PromptActionPicker scope="chat" target="one" draft="" draftRevision={1} onInsert={vi.fn()} /></HertaBridgeProvider>);
  fireEvent.click(screen.getByRole("button", { name: "快捷操作" }));
  const common = await screen.findByRole("group", { name: "常用" });
  expect(common).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /运行插件/ }));
  const action = await screen.findByRole("button", { name: /整理资料/ });
  expect(screen.queryByLabelText("查找操作")).toBeNull(); expect(common).not.toBeVisible();
  expect(screen.queryByText(/暂无提示词动作/)).toBeNull();
  const popover = screen.getByRole("region", { name: "快捷操作" }); popover.scrollTop = 220;
  fireEvent.click(action);
  const field = screen.getByLabelText("资料 *"); expect(field).toBeVisible(); expect(document.activeElement).toBe(field);
  expect(popover.scrollTop).toBe(0);
  fireEvent.click(screen.getByRole("button", { name: "返回快捷操作" }));
  expect(screen.queryByLabelText("查找操作")).toBeNull(); expect(common).toBeVisible(); expect(document.activeElement).toBe(screen.getByRole("button", { name: /运行插件/ }));
  expect(bridge.executablePlugins).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "run" }));
});

it("cancels a late start when returning to quick actions without unmounting the picker", async () => {
  let finish!: (reply: ExecutablePluginReply) => void;
  const bridge = createMockHertaBridge().bridge, insert = vi.fn();
  bridge.promptPlugins = vi.fn(async () => ({ ok: true as const, snapshot: { revision: 0, items: [] } }));
  bridge.executablePlugins = vi.fn(input => input.kind === "run" ? new Promise<ExecutablePluginReply>(resolve => { finish = resolve; }) : Promise.resolve(list));
  renderWithLocale(<HertaBridgeProvider bridge={bridge}><PromptActionPicker scope="chat" target="one" draft="" draftRevision={1} onInsert={insert} /></HertaBridgeProvider>);
  fireEvent.click(screen.getByRole("button", { name: "快捷操作" })); await choose();
  fireEvent.click(screen.getByRole("button", { name: "开始运行" })); fireEvent.click(screen.getByRole("button", { name: "返回快捷操作" }));
  expect(screen.getByRole("button", { name: /运行插件/ })).toBeVisible();
  await act(async () => finish({ ok: true, run: running }));
  expect(bridge.executablePlugins).toHaveBeenCalledWith({ kind: "cancel", runId: running.id }); expect(insert).not.toHaveBeenCalled();
  expect(screen.queryByLabelText("插件运行结果")).toBeNull();
});

const visualManifest = parseExecutablePluginManifest(JSON.stringify({
  ...manifest, capabilities: [...manifest.capabilities, { name: "ui.present" }],
  actions: [{ ...manifest.actions[0]!, capabilities: [...manifest.actions[0]!.capabilities, "ui.present"] },
    { ...manifest.actions[0]!, id: "refine", title: "修改选中项", export: "refine", capabilities: ["draft.append"] }],
}));
const visualSnapshot: ExecutablePluginSnapshot = { ...snapshot, items: [{ ...snapshot.items[0]!, manifest: visualManifest, grantedCapabilities: visualManifest.capabilities }] };
const visualList: ExecutablePluginReply = { ok: true, snapshot: visualSnapshot, availableCapabilities: ["storage.get", "draft.append", "ui.present"] };
const visualRun: ExecutablePluginRunView = { ...completed, draftProposal: undefined, result: { ok: true, valueJson: "null" }, controlledView: {
  ...parsePluginControlledView(JSON.stringify({ title: "资料检查结果", blocks: [{ type: "text", text: "可以选择其中一项继续整理。" }, { type: "fields", items: [{ label: "项目数", value: "2" }] }],
    actions: [{ id: "continue", label: "调整这一项", actionId: "refine", inputJson: '{"text":"视图预填","count":2,"format":"详细","include":true}' }],
  })), id: "view-one", revision: 1,
} };
const derivedRun: ExecutablePluginRunView = { ...completed, id: "run-two", draftProposal: "派生的草稿", result: { ok: true, valueJson: '"派生运行已结束"' } };
function visualReply(input: ExecutablePluginRequest): Promise<ExecutablePluginReply> {
  if (input.kind === "run" || (input.kind === "status" && input.runId === visualRun.id)) return Promise.resolve({ ok: true, run: visualRun });
  if (input.kind === "view-action" || (input.kind === "status" && input.runId === derivedRun.id)) return Promise.resolve({ ok: true, run: derivedRun });
  return Promise.resolve(visualList);
}
async function showVisualResult() {
  await choose(); fireEvent.click(screen.getByRole("button", { name: "开始运行" }));
  await screen.findByRole("region", { name: "资料检查结果" });
}

it("revalidates a result button, opens editable manifest fields, and starts only after another explicit click", async () => {
  const { bridge, insert } = setup(visualReply);
  await showVisualResult(); fireEvent.click(screen.getByRole("button", { name: "调整这一项" }));
  await waitFor(() => expect(screen.getByLabelText("资料 *")).toHaveValue("视图预填"));
  expect(screen.getByLabelText("数量 *")).toHaveValue(2); expect(screen.getByLabelText("格式 *")).toHaveValue("详细"); expect(screen.getByLabelText("包含标题")).toBeChecked();
  expect(document.activeElement).toBe(screen.getByLabelText("资料 *"));
  expect(bridge.executablePlugins).toHaveBeenCalledWith({ kind: "status", runId: visualRun.id });
  expect(bridge.executablePlugins).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "view-action" })); expect(insert).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("资料 *"), { target: { value: "我修订的资料" } });
  fireEvent.click(screen.getByRole("button", { name: "开始运行" }));
  await waitFor(() => expect(bridge.executablePlugins).toHaveBeenCalledWith({ kind: "view-action", runId: visualRun.id, viewId: "view-one", viewRevision: 1, buttonId: "continue", draftRevision: 1,
    inputJson: '{"text":"我修订的资料","count":2,"format":"详细","include":true}' }));
  fireEvent.click(await screen.findByRole("button", { name: "追加到草稿" }));
  await waitFor(() => expect(insert).toHaveBeenCalledExactlyOnceWith("已有草稿\n\n派生的草稿", 1));
});

it("returns to the original readable result without executing or losing the latest cancellation handle", async () => {
  const { bridge } = setup(visualReply); await showVisualResult();
  fireEvent.click(screen.getByRole("button", { name: "调整这一项" })); await screen.findByRole("button", { name: "返回结果" });
  fireEvent.click(screen.getByRole("button", { name: "返回结果" }));
  const region = screen.getByRole("region", { name: "资料检查结果" }); expect(document.activeElement).toBe(region);
  expect(screen.getByLabelText("资料 *")).toHaveValue("默认资料");
  expect(bridge.executablePlugins).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "view-action" }));
  fireEvent.click(screen.getByRole("button", { name: "调整这一项" })); await screen.findByRole("button", { name: "返回结果" });
  fireEvent.click(screen.getByRole("button", { name: "开始运行" })); await screen.findByText("派生的草稿");
  fireEvent.click(screen.getByRole("button", { name: "返回结果" }));
  expect(screen.getByRole("button", { name: "调整这一项" })).toBeDisabled(); expect(screen.getByText(/这份结果仅供阅读/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "调整这一项" }));
  expect(vi.mocked(bridge.executablePlugins!).mock.calls.filter(([request]) => request.kind === "view-action")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "返回快捷操作" }));
  expect(bridge.executablePlugins).toHaveBeenLastCalledWith({ kind: "cancel", runId: derivedRun.id });
});

it.each(["running", "failed", "cancelled"] as const)("renders a %s result view read-only", async status => {
  const result = { ...visualRun, status, ...(status === "running" ? { endedAt: undefined } : { result: { ok: false as const, code: "guest-error" as const } }) };
  const { bridge } = setup(async input => input.kind === "run" || input.kind === "status" ? { ok: true, run: result } : visualList);
  await showVisualResult(); const button = screen.getByRole("button", { name: "调整这一项" }); expect(button).toBeDisabled(); fireEvent.click(button);
  expect(bridge.executablePlugins).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "view-action" }));
});

it("refuses changed view content or revision until the new result is read and selected again", async () => {
  const fresh = { ...visualRun, controlledView: { ...visualRun.controlledView!, revision: 2,
    actions: [{ ...visualRun.controlledView!.actions[0]!, inputJson: '{"text":"新视图预填","count":4,"format":"简洁","include":false}' }] } };
  const { bridge } = setup(async input => input.kind === "run" ? { ok: true, run: visualRun } : input.kind === "status" ? { ok: true, run: fresh } : visualList);
  await showVisualResult(); fireEvent.click(screen.getByRole("button", { name: "调整这一项" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("结果已更新"); expect(screen.queryByRole("button", { name: "返回结果" })).toBeNull();
  expect(bridge.executablePlugins).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "view-action" }));
  fireEvent.click(screen.getByRole("button", { name: "调整这一项" }));
  await waitFor(() => expect(screen.getByLabelText("资料 *")).toHaveValue("新视图预填")); expect(screen.getByLabelText("数量 *")).toHaveValue(4);
});

it("does not open a result action after configuration revocation", async () => {
  const { bridge } = setup(async input => input.kind === "run" ? { ok: true, run: visualRun }
    : input.kind === "status" ? { ok: false, message: "插件版本已经变化。" } : visualList);
  await showVisualResult(); fireEvent.click(screen.getByRole("button", { name: "调整这一项" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("插件版本已经变化");
  expect(screen.queryByRole("region", { name: "资料检查结果" })).toBeNull(); expect(screen.queryByRole("button", { name: "返回结果" })).toBeNull();
  expect(bridge.executablePlugins).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "view-action" }));
});

it("drops a late view-selection status when the draft revision changes", async () => {
  let finish!: (reply: ExecutablePluginReply) => void;
  const { change, bridge } = setup(input => input.kind === "run" ? Promise.resolve({ ok: true, run: visualRun })
    : input.kind === "status" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(visualList));
  await showVisualResult(); fireEvent.click(screen.getByRole("button", { name: "调整这一项" })); change({ draftRevision: 2 });
  await act(async () => finish({ ok: true, run: visualRun }));
  expect(screen.queryByRole("button", { name: "返回结果" })).toBeNull(); expect(screen.queryByLabelText("资料 *")).toBeNull();
  expect(bridge.executablePlugins).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "view-action" }));
});

it("does not resolve a result button against another plugin's action", async () => {
  const foreign = parseExecutablePluginManifest(JSON.stringify({ ...manifest, id: "other.toolbox", name: "另一个工具箱", capabilities: [],
    actions: [{ ...manifest.actions[0]!, id: "foreign", title: "外部操作", capabilities: [], inputs: [] }] }));
  const badView = { ...visualRun, controlledView: { ...visualRun.controlledView!, actions: [{ ...visualRun.controlledView!.actions[0]!, actionId: "foreign", inputJson: "{}" }] } };
  const { bridge } = setup(async input => input.kind === "run" || input.kind === "status" ? { ok: true, run: badView }
    : { ...visualList, ok: true, snapshot: { ...visualSnapshot, items: [...visualSnapshot.items, { ...snapshot.items[0]!, manifest: foreign, contentHash: "b".repeat(64), grantedCapabilities: [] }] } });
  await showVisualResult(); fireEvent.click(screen.getByRole("button", { name: "调整这一项" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("不在当前插件中"); expect(screen.queryByRole("button", { name: "返回结果" })).toBeNull();
  expect(bridge.executablePlugins).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "view-action" }));
});

it("rejects invalid action prefills before opening a form", async () => {
  const badView = { ...visualRun, controlledView: { ...visualRun.controlledView!, actions: [{ ...visualRun.controlledView!.actions[0]!, inputJson: '{"text":99}' }] } };
  const { bridge } = setup(async input => input.kind === "run" || input.kind === "status" ? { ok: true, run: badView } : visualList);
  await showVisualResult(); fireEvent.click(screen.getByRole("button", { name: "调整这一项" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("参数不符合"); expect(screen.queryByRole("button", { name: "返回结果" })).toBeNull();
  expect(bridge.executablePlugins).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "view-action" }));
});

it("retains the source view after a launch rejection that did not create a run", async () => {
  let attempts = 0;
  const { bridge } = setup(async input => input.kind === "view-action" ? (++attempts === 1 ? { ok: false, message: "暂时不能开始，请重试。" } : { ok: true, run: derivedRun })
    : input.kind === "run" || input.kind === "status" ? { ok: true, run: visualRun } : visualList);
  await showVisualResult(); fireEvent.click(screen.getByRole("button", { name: "调整这一项" })); await screen.findByRole("button", { name: "返回结果" });
  fireEvent.click(screen.getByRole("button", { name: "开始运行" })); expect(await screen.findByRole("alert")).toHaveTextContent("暂时不能开始");
  expect(screen.getByRole("button", { name: "开始运行" })).not.toBeDisabled();
  fireEvent.change(screen.getByLabelText("资料 *"), { target: { value: "修订后重试" } }); fireEvent.click(screen.getByRole("button", { name: "开始运行" }));
  await screen.findByText("派生的草稿"); expect(vi.mocked(bridge.executablePlugins!).mock.calls.filter(([request]) => request.kind === "view-action")).toHaveLength(2);
});

it("keeps return disabled during a derived start and cancels its late run on close", async () => {
  let finish!: (reply: ExecutablePluginReply) => void;
  const { bridge, insert } = setup(input => input.kind === "view-action" ? new Promise(resolve => { finish = resolve; }) : visualReply(input));
  await showVisualResult(); fireEvent.click(screen.getByRole("button", { name: "调整这一项" })); await screen.findByRole("button", { name: "返回结果" });
  fireEvent.click(screen.getByRole("button", { name: "开始运行" })); expect(screen.getByRole("button", { name: "返回结果" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "返回快捷操作" }));
  await act(async () => finish({ ok: true, run: { ...derivedRun, status: "running", endedAt: undefined, result: undefined } }));
  expect(bridge.executablePlugins).toHaveBeenCalledWith({ kind: "cancel", runId: derivedRun.id }); expect(insert).not.toHaveBeenCalled();
  expect(screen.queryByLabelText("插件运行结果")).toBeNull();
});
