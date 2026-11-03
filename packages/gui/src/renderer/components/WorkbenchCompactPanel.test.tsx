import type { CompactReply, CompactView } from "@herta/core";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  bridge: { getSessionCompact: vi.fn(), updateSessionCompact: vi.fn() },
}));
vi.mock("../context/HertaBridgeContext.js", () => ({
  useHertaBridge: () => ({ bridge: mock.bridge }),
}));
vi.mock("./MessageContent.js", () => ({
  MessageContent: ({ text }: { text: string }) => <p>{text}</p>,
}));

import {
  CompactStrip,
  useWorkbenchCompact,
  WorkbenchCompactPanel,
} from "./WorkbenchCompactPanel.js";

const state = (status: CompactView["status"] = "idle"): CompactView => ({
  revision: 1,
  status,
  scheduledPersistent: false,
  recap: null,
  recordLength: 10,
});
function Host({ id = "a", busy = false }: { id?: string; busy?: boolean }) {
  const compact = useWorkbenchCompact(id, busy, true);
  return (
    <>
      <button type="button" onClick={() => void compact.schedule()}>
        安排
      </button>
      <button type="button" onClick={compact.open}>
        打开
      </button>
      <CompactStrip compact={compact} />
      <WorkbenchCompactPanel compact={compact} />
    </>
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
  mock.bridge.getSessionCompact.mockResolvedValue({ ok: true, view: state() });
  mock.bridge.updateSessionCompact.mockResolvedValue({
    ok: true,
    view: { ...state("scheduled"), revision: 2 },
  });
});
it("schedules only the current target, exposes cancellation and avoids scheduling it twice", async () => {
  render(<Host />);
  fireEvent.click(screen.getByRole("button", { name: "安排" }));
  await screen.findByText("下一回合整理先前记录");
  expect(mock.bridge.updateSessionCompact).toHaveBeenCalledWith("a", 1, {
    type: "schedule",
  });
  mock.bridge.getSessionCompact.mockResolvedValue({
    ok: true,
    view: { ...state("scheduled"), revision: 2 },
  });
  fireEvent.click(screen.getByRole("button", { name: "安排" }));
  await waitFor(() =>
    expect(mock.bridge.getSessionCompact).toHaveBeenCalledTimes(3),
  );
  expect(mock.bridge.updateSessionCompact).toHaveBeenCalledOnce();
  mock.bridge.updateSessionCompact.mockResolvedValue({
    ok: true,
    view: { ...state(), revision: 3, reason: "cancelled" },
  });
  fireEvent.click(screen.getByRole("button", { name: "撤销整理" }));
  await screen.findByText("已撤销下一回合的整理安排。");
  expect(mock.bridge.updateSessionCompact).toHaveBeenLastCalledWith("a", 2, {
    type: "cancel",
  });
});
it("reads a saved recap with exact block coverage and an unknown legacy timestamp", async () => {
  mock.bridge.getSessionCompact.mockResolvedValue({
    ok: true,
    view: {
      ...state("completed"),
      recap: { text: "只读的先前记录", boundaryIndex: 6, generatedAt: null },
    },
  });
  render(<Host />);
  const button = screen.getByRole("button", { name: "打开" });
  button.focus();
  fireEvent.click(button);
  await screen.findByText("只读的先前记录");
  expect(
    screen.getByText("覆盖前 6 条记录（共 10 条） · 生成时间：未记录"),
  ).toBeInTheDocument();
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(
    screen.getByText("这是整理后的摘要，原消息仍在对话中。"),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /重新读取|重试读取/ }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "关闭先前记录" }));
  expect(button).toHaveFocus();
  const reads = mock.bridge.getSessionCompact.mock.calls.length;
  mock.bridge.getSessionCompact.mockResolvedValue({
    ok: true,
    view: {
      ...state("completed"),
      recap: {
        text: "重新打开时读取的摘要",
        boundaryIndex: 8,
        generatedAt: "2026-11-01T00:00:00.000Z",
      },
    },
  });
  fireEvent.click(button);
  await screen.findByText("重新打开时读取的摘要");
  expect(mock.bridge.getSessionCompact).toHaveBeenCalledTimes(reads + 1);
  expect(
    screen.queryByRole("button", { name: /重新读取|重试读取/ }),
  ).toBeNull();
});
it("refreshes after a completed turn and leaves failures explicit", async () => {
  const view = render(<Host busy />);
  expect(mock.bridge.getSessionCompact).not.toHaveBeenCalled();
  mock.bridge.getSessionCompact.mockResolvedValue({
    ok: true,
    view: { ...state("failed"), reason: "input_limit" },
  });
  view.rerender(<Host />);
  await screen.findByText("更早的内容超出整理额度，本次未整理，原记录仍保留。");
});

it("refreshes an arranged compaction at turn start so it no longer claims to wait for the next turn", async () => {
  mock.bridge.getSessionCompact.mockResolvedValue({
    ok: true,
    view: state("scheduled"),
  });
  const host = render(<Host />);
  await screen.findByText("下一回合整理先前记录");
  mock.bridge.getSessionCompact.mockResolvedValue({
    ok: true,
    view: state("running"),
  });
  host.rerender(<Host busy />);
  await screen.findByText("正在整理先前记录…");
  expect(screen.queryByText("下一回合整理先前记录")).toBeNull();
});
it("drops late mutation results after an A to B to A transition and rereads authoritative state", async () => {
  let finish!: (reply: CompactReply) => void;
  mock.bridge.updateSessionCompact.mockImplementationOnce(
    () =>
      new Promise<CompactReply>((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(<Host />);
  fireEvent.click(screen.getByRole("button", { name: "安排" }));
  await waitFor(() =>
    expect(mock.bridge.updateSessionCompact).toHaveBeenCalledOnce(),
  );
  view.rerender(<Host id="b" />);
  view.rerender(<Host />);
  mock.bridge.getSessionCompact.mockResolvedValue({
    ok: true,
    view: { ...state(), reason: "cancelled" },
  });
  await act(async () => finish({ ok: true, view: state("scheduled") }));
  await screen.findByText("已撤销下一回合的整理安排。");
  expect(screen.queryByText("下一回合整理先前记录")).toBeNull();
});
it("does not write while a turn is running and reports read failures without success claims", async () => {
  const view = render(<Host busy />);
  fireEvent.click(screen.getByRole("button", { name: "安排" }));
  expect(mock.bridge.updateSessionCompact).not.toHaveBeenCalled();
  mock.bridge.getSessionCompact.mockRejectedValue(Error("unavailable"));
  view.rerender(<Host />);
  await screen.findByText("暂时无法读取先前记录，请重试。");
  expect(mock.bridge.updateSessionCompact).not.toHaveBeenCalled();
});
it("offers a retry only after a read failure and removes it when the next read succeeds", async () => {
  mock.bridge.getSessionCompact.mockRejectedValue(Error("read failure"));
  render(<Host />);
  fireEvent.click(screen.getByRole("button", { name: "打开" }));
  const panel = screen.getByRole("dialog", { name: "先前记录" });
  await within(panel).findByRole("alert");
  expect(within(panel).queryByText("先前记录已整理")).toBeNull();
  mock.bridge.getSessionCompact.mockResolvedValue({
    ok: true,
    view: {
      ...state("completed"),
      recap: {
        text: "重试读取成功的摘要",
        boundaryIndex: 6,
        generatedAt: null,
      },
    },
  });
  fireEvent.click(within(panel).getByRole("button", { name: "重试读取" }));
  await within(panel).findByText("重试读取成功的摘要");
  expect(within(panel).queryByRole("button", { name: "重试读取" })).toBeNull();
  expect(within(panel).queryByRole("alert")).toBeNull();
  expect(within(panel).getByRole("status")).toHaveTextContent("先前记录已整理");
  expect(mock.bridge.updateSessionCompact).not.toHaveBeenCalled();
});
