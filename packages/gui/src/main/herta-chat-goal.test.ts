// @vitest-environment node
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  stream: vi.fn(),
  acquire: vi.fn(),
  failCommit: false,
  failBackup: false,
}));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      if (mocks.failCommit) throw new Error("synthetic disk failure");
      return fs.renameSync(...args);
    },
    copyFileSync: (...args: Parameters<typeof fs.copyFileSync>) => {
      if (mocks.failBackup) throw new Error("synthetic backup failure");
      return fs.copyFileSync(...args);
    },
  };
});
vi.mock("./provider-settings.js", () => ({
  acquireChatProvider: mocks.acquire,
  getProviderSettings: () => ({ settings: { defaultBindings: {} } }),
  recordImageRequestRefused: vi.fn(),
}));
vi.mock("@herta/providers", () => ({
  createProtocolAdapter: () => ({ stream: mocks.stream }),
  reasoningChoices: () => [],
}));
vi.mock("@herta/app-server", () => ({
  desktopPersonaIdentity: () => "Herta persona",
}));
import { createHertaChat } from "./herta-chat.js";

let path: string;
const runtimes: ReturnType<typeof createHertaChat>[] = [];
function runtime() {
  const chat = createHertaChat(path);
  runtimes.push(chat);
  return chat;
}
const input = { text: "synthetic question", providerId: "p", modelId: "m" };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.failCommit = false;
  mocks.failBackup = false;
  path = join(mkdtempSync(join(tmpdir(), "herta-chat-goal-")), "chat.json");
  mocks.acquire.mockReturnValue({
    config: {},
    key: "synthetic",
    release: vi.fn(),
  });
  mocks.stream.mockImplementation(async function* () {
    yield {
      type: "text-delta",
      text: "The goal is done, according to this synthetic reply.",
    };
    yield { type: "finished", reason: "stop" };
  });
});
afterEach(async () => {
  for (const chat of runtimes.splice(0)) await chat.dispose();
});

it("gives old chats an empty goal, preserves set/edit/end history through reopen, and changes no messages or chat time", () => {
  const chat = runtime();
  const before = chat.snapshot();
  const id = before.activeId!;
  expect(chat.getGoal(id)).toMatchObject({
    ok: true,
    view: { state: { revision: 0, active: null, history: [] } },
  });
  expect(
    chat.updateGoal(id, 0, { type: "set", text: "First goal" }),
  ).toMatchObject({
    ok: true,
    view: {
      state: { revision: 1, active: { text: "First goal", status: "active" } },
    },
  });
  const setAt = chat.snapshot().goal?.state.active?.setAt;
  expect(
    chat.updateGoal(id, 1, { type: "set", text: "Revised goal" }),
  ).toMatchObject({
    ok: true,
    view: { state: { revision: 2, active: { text: "Revised goal", setAt } } },
  });
  expect(
    chat.updateGoal(id, 2, {
      type: "end",
      status: "done",
      result: "User-verified result",
    }),
  ).toMatchObject({
    ok: true,
    view: {
      state: {
        revision: 3,
        active: null,
        history: [
          {
            text: "Revised goal",
            status: "done",
            result: "User-verified result",
          },
        ],
      },
    },
  });
  expect(chat.snapshot().messages).toEqual(before.messages);
  expect(chat.snapshot().chats[0]?.updatedAt).toBe(before.chats[0]?.updatedAt);
  expect(runtime().getGoal(id)).toEqual(chat.getGoal(id));
  expect(
    chat.updateGoal(id, 3, { type: "set", text: "Next goal" }),
  ).toMatchObject({ ok: true });
  expect(chat.snapshot().goal?.state.history).toHaveLength(1);
  expect(mocks.stream).not.toHaveBeenCalled();
  expect(JSON.parse(readFileSync(path, "utf8")).schemaVersion).toBe(3);
});

it("checks target and goal revision, rejects malformed actions, and keeps stale writes from changing any chat", () => {
  const chat = runtime();
  const id = chat.snapshot().activeId!;
  chat.updateGoal(id, 0, { type: "set", text: "Current" });
  const disk = readFileSync(path, "utf8");
  expect(chat.updateGoal(id, 0, { type: "set", text: "stale" })).toMatchObject({
    ok: false,
    reason: "conflict",
  });
  expect(
    chat.updateGoal(id, 1, { type: "set", text: "x".repeat(501) }),
  ).toMatchObject({ ok: false, reason: "invalid" });
  expect(
    chat.updateGoal(id, 1, { type: "end", status: "complete" } as never),
  ).toMatchObject({ ok: false, reason: "invalid" });
  expect(readFileSync(path, "utf8")).toBe(disk);
  const newId = chat.manage({ type: "create" }).activeId!;
  expect(chat.getGoal(id)).toMatchObject({ ok: false, reason: "no_target" });
  expect(
    chat.updateGoal(id, 1, { type: "set", text: "wrong chat" }),
  ).toMatchObject({ ok: false, reason: "no_target" });
  expect(chat.getGoal(newId)).toMatchObject({
    ok: true,
    view: { state: { active: null } },
  });
  chat.manage({ type: "select", id });
  expect(chat.snapshot().goal?.state.active?.text).toBe("Current");
});

it("persists first and reports a storage failure without changing disk, memory or revisions", () => {
  const chat = runtime();
  const id = chat.snapshot().activeId!;
  chat.updateGoal(id, 0, { type: "set", text: "Original goal" });
  const snapshot = chat.snapshot();
  const disk = readFileSync(path, "utf8");
  mocks.failCommit = true;
  expect(
    chat.updateGoal(id, 1, {
      type: "end",
      status: "dropped",
      result: "Should not commit",
    }),
  ).toMatchObject({ ok: false, reason: "storage" });
  expect(chat.snapshot()).toEqual(snapshot);
  expect(readFileSync(path, "utf8")).toBe(disk);
  mocks.failCommit = false;
  expect(
    chat.updateGoal(id, 1, {
      type: "end",
      status: "dropped",
      result: "No longer needed",
    }),
  ).toMatchObject({ ok: true });
});

it("sends only the active goal in persona context and never treats a model completion claim as goal completion", async () => {
  const chat = runtime();
  const id = chat.snapshot().activeId!;
  chat.updateGoal(id, 0, { type: "set", text: "GOAL-ONLY-ACTIVE-7291" });
  chat.send({ ...input, chatId: id });
  await vi.waitFor(() => expect(chat.snapshot().busy).toBe(false));
  expect(mocks.stream.mock.calls[0]?.[0].system).toContain(
    "GOAL-ONLY-ACTIVE-7291",
  );
  expect(mocks.stream.mock.calls[0]?.[0].tools).toEqual([]);
  expect(chat.snapshot().goal?.state.active?.status).toBe("active");
  chat.updateGoal(id, 1, {
    type: "end",
    status: "done",
    result: "HISTORY-RESULT-7291",
  });
  chat.send({ ...input, chatId: id });
  await vi.waitFor(() => expect(chat.snapshot().busy).toBe(false));
  const second = mocks.stream.mock.calls[1]?.[0];
  expect(second.system).not.toContain("GOAL-ONLY-ACTIVE-7291");
  expect(JSON.stringify(second.messages)).not.toContain("HISTORY-RESULT-7291");
  expect(chat.snapshot().goal?.state.history).toHaveLength(1);
});

it("refuses goal updates while a reply is running", async () => {
  const chat = runtime();
  const id = chat.snapshot().activeId!;
  chat.updateGoal(id, 0, { type: "set", text: "Keep this goal" });
  mocks.stream.mockImplementation(async function* (request) {
    yield { type: "text-delta", text: "partial" };
    if (request.signal.aborted) return;
    await new Promise<void>((resolve) =>
      request.signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  });
  chat.send({ ...input, chatId: id });
  await vi.waitFor(() => expect(chat.snapshot().busy).toBe(true));
  expect(chat.updateGoal(id, 1, { type: "set", text: "late" })).toMatchObject({
    ok: false,
    reason: "busy",
  });
  expect(chat.snapshot().goal?.state.active?.text).toBe("Keep this goal");
  chat.stop();
  await chat.dispose();
});

it("preserves malformed goal bytes through unrelated saves and resets only after backing up the original store", () => {
  const first = runtime();
  const id = first.snapshot().activeId!;
  const data = JSON.parse(readFileSync(path, "utf8"));
  const bad = {
    schemaVersion: 17,
    image: { data: "not an image" },
    attachments: [{ image: { bad: true } }],
    unknown: "KEEP-BAD-GOAL",
  };
  data.chats[0].goal = bad;
  writeFileSync(path, JSON.stringify(data));
  const chat = runtime();
  expect(chat.snapshot().goal?.damaged).toBe(true);
  expect(chat.getGoal(id)).toMatchObject({ ok: true, view: { damaged: true } });
  expect(
    chat.updateGoal(id, 0, { type: "set", text: "Must not replace damage" }),
  ).toMatchObject({ ok: false, reason: "damaged" });
  expect(() => chat.send({ ...input, chatId: id })).toThrow("目标");
  expect(mocks.acquire).not.toHaveBeenCalled();
  chat.manage({ type: "rename", id, title: "Other change preserves raw goal" });
  expect(JSON.parse(readFileSync(path, "utf8")).chats[0].goal).toEqual(bad);
  const original = readFileSync(path, "utf8");
  expect(chat.updateGoal(id, 0, { type: "reset" })).toMatchObject({
    ok: true,
    view: { state: { active: null, history: [] } },
  });
  const backups = readdirSync(dirname(path)).filter((name) =>
    name.includes("goal-damaged"),
  );
  expect(backups).toHaveLength(1);
  expect(readFileSync(join(dirname(path), backups[0]!), "utf8")).toBe(original);
  expect(runtime().snapshot().goal?.damaged).toBeUndefined();
});

it("does not discard a damaged goal if its backup or replacement cannot be saved", () => {
  const first = runtime();
  const id = first.snapshot().activeId!;
  const data = JSON.parse(readFileSync(path, "utf8"));
  data.chats[0].goal = { broken: true };
  const raw = JSON.stringify(data);
  writeFileSync(path, raw);
  const chat = runtime();
  for (const failure of ["backup", "commit"]) {
    mocks.failBackup = failure === "backup";
    mocks.failCommit = failure === "commit";
    expect(chat.updateGoal(id, 0, { type: "reset" })).toMatchObject({
      ok: false,
      reason: "storage",
    });
    expect(chat.snapshot().goal?.damaged).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(raw);
  }
  mocks.failBackup = mocks.failCommit = false;
});
