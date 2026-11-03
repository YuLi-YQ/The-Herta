import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { ProviderConfig } from "@herta/providers";
import { parseExecutablePluginPackage } from "../../../shared/executable-plugins.js";
import type { PluginWorkshopDraft, PluginWorkshopJob, PluginWorkshopReply, PluginWorkshopRequest, PluginWorkshopInstallation } from "../../../shared/plugin-workshop.js";
import type { ExecutablePluginReply, ExecutablePluginRequest, ExecutablePluginSnapshot } from "../../../shared/executable-plugin-management.js";
import type { ProviderSettingsView } from "../../../shared/provider-settings-ipc.js";
import type { PluginTrialResult } from "../../../shared/plugin-trial.js";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { PluginWorkshopPanel } from "./PluginWorkshopPanel.js";
import { ExecutablePluginSettings } from "./ExecutablePluginSettings.js";

const model = { providerId: "provider", modelId: "verified-model", providerRevision: 4 };
const providers: ProviderSettingsView = { settings: { schemaVersion: 1, providers: [{ id: model.providerId, name: "合成服务", revision: 4, protocol: "openai-chat-completions",
  models: [{ id: model.modelId, validation: { state: "text-available", providerRevision: 4, protocol: "openai-chat-completions" } },
    { id: "old-validation", validation: { state: "text-available", providerRevision: 3, protocol: "openai-chat-completions" } },
    { id: "wrong-protocol", validation: { state: "text-available", providerRevision: 4, protocol: "anthropic-messages" } }],
} as unknown as ProviderConfig], defaultBindings: { persona: { providerId: model.providerId, modelId: model.modelId }, executor: { providerId: model.providerId, modelId: model.modelId } }, sessionBindings: {} }, credentialStatuses: {}, runtimeActive: true };
const pkg = parseExecutablePluginPackage(JSON.stringify({ manifest: { schemaVersion: 2, apiVersion: 1, id: "local.workshop", name: "文本小助手", version: "1.0.0", description: "合成候选", entry: "main.js",
  capabilities: [{ name: "ui.present" }, { name: "draft.append" }], actions: [{ id: "inspect", title: "检查文字", scope: "both", export: "run", capabilities: ["ui.present", "draft.append"], inputs: [{ id: "text", type: "text", label: "输入文字", required: true, maxLength: 100, default: "sample" }] }] },
  files: [{ path: "main.js", source: "export async function run(input) { return input.text; }" }] }));
const draft: PluginWorkshopDraft = { id: "11111111-1111-4111-8111-111111111111", revision: 1, contentHash: "a".repeat(64), createdAt: "2026-11-02T00:00:00.000Z", updatedAt: "2026-11-02T00:00:00.000Z", brief: "整理文字", model, package: pkg, packageJson: JSON.stringify(pkg) };
const target = { id: draft.id, revision: draft.revision, contentHash: draft.contentHash };
const snapshot: ExecutablePluginSnapshot = { revision: 0, hostRevision: 1, items: [] };
const installed: ExecutablePluginSnapshot = { revision: 1, hostRevision: 2, items: [{ manifest: pkg.manifest, contentHash: draft.contentHash, enabled: true, grantRevision: 1, grantedCapabilities: [], history: [], installedAt: draft.createdAt, updatedAt: draft.updatedAt }] };
const installation: PluginWorkshopInstallation = { target, hostRevision: 1, revision: 0, actions: [{ actionId: "inspect", state: "not-run" }], preview: {
  id: "install-one", manifest: pkg.manifest, contentHash: draft.contentHash, files: pkg.files, baseContentHash: null, source: "generated", identical: false,
  changes: [{ path: "main.js", kind: "module", change: "added", before: null, after: pkg.files[0]!.source, diff: `--- /dev/null\n+++ b/main.js\n+${pkg.files[0]!.source}`, additions: 1, deletions: 0 }],
} };
const trial: PluginTrialResult = { id: "trial-one", candidateId: draft.id, revision: 1, sourceHash: "b".repeat(64), contentHash: draft.contentHash, requestHash: "c".repeat(64), actionId: "inspect", scope: "chat", simulated: true, externalEnvironmentVerified: false,
  startedAt: draft.createdAt, endedAt: draft.updatedAt, outcome: "completed", runtimeResult: { ok: true, valueJson: '"sample"' }, trace: [], unverified: [], logs: [{ level: "info", message: "合成日志" }], artifacts: [], proposals: [], draftProposal: "只应留在试跑结果",
  controlledView: { id: "view-one", revision: 1, title: "模拟面板", blocks: [{ type: "text", text: "只读结果" }], actions: [{ id: "next", label: "不可执行的按钮", actionId: "inspect", inputJson: '{"text":"hello"}' }] }, retainedBytes: 100 };
const job = (kind: "generate" | "trial", status: PluginWorkshopJob["status"], busy: boolean): PluginWorkshopJob => ({ id: `${kind}-job`, kind, status, busy, target: kind === "generate" ? null : target, chars: 20, startedAt: draft.createdAt, ...(kind === "generate" ? { model } : {}) });
function mount(request: (input: PluginWorkshopRequest) => Promise<PluginWorkshopReply>, providerView = providers) {
  const api = vi.fn(request), onInstalled = vi.fn(), onChanged = vi.fn(), onBusyChange = vi.fn(), onClose = vi.fn(), getProviderSettings = vi.fn(async () => providerView);
  const view = renderWithLocale(<PluginWorkshopPanel request={api} getProviderSettings={getProviderSettings} hostRevision={1} available={["ui.present", "draft.append"]} disabled={false} onInstalled={onInstalled} onChanged={onChanged} onBusyChange={onBusyChange} onClose={onClose} />);
  return { ...view, api, onInstalled, onChanged, onBusyChange, onClose };
}
const emptyList = { ok: true as const, drafts: { items: [], unreadable: 0 } };
const list = { ok: true as const, drafts: { items: [{ id: draft.id, revision: 1, name: pkg.manifest.name, version: "1.0.0", updatedAt: draft.updatedAt, contentHash: draft.contentHash }], unreadable: 0 } };
async function ready() { await waitFor(() => expect(screen.getByLabelText("制作模型")).toHaveValue(JSON.stringify([model.providerId, model.modelId, model.providerRevision]))); }
async function openDraft() { fireEvent.click(await screen.findByText(/^制作草稿 ·/)); fireEvent.click(screen.getByRole("button", { name: "打开 文本小助手" })); await screen.findByRole("heading", { name: "文本小助手 · 1.0.0" }); }

it("R146 settings opens the workshop with verified persona model and retains the brief on generation failure", async () => {
  const bridge = createMockHertaBridge().bridge; bridge.getProviderSettings = vi.fn(async () => providers); bridge.setProviderBindings = vi.fn();
  bridge.executablePlugins = vi.fn(async (input: ExecutablePluginRequest): Promise<ExecutablePluginReply> => input.kind === "list" ? { ok: true, snapshot, availableCapabilities: ["ui.present", "draft.append"] }
    : input.kind === "storage-usage" ? { ok: true, storage: { status: "ready", usedBytes: 0, limitBytes: 512 * 1024 * 1024, availableBytes: 512 * 1024 * 1024, fileCount: 0, overLimit: false, categories: [] } }
      : input.kind === "workshop-generate" ? { ok: true, job: { ...job("generate", "failed", false), message: "合成生成失败，原要求保留。" } } : emptyList);
  renderWithLocale(<HertaBridgeProvider bridge={bridge}><ExecutablePluginSettings /></HertaBridgeProvider>);
  await screen.findByText(/还没有执行插件/); fireEvent.click(screen.getByRole("button", { name: "让黑塔制作" })); await ready();
  expect(screen.queryByRole("option", { name: /old-validation|wrong-protocol/ })).toBeNull();
  fireEvent.change(screen.getByLabelText("制作要求"), { target: { value: "整理文字，不替换旧稿" } }); fireEvent.click(screen.getByRole("button", { name: "生成候选" }));
  expect(await screen.findByText("合成生成失败，原要求保留。")).toBeVisible(); expect(screen.getByLabelText("制作要求")).toHaveValue("整理文字，不替换旧稿");
  expect(bridge.setProviderBindings).not.toHaveBeenCalled(); expect(bridge.executablePlugins).toHaveBeenCalledWith({ kind: "workshop-generate", target: null, brief: "整理文字，不替换旧稿", model });
});

it("R146 generates, waits for trial closure, reviews immutable output and explicitly installs selected permissions", async () => {
  const result = mount(async input => {
    if (input.kind === "workshop-generate") return { ok: true, job: { ...job("generate", "completed", false), draft } };
    if (input.kind === "workshop-trial") return { ok: true, job: { ...job("trial", "completed", true), trial } };
    if (input.kind === "workshop-status") return { ok: true, job: { ...job("trial", "completed", false), trial } };
    if (input.kind === "workshop-preview") return { ok: true, installation };
    if (input.kind === "workshop-install") return { ok: true, snapshot: installed };
    return emptyList;
  });
  await ready(); fireEvent.change(screen.getByLabelText("制作要求"), { target: { value: "整理文字" } }); fireEvent.click(screen.getByRole("button", { name: "生成候选" }));
  await screen.findByRole("heading", { name: "文本小助手 · 1.0.0" }); fireEvent.click(screen.getByRole("button", { name: "隔离试跑所选操作" }));
  await screen.findByText("正在收尾，稍等片刻…"); expect(screen.getByRole("button", { name: "查看差异与安装权限" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "重新查看状态" })); await screen.findByRole("heading", { name: "模拟完成" });
  expect(screen.getByRole("button", { name: "不可执行的按钮" })).toBeDisabled(); expect(screen.queryByRole("button", { name: /追加到草稿|插入草稿/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "查看差异与安装权限" })); const confirmation = await screen.findByRole("region", { name: "制作候选安装确认" });
  expect(screen.getByText("制作与试跑设置").closest("details")).not.toHaveAttribute("open");
  expect(screen.getByText("试跑结果 · 模拟完成").closest("details")).not.toHaveAttribute("open");
  within(confirmation).getAllByRole("checkbox").forEach(check => expect(check).not.toBeChecked()); expect(within(confirmation).getByText(/尚未试跑/)).toBeVisible();
  expect(result.api).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "workshop-install" }));
  fireEvent.click(within(confirmation).getByLabelText("展示插件面板")); fireEvent.click(within(confirmation).getByRole("button", { name: "确认安装此候选" }));
  expect(screen.getByRole("button", { name: "关闭制作" })).toBeDisabled();
  await waitFor(() => expect(result.onInstalled).toHaveBeenCalledWith(installed));
  expect(screen.getByRole("button", { name: "关闭制作" })).toBeEnabled();
  expect(result.api).toHaveBeenCalledWith({ kind: "workshop-install", target, previewId: "install-one", hostRevision: 1, revision: 0, grants: ["ui.present"] });
  expect(result.api).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "run" }));
});

it("R146 editing invalidates an installation preview and strict save preserves invalid JSON before allowing a corrected revision", async () => {
  const saved = { ...draft, revision: 2, brief: "新要求" };
  const result = mount(async input => input.kind === "workshop-get" ? { ok: true, draft } : input.kind === "workshop-preview" ? { ok: true, installation }
    : input.kind === "workshop-save" ? { ok: true, draft: saved } : list, { ...providers, settings: { ...providers.settings, providers: [] } });
  await openDraft(); expect(screen.getByRole("button", { name: "按要求重新生成" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "查看差异与安装权限" })); await screen.findByRole("region", { name: "制作候选安装确认" });
  fireEvent.click(screen.getByText("制作与试跑设置"));
  fireEvent.change(screen.getByLabelText("制作要求"), { target: { value: "新要求" } });
  expect(screen.queryByRole("region", { name: "制作候选安装确认" })).toBeNull(); expect(result.api).toHaveBeenCalledWith({ kind: "workshop-discard", previewId: "install-one" });
  fireEvent.click(screen.getByText("候选 JSON · 可手动编辑或粘贴")); fireEvent.change(screen.getByLabelText("候选 JSON"), { target: { value: "{bad json" } });
  fireEvent.click(screen.getByRole("button", { name: "检查并保存草稿" })); expect(screen.getByRole("alert")).toHaveTextContent("不符合插件格式"); expect(screen.getByLabelText("候选 JSON")).toHaveValue("{bad json");
  expect(result.api).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "workshop-save" })); expect(screen.getByRole("button", { name: "查看差异与安装权限" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("候选 JSON"), { target: { value: JSON.stringify(pkg) } }); fireEvent.click(screen.getByRole("button", { name: "检查并保存草稿" }));
  await screen.findByText("制作草稿已保存，先前试跑与安装预览已失效。"); expect(result.api).toHaveBeenCalledWith({ kind: "workshop-save", target, brief: "新要求", packageJson: JSON.stringify(pkg), model });
});

it("R146 cancels only its late generation job after unmount and never adopts the late draft", async () => {
  let finish!: (reply: PluginWorkshopReply) => void;
  const result = mount(input => input.kind === "workshop-generate" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(emptyList));
  await ready(); fireEvent.change(screen.getByLabelText("制作要求"), { target: { value: "迟到候选" } }); fireEvent.click(screen.getByRole("button", { name: "生成候选" })); result.unmount();
  await act(async () => finish({ ok: true, job: { ...job("generate", "running", true), id: "owned-late-job" } }));
  expect(result.api).toHaveBeenCalledWith({ kind: "workshop-cancel", jobId: "owned-late-job" });
  expect(result.api).not.toHaveBeenCalledWith({ kind: "workshop-discard" }); expect(result.onInstalled).not.toHaveBeenCalled();
});

it("R146 previews damaged draft deletion, refuses unknown scope and reports partial deletion only after confirmation", async () => {
  const damagedId = "22222222-2222-4222-8222-222222222222"; let attempts = 0;
  const result = mount(async input => {
    if (input.kind === "workshop-delete-preview") return { ok: true, deletePreview: { id: `delete-${++attempts}`, draftId: damagedId, damaged: true, bytes: attempts === 1 ? null : 20, fileCount: attempts === 1 ? null : 2, canConfirm: attempts !== 1, expiresAt: new Date(Date.now() + 600000).toISOString() } };
    if (input.kind === "workshop-delete-confirm") return { ok: true, deleteResult: { draftId: damagedId, deleted: false, deletedFiles: 1, deletedBytes: 10, remainingFiles: 1, cancelled: false, message: "部分文件已删除，其余保留，请重新检查。" } };
    return { ok: true, drafts: { items: [], unreadable: 2, damagedIds: [damagedId] } };
  });
  await ready(); fireEvent.click(screen.getByText(/^制作草稿 ·/)); fireEvent.click(await screen.findByRole("button", { name: /^检查删除损坏草稿/ }));
  await screen.findByRole("region", { name: "删除制作草稿确认" }); expect(screen.getByText(/逻辑大小无法统计/)).toBeVisible(); expect(screen.getByRole("button", { name: "确认删除制作草稿" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "取消删除" })); expect(result.api).toHaveBeenCalledWith({ kind: "workshop-delete-discard", previewId: "delete-1" });
  fireEvent.click(screen.getByRole("button", { name: /^检查删除损坏草稿/ })); await waitFor(() => expect(screen.getByRole("button", { name: "确认删除制作草稿" })).toBeEnabled());
  expect(result.api).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "workshop-delete-confirm" })); fireEvent.click(screen.getByRole("button", { name: "确认删除制作草稿" }));
  expect(await screen.findByText(/已删除 1 个文件.*剩余 1 个/)).toBeVisible(); expect(screen.queryByRole("button", { name: "确认删除制作草稿" })).toBeNull();
  expect(result.api).toHaveBeenCalledWith({ kind: "workshop-delete-confirm", previewId: "delete-2" });
});
