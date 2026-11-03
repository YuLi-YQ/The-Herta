import { promises as fs } from "node:fs";
import * as childProcess from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withPermissionMode } from "@herta/core";
import { runApprovedPluginCommand, type PluginCommandContext, type PluginCommandPreview } from "./plugin-command.js";
import { checkReaderArgvPaths } from "./run-command/reader-guard.js";
import { resolveWindowsShim } from "./run-command/shim-wrapper.js";
import { resolveCommandEncoding } from "./run-command/output-encoding.js";
vi.mock("node:child_process", async importOriginal => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, execFile: vi.fn(original.execFile) };
});

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), "herta-plugin-command-test-")); roots.push(root);
  const abort = new AbortController(), authorize = vi.fn(async (_preview: PluginCommandPreview) => true);
  const context: PluginCommandContext = { workspaceRoot: root, expectedPhysicalRoot: await fs.realpath(root), protectedPaths: [],
    signal: abort.signal, assertCurrent() {}, authorize };
  return { root, context, authorize, abort };
}
const node = (source: string) => [process.execPath, "-e", source];
describe("approved plugin local commands", () => {
  it("runs an approved real command, preserves exit status, redacts and bounds output", async () => {
    const f = await fixture();
    const result = await runApprovedPluginCommand({ argv: node("process.stdout.write('API_KEY=fixtureSecretValue\\n'+'x'.repeat(100000));process.stderr.write('diagnostic');process.exitCode=7") }, f.context);
    expect(f.authorize).toHaveBeenCalledOnce();
    expect(f.authorize.mock.calls[0]![0]).toMatchObject({ cwd: ".", timeoutMs: 15000 });
    expect(result).toMatchObject({ exitCode: 7, timedOut: false, stdoutTruncated: true, stderr: "diagnostic", stderrTruncated: false });
    expect(result.stdout).toContain("[REDACTED:env_secret]"); expect(result.stdout).not.toContain("fixtureSecretValue");
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(25000); expect(result.stdoutBytes).toBeGreaterThan(100000);
    expect(await fs.readdir(f.root)).toEqual([]);
  });
  it("starts from a clean environment and removes its own temporary home without workspace logs", async () => {
    const f = await fixture(); vi.stubEnv("HERTA_PLUGIN_TEST_SECRET", "synthetic-env-value"); vi.stubEnv("HTTP_PROXY", "http://synthetic.invalid:1234");
    const result = await runApprovedPluginCommand({ argv: node("console.log(JSON.stringify({secret:process.env.HERTA_PLUGIN_TEST_SECRET??null,proxy:process.env.HTTP_PROXY??null,home:process.env.HOME,user:process.env.USERPROFILE,app:process.env.APPDATA}))") }, f.context);
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({ secret: null, proxy: null }); expect(output.home).toContain("herta-plugin-command-");
    expect(output.user).toBe(output.home); expect(output.app).toBe(output.home);
    await expect(fs.stat(output.home)).rejects.toMatchObject({ code: "ENOENT" }); expect(await fs.readdir(f.root)).toEqual([]);
  });
  it("requires approval even for classifier allow commands, and refusal does not execute", async () => {
    const f = await fixture(); f.authorize.mockResolvedValue(false);
    await expect(runApprovedPluginCommand({ argv: [process.execPath, "--version"] }, f.context)).rejects.toMatchObject({ code: "capability-denied" });
    expect(f.authorize).toHaveBeenCalledOnce(); expect(await fs.readdir(f.root)).toEqual([]);
  });
  it("rejects extra execution options, catastrophic commands, protected cwd and outside cwd before approval", async () => {
    const f = await fixture(); await fs.mkdir(join(f.root, ".herta"));
    for (const input of [
      { argv: node("0"), env: { TEST: "x" } }, { argv: ["rm", "-rf", "/"] },
      { argv: node("0"), cwd: ".herta" }, { argv: node("0"), cwd: "../outside" },
    ]) await expect(runApprovedPluginCommand(input, f.context)).rejects.toMatchObject({ code: expect.stringMatching(/invalid-input|capability-denied/) });
    expect(f.authorize).not.toHaveBeenCalled();
  });
  it("denies a cwd identity swapped while waiting for approval", async () => {
    const f = await fixture(); const cwd = join(f.root, "project"); await fs.mkdir(cwd);
    f.authorize.mockImplementation(async () => { await fs.rename(cwd, join(f.root, "old-project")); await fs.mkdir(cwd); return true; });
    await expect(runApprovedPluginCommand({ argv: node("console.log('must-not-run')"), cwd: "project" }, f.context)).rejects.toMatchObject({ code: "capability-denied" });
    expect(f.authorize).toHaveBeenCalledOnce();
  });
  it("closes internal-data reader carve-outs only for the plugin caller", async () => {
    const f = await fixture(); const file = join(f.root, ".herta", "logs", "synthetic.txt"); await fs.mkdir(dirname(file), { recursive: true }); await fs.writeFile(file, "synthetic session output");
    await withPermissionMode({ getPermissionMode: () => ({ mode: "workspace-edit", revision: 1 }) }, async () => {
      expect(await checkReaderArgvPaths(f.root, f.root, ["cat", file])).toBeNull();
      expect(await checkReaderArgvPaths(f.root, f.root, ["cat", file], { allowHarnessPaths: false })).toMatchObject({ code: "path_denied" });
    });
    await expect(runApprovedPluginCommand({ argv: ["cat", file] }, f.context)).rejects.toMatchObject({ code: "capability-denied" });
    expect(f.authorize).not.toHaveBeenCalled();
  });
  it("cancels an actually started safe process and does not accept stale results", async () => {
    const f = await fixture(); const task = runApprovedPluginCommand({ argv: node("require('fs').writeFileSync('started.txt','synthetic');setInterval(()=>{},1000)") }, f.context);
    let started = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      started = await fs.stat(join(f.root, "started.txt")).then(() => true, () => false);
      if (started) break; await new Promise(resolve => setTimeout(resolve, 25));
    }
    f.abort.abort(); await expect(task).rejects.toMatchObject({ code: "cancelled" }); expect(started).toBe(true);
  });
  it("returns bounded partial output on a real timeout", async () => {
    const f = await fixture(); const result = await runApprovedPluginCommand({ argv: node("console.log('started');setInterval(()=>{},1000)"), timeoutMs: 500 }, f.context);
    expect(result.timedOut).toBe(true); expect(result.stdout).toContain("started");
  });
  it.skipIf(process.platform !== "win32")("uses only the supplied trusted shim path and disables cmd AutoRun", async () => {
    const f = await fixture(); await fs.writeFile(join(f.root, "npm.cmd"), "@echo synthetic");
    const commandInterpreter = "C:\\Windows\\System32\\cmd.exe";
    const wrapped = resolveWindowsShim(["npm", "run", "build"], { path: f.root, commandInterpreter });
    expect(wrapped).toEqual({ kind: "wrapped", argv: [commandInterpreter, "/d", "/s", "/c", `""${join(f.root, "npm.cmd")}" "run" "build""`],
      windowsVerbatimArguments: true, shimPath: join(f.root, "npm.cmd") });
    expect(resolveWindowsShim(["npm", "run", "a&b"], { path: f.root, commandInterpreter })).toMatchObject({ kind: "unsafe_args" });
    expect(resolveWindowsShim(["npm", "run", "build"], { path: "", commandInterpreter })).toEqual({ kind: "unwrapped", argv: ["npm", "run", "build"] });
  });
  it.skipIf(process.platform !== "win32")("executes a real trusted build-shaped shim in a path containing spaces", async () => {
    const f = await fixture(); const tools = await fs.mkdtemp(join(tmpdir(), "herta-plugin-tools ")); roots.push(tools);
    await fs.writeFile(join(tools, "npm.cmd"), "@echo off\r\necho shim-safe %~1 %~2\r\n");
    vi.stubEnv("PATH", `${tools}${delimiter}${process.env.PATH ?? process.env.Path ?? ""}`);
    const result = await runApprovedPluginCommand({ argv: ["npm", "run", "build with spaces"] }, f.context);
    expect(result).toMatchObject({ exitCode: 0 }); expect(result.stdout).toContain("shim-safe run build with spaces"); expect(f.authorize).toHaveBeenCalledOnce();
  });
  it.skipIf(process.platform !== "win32")("decodes real cmd Unicode output and probes legacy pages only with the supplied clean environment", async () => {
    const f = await fixture(); const commandInterpreter = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
    const result = await runApprovedPluginCommand({ argv: [commandInterpreter, "/d", "/u", "/c", "echo 中文输出"] }, f.context);
    expect(result.exitCode).toBe(0); expect(result.stdout.trim()).toBe("中文输出"); expect(f.authorize).toHaveBeenCalledOnce();
    const probe = vi.mocked(childProcess.execFile).mockImplementationOnce(((...args: unknown[]) => {
      const callback = args.at(-1) as (error: null, stdout: Buffer, stderr: Buffer) => void;
      callback(null, Buffer.from("Active code page: 936"), Buffer.alloc(0));
      return {} as childProcess.ChildProcess;
    }) as typeof childProcess.execFile);
    const env = { SystemRoot: process.env.SystemRoot, HOME: f.root }, signal = new AbortController().signal;
    expect(await resolveCommandEncoding(["powershell", "-NoProfile", "-Command", "Write-Output 中文"], undefined,
      { commandInterpreter, env, cwd: f.root, signal, timeoutMs: 125 })).toBe("gb18030");
    expect(probe).toHaveBeenCalledWith(commandInterpreter, ["/d", "/c", "chcp"],
      expect.objectContaining({ env, cwd: f.root, signal, timeout: 125, maxBuffer: 1024 }), expect.any(Function));
  });
});
