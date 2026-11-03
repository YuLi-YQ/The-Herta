import type {
  DraftChatContextInput,
  DraftChatContextReply,
  HertaChatSnapshot,
} from "../../shared/herta-chat.js";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({
  bridge: {
    draftChatContext: vi.fn(),
    cancelChatContextDraft: vi.fn(),
    manageHertaChat: vi.fn(),
  },
  receive: vi.fn(),
  saving: vi.fn(),
}));
vi.mock("../context/HertaBridgeContext.js", () => ({
  useHertaBridge: () => ({ bridge: mock.bridge }),
}));
import { ChatContextPanel, useChatContext } from "./ChatContextPanel.js";
const snapshot = (id = "a", revision = 3): HertaChatSnapshot => ({
  revision,
  activeId: id,
  chats: [],
  messages: [0, 1, 2, 3].map((i) => ({
    id: `${i}`,
    role: i % 2 ? "assistant" : "user",
    text: `内容${i}`,
    at: "2026-11-01T00:00:00Z",
    status: "complete",
  })),
  contextStart: 0,
  contextNote: "原来的要点",
  contextCharacters: 12,
  busy: false,
  error: null,
});
const result = (
  input: DraftChatContextInput,
  text = "模型起草的要点",
): DraftChatContextReply => ({
  ok: true,
  chatId: input.chatId,
  requestId: input.requestId,
  revision: input.expectedRevision,
  keepTurns: input.keepTurns,
  boundaryIndex: 4,
  text,
  providerId: input.providerId,
  modelId: input.modelId,
  providerRevision: input.providerRevision,
  generatedAt: "2026-11-01T01:00:00Z",
});
function Host({
  state = snapshot(),
  providerRevision = 1,
  shown = true,
}: {
  state?: HertaChatSnapshot;
  providerRevision?: number;
  shown?: boolean;
}) {
  const context = useChatContext(
    state,
    { providerId: "p", modelId: "m", providerRevision },
    state.busy,
    shown,
    mock.receive,
    mock.saving,
  );
  return (
    <>
      <button type="button" onClick={context.open}>
        打开范围
      </button>
      <ChatContextPanel context={context} />
    </>
  );
}
const note = () => screen.getByRole("textbox", { name: "续聊要点" });
function open() {
  fireEvent.click(screen.getByRole("button", { name: "打开范围" }));
}
function excluded() {
  fireEvent.change(screen.getByRole("combobox", { name: "保留范围" }), {
    target: { value: "0" },
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  mock.bridge.draftChatContext.mockImplementation(async (input) =>
    result(input),
  );
  mock.bridge.cancelChatContextDraft.mockResolvedValue({ cancelled: true });
  mock.bridge.manageHertaChat.mockResolvedValue({
    ...snapshot("a", 4),
    contextNote: "模型起草的要点",
    contextStart: 4,
  });
});

it("keeps the saved boundary when changing only the note instead of silently resetting to six turns", async () => {
  const state = snapshot();
  state.messages = Array.from({ length: 20 }, (_, index) => ({
    ...state.messages[index % 4]!,
    id: `message-${index}`,
  }));
  state.contextStart = 14;
  render(<Host state={state} />);
  open();
  expect(screen.getByRole("combobox", { name: "保留范围" })).toHaveValue("-2");
  expect(
    screen.getByRole("option", { name: "当前已保存范围（6 条消息）" }),
  ).toBeInTheDocument();
  fireEvent.change(note(), { target: { value: "仅更正称呼" } });
  fireEvent.click(screen.getByRole("button", { name: "应用续聊范围" }));
  await waitFor(() =>
    expect(mock.bridge.manageHertaChat).toHaveBeenCalledWith({
      type: "context",
      id: "a",
      note: "仅更正称呼",
      keepTurns: -2,
      expectedRevision: 3,
    }),
  );
});

it("drafts the saved excluded range and retains its absolute boundary when new messages arrive", async () => {
  const state = { ...snapshot(), contextStart: 2 };
  mock.bridge.draftChatContext.mockImplementation(async (input) => ({
    ...result(input),
    boundaryIndex: 2,
  }));
  const host = render(<Host state={state} />);
  open();
  fireEvent.click(screen.getByRole("button", { name: "起草要点" }));
  await screen.findByText("要点已起草，请检查、修改后再应用续聊范围。");
  expect(mock.bridge.draftChatContext).toHaveBeenCalledWith(
    expect.objectContaining({ keepTurns: -2 }),
  );
  host.rerender(
    <Host
      state={{
        ...state,
        revision: 4,
        messages: [...state.messages, ...state.messages.slice(0, 2)],
      }}
    />,
  );
  expect(
    screen.getByRole("option", { name: "当前已保存范围（4 条消息）" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "保留范围" })).toHaveValue("-2");
  expect(screen.getByRole("button", { name: "应用续聊范围" })).toBeDisabled();
  fireEvent.click(
    screen.getByRole("button", { name: "保留草稿并采用当前记录" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "应用续聊范围" }));
  await waitFor(() =>
    expect(mock.bridge.manageHertaChat).toHaveBeenCalledWith(
      expect.objectContaining({ keepTurns: -2, expectedRevision: 4 }),
    ),
  );
});

it("drafts excluded messages into an editable note, preserving it on close and only saves explicitly", async () => {
  render(<Host />);
  open();
  excluded();
  fireEvent.click(screen.getByRole("button", { name: "起草要点" }));
  await screen.findByText("要点已起草，请检查、修改后再应用续聊范围。");
  expect(note()).toHaveValue("模型起草的要点");
  expect(mock.bridge.manageHertaChat).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText(/^续聊范围/));
  open();
  expect(note()).toHaveValue("模型起草的要点");
  fireEvent.click(screen.getByRole("button", { name: "应用续聊范围" }));
  await waitFor(() => expect(mock.receive).toHaveBeenCalledOnce());
  expect(mock.bridge.manageHertaChat).toHaveBeenCalledWith({
    type: "context",
    id: "a",
    keepTurns: 0,
    note: "模型起草的要点",
    expectedRevision: 3,
  });
});

it.each([
  "cancel",
  "edit",
  "range",
  "close",
  "switch",
  "configuration",
  "hidden",
  "revision",
] as const)("drops a late result after %s and keeps the original note", async (reason) => {
  let finish!: (reply: DraftChatContextReply) => void;
  mock.bridge.draftChatContext.mockImplementation(
    () =>
      new Promise<DraftChatContextReply>((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(<Host />);
  open();
  excluded();
  fireEvent.click(screen.getByRole("button", { name: "起草要点" }));
  const input = mock.bridge.draftChatContext.mock
    .calls[0]![0] as DraftChatContextInput;
  if (reason === "cancel")
    fireEvent.click(screen.getByRole("button", { name: "取消起草" }));
  if (reason === "edit") {
    fireEvent.change(note(), { target: { value: "新要点" } });
    fireEvent.change(note(), { target: { value: "原来的要点" } });
  }
  if (reason === "range")
    fireEvent.change(screen.getByRole("combobox", { name: "保留范围" }), {
      target: { value: "-1" },
    });
  if (reason === "close") fireEvent.click(screen.getByText(/^续聊范围/));
  if (reason === "switch") {
    view.rerender(<Host state={snapshot("b")} />);
    view.rerender(<Host />);
  }
  if (reason === "configuration") view.rerender(<Host providerRevision={2} />);
  if (reason === "hidden") view.rerender(<Host shown={false} />);
  if (reason === "revision") view.rerender(<Host state={snapshot("a", 4)} />);
  await act(async () => finish(result(input)));
  if (reason === "hidden") view.rerender(<Host />);
  open();
  expect(note()).toHaveValue("原来的要点");
  expect(mock.bridge.cancelChatContextDraft).toHaveBeenCalledWith({
    chatId: "a",
    requestId: input.requestId,
  });
  expect(mock.bridge.manageHertaChat).not.toHaveBeenCalled();
});

it("retains the note on provider failure and oversized output", async () => {
  mock.bridge.draftChatContext
    .mockResolvedValueOnce({
      ok: false,
      reason: "provider",
      message: "服务暂不可用。",
    })
    .mockImplementationOnce(async (input) => result(input, "x".repeat(4001)));
  render(<Host />);
  open();
  excluded();
  fireEvent.click(screen.getByRole("button", { name: "起草要点" }));
  await screen.findByText("服务暂不可用。");
  expect(note()).toHaveValue("原来的要点");
  fireEvent.click(screen.getByRole("button", { name: "起草要点" }));
  await screen.findByText("返回的要点与当前聊天不一致，原要点保持不变。");
  expect(note()).toHaveValue("原来的要点");
});

it("requires reviewing a changed source revision and preserves note after saving fails", async () => {
  mock.bridge.manageHertaChat.mockRejectedValueOnce(Error("conflict"));
  const view = render(<Host />);
  open();
  excluded();
  fireEvent.change(note(), { target: { value: "我的修改" } });
  view.rerender(<Host state={snapshot("a", 4)} />);
  expect(screen.getByRole("button", { name: "应用续聊范围" })).toBeDisabled();
  fireEvent.click(
    screen.getByRole("button", { name: "保留草稿并采用当前记录" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "应用续聊范围" }));
  await screen.findByText("续聊范围未保存，草稿仍保留。请复查当前记录后重试。");
  expect(note()).toHaveValue("我的修改");
  expect(mock.bridge.manageHertaChat).toHaveBeenCalledWith(
    expect.objectContaining({ expectedRevision: 4 }),
  );
});
