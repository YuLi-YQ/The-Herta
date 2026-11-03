import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { ExecutablePluginReply } from "../../../shared/executable-plugin-management.js";
import type { PluginStorageSnapshot } from "../../../shared/plugin-storage.js";
import type { HertaBridge } from "../../ipc/bridge-types.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { PluginStorageSummary } from "./PluginStorageSummary.js";

type Request = NonNullable<HertaBridge["executablePlugins"]>;
const MiB = 1024 * 1024;
function snapshot(usedBytes = 0): PluginStorageSnapshot {
  return { status: "ready", usedBytes, limitBytes: 512 * MiB, availableBytes: Math.max(0, 512 * MiB - usedBytes), fileCount: usedBytes ? 1 : 0,
    overLimit: usedBytes > 512 * MiB, categories: [
      { id: "packages", usedBytes, fileCount: usedBytes ? 1 : 0 }, { id: "private-data", usedBytes: 0, fileCount: 0 },
      { id: "artifacts", usedBytes: 0, fileCount: 0 }, { id: "proposals", usedBytes: 0, fileCount: 0 },
    ] };
}
function deferred() { let resolve!: (reply: ExecutablePluginReply) => void;
  const promise = new Promise<ExecutablePluginReply>(done => { resolve = done; }); return { promise, resolve }; }

it("storage summary distinguishes initial loading from real zero and exposes a keyboard-focusable native breakdown", async () => {
  const pending = deferred(), request = vi.fn<Request>(() => pending.promise);
  const { container } = renderWithLocale(<PluginStorageSummary request={request} refreshKey={1} />);
  expect(screen.getByRole("status")).toHaveTextContent("正在统计"); expect(screen.queryByRole("meter")).toBeNull();
  expect(screen.queryByText("0 B")).toBeNull(); expect(request).toHaveBeenCalledExactlyOnceWith({ kind: "storage-usage" });
  await act(async () => pending.resolve({ ok: true, storage: snapshot() }));
  expect(screen.getByRole("status")).toHaveTextContent("0 B / 512 MiB");
  expect(screen.getByRole("meter", { name: "插件空间使用量" })).toHaveAttribute("aria-valuenow", "0");
  expect(container.querySelector<HTMLElement>(".plugin-storage-meter > span")!.style.width).toBe("0%");
  const disclosure = screen.getByText("查看占用明细"), details = disclosure.closest("details")!;
  expect(details.open).toBe(false); fireEvent.click(disclosure); await waitFor(() => expect(details.open).toBe(true));
  for (const label of ["插件包", "插件私有资料", "生成文件", "修改提案"]) expect(screen.getByText(label)).toBeVisible();
  const refresh = screen.getByRole("button", { name: "刷新插件空间" }); refresh.focus(); expect(refresh).toHaveFocus();
});

it("storage summary preserves and labels prior over-limit data during a refresh failure", async () => {
  const pending = deferred(), request = vi.fn<Request>().mockResolvedValueOnce({ ok: true, storage: snapshot(600 * MiB) }).mockReturnValueOnce(pending.promise);
  renderWithLocale(<PluginStorageSummary request={request} refreshKey={1} />);
  await screen.findByText(/已超过空间上限，新增写入会被拒绝/);
  expect(screen.getByRole("meter")).toHaveAttribute("aria-valuetext", "已用 600 MiB，上限 512 MiB，已超限");
  const refresh = screen.getByRole("button", { name: "刷新插件空间" }); fireEvent.click(refresh);
  expect(refresh).toBeDisabled(); expect(screen.getByRole("status")).toHaveTextContent("600 MiB / 512 MiB");
  expect(screen.getByText("正在刷新，显示上次统计。")).toBeVisible();
  await act(async () => pending.resolve({ ok: false, message: "无法完整核对插件资料空间，原有文件保持不变。" }));
  expect(screen.getByRole("alert")).toHaveTextContent("无法完整核对插件资料空间");
  expect(screen.getByText("显示上次成功统计。")).toBeVisible(); expect(screen.getByText("上次统计已超过空间上限。")).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent("600 MiB / 512 MiB"); expect(refresh).not.toBeDisabled();
  expect(screen.queryByRole("button", { name: /清理|删除/ })).toBeNull();
});

it("storage summary ignores a stale reply after the installation revision changes and releases an unmounted request", async () => {
  const old = deferred(), current = deferred(), late = deferred();
  const request = vi.fn<Request>().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise).mockReturnValueOnce(late.promise);
  const { rerender, unmount } = renderWithLocale(<PluginStorageSummary request={request} refreshKey={1} />);
  rerender(<PluginStorageSummary request={request} refreshKey={2} />);
  await act(async () => current.resolve({ ok: true, storage: snapshot(128 * MiB) }));
  await act(async () => old.resolve({ ok: true, storage: snapshot(512 * MiB) }));
  expect(screen.getByRole("status")).toHaveTextContent("128 MiB / 512 MiB");
  fireEvent.click(screen.getByRole("button", { name: "刷新插件空间" })); unmount();
  await act(async () => late.resolve({ ok: false, message: "迟到失败" }));
  expect(screen.queryByRole("region", { name: "插件空间" })).toBeNull(); expect(screen.queryByText("迟到失败")).toBeNull();
  expect(request).toHaveBeenCalledTimes(3);
});
