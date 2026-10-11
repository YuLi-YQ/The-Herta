import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BackgroundHost,
  InMemoryEventBus,
  NoopMemoryManager,
  ReadLedger,
  type ToolContext,
} from "@herta/core";
import { afterEach, expect, it } from "vitest";
import { editFileTool } from "./edit-file/index.js";
import { readFileTool } from "./read-file/index.js";
import { runCommand } from "./run-command/runner.js";
import { mkTmpWorkspace, type TmpWorkspace } from "./testing/tmp-workspace.js";
import { writeNewFileTool } from "./write-new-file/index.js";

let temporary: TmpWorkspace | undefined;
afterEach(async () => {
  await temporary?.cleanup();
  temporary = undefined;
});
async function workspace(): Promise<ToolContext> {
  temporary = await mkTmpWorkspace({});
  const root = join(temporary.root, "黑塔 实验室（测试）");
  await mkdir(root);
  return {
    sessionId: "round-three-local-safety",
    workspaceRoot: root,
    signal: new AbortController().signal,
    reads: new ReadLedger(),
    bg: new BackgroundHost(),
    bus: new InMemoryEventBus(),
    memory: new NoopMemoryManager(),
  };
}
it("uses real file tools and a real command in a Chinese workspace without overwriting user edits", async () => {
  const ctx = await workspace();
  const path = "说明 文件（草稿）.txt";
  const created = await writeNewFileTool().run(
    {
      id: "write-1",
      tool: "write_new_file",
      input: { path, content: "original\n" },
    },
    ctx,
    () => {},
  );
  expect(created.ok).toBe(true);
  const read = await readFileTool().run(
    { id: "read-1", tool: "read_file", input: { path } },
    ctx,
    () => {},
  );
  expect(read.ok).toBe(true);
  const edited = await editFileTool().run(
    {
      id: "edit-1",
      tool: "edit_file",
      input: { path, hunks: [{ search: "original", replace: "changed" }] },
    },
    ctx,
    () => {},
  );
  expect(edited.ok).toBe(true);
  expect(await readFile(join(ctx.workspaceRoot, path), "utf8")).toBe(
    "changed\n",
  );
  await writeFile(join(ctx.workspaceRoot, path), "user modification\n");
  const stale = await editFileTool().run(
    {
      id: "edit-2",
      tool: "edit_file",
      input: { path, hunks: [{ search: "changed", replace: "overwritten" }] },
    },
    ctx,
    () => {},
  );
  expect(stale.ok).toBe(false);
  expect(await readFile(join(ctx.workspaceRoot, path), "utf8")).toBe(
    "user modification\n",
  );
  const output = await runCommand(
    [process.execPath, "-e", "process.stdout.write(process.cwd())"],
    {
      cwd: ctx.workspaceRoot,
      timeoutMs: 5000,
      signal: ctx.signal,
      maxBytesPerStream: 4096,
    },
  );
  expect(output.exitCode).toBe(0);
  expect(output.stdout.toString("utf8")).toBe(ctx.workspaceRoot);
  const escapedWrite = await writeNewFileTool().run(
    {
      id: "escape",
      tool: "write_new_file",
      input: { path: "../outside.txt", content: "blocked" },
    },
    ctx,
    () => {},
  );
  expect(escapedWrite.ok).toBe(false);
});
it("AbortController stops the actual command and its child process", async () => {
  const ctx = await workspace();
  const controller = new AbortController();
  let childPid: number | undefined;
  const script =
    'const {spawn}=require("node:child_process"); const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore",windowsHide:true}); console.log("CHILD:"+child.pid); setInterval(()=>{},1000);';
  const result = await runCommand([process.execPath, "-e", script], {
    cwd: ctx.workspaceRoot,
    timeoutMs: 10000,
    signal: controller.signal,
    maxBytesPerStream: 4096,
    onOutput: (chunk) => {
      const match = chunk.toString("utf8").match(/CHILD:(\d+)/);
      if (match) {
        childPid = Number(match[1]);
        controller.abort();
      }
    },
  });
  expect(result.cause).toBe("aborted");
  expect(childPid).toBeTypeOf("number");
  let alive = true;
  for (let n = 0; n < 50 && alive; n++) {
    try {
      process.kill(childPid as number, 0);
      await new Promise((r) => setTimeout(r, 100));
    } catch {
      alive = false;
    }
  }
  if (alive) {
    try {
      process.kill(childPid as number);
    } catch {
      /* already stopped */
    }
  }
  expect(alive).toBe(false);
}, 20000);
