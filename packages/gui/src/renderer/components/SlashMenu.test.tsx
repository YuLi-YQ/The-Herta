import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useRef, useState } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import {
  type BackendCommand,
  type BackendOutcome,
  type ComposerState,
  commandAt,
  useBackendCommands,
} from "./ComposerActions.js";
import { PromptActionPicker } from "./Plugins/PromptActionPicker.js";
import { useSlashMenu } from "./SlashMenu.js";

const mocks = vi.hoisted(() => ({ bridge: { promptPlugins: vi.fn() }, run: vi.fn() }));
vi.mock("../context/HertaBridgeContext.js", () => ({ useHertaBridge: () => ({ bridge: mocks.bridge }) }));
function Harness({ target = "a" }: { target?: string }) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState("");
  const slash = useSlashMenu({ scope: "chat", target, textarea, draft, setDraft, disabled: false, onPromptAction: mocks.run });
  return <><textarea aria-label="draft" ref={textarea} value={draft} onChange={(e) => { setDraft(e.target.value); slash.onChange(e.target.value, e.target.selectionStart); }} onKeyDown={slash.onKeyDown} />{slash.menu}</>;
}
const reply = { ok: true, snapshot: { items: [{ enabled: true, manifest: { id: "test", name: "插件", actions: [{ id: "act", title: "旧动作", scope: "both" }] } }] } };
beforeEach(() => { mocks.run.mockReset(); mocks.bridge.promptPlugins.mockReset(); });

it("discards late plugin results after closing or changing the target", async () => {
  let resolve!: (value: typeof reply) => void;
  mocks.bridge.promptPlugins.mockImplementationOnce(() => new Promise((r) => { resolve = r; })).mockImplementation(() => new Promise(() => {}));
  const view = render(<Harness />);
  const input = screen.getByLabelText("draft");
  fireEvent.change(input, { target: { value: "/" } });
  fireEvent.keyDown(input, { key: "Escape" });
  view.rerender(<Harness target="b" />);
  await act(async () => resolve(reply));
  fireEvent.change(input, { target: { value: "/旧" } });
  expect(screen.queryByText("旧动作")).toBeNull();
});

it("does not reuse a previous plugin list while a refreshed list is pending", async () => {
  mocks.bridge.promptPlugins.mockResolvedValueOnce(reply).mockImplementation(() => new Promise(() => {}));
  render(<Harness />);
  const input = screen.getByLabelText("draft");
  fireEvent.change(input, { target: { value: "/旧" } });
  await screen.findByText("旧动作");
  fireEvent.keyDown(input, { key: "Escape" });
  fireEvent.change(input, { target: { value: "/旧动" } });
  expect(screen.queryByText("旧动作")).toBeNull();
});

it("does not run a stale menu after the caret moves into ordinary text", async () => {
  mocks.bridge.promptPlugins.mockResolvedValue(reply);
  render(<Harness />);
  const input = screen.getByLabelText("draft") as HTMLTextAreaElement;
  const text = "保留这行\n/旧";
  fireEvent.change(input, { target: { value: text } });
  await screen.findByText("旧动作");
  input.setSelectionRange(2, 2);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(mocks.run).not.toHaveBeenCalled();
  expect(input).toHaveValue(text);
});

it.each(["~~~\n/model", "````\n```\n/model", "   ~~~~txt\n/model"])("ignores slash inside fenced code: %s", (text) => {
  expect(commandAt(text, text.length)).toBeNull();
});
it.each(["~~~\ncode\n~~~\n/model", "```ts\ncode\n```\n/model", "inline ``` text\n/model"])("recognizes slash outside fenced code: %s", (text) => {
  expect(commandAt(text, text.length)).toBe("model");
});

/** A chat composer with the controls its actions open, disabled the way HertaChat disables them. */
function Composer({ state = {} }: { state?: ComposerState }) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState("");
  const slash = useSlashMenu({
    scope: "chat",
    target: "a",
    textarea,
    draft,
    setDraft,
    disabled: false,
    state,
    onPromptAction: mocks.run,
  });
  return (
    <div className="herta-chat-composer">
      {slash.menu}
      <textarea
        aria-label="draft"
        ref={textarea}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          slash.onChange(e.target.value, e.target.selectionStart);
        }}
        onKeyDown={slash.onKeyDown}
      />
      <input
        type="file"
        aria-label="附加文件"
        disabled={state.replying || state.reading}
      />
      <button
        type="button"
        className="herta-chat-model"
        aria-label="聊天模型"
        disabled={state.replying}
      >
        m
      </button>
    </div>
  );
}
const option = (title: string) =>
  screen
    .getAllByRole("option")
    .find((o) => o.querySelector(".herta-slash-title")?.textContent === title)!;

it("says why a command cannot run, and Enter on it keeps the typed /word (R123)", () => {
  mocks.bridge.promptPlugins.mockResolvedValue({
    ok: true,
    snapshot: { revision: 1, items: [] },
  });
  const clicked = vi
    .spyOn(HTMLInputElement.prototype, "click")
    .mockImplementation(() => {});
  try {
    render(<Composer state={{ reading: true }} />);
    const input = screen.getByLabelText("draft");
    fireEvent.change(input, { target: { value: "/" } });
    expect(option("附加文件")).toHaveTextContent("正在读取文件，读完后再添加");
    expect(option("附加文件")).toHaveAttribute("aria-disabled", "true");
    expect(option("选择模型")).toHaveTextContent("本聊天使用的模型");
    fireEvent.change(input, { target: { value: "/att" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "无法执行“附加文件”：正在读取文件，读完后再添加",
    );
    expect(clicked).not.toHaveBeenCalled();
    expect(input).toHaveValue("/att");
    // Typing on clears the notice; Esc still closes and keeps the draft.
    fireEvent.change(input, { target: { value: "/at" } });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "指令" })).toBeNull();
    expect(input).toHaveValue("/at");
  } finally {
    clicked.mockRestore();
  }
});

it("checks again before running: a control disabled after the menu listed it keeps the draft and says so (R123)", () => {
  mocks.bridge.promptPlugins.mockResolvedValue({
    ok: true,
    snapshot: { revision: 1, items: [] },
  });
  render(<Composer />);
  const input = screen.getByLabelText("draft");
  fireEvent.change(input, { target: { value: "保留\n/mod" } });
  expect(option("选择模型")).not.toHaveAttribute("aria-disabled");
  // A turn starts between listing and Enter: the host disables the trigger before the menu re-renders.
  (screen.getByLabelText("聊天模型") as HTMLButtonElement).disabled = true;
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.getByRole("alert")).toHaveTextContent(
    "无法执行“选择模型”：当前不可用",
  );
  expect(input).toHaveValue("保留\n/mod");
  expect(document.activeElement).not.toBe(screen.getByLabelText("聊天模型"));
});

it("says why a prompt action waits, and does not open it during a reply (R123)", async () => {
  mocks.bridge.promptPlugins.mockResolvedValue(reply);
  render(<Composer state={{ replying: true }} />);
  const input = screen.getByLabelText("draft");
  fireEvent.change(input, { target: { value: "/旧" } });
  await screen.findByText("旧动作");
  expect(option("旧动作")).toHaveTextContent("黑塔正在回复，结束后可用");
  fireEvent.click(option("旧动作"));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "无法执行“旧动作”：黑塔正在回复，结束后可用",
  );
  expect(mocks.run).not.toHaveBeenCalled();
  expect(input).toHaveValue("/旧");
});

it.each([
  [
    "a damaged plugin record",
    () =>
      Promise.resolve({
        ok: true,
        snapshot: { revision: 1, items: [], damaged: true },
      }),
    "插件记录需要在设置中恢复。",
  ],
  [
    "a refused list",
    () => Promise.resolve({ ok: false, message: "插件存储不可用。" }),
    "插件存储不可用。",
  ],
  [
    "a failed request",
    () => Promise.reject(new Error("ipc")),
    "无法读取快捷操作，请重新打开。",
  ],
])("says when the prompt actions cannot be listed, as the 快捷操作 menu does: %s (R123)", async (_name, list, text) => {
  mocks.bridge.promptPlugins.mockImplementation(list);
  render(<Composer />);
  fireEvent.change(screen.getByLabelText("draft"), { target: { value: "/" } });
  expect(await screen.findByText(text)).toBeInTheDocument();
  // The composer's own actions stay usable.
  expect(option("附加文件")).not.toHaveAttribute("aria-disabled");
});

/** A host with a command of its own, listed by both menus, its result shown beside the composer (R124). */
function Host({
  target = "a",
  run,
}: {
  target?: string;
  run: BackendCommand["run"];
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState("");
  const backend = useBackendCommands(target, [
    {
      id: "export",
      title: "导出",
      aliases: ["export"],
      hint: "存为文件",
      group: "会话操作",
      blockedBy: ["noTarget"],
      run,
    },
  ]);
  const slash = useSlashMenu({
    scope: "chat",
    target,
    textarea,
    draft,
    setDraft,
    disabled: false,
    backend,
    onPromptAction: mocks.run,
  });
  return (
    <div className="herta-chat-composer">
      {slash.menu}
      {backend.notice && (
        <p className="result" role={backend.notice.error ? "alert" : "status"}>
          {backend.notice.text}
        </p>
      )}
      <textarea
        aria-label="draft"
        ref={textarea}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          slash.onChange(e.target.value, e.target.selectionStart);
        }}
        onKeyDown={slash.onKeyDown}
      />
      <PromptActionPicker
        scope="chat"
        target={target}
        draft={draft}
        backend={backend}
        onInsert={setDraft}
      />
    </div>
  );
}
const NO_PROMPTS = { ok: true, snapshot: { revision: 1, items: [] } };
const result = () => document.querySelector(".result");

it("runs a command of the host's from either menu, one run at a time, and says so while it runs (R124)", async () => {
  mocks.bridge.promptPlugins.mockResolvedValue(NO_PROMPTS);
  let finish!: (outcome: BackendOutcome) => void;
  const run = vi.fn(
    () =>
      new Promise<BackendOutcome>((resolve) => {
        finish = resolve;
      }),
  );
  render(<Host run={run} />);
  const input = screen.getByLabelText("draft");
  fireEvent.change(input, { target: { value: "保留\n/exp" } });
  expect(option("导出")).toHaveTextContent("存为文件");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(run).toHaveBeenCalledTimes(1);
  // Started: only the typed /word goes, and the menu closes.
  expect(input).toHaveValue("保留\n");
  expect(screen.queryByRole("listbox", { name: "指令" })).toBeNull();
  fireEvent.change(input, { target: { value: "保留\n/exp" } });
  expect(option("导出")).toHaveTextContent("正在执行…");
  expect(option("导出")).toHaveAttribute("aria-disabled", "true");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(
    within(screen.getByRole("listbox", { name: "指令" })).getByRole("alert"),
  ).toHaveTextContent("无法执行“导出”：正在执行…");
  expect(input).toHaveValue("保留\n/exp");
  fireEvent.keyDown(input, { key: "Escape" });
  // The 快捷操作 menu lists it with the actions, running as well.
  fireEvent.click(screen.getByRole("button", { name: "快捷操作" }));
  const common = await screen.findByRole("group", { name: "常用" });
  const button = within(common).getByRole("button", { name: /导出/ });
  expect(button).toBeDisabled();
  expect(button).toHaveTextContent("正在执行…");
  expect(run).toHaveBeenCalledTimes(1);
  await act(async () => finish({ ok: true, notice: "已导出" }));
  expect(result()).toHaveTextContent("已导出");
  expect(result()).toHaveAttribute("role", "status");
  expect(button).toBeEnabled();
  fireEvent.click(button);
  expect(run).toHaveBeenCalledTimes(2);
  // Started from 快捷操作: the menu closes and the focus goes back to its button.
  expect(screen.queryByRole("region", { name: "快捷操作" })).toBeNull();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "快捷操作" }),
  );
});

it("drops a result that comes back after a switch to another chat, and tells the run to stop (R124)", async () => {
  mocks.bridge.promptPlugins.mockResolvedValue(NO_PROMPTS);
  let finish!: (outcome: BackendOutcome) => void;
  let signal: AbortSignal | undefined;
  const run = vi.fn((s: AbortSignal) => {
    signal = s;
    return new Promise<BackendOutcome>((resolve) => {
      finish = resolve;
    });
  });
  const view = render(<Host run={run} />);
  const input = screen.getByLabelText("draft");
  fireEvent.change(input, { target: { value: "/exp" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(signal?.aborted).toBe(false);
  view.rerender(<Host run={run} target="b" />);
  expect(signal?.aborted).toBe(true);
  // It runs until it ends: the other chat waits for it as well.
  fireEvent.change(input, { target: { value: "/exp" } });
  expect(option("导出")).toHaveTextContent("正在执行…");
  fireEvent.keyDown(input, { key: "Escape" });
  await act(async () => finish({ ok: false, reason: "写入失败" }));
  expect(result()).toBeNull();
  fireEvent.change(input, { target: { value: "/expo" } });
  expect(option("导出")).not.toHaveAttribute("aria-disabled");
});

it("a failure says why until the next run, a cancel says nothing, a done notice fades like the sidebar's (R124)", async () => {
  mocks.bridge.promptPlugins.mockResolvedValue(NO_PROMPTS);
  const outcomes: BackendOutcome[] = [
    { ok: false, reason: "写入失败" },
    { ok: true },
    { ok: true, notice: "已导出" },
  ];
  const run = vi.fn(
    async (): Promise<BackendOutcome> => outcomes.shift() ?? { ok: true },
  );
  vi.useFakeTimers();
  try {
    render(<Host run={run} />);
    const input = screen.getByLabelText("draft");
    const start = async () => {
      fireEvent.change(input, { target: { value: "/exp" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await act(() => vi.advanceTimersByTimeAsync(0));
    };
    await start();
    expect(result()).toHaveTextContent("无法执行“导出”：写入失败");
    expect(result()).toHaveAttribute("role", "alert");
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(result()).toHaveTextContent("无法执行“导出”：写入失败");
    await start();
    expect(result()).toBeNull();
    await start();
    expect(result()).toHaveTextContent("已导出");
    await act(() => vi.advanceTimersByTimeAsync(2400));
    expect(result()).toBeNull();
    expect(run).toHaveBeenCalledTimes(3);
  } finally {
    vi.useRealTimers();
  }
});
