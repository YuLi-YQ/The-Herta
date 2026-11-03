import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  stream: vi.fn(),
  release: vi.fn(),
  review: vi.fn(),
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
  recordImageRequestRefused: mocks.review,
}));
vi.mock("@herta/providers", () => ({
  createProtocolAdapter: () => ({ stream: mocks.stream }),
  reasoningChoices: () => ["low", "high"],
}));
vi.mock("@herta/app-server", () => ({
  desktopPersonaIdentity: () => "Herta persona",
}));
vi.mock("./chat-storage-scan.js", async () => {
 const { statSync } = await import("node:fs");
 const { createChatImageStore } = await import("./chat-image-store.js");
 return { createChatStorageScan: (path: string) => ({run: async () => ({ checkedAt: new Date().toISOString(), historyBytes: statSync(path).size, historyLimitBytes: 64*1024*1024, images: createChatImageStore(`${path}.images`).usage() }), dispose: () => {} }) };
});
import { createHertaChat } from "./herta-chat.js";
import { chatFailures } from "../shared/herta-chat.js";
it("plugin identity is narrow and does not reuse an epoch after switching away and back", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "herta-plugin-identity-")), "chat.json");
  const chat = createHertaChat(file);
  try {
    const first = chat.pluginIdentity();
    expect(Object.keys(first).sort()).toEqual(["busy", "disposed", "id", "revision"]);
    chat.snapshot(); chat.noteUserActivity();
    expect(chat.pluginIdentity()).toEqual(first);
    chat.manage({ type: "create" });
    expect(chat.pluginIdentity().id).not.toBe(first.id);
    chat.manage({ type: "select", id: first.id! });
    expect(chat.pluginIdentity().id).toBe(first.id);
    expect(chat.pluginIdentity().revision).toBeGreaterThan(first.revision);
  } finally { await chat.dispose(); }
  expect(chat.pluginIdentity()).toMatchObject({ id: null, disposed: true });
});
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
  // The content itself, not only the name (R77).
  expect(wire).toContain("# sample");
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
 const reopened=createHertaChat(path), view=reopened.snapshot();
 expect(view.messages[0]?.attachments?.[0]?.imageDeferred).toBe(true);
 expect(JSON.stringify(view)).not.toContain(image.data);
 expect(reopened.readImage(chatId,view.messages[0]!.id,0)).toEqual(image);
 expect(()=>reopened.readImage("other",view.messages[0]!.id,0)).toThrow();
 expect(()=>reopened.readImage(chatId,view.messages[0]!.id,-1)).toThrow();
 await reopened.dispose();
 expect(()=>chat.send({...input,modelId:"deepseek-flash",chatId})).toThrow("识图检测");
 expect(mocks.stream).toHaveBeenCalledTimes(1);
 chat.send({...input,modelId:"gpt-4.1",chatId});
 await vi.waitFor(()=>expect(chat.snapshot().busy).toBe(false));
 expect(mocks.stream.mock.calls[1]![0].messages[0].images).toEqual([image]);
 await chat.dispose();
});

it("sends pictures to a probe-verified model on a custom endpoint and refuses an unverified one first (R77)", async()=>{
 const image={mimeType:"image/png" as const,data:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="};
 const config=(images:"unknown"|"supported")=>({protocol:"openai-chat-completions",baseURL:"https://proxy.example/v1",models:[{id:"vision-x",source:"manual",capabilities:{streaming:"supported",tools:"unknown",images,reasoning:"unknown"},validation:{state:"text-available",protocol:"openai-chat-completions",providerRevision:1}}]});
 mocks.acquire.mockReturnValue({config:config("unknown"),key:"test-private",release:mocks.release});
 const chat=createHertaChat(path), chatId=chat.snapshot().activeId!;
 // Text validation alone does not admit pictures: refused before anything is saved or sent.
 expect(()=>chat.send({...input,modelId:"vision-x",chatId,attachments:[{name:"x.png",text:"",image}]})).toThrow("识图检测");
 expect(mocks.stream).not.toHaveBeenCalled();expect(chat.snapshot().messages).toHaveLength(0);
 mocks.acquire.mockReturnValue({config:config("supported"),key:"test-private",release:mocks.release});
 chat.send({...input,modelId:"vision-x",chatId,attachments:[{name:"x.png",text:"",image}]});
 await vi.waitFor(()=>expect(chat.snapshot().busy).toBe(false));
 const sent=mocks.stream.mock.calls[0]![0].messages.find((m:{images?:unknown[]})=>m.images?.length);
 expect(sent.images).toEqual([image]);expect(sent.text).not.toContain(image.data);
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
 expect(reopened.snapshot().messages[0]?.attachments?.[0]?.imageDeferred).toBe(true);
 expect(()=>reopened.readImage("c","u",0)).toThrow("缺失或损坏");
 expect(()=>reopened.send({...input,chatId:"c"})).toThrow("缺失或损坏");
 expect(mocks.stream).not.toHaveBeenCalled();
 reopened.manage({type:"context",id:"c",keepTurns:0,note:""});
 reopened.send({...input,chatId:"c"});
 await vi.waitFor(()=>expect(reopened.snapshot().busy).toBe(false));
 expect(mocks.stream).toHaveBeenCalledTimes(1);
 expect(mocks.stream.mock.calls[0]![0].messages).toEqual([{role:"user",text:input.text}]);
 await reopened.dispose();
});
it("storage inspection preserves chat bytes and performs no model request",async()=>{
 const chat=createHertaChat(path); chat.snapshot();
 const before=readFileSync(path);
 const view=await chat.inspectStorage();
 expect(view.storage).toMatchObject({historyBytes:before.length,historyLimitBytes:64*1024*1024,images:{bytes:0,files:0,limitBytes:256*1024*1024}});
 expect(readFileSync(path).equals(before)).toBe(true);
 expect(mocks.acquire).not.toHaveBeenCalled();
 expect(chat.snapshot().storage).toEqual(view.storage);
 await chat.dispose();
});
// R51 found a folder in the library failing the whole read, which also hid the quarantine list.
it("still reads usage and lists quarantined batches when the image library holds a folder",async()=>{
 const { mkdirSync } = await import("node:fs");
 const chat=createHertaChat(path); chat.snapshot();
 mkdirSync(join(`${path}.images`,"a".repeat(64)),{recursive:true});
 mkdirSync(join(`${path}.images-quarantine`,"20261021T000000-0a1b2c3d"),{recursive:true});
 const view=await chat.inspectStorage();
 expect(view.storage?.images).toMatchObject({bytes:0,files:0,others:1});
 expect(view.storage?.quarantine?.map(b=>b.id)).toEqual(["20261021T000000-0a1b2c3d"]);
 await chat.dispose();
});
it("reports an image library location that is not a plain folder and still lists quarantined batches",async()=>{
 const { mkdirSync } = await import("node:fs");
 const chat=createHertaChat(path); chat.snapshot();
 writeFileSync(`${path}.images`,"not a folder");
 mkdirSync(join(`${path}.images-quarantine`,"20261021T000000-0a1b2c3d"),{recursive:true});
 const view=await chat.inspectStorage();
 expect(view.storage?.images).toMatchObject({bytes:0,files:0,invalid:true});
 expect(view.storage?.quarantine?.map(b=>b.id)).toEqual(["20261021T000000-0a1b2c3d"]);
 expect(readFileSync(`${path}.images`,"utf8")).toBe("not a folder");
 await chat.dispose();
});
it("cleans unreferenced images through preview, quarantine and restore, never while a reply runs", async () => {
  const { createHash } = await import("node:crypto");
  const chat = createHertaChat(path);
  chat.snapshot();
  const bytes = Buffer.from("loose-image"), name = createHash("sha256").update(bytes).digest("hex");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(`${path}.images`, { recursive: true });
  writeFileSync(join(`${path}.images`, name), bytes);
  const preview = chat.manage({ type: "image-preview" }).imageCleanup?.preview;
  expect(preview).toMatchObject({ files: 1, bytes: bytes.length });
  let release!: () => void;
  mocks.stream.mockImplementationOnce(async function* () {
    await new Promise<void>((done) => { release = done; });
    yield { type: "text-delta", text: "好" };
    yield { type: "finished", reason: "stop" };
  });
  chat.send({ ...input, chatId: chat.snapshot().activeId! });
  await vi.waitFor(() => expect(chat.snapshot().busy).toBe(true));
  expect(() => chat.manage({ type: "image-isolate", token: preview!.token })).toThrow("请等待回复结束");
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  release();
  await vi.waitFor(() => expect(chat.snapshot().busy).toBe(false));
  const isolated = chat.manage({ type: "image-isolate", token: preview!.token });
  expect(isolated.imageCleanup?.notice).toContain("移入隔离区");
  expect(isolated.imageCleanup?.notice).toContain("（11 B）");
  expect(isolated.storage).toBeUndefined();
  expect(readdirSync(`${path}.images`)).not.toContain(name);
  const batches = (await chat.inspectStorage()).storage?.quarantine;
  expect(batches).toHaveLength(1);
  expect(chat.manage({ type: "image-restore", id: batches![0]!.id }).imageCleanup?.notice).toContain("已恢复 1 张");
  expect(readdirSync(`${path}.images`)).toContain(name);
});

// R110 (F06): the service refusing a chat request that carried pictures. Deterministic stream
// errors shaped like ProviderError; not a service verification.
const refusedImage = { mimeType: "image/png" as const, data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=" };
/** A documented vision model: pictures go by the documented list (user decision, 2026-10-29). */
const vision = () =>
  mocks.acquire.mockReturnValue({ config: { id: "p", revision: 4, protocol: "openai-responses", baseURL: "https://api.openai.com/v1" }, key: "test-private", release: mocks.release });
const refuse = (fields: object, times = 1) => {
  let left = times;
  mocks.stream.mockImplementation(async function* () {
    if (left-- > 0) throw Object.assign(new Error("Provider HTTP (code=remote-private-body)"), fields);
    yield { type: "text-delta", text: "好的" };
    yield { type: "finished", reason: "stop" };
  });
};
const withPicture = (chatId: string) => ({ ...input, modelId: "gpt-4.1", chatId, attachments: [{ name: "x.png", text: "", image: refusedImage }] });
it.each([400, 415, 422])("HTTP %i on a message with a picture: own words, marks the model once, sends nothing again", async (status) => {
  vision();
  refuse({ code: "http", status });
  const chat = createHertaChat(path), chatId = chat.snapshot().activeId!;
  chat.send(withPicture(chatId));
  await vi.waitFor(() => expect(chat.snapshot().busy).toBe(false));
  expect(chat.snapshot().messages[1]).toMatchObject({ status: "failed", failure: "image-rejected" });
  expect(chat.snapshot().error).toBe(chatFailures["image-rejected"]);
  expect(mocks.review.mock.calls).toEqual([[{ providerId: "p", providerRevision: 4, modelId: "gpt-4.1", status, surface: "chat" }]]);
  expect(mocks.stream).toHaveBeenCalledTimes(1);
  // The words survive a reload; the remote text never reaches the file.
  expect(createHertaChat(path).snapshot().messages[1]?.failure).toBe("image-rejected");
  expect(readFileSync(path, "utf8")).not.toContain("remote-private-body");
  await chat.dispose();
});
it("HTTP 413 on a message with a picture says it was too large and marks nothing", async () => {
  vision();
  refuse({ code: "http", status: 413 });
  const chat = createHertaChat(path), chatId = chat.snapshot().activeId!;
  chat.send(withPicture(chatId));
  await vi.waitFor(() => expect(chat.snapshot().busy).toBe(false));
  expect(chat.snapshot().messages[1]?.failure).toBe("image-too-large");
  expect(mocks.review).not.toHaveBeenCalled();
  await chat.dispose();
});
it.each([
  [{ code: "http", status: 401 }, "authentication"],
  [{ code: "http", status: 403 }, "authentication"],
  [{ code: "http", status: 404 }, "model-not-found"],
  [{ code: "http", status: 429 }, "rate-limit"],
  [{ code: "http", status: 500 }, "service-unavailable"],
  [{ code: "http", status: 503 }, "service-unavailable"],
  [{ code: "stall" }, "timeout"],
  [{ code: "network" }, "network"],
  [{ code: "sse" }, "stream-interrupted"],
] as const)("%j on a message with a picture keeps its own words and marks nothing", async (fields, failure) => {
  vision();
  refuse(fields);
  const chat = createHertaChat(path), chatId = chat.snapshot().activeId!;
  chat.send(withPicture(chatId));
  await vi.waitFor(() => expect(chat.snapshot().busy).toBe(false));
  expect(chat.snapshot().messages[1]?.failure).toBe(failure);
  expect(mocks.review).not.toHaveBeenCalled();
  await chat.dispose();
});
it("HTTP 400 on a message without pictures keeps the general words and marks nothing", async () => {
  vision();
  refuse({ code: "http", status: 400 });
  const chat = createHertaChat(path), chatId = chat.snapshot().activeId!;
  chat.send({ ...input, modelId: "gpt-4.1", chatId });
  await vi.waitFor(() => expect(chat.snapshot().busy).toBe(false));
  expect(chat.snapshot().messages[1]?.failure).toBe("service-unavailable");
  expect(mocks.review).not.toHaveBeenCalled();
  await chat.dispose();
});
it("counts a picture the continuation range sends again, and a range without it sends none", async () => {
  vision();
  const chat = createHertaChat(path), chatId = chat.snapshot().activeId!;
  chat.send(withPicture(chatId));
  await vi.waitFor(() => expect(chat.snapshot().busy).toBe(false));
  refuse({ code: "http", status: 400 }, 2);
  chat.send({ ...input, text: "左上角写了什么？", modelId: "gpt-4.1", chatId });
  await vi.waitFor(() => expect(chat.snapshot().busy).toBe(false));
  expect(mocks.stream.mock.calls[1]![0].messages.some((m: { images?: unknown[] }) => m.images?.length)).toBe(true);
  expect(chat.snapshot().messages.at(-1)?.failure).toBe("image-rejected");
  expect(mocks.review).toHaveBeenCalledTimes(1);
  // What the words suggest: a range that leaves the picture out sends a request without it.
  chat.manage({ type: "context", id: chatId, keepTurns: 0, note: "" });
  chat.send({ ...input, text: "不看图了，直接说", modelId: "gpt-4.1", chatId });
  await vi.waitFor(() => expect(chat.snapshot().busy).toBe(false));
  expect(mocks.stream.mock.calls[2]![0].messages.some((m: { images?: unknown[] }) => m.images?.length)).toBe(false);
  expect(chat.snapshot().messages.at(-1)?.failure).toBe("service-unavailable");
  expect(mocks.review).toHaveBeenCalledTimes(1);
  await chat.dispose();
});
it("a mark that cannot be written leaves the failure's words as they are", async () => {
  vision();
  refuse({ code: "http", status: 400 });
  mocks.review.mockImplementationOnce(() => {
    throw new Error("disk unavailable");
  });
  const chat = createHertaChat(path), chatId = chat.snapshot().activeId!;
  chat.send(withPicture(chatId));
  await vi.waitFor(() => expect(chat.snapshot().busy).toBe(false));
  expect(chat.snapshot().messages[1]?.failure).toBe("image-rejected");
  expect(mocks.release).toHaveBeenCalledTimes(1);
  await chat.dispose();
});
// F04 (R117, design 2.7): a sent picture the user stops sending to the models.
const stopped = (chat: ReturnType<typeof createHertaChat>, chatId: string, messageId: string, indexes: number[], use: "stop" | "send" = "stop") =>
  chat.manage({ type: "picture-use", id: chatId, messageId, indexes, use });
const imagesSent = (call: number) =>
  mocks.stream.mock.calls[call]![0].messages.flatMap((m: { images?: unknown[] }) => m.images ?? []);
it("a stopped picture is not counted, read or sent, the request says why, and it survives a reopen until restored", async () => {
  vision();
  const chat = createHertaChat(path), chatId = chat.snapshot().activeId!;
  chat.send(withPicture(chatId));
  await vi.waitFor(() => expect(chat.snapshot().busy).toBe(false));
  const message = chat.snapshot().messages[0]!;
  const updatedAt = chat.snapshot().chats[0]!.updatedAt;
  const view = stopped(chat, chatId, message.id, [0]);
  expect(view.messages[0]?.attachments?.[0]).toMatchObject({ modelUse: "stopped", imageDeferred: true });
  expect(view.chats[0]!.updatedAt).toBe(updatedAt);
  expect(readFileSync(path, "utf8")).toContain('"modelUse":"stopped"');
  // The picture stays: its preview still reads.
  expect(chat.readImage(chatId, message.id, 0)).toEqual(refusedImage);
  chat.send({ ...input, text: "继续", modelId: "gpt-4.1", chatId });
  await vi.waitFor(() => expect(chat.snapshot().busy).toBe(false));
  expect(imagesSent(1)).toEqual([]);
  const first = mocks.stream.mock.calls[1]![0].messages[0];
  expect(first.text).toContain("用户已停止把这张图片发给模型");
  expect(first.text).toContain('"name":"x.png"');
  expect(first.text).not.toContain("sha256");
  // Only the pictures still sent face the image check: a text-only model may continue.
  chat.send({ ...input, text: "换个模型", modelId: "deepseek-flash", chatId });
  await vi.waitFor(() => expect(chat.snapshot().busy).toBe(false));
  expect(imagesSent(2)).toEqual([]);
  await chat.dispose();
  const reopened = createHertaChat(path);
  expect(reopened.snapshot().messages[0]?.attachments?.[0]?.modelUse).toBe("stopped");
  expect(stopped(reopened, chatId, message.id, [0], "send").messages[0]?.attachments?.[0]?.modelUse).toBeUndefined();
  reopened.send({ ...input, text: "再看图", modelId: "gpt-4.1", chatId });
  await vi.waitFor(() => expect(reopened.snapshot().busy).toBe(false));
  expect(imagesSent(3)).toEqual([refusedImage]);
  await reopened.dispose();
});
it("stopping one picture frees room for a message the eight-picture limit refused", async () => {
  vision();
  const four = Array.from({ length: 4 }, (_, i) => ({ name: `p${i}.png`, text: "", image: refusedImage }));
  const chat = createHertaChat(path), chatId = chat.snapshot().activeId!;
  for (const text of ["一", "二"]) {
    chat.send({ ...input, text, modelId: "gpt-4.1", chatId, attachments: four });
    await vi.waitFor(() => expect(chat.snapshot().busy).toBe(false));
  }
  const ninth = { ...input, text: "三", modelId: "gpt-4.1", chatId, attachments: [{ name: "n.png", text: "", image: refusedImage }] };
  expect(() => chat.send(ninth)).toThrow("续聊图片较多");
  expect(mocks.stream).toHaveBeenCalledTimes(2);
  stopped(chat, chatId, chat.snapshot().messages[0]!.id, [1]);
  chat.send(ninth);
  await vi.waitFor(() => expect(chat.snapshot().busy).toBe(false));
  expect(imagesSent(2)).toHaveLength(8);
  await chat.dispose();
});
it("a stopped picture whose copy is missing no longer blocks sending", async () => {
  vision();
  const chat = createHertaChat(path), chatId = chat.snapshot().activeId!;
  chat.send(withPicture(chatId));
  await vi.waitFor(() => expect(chat.snapshot().busy).toBe(false));
  await chat.dispose();
  writeFileSync(join(`${path}.images`, readdirSync(`${path}.images`)[0]!), "corrupt");
  const reopened = createHertaChat(path);
  const send = { ...input, text: "继续", modelId: "gpt-4.1", chatId };
  expect(() => reopened.send(send)).toThrow("缺失或损坏");
  stopped(reopened, chatId, reopened.snapshot().messages[0]!.id, [0]);
  reopened.send(send);
  await vi.waitFor(() => expect(reopened.snapshot().busy).toBe(false));
  expect(imagesSent(1)).toEqual([]);
  await reopened.dispose();
});
it("refuses a picture switch that does not name a sent picture of the current chat, or comes while a reply runs, and saves nothing", async () => {
  vision();
  const chat = createHertaChat(path), chatId = chat.snapshot().activeId!;
  chat.send({ ...withPicture(chatId), attachments: [{ name: "x.png", text: "", image: refusedImage }, { name: "a.txt", text: "文字" }] });
  await vi.waitFor(() => expect(chat.snapshot().busy).toBe(false));
  const [user, reply] = chat.snapshot().messages;
  const disk = readFileSync(path, "utf8"), revision = chat.snapshot().revision;
  for (const bad of [
    { id: "other", messageId: user!.id, indexes: [0], use: "stop" },
    { id: chatId, messageId: "missing", indexes: [0], use: "stop" },
    { id: chatId, messageId: reply!.id, indexes: [0], use: "stop" },
    { id: chatId, messageId: user!.id, indexes: [1], use: "stop" },
    { id: chatId, messageId: user!.id, indexes: [4], use: "stop" },
    { id: chatId, messageId: user!.id, indexes: [0, 0], use: "stop" },
    { id: chatId, messageId: user!.id, indexes: [], use: "stop" },
    { id: chatId, messageId: user!.id, indexes: [0.5], use: "stop" },
    { id: chatId, messageId: user!.id, indexes: [0], use: "pin" },
    { id: chatId, messageId: user!.id, indexes: "0", use: "stop" },
  ])
    expect(() => chat.manage({ type: "picture-use", ...bad } as never)).toThrow("图片");
  // Already in that state: nothing is rewritten.
  stopped(chat, chatId, user!.id, [0], "send");
  expect(readFileSync(path, "utf8")).toBe(disk);
  expect(chat.snapshot().revision).toBe(revision);
  // A chat that is not the selected one cannot be changed.
  chat.manage({ type: "create" });
  expect(() => stopped(chat, chatId, user!.id, [0])).toThrow("图片");
  chat.manage({ type: "select", id: chatId });
  mocks.stream.mockImplementation(async function* (r) {
    yield { type: "text-delta", text: "partial" };
    await new Promise<void>((resolve) => r.signal.addEventListener("abort", () => resolve(), { once: true }));
  });
  chat.send({ ...input, text: "等等", modelId: "gpt-4.1", chatId });
  await vi.waitFor(() => expect(chat.snapshot().messages.at(-1)?.text).toBe("partial"));
  expect(() => stopped(chat, chatId, user!.id, [0])).toThrow("请等待回复结束");
  chat.stop();
  await chat.dispose();
  expect(createHertaChat(path).snapshot().messages[0]?.attachments?.[0]?.modelUse).toBeUndefined();
});
it("keeps a later version's picture state as sent, drops one on a file, and never takes it from a new message", async () => {
  const image = refusedImage;
  const legacy = { schemaVersion: 2, activeId: "c", chats: [{ id: "c", title: "t", updatedAt: "now", pinned: false, archived: false, contextStart: 0, contextNote: "", messages: [{ id: "u", role: "user", text: "图", at: "now", status: "complete", attachments: [{ name: "x.png", text: "", image, modelUse: "pinned" }, { name: "a.txt", text: "文字", modelUse: "stopped" }] }] }] };
  writeFileSync(path, JSON.stringify(legacy));
  vision();
  const chat = createHertaChat(path);
  const [picture, file] = chat.snapshot().messages[0]!.attachments!;
  expect(picture?.modelUse).toBe("pinned");
  expect(file?.modelUse).toBeUndefined();
  chat.send({ ...input, text: "继续", modelId: "gpt-4.1", chatId: "c" });
  await vi.waitFor(() => expect(chat.snapshot().busy).toBe(false));
  expect(imagesSent(0)).toEqual([image]);
  expect(() => chat.send({ ...input, modelId: "gpt-4.1", chatId: "c", attachments: [{ name: "y.png", text: "", image, modelUse: "stopped" } as never] })).toThrow("请重新上传图片文件");
  expect(mocks.stream).toHaveBeenCalledTimes(1);
  await chat.dispose();
});
