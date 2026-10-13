import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  stream: vi.fn(),
  release: vi.fn(),
  failCommit: false,
}));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  const renameSync = (...args: Parameters<typeof fs.renameSync>) => {
    if (mocks.failCommit) throw new Error("disk unavailable");
    return fs.renameSync(...args);
  };
  return { ...fs, renameSync, default: { ...fs, renameSync } };
});
vi.mock("./provider-settings.js", () => ({
  acquireChatProvider: mocks.acquire,
  getProviderSettings: () => ({
    settings: {
      defaultBindings: { persona: { providerId: "p", modelId: "m" } },
    },
  }),
}));
vi.mock("@herta/providers", () => ({
  createProtocolAdapter: () => ({ stream: mocks.stream }),
  reasoningChoices: () => ["low", "high"],
}));
vi.mock("@herta/app-server", () => ({
  desktopPersonaIdentity: () => "Herta persona",
}));
import { createHertaChat } from "./herta-chat.js";
let path: string;
const input = { text: "你好", providerId: "p", modelId: "m" };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.failCommit = false;
  path = join(mkdtempSync(join(tmpdir(), "herta-chat-")), "chat.json");
  mocks.acquire.mockReturnValue({
    config: {},
    key: "test-private",
    release: mocks.release,
  });
  mocks.stream.mockImplementation(async function* () {
    yield { type: "text-delta", text: "有什么有趣的问题？" };
    yield { type: "finished", reason: "stop" };
  });
});
it("sends text-only without executor/tools, persists replies and reopens without a request", async () => {
  const chat = createHertaChat(path);
  expect(chat.send({ ...input, chatId: chat.snapshot().activeId! })).toEqual({
    accepted: true,
  });
  await vi.waitFor(() => expect(chat.snapshot().busy).toBe(false));
  const request = mocks.stream.mock.calls[0]![0];
  expect(request.tools).toEqual([]);
  expect(request.system).toContain("独立闲聊");
  expect(request.messages).toEqual([{ role: "user", text: "你好" }]);
  expect(chat.snapshot().messages[1]?.status).toBe("complete");
  const disk = readFileSync(path, "utf8");
  expect(disk).not.toContain("test-private");
  expect(createHertaChat(path).snapshot().messages).toEqual(
    chat.snapshot().messages,
  );
  expect(mocks.stream).toHaveBeenCalledTimes(1);
  expect(mocks.release).toHaveBeenCalledTimes(1);
  await chat.dispose();
});
it.each([
  "tool",
  "length",
  "disconnect",
])("preserves partial output and refuses false completion: %s", async (kind) => {
  mocks.stream.mockImplementation(async function* () {
    yield { type: "text-delta", text: "partial" };
    if (kind === "tool")
      yield { type: "tool-call-ready", call: { name: "run_command" } };
    if (kind === "length") yield { type: "finished", reason: "length" };
  });
  const chat = createHertaChat(path);
  chat.send({ ...input, chatId: chat.snapshot().activeId! });
  await vi.waitFor(() => expect(chat.snapshot().busy).toBe(false));
  expect(chat.snapshot().messages[1]).toMatchObject({
    text: "partial",
    status: "failed",
  });
  expect(chat.snapshot().error).toBeTruthy();
  expect(mocks.release).toHaveBeenCalledTimes(1);
});
it("preflight validation failure saves nothing and starts no request", () => {
  mocks.acquire.mockImplementationOnce(() => {
    throw new Error("stale validation");
  });
  const chat = createHertaChat(path);
  expect(() =>
    chat.send({ ...input, chatId: chat.snapshot().activeId! }),
  ).toThrow();
  expect(chat.snapshot().messages).toEqual([]);
  expect(mocks.stream).not.toHaveBeenCalled();
});
it("stops an active reply and refuses duplicate sends", async () => {
  mocks.stream.mockImplementation(async function* (request) {
    yield { type: "text-delta", text: "partial" };
    await new Promise<void>((resolve) =>
      request.signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  });
  const chat = createHertaChat(path);
  chat.send({ ...input, chatId: chat.snapshot().activeId! });
  await vi.waitFor(() =>
    expect(chat.snapshot().messages[1]?.text).toBe("partial"),
  );
  expect(() =>
    chat.send({ ...input, chatId: chat.snapshot().activeId! }),
  ).toThrow();
  chat.stop();
  await chat.dispose();
  expect(chat.snapshot().messages[1]?.status).toBe("cancelled");
  expect(chat.snapshot().busy).toBe(false);
  expect(mocks.release).toHaveBeenCalledTimes(1);
});
it("marks interrupted persisted streams without replay and protects malformed history", () => {
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: 1,
      messages: [
        {
          id: "a",
          role: "assistant",
          text: "partial",
          at: "now",
          status: "streaming",
        },
      ],
    }),
  );
  expect(createHertaChat(path).snapshot().messages[0]?.status).toBe(
    "interrupted",
  );
  writeFileSync(path, "broken original");
  expect(() => createHertaChat(path).snapshot()).toThrow();
  expect(readFileSync(path, "utf8")).toBe("broken original");
  expect(mocks.stream).not.toHaveBeenCalled();
});

it("migrates v1 exactly once with an intact backup and never requests the provider", () => {
  const original = JSON.stringify({
    schemaVersion: 1,
    messages: [
      {
        id: "old",
        role: "user",
        text: "旧聊天正文",
        at: "then",
        status: "complete",
      },
    ],
  });
  writeFileSync(path, original);
  const chat = createHertaChat(path),
    snapshot = chat.snapshot();
  expect(snapshot.chats[0]?.title).toBe("以前的聊天");
  expect(snapshot.messages[0]?.text).toBe("旧聊天正文");
  const backups = readdirSync(join(path, "..")).filter((p) =>
    p.includes("v1-backup"),
  );
  expect(backups).toHaveLength(1);
  expect(readFileSync(join(path, "..", backups[0]!), "utf8")).toBe(original);
  expect(JSON.parse(readFileSync(path, "utf8")).schemaVersion).toBe(3);
  expect(createHertaChat(path).snapshot().activeId).toBe(snapshot.activeId);
  expect(
    readdirSync(join(path, "..")).filter((p) => p.includes("v1-backup")),
  ).toHaveLength(1);
  expect(mocks.stream).not.toHaveBeenCalled();
});
it("failed migration leaves v1 intact and retry preserves all messages", () => {
  const original = JSON.stringify({
    schemaVersion: 1,
    messages: [
      { id: "old", role: "user", text: "keep", at: "then", status: "complete" },
    ],
  });
  writeFileSync(path, original);
  const chat = createHertaChat(path);
  mocks.failCommit = true;
  expect(() => chat.snapshot()).toThrow();
  expect(readFileSync(path, "utf8")).toBe(original);
  mocks.failCommit = false;
  expect(chat.snapshot().messages[0]?.text).toBe("keep");
});
it("creates, renames, pins, archives and restores separate chats across restart", async () => {
  const chat = createHertaChat(path),
    first = chat.snapshot().activeId!;
  chat.send({ ...input, chatId: first });
  await vi.waitFor(() => expect(chat.snapshot().busy).toBe(false));
  const second = chat.manage({ type: "create" }).activeId!;
  expect(chat.snapshot().messages).toHaveLength(0);
  chat.manage({ type: "rename", id: second, title: "研究记录" });
  chat.manage({ type: "pin", id: second, pinned: true });
  chat.manage({ type: "archive", id: first });
  expect(chat.snapshot().chats.find((c) => c.id === first)?.archived).toBe(
    true,
  );
  expect(chat.manage({ type: "restore", id: first }).messages).toHaveLength(2);
  const reopened = createHertaChat(path).snapshot();
  expect(reopened.activeId).toBe(first);
  expect(reopened.chats.find((c) => c.id === second)).toMatchObject({
    title: "研究记录",
    pinned: true,
  });
  expect(mocks.stream).toHaveBeenCalledTimes(1);
});
it("rejects sends targeting stale selection and never leaks other chat history", async () => {
  const chat = createHertaChat(path),
    first = chat.snapshot().activeId!;
  chat.send({ ...input, chatId: first, text: "private first topic" });
  await vi.waitFor(() => expect(chat.snapshot().busy).toBe(false));
  const second = chat.manage({ type: "create" }).activeId!;
  expect(() => chat.send({ ...input, chatId: first })).toThrow();
  chat.send({ ...input, chatId: second, text: "second topic" });
  await vi.waitFor(() => expect(chat.snapshot().busy).toBe(false));
  expect(mocks.stream.mock.calls[1]![0].messages).toEqual([
    { role: "user", text: "second topic" },
  ]);
});
it("failed management and send persistence roll back in-memory and disk state", () => {
  const chat = createHertaChat(path),
    before = chat.snapshot(),
    disk = readFileSync(path, "utf8");
  mocks.failCommit = true;
  expect(() => chat.manage({ type: "create" })).toThrow();
  expect(() =>
    chat.manage({ type: "archive", id: before.activeId! }),
  ).toThrow();
  expect(() => chat.send({ ...input, chatId: before.activeId! })).toThrow();
  expect(chat.snapshot()).toEqual(before);
  expect(readFileSync(path, "utf8")).toBe(disk);
  expect(mocks.stream).not.toHaveBeenCalled();
  expect(mocks.release).toHaveBeenCalledTimes(1);
});
it("blocks management during a stream, then permits archive/restore without replay", async () => {
  mocks.stream.mockImplementation(async function* (r) {
    yield { type: "text-delta", text: "partial" };
    await new Promise<void>((resolve) =>
      r.signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  });
  const chat = createHertaChat(path),
    id = chat.snapshot().activeId!;
  chat.send({ ...input, chatId: id });
  await vi.waitFor(() =>
    expect(chat.snapshot().messages[1]?.text).toBe("partial"),
  );
  expect(() => chat.manage({ type: "create" })).toThrow();
  expect(() => chat.manage({ type: "archive", id })).toThrow();
  chat.stop();
  await chat.dispose();
  expect(chat.manage({ type: "archive", id }).activeId).toBeNull();
  expect(chat.manage({ type: "restore", id }).messages[1]?.status).toBe(
    "cancelled",
  );
  expect(mocks.stream).toHaveBeenCalledTimes(1);
});
it("context changes retain all original messages but send only selected turns and user notes", async () => {
  const old = Array.from({ length: 8 }, (_, i) => [
    {
      id: `u${i}`,
      role: "user",
      text: `question${i}`,
      at: "then",
      status: "complete",
    },
    {
      id: `a${i}`,
      role: "assistant",
      text: `answer${i}`,
      at: "then",
      status: "complete",
    },
  ]).flat();
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, messages: old }));
  const chat = createHertaChat(path),
    id = chat.snapshot().activeId!;
  const adjusted = chat.manage({
    type: "context",
    id,
    keepTurns: 3,
    note: "请记得我是开拓者",
  });
  expect(adjusted.contextStart).toBe(10);
  expect(adjusted.messages).toHaveLength(16);
  chat.send({ ...input, chatId: id });
  await vi.waitFor(() => expect(chat.snapshot().busy).toBe(false));
  const request = mocks.stream.mock.calls[0]![0];
  expect(request.messages[0].role).toBe("user");
  expect(request.messages[0].text).toContain("请记得");
  expect(request.messages[1].text).toBe("question5");
  expect(JSON.stringify(request.messages)).not.toContain("question0");
  expect(chat.snapshot().messages[0]?.text).toBe("question0");
  expect(createHertaChat(path).snapshot().contextStart).toBe(10);
  expect(
    chat.manage({ type: "context", id, keepTurns: -1, note: "" }).contextStart,
  ).toBe(0);
});
it("explicit context reset enables a full chat to continue without deleting its history", async () => {
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: 1,
      messages: [
        {
          id: "long",
          role: "user",
          text: "x".repeat(160001),
          at: "then",
          status: "complete",
        },
      ],
    }),
  );
  const chat = createHertaChat(path),
    id = chat.snapshot().activeId!;
  expect(() => chat.send({ ...input, chatId: id })).toThrow(/续聊/);
  expect(() =>
    chat.manage({ type: "context", id, keepTurns: 3, note: "" }),
  ).toThrow(/过长/);
  chat.manage({ type: "context", id, keepTurns: 0, note: "new start" });
  chat.send({ ...input, chatId: id });
  await vi.waitFor(() => expect(chat.snapshot().busy).toBe(false));
  expect(chat.snapshot().messages[0]?.text.length).toBe(160001);
  expect(mocks.stream.mock.calls[0]![0].messages).toHaveLength(2);
});
it("rejects invalid context ranges, malformed v2 and unknown actions without saving", () => {
  const chat = createHertaChat(path),
    id = chat.snapshot().activeId!,
    original = readFileSync(path, "utf8");
  expect(() =>
    chat.manage({ type: "context", id, keepTurns: 999, note: "" }),
  ).toThrow();
  expect(() => chat.manage({ type: "rename", id, title: "\n" })).toThrow();
  expect(readFileSync(path, "utf8")).toBe(original);
  const data = JSON.parse(original);
  data.chats[0].contextStart = 2;
  writeFileSync(path, JSON.stringify(data));
  expect(() => createHertaChat(path).snapshot()).toThrow();
});

it.each([
  "length",
  "stall",
  "authentication",
  "empty-response",
  "disconnect",
])("records safe failure reason across reload without replay: %s", async (kind) => {
  mocks.stream.mockImplementation(async function* () {
    if (kind === "length") {
      yield { type: "finished", reason: "length" };
      return;
    }
    if (kind === "empty-response") {
      yield { type: "finished", reason: "stop" };
      return;
    }
    if (kind === "disconnect") return;
    throw Object.assign(new Error("remote-private-body"), { code: kind });
  });
  const chat = createHertaChat(path);
  chat.send({ ...input, chatId: chat.snapshot().activeId! });
  await vi.waitFor(() => expect(chat.snapshot().busy).toBe(false));
  const failure =
    kind === "stall"
      ? "timeout"
      : kind === "disconnect"
        ? "stream-interrupted"
        : kind;
  expect(chat.snapshot().messages[1]).toMatchObject({
    text: "",
    status: "failed",
    failure,
  });
  expect(createHertaChat(path).snapshot().messages[1]?.failure).toBe(failure);
  expect(readFileSync(path, "utf8")).not.toContain("remote-private-body");
  expect(mocks.stream).toHaveBeenCalledTimes(1);
  expect(mocks.stream.mock.calls[0]![0].options.maxOutputTokens).toBe(16384);
});
it("validates output budgets before acquisition and forwards an explicit supported budget", async () => {
  const chat = createHertaChat(path);
  expect(() =>
    chat.send({
      ...input,
      chatId: chat.snapshot().activeId!,
      maxOutputTokens: 999999,
    }),
  ).toThrow();
  expect(mocks.acquire).not.toHaveBeenCalled();
  expect(chat.snapshot().messages).toHaveLength(0);
  chat.send({
    ...input,
    chatId: chat.snapshot().activeId!,
    maxOutputTokens: 32768,
  });
  await vi.waitFor(() => expect(chat.snapshot().busy).toBe(false));
  expect(mocks.stream.mock.calls[0]![0].options.maxOutputTokens).toBe(32768);
});

it("rejects unsupported effort without messages and releases lease; forwards supported effort", async () => {
  const chat = createHertaChat(path);
  expect(() =>
    chat.send({
      ...input,
      chatId: chat.snapshot().activeId!,
      reasoningEffort: "unknown",
    }),
  ).toThrow();
  expect(chat.snapshot().messages).toHaveLength(0);
  expect(mocks.release).toHaveBeenCalledTimes(1);
  chat.send({
    ...input,
    chatId: chat.snapshot().activeId!,
    reasoningEffort: "low",
  });
  await vi.waitFor(() => expect(chat.snapshot().busy).toBe(false));
  expect(mocks.stream.mock.calls[0]![0].options.reasoningEffort).toBe("low");
});

it("bounds public reasoning, persists partial thought on failure and never resends it as conversation text", async () => {
  mocks.stream.mockImplementationOnce(async function* () {
    yield {
      type: "public-reasoning-delta",
      text: "r".repeat(40000),
      format: "text",
    };
    yield { type: "finished", reason: "length" };
  });
  const chat = createHertaChat(path);
  chat.send({ ...input, chatId: chat.snapshot().activeId! });
  await vi.waitFor(() => expect(chat.snapshot().busy).toBe(false));
  const saved = createHertaChat(path).snapshot().messages[1]!;
  expect(saved.reasoning).toHaveLength(32000);
  expect(saved.reasoningTruncated).toBe(true);
  expect(saved.text).toBe("");
  expect(saved.failure).toBe("length");
  chat.send({ ...input, chatId: chat.snapshot().activeId! });
  await vi.waitFor(() => expect(chat.snapshot().busy).toBe(false));
  expect(JSON.stringify(mocks.stream.mock.calls[1]![0].messages)).not.toContain(
    "rrrrr",
  );
});

it("recalls persisted memory, passes attachment data separately and keeps original timestamp after restart", async () => {
  const chat = createHertaChat(path);
  chat.manage({ type: "memory", operation: "save", text: "我喜欢简洁的回答" });
  chat.send({
    ...input,
    chatId: chat.snapshot().activeId!,
    attachments: [{ name: "notes.md", text: "# sample" }],
  });
  await vi.waitFor(() => expect(chat.snapshot().busy).toBe(false));
  const wire = JSON.stringify(mocks.stream.mock.calls[0]![0].messages);
  expect(wire).toContain("我喜欢简洁的回答");
  expect(wire).toContain("notes.md");
  const reopened = createHertaChat(path);
  expect(reopened.snapshot().messages[0]).toEqual(chat.snapshot().messages[0]);
  expect(reopened.snapshot().memory?.items).toHaveLength(1);
  await chat.dispose();
  await reopened.dispose();
});
it("runs an idle pass only after a completed chat and never dispatches tools", async () => {
  vi.useFakeTimers();
  const chat = createHertaChat(path, { idleMs: 10000 });
  try {
    const id = chat.snapshot().activeId!;
    chat.send({ ...input, text: "我喜欢紫色", chatId: id });
    await vi.advanceTimersByTimeAsync(1);
    const sourceId = chat.snapshot().messages[0]!.id;
    mocks.stream.mockImplementationOnce(async function* () {
      yield {
        type: "text-delta",
        text: JSON.stringify([
          { sourceMessageId: sourceId, quote: "我喜欢紫色" },
        ]),
      };
      yield { type: "finished", reason: "stop" };
    });
    await vi.advanceTimersByTimeAsync(20000);
    expect(chat.snapshot().memory?.items[0]?.text).toBe("我喜欢紫色");
    expect(mocks.stream.mock.calls[1]![0].tools).toEqual([]);
    await vi.advanceTimersByTimeAsync(1800000);
    expect(mocks.stream).toHaveBeenCalledTimes(2);
  } finally {
    await chat.dispose();
    vi.useRealTimers();
  }
});
it('enables only supported search, persists sources and keeps local tools absent', async () => {
  mocks.acquire.mockReturnValue({ config: { protocol: 'anthropic-messages', baseURL: 'https://api.deepseek.com/anthropic' }, key: 'synthetic', release: mocks.release });
  mocks.stream.mockImplementation(async function* () {
    yield { type: 'web-search', id: 's', status: 'searching', query: 'Python' };
    yield { type: 'web-search', id: 's', status: 'completed', sources: [{url:'https://www.python.org',title:'Python'}] };
    yield { type: 'text-delta', text: '回答' };
    yield { type: 'finished', reason: 'stop' };
  });
  const chat = createHertaChat(path);
  chat.send({...input, modelId:'deepseek-flash',chatId:chat.snapshot().activeId!,webSearch:true});
  await vi.waitFor(() => expect(chat.snapshot().busy).toBe(false));
  expect(mocks.stream.mock.calls[0]![0].options.webSearch).toBe(true);
  expect(mocks.stream.mock.calls[0]![0].tools).toEqual([]);
  const restored=createHertaChat(path);
  expect(restored.snapshot().messages[1]?.searches?.[0]).toMatchObject({status:'completed',query:'Python'});
  await restored.dispose();await chat.dispose();
});
it('rejects unsupported search before saving or requesting a message', async () => {
  const chat=createHertaChat(path);
  expect(() => chat.send({...input,chatId:chat.snapshot().activeId!,webSearch:true})).toThrow('尚不支持联网搜索');
  expect(mocks.stream).not.toHaveBeenCalled();expect(chat.snapshot().messages).toHaveLength(0);
  await chat.dispose();
});

it("preserves image history while keeping bytes out of prompt text, and rejects switching to text-only models", async()=>{
 const image={mimeType:"image/png" as const,data:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="};
 mocks.acquire.mockReturnValue({config:{protocol:"openai-responses",baseURL:"https://api.openai.com/v1"},key:"test-private",release:mocks.release});
 const chat=createHertaChat(path), chatId=chat.snapshot().activeId!;
 chat.send({...input,modelId:"gpt-4.1",chatId,attachments:[{name:"x.png",text:"",image}]});
 await vi.waitFor(()=>expect(chat.snapshot().busy).toBe(false));
 const sent=mocks.stream.mock.calls[0]![0].messages[0];
 expect(sent.images).toEqual([image]);expect(sent.text).not.toContain(image.data);
 expect(createHertaChat(path).snapshot().messages[0]?.attachments?.[0]?.image).toEqual(image);
 expect(()=>chat.send({...input,modelId:"deepseek-flash",chatId})).toThrow("图片阅读");
 expect(mocks.stream).toHaveBeenCalledTimes(1);
 chat.send({...input,modelId:"gpt-4.1",chatId});
 await vi.waitFor(()=>expect(chat.snapshot().busy).toBe(false));
 expect(mocks.stream.mock.calls[1]![0].messages[0].images).toEqual([image]);
 await chat.dispose();
});

it("backs up v2 before conversion, preserves missing-image history and blocks silent omission",async()=>{
 const image={mimeType:"image/png",data:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="};
 const legacy={schemaVersion:2,activeId:"c",chats:[{id:"c",title:"legacy",updatedAt:"now",pinned:false,archived:false,contextStart:0,contextNote:"",messages:[{id:"u",role:"user",text:"图片问题",at:"now",status:"complete",attachments:[{name:"x.png",text:"",image}]}]}]};
 const original=JSON.stringify(legacy);writeFileSync(path,original);
 const chat=createHertaChat(path);chat.manage({type:"rename",id:"c",title:"renamed"});
 const files=readdirSync(join(path,".."));const backup=files.find(n=>n.includes(".v2-backup-"))!;
 expect(readFileSync(join(path,"..",backup),"utf8")).toBe(original);
 expect(readFileSync(path,"utf8")).not.toContain(image.data);
 await chat.dispose();
 const blob=join(`${path}.images`,readdirSync(`${path}.images`)[0]!);writeFileSync(blob,"corrupt");
 const reopened=createHertaChat(path);
 expect(reopened.snapshot().messages[0]?.text).toBe("图片问题");
 expect(reopened.snapshot().messages[0]?.attachments?.[0]?.imageMissing).toBe(true);
 expect(()=>reopened.send({...input,chatId:"c"})).toThrow("缺失或损坏");
 expect(mocks.stream).not.toHaveBeenCalled();
 await reopened.dispose();
});
