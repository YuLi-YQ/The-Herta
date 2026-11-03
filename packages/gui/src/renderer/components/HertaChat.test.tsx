import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { gsap } from "gsap";
import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({
  bridge: {
    parseChatFile: vi.fn(),
    cancelChatFile: vi.fn(),
    getHertaChat: vi.fn(),
    sendHertaChat: vi.fn(),
    stopHertaChat: vi.fn(),
    manageHertaChat: vi.fn(),
    getProviderSettings: vi.fn(),
  },
}));
vi.mock("../context/HertaBridgeContext.js", () => ({
  useHertaBridge: () => ({ bridge: mock.bridge }),
}));
vi.mock("./MessageContent.js", () => ({
  MessageContent: ({ text }: { text: string }) => <div>{text}</div>,
}));
import { HertaChat } from "./HertaChat.js";
import { memoryIdb } from "../test-utils/memory-idb.js";
beforeEach(() => {
  vi.clearAllMocks();
  mock.bridge.cancelChatFile.mockResolvedValue(true);
  localStorage.clear();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  mock.bridge.getHertaChat.mockResolvedValue({
    revision: 0,
    activeId: "a",
    chats: [
      {
        id: "a",
        title: "新聊天",
        updatedAt: "now",
        pinned: false,
        archived: false,
        messageCount: 0,
      },
    ],
    contextStart: 0,
    contextNote: "",
    contextCharacters: 0,
    messages: [],
    busy: false,
    error: null,
  });
  mock.bridge.getProviderSettings.mockResolvedValue({
    settings: {
      providers: [
        {
          id: "p",
          name: "Text provider",
          protocol: "openai-chat-completions",
          revision: 1,
          models: [
            {
              id: "m",
              validation: {
                state: "text-available",
                providerRevision: 1,
                protocol: "openai-chat-completions",
              },
            },
            {
              id: "stale",
              validation: {
                state: "tools-available",
                providerRevision: 0,
                protocol: "openai-chat-completions",
              },
            },
          ],
        },
      ],
    },
  });
  mock.bridge.sendHertaChat.mockResolvedValue({ accepted: true });
});
async function chatModelReady(label: string) {
  const trigger = await screen.findByRole("button", { name: "聊天模型与回复设置" });
  await waitFor(() => expect(trigger).toHaveAttribute("title", label));
  return trigger;
}
async function openChatModel() {
  const trigger = screen.getByRole("button", { name: "聊天模型与回复设置" });
  if (trigger.getAttribute("aria-expanded") !== "true") fireEvent.click(trigger);
  return screen.findByRole("dialog", { name: "聊天模型与回复设置" });
}
it("offers text-only validated models, sends selected input and clears accepted draft", async () => {
  render(<HertaChat onSettings={vi.fn()} />);
  await chatModelReady("m · Text provider");
  await openChatModel();
  expect(screen.getByRole("button", { name: "m · Text provider" })).toHaveAttribute("aria-pressed", "true");
  expect(
    screen.queryByRole("button", { name: /stale/ }),
  ).not.toBeInTheDocument();
  fireEvent.keyDown(document, { key: "Escape" });
  fireEvent.change(screen.getByRole("textbox", { name: "给黑塔的消息" }), {
    target: { value: "今天聊什么" },
  });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "给黑塔的消息" })).toHaveValue(
      "",
    ),
  );
  expect(mock.bridge.sendHertaChat).toHaveBeenCalledWith({
    chatId: "a",
    text: "今天聊什么",
    providerId: "p",
    modelId: "m",
    maxOutputTokens: 16384,
  });
});
it("changes the model inside the chat popover without updating workbench bindings (R133)", async () => {
  const settings = await mock.bridge.getProviderSettings();
  settings.settings.providers[0].models.push({
    id: "other-model",
    validation: { state: "text-available", providerRevision: 1, protocol: "openai-chat-completions" },
  });
  mock.bridge.getProviderSettings.mockResolvedValue(settings);
  const setBindings = vi.fn();
  Object.assign(mock.bridge, { setProviderBindings: setBindings });
  try {
    render(<HertaChat onSettings={vi.fn()} />);
    await chatModelReady("m · Text provider");
    await openChatModel();
    fireEvent.click(screen.getByRole("button", { name: "other-model · Text provider" }));
    await chatModelReady("other-model · Text provider");
    expect(localStorage.getItem("the-herta.chat-model.v2.a")).toBe(JSON.stringify(["p", "other-model"]));
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.change(screen.getByRole("textbox", { name: "给黑塔的消息" }), { target: { value: "按这个模型继续" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(mock.bridge.sendHertaChat).toHaveBeenCalledWith(expect.objectContaining({ chatId: "a", providerId: "p", modelId: "other-model" })));
    expect(setBindings).not.toHaveBeenCalled();
  } finally {
    Reflect.deleteProperty(mock.bridge, "setProviderBindings");
  }
});
it("keeps draft on rejection and does not send an IME confirmation", async () => {
  mock.bridge.sendHertaChat.mockRejectedValue(new Error("preflight"));
  render(<HertaChat onSettings={vi.fn()} />);
  await chatModelReady("m · Text provider");
  const textbox = screen.getByRole("textbox", { name: "给黑塔的消息" });
  fireEvent.change(textbox, { target: { value: "中文草稿" } });
  fireEvent.keyDown(textbox, {
    key: "Enter",
    ctrlKey: true,
    isComposing: true,
    keyCode: 229,
  });
  expect(mock.bridge.sendHertaChat).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await screen.findByRole("alert");
  expect(textbox).toHaveValue("中文草稿");
});
it("stops chat independently and opens settings without invoking any tools", async () => {
  mock.bridge.getHertaChat.mockResolvedValue({
    revision: 0,
    activeId: "a",
    chats: [
      {
        id: "a",
        title: "新聊天",
        updatedAt: "now",
        pinned: false,
        archived: false,
        messageCount: 0,
      },
    ],
    contextStart: 0,
    contextNote: "",
    contextCharacters: 0,
    messages: [],
    busy: true,
    error: null,
  });
  mock.bridge.stopHertaChat.mockResolvedValue(undefined);
  const settings = vi.fn();
  render(<HertaChat onSettings={settings} />);
  fireEvent.click(await screen.findByRole("button", { name: "停止" }));
  expect(mock.bridge.stopHertaChat).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "连接与模型" }));
  expect(settings).toHaveBeenCalledTimes(1);
});

const snap = (id: string, revision: number) => ({
  revision,
  activeId: id,
  chats: [
    {
      id: "a",
      title: "话题A",
      updatedAt: "now",
      pinned: false,
      archived: false,
      messageCount: 0,
    },
    {
      id: "b",
      title: "话题B",
      updatedAt: "now",
      pinned: false,
      archived: false,
      messageCount: 0,
    },
  ],
  contextStart: 0,
  contextNote: "",
  contextCharacters: 0,
  messages: [],
  busy: false,
  error: null,
});
it("keeps drafts isolated when creating and switching chats, rejecting stale poll snapshots", async () => {
  mock.bridge.getHertaChat.mockResolvedValue(snap("a", 0));
  mock.bridge.manageHertaChat
    .mockResolvedValueOnce(snap("b", 1))
    .mockResolvedValueOnce(snap("a", 2));
  render(<HertaChat onSettings={vi.fn()} />);
  await screen.findByRole("button", { name: "话题A" });
  const box = screen.getByRole("textbox", { name: "给黑塔的消息" });
  fireEvent.change(box, { target: { value: "A草稿" } });
  fireEvent.click(screen.getByRole("button", { name: "新建聊天" }));
  await waitFor(() => expect(box).toHaveValue(""));
  fireEvent.change(box, { target: { value: "B草稿" } });
  await new Promise((r) => setTimeout(r, 450));
  expect(box).toHaveValue("B草稿");
  fireEvent.click(screen.getByRole("button", { name: "话题A" }));
  await waitFor(() => expect(box).toHaveValue("A草稿"));
  expect(localStorage.getItem("the-herta.chat-draft.v2.b")).toBe("B草稿");
  expect(localStorage.getItem("the-herta.chat-draft.v2.a")).toBe("A草稿");
});
it("migrates the old global draft only once without overwriting a thread draft", async () => {
  localStorage.setItem("the-herta.chat-draft.v1", "旧草稿");
  localStorage.setItem("the-herta.chat-draft.v2.a", "已有草稿");
  render(<HertaChat onSettings={vi.fn()} />);
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "给黑塔的消息" })).toHaveValue(
      "已有草稿",
    ),
  );
  expect(localStorage.getItem("the-herta.chat-draft.v1")).toBeNull();
});
it("exposes renaming and reversible archive/restore without dropping the draft", async () => {
  let current = snap("a", 0);
  mock.bridge.getHertaChat.mockImplementation(async () => current);
  mock.bridge.manageHertaChat.mockImplementation(async (action) => {
    current = {
      ...current,
      revision: current.revision + 1,
      chats: current.chats.map((c) =>
        c.id === action.id
          ? {
              ...c,
              title: action.type === "rename" ? action.title : c.title,
              archived:
                action.type === "archive"
                  ? true
                  : action.type === "restore"
                    ? false
                    : c.archived,
            }
          : c,
      ),
      activeId:
        action.type === "archive"
          ? "b"
          : action.type === "restore"
            ? "a"
            : current.activeId,
    };
    return current;
  });
  render(<HertaChat onSettings={vi.fn()} />);
  await screen.findByRole("button", { name: "话题A" });
  fireEvent.click(screen.getByRole("button", { name: "聊天操作 话题A" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
  fireEvent.change(screen.getByRole("textbox", { name: "聊天名称" }), {
    target: { value: "新的标题" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await screen.findByRole("button", { name: "新的标题" });
  fireEvent.click(screen.getByRole("button", { name: "聊天操作 新的标题" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "移到回收区" }));
  const recycle = await screen.findByText("回收区 · 1");
  fireEvent.click(recycle);
  fireEvent.click(
    await screen.findByRole("button", { name: "恢复聊天 新的标题" }),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "新的标题" })).toHaveAttribute(
      "aria-current",
      "true",
    ),
  );
});
it("context changes require explicit application and do not send a message", async () => {
  mock.bridge.manageHertaChat.mockResolvedValue({
    ...snap("a", 1),
    contextNote: "记住称呼",
  });
  render(<HertaChat onSettings={vi.fn()} />);
  const toggle = await screen.findByText("续聊范围");
  fireEvent.click(toggle);
  fireEvent.change(screen.getByRole("combobox", { name: "保留范围" }), {
    target: { value: "0" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "续聊要点" }), {
    target: { value: "记住称呼" },
  });
  expect(mock.bridge.manageHertaChat).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "应用续聊范围" }));
  await waitFor(() =>
    expect(mock.bridge.manageHertaChat).toHaveBeenCalledWith({
      type: "context",
      id: "a",
      keepTurns: 0,
      note: "记住称呼",
      expectedRevision: 0,
    }),
  );
  expect(mock.bridge.sendHertaChat).not.toHaveBeenCalled();
});

it("opens /compact in the existing chat range control without consuming the ordinary draft or saving (R131)", async () => {
  Object.assign(mock.bridge, { draftChatContext: vi.fn(), cancelChatContextDraft: vi.fn() });
  try {
    render(<HertaChat onSettings={vi.fn()} />);
    await chatModelReady("m · Text provider");
    const field = screen.getByRole("textbox", { name: "给黑塔的消息" });
    fireEvent.change(field, { target: { value: "保留这段正文\n/compact" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(await screen.findByRole("combobox", { name: "保留范围" })).toBeVisible();
    expect(field).toHaveValue("保留这段正文\n");
    expect(screen.getByRole("button", { name: "起草要点" })).toBeDisabled();
    expect(mock.bridge.sendHertaChat).not.toHaveBeenCalled();
    expect(mock.bridge.manageHertaChat).not.toHaveBeenCalledWith(expect.objectContaining({ type: "context" }));
  } finally {
    Reflect.deleteProperty(mock.bridge, "draftChatContext");
    Reflect.deleteProperty(mock.bridge, "cancelChatContextDraft");
  }
});

it("preserves draft and budget across peer tab switches and refreshes models after settings", async () => {
  const props = { onSettings: vi.fn() };
  const view = render(<HertaChat {...props} visible />);
  await chatModelReady("m · Text provider");
  fireEvent.change(screen.getByRole("textbox", { name: "给黑塔的消息" }), {
    target: { value: "留在这里" },
  });
  await openChatModel();
  fireEvent.change(screen.getByRole("combobox", { name: "回复额度" }), {
    target: { value: "32768" },
  });
  view.rerender(<HertaChat {...props} visible={false} />);
  expect(
    screen.queryByRole("textbox", { name: "给黑塔的消息" }),
  ).not.toBeInTheDocument();
  expect(mock.bridge.stopHertaChat).not.toHaveBeenCalled();
  view.rerender(<HertaChat {...props} visible />);
  expect(screen.getByRole("textbox", { name: "给黑塔的消息" })).toHaveValue(
    "留在这里",
  );
  expect(screen.queryByRole("dialog", { name: "聊天模型与回复设置" })).not.toBeInTheDocument();
  await openChatModel();
  expect(screen.getByRole("combobox", { name: "回复额度" })).toHaveValue(
    "32768",
  );
  view.rerender(<HertaChat {...props} visible settingsOpen />);
  const count = mock.bridge.getProviderSettings.mock.calls.length;
  view.rerender(<HertaChat {...props} visible settingsOpen={false} />);
  await waitFor(() =>
    expect(mock.bridge.getProviderSettings.mock.calls.length).toBeGreaterThan(
      count,
    ),
  );
});

it("shows bounded public thinking and a persistent specific failure without an empty answer action", async () => {
  mock.bridge.getHertaChat.mockResolvedValue({
    ...snap("a", 4),
    busy: false,
    error: null,
    messages: [
      {
        id: "reply",
        role: "assistant",
        text: "",
        at: "now",
        status: "failed",
        failure: "length",
        reasoning: "服务返回的思考片段",
        reasoningTruncated: true,
      },
    ],
  });
  render(<HertaChat onSettings={vi.fn()} />);
  expect(await screen.findByText(/回复额度已用尽/)).toBeInTheDocument();
  expect(screen.getByText("查看思考")).toBeInTheDocument();
  expect(screen.getByText("服务返回的思考片段")).toBeInTheDocument();
  expect(screen.getByText(/仅展示前 32000 字符/)).toBeInTheDocument();
  expect(screen.queryByText("复制原文")).not.toBeInTheDocument();
});
it("offers only model-supported effort and preserves the explicit choice for later sends", async () => {
  const settings = await mock.bridge.getProviderSettings();
  settings.settings.providers[0].models[0].id = "deepseek-flash";
  mock.bridge.getProviderSettings.mockResolvedValue(settings);
  const props = { onSettings: vi.fn() };
  const view = render(<HertaChat {...props} />);
  await chatModelReady("deepseek-flash · Text provider");
  await openChatModel();
  const select = screen.getByRole("combobox", { name: "聊天思考强度" });
  fireEvent.change(select, { target: { value: "none" } });
  view.rerender(<HertaChat {...props} visible={false} />);
  view.rerender(<HertaChat {...props} visible />);
  await openChatModel();
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "聊天思考强度" })).toHaveValue(
      "none",
    ),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "给黑塔的消息" }), {
    target: { value: "你好" },
  });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() =>
    expect(mock.bridge.sendHertaChat).toHaveBeenCalledWith(
      expect.objectContaining({
        reasoningEffort: "none",
        maxOutputTokens: 16384,
      }),
    ),
  );
});

it("previews imported document text and sends only the normalized attachment", async () => {
 mock.bridge.parseChatFile.mockResolvedValue({ok:true,attachment:{name:"report.pdf",text:"Extracted text",format:"pdf",pages:2}});
 render(<HertaChat onSettings={vi.fn()} />);
 await chatModelReady("m · Text provider");
 fireEvent.change(screen.getByLabelText("附加文件"),{target:{files:[{name:"report.pdf",size:10,arrayBuffer:async()=>new ArrayBuffer(10)}]}});
 fireEvent.click(await screen.findByRole("button",{name:"查看 report.pdf"}));
 expect(await screen.findByText("Extracted text")).toBeInTheDocument();
 expect(screen.getByText("PDF · 2 页")).toBeInTheDocument();
 fireEvent.change(screen.getByRole("textbox",{name:"给黑塔的消息"}),{target:{value:"总结附件"}});
 fireEvent.click(screen.getByRole("button",{name:"发送"}));
 await waitFor(()=>expect(mock.bridge.sendHertaChat).toHaveBeenCalledWith(expect.objectContaining({attachments:[{name:"report.pdf",text:"Extracted text",format:"pdf",pages:2}]})));
});
it("blocks sending while parsing and keeps draft when a document is rejected",async()=>{
 let finish!: (value:unknown)=>void;
 mock.bridge.parseChatFile.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 render(<HertaChat onSettings={vi.fn()} />);
 await chatModelReady("m · Text provider");
 fireEvent.change(screen.getByRole("textbox",{name:"给黑塔的消息"}),{target:{value:"保留草稿"}});
 fireEvent.change(screen.getByLabelText("附加文件"),{target:{files:[{name:"scan.pdf",size:10,arrayBuffer:async()=>new ArrayBuffer(10)}]}});
 await waitFor(()=>expect(mock.bridge.parseChatFile).toHaveBeenCalled());
 expect(screen.getByRole("button",{name:"发送"})).toBeDisabled();
 finish({ok:false,message:"文档没有可读取的文字。"});
 expect(await screen.findByRole("alert")).toHaveTextContent("未添加：文档没有可读取的文字。");
 expect(screen.getByRole("group",{name:"待发送的附件"})).toHaveTextContent("scan.pdf");
 expect(screen.getByRole("textbox",{name:"给黑塔的消息"})).toHaveValue("保留草稿");
 fireEvent.click(screen.getByRole("button",{name:"发送"}));
 expect(await screen.findByText("还有附件没有添加成功：请重试或移除它，再发送。")).toBeInTheDocument();
 expect(mock.bridge.sendHertaChat).not.toHaveBeenCalled();
});

it("previews image attachments and explains incompatible models",async()=>{
 const image={mimeType:"image/png",data:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="};
 mock.bridge.parseChatFile.mockResolvedValue({ok:true,attachment:{name:"x.png",text:"",image}});
 render(<HertaChat onSettings={vi.fn()} />);
 await chatModelReady("m · Text provider");
 fireEvent.change(screen.getByLabelText("附加文件"),{target:{files:[{name:"x.png",size:68,arrayBuffer:async()=>new ArrayBuffer(68)}]}});
 expect((await screen.findByRole("button",{name:"查看图片 x.png"})).querySelector("img")).toHaveAttribute("src",`data:image/png;base64,${image.data}`);
 expect(screen.getByText(/当前模型未通过识图检测/)).toBeInTheDocument();
});
it("keeps chat controls available while a storage-only refresh is pending",async()=>{
 mock.bridge.manageHertaChat.mockImplementation(action=>action.type==="storage"?new Promise(()=>{}):mock.bridge.getHertaChat());
 const view=render(<HertaChat onSettings={vi.fn()}/>);
 await chatModelReady("m · Text provider");
 fireEvent.click(screen.getByRole("button",{name:"存储空间"}));
 await waitFor(()=>expect(mock.bridge.manageHertaChat).toHaveBeenCalledWith({type:"storage"}));
 expect(screen.getByRole("button",{name:"新建聊天"})).not.toBeDisabled();
 expect(screen.getByRole("textbox",{name:"给黑塔的消息"})).not.toBeDisabled();
 view.unmount();
});

it("keeps an existing chat error when storage refresh fails, then allows retry", async () => {
 mock.bridge.manageHertaChat.mockImplementation(action => action.type === "storage" ? Promise.reject(new Error("private storage path")) : mock.bridge.getHertaChat());
 render(<HertaChat onSettings={vi.fn()}/>);
 await chatModelReady("m · Text provider");
 const five=["a","b","c","d","e"].map(n=>({name:`${n}.pdf`,size:10,arrayBuffer:async()=>new ArrayBuffer(10)}));
 fireEvent.change(screen.getByLabelText("附加文件"),{target:{files:five}});
 await screen.findByText("每条消息最多附加4个文件。");
 fireEvent.click(screen.getByRole("button",{name:"存储空间"}));
 await screen.findByText("暂时无法读取用量，请稍后刷新。");
 expect(screen.getByText("每条消息最多附加4个文件。")).toBeInTheDocument();
 expect(screen.queryByText(/private storage path/)).not.toBeInTheDocument();
 mock.bridge.manageHertaChat.mockImplementation(()=>mock.bridge.getHertaChat());
 fireEvent.click(screen.getByRole("button",{name:"刷新用量"}));
 await waitFor(()=>expect(screen.queryByText("暂时无法读取用量，请稍后刷新。")).not.toBeInTheDocument());
 expect(screen.getByText("每条消息最多附加4个文件。")).toBeInTheDocument();
});
it("does not issue another refresh when reopening storage while pending", async () => {
 let finish!: (value: unknown) => void;
 mock.bridge.manageHertaChat.mockImplementation(action => action.type === "storage" ? new Promise(resolve=>{finish=resolve;}) : mock.bridge.getHertaChat());
 render(<HertaChat onSettings={vi.fn()}/>);
 await chatModelReady("m · Text provider");
 fireEvent.click(screen.getByRole("button",{name:"存储空间"}));
 document.querySelector('dialog[aria-label="聊天存储空间"]')!.removeAttribute("open");
 fireEvent.click(screen.getByRole("button",{name:"存储空间"}));
 expect(mock.bridge.manageHertaChat.mock.calls.filter(([action])=>action.type==="storage")).toHaveLength(1);
 finish(await mock.bridge.getHertaChat());
 await waitFor(()=>expect(screen.getByRole("button",{name:"刷新用量"})).not.toBeDisabled());
});

it("isolates pending attachment imports across chats and ignores late completion", async () => {
 mock.bridge.getHertaChat.mockResolvedValue(snap("a",0));
 mock.bridge.manageHertaChat.mockResolvedValue(snap("b",1));
 const finishes: ((value:unknown)=>void)[]=[];
 mock.bridge.parseChatFile.mockImplementation(()=>new Promise(resolve=>finishes.push(resolve)));
 render(<HertaChat onSettings={vi.fn()}/>);
 await chatModelReady("m · Text provider");
 const file=(name:string)=>({name,size:10,arrayBuffer:async()=>new ArrayBuffer(10)});
 fireEvent.change(screen.getByLabelText("附加文件"),{target:{files:[file("old.pdf"),file("unused.pdf")]}});
 await waitFor(()=>expect(finishes).toHaveLength(1));
 fireEvent.click(screen.getByRole("button",{name:"话题B"}));
 await waitFor(()=>expect(screen.getByLabelText("附加文件")).not.toBeDisabled());
 fireEvent.change(screen.getByRole("textbox",{name:"给黑塔的消息"}),{target:{value:"新话题"}});
 expect(screen.getByRole("button",{name:"发送"})).not.toBeDisabled();
 fireEvent.change(screen.getByLabelText("附加文件"),{target:{files:[file("new.pdf")]}});
 await waitFor(()=>expect(finishes).toHaveLength(2));
 await act(async()=>finishes[0]!({ok:true,attachment:{name:"old.pdf",text:"旧聊天附件",format:"pdf"}}));
 expect(screen.getByLabelText("附加文件")).toBeDisabled();
 expect(screen.getByRole("button",{name:"发送"})).toBeDisabled();
 expect(screen.queryByRole("button",{name:"查看 old.pdf"})).not.toBeInTheDocument();
 expect(mock.bridge.parseChatFile).toHaveBeenCalledTimes(2);
 await act(async()=>finishes[1]!({ok:true,attachment:{name:"new.pdf",text:"新聊天附件",format:"pdf"}}));
 fireEvent.click(await screen.findByRole("button",{name:"查看 new.pdf"}));
 expect(await screen.findByText("新聊天附件")).toBeInTheDocument();
 expect(screen.getByRole("button",{name:"发送"})).not.toBeDisabled();
});

it.each([
 "续聊图片较多（每次最多8张、共12 MiB），可在图片下选择“不再发给模型”，或减少续聊范围、新建聊天；原图仍保留。",
 "续聊中有缺失或损坏的图片，请恢复图片目录、调整续聊范围，或在该图片下选择“不再发给模型”。",
 "当前模型未通过识图检测，图片不会发出。可在“连接与模型”中点“测试识图”，或换用已通过的模型；也可移除附件、调整续聊范围，或在已发送的图片下选择“不再发给模型”。",
 "当前连接或模型尚不支持联网搜索。",
 "请重新上传图片文件。",
])("shows a safe actionable send rejection and preserves draft: %s", async message => {
 mock.bridge.sendHertaChat.mockRejectedValue(new Error("IPC: " + message + " private-diagnostic"));
 render(<HertaChat onSettings={vi.fn()}/>);
 await chatModelReady("m · Text provider");
 const box=screen.getByRole("textbox",{name:"给黑塔的消息"});
 fireEvent.change(box,{target:{value:"保留这段问题"}});
 fireEvent.click(screen.getByRole("button",{name:"发送"}));
 expect(await screen.findByRole("alert")).toHaveTextContent(message);
 expect(screen.queryByText(/private-diagnostic/)).not.toBeInTheDocument();
 expect(box).toHaveValue("保留这段问题");
 expect(mock.bridge.sendHertaChat).toHaveBeenCalledTimes(1);
});
it("offers 回到最新 once the reader scrolls up, and jumps back to the newest line (R44)", async () => {
  render(<HertaChat onSettings={vi.fn()} />);
  await chatModelReady("m · Text provider");
  const list = document.querySelector<HTMLElement>(".herta-chat-messages")!;
  let top = 600;
  Object.defineProperties(list, {
    scrollHeight: { configurable: true, get: () => 1000 },
    clientHeight: { configurable: true, get: () => 400 },
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        top = Math.max(0, Math.min(value, 600));
      },
    },
  });
  expect(screen.queryByRole("button", { name: "回到最新" })).toBeNull();
  act(() => {
    list.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
    top = 560;
    list.dispatchEvent(new Event("scroll"));
  });
  // A small step up stays put: the 400 ms poll no longer pulls it back down.
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(top).toBe(560);
  fireEvent.click(await screen.findByRole("button", { name: "回到最新" }));
  expect(top).toBe(600);
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "回到最新" })).toBeNull(),
  );
});
// R103: the stylesheet lets the browser anchor the transcript only while the
// reader is away from the newest line (see styles/chat-scroll-anchor.test.ts).
it("marks the transcript away while the reader has left the newest line (R103)", async () => {
  render(<HertaChat onSettings={vi.fn()} />);
  await chatModelReady("m · Text provider");
  const list = document.querySelector<HTMLElement>(".herta-chat-messages")!;
  let top = 600;
  Object.defineProperties(list, {
    scrollHeight: { configurable: true, get: () => 1000 },
    clientHeight: { configurable: true, get: () => 400 },
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        top = Math.max(0, Math.min(value, 600));
      },
    },
  });
  expect(list).not.toHaveClass("is-away");
  act(() => {
    list.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
    top = 560;
    list.dispatchEvent(new Event("scroll"));
  });
  await waitFor(() => expect(list).toHaveClass("is-away"));
  fireEvent.click(screen.getByRole("button", { name: "回到最新" }));
  await waitFor(() => expect(list).not.toHaveClass("is-away"));
});
// R62: memory edits work while a reply runs and report their own failures where they were made.
const withMemory = (busy: boolean, messages: unknown[] = []) => ({
  revision: 1,
  activeId: "a",
  chats: [{ id: "a", title: "话题A", updatedAt: "now", pinned: false, archived: false, messageCount: messages.length }],
  contextStart: 0,
  contextNote: "",
  contextCharacters: 0,
  messages,
  busy,
  error: null,
  memory: { enabled: true, status: "空闲", items: [{ id: "k", text: "喜欢简短回答", at: "now", source: "user" }] },
});
it("saves a memory while a reply is running instead of ignoring the click (R62)", async () => {
  mock.bridge.getHertaChat.mockResolvedValue(withMemory(true));
  mock.bridge.manageHertaChat.mockResolvedValue(withMemory(true));
  render(<HertaChat onSettings={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "黑塔的记忆 · 1" }));
  const dialog = screen.getByRole("dialog", { name: "黑塔的记忆" });
  const box = within(dialog).getByRole("textbox");
  fireEvent.change(box, { target: { value: "周末不安排工作" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "保存记忆" }));
  await waitFor(() => expect(box).toHaveValue(""));
  expect(mock.bridge.manageHertaChat).toHaveBeenCalledWith({ type: "memory", operation: "save", id: undefined, text: "周末不安排工作" });
});
it("shows a failed memory save inside the dialog, keeps the text and names the real reason (R62)", async () => {
  mock.bridge.getHertaChat.mockResolvedValue(withMemory(false));
  mock.bridge.manageHertaChat
    .mockRejectedValueOnce(new Error("Error invoking remote method: Error: 记忆已满，请先整理已有条目。"))
    .mockRejectedValueOnce(new Error("EPERM: operation not permitted, rename 'C:\private\memory.json.tmp'"));
  render(<HertaChat onSettings={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "黑塔的记忆 · 1" }));
  const dialog = screen.getByRole("dialog", { name: "黑塔的记忆" });
  const box = within(dialog).getByRole("textbox");
  fireEvent.change(box, { target: { value: "周末不安排工作" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "保存记忆" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("记忆已满，请先整理已有条目。");
  expect(box).toHaveValue("周末不安排工作");
  fireEvent.click(within(dialog).getByRole("button", { name: "保存记忆" }));
  await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent("记忆更改未保存，原有记忆保持不变。"));
  expect(screen.queryByText(/EPERM|private|检查连接与模型设置/)).not.toBeInTheDocument();
  expect(box).toHaveValue("周末不安排工作");
});
it("closes the 续聊范围 popover on Escape and returns focus to its toggle (R63)", async () => {
  const { container } = render(<HertaChat onSettings={vi.fn()} />);
  await chatModelReady("m · Text provider");
  const details = container.querySelector(".herta-chat-context") as HTMLDetailsElement;
  details.open = true;
  const range = screen.getByLabelText("保留范围");
  range.focus();
  fireEvent.keyDown(range, { key: "Escape" });
  expect(details.open).toBe(false);
  expect(document.activeElement).toBe(details.querySelector("summary"));
});
it("reuses a blank current chat instead of stacking another empty one (R68)", async () => {
  mock.bridge.getHertaChat.mockResolvedValue(snap("a", 0));
  mock.bridge.manageHertaChat.mockResolvedValue(snap("b", 1));
  render(<HertaChat onSettings={vi.fn()} />);
  await chatModelReady("m · Text provider");
  const box = screen.getByRole("textbox", { name: "给黑塔的消息" });
  fireEvent.click(screen.getByRole("button", { name: "新建聊天" }));
  expect(mock.bridge.manageHertaChat).not.toHaveBeenCalledWith({ type: "create" });
  expect(document.activeElement).toBe(box);
  fireEvent.change(box, { target: { value: "有内容了" } });
  fireEvent.click(screen.getByRole("button", { name: "新建聊天" }));
  await waitFor(() => expect(mock.bridge.manageHertaChat).toHaveBeenCalledWith({ type: "create" }));
});

it("keeps the readable files of a batch and names the rejected one (R70)", async () => {
 mock.bridge.parseChatFile.mockImplementation(async (name:string)=>name==="scan.pdf"?{ok:false,message:"文档没有可读取的文字。"}:{ok:true,attachment:{name,text:`${name} 内容`,format:"pdf"}});
 render(<HertaChat onSettings={vi.fn()}/>);
 await chatModelReady("m · Text provider");
 const file=(name:string,size=10)=>({name,size,arrayBuffer:async()=>new ArrayBuffer(10)});
 fireEvent.change(screen.getByLabelText("附加文件"),{target:{files:[file("a.pdf"),file("scan.pdf"),file("huge.pdf",5*1024*1024),file("c.pdf")]}});
 expect(await screen.findByText("未添加：单个附件不能超过4 MB。")).toBeInTheDocument();
 expect(screen.getByText("未添加：文档没有可读取的文字。")).toBeInTheDocument();
 expect(screen.getByRole("button",{name:"查看 a.pdf"})).toBeInTheDocument();
 expect(screen.getByRole("button",{name:"查看 c.pdf"})).toBeInTheDocument();
 expect(screen.getAllByRole("button",{name:/^移除 /}).map(b=>b.getAttribute("aria-label"))).toEqual(["移除 a.pdf","移除 c.pdf","移除 scan.pdf","移除 huge.pdf"]);
 expect(screen.getAllByRole("button",{name:/^重试添加 /})).toHaveLength(2);
});
it("keeps pending files with their chat across a switch until that chat sends them (R70)", async () => {
 mock.bridge.getHertaChat.mockResolvedValue(snap("a",0));
 mock.bridge.manageHertaChat.mockResolvedValueOnce(snap("b",1)).mockResolvedValueOnce(snap("a",2));
 mock.bridge.parseChatFile.mockResolvedValue({ok:true,attachment:{name:"plan.pdf",text:"计划附件",format:"pdf"}});
 mock.bridge.sendHertaChat.mockResolvedValue({accepted:true});
 render(<HertaChat onSettings={vi.fn()}/>);
 await chatModelReady("m · Text provider");
 fireEvent.change(screen.getByLabelText("附加文件"),{target:{files:[{name:"plan.pdf",size:10,arrayBuffer:async()=>new ArrayBuffer(10)}]}});
 await screen.findByRole("button",{name:"查看 plan.pdf"});
 fireEvent.click(screen.getByRole("button",{name:"话题B"}));
 await waitFor(()=>expect(screen.queryByRole("button",{name:"查看 plan.pdf"})).not.toBeInTheDocument());
 fireEvent.click(screen.getByRole("button",{name:"话题A"}));
 expect(await screen.findByRole("button",{name:"查看 plan.pdf"})).toBeInTheDocument();
 fireEvent.change(screen.getByRole("textbox",{name:"给黑塔的消息"}),{target:{value:"看看计划"}});
 fireEvent.click(screen.getByRole("button",{name:"发送"}));
 await waitFor(()=>expect(mock.bridge.sendHertaChat).toHaveBeenCalledWith(expect.objectContaining({chatId:"a",attachments:[{name:"plan.pdf",text:"计划附件",format:"pdf"}]})));
 await waitFor(()=>expect(screen.queryByRole("button",{name:"查看 plan.pdf"})).not.toBeInTheDocument());
});
it("lands a switched-to chat on its newest line, then brings the messages in view in one by one (R71)", async () => {
 document.documentElement.dataset.appearance = "observatory";
 document.documentElement.dataset.motion = "system";
 vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("no-preference"), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
 const box = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ top: 0, bottom: 40, height: 40, left: 0, right: 100, width: 100, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
 const message = (id: string, role: "user" | "assistant", text: string) => ({ id, role, text, at: "2026-10-22T00:00:00Z", status: "complete" as const });
 mock.bridge.getHertaChat.mockResolvedValue({ ...snap("a", 0), messages: [message("a1", "user", "甲一")] });
 mock.bridge.manageHertaChat.mockResolvedValueOnce({ ...snap("b", 1), messages: [message("b1", "user", "乙一"), message("b2", "assistant", "乙二")] });
 const from = vi.spyOn(gsap, "from");
 try {
  const view = render(<HertaChat onSettings={vi.fn()} />);
  await screen.findByText("甲一");
  const scroller = view.container.querySelector<HTMLElement>(".herta-chat-messages")!;
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 900 });
  fireEvent.click(screen.getByRole("button", { name: "话题B" }));
  await screen.findByText("乙二");
  expect(scroller.scrollTop).toBe(900);
  const targets = from.mock.calls.at(-1)?.[0] as HTMLElement[];
  expect(targets.map((el) => el.dataset.entrance)).toEqual(["b1", "b2"]);
  view.unmount();
 } finally {
  from.mockRestore();
  box.mockRestore();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.appearance;
  delete document.documentElement.dataset.motion;
 }
});
it("says the image warning once when a send then fails for it (R72)", async () => {
 const image={mimeType:"image/png",data:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="};
 mock.bridge.parseChatFile.mockResolvedValue({ok:true,attachment:{name:"x.png",text:"",image}});
 mock.bridge.sendHertaChat.mockRejectedValue(new Error("当前模型未通过识图检测，图片不会发出。可在“连接与模型”中点“测试识图”，或换用已通过的模型；也可移除附件、调整续聊范围，或在已发送的图片下选择“不再发给模型”。"));
 render(<HertaChat onSettings={vi.fn()} />);
 await chatModelReady("m · Text provider");
 fireEvent.change(screen.getByLabelText("附加文件"),{target:{files:[{name:"x.png",size:68,arrayBuffer:async()=>new ArrayBuffer(68)}]}});
 await screen.findByRole("button",{name:"查看图片 x.png"});
 expect(screen.getAllByText(/当前模型未通过识图检测/)).toHaveLength(1);
 fireEvent.change(screen.getByRole("textbox",{name:"给黑塔的消息"}),{target:{value:"看图"}});
 fireEvent.click(screen.getByRole("button",{name:"发送"}));
 await screen.findByRole("alert");
 expect(screen.getAllByText(/当前模型未通过识图检测/)).toHaveLength(1);
});
const pick = (name: string) => ({ name, size: 10, arrayBuffer: async () => new ArrayBuffer(10) });
it("removes one pending file by its own button and sends only the rest (R78)", async () => {
 const image={mimeType:"image/png",data:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="};
 mock.bridge.parseChatFile.mockImplementation(async (name:string)=>name==="x.png"?{ok:true,attachment:{name,text:"",image}}:{ok:true,attachment:{name,text:"要点",format:"pdf"}});
 mock.bridge.sendHertaChat.mockResolvedValue({accepted:true});
 render(<HertaChat onSettings={vi.fn()}/>);
 await chatModelReady("m · Text provider");
 fireEvent.change(screen.getByLabelText("附加文件"),{target:{files:[pick("notes.pdf"),pick("x.png")]}});
 const tray = await screen.findByRole("group",{name:"待发送的附件"});
 await screen.findByRole("button",{name:"查看图片 x.png"});
 // The picture comes first; its viewer and its remove button are separate targets.
 expect([...tray.querySelectorAll("li")].map(li=>li.className)).toEqual(["herta-attachment is-picture","herta-attachment is-file"]);
 fireEvent.click(screen.getByRole("button",{name:"移除 notes.pdf"}));
 expect(screen.queryByRole("button",{name:"查看 notes.pdf"})).not.toBeInTheDocument();
 fireEvent.change(screen.getByRole("textbox",{name:"给黑塔的消息"}),{target:{value:"看这张"}});
 fireEvent.click(screen.getByRole("button",{name:"发送"}));
 await waitFor(()=>expect(mock.bridge.sendHertaChat).toHaveBeenCalledTimes(1));
 expect(mock.bridge.sendHertaChat.mock.calls[0]![0].attachments).toEqual([{name:"x.png",text:"",image}]);
});
it("cancels a file while it is read and drops its late result (R78)", async () => {
 const finishes: ((value:unknown)=>void)[]=[];
 mock.bridge.parseChatFile.mockImplementation(()=>new Promise(resolve=>finishes.push(resolve)));
 render(<HertaChat onSettings={vi.fn()}/>);
 await chatModelReady("m · Text provider");
 fireEvent.change(screen.getByLabelText("附加文件"),{target:{files:[pick("slow.pdf"),pick("next.pdf")]}});
 await waitFor(()=>expect(finishes).toHaveLength(1));
 expect(screen.getByRole("group",{name:"待发送的附件"})).toHaveTextContent("slow.pdf正在读取…");
 fireEvent.click(screen.getByRole("button",{name:"取消添加 slow.pdf"}));
 expect(screen.queryByText("slow.pdf")).not.toBeInTheDocument();
 await act(async()=>finishes[0]!({ok:true,attachment:{name:"slow.pdf",text:"迟到的内容",format:"pdf"}}));
 await waitFor(()=>expect(finishes).toHaveLength(2));
 await act(async()=>finishes[1]!({ok:true,attachment:{name:"next.pdf",text:"下一份",format:"pdf"}}));
 expect(await screen.findByRole("button",{name:"查看 next.pdf"})).toBeInTheDocument();
 expect(screen.queryByRole("button",{name:"查看 slow.pdf"})).not.toBeInTheDocument();
 expect(screen.getByLabelText("附加文件")).not.toBeDisabled();
});
it("retries a file that could not be added (R78)", async () => {
 mock.bridge.parseChatFile.mockResolvedValueOnce({ok:false,message:"文件未能读取，请检查编码、格式或文件是否损坏。"}).mockResolvedValueOnce({ok:true,attachment:{name:"flaky.md",text:"# 第二次"}});
 render(<HertaChat onSettings={vi.fn()}/>);
 await chatModelReady("m · Text provider");
 fireEvent.change(screen.getByLabelText("附加文件"),{target:{files:[pick("flaky.md")]}});
 fireEvent.click(await screen.findByRole("button",{name:"重试添加 flaky.md"}));
 expect(await screen.findByRole("button",{name:"查看 flaky.md"})).toBeInTheDocument();
 expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
it("puts a sent message's attachments above its text in the same bubble (R78)", async () => {
 const image={mimeType:"image/png",data:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="};
 mock.bridge.getHertaChat.mockResolvedValue({...snap("a",0),messages:[{id:"u1",role:"user",text:"看看这两份",at:"2026-10-22T00:00:00Z",status:"complete",attachments:[{name:"plan.pdf",text:"计划",format:"pdf",pages:3},{name:"x.png",text:"",image}]}]});
 render(<HertaChat onSettings={vi.fn()}/>);
 const text = await screen.findByText("看看这两份");
 const group = screen.getByRole("group",{name:"这条消息的附件"});
 const bubble = group.closest("article")!;
 expect(bubble).toBe(text.closest("article"));
 expect(group.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 // Pictures first, then files; a file's text opens from its chip.
 expect([...group.querySelectorAll("li")].map(li=>li.className)).toEqual(["herta-attachment is-picture has-model-use","herta-attachment is-file"]);
 expect(screen.getByText("PDF · 3 页")).toBeInTheDocument();
 fireEvent.click(screen.getByRole("button",{name:"查看 plan.pdf"}));
 expect(await screen.findByText("计划")).toBeInTheDocument();
});

const draftBox = () => screen.getByRole("textbox", { name: "给黑塔的消息" });
const typeDraft = (value: string) => fireEvent.change(draftBox(), { target: { value } });
it("opens / at a line start, narrows by name or alias, and Enter opens the model choice (R80)", async () => {
 render(<HertaChat onSettings={vi.fn()} />);
 await chatModelReady("m · Text provider");
 typeDraft("/");
 const menu = screen.getByRole("listbox", { name: "指令" });
 expect(within(menu).getAllByRole("option").map(o => o.querySelector(".herta-slash-title")?.textContent)).toEqual(["附加文件", "选择模型"]);
 typeDraft("/mod");
 expect(within(menu).getAllByRole("option")).toHaveLength(1);
 typeDraft("/模型");
 expect(within(screen.getByRole("listbox", { name: "指令" })).getByRole("option")).toHaveTextContent("选择模型");
 fireEvent.keyDown(draftBox(), { key: "Enter" });
 expect(screen.queryByRole("listbox", { name: "指令" })).toBeNull();
 expect(await screen.findByRole("dialog", { name: "聊天模型与回复设置" })).toBeInTheDocument();
 expect(document.activeElement).toBe(screen.getByRole("button", { name: "m · Text provider" }));
 expect(draftBox()).toHaveValue("");
});
it("/attach clicks the same file picker as the paperclip, keeping the rest of the draft (R80)", async () => {
 const clicked = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {});
 try {
  render(<HertaChat onSettings={vi.fn()} />);
  await chatModelReady("m · Text provider");
  typeDraft("先看这个\n/att");
  fireEvent.keyDown(draftBox(), { key: "Enter" });
  expect(clicked).toHaveBeenCalledTimes(1);
  expect(clicked.mock.contexts[0]).toBe(screen.getByLabelText("附加文件"));
  expect(draftBox()).toHaveValue("先看这个\n");
 } finally {
  clicked.mockRestore();
 }
});
it("never opens / for a path, a URL or a slash mid-line; Esc closes and keeps the draft; IME and unknown commands do not run (R80)", async () => {
 render(<HertaChat onSettings={vi.fn()} />);
 await chatModelReady("m · Text provider");
 for (const text of ["src/main.ts", "https://example.com/a", "/usr/bin", "看 /attach", "```\n/attach"]) {
  typeDraft(text);
  expect(screen.queryByRole("listbox", { name: "指令" }), text).toBeNull();
 }
 typeDraft("/");
 fireEvent.keyDown(draftBox(), { key: "Escape" });
 expect(screen.queryByRole("listbox", { name: "指令" })).toBeNull();
 expect(draftBox()).toHaveValue("/");
 typeDraft("/mo");
 // Mid-composition the keys belong to the IME.
 expect(fireEvent.keyDown(draftBox(), { key: "Enter", isComposing: true, keyCode: 229 })).toBe(true);
 expect(screen.getByRole("listbox", { name: "指令" })).toBeInTheDocument();
 typeDraft("/zzz");
 expect(screen.getByText("没有匹配的指令，按 Enter 照常换行。")).toBeInTheDocument();
 // Not prevented: Enter stays a newline.
 expect(fireEvent.keyDown(draftBox(), { key: "Enter" })).toBe(true);
 expect(screen.queryByRole("listbox", { name: "指令" })).toBeNull();
});

it("imports a pasted screenshot and dropped files like the picker, and leaves text pastes alone (R82)", async () => {
 // jsdom's Blob has no arrayBuffer(); Electron's does. Read through FileReader instead.
 if (!Blob.prototype.arrayBuffer)
  Blob.prototype.arrayBuffer = function (this: Blob) {
   return new Promise<ArrayBuffer>((done) => { const r = new FileReader(); r.onload = () => done(r.result as ArrayBuffer); r.readAsArrayBuffer(this); });
  };
 mock.bridge.parseChatFile.mockImplementation(async (name: string) => ({ ok: true, attachment: /\.png$/.test(name) ? { name, text: "", image: { mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=" } } : { name, text: `${name} 内容` } }));
 render(<HertaChat onSettings={vi.fn()} />);
 await chatModelReady("m · Text provider");
 const box = screen.getByRole("textbox", { name: "给黑塔的消息" });
 fireEvent.paste(box, { clipboardData: { files: [] } });
 expect(mock.bridge.parseChatFile).not.toHaveBeenCalled();
 const shot = new File([new Uint8Array([0x89, 0x50])], "image.png", { type: "image/png" });
 await act(async () => {
  fireEvent.paste(box, { clipboardData: { files: [shot, new File(["x"], "a.txt", { type: "text/plain" })] } });
 });
 await waitFor(() => expect(mock.bridge.parseChatFile).toHaveBeenCalledTimes(1));
 const [name, bytes] = mock.bridge.parseChatFile.mock.calls[0] as [string, Uint8Array];
 expect(name).toBe("pasted-image.png");
 expect(Array.from(bytes)).toEqual([0x89, 0x50]);
 expect(await screen.findByRole("button", { name: "查看图片 pasted-image.png" })).toBeInTheDocument();
 const composer = box.closest(".herta-chat-composer") as HTMLElement;
 const dropped = { name: "notes.md", size: 4, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer };
 fireEvent.dragEnter(composer, { dataTransfer: { types: ["Files"], files: [dropped] } });
 expect(composer).toHaveClass("is-dragover");
 await act(async () => {
  fireEvent.drop(composer, { dataTransfer: { types: ["Files"], files: [dropped] } });
 });
 expect(composer).not.toHaveClass("is-dragover");
 await waitFor(() => expect(mock.bridge.parseChatFile).toHaveBeenCalledTimes(2));
 expect(mock.bridge.parseChatFile.mock.calls[1]?.[0]).toBe("notes.md");
 expect(await screen.findByText("notes.md")).toBeInTheDocument();
});

it("refuses a paste or drop while an attachment is still being read (R82)", async () => {
 mock.bridge.parseChatFile.mockImplementation(() => new Promise(() => {}));
 render(<HertaChat onSettings={vi.fn()} />);
 await chatModelReady("m · Text provider");
 fireEvent.change(screen.getByLabelText("附加文件"), { target: { files: [{ name: "slow.pdf", size: 10, arrayBuffer: async () => new ArrayBuffer(10) }] } });
 await waitFor(() => expect(mock.bridge.parseChatFile).toHaveBeenCalledTimes(1));
 const box = screen.getByRole("textbox", { name: "给黑塔的消息" });
 await act(async () => {
  fireEvent.drop(box.closest(".herta-chat-composer") as HTMLElement, { dataTransfer: { types: ["Files"], files: [{ name: "late.md", size: 1, arrayBuffer: async () => new ArrayBuffer(1) }] } });
 });
 expect(await screen.findByText("附件还在读取，请稍候。")).toBeInTheDocument();
 await act(async () => {
  fireEvent.paste(box, { clipboardData: { files: [new File([new Uint8Array([1])], "image.png", { type: "image/png" })] } });
 });
 expect(mock.bridge.parseChatFile).toHaveBeenCalledTimes(1);
});

// R101: a chat's pending files are kept on this computer (IndexedDB) and come back after a
// restart. Each test gives the window its own in-memory IndexedDB; a new render is a new launch.
const r101Image = { mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=" };
const withIdb = async (run: (mem: ReturnType<typeof memoryIdb>) => Promise<void>) => {
 const mem = memoryIdb();
 vi.stubGlobal("indexedDB", mem.idb);
 try {
  await run(mem);
 } finally {
  vi.unstubAllGlobals();
 }
};
const settle = () => act(() => new Promise<void>((done) => setTimeout(done, 10)));
it("keeps a chat's pending files across a restart, then sends and forgets them (R101)", () => withIdb(async (mem) => {
 mock.bridge.parseChatFile.mockImplementation(async (name: string) => name.endsWith(".png") ? { ok: true, attachment: { name, text: "", image: r101Image } } : { ok: true, attachment: { name, text: "要点", format: "pdf" } });
 const first = render(<HertaChat onSettings={vi.fn()} />);
 await chatModelReady("m · Text provider");
 fireEvent.change(screen.getByLabelText("附加文件"), { target: { files: [pick("notes.pdf"), pick("x.png")] } });
 await screen.findByRole("button", { name: "查看图片 x.png" });
 await waitFor(() => expect(mem.pending().get("a")?.files).toHaveLength(2));
 first.unmount();
 render(<HertaChat onSettings={vi.fn()} />);
 expect(await screen.findByRole("button", { name: "查看图片 x.png" })).toBeInTheDocument();
 expect(screen.getByRole("button", { name: "查看 notes.pdf" })).toBeInTheDocument();
 // Coming back reads nothing again and sends nothing.
 expect(mock.bridge.parseChatFile).toHaveBeenCalledTimes(2);
 expect(mock.bridge.sendHertaChat).not.toHaveBeenCalled();
 await chatModelReady("m · Text provider");
 typeDraft("接着看");
 fireEvent.click(screen.getByRole("button", { name: "发送" }));
 await waitFor(() => expect(mock.bridge.sendHertaChat).toHaveBeenCalledTimes(1));
 expect(mock.bridge.sendHertaChat.mock.calls[0]![0].attachments).toEqual([{ name: "notes.pdf", text: "要点", format: "pdf" }, { name: "x.png", text: "", image: r101Image }]);
 await waitFor(() => expect(mem.pending().has("a")).toBe(false));
 expect(screen.queryByRole("alert")).not.toBeInTheDocument();
}));
it("a file removed before the restart stays removed (R101)", () => withIdb(async (mem) => {
 mock.bridge.parseChatFile.mockImplementation(async (name: string) => ({ ok: true, attachment: { name, text: `${name} 内容` } }));
 const first = render(<HertaChat onSettings={vi.fn()} />);
 await chatModelReady("m · Text provider");
 fireEvent.change(screen.getByLabelText("附加文件"), { target: { files: [pick("a.md"), pick("b.md")] } });
 await screen.findByRole("button", { name: "查看 b.md" });
 fireEvent.click(screen.getByRole("button", { name: "移除 a.md" }));
 await waitFor(() => expect(mem.pending().get("a")?.files.map((file: { name: string }) => file.name)).toEqual(["b.md"]));
 first.unmount();
 render(<HertaChat onSettings={vi.fn()} />);
 expect(await screen.findByRole("button", { name: "查看 b.md" })).toBeInTheDocument();
 expect(screen.queryByText("a.md")).not.toBeInTheDocument();
 fireEvent.click(screen.getByRole("button", { name: "移除 b.md" }));
 await waitFor(() => expect(mem.pending().has("a")).toBe(false));
}));
it("keeps a saved record it cannot read, says so, and sets it aside only when asked (R101)", () => withIdb(async (mem) => {
 const future = { version: 2, chatId: "a", files: [{ name: "new.md", text: "x", kind: "later" }] };
 mem.seed("a", future);
 mock.bridge.parseChatFile.mockResolvedValue({ ok: true, attachment: { name: "now.md", text: "现在" } });
 render(<HertaChat onSettings={vi.fn()} />);
 expect(await screen.findByText(/上次未发送的附件记录无法读取/)).toBeInTheDocument();
 await chatModelReady("m · Text provider");
 fireEvent.change(screen.getByLabelText("附加文件"), { target: { files: [pick("now.md")] } });
 expect(await screen.findByRole("button", { name: "查看 now.md" })).toBeInTheDocument();
 // What it could not read is never written over; the new file stays in this window.
 await settle();
 expect(mem.seen.commits).toBe(0);
 expect(mem.pending().get("a")).toEqual(future);
 fireEvent.click(screen.getByRole("button", { name: "重置附件记录" }));
 await waitFor(() => expect(screen.queryByText(/上次未发送的附件记录无法读取/)).not.toBeInTheDocument());
 expect([...mem.aside().values()]).toMatchObject([{ chatId: "a", record: future }]);
 await waitFor(() => expect(mem.pending().get("a")).toEqual({ version: 1, chatId: "a", files: [{ name: "now.md", text: "现在" }] }));
 expect(screen.getByRole("button", { name: "查看 now.md" })).toBeInTheDocument();
}));
it("does not send before the saved files are back, and shows them first (R101)", () => withIdb(async (mem) => {
 mem.seed("a", { version: 1, chatId: "a", files: [{ name: "kept.md", text: "上次的" }] });
 const release = mem.hold();
 render(<HertaChat onSettings={vi.fn()} />);
 await chatModelReady("m · Text provider");
 typeDraft("马上发");
 fireEvent.click(screen.getByRole("button", { name: "发送" }));
 await act(async () => release());
 expect(await screen.findByText("已恢复上次未发送的附件，请确认后再发送。")).toBeInTheDocument();
 expect(screen.getByRole("button", { name: "查看 kept.md" })).toBeInTheDocument();
 expect(mock.bridge.sendHertaChat).not.toHaveBeenCalled();
 expect(draftBox()).toHaveValue("马上发");
 fireEvent.click(screen.getByRole("button", { name: "发送" }));
 await waitFor(() => expect(mock.bridge.sendHertaChat).toHaveBeenCalledTimes(1));
 expect(mock.bridge.sendHertaChat.mock.calls[0]![0].attachments).toEqual([{ name: "kept.md", text: "上次的" }]);
}));
it("counts files a restart brings back toward the four, even when they arrive late (R101)", () => withIdb(async (mem) => {
 mem.seed("a", { version: 1, chatId: "a", files: ["1.md", "2.md", "3.md"].map((name) => ({ name, text: name })) });
 const release = mem.hold();
 render(<HertaChat onSettings={vi.fn()} />);
 await chatModelReady("m · Text provider");
 fireEvent.change(screen.getByLabelText("附加文件"), { target: { files: [pick("4.md"), pick("5.md")] } });
 await act(async () => release());
 expect(await screen.findByText("每条消息最多附加4个文件。")).toBeInTheDocument();
 expect(screen.getByRole("button", { name: "查看 3.md" })).toBeInTheDocument();
 expect(screen.queryByText("4.md")).not.toBeInTheDocument();
 expect(mock.bridge.parseChatFile).not.toHaveBeenCalled();
}));
it("says when pending files could not be saved, and still sends them (R101)", () => withIdb(async (mem) => {
 mock.bridge.parseChatFile.mockResolvedValue({ ok: true, attachment: { name: "a.md", text: "内容" } });
 render(<HertaChat onSettings={vi.fn()} />);
 await chatModelReady("m · Text provider");
 await settle();
 mem.fail.commit = true;
 fireEvent.change(screen.getByLabelText("附加文件"), { target: { files: [pick("a.md")] } });
 expect(await screen.findByText(/待发附件的更改未能保存到本机/)).toBeInTheDocument();
 expect(screen.getByRole("button", { name: "查看 a.md" })).toBeInTheDocument();
 mem.fail.commit = false;
 typeDraft("照常发送");
 fireEvent.click(screen.getByRole("button", { name: "发送" }));
 await waitFor(() => expect(mock.bridge.sendHertaChat).toHaveBeenCalledTimes(1));
 expect(mock.bridge.sendHertaChat.mock.calls[0]![0].attachments).toEqual([{ name: "a.md", text: "内容" }]);
 // Clearing the sent files was saved, which ends the warning.
 await waitFor(() => expect(screen.queryByText(/待发附件的更改未能保存到本机/)).not.toBeInTheDocument());
 expect(mem.pending().has("a")).toBe(false);
}));
it("when saved files cannot be read at all, nothing is written over them in that run (R101)", () => withIdb(async (mem) => {
 const kept = { version: 1, chatId: "a", files: [{ name: "kept.md", text: "上次的" }] };
 mem.seed("a", kept);
 mem.fail.open = "error";
 mock.bridge.parseChatFile.mockResolvedValue({ ok: true, attachment: { name: "now.md", text: "现在" } });
 render(<HertaChat onSettings={vi.fn()} />);
 expect(await screen.findByText(/无法读取本机保存的待发附件/)).toBeInTheDocument();
 await chatModelReady("m · Text provider");
 mem.fail.open = undefined; // storage works again, but this run never read the record
 fireEvent.change(screen.getByLabelText("附加文件"), { target: { files: [pick("now.md")] } });
 expect(await screen.findByRole("button", { name: "查看 now.md" })).toBeInTheDocument();
 await settle();
 expect(mem.seen.commits).toBe(0);
 expect(mem.pending().get("a")).toEqual(kept);
}));

// The sent message shows its own chips with the same names, so these look inside the composer's tray.
const tray = () => within(screen.getByRole("group", { name: "待发送的附件" }));
const sentWith = (attachments: unknown[]) => ({ ...snap("a", 0), messages: [{ id: "u1", role: "user", text: "看这两份", at: "2026-10-26T00:00:00Z", status: "complete", attachments }, { id: "r1", role: "assistant", text: "收到", at: "2026-10-26T00:00:01Z", status: "complete" }] });
it("warns when restored files are the ones the newest message already carried, and keeps them (R101)", () => withIdb(async (mem) => {
 // An exit between saving the message and clearing its files leaves exactly these behind.
 mem.seed("a", { version: 1, chatId: "a", files: [{ name: "kept.md", text: "上次的" }, { name: "x.png", text: "", image: r101Image }] });
 mock.bridge.getHertaChat.mockResolvedValue(sentWith([{ name: "kept.md", text: "上次的" }, { name: "x.png", text: "", imageDeferred: true }]));
 render(<HertaChat onSettings={vi.fn()} />);
 expect(await screen.findByText(/可能已随那条消息发出/)).toBeInTheDocument();
 expect(tray().getByRole("button", { name: "查看 kept.md" })).toBeInTheDocument();
 expect(tray().getByRole("button", { name: "查看图片 x.png" })).toBeInTheDocument();
 expect(mock.bridge.sendHertaChat).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole("button", { name: "移除 kept.md" }));
 await waitFor(() => expect(screen.queryByText(/可能已随那条消息发出/)).not.toBeInTheDocument());
 await waitFor(() => expect(mem.pending().get("a")?.files.map((file: { name: string }) => file.name)).toEqual(["x.png"]));
}));
it("does not call restored files sent when only their names match the last message (R101)", () => withIdb(async (mem) => {
 mem.seed("a", { version: 1, chatId: "a", files: [{ name: "kept.md", text: "改过的" }] });
 mock.bridge.getHertaChat.mockResolvedValue(sentWith([{ name: "kept.md", text: "上次的" }]));
 render(<HertaChat onSettings={vi.fn()} />);
 await waitFor(() => expect(tray().getByRole("button", { name: "查看 kept.md" })).toBeInTheDocument());
 await settle();
 expect(screen.queryByText(/可能已随那条消息发出/)).not.toBeInTheDocument();
}));

// R102: cards of files that never became attachments stay with their chat across a switch and a restart.
const cardKey = (chatId: string) => `the-herta.chat-attach-issues.v1.${chatId}`;
const storedCards = (chatId: string) => JSON.parse(localStorage.getItem(cardKey(chatId)) ?? "null");
const NOT_TEXT = "支持文本、代码、PDF、DOCX、PNG 和 JPEG；旧版 Office 暂不支持。";
const AFTER_RESTART = "应用重启后无法直接重试，需要时请重新添加。";
it("keeps a refused file's card with its chat across a switch, where it can still be retried (R102)", async () => {
 mock.bridge.getHertaChat.mockResolvedValue(snap("a", 0));
 mock.bridge.manageHertaChat.mockResolvedValueOnce(snap("b", 1)).mockResolvedValueOnce(snap("a", 2));
 mock.bridge.parseChatFile.mockResolvedValueOnce({ ok: false, message: "文本文件不能超过128 KB。" }).mockResolvedValueOnce({ ok: true, attachment: { name: "big.txt", text: "第二次" } });
 render(<HertaChat onSettings={vi.fn()} />);
 await chatModelReady("m · Text provider");
 fireEvent.change(screen.getByLabelText("附加文件"), { target: { files: [pick("big.txt")] } });
 expect(await screen.findByText("未添加：文本文件不能超过128 KB。")).toBeInTheDocument();
 fireEvent.click(screen.getByRole("button", { name: "话题B" }));
 await waitFor(() => expect(screen.queryByText(/big\.txt/)).not.toBeInTheDocument());
 // The card is A's: B sends without it.
 typeDraft("B的消息");
 fireEvent.click(screen.getByRole("button", { name: "发送" }));
 await waitFor(() => expect(mock.bridge.sendHertaChat).toHaveBeenCalledTimes(1));
 expect(mock.bridge.sendHertaChat.mock.calls[0]![0]).toMatchObject({ chatId: "b", text: "B的消息" });
 expect(mock.bridge.sendHertaChat.mock.calls[0]![0].attachments).toBeUndefined();
 expect(localStorage.getItem(cardKey("b"))).toBeNull();
 await waitFor(() => expect(screen.getByRole("button", { name: "话题A" })).not.toBeDisabled());
 fireEvent.click(screen.getByRole("button", { name: "话题A" }));
 expect(await screen.findByText("未添加：文本文件不能超过128 KB。")).toBeInTheDocument();
 fireEvent.click(screen.getByRole("button", { name: "重试添加 big.txt" }));
 expect(await screen.findByRole("button", { name: "查看 big.txt" })).toBeInTheDocument();
 expect(screen.queryByText(/未添加/)).not.toBeInTheDocument();
 expect(localStorage.getItem(cardKey("a"))).toBeNull();
});
it("turns a read a switch cut short into a card of its own chat, and the late result goes nowhere (R102)", async () => {
 mock.bridge.getHertaChat.mockResolvedValue(snap("a", 0));
 mock.bridge.manageHertaChat.mockResolvedValueOnce(snap("b", 1)).mockResolvedValueOnce(snap("a", 2));
 const finishes: ((value: unknown) => void)[] = [];
 mock.bridge.parseChatFile.mockImplementation(() => new Promise((resolve) => finishes.push(resolve)));
 render(<HertaChat onSettings={vi.fn()} />);
 await chatModelReady("m · Text provider");
 fireEvent.change(screen.getByLabelText("附加文件"), { target: { files: [pick("slow.pdf"), pick("next.pdf")] } });
 await waitFor(() => expect(finishes).toHaveLength(1));
 fireEvent.click(screen.getByRole("button", { name: "话题B" }));
 await waitFor(() => expect(screen.queryByText("slow.pdf")).not.toBeInTheDocument());
 await act(async () => finishes[0]!({ ok: true, attachment: { name: "slow.pdf", text: "迟到的内容", format: "pdf" } }));
 expect(screen.queryByRole("group", { name: "待发送的附件" })).not.toBeInTheDocument();
 fireEvent.click(screen.getByRole("button", { name: "话题A" }));
 // Neither file of the batch was added; both are cards to retry, not attachments.
 await waitFor(() => expect(tray().getAllByText("未添加：读取没有完成，请重试或移除。")).toHaveLength(2));
 expect(screen.queryByRole("button", { name: "查看 slow.pdf" })).not.toBeInTheDocument();
 expect(mock.bridge.parseChatFile).toHaveBeenCalledTimes(1);
 typeDraft("现在发");
 fireEvent.click(screen.getByRole("button", { name: "发送" }));
 expect(await screen.findByText("还有附件没有添加成功：请重试或移除它，再发送。")).toBeInTheDocument();
 expect(mock.bridge.sendHertaChat).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole("button", { name: "重试添加 slow.pdf" }));
 await waitFor(() => expect(finishes).toHaveLength(2));
 await act(async () => finishes[1]!({ ok: true, attachment: { name: "slow.pdf", text: "重新读取", format: "pdf" } }));
 expect(await screen.findByRole("button", { name: "查看 slow.pdf" })).toBeInTheDocument();
 expect(screen.getByRole("button", { name: "重试添加 next.pdf" })).toBeInTheDocument();
 expect(storedCards("a")).toEqual([{ id: expect.any(String), name: "next.pdf" }]);
});
it("brings refused and unfinished cards back after a restart without a retry; they block sending until removed (R102)", async () => {
 const finishes: ((value: unknown) => void)[] = [];
 mock.bridge.parseChatFile.mockImplementationOnce(async () => ({ ok: false, message: NOT_TEXT })).mockImplementation(() => new Promise((resolve) => finishes.push(resolve)));
 const first = render(<HertaChat onSettings={vi.fn()} />);
 await chatModelReady("m · Text provider");
 fireEvent.change(screen.getByLabelText("附加文件"), { target: { files: [pick("secret.key"), pick("long.pdf")] } });
 expect(await screen.findByText(`未添加：${NOT_TEXT}`)).toBeInTheDocument();
 await waitFor(() => expect(finishes).toHaveLength(1));
 // The window closes while long.pdf is still read: only ids, names and reasons are on record.
 const stored = storedCards("a");
 expect(stored).toEqual([{ id: expect.any(String), name: "secret.key", error: NOT_TEXT }, { id: expect.any(String), name: "long.pdf" }]);
 expect(stored.flatMap(Object.keys)).toEqual(["id", "name", "error", "id", "name"]);
 first.unmount();
 render(<HertaChat onSettings={vi.fn()} />);
 expect(await screen.findByText(`未添加：${NOT_TEXT}${AFTER_RESTART}`)).toBeInTheDocument();
 expect(screen.getByText(`未添加：上次关闭前还没读取完成。${AFTER_RESTART}`)).toBeInTheDocument();
 expect(screen.queryByRole("button", { name: /^重试添加 / })).not.toBeInTheDocument();
 await chatModelReady("m · Text provider");
 typeDraft("重启后");
 fireEvent.click(screen.getByRole("button", { name: "发送" }));
 expect(await screen.findByText("还有附件没有添加成功：请重试或移除它，再发送。")).toBeInTheDocument();
 expect(mock.bridge.sendHertaChat).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole("button", { name: "移除 secret.key" }));
 expect(storedCards("a")).toEqual([stored[1]]);
 fireEvent.click(screen.getByRole("button", { name: "移除 long.pdf" }));
 expect(localStorage.getItem(cardKey("a"))).toBeNull();
 fireEvent.click(screen.getByRole("button", { name: "发送" }));
 await waitFor(() => expect(mock.bridge.sendHertaChat).toHaveBeenCalledTimes(1));
 // Nothing was read again after the restart.
 expect(mock.bridge.parseChatFile).toHaveBeenCalledTimes(2);
});
it("drops a cancelled file's card from the record (R102)", async () => {
 const finishes: ((value: unknown) => void)[] = [];
 mock.bridge.parseChatFile.mockImplementation(() => new Promise((resolve) => finishes.push(resolve)));
 render(<HertaChat onSettings={vi.fn()} />);
 await chatModelReady("m · Text provider");
 fireEvent.change(screen.getByLabelText("附加文件"), { target: { files: [pick("slow.pdf")] } });
 await waitFor(() => expect(finishes).toHaveLength(1));
 expect(storedCards("a")).toEqual([{ id: expect.any(String), name: "slow.pdf" }]);
 fireEvent.click(screen.getByRole("button", { name: "取消添加 slow.pdf" }));
 expect(localStorage.getItem(cardKey("a"))).toBeNull();
});
it("keeps a card record it cannot read, says so, and never writes over it (R102)", async () => {
 localStorage.setItem(cardKey("a"), "{broken");
 mock.bridge.parseChatFile.mockResolvedValue({ ok: false, message: "文本文件不能超过128 KB。" });
 render(<HertaChat onSettings={vi.fn()} />);
 expect(await screen.findByText(/未添加成功的附件记录无法读取/)).toBeInTheDocument();
 await chatModelReady("m · Text provider");
 fireEvent.change(screen.getByLabelText("附加文件"), { target: { files: [pick("big.txt")] } });
 // This run still shows the card, but the record stays as it was.
 expect(await screen.findByText("未添加：文本文件不能超过128 KB。")).toBeInTheDocument();
 expect(localStorage.getItem(cardKey("a"))).toBe("{broken");
 fireEvent.click(screen.getByRole("button", { name: "移除 big.txt" }));
 expect(localStorage.getItem(cardKey("a"))).toBe("{broken");
 expect(screen.getByText(/未添加成功的附件记录无法读取/)).toBeInTheDocument();
});
it("says when a card could not be kept, and still shows it (R102)", async () => {
 const setItem = Storage.prototype.setItem;
 const quota = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, name: string, value: string) {
  if (name.startsWith("the-herta.chat-attach-issues.")) throw new Error("quota");
  setItem.call(this, name, value);
 });
 try {
  mock.bridge.parseChatFile.mockResolvedValue({ ok: false, message: "文本文件不能超过128 KB。" });
  render(<HertaChat onSettings={vi.fn()} />);
  await chatModelReady("m · Text provider");
  fireEvent.change(screen.getByLabelText("附加文件"), { target: { files: [pick("big.txt")] } });
  expect(await screen.findByText("未添加：文本文件不能超过128 KB。")).toBeInTheDocument();
  expect(screen.getByText("未添加成功的附件记录保存失败，当前卡片只在本次运行中保留。")).toBeInTheDocument();
 } finally {
  quota.mockRestore();
 }
 // A later change that is kept ends the warning.
 fireEvent.click(screen.getByRole("button", { name: "移除 big.txt" }));
 await waitFor(() => expect(screen.queryByText(/附件记录保存失败/)).not.toBeInTheDocument());
});
it("keeps a read file's card on record until the file itself is saved (R102)", () => withIdb(async (mem) => {
 mock.bridge.parseChatFile.mockResolvedValue({ ok: true, attachment: { name: "a.md", text: "内容" } });
 render(<HertaChat onSettings={vi.fn()} />);
 await chatModelReady("m · Text provider");
 await settle(); // the chat's saved files were read; from now on it saves
 const release = mem.hold();
 fireEvent.change(screen.getByLabelText("附加文件"), { target: { files: [pick("a.md")] } });
 expect(await screen.findByRole("button", { name: "查看 a.md" })).toBeInTheDocument();
 // In the tray already, but not saved yet: an exit now would still find its card.
 expect(storedCards("a")).toEqual([{ id: expect.any(String), name: "a.md" }]);
 expect(screen.queryByText(/未添加/)).not.toBeInTheDocument();
 await act(async () => release());
 await waitFor(() => expect(mem.pending().get("a")?.files).toHaveLength(1));
 await waitFor(() => expect(localStorage.getItem(cardKey("a"))).toBeNull());
}));
it("refuses a file that would pass the message's text total on its own, and reads the rest (R102)", async () => {
 const texts: Record<string, string> = { "one.md": "一".repeat(32000), "two.md": "二".repeat(30000), "three.md": "三".repeat(32000), "small.md": "小" };
 mock.bridge.parseChatFile.mockImplementation(async (name: string) => ({ ok: true, attachment: { name, text: texts[name] } }));
 render(<HertaChat onSettings={vi.fn()} />);
 await chatModelReady("m · Text provider");
 fireEvent.change(screen.getByLabelText("附加文件"), { target: { files: [pick("one.md"), pick("two.md"), pick("three.md"), pick("small.md")] } });
 expect(await screen.findByRole("button", { name: "查看 small.md" })).toBeInTheDocument();
 expect(screen.getByText("未添加：附件总量不能超过64000字。")).toBeInTheDocument();
 expect(screen.getByRole("button", { name: "重试添加 three.md" })).toBeInTheDocument();
 expect(tray().getAllByRole("button", { name: /^查看 / }).map((b) => b.getAttribute("aria-label"))).toEqual(["查看 one.md", "查看 two.md", "查看 small.md"]);
 expect(storedCards("a")).toEqual([{ id: expect.any(String), name: "three.md", error: "附件总量不能超过64000字。" }]);
});
it("keeps a card whose retry finds the four files already used (R102)", async () => {
 mock.bridge.parseChatFile.mockImplementation(async (name: string) => name === "late.md" ? { ok: false, message: "文件未能读取，请检查编码、格式或文件是否损坏。" } : { ok: true, attachment: { name, text: name } });
 render(<HertaChat onSettings={vi.fn()} />);
 await chatModelReady("m · Text provider");
 fireEvent.change(screen.getByLabelText("附加文件"), { target: { files: [pick("1.md"), pick("2.md"), pick("3.md"), pick("late.md")] } });
 await screen.findByRole("button", { name: "重试添加 late.md" });
 fireEvent.change(screen.getByLabelText("附加文件"), { target: { files: [pick("4.md")] } });
 await screen.findByRole("button", { name: "查看 4.md" });
 fireEvent.click(screen.getByRole("button", { name: "重试添加 late.md" }));
 expect(await screen.findByText("每条消息最多附加4个文件。")).toBeInTheDocument();
 expect(screen.getByRole("button", { name: "重试添加 late.md" })).toBeInTheDocument();
 expect(storedCards("a")).toEqual([{ id: expect.any(String), name: "late.md", error: "文件未能读取，请检查编码、格式或文件是否损坏。" }]);
 expect(mock.bridge.parseChatFile).toHaveBeenCalledTimes(5);
});

// F04 (R117, design 2.7): a sent picture in the chat can stop being sent to the model.
const tinyPicture = { mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=" };
const withPictures = (revision: number, uses: (string | undefined)[], extra: object = {}) => ({
 ...snap("a", revision),
 messages: [
  { id: "u0", role: "user", text: "更早的图", at: "2026-10-22T00:00:00Z", status: "complete", attachments: [{ name: "old.png", text: "", image: tinyPicture }] },
  { id: "r0", role: "assistant", text: "看到了", at: "2026-10-22T00:00:01Z", status: "complete" },
  { id: "u1", role: "user", text: "看看这两张", at: "2026-10-22T00:01:00Z", status: "complete", attachments: [{ name: "plan.md", text: "计划" }, ...uses.map((modelUse, i) => ({ name: `p${i}.png`, text: "", image: tinyPicture, ...(modelUse ? { modelUse } : {}) }))] },
  { id: "r1", role: "assistant", text: "好的", at: "2026-10-22T00:01:01Z", status: "complete" },
 ],
 contextStart: 2,
 ...extra,
});
const visionModel = () => mock.bridge.getProviderSettings.mockResolvedValue({ settings: { providers: [{ id: "p", name: "Vision provider", protocol: "openai-chat-completions", revision: 1, models: [{ id: "m", validation: { state: "text-available", protocol: "openai-chat-completions", providerRevision: 1 }, capabilities: { streaming: "supported", tools: "unknown", images: "supported", reasoning: "unknown" } }] }], defaultBindings: { persona: { providerId: "p", modelId: "m" } } } });
const messageTray = (text: string) => within(screen.getByText(text).closest("article")!);
it("switches one sent picture off and on, keeps focus on its switch, and says what each picture does (R117)", async () => {
 mock.bridge.getHertaChat.mockResolvedValue(withPictures(0, [undefined, undefined]));
 mock.bridge.manageHertaChat.mockResolvedValueOnce(withPictures(1, ["stopped", undefined]));
 render(<HertaChat onSettings={vi.fn()} />);
 await screen.findByText("看看这两张");
 const tray = messageTray("看看这两张");
 expect(tray.getAllByText("续聊时随消息发送")).toHaveLength(2);
 // Outside the continuation range: said so, and still switchable for later.
 expect(messageTray("更早的图").getByText("不在续聊范围内，不会发送")).toBeInTheDocument();
 // Replies and files carry no switch.
 expect(within(screen.getByText("看到了").closest("article")!).queryByRole("button", { name: /发给模型/ })).not.toBeInTheDocument();
 expect(tray.queryByRole("button", { name: /发给模型：plan\.md/ })).not.toBeInTheDocument();
 const first = tray.getByRole("button", { name: "不再发给模型：p0.png" });
 expect(first).toHaveAccessibleDescription(/续聊时随消息发送.*超出时消息不能发送/);
 first.focus();
 fireEvent.click(first);
 expect(mock.bridge.manageHertaChat).toHaveBeenCalledWith({ type: "picture-use", id: "a", messageId: "u1", indexes: [1], use: "stop" });
 const restored = await tray.findByRole("button", { name: "恢复发给模型：p0.png" });
 expect(restored).toBe(first);
 expect(document.activeElement).toBe(first);
 expect(tray.getByText("不再发给模型", { selector: ".herta-attachment-status" })).toBeInTheDocument();
 expect(first.closest("li")).toHaveClass("is-stopped");
 // The whole message: only the pictures not yet stopped are asked for.
 mock.bridge.manageHertaChat.mockResolvedValueOnce(withPictures(2, ["stopped", "stopped"]));
 fireEvent.click(tray.getByRole("button", { name: "本条图片都不再发给模型" }));
 expect(mock.bridge.manageHertaChat).toHaveBeenLastCalledWith({ type: "picture-use", id: "a", messageId: "u1", indexes: [2], use: "stop" });
 expect(await tray.findByRole("button", { name: "本条图片都恢复发给模型" })).toBeInTheDocument();
});
it("ignores clicks while a picture change is under way and says why a change failed (R117)", async () => {
 mock.bridge.getHertaChat.mockResolvedValue(withPictures(0, [undefined, undefined]));
 let answer!: (value: unknown) => void;
 mock.bridge.manageHertaChat.mockImplementationOnce(() => new Promise((_resolve, reject) => { answer = (e) => reject(e); }));
 render(<HertaChat onSettings={vi.fn()} />);
 await screen.findByText("看看这两张");
 const tray = messageTray("看看这两张");
 const first = tray.getByRole("button", { name: "不再发给模型：p0.png" });
 fireEvent.click(first);
 // Not disabled while it waits (Chromium would move focus away); a second click is ignored.
 expect(first).not.toBeDisabled();
 fireEvent.click(tray.getByRole("button", { name: "不再发给模型：p1.png" }));
 expect(mock.bridge.manageHertaChat).toHaveBeenCalledTimes(1);
 await act(async () => answer(new Error("IPC: 这些图片已经变化，请重试。 private-diagnostic")));
 expect(await tray.findByRole("alert")).toHaveTextContent("这条消息的图片已经变化，请重试。");
 expect(screen.queryByText(/private-diagnostic/)).not.toBeInTheDocument();
 mock.bridge.manageHertaChat.mockRejectedValueOnce(new Error("IPC: 请等待回复结束或先停止，再管理聊天。"));
 fireEvent.click(first);
 await waitFor(() => expect(tray.getByRole("alert")).toHaveTextContent("黑塔正在回复，结束后再更改。"));
 mock.bridge.manageHertaChat.mockRejectedValueOnce(new Error("disk unavailable"));
 fireEvent.click(first);
 await waitFor(() => expect(tray.getByRole("alert")).toHaveTextContent("未能更改图片的发送设置，请重试。"));
});
it("disables the picture switches while a reply runs (R117)", async () => {
 mock.bridge.getHertaChat.mockResolvedValue(withPictures(0, [undefined, undefined], { busy: true }));
 render(<HertaChat onSettings={vi.fn()} />);
 await screen.findByText("看看这两张");
 const tray = messageTray("看看这两张");
 expect(tray.getByRole("button", { name: "不再发给模型：p0.png" })).toBeDisabled();
 expect(tray.getByRole("button", { name: "本条图片都不再发给模型" })).toBeDisabled();
});
it("leaves stopped pictures out of the continuation's picture notice (R117)", async () => {
 visionModel();
 mock.bridge.getHertaChat.mockResolvedValue(withPictures(0, ["stopped"]));
 render(<HertaChat onSettings={vi.fn()} />);
 await screen.findByText("看看这两张");
 await chatModelReady("m · Vision provider");
 expect(screen.queryByText("图片将随当前续聊内容发送给所选模型。")).not.toBeInTheDocument();
});
it("tells the main process to stop a cancelled read, naming the card's job (R118)", async () => {
  const finishes: ((value: unknown) => void)[] = [];
  mock.bridge.parseChatFile.mockImplementation(
    () => new Promise((resolve) => finishes.push(resolve)),
  );
  mock.bridge.cancelChatFile.mockResolvedValue(true);
  render(<HertaChat onSettings={vi.fn()} />);
  await chatModelReady("m · Text provider");
  fireEvent.change(screen.getByLabelText("附加文件"), {
    target: { files: [pick("slow.pdf"), pick("next.pdf")] },
  });
  await waitFor(() => expect(finishes).toHaveLength(1));
  const job = mock.bridge.parseChatFile.mock.calls[0]![2];
  expect(job).toMatch(/^file-\d+-/);
  // A card still waiting its turn is only skipped: the main process is not reading it.
  fireEvent.click(screen.getByRole("button", { name: "取消添加 next.pdf" }));
  expect(mock.bridge.cancelChatFile).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "取消添加 slow.pdf" }));
  expect(mock.bridge.cancelChatFile).toHaveBeenCalledWith(job);
  await act(async () =>
    finishes[0]!({ ok: false, message: "附件读取已取消。" }),
  );
  expect(mock.bridge.parseChatFile).toHaveBeenCalledTimes(1);
  expect(screen.queryByText("附件读取已取消。")).not.toBeInTheDocument();
  expect(screen.getByLabelText("附加文件")).not.toBeDisabled();
});
it("stops the main-process read when the chat closes mid-read (R118)", async () => {
  mock.bridge.parseChatFile.mockImplementation(() => new Promise(() => {}));
  mock.bridge.cancelChatFile.mockResolvedValue(true);
  const view = render(<HertaChat onSettings={vi.fn()} />);
  await chatModelReady("m · Text provider");
  fireEvent.change(screen.getByLabelText("附加文件"), {
    target: { files: [pick("slow.pdf")] },
  });
  await waitFor(() => expect(mock.bridge.parseChatFile).toHaveBeenCalled());
  view.unmount();
  expect(mock.bridge.cancelChatFile).toHaveBeenCalledWith(
    mock.bridge.parseChatFile.mock.calls[0]![2],
  );
});
it("never asks the main process for a file cancelled while the window read it (R118)", async () => {
  let read!: (value: ArrayBuffer) => void;
  const slow = {
    name: "slow.pdf",
    size: 10,
    arrayBuffer: () =>
      new Promise<ArrayBuffer>((resolve) => {
        read = resolve;
      }),
  };
  render(<HertaChat onSettings={vi.fn()} />);
  await chatModelReady("m · Text provider");
  fireEvent.change(screen.getByLabelText("附加文件"), {
    target: { files: [slow] },
  });
  fireEvent.click(
    await screen.findByRole("button", { name: "取消添加 slow.pdf" }),
  );
  await act(async () => read(new ArrayBuffer(10)));
  expect(mock.bridge.parseChatFile).not.toHaveBeenCalled();
  expect(mock.bridge.cancelChatFile).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(screen.getByLabelText("附加文件")).not.toBeDisabled(),
  );
});

/** The chat export saves through the bridge's export (R124); the mock bridge has none unless a test adds it. */
const withExport = async (
  save: (name: string, markdown: string) => Promise<unknown>,
  run: () => Promise<void>,
) => {
  const bridge = mock.bridge as Record<string, unknown>;
  bridge.saveSessionExport = save;
  try {
    await run();
  } finally {
    delete bridge.saveSessionExport;
  }
};
const slashOption = (title: string) =>
  within(screen.getByRole("listbox", { name: "指令" }))
    .getAllByRole("option")
    .find((o) => o.querySelector(".herta-slash-title")?.textContent === title)!;
it("opens /goal and the same goal panel from shortcuts without sending a chat message (R129)", async () => {
  const bridge = mock.bridge as Record<string, unknown>;
  let goal = {
    state: {
      revision: 0,
      active: null as {
        text: string;
        status: "active";
        setAt: string;
        revision: number;
      } | null,
      history: [],
    },
  };
  const write = vi.fn(
    async (_id: string, _revision: number, action: { text: string }) => {
      goal = {
        state: {
          revision: 1,
          active: {
            text: action.text,
            status: "active",
            setAt: "2026-11-01T00:00:00Z",
            revision: 1,
          },
          history: [],
        },
      };
      return { ok: true, view: goal };
    },
  );
  bridge.getChatGoal = vi.fn(async () => ({ ok: true, view: goal }));
  bridge.updateChatGoal = write;
  bridge.promptPlugins = vi.fn(async () => ({
    ok: true,
    snapshot: { revision: 0, plugins: [], damaged: false },
  }));
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
  try {
    render(<HertaChat onSettings={vi.fn()} />);
    await chatModelReady("m · Text provider");
    const draft = screen.getByRole("textbox", { name: "给黑塔的消息" });
    fireEvent.change(draft, { target: { value: "/goal" } });
    expect(slashOption("目标")).toBeInTheDocument();
    fireEvent.keyDown(draft, { key: "Enter" });
    const panel = await screen.findByRole("dialog", { name: "目标" });
    expect(draft).toHaveValue("");
    fireEvent.change(within(panel).getByRole("textbox", { name: "目标内容" }), {
      target: { value: "聊清楚下一步" },
    });
    const save = within(panel).getByRole("button", { name: "设置目标" });
    await waitFor(() => expect(save).not.toBeDisabled());
    fireEvent.click(save);
    await within(panel).findByText("目标已保存。");
    expect(write).toHaveBeenCalledWith("a", 0, {
      type: "set",
      text: "聊清楚下一步",
    });
    expect(screen.getByRole("region", { name: "当前目标" })).toHaveTextContent(
      "聊清楚下一步",
    );
    fireEvent.click(within(panel).getByRole("button", { name: "关闭目标" }));
    fireEvent.click(screen.getByRole("button", { name: "快捷操作" }));
    const common = await screen.findByRole("group", { name: "常用" });
    fireEvent.click(within(common).getByRole("button", { name: /目标/ }));
    expect(await screen.findByRole("dialog", { name: "目标" })).toBe(panel);
    expect(mock.bridge.sendHertaChat).not.toHaveBeenCalled();
  } finally {
    delete bridge.getChatGoal;
    delete bridge.updateChatGoal;
    delete bridge.promptPlugins;
    Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
  }
});
it("exports the open chat from /: its messages, files by name only, where the 续聊范围 starts, and says so (R124)", async () => {
  const save = vi.fn(async (_name: string, _markdown: string) => ({
    saved: true,
  }));
  await withExport(save, async () => {
    mock.bridge.getHertaChat.mockResolvedValue({
      ...snap("a", 0),
      contextStart: 2,
      contextNote: "只聊行程",
      messages: [
        {
          id: "u1",
          role: "user",
          text: "看看这份",
          at: "2026-10-26T00:00:00Z",
          status: "complete",
          attachments: [
            { name: "行程.pdf", text: "附件里的正文", format: "pdf", pages: 2 },
          ],
        },
        {
          id: "r1",
          role: "assistant",
          text: "看过了",
          at: "2026-10-26T00:00:01Z",
          status: "complete",
        },
        {
          id: "u2",
          role: "user",
          text: "下一步呢",
          at: "2026-10-26T00:01:00Z",
          status: "complete",
        },
        {
          id: "r2",
          role: "assistant",
          text: "先订票",
          at: "2026-10-26T00:01:01Z",
          status: "complete",
        },
      ],
    });
    render(<HertaChat onSettings={vi.fn()} />);
    await screen.findByText("先订票");
    typeDraft("/daochu");
    expect(slashOption("导出")).toHaveTextContent("附件只列名称，不含记忆");
    fireEvent.keyDown(draftBox(), { key: "Enter" });
    expect(await screen.findByText("已导出")).toHaveAttribute("role", "status");
    expect(save).toHaveBeenCalledTimes(1);
    const [name, markdown] = save.mock.calls[0]!;
    expect(name).toBe("话题A");
    expect(markdown.startsWith("# 话题A\n\n开始于 ")).toBe(true);
    expect(markdown).toContain("附件：行程.pdf（PDF · 2 页）\n\n看看这份");
    expect(markdown).not.toContain("附件里的正文");
    expect(markdown).toContain(
      "看过了\n\n---\n\n*黑塔从这里开始参考；更早的内容只保留在记录中*\n\n**续聊要点**\n\n只聊行程\n\n**你**",
    );
    expect(draftBox()).toHaveValue("");
    expect(mock.bridge.sendHertaChat).not.toHaveBeenCalled();
  });
});
it("a cancelled chat export says nothing; a failed or broken save says the record is untouched (R124)", async () => {
  const save = vi
    .fn()
    .mockResolvedValueOnce({ saved: false })
    .mockResolvedValueOnce({ saved: false, failed: true })
    .mockRejectedValueOnce(new Error("ipc"));
  await withExport(save, async () => {
    mock.bridge.getHertaChat.mockResolvedValue(sentWith([]));
    render(<HertaChat onSettings={vi.fn()} />);
    await screen.findByText("收到");
    const failure = "无法执行“导出”：导出没有完成，原记录未改动";
    const exportOnce = async (calls: number) => {
      typeDraft("/export");
      fireEvent.keyDown(draftBox(), { key: "Enter" });
      // A new run clears what the last one said.
      expect(screen.queryByText(failure)).toBeNull();
      await waitFor(() => expect(save).toHaveBeenCalledTimes(calls));
    };
    await exportOnce(1);
    await act(async () => {});
    expect(screen.queryByText(failure)).toBeNull();
    expect(screen.queryByText("已导出")).toBeNull();
    await exportOnce(2);
    expect(await screen.findByText(failure)).toHaveAttribute("role", "alert");
    await exportOnce(3);
    expect(await screen.findByText(failure)).toHaveAttribute("role", "alert");
  });
});
it("waits for the reply to finish before exporting a chat (R124)", async () => {
  const save = vi.fn(async () => ({ saved: true }));
  await withExport(save, async () => {
    mock.bridge.getHertaChat.mockResolvedValue({ ...sentWith([]), busy: true });
    render(<HertaChat onSettings={vi.fn()} />);
    await screen.findByText("收到");
    typeDraft("/export");
    expect(slashOption("导出")).toHaveTextContent("黑塔正在回复，结束后可用");
    fireEvent.keyDown(draftBox(), { key: "Enter" });
    expect(
      within(screen.getByRole("listbox", { name: "指令" })).getByRole("alert"),
    ).toHaveTextContent("无法执行“导出”：黑塔正在回复，结束后可用");
    expect(draftBox()).toHaveValue("/export");
    expect(save).not.toHaveBeenCalled();
  });
});
it("has nothing to export in a chat without messages (R124)", async () => {
  const save = vi.fn(async () => ({ saved: true }));
  await withExport(save, async () => {
    render(<HertaChat onSettings={vi.fn()} />);
    await chatModelReady("m · Text provider");
    typeDraft("/export");
    expect(slashOption("导出")).toHaveTextContent("这个聊天还没有消息");
    fireEvent.keyDown(draftBox(), { key: "Enter" });
    expect(save).not.toHaveBeenCalled();
  });
});
it("opens one feedback panel from / and from 快捷操作: the chat's failure and settings by choice, never its messages (R125)", async () => {
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
  const save = vi.fn(async (_name: string, _markdown: string) => ({
    saved: true,
  }));
  const bridge = mock.bridge as Record<string, unknown>;
  bridge.promptPlugins = vi.fn(async () => ({
    ok: true,
    snapshot: { revision: 1, items: [] },
  }));
  try {
    await withExport(save, async () => {
      mock.bridge.getHertaChat.mockResolvedValue({
        ...snap("a", 0),
        messages: [
          {
            id: "u1",
            role: "user",
            text: "私密的问题内容",
            at: "2026-10-26T00:00:00Z",
            status: "complete",
          },
          {
            id: "r1",
            role: "assistant",
            text: "",
            at: "2026-10-26T00:00:01Z",
            status: "failed",
            failure: "rate-limit",
          },
        ],
      });
      render(<HertaChat onSettings={vi.fn()} />);
      await screen.findByText("私密的问题内容");
      draftBox().focus();
      typeDraft("/fankui");
      expect(slashOption("反馈")).toHaveTextContent(
        "预览后存为本地 Markdown；不会发送",
      );
      fireEvent.keyDown(draftBox(), { key: "Enter" });
      const panel = await screen.findByRole("dialog", { name: "反馈" });
      expect(draftBox()).toHaveValue("");
      await within(panel).findByText(/^应用版本：/);
      const error = within(panel).getByRole("checkbox", { name: "错误提示" });
      expect(error).not.toBeChecked();
      expect(error).toHaveAccessibleDescription("服务限流，请稍后再发送。");
      expect(
        within(panel).getByRole("checkbox", { name: "最近一次失败" }),
      ).toHaveAccessibleDescription(
        /^代码：rate-limit\s+时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/,
      );
      const settings = within(panel).getByRole("checkbox", {
        name: "设置概要",
      });
      expect(settings).toHaveAccessibleDescription(/模型：m · Text provider/);
      expect(settings).toHaveAccessibleDescription(/续聊要点：无/);
      fireEvent.change(
        within(panel).getByRole("textbox", { name: /问题描述/ }),
        {
          target: { value: "回复一直限流" },
        },
      );
      fireEvent.click(error);
      fireEvent.click(settings);
      fireEvent.click(within(panel).getByRole("button", { name: "预览" }));
      const text = (
        within(panel).getByRole("textbox", {
          name: /预览/,
        }) as HTMLTextAreaElement
      ).value;
      expect(text).toContain(" · 黑塔聊天\n\n## 问题描述\n\n回复一直限流");
      expect(text).toContain("### 错误提示\n\n> 服务限流，请稍后再发送。");
      expect(text).toContain("### 设置概要\n\n- 模型：m · Text provider");
      expect(text).not.toContain("最近一次失败");
      expect(text).not.toContain("私密的问题内容");
      fireEvent.click(within(panel).getByRole("button", { name: "关闭反馈" }));
      expect(draftBox()).toHaveFocus();
      // The same panel from 快捷操作, still holding what was written.
      const quick = screen.getByRole("button", { name: "快捷操作" });
      fireEvent.click(quick);
      const common = await screen.findByRole("group", { name: "常用" });
      expect(
        within(common)
          .getAllByRole("button")
          .map((b) => b.firstChild?.textContent),
      ).toEqual(["附加文件", "选择模型", "导出", "反馈"]);
      fireEvent.click(within(common).getByRole("button", { name: /反馈/ }));
      expect(await screen.findByRole("dialog", { name: "反馈" })).toBe(panel);
      expect(
        within(panel).getByRole("textbox", { name: /问题描述/ }),
      ).toHaveValue("回复一直限流");
      fireEvent.click(within(panel).getByRole("button", { name: "预览" }));
      fireEvent.click(within(panel).getByRole("button", { name: "保存…" }));
      expect(await within(panel).findByText("已保存。")).toBeInTheDocument();
      expect(save).toHaveBeenCalledTimes(1);
      expect(save.mock.calls[0]![0]).toMatch(
        /^The Herta 反馈 \d{4}-\d{2}-\d{2}$/,
      );
      expect(save.mock.calls[0]![1]).not.toContain("私密的问题内容");
      fireEvent.click(within(panel).getByRole("button", { name: "完成" }));
      expect(quick).toHaveFocus();
      expect(mock.bridge.sendHertaChat).not.toHaveBeenCalled();
    });
  } finally {
    delete bridge.promptPlugins;
    Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
  }
});
it("lists no feedback in a chat that cannot save (R125)", async () => {
  mock.bridge.getHertaChat.mockResolvedValue(sentWith([]));
  render(<HertaChat onSettings={vi.fn()} />);
  await screen.findByText("收到");
  typeDraft("/");
  const menu = screen.getByRole("listbox", { name: "指令" });
  expect(within(menu).getByText("选择模型")).toBeInTheDocument();
  expect(within(menu).queryByText("反馈")).toBeNull();
  expect(screen.queryByRole("dialog", { name: "反馈" })).toBeNull();
});
