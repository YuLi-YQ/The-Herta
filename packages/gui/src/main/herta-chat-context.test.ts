// @vitest-environment node
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  DraftChatContextInput,
  HertaChatMessage,
} from "../shared/herta-chat.js";

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  stream: vi.fn(),
  release: vi.fn(),
  providerRevision: 7,
  failCommit: false,
}));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (mocks.failCommit) throw new Error("synthetic write failure");
      return actual.renameSync(...args);
    },
  };
});
vi.mock("./provider-settings.js", () => ({
  acquireChatProvider: mocks.acquire,
  getProviderSettings: () => ({
    settings: {
      providers: [{ id: "p", revision: mocks.providerRevision }],
      defaultBindings: {},
    },
  }),
  recordImageRequestRefused: vi.fn(),
}));
vi.mock("@herta/providers", () => ({
  createProtocolAdapter: () => ({ stream: mocks.stream }),
  reasoningChoices: () => ["low", "high"],
}));
vi.mock("@herta/app-server", () => ({
  desktopPersonaIdentity: () => "synthetic persona",
}));
import { createHertaChat } from "./herta-chat.js";
import { createChatContextDrafter } from "./chat-context-draft.js";

let path: string;
const runtimes: ReturnType<typeof createHertaChat>[] = [];
function fixture(turns = 8, text = "") {
  const messages: HertaChatMessage[] = Array.from({ length: turns }, (_, i) => [
    {
      id: `u${i}`,
      role: "user" as const,
      text: `user-${i}${text}`,
      status: "complete" as const,
      at: "2026-11-01T03:00:00.000Z",
    },
    {
      id: `a${i}`,
      role: "assistant" as const,
      text: `assistant-${i}${text}`,
      status: i === 1 ? ("failed" as const) : ("complete" as const),
      at: "2026-11-01T03:00:01.000Z",
      reasoning: "reasoning is excluded",
    },
  ]).flat();
  messages[0]!.attachments = [
    { name: "old-file.txt", text: "private attachment body is excluded" },
  ];
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: 2,
      activeId: "chat-a",
      chats: [
        {
          id: "chat-a",
          title: "Synthetic chat",
          updatedAt: "2026-11-01",
          pinned: false,
          archived: false,
          messages,
          contextStart: 0,
          contextNote: "existing note is excluded",
        },
      ],
    }),
  );
  const runtime = createHertaChat(path);
  runtimes.push(runtime);
  const input: DraftChatContextInput = {
    chatId: "chat-a",
    requestId: "request-a",
    expectedRevision: runtime.snapshot().revision,
    keepTurns: 3,
    providerId: "p",
    modelId: "m",
    providerRevision: 7,
    reasoningEffort: "low",
  };
  return { runtime, input };
}
function gateStream(text = "new draft") {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  mocks.stream.mockImplementationOnce(async function* () {
    await gate;
    yield { type: "text-delta", text };
    yield { type: "finished", reason: "stop" };
  });
  return release;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.providerRevision = 7;
  mocks.failCommit = false;
  path = join(mkdtempSync(join(tmpdir(), "herta-chat-context-")), "chat.json");
  mocks.acquire.mockImplementation(() => ({
    config: { id: "p", revision: 7 },
    key: "synthetic-private-key",
    release: mocks.release,
  }));
  mocks.stream.mockImplementation(async function* () {
    yield { type: "text-delta", text: "  已讨论要点\n仍需确认的事项  " };
    yield { type: "finished", reason: "stop" };
  });
});
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
});

it("drafts only excluded messages through the selected model and leaves every stored field unchanged", async () => {
  const { runtime, input } = fixture();
  const before = runtime.snapshot(),
    disk = readFileSync(path, "utf8");
  const result = await runtime.draftContext(input);
  expect(result).toMatchObject({
    ok: true,
    chatId: "chat-a",
    requestId: "request-a",
    revision: before.revision,
    keepTurns: 3,
    boundaryIndex: 10,
    text: "已讨论要点\n仍需确认的事项",
    providerId: "p",
    modelId: "m",
    providerRevision: 7,
  });
  if (result.ok)
    expect(Number.isFinite(Date.parse(result.generatedAt))).toBe(true);
  expect(mocks.acquire).toHaveBeenCalledWith("p", "m");
  const request = mocks.stream.mock.calls[0]![0];
  expect(request).toMatchObject({
    modelId: "m",
    tools: [],
    options: { webSearch: false, reasoningEffort: "low" },
  });
  expect(request.system).toContain("未读取内容");
  const source = JSON.parse(request.messages[0].text);
  expect(source).toHaveLength(10);
  expect(source[3]).toMatchObject({ text: "assistant-1", status: "failed" });
  expect(source[0].attachments).toEqual([
    { name: "old-file.txt", kind: "file", content: "未读取附件内容" },
  ]);
  expect(request.messages[0].text).not.toMatch(
    /user-5|assistant-7|existing note|reasoning is excluded|private attachment body/,
  );
  expect(runtime.snapshot()).toEqual(before);
  expect(readFileSync(path, "utf8")).toBe(disk);
  expect(mocks.release).toHaveBeenCalledTimes(1);
});

it("uses attachment metadata without inspecting image bytes or file contents", async () => {
  const source = {
    chatId: "chat",
    revision: 4,
    contextStart: 0,
    busy: false,
    disposed: false,
    messages: [
      {
        id: "u",
        role: "user" as const,
        status: "complete" as const,
        at: "now",
        text: "earlier message",
        attachments: [
          {
            name: "photo.png",
            text: "private OCR",
            imageRef: {
              storage: "sha256" as const,
              sha256: "do-not-read",
              mimeType: "image/png" as const,
            },
          },
        ],
      },
    ],
  };
  const draft = createChatContextDrafter(() => source, vi.fn());
  expect(
    (
      await draft.draft({
        chatId: "chat",
        requestId: "r",
        expectedRevision: 4,
        keepTurns: 0,
        providerId: "p",
        modelId: "m",
        providerRevision: 7,
      })
    ).ok,
  ).toBe(true);
  expect(mocks.stream.mock.calls[0]![0].messages[0].text).toContain(
    '"kind":"image"',
  );
  expect(mocks.stream.mock.calls[0]![0].messages[0].text).not.toMatch(
    /do-not-read|private OCR/,
  );
  await draft.dispose();
});

it("preserves the exact saved boundary for drafting and note-only saves after more messages arrive", async () => {
  const { runtime, input } = fixture();
  runtime.manage({
    type: "context",
    id: input.chatId,
    keepTurns: 3,
    note: "saved note",
  });
  expect(runtime.snapshot().contextStart).toBe(10);
  runtime.send({
    chatId: input.chatId,
    providerId: "p",
    modelId: "m",
    text: "newest extra turn",
  });
  await vi.waitFor(() => expect(runtime.snapshot().busy).toBe(false));
  const current = runtime.snapshot();
  expect(current.messages).toHaveLength(18);
  const reply = await runtime.draftContext({
    ...input,
    keepTurns: -2,
    expectedRevision: current.revision,
  });
  expect(reply).toMatchObject({ ok: true, keepTurns: -2, boundaryIndex: 10 });
  const source = JSON.parse(
    mocks.stream.mock.calls.at(-1)![0].messages[0].text,
  );
  expect(source).toHaveLength(10);
  expect(JSON.stringify(source)).not.toContain("user-5");
  expect(runtime.snapshot().contextNote).toBe("saved note");
  const result = runtime.manage({
    type: "context",
    id: input.chatId,
    keepTurns: -2,
    note: "edited only note",
    expectedRevision: current.revision,
  });
  expect(result.contextStart).toBe(10);
  expect(result.contextNote).toBe("edited only note");
  expect(result.messages).toEqual(current.messages);
});

it.each([
  -1, 2, 1.5,
])("does not send a draft when the authoritative stored boundary is invalid: %s", async (contextStart) => {
  const draft = createChatContextDrafter(
    () => ({
      chatId: "chat",
      revision: 0,
      busy: false,
      disposed: false,
      contextStart,
      messages: [
        {
          id: "u",
          role: "user",
          text: "record",
          status: "complete",
          at: "now",
        },
      ],
    }),
    vi.fn(),
  );
  expect(
    await draft.draft({
      chatId: "chat",
      requestId: "r",
      expectedRevision: 0,
      keepTurns: -2,
      providerId: "p",
      modelId: "m",
      providerRevision: 7,
    }),
  ).toMatchObject({ ok: false, reason: "storage" });
  expect(mocks.acquire).not.toHaveBeenCalled();
  await draft.dispose();
});

it("only applies a draft on explicit CAS save; stale, invalid and failed saves preserve the original note", async () => {
  const { runtime, input } = fixture();
  const result = await runtime.draftContext(input);
  if (!result.ok) throw Error(result.message);
  expect(runtime.snapshot().contextNote).toBe("existing note is excluded");
  expect(() =>
    runtime.manage({
      type: "context",
      id: input.chatId,
      keepTurns: 3,
      note: result.text,
      expectedRevision: input.expectedRevision + 1,
    }),
  ).toThrow("聊天内容已变化");
  expect(() =>
    runtime.manage({
      type: "context",
      id: input.chatId,
      keepTurns: 3,
      note: result.text,
      expectedRevision: -1,
    }),
  ).toThrow("无效");
  expect(() =>
    runtime.manage({
      type: "context",
      id: input.chatId,
      keepTurns: 3,
      note: result.text,
      expectedRevision: 0,
      privilege: true,
    } as never),
  ).toThrow("无效");
  mocks.failCommit = true;
  expect(() =>
    runtime.manage({
      type: "context",
      id: input.chatId,
      keepTurns: 3,
      note: result.text,
      expectedRevision: 0,
    }),
  ).toThrow("未保存");
  expect(runtime.snapshot().contextNote).toBe("existing note is excluded");
  mocks.failCommit = false;
  const saved = runtime.manage({
    type: "context",
    id: input.chatId,
    keepTurns: 3,
    note: result.text,
    expectedRevision: result.revision,
  });
  expect(saved.contextNote).toBe(result.text);
  expect(saved.contextStart).toBe(10);
  // Existing callers that omit CAS remain compatible.
  expect(
    runtime.manage({
      type: "context",
      id: input.chatId,
      keepTurns: 6,
      note: "legacy save",
    }).contextNote,
  ).toBe("legacy save");
});

it.each([
  { keepTurns: 2 },
  { expectedRevision: -1 },
  { expectedRevision: 0.5 },
  { providerRevision: 0 },
  { requestId: "../escape" },
  { modelId: "" },
  { webSearch: true },
  { boundaryIndex: 4 },
  { reasoningEffort: false },
])("rejects malformed inputs before acquiring a model: %j", async (change) => {
  const { runtime, input } = fixture();
  expect(await runtime.draftContext({ ...input, ...change })).toMatchObject({
    ok: false,
    reason: "invalid",
  });
  expect(mocks.acquire).not.toHaveBeenCalled();
});
it.each([
  [{ chatId: "different" }, "no_target"],
  [{ expectedRevision: 20 }, "conflict"],
  [{ keepTurns: -1 }, "no_content"],
  [{ keepTurns: 12 }, "no_content"],
])("rejects unavailable source before sending: %j", async (change, reason) => {
  const { runtime, input } = fixture();
  expect(
    await runtime.draftContext({ ...input, ...(change as object) }),
  ).toMatchObject({ ok: false, reason });
  expect(mocks.acquire).not.toHaveBeenCalled();
});
it("refuses oversized source rather than silently truncating earlier history", async () => {
  const { runtime, input } = fixture(10, "x".repeat(13000));
  expect(await runtime.draftContext({ ...input, keepTurns: 0 })).toMatchObject({
    ok: false,
    reason: "input_limit",
  });
  expect(mocks.acquire).not.toHaveBeenCalled();
});
it.each([
  { providerRevision: 6 },
  { reasoningEffort: "unsupported" },
])("requires a matching validated configuration: %j", async (change) => {
  const { runtime, input } = fixture();
  expect(await runtime.draftContext({ ...input, ...change })).toMatchObject({
    ok: false,
    reason: "configuration",
  });
  expect(mocks.stream).not.toHaveBeenCalled();
  expect(mocks.release).toHaveBeenCalledTimes(1);
});
it("keeps validation failures and provider errors private", async () => {
  const { runtime, input } = fixture();
  mocks.acquire.mockImplementationOnce(() => {
    throw Error("synthetic-secret path");
  });
  expect(JSON.stringify(await runtime.draftContext(input))).not.toContain(
    "synthetic-secret",
  );
  mocks.stream.mockImplementationOnce(async function* () {
    throw Object.assign(Error("synthetic-secret body"), { status: 429 });
  });
  const failed = await runtime.draftContext(input);
  expect(failed).toMatchObject({
    ok: false,
    reason: "provider",
    code: "rate-limit",
  });
  expect(JSON.stringify(failed)).not.toContain("synthetic-secret");
});

it.each([
  "length",
  "early",
  "empty",
  "tool",
  "search",
  "oversized",
  "late-text",
])("rejects incomplete or invalid output without returning a partial draft: %s", async (kind) => {
  const { runtime, input } = fixture();
  const disk = readFileSync(path, "utf8");
  mocks.stream.mockImplementationOnce(async function* () {
    if (kind !== "empty")
      yield {
        type: "text-delta",
        text: kind === "oversized" ? "x".repeat(4001) : "partial",
      };
    if (kind === "early") return;
    if (kind === "tool")
      yield { type: "tool-call-ready", call: { id: "t", tool: "execute" } };
    if (kind === "search")
      yield { type: "web-search", id: "s", status: "searching" };
    yield { type: "finished", reason: kind === "length" ? "length" : "stop" };
    if (kind === "late-text") yield { type: "text-delta", text: "unexpected" };
  });
  const result = await runtime.draftContext(input);
  expect(result).toMatchObject({
    ok: false,
    reason: kind === "oversized" ? "output_limit" : "provider",
  });
  expect(result).not.toHaveProperty("text");
  expect(readFileSync(path, "utf8")).toBe(disk);
});
it("accepts exactly 4000 UTF-16 units and rejects 4002 from surrogate pairs", async () => {
  const { runtime, input } = fixture();
  mocks.stream.mockImplementationOnce(async function* () {
    yield { type: "text-delta", text: "🪐".repeat(2000) };
    yield { type: "finished", reason: "stop" };
  });
  expect((await runtime.draftContext(input)).ok).toBe(true);
  mocks.stream.mockImplementationOnce(async function* () {
    yield { type: "text-delta", text: "🪐".repeat(2001) };
    yield { type: "finished", reason: "stop" };
  });
  expect(await runtime.draftContext(input)).toMatchObject({
    ok: false,
    reason: "output_limit",
  });
});

it("cancels promptly, ignores late output and protects a new request from an old cancel", async () => {
  const { runtime, input } = fixture();
  const releaseFirst = gateStream("stale first");
  const first = runtime.draftContext(input);
  expect(runtime.snapshot().busy).toBe(false);
  expect(
    await runtime.draftContext({ ...input, requestId: "duplicate" }),
  ).toMatchObject({ reason: "busy" });
  expect(
    runtime.cancelContextDraft({ chatId: "other", requestId: input.requestId }),
  ).toEqual({ cancelled: false });
  expect(
    runtime.cancelContextDraft({
      chatId: input.chatId,
      requestId: input.requestId,
    }),
  ).toEqual({ cancelled: true });
  await expect(first).resolves.toMatchObject({
    ok: false,
    reason: "cancelled",
  });
  const releaseSecond = gateStream("second draft");
  const second = runtime.draftContext({ ...input, requestId: "second" });
  expect(
    runtime.cancelContextDraft({
      chatId: input.chatId,
      requestId: input.requestId,
    }),
  ).toEqual({ cancelled: false });
  releaseFirst();
  releaseSecond();
  expect(await second).toMatchObject({ ok: true, text: "second draft" });
  expect(runtime.snapshot().contextNote).toBe("existing note is excluded");
});
it("rejects late completion after switching away and back to the same chat", async () => {
  const { runtime, input } = fixture();
  const release = gateStream();
  const job = runtime.draftContext(input);
  const other = runtime.manage({ type: "create" });
  expect(other.activeId).not.toBe(input.chatId);
  runtime.manage({ type: "select", id: input.chatId });
  release();
  expect(await job).toMatchObject({ ok: false, reason: "conflict" });
  expect(runtime.snapshot().contextNote).toBe("existing note is excluded");
});
it("rejects completion after provider revision changed", async () => {
  const { runtime, input } = fixture();
  const release = gateStream();
  const job = runtime.draftContext(input);
  mocks.providerRevision++;
  release();
  expect(await job).toMatchObject({ ok: false, reason: "conflict" });
});
it("invalidates pending drafting when a regular chat turn starts", async () => {
  const { runtime, input } = fixture();
  const release = gateStream();
  const job = runtime.draftContext(input);
  runtime.send({
    chatId: input.chatId,
    providerId: "p",
    modelId: "m",
    text: "new regular message",
  });
  expect(await job).toMatchObject({ ok: false, reason: "conflict" });
  release();
  await vi.waitFor(() => expect(runtime.snapshot().busy).toBe(false));
  expect(runtime.snapshot().contextNote).toBe("existing note is excluded");
});
it("refuses drafting during a normal reply and cancels pending work on disposal", async () => {
  const { runtime, input } = fixture();
  const releaseReply = gateStream();
  runtime.send({
    chatId: input.chatId,
    providerId: "p",
    modelId: "m",
    text: "running reply",
  });
  expect(await runtime.draftContext(input)).toMatchObject({
    ok: false,
    reason: "busy",
  });
  releaseReply();
  await vi.waitFor(() => expect(runtime.snapshot().busy).toBe(false));
  const releaseDraft = gateStream();
  const pending = runtime.draftContext({
    ...input,
    expectedRevision: runtime.snapshot().revision,
  });
  await runtime.dispose();
  expect(await pending).toMatchObject({ ok: false, reason: "cancelled" });
  releaseDraft();
});
