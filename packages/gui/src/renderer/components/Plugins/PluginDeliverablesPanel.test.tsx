import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { ExecutablePluginReply, ExecutablePluginRequest } from "../../../shared/executable-plugin-management.js";
import type { PluginArtifact, PluginOutputSnapshot, PluginPatchContent, PluginPatchStatus } from "../../../shared/plugin-deliverables.js";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { PluginDeliverablesPanel, type PluginDeliverablesPanelProps } from "./PluginDeliverablesPanel.js";

const producer = { id: "local.files", name: "资料工具", version: "1.0.0", contentHash: "a".repeat(64), grantRevision: 1 };
const artifact: PluginArtifact = { id: "file-one", name: "研究笔记.md", mime: "text/markdown", bytes: 123, sha256: "b".repeat(64), producer, runId: "run-old", createdAt: "2026-11-01T00:00:00Z" };
const patch: PluginPatchContent = { proposal: { id: "patch-one", path: "notes.txt", baseHash: "c".repeat(64), nextHash: "d".repeat(64), producer, runId: "run-old", createdAt: artifact.createdAt, status: "pending", additions: 1, deletions: 1 }, before: "before", after: "after", diff: "--- a/notes.txt\n+++ b/notes.txt\n@@ -1 +1 @@\n-before\n+after" };
const outputs: PluginOutputSnapshot = { artifacts: [artifact], proposals: [patch.proposal], damagedArtifacts: 0, damagedProposals: 0 };
const empty: PluginOutputSnapshot = { artifacts: [], proposals: [], damagedArtifacts: 0, damagedProposals: 0 };
const basic = async (input: ExecutablePluginRequest): Promise<ExecutablePluginReply> => {
  if (input.kind === "artifact-read") return { ok: true, artifact, content: "已保存资料" };
  if (input.kind === "patch-read") return { ok: true, patch };
  return { ok: true, outputs };
};
function setup(request = basic, extra: Partial<PluginDeliverablesPanelProps> = {}) {
  const bridge = createMockHertaBridge().bridge; bridge.executablePlugins = vi.fn(request);
  const onClose = vi.fn();
  const props: PluginDeliverablesPanelProps = { scope: "workbench", target: "session-one", open: true, draftRevision: 1, onClose, ...extra };
  const view = (next: Partial<PluginDeliverablesPanelProps> = {}) => <HertaBridgeProvider bridge={bridge}><PluginDeliverablesPanel {...props} {...next} /></HertaBridgeProvider>;
  const render = renderWithLocale(view());
  return { ...render, bridge, onClose, change: (next: Partial<PluginDeliverablesPanelProps>) => render.rerender(view(next)) };
}
const inspectPatch = async () => fireEvent.click(await screen.findByRole("button", { name: /notes.txt.*待应用/ }));

it("lists persisted files without starting a plugin, changing a draft or reading live paths", async () => {
  const { bridge } = setup();
  fireEvent.click(await screen.findByRole("button", { name: /研究笔记.md.*查看/ }));
  expect(await screen.findByLabelText("研究笔记.md 的内容")).toHaveTextContent("已保存资料");
  expect(bridge.executablePlugins).toHaveBeenCalledWith({ kind: "artifact-read", scope: "workbench", target: "session-one", id: "file-one" });
  expect(bridge.executablePlugins).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "run" }));
  expect(screen.getByText(/文件保留不代表插件运行成功/)).toBeTruthy();
});
it("keeps output data inert, without links, image requests or HTML injection", async () => {
  setup(async input => input.kind === "artifact-read" ? { ok: true, artifact: { ...artifact, mime: "text/plain" }, content: '<img src="https://example.com/secret">' } : basic(input));
  fireEvent.click(await screen.findByRole("button", { name: /研究笔记.md.*查看/ }));
  const reader = await screen.findByLabelText("研究笔记.md 的内容");
  expect(reader).toHaveTextContent('<img src="https://example.com/secret">'); expect(reader.querySelector("img,a,iframe")).toBeNull();
});
it("saves only after a click, passes only artifact identity and remains open across native blur", async () => {
  let finish!: (r: ExecutablePluginReply) => void;
  const { bridge } = setup(input => input.kind === "artifact-save" ? new Promise(resolve => { finish = resolve; }) : basic(input));
  const save = await screen.findByRole("button", { name: "保存 研究笔记.md 的副本" });
  expect(bridge.executablePlugins).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "artifact-save" }));
  fireEvent.click(save); fireEvent.blur(window); expect(screen.getByLabelText("插件文件")).toBeTruthy();
  expect(save).toBeDisabled();
  expect(bridge.executablePlugins).toHaveBeenCalledWith({ kind: "artifact-save", scope: "workbench", target: "session-one", id: artifact.id });
  await act(async () => finish({ ok: true, saved: true })); expect(await screen.findByText("已保存副本。")).toBeTruthy();
});
it("treats cancelling the native save dialog separately from a failure", async () => {
  setup(async input => input.kind === "artifact-save" ? { ok: true, saved: false } : basic(input));
  fireEvent.click(await screen.findByRole("button", { name: "保存 研究笔记.md 的副本" }));
  expect(await screen.findByText("已取消保存，原文件仍保留。")).toBeTruthy(); expect(screen.queryByRole("alert")).toBeNull();
});
it("displays a host save failure and leaves the persisted file readable", async () => {
  setup(async input => input.kind === "artifact-save" ? { ok: false, message: "保存位置不可写。" } : basic(input));
  fireEvent.click(await screen.findByRole("button", { name: "保存 研究笔记.md 的副本" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("保存位置不可写。");
  fireEvent.click(screen.getByRole("button", { name: /研究笔记.md.*查看/ })); expect(await screen.findByLabelText("研究笔记.md 的内容")).toBeTruthy();
});
it("drops a late save notice after owner changes", async () => {
  let finish!: (r: ExecutablePluginReply) => void;
  const { change } = setup(input => input.kind === "artifact-save" ? new Promise(resolve => { finish = resolve; }) : basic(input));
  fireEvent.click(await screen.findByRole("button", { name: "保存 研究笔记.md 的副本" }));
  change({ target: "session-two" }); await act(async () => finish({ ok: true, saved: true }));
  expect(screen.queryByText("已保存副本。")).toBeNull();
});
it("drops late replies on close and does not cancel persisted proposals or remove files", async () => {
  let finish!: (r: ExecutablePluginReply) => void;
  const { change, bridge } = setup(input => input.kind === "artifact-read" ? new Promise(resolve => { finish = resolve; }) : basic(input));
  fireEvent.click(await screen.findByRole("button", { name: /研究笔记.md.*查看/ })); change({ open: false });
  await act(async () => finish({ ok: true, artifact, content: "late" }));
  expect(screen.queryByLabelText("插件文件")).toBeNull();
  expect(bridge.executablePlugins).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "patch-cancel" }));
  change({ open: true }); expect(await screen.findByRole("button", { name: /研究笔记.md.*查看/ })).toBeTruthy();
  expect(screen.queryByText("late")).toBeNull();
});
it("does not issue a request after an immediate draft revision changes before React renders", async () => {
  let revision = 1;
  const { bridge } = setup(basic, { getCurrentRevision: () => revision });
  const save = await screen.findByRole("button", { name: "保存 研究笔记.md 的副本" }); revision = 3;
  fireEvent.click(save); expect(bridge.executablePlugins).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "artifact-save" }));
});
it("discards save feedback after an ABA draft edit even with identical visible draft text", async () => {
  let finish!: (r: ExecutablePluginReply) => void, revision = 1;
  const { change } = setup(input => input.kind === "artifact-save" ? new Promise(resolve => { finish = resolve; }) : basic(input), { getCurrentRevision: () => revision });
  fireEvent.click(await screen.findByRole("button", { name: "保存 研究笔记.md 的副本" }));
  revision = 3; change({ draftRevision: 3 }); await act(async () => finish({ ok: true, saved: true }));
  expect(screen.queryByText("已保存副本。")).toBeNull();
});
it("retains the newer selected reader when an older read arrives late", async () => {
  let finish!: (r: ExecutablePluginReply) => void;
  setup(input => input.kind === "artifact-read" ? new Promise(resolve => { finish = resolve; }) : basic(input));
  fireEvent.click(await screen.findByRole("button", { name: /研究笔记.md.*查看/ })); await inspectPatch();
  await screen.findByRole("button", { name: "申请应用" }); await act(async () => finish({ ok: true, artifact, content: "late" }));
  expect(screen.queryByLabelText("研究笔记.md 的内容")).toBeNull(); expect(screen.getByLabelText("notes.txt 的修改提案")).toBeTruthy();
});
it("shows immutable before/after diff and requires a separate application request", async () => {
  const { bridge } = setup(); await inspectPatch();
  const reader = await screen.findByLabelText("notes.txt 的修改提案");
  expect(reader.querySelector(".is-add")).toHaveTextContent("after"); expect(reader.querySelector(".is-del")).toHaveTextContent("before");
  fireEvent.click(within(reader).getByRole("button", { name: "修改前全文" })); expect(reader).toHaveTextContent("before");
  fireEvent.click(within(reader).getByRole("button", { name: "修改后全文" })); expect(reader).toHaveTextContent("after");
  expect(bridge.executablePlugins).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "patch-apply" }));
  fireEvent.click(within(reader).getByRole("button", { name: "申请应用" }));
  await waitFor(() => expect(bridge.executablePlugins).toHaveBeenCalledWith({ kind: "patch-apply", scope: "workbench", target: "session-one", id: patch.proposal.id }));
});
it("shows background application as pending, provides cancellation and never equates acceptance with applied", async () => {
  let state = outputs;
  const { bridge, onClose } = setup(async input => {
    if (input.kind === "outputs-list") return { ok: true, outputs: state };
    if (input.kind === "patch-apply") { state = { ...outputs, proposals: [{ ...patch.proposal, status: "applying" }] }; return { ok: true, applying: true, outputs: state }; }
    return basic(input);
  });
  await inspectPatch(); fireEvent.click(await screen.findByRole("button", { name: "申请应用" }));
  const cancel = await screen.findByRole("button", { name: "取消应用" });
  expect(screen.queryByText("已应用", { exact: true })).toBeNull(); fireEvent.click(cancel);
  await waitFor(() => expect(bridge.executablePlugins).toHaveBeenCalledWith({ kind: "patch-cancel", scope: "workbench", target: "session-one", id: patch.proposal.id }));
  fireEvent.click(screen.getByRole("button", { name: "返回工作台" })); expect(onClose).toHaveBeenCalledOnce();
});
it("does not let an earlier list response turn an accepted application back into pending", async () => {
  let reads = 0, finish!: (r: ExecutablePluginReply) => void, state = outputs;
  vi.useFakeTimers();
  try {
    setup(input => {
      if (input.kind === "outputs-list") return ++reads === 2 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ ok: true, outputs: state });
      if (input.kind === "patch-apply") { state = { ...outputs, proposals: [{ ...patch.proposal, status: "applying" }] }; return Promise.resolve({ ok: true, applying: true, outputs: state }); }
      return basic(input);
    });
    await act(async () => {});
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /notes.txt.*待应用/ })));
    const apply = screen.getByRole("button", { name: "申请应用" });
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(reads).toBe(2);
    await act(async () => fireEvent.click(apply));
    await act(async () => finish({ ok: true, outputs }));
    expect(screen.getByRole("button", { name: "取消应用" })).toBeTruthy(); expect(screen.queryByRole("button", { name: "申请应用" })).toBeNull();
  } finally { vi.useRealTimers(); }
});
it.each(["conflict", "needs-review", "applied"] as const)("does not offer force/retry for %s proposals", async status => {
  const changed = { ...patch, proposal: { ...patch.proposal, status } };
  setup(async input => input.kind === "patch-read" ? { ok: true, patch: changed } : { ok: true, outputs: { ...outputs, proposals: [changed.proposal] } });
  fireEvent.click(await screen.findByRole("button", { name: /notes.txt/ })); await screen.findByLabelText("notes.txt 的修改提案");
  expect(screen.queryByRole("button", { name: /申请应用/ })).toBeNull(); expect(screen.queryByRole("button", { name: "取消应用" })).toBeNull();
});
it.each(["denied", "cancelled", "failed"] as PluginPatchStatus[])("offers an explicit fresh request after %s, without auto-retry", async status => {
  const changed = { ...patch, proposal: { ...patch.proposal, status } };
  const { bridge } = setup(async input => input.kind === "patch-read" ? { ok: true, patch: changed } : { ok: true, outputs: { ...outputs, proposals: [changed.proposal] } });
  fireEvent.click(await screen.findByRole("button", { name: /notes.txt/ })); expect(await screen.findByRole("button", { name: "重新申请应用" })).toBeEnabled();
  expect(bridge.executablePlugins).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "patch-apply" }));
});
it("keeps host refusal after a permission change visible instead of claiming an application", async () => {
  setup(async input => input.kind === "patch-apply" ? { ok: false, message: "插件授权已变化，请重新生成提案。" } : basic(input));
  await inspectPatch(); fireEvent.click(await screen.findByRole("button", { name: "申请应用" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("插件授权已变化"); expect(screen.queryByText("已应用", { exact: true })).toBeNull();
});
it("never exposes workspace mutation buttons in chat even if a corrupt host reply contains a proposal", async () => {
  setup(basic, { scope: "chat" }); await inspectPatch(); await screen.findByLabelText("notes.txt 的修改提案");
  expect(screen.queryByRole("button", { name: /申请应用/ })).toBeNull();
});
it("rejects mismatched read identities rather than showing the wrong file", async () => {
  setup(async input => input.kind === "artifact-read" ? { ok: true, artifact: { ...artifact, id: "another" }, content: "wrong" } : basic(input));
  fireEvent.click(await screen.findByRole("button", { name: /研究笔记.md.*查看/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent("文件记录已变化"); expect(screen.queryByText("wrong")).toBeNull();
});
it("reports damaged records without offering deletion or silently treating them as empty", async () => {
  setup(async () => ({ ok: true, outputs: { ...empty, damagedArtifacts: 2 } }));
  expect(await screen.findByRole("alert")).toHaveTextContent("2 条记录无法读取");
  expect(screen.queryByRole("button", { name: /删除|重置/ })).toBeNull();
});
it("does not read while hidden and preserves IME Escape before a deliberate close", async () => {
  const { bridge, change, onClose } = setup(basic, { shown: false }); expect(bridge.executablePlugins).not.toHaveBeenCalled();
  change({ shown: true }); await screen.findByRole("button", { name: /研究笔记.md.*查看/ });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "关闭插件文件" }));
  fireEvent.keyDown(document, { key: "Escape", isComposing: true }); fireEvent.keyDown(document, { key: "Escape", keyCode: 229 }); expect(onClose).not.toHaveBeenCalled();
  fireEvent.keyDown(document, { key: "Escape" }); expect(onClose).toHaveBeenCalledOnce();
});
