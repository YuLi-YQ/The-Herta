import { describe, expect, it } from "vitest";
import {
  CommandOutputDecoder,
  decodeCommandOutput,
  resolveCommandEncoding,
} from "./output-encoding.js";
import { runCommand } from "./runner.js";
import { SpawnedBackgroundProcess } from "./background-process.js";
import { runCommandInputSchema } from "./schema.js";
const cases = [
  ["utf-8", Buffer.from("中文😀\n"), "中文😀\n"],
  ["gb18030", Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 10]), "中文\n"],
  ["utf-16le", Buffer.from("中文😀\n", "utf16le"), "中文😀\n"],
] as const;
it.each(
  cases,
)("decodes %s at every byte boundary and matches final output", (encoding, bytes, expected) => {
  const decoder = new CommandOutputDecoder(encoding);
  let text = "";
  for (const b of bytes) text += decoder.write(Buffer.from([b]));
  text += decoder.end();
  expect(text).toBe(expected);
  expect(decodeCommandOutput(bytes, encoding)).toBe(text);
});
it("validates explicit encoding and lets it override shell defaults", async () => {
  expect(
    runCommandInputSchema.safeParse({ argv: ["cmd"], outputEncoding: "bad" })
      .success,
  ).toBe(false);
  expect(await resolveCommandEncoding(["cmd", "/u"], "gb18030")).toBe(
    "gb18030",
  );
});
describe.skipIf(process.platform !== "win32")(
  "actual Windows shell output",
  () => {
    it.each([
      { flags: [] },
      { flags: ["/u"] },
    ])("reads native cmd Chinese ($flags)", async ({ flags }) => {
      const argv = ["cmd.exe", "/d", ...flags, "/c", "echo 中文"];
      const encoding = await resolveCommandEncoding(argv);
      const result = await runCommand(argv, {
        cwd: process.cwd(),
        timeoutMs: 5000,
        signal: new AbortController().signal,
        maxBytesPerStream: 1024,
      });
      expect(result.exitCode).toBe(0);
      expect(decodeCommandOutput(result.stdout, encoding).trim()).toBe("中文");
    });
  },
);
it("background streams preserve split GBK characters before merging and cursor reads", async () => {
  const process = new SpawnedBackgroundProcess({
    id: "encoding",
    argv: [
      globalThis.process.execPath,
      "-e",
      "process.stdout.write(Buffer.from([0xd6]));setTimeout(()=>{process.stdout.write(Buffer.from([0xd0]));process.stderr.write(Buffer.from([0xce,0xc4]));},30)",
    ],
    cwd: globalThis.process.cwd(),
    env: globalThis.process.env,
    outputEncoding: "gb18030",
  });
  await process.closed();
  const output = process.readSince(0);
  expect(output.text).toContain("中");
  expect(output.text).toContain("文");
  expect(output.text).not.toContain("�");
  expect(process.readSince(output.nextByte).text).toBe("");
  expect(process.readSince(1).text).not.toContain("�");
});
