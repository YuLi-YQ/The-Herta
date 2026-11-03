import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { ExecutablePluginReply, ExecutablePluginRequest } from "../../../shared/executable-plugin-management.js";
import type { PluginMaintenancePreview, PluginMaintenanceResult } from "../../../shared/plugin-maintenance.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { PluginMaintenancePanel } from "./PluginMaintenancePanel.js";

function preview(id = "preview-1", hostRevision = 1): PluginMaintenancePreview {
  return { id, hostRevision, expiresAt: new Date(Date.now() + 600000).toISOString(), usageKnown: false, protectedBlobCount: 3,
    blockedReasons: ["安装备份损坏，未列出无法确认引用的插件包。"], items: [
      { id: "temp-1", category: "temporary", label: "安装临时文件 alpha", bytes: 10, fileCount: 1, linkCount: 0 },
      { id: "archive-1", category: "archive", label: "旧归档 2026-10-01", bytes: 30, fileCount: 1, linkCount: 1, warning: "包含链接入口，目标内容未读取。" },
    ] };
}
function deferred() { let resolve!: (reply: ExecutablePluginReply) => void;
  const promise = new Promise<ExecutablePluginReply>(done => { resolve = done; }); return { resolve, promise }; }
const props = { hostRevision: 1, disabled: false };

it("maintenance UI leaves every candidate unchecked and sends only the explicitly selected confirmed IDs", async () => {
  const changed = vi.fn(), outcome: PluginMaintenanceResult = { deletedCount: 1, deletedBytes: 30, retainedCount: 0, failedCount: 0, cancelled: false, usageKnown: false, issues: [] };
  const request = vi.fn(async (input: ExecutablePluginRequest): Promise<ExecutablePluginReply> => input.kind === "maintenance-preview"
    ? { ok: true, maintenancePreview: preview() } : input.kind === "maintenance-confirm" ? { ok: true, maintenanceResult: outcome } : { ok: true });
  renderWithLocale(<PluginMaintenancePanel {...props} request={request} onChanged={changed} />);
  expect(request).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("button", { name: "检查可清理资料" }));
  expect(await screen.findByRole("button", { name: "确认删除 0 项" })).toBeDisabled();
  expect(screen.getByRole("region", { name: "清理插件资料" })).toHaveFocus();
  screen.getAllByRole("checkbox").forEach(checkbox => expect(checkbox).not.toBeChecked());
  expect(screen.getByText(/保留 3 个被当前版本、历史版本或备份等引用/)).toBeVisible();
  expect(screen.getByText(/部分占用无法完整统计/)).toBeVisible(); expect(screen.getByText(/安装备份损坏/)).toBeVisible();
  expect(screen.getByText("删除后将失去从此归档恢复资料的能力。")).toBeVisible();
  fireEvent.click(screen.getByRole("checkbox", { name: /旧归档 2026-10-01/ }));
  expect(screen.getByText("已选 1 个确认项 · 可核对逻辑大小 30 B")).toBeVisible();
  expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "maintenance-confirm" }));
  fireEvent.click(screen.getByRole("button", { name: "确认删除 1 项" }));
  await screen.findByText("清理完成。已完整删除 1 个确认项。");
  expect(request).toHaveBeenCalledWith({ kind: "maintenance-confirm", previewId: "preview-1", selectedIds: ["archive-1"], hostRevision: 1 });
  expect(changed).toHaveBeenCalledOnce(); expect(screen.queryByRole("checkbox")).toBeNull();
});

it("maintenance UI reports partial archive deletion honestly and requires a new preview instead of retrying", async () => {
  const changed = vi.fn(), result: PluginMaintenanceResult = { deletedCount: 0, deletedBytes: 11, retainedCount: 1, failedCount: 1,
    cancelled: true, usageKnown: false, issues: ["归档内已有部分文件删除，剩余资料已保留。"] };
  const request = vi.fn(async (input: ExecutablePluginRequest): Promise<ExecutablePluginReply> => input.kind === "maintenance-preview"
    ? { ok: true, maintenancePreview: preview() } : input.kind === "maintenance-confirm" ? { ok: true, maintenanceResult: result } : { ok: true });
  renderWithLocale(<PluginMaintenancePanel {...props} request={request} onChanged={changed} />);
  fireEvent.click(screen.getByRole("button", { name: "检查可清理资料" }));
  fireEvent.click(await screen.findByRole("checkbox", { name: /旧归档 2026-10-01/ }));
  fireEvent.click(screen.getByRole("button", { name: "确认删除 1 项" }));
  await screen.findByText("清理已中止。已完整删除 0 个确认项。");
  expect(screen.getByText("已删除文件的逻辑大小：11 B。")).toBeVisible();
  expect(screen.getByText("未完整删除 1 项，其中失败 1 项。")).toBeVisible();
  expect(screen.getByText("归档内已有部分文件删除，剩余资料已保留。")).toBeVisible();
  expect(screen.queryByRole("button", { name: /^确认删除/ })).toBeNull();
  expect(request.mock.calls.filter(([input]) => input.kind === "maintenance-confirm")).toHaveLength(1);
  expect(changed).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "重新检查可清理资料" }));
  await screen.findByRole("button", { name: "确认删除 0 项" });
  screen.getAllByRole("checkbox").forEach(checkbox => expect(checkbox).not.toBeChecked());
  expect(request.mock.calls.filter(([input]) => input.kind === "maintenance-confirm")).toHaveLength(1);
});

it("maintenance UI drops late and selected previews when host revision changes or settings unmount", async () => {
  const old = deferred(), pending = deferred(), changed = vi.fn(); let calls = 0;
  const request = vi.fn((input: ExecutablePluginRequest): Promise<ExecutablePluginReply> => {
    if (input.kind !== "maintenance-preview") return Promise.resolve({ ok: true });
    calls++;
    return calls === 1 ? old.promise : calls === 2 ? Promise.resolve({ ok: true, maintenancePreview: preview("current", 2) }) : pending.promise;
  });
  const { rerender, unmount } = renderWithLocale(<PluginMaintenancePanel {...props} request={request} onChanged={changed} />);
  fireEvent.click(screen.getByRole("button", { name: "检查可清理资料" }));
  rerender(<PluginMaintenancePanel {...props} hostRevision={2} request={request} onChanged={changed} />);
  await act(async () => old.resolve({ ok: true, maintenancePreview: preview("old", 1) }));
  await waitFor(() => expect(request).toHaveBeenCalledWith({ kind: "maintenance-discard", previewId: "old" }));
  expect(screen.queryByRole("checkbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "检查可清理资料" }));
  fireEvent.click(await screen.findByRole("checkbox", { name: /安装临时文件 alpha/ }));
  rerender(<PluginMaintenancePanel {...props} hostRevision={3} request={request} onChanged={changed} />);
  expect(request).toHaveBeenCalledWith({ kind: "maintenance-discard", previewId: "current" });
  expect(screen.queryByRole("checkbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "检查可清理资料" })); unmount();
  await act(async () => pending.resolve({ ok: true, maintenancePreview: preview("unmounted", 3) }));
  expect(request).toHaveBeenCalledWith({ kind: "maintenance-discard", previewId: "unmounted" });
  expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "maintenance-confirm" })); expect(changed).not.toHaveBeenCalled();
});
