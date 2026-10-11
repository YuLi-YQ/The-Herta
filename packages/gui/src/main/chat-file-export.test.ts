import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { expect, it, vi } from "vitest";
import { createChatFileSaver } from "./chat-file-export.js";
it("only writes to the user-selected destination and preserves exact text", async () => {
  const directory = mkdtempSync(join(tmpdir(), "herta-chat-file-"));
  const destination = join(directory, "chosen.py");
  const choose = vi.fn(async (_path: string) => ({
    canceled: false,
    filePath: destination,
  }));
  const save = createChatFileSaver({ directory, choose });
  expect(await save("../../script.py", "print('hello')\n")).toEqual({
    saved: true,
  });
  expect(readFileSync(destination, "utf8")).toBe("print('hello')\n");
  expect(dirname(choose.mock.calls[0]![0])).toBe(directory);
});
it("cancel and oversized artifacts do not write files", async () => {
  const choose = vi.fn(async () => ({ canceled: true }));
  const save = createChatFileSaver({ directory: tmpdir(), choose });
  expect(await save("sample.txt", "hello")).toEqual({ saved: false });
  expect(await save("sample.txt", "x".repeat(512001))).toEqual({
    saved: false,
    failed: true,
  });
  expect(choose).toHaveBeenCalledTimes(1);
});

