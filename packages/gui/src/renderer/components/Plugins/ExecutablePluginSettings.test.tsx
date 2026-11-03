import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { parseExecutablePluginManifest } from "../../../shared/executable-plugins.js";
import type { ExecutablePluginFileChange, ExecutablePluginPreview, ExecutablePluginReply, ExecutablePluginRequest, ExecutablePluginSnapshot } from "../../../shared/executable-plugin-management.js";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { ExecutablePluginSettings } from "./ExecutablePluginSettings.js";
import { PluginSettings } from "./PluginSettings.js";

const manifest = parseExecutablePluginManifest(JSON.stringify({
  schemaVersion: 2, apiVersion: 1, id: "local.analyze", name: "黑塔的资料整理", description: "整理选定资料。", version: "1.1.0", entry: "main.js",
  capabilities: [{ name: "storage.get" }, { name: "draft.append" }, { name: "network.request", origins: ["https://example.invalid"], methods: ["GET"] }],
  actions: [{ id: "analyze", title: "整理资料", scope: "both", export: "run", inputs: [], capabilities: ["storage.get", "draft.append", "network.request"] }],
}));
const empty: ExecutablePluginSnapshot = { revision: 2, hostRevision: 3, items: [] };
function change(path: string, kind: ExecutablePluginFileChange["kind"], before: string | null, after: string | null): ExecutablePluginFileChange {
  const lines = (text: string | null) => text === null || text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const oldLines = lines(before), newLines = lines(after);
  return { path, kind, before, after, change: before === null ? "added" : after === null ? "removed" : "modified",
    diff: `--- a/${path}\n+++ b/${path}\n` + [...oldLines.map(line => "-" + line), ...newLines.map(line => "+" + line)].join("\n"), additions: newLines.length, deletions: oldLines.length };
}
const source = "export function run() { return '<img src=x onerror=evil()>'; }";
const preview: ExecutablePluginPreview = { id: "preview-one", manifest, contentHash: "a".repeat(64), files: [{ path: "main.js", source }],
  baseContentHash: null, changes: [change("manifest.json", "manifest", null, JSON.stringify(manifest, null, 2)), change("main.js", "module", null, source)], source: "file", identical: false };
const installed: ExecutablePluginSnapshot = { revision: 4, hostRevision: 5, items: [{ manifest, contentHash: preview.contentHash, enabled: true, grantRevision: 1, grantedCapabilities: [{ name: "storage.get" }], history: [{ contentHash: "b".repeat(64), version: "1.0.0", installedAt: "2026-11-01T00:00:00Z" }], installedAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z" }] };
const available = ["storage.get", "draft.append"] as const;
function mount(request: (input: ExecutablePluginRequest) => Promise<ExecutablePluginReply>) {
  const bridge = createMockHertaBridge().bridge;
  bridge.executablePlugins = vi.fn((input: ExecutablePluginRequest): Promise<ExecutablePluginReply> => input.kind === "storage-usage" ? Promise.resolve({ ok: true, storage: {
    status: "ready", usedBytes: 0, limitBytes: 512 * 1024 * 1024, availableBytes: 512 * 1024 * 1024, fileCount: 0, overLimit: false,
    categories: ["packages", "private-data", "artifacts", "proposals"].map(id => ({ id: id as "packages" | "private-data" | "artifacts" | "proposals", usedBytes: 0, fileCount: 0 })),
  } }) : input.kind === "network-settings-get" ? Promise.resolve({ ok: true, networkSettings: { revision: 0, config: {
    mode: "direct", proxyUrl: "", resolver: "system", dohUrl: "", dohBootstrapAddress: "",
  } } }) : request(input));
  return { bridge, ...renderWithLocale(<HertaBridgeProvider bridge={bridge}><ExecutablePluginSettings /></HertaBridgeProvider>) };
}

it("requires an explicit preview confirmation and starts every requested permission unchecked", async () => {
  const { bridge } = mount(async input => ({ ok: true, snapshot: empty, availableCapabilities: available, ...(input.kind === "preview" ? { preview } : {}) }));
  await screen.findByText(/还没有执行插件/);
  fireEvent.click(screen.getByRole("button", { name: "从文件添加" }));
  const panel = await screen.findByRole("region", { name: "执行插件安装预览" });
  const checks = within(panel).getAllByRole("checkbox"); checks.forEach(check => expect(check).not.toBeChecked());
  expect(within(panel).getByLabelText(/联网请求/)).toBeDisabled();
  expect(bridge.executablePlugins).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "confirm" }));
  fireEvent.click(within(panel).getByLabelText("准备聊天草稿"));
  fireEvent.click(within(panel).getByRole("button", { name: "确认安装插件" }));
  await waitFor(() => expect(bridge.executablePlugins).toHaveBeenCalledWith({ kind: "confirm", previewId: preview.id, revision: 2, grants: ["draft.append"] }));
  expect(bridge.executablePlugins).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "run" }));
});

it("releases a dismissed preview and keeps code content inert", async () => {
  const { bridge, container } = mount(async input => ({ ok: true, snapshot: empty, availableCapabilities: available, ...(input.kind === "preview" ? { preview } : {}) }));
  await screen.findByText(/还没有执行插件/); fireEvent.click(screen.getByRole("button", { name: "从文件添加" }));
  fireEvent.change(await screen.findByLabelText("查看文件"), { target: { value: "main.js" } });
  expect(screen.getByRole("region", { name: "只读代码" })).toHaveTextContent(preview.files[0]!.source); expect(container.querySelector("img")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "取消安装" }));
  await waitFor(() => expect(bridge.executablePlugins).toHaveBeenCalledWith({ kind: "discard", previewId: preview.id }));
  expect(bridge.executablePlugins).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "confirm" }));
});

it("R145 reviews actual added removed code and manifest permissions without automatic installation", async () => {
  const next: ExecutablePluginPreview = { ...preview, existing: installed.items[0], baseContentHash: "b".repeat(64), changes: [
    change("manifest.json", "manifest", '{"capabilities":[]}', JSON.stringify(manifest, null, 2)),
    change("old.js", "module", "export const oldVersion = 1;", null), change("main.js", "module", null, source),
  ] };
  const { bridge, container } = mount(async input => ({ ok: true, snapshot: empty, availableCapabilities: available, ...(input.kind === "preview" ? { preview: next } : {}) }));
  await screen.findByText(/还没有执行插件/); fireEvent.click(screen.getByRole("button", { name: "从文件添加" }));
  const file = await screen.findByLabelText("查看文件");
  expect(screen.getByRole("region", { name: "只读代码" })).toHaveTextContent("https://example.invalid");
  fireEvent.change(file, { target: { value: "old.js" } });
  expect(container.querySelector(".round-code-row.is-del")).toHaveTextContent("oldVersion");
  expect(screen.getByRole("button", { name: "修改后全文" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "修改前全文" }));
  expect(screen.getByRole("region", { name: "只读代码" })).toHaveTextContent("export const oldVersion = 1;");
  fireEvent.change(file, { target: { value: "main.js" } });
  expect(container.querySelector(".round-code-row.is-add")).toHaveTextContent(source); expect(container.querySelector("img")).toBeNull();
  expect(screen.getByRole("button", { name: "修改前全文" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "确认更新插件" })).toBeEnabled();
  screen.getAllByRole("checkbox").forEach(check => expect(check).not.toBeChecked());
  expect(bridge.executablePlugins).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "confirm" }));
  expect(bridge.executablePlugins).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "run" }));
});

it("discards a late preview after settings unmount without installing it", async () => {
  let finish!: (reply: ExecutablePluginReply) => void;
  const { bridge, unmount } = mount(input => input.kind === "preview" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ ok: true, snapshot: empty, availableCapabilities: available }));
  await screen.findByText(/还没有执行插件/); fireEvent.click(screen.getByRole("button", { name: "从文件添加" })); unmount();
  await act(async () => finish({ ok: true, snapshot: empty, preview }));
  expect(bridge.executablePlugins).toHaveBeenCalledWith({ kind: "discard", previewId: preview.id });
  expect(bridge.executablePlugins).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "confirm" }));
});

it("requires rollback preview and fresh permission confirmation", async () => {
  const previous = { ...preview, source: "rollback" as const, manifest: { ...manifest, version: "1.0.0" }, existing: installed.items[0] };
  const { bridge } = mount(async input => ({ ok: true, snapshot: installed, availableCapabilities: available, ...(input.kind === "rollback-preview" ? { preview: previous } : {}) }));
  fireEvent.click(await screen.findByRole("button", { name: "恢复至 1.0.0" }));
  await screen.findByRole("button", { name: "确认恢复此版本" });
  expect(bridge.executablePlugins).toHaveBeenCalledWith({ kind: "rollback-preview", id: manifest.id, contentHash: "b".repeat(64), revision: 4 });
  expect(screen.getByLabelText("读取插件自己的资料")).not.toBeChecked();
  expect(bridge.executablePlugins).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "confirm" }));
});

it("edits grants explicitly and requires object-specific removal confirmation", async () => {
  const { bridge } = mount(async () => ({ ok: true, snapshot: installed, availableCapabilities: available }));
  fireEvent.click(await screen.findByRole("button", { name: "调整权限" }));
  const allowed = screen.getByLabelText("读取插件自己的资料"); expect(allowed).toBeChecked(); fireEvent.click(allowed);
  expect(bridge.executablePlugins).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "grants" }));
  fireEvent.click(screen.getByRole("button", { name: "保存插件权限" }));
  await waitFor(() => expect(bridge.executablePlugins).toHaveBeenCalledWith({ kind: "grants", id: manifest.id, grants: [], revision: 4 }));
  await waitFor(() => expect(screen.getByRole("button", { name: "移除插件" })).not.toBeDisabled());
  fireEvent.click(screen.getByRole("button", { name: "移除插件" })); expect(screen.getByRole("alert")).toHaveTextContent(`移除“${manifest.name}”`);
  expect(bridge.executablePlugins).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "remove" }));
  fireEvent.click(screen.getByRole("button", { name: "确认移除执行插件" }));
  await waitFor(() => expect(bridge.executablePlugins).toHaveBeenCalledWith({ kind: "remove", id: manifest.id, revision: 4 }));
});

it("explains archived records before a damaged-list reset", async () => {
  const { bridge } = mount(async input => ({ ok: true, snapshot: input.kind === "reset" ? empty : { ...empty, damaged: true }, availableCapabilities: available }));
  fireEvent.click(await screen.findByRole("button", { name: "重新建立插件列表" }));
  expect(screen.getByText(/归档现有插件文件和记录/)).toBeTruthy();
  expect(bridge.executablePlugins).not.toHaveBeenCalledWith({ kind: "reset" });
  fireEvent.click(screen.getByRole("button", { name: "确认重建执行插件列表" }));
  await waitFor(() => expect(bridge.executablePlugins).toHaveBeenCalledWith({ kind: "reset" }));
});

it("does not discard a preview or selected grants when confirmation fails", async () => {
  mount(async input => input.kind === "confirm" ? { ok: false, message: "列表已变化，请重新预览。" } : { ok: true, snapshot: empty, availableCapabilities: available, ...(input.kind === "preview" ? { preview } : {}) });
  await screen.findByText(/还没有执行插件/); fireEvent.click(screen.getByRole("button", { name: "从文件添加" }));
  fireEvent.click(await screen.findByLabelText("准备聊天草稿")); fireEvent.click(screen.getByRole("button", { name: "确认安装插件" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("列表已变化"); expect(screen.getByLabelText("准备聊天草稿")).toBeChecked();
});

it("hides the new section when the runtime bridge is unavailable", () => {
  const bridge = createMockHertaBridge().bridge; delete bridge.executablePlugins;
  const { container } = renderWithLocale(<HertaBridgeProvider bridge={bridge}><ExecutablePluginSettings /></HertaBridgeProvider>);
  expect(container.textContent).toBe("");
});

it("names both plugin sections so their file actions have an unambiguous context", async () => {
  const bridge = createMockHertaBridge().bridge;
  bridge.promptPlugins = vi.fn(async () => ({ ok: true as const, snapshot: { revision: 0, items: [] } }));
  bridge.executablePlugins = vi.fn(async (): Promise<ExecutablePluginReply> => ({ ok: true, snapshot: empty, availableCapabilities: available }));
  renderWithLocale(<HertaBridgeProvider bridge={bridge}><PluginSettings /></HertaBridgeProvider>);
  expect(screen.getByRole("heading", { name: "提示词插件" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "执行插件" })).toBeVisible();
  await screen.findByText(/还没有执行插件/);
  expect(within(screen.getByRole("region", { name: "提示词插件" })).getByRole("button", { name: "从文件安装 / 更新" })).toBeVisible();
  expect(within(screen.getByRole("region", { name: "执行插件" })).getByRole("button", { name: "从文件添加" })).toBeVisible();
});
