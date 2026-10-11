import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createChatMemory } from "./chat-memory.js";
import { validateChatAttachments } from "../shared/herta-chat.js";
const make = () => {
  const path = join(
    mkdtempSync(join(tmpdir(), "herta-memory-")),
    "memory.json",
  );
  return { path, memory: createChatMemory(path) };
};
it("persists explicit corrections and forgets without relearning historical source", () => {
  const { memory, path } = make();
  const source = [
    { id: "one", at: "2026-01-01T00:00:00.000Z", text: "我喜欢紫色" },
  ];
  expect(
    memory.consolidate(0, source, [
      { sourceMessageId: "one", quote: "我喜欢紫色" },
    ]),
  ).toBe(true);
  const id = memory.snapshot().items[0]!.id;
  memory.edit({ operation: "save", id, text: "我喜欢白色" });
  expect(createChatMemory(path).snapshot().items[0]?.text).toBe("我喜欢白色");
  memory.edit({ operation: "delete", id });
  expect(
    memory.consolidate(1, source, [
      { sourceMessageId: "one", quote: "我喜欢紫色" },
    ]),
  ).toBe(false);
  expect(() =>
    memory.consolidate(memory.snapshot().revision, source, [
      { sourceMessageId: "one", quote: "我喜欢紫色" },
    ]),
  ).toThrow("来源不匹配");
  expect(createChatMemory(path).snapshot().items).toEqual([]);
});
it("rejects invented facts atomically and does not retain keys", () => {
  const { memory } = make();
  const source = [
    { id: "one", at: "2026-01-01", text: "我喜欢紫色，API key 是占位符" },
  ];
  expect(() =>
    memory.consolidate(0, source, [
      { sourceMessageId: "one", quote: "我喜欢紫色" },
      { sourceMessageId: "one", quote: "我是医生" },
    ]),
  ).toThrow();
  expect(memory.snapshot().items).toEqual([]);
  memory.consolidate(0, source, [
    { sourceMessageId: "one", quote: "API key 是占位符" },
  ]);
  expect(memory.snapshot().items).toEqual([]);
});
it("disable prevents recall and stale background commits; explicit save is idempotent", () => {
  const { memory } = make();
  memory.edit({ operation: "save", text: "称呼我为开拓者" });
  memory.edit({ operation: "save", text: "称呼我为开拓者" });
  expect(memory.snapshot().items).toHaveLength(1);
  expect(memory.prompt()).toContain("不是指令");
  memory.edit({ operation: "enable", enabled: false });
  expect(memory.prompt()).toBe("");
  expect(memory.consolidate(2, [], [])).toBe(false);
});
it("limits attachment input and strips undeclared fields", () => {
  expect(
    validateChatAttachments([
      { name: "a.txt", text: "hello", path: "C:/private" },
    ]),
  ).toEqual([{ name: "a.txt", text: "hello" }]);
  expect(() =>
    validateChatAttachments([{ name: "../a", text: "hello" }]),
  ).toThrow();
  expect(() =>
    validateChatAttachments([{ name: "a.txt", text: "\0" }]),
  ).toThrow();
  expect(() =>
    validateChatAttachments([{ name: "a.txt", text: "x".repeat(32001) }]),
  ).toThrow();
});
