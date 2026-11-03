import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ChatStorage } from "./ChatStorage.js";
import type { ChatStorageUsage } from "../../shared/herta-chat.js";
const usage = (complete = true): ChatStorageUsage => ({
  checkedAt: "2026-10-20T00:00:00.000Z", historyBytes: 1000, historyLimitBytes: 64 * 1048576,
  images: { bytes: 5000, files: 3, limitBytes: 256 * 1048576 },
  audit: { complete, current: 1, backupOnly: 0, unreferenced: 2, unreferencedBytes: 4000, missing: 0, checkedBackups: 1 },
  quarantine: [{ id: "20261020T000000-0a1b2c3d", at: "2026-10-20T00:00:00Z", files: 4, bytes: 2048 }],
});
it("previews, then isolates with the preview token and rescans; permanent deletion needs a second confirmation", async () => {
  const onCleanup = vi.fn(async () => null), onRefresh = vi.fn(async () => true);
  const { rerender } = render(<ChatStorage usage={usage()} busy={false} onRefresh={onRefresh} onCleanup={onCleanup} />);
  fireEvent.click(screen.getByText("预览可清理图片"));
  await waitFor(() => expect(onCleanup).toHaveBeenCalledWith({ type: "image-preview" }));
  expect(onRefresh).not.toHaveBeenCalled();
  rerender(<ChatStorage usage={usage()} cleanup={{ preview: { token: "t1", files: 2, bytes: 4000, expiresAt: "x" } }} busy={false} onRefresh={onRefresh} onCleanup={onCleanup} />);
  expect(screen.getByText(/将移入隔离区：2 张/)).toBeTruthy();
  fireEvent.click(screen.getByText("移入隔离区"));
  await waitFor(() => expect(onCleanup).toHaveBeenCalledWith({ type: "image-isolate", token: "t1" }));
  await waitFor(() => expect(onRefresh).toHaveBeenCalled());
  fireEvent.click(screen.getByText("永久删除"));
  expect(onCleanup).not.toHaveBeenCalledWith(expect.objectContaining({ type: "image-discard" }));
  fireEvent.click(screen.getByText("确认永久删除"));
  await waitFor(() => expect(onCleanup).toHaveBeenCalledWith({ type: "image-discard", id: "20261020T000000-0a1b2c3d" }));
  fireEvent.click(screen.getByText("恢复"));
  await waitFor(() => expect(onCleanup).toHaveBeenCalledWith({ type: "image-restore", id: "20261020T000000-0a1b2c3d" }));
});
it("says how many library entries are not image files while the quarantine stays usable", () => {
  const withFolder = { ...usage(false), images: { ...usage().images, others: 2 } };
  const { rerender } = render(<ChatStorage usage={withFolder} busy={false} onRefresh={async () => true} onCleanup={async () => null} />);
  expect(screen.getByText(/另有 2 个项目不是图片文件/)).toBeTruthy();
  expect(screen.queryByText("预览可清理图片")).toBeNull();
  expect(screen.getByText("恢复")).toBeTruthy();
  rerender(<ChatStorage usage={usage()} busy={false} onRefresh={async () => true} onCleanup={async () => null} />);
  expect(screen.queryByText(/不是图片文件/)).toBeNull();
});
it("explains a library location that is not a plain folder instead of counting nothing", () => {
  const invalid = { ...usage(false), images: { bytes: 0, files: 0, limitBytes: 256 * 1048576, invalid: true as const } };
  render(<ChatStorage usage={invalid} busy={false} onRefresh={async () => true} onCleanup={async () => null} />);
  expect(screen.getByText(/不是普通文件夹/).getAttribute("role")).toBe("alert");
  expect(screen.queryByText(/图片库保存了/)).toBeNull();
  expect(screen.getByText("恢复")).toBeTruthy();
});
it("offers no cleanup when the audit is incomplete and shows cleanup errors inside the panel", async () => {
  const onCleanup = vi.fn(async () => "清理预览已过期，请重新预览。");
  const { rerender } = render(<ChatStorage usage={usage(false)} busy={false} onRefresh={async () => true} onCleanup={onCleanup} />);
  expect(screen.queryByText("预览可清理图片")).toBeNull();
  rerender(<ChatStorage usage={usage()} busy={false} onRefresh={async () => true} onCleanup={onCleanup} />);
  fireEvent.click(screen.getByText("预览可清理图片"));
  await waitFor(() => expect(screen.getByText("清理预览已过期，请重新预览。")).toBeTruthy());
});
