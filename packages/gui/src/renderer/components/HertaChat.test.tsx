import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({
  bridge: {
    parseChatFile: vi.fn(),
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
beforeEach(() => {
  vi.clearAllMocks();
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
it("offers text-only validated models, sends selected input and clears accepted draft", async () => {
  render(<HertaChat onSettings={vi.fn()} />);
  await screen.findByRole("option", { name: "Text provider · m" });
  expect(
    screen.queryByRole("option", { name: /stale/ }),
  ).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole("textbox", { name: "给黑塔的消息" }), {
    target: { value: "今天聊什么" },
  });
  fireEvent.click(screen.getByRole("button", { name: "发送 ↑" }));
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
it("keeps draft on rejection and does not send an IME confirmation", async () => {
  mock.bridge.sendHertaChat.mockRejectedValue(new Error("preflight"));
  render(<HertaChat onSettings={vi.fn()} />);
  await screen.findByRole("option", { name: "Text provider · m" });
  const textbox = screen.getByRole("textbox", { name: "给黑塔的消息" });
  fireEvent.change(textbox, { target: { value: "中文草稿" } });
  fireEvent.keyDown(textbox, {
    key: "Enter",
    ctrlKey: true,
    isComposing: true,
    keyCode: 229,
  });
  expect(mock.bridge.sendHertaChat).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "发送 ↑" }));
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
  fireEvent.click(screen.getByRole("button", { name: "＋ 新聊天" }));
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
  fireEvent.click(screen.getByRole("button", { name: "重命名" }));
  fireEvent.change(screen.getByRole("textbox", { name: "聊天名称" }), {
    target: { value: "新的标题" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await screen.findByRole("button", { name: "新的标题" });
  fireEvent.click(screen.getByRole("button", { name: "移到回收区" }));
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
    }),
  );
  expect(mock.bridge.sendHertaChat).not.toHaveBeenCalled();
});

it("preserves draft and budget across peer tab switches and refreshes models after settings", async () => {
  const props = { onSettings: vi.fn() };
  const view = render(<HertaChat {...props} visible />);
  await screen.findByRole("option", { name: "Text provider · m" });
  fireEvent.change(screen.getByRole("textbox", { name: "给黑塔的消息" }), {
    target: { value: "留在这里" },
  });
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
  const select = await screen.findByRole("combobox", { name: "聊天思考强度" });
  fireEvent.change(select, { target: { value: "none" } });
  view.rerender(<HertaChat {...props} visible={false} />);
  view.rerender(<HertaChat {...props} visible />);
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "聊天思考强度" })).toHaveValue(
      "none",
    ),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "给黑塔的消息" }), {
    target: { value: "你好" },
  });
  fireEvent.click(screen.getByRole("button", { name: "发送 ↑" }));
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
 await screen.findByRole("option",{name:"Text provider · m"});
 fireEvent.change(screen.getByLabelText("附加文件"),{target:{files:[{name:"report.pdf",size:10,arrayBuffer:async()=>new ArrayBuffer(10)}]}});
 await screen.findByText("Extracted text");
 expect(screen.getByText(/report.pdf · 2页/)).toBeInTheDocument();
 fireEvent.change(screen.getByRole("textbox",{name:"给黑塔的消息"}),{target:{value:"总结附件"}});
 fireEvent.click(screen.getByRole("button",{name:"发送 ↑"}));
 await waitFor(()=>expect(mock.bridge.sendHertaChat).toHaveBeenCalledWith(expect.objectContaining({attachments:[{name:"report.pdf",text:"Extracted text",format:"pdf",pages:2}]})));
});
it("blocks sending while parsing and keeps draft when a document is rejected",async()=>{
 let finish!: (value:unknown)=>void;
 mock.bridge.parseChatFile.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 render(<HertaChat onSettings={vi.fn()} />);
 await screen.findByRole("option",{name:"Text provider · m"});
 fireEvent.change(screen.getByRole("textbox",{name:"给黑塔的消息"}),{target:{value:"保留草稿"}});
 fireEvent.change(screen.getByLabelText("附加文件"),{target:{files:[{name:"scan.pdf",size:10,arrayBuffer:async()=>new ArrayBuffer(10)}]}});
 await waitFor(()=>expect(mock.bridge.parseChatFile).toHaveBeenCalled());
 expect(screen.getByRole("button",{name:"发送 ↑"})).toBeDisabled();
 finish({ok:false,message:"文档没有可读取的文字。"});
 await screen.findByText("文档没有可读取的文字。");
 expect(screen.getByRole("textbox",{name:"给黑塔的消息"})).toHaveValue("保留草稿");
 expect(mock.bridge.sendHertaChat).not.toHaveBeenCalled();
});

it("previews image attachments and explains incompatible models",async()=>{
 const image={mimeType:"image/png",data:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="};
 mock.bridge.parseChatFile.mockResolvedValue({ok:true,attachment:{name:"x.png",text:"",image}});
 render(<HertaChat onSettings={vi.fn()} />);
 await screen.findByRole("option",{name:"Text provider · m"});
 fireEvent.change(screen.getByLabelText("附加文件"),{target:{files:[{name:"x.png",size:68,arrayBuffer:async()=>new ArrayBuffer(68)}]}});
 expect(await screen.findByAltText("x.png")).toHaveAttribute("src",`data:image/png;base64,${image.data}`);
 expect(screen.getByText(/当前模型尚未适配图片阅读/)).toBeInTheDocument();
});
it("keeps chat controls available while a storage-only refresh is pending",async()=>{
 mock.bridge.manageHertaChat.mockImplementation(action=>action.type==="storage"?new Promise(()=>{}):mock.bridge.getHertaChat());
 const view=render(<HertaChat onSettings={vi.fn()}/>);
 await screen.findByRole("option",{name:"Text provider · m"});
 fireEvent.click(screen.getByRole("button",{name:"存储空间"}));
 await waitFor(()=>expect(mock.bridge.manageHertaChat).toHaveBeenCalledWith({type:"storage"}));
 expect(screen.getByRole("button",{name:"＋ 新聊天"})).not.toBeDisabled();
 expect(screen.getByRole("textbox",{name:"给黑塔的消息"})).not.toBeDisabled();
 view.unmount();
});

it("keeps an existing chat error when storage refresh fails, then allows retry", async () => {
 mock.bridge.parseChatFile.mockResolvedValue({ok:false,message:"文档没有可读取的文字。"});
 mock.bridge.manageHertaChat.mockImplementation(action => action.type === "storage" ? Promise.reject(new Error("private storage path")) : mock.bridge.getHertaChat());
 render(<HertaChat onSettings={vi.fn()}/>);
 await screen.findByRole("option",{name:"Text provider · m"});
 fireEvent.change(screen.getByLabelText("附加文件"),{target:{files:[{name:"scan.pdf",size:10,arrayBuffer:async()=>new ArrayBuffer(10)}]}});
 await screen.findByText("文档没有可读取的文字。");
 fireEvent.click(screen.getByRole("button",{name:"存储空间"}));
 await screen.findByText("暂时无法读取用量，请稍后刷新。");
 expect(screen.getByText("文档没有可读取的文字。")).toBeInTheDocument();
 expect(screen.queryByText(/private storage path/)).not.toBeInTheDocument();
 mock.bridge.manageHertaChat.mockImplementation(()=>mock.bridge.getHertaChat());
 fireEvent.click(screen.getByRole("button",{name:"刷新用量"}));
 await waitFor(()=>expect(screen.queryByText("暂时无法读取用量，请稍后刷新。")).not.toBeInTheDocument());
 expect(screen.getByText("文档没有可读取的文字。")).toBeInTheDocument();
});
it("does not issue another refresh when reopening storage while pending", async () => {
 let finish!: (value: unknown) => void;
 mock.bridge.manageHertaChat.mockImplementation(action => action.type === "storage" ? new Promise(resolve=>{finish=resolve;}) : mock.bridge.getHertaChat());
 render(<HertaChat onSettings={vi.fn()}/>);
 await screen.findByRole("option",{name:"Text provider · m"});
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
 await screen.findByRole("option",{name:"Text provider · m"});
 const file=(name:string)=>({name,size:10,arrayBuffer:async()=>new ArrayBuffer(10)});
 fireEvent.change(screen.getByLabelText("附加文件"),{target:{files:[file("old.pdf"),file("unused.pdf")]}});
 await waitFor(()=>expect(finishes).toHaveLength(1));
 fireEvent.click(screen.getByRole("button",{name:"话题B"}));
 await waitFor(()=>expect(screen.getByLabelText("附加文件")).not.toBeDisabled());
 fireEvent.change(screen.getByRole("textbox",{name:"给黑塔的消息"}),{target:{value:"新话题"}});
 expect(screen.getByRole("button",{name:"发送 ↑"})).not.toBeDisabled();
 fireEvent.change(screen.getByLabelText("附加文件"),{target:{files:[file("new.pdf")]}});
 await waitFor(()=>expect(finishes).toHaveLength(2));
 await act(async()=>finishes[0]!({ok:true,attachment:{name:"old.pdf",text:"旧聊天附件",format:"pdf"}}));
 expect(screen.getByLabelText("附加文件")).toBeDisabled();
 expect(screen.getByRole("button",{name:"发送 ↑"})).toBeDisabled();
 expect(screen.queryByText("旧聊天附件")).not.toBeInTheDocument();
 expect(mock.bridge.parseChatFile).toHaveBeenCalledTimes(2);
 await act(async()=>finishes[1]!({ok:true,attachment:{name:"new.pdf",text:"新聊天附件",format:"pdf"}}));
 expect(await screen.findByText("新聊天附件")).toBeInTheDocument();
 expect(screen.getByRole("button",{name:"发送 ↑"})).not.toBeDisabled();
});

it.each([
 "续聊图片较多，请减少续聊范围或新建聊天；原图仍保留。",
 "续聊中有缺失或损坏的图片，请恢复图片目录，或调整续聊范围后重新上传。",
 "当前模型尚未适配图片阅读。请选择已验证的视觉模型，或移除附件、调整续聊范围中的图片。",
 "当前连接或模型尚不支持联网搜索。",
 "请重新上传图片文件。",
])("shows a safe actionable send rejection and preserves draft: %s", async message => {
 mock.bridge.sendHertaChat.mockRejectedValue(new Error("IPC: " + message + " private-diagnostic"));
 render(<HertaChat onSettings={vi.fn()}/>);
 await screen.findByRole("option",{name:"Text provider · m"});
 const box=screen.getByRole("textbox",{name:"给黑塔的消息"});
 fireEvent.change(box,{target:{value:"保留这段问题"}});
 fireEvent.click(screen.getByRole("button",{name:"发送 ↑"}));
 expect(await screen.findByRole("alert")).toHaveTextContent(message);
 expect(screen.queryByText(/private-diagnostic/)).not.toBeInTheDocument();
 expect(box).toHaveValue("保留这段问题");
 expect(mock.bridge.sendHertaChat).toHaveBeenCalledTimes(1);
});
