import { promises as fs, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isPathInside, withPermissionMode, type CommandConsequence, type RiskLevel } from "@herta/core";
import { isCredentialPath } from "./credential-denylist.js";
import { resolveSafePath } from "./path-safety.js";
import { namesProtectedApplicationPath } from "./permission-mode-policy.js";
import { classifyCommand } from "./run-command/classifier.js";
import { decodeCommandOutput, resolveCommandEncoding, type CommandEncoding } from "./run-command/output-encoding.js";
import { checkReaderArgvPaths } from "./run-command/reader-guard.js";
import { redactSecrets } from "./run-command/redactor.js";
import { runCommandWriteGuard } from "./run-command/rule.js";
import { runCommand } from "./run-command/runner.js";
import { resolveWindowsShim } from "./run-command/shim-wrapper.js";

export interface PluginCommandInput { readonly argv: readonly string[]; readonly cwd?: string; readonly timeoutMs?: number }
export interface PluginCommandPreview {
  readonly argv: readonly string[]; readonly cwd: string; readonly timeoutMs: number;
  readonly reason: string; readonly risk: RiskLevel; readonly code?: string; readonly consequence?: CommandConsequence;
}
export interface PluginCommandContext {
  readonly workspaceRoot: string; readonly expectedPhysicalRoot: string; readonly protectedPaths: readonly string[];
  readonly signal: AbortSignal; assertCurrent(): void; authorize(preview: PluginCommandPreview): Promise<boolean>;
}
export interface PluginCommandResult {
  readonly exitCode: number | null; readonly signal: string | null; readonly timedOut: boolean; readonly durationMs: number;
  readonly stdout: string; readonly stderr: string; readonly stdoutBytes: number; readonly stderrBytes: number;
  readonly stdoutTruncated: boolean; readonly stderrTruncated: boolean;
}
export type PluginCommandFaultCode = "invalid-input" | "capability-denied" | "cancelled" | "revoked" | "runner-unavailable" | "host-error";
export class PluginCommandFault extends Error {
  constructor(readonly code: PluginCommandFaultCode) { super(code); this.name = "PluginCommandFault"; }
}
const CAPTURE_BYTES = 64 * 1024;
const RETURN_BYTES = 24 * 1024;
function fail(code: PluginCommandFaultCode): never { throw new PluginCommandFault(code); }
const samePath = (a: string, b: string) => process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
const sameIdentity = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
const sameExecutable = (a: Stats, b: Stats) => sameIdentity(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
function live(context: PluginCommandContext): void {
  if (context.signal.aborted) fail("cancelled");
  try { context.assertCurrent(); } catch { fail(context.signal.aborted ? "cancelled" : "revoked"); }
}
function inputCopy(input: PluginCommandInput): Required<PluginCommandInput> {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("invalid-input");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).some(key => typeof key !== "string" || !["argv", "cwd", "timeoutMs"].includes(key)
    || !("value" in descriptors[key]!))) fail("invalid-input");
  const argv = descriptors.argv?.value, cwd = descriptors.cwd?.value ?? ".", timeoutMs = descriptors.timeoutMs?.value ?? 15000;
  if (!Array.isArray(argv) || !argv.length || argv.length > 64 || argv.some((arg, index) => typeof arg !== "string"
    || arg.length > 2048 || (!index && !arg.trim()) || /[\x00-\x1f\x7f]/.test(arg))
    || typeof cwd !== "string" || !cwd || cwd.length > 1024 || /[\x00-\x1f\x7f:]/.test(cwd) || isAbsolute(cwd)
    || (cwd !== "." && cwd.split(/[\\/]/).some(part => !part || part === "." || part === ".." || part.trim() !== part || part.endsWith(".")))
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) fail("invalid-input");
  if (Buffer.byteLength(JSON.stringify(argv), "utf8") > 65536) fail("invalid-input");
  return { argv: Object.freeze([...argv]), cwd, timeoutMs };
}
async function trustedPath(root: string, protectedPaths: readonly string[]): Promise<string> {
  const entries: string[] = [];
  for (const part of (process.env.PATH ?? process.env.Path ?? "").split(delimiter)) {
    if (!part || !isAbsolute(part) || /[\x00-\x1f]/.test(part)) continue;
    try {
      const path = await fs.realpath(part);
      if (!(await fs.stat(path)).isDirectory() || isPathInside(root, path)
        || protectedPaths.some(blocked => isPathInside(blocked, path))) continue;
      if (!entries.some(existing => samePath(existing, path))) entries.push(path);
    } catch { /* Unavailable PATH entries do not become cwd-relative searches. */ }
  }
  return entries.join(delimiter);
}
async function executable(head: string, cwd: string, path: string): Promise<string> {
  const candidates = /[\\/]/.test(head) || isAbsolute(head) ? [resolve(cwd, head)]
    : path.split(delimiter).filter(Boolean).flatMap(dir => process.platform === "win32" && !/\.(?:exe|com)$/i.test(head)
      ? [join(dir, `${head}.exe`), join(dir, `${head}.com`)] : [join(dir, head)]);
  for (const candidate of candidates) {
    try {
      const resolved = await fs.realpath(candidate);
      if (namesProtectedApplicationPath(resolved) || isCredentialPath(resolved)) fail("capability-denied");
      if (/\.(?:cmd|bat)$/i.test(resolved)) fail("capability-denied");
      if ((await fs.stat(resolved)).isFile()) return resolved;
    } catch (error) { if (error instanceof PluginCommandFault) throw error; }
  }
  return fail("runner-unavailable");
}
function boundedOutput(bytes: Buffer, rawBytes: number, encoding: CommandEncoding): { text: string; truncated: boolean } {
  const redacted = Buffer.from(redactSecrets(decodeCommandOutput(bytes, encoding)).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "�"), "utf8");
  const truncated = rawBytes > bytes.length || redacted.length > RETURN_BYTES;
  const text = redacted.length > RETURN_BYTES ? `${redacted.subarray(0, RETURN_BYTES).toString("utf8")}\n[output truncated]` : redacted.toString("utf8");
  return { text, truncated };
}
/** Explicitly approved local process execution, NOT an OS filesystem/network
 * sandbox. No host ToolContext, personal environment, session logs or background
 * handles cross this boundary. Existing runner termination is best-effort tree
 * cleanup, not a Windows Job Object guarantee for deliberately detached children. */
export async function runApprovedPluginCommand(input: PluginCommandInput, context: PluginCommandContext): Promise<PluginCommandResult> {
  let temporary: { path: string; parent: string; stamp: Stats } | undefined;
  try {
    live(context);
    const checked = inputCopy(input);
    return await withPermissionMode({ getPermissionMode: () => ({ mode: "workspace-edit", revision: 1 }),
      permissionProtectedPaths: context.protectedPaths }, async () => {
      const root = await fs.realpath(context.workspaceRoot); live(context);
      if (!samePath(root, context.expectedPhysicalRoot)) fail("capability-denied");
      const safe = await resolveSafePath(root, checked.cwd); live(context);
      if (!safe.ok || !isPathInside(root, safe.resolved)) fail("capability-denied");
      const cwd = safe.resolved, rootStamp = await fs.stat(root), cwdStamp = await fs.stat(cwd); live(context);
      if (!rootStamp.isDirectory() || !cwdStamp.isDirectory() || checked.argv.some(namesProtectedApplicationPath)) fail("capability-denied");
      const verdict = classifyCommand(checked.argv, { writeGuard: runCommandWriteGuard(root, cwd) });
      if (verdict.kind === "block" || await checkReaderArgvPaths(root, cwd, checked.argv, { allowHarnessPaths: false })) fail("capability-denied");
      const path = await trustedPath(root, context.protectedPaths); live(context);
      const systemRoot = process.platform === "win32" ? await fs.realpath(process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows") : undefined;
      const shim = resolveWindowsShim(checked.argv, { path, commandInterpreter: systemRoot ? join(systemRoot, "System32", "cmd.exe") : "" });
      if (shim.kind === "unsafe_args") fail("invalid-input");
      const command = await executable(shim.argv[0]!, cwd, path), commandStamp = await fs.stat(command); live(context);
      const execArgv = Object.freeze([command, ...shim.argv.slice(1)]);
      const shimFile = shim.kind === "wrapped" ? shim.shimPath : undefined;
      const shimStamp = shimFile ? await fs.stat(shimFile) : undefined;
      // The classifier never auto-approves plugin commands. Its decision only
      // adds trusted context to the mandatory, one-command permission card.
      const preview: PluginCommandPreview = Object.freeze({ argv: checked.argv, cwd: relative(root, cwd) || ".", timeoutMs: checked.timeoutMs,
        reason: verdict.kind === "ask" ? verdict.reason : "Run this plugin-requested local project command.",
        risk: verdict.kind === "ask" ? verdict.risk : "workspace_write", code: verdict.kind === "ask" ? verdict.code : "plugin_command_ask",
        ...(verdict.kind === "ask" && verdict.consequence ? { consequence: verdict.consequence } : {}) });
      live(context); if (!await context.authorize(preview)) fail("capability-denied"); live(context);
      const parent = await fs.realpath(tmpdir());
      const temp = await fs.mkdtemp(join(parent, "herta-plugin-command-"));
      temporary = { path: temp, parent, stamp: await fs.lstat(temp) };
      const env: NodeJS.ProcessEnv = { PATH: path, HOME: temp, USERPROFILE: temp, APPDATA: temp, LOCALAPPDATA: temp,
        TMPDIR: temp, TMP: temp, TEMP: temp, XDG_CONFIG_HOME: temp, XDG_CACHE_HOME: temp, XDG_DATA_HOME: temp,
        CI: "1", NO_COLOR: "1", TERM: "dumb", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(temp, "gitconfig"),
        NPM_CONFIG_USERCONFIG: join(temp, "npmrc"), NPM_CONFIG_CACHE: join(temp, "npm-cache"), PYTHONNOUSERSITE: "1" };
      if (systemRoot) { env.SystemRoot = systemRoot; env.WINDIR = systemRoot; env.ComSpec = join(systemRoot, "System32", "cmd.exe"); }
      const executionStart = process.hrtime.bigint();
      const elapsed = () => Number((process.hrtime.bigint() - executionStart) / 1_000_000n);
      const executionSignal = AbortSignal.any([context.signal, AbortSignal.timeout(checked.timeoutMs)]);
      // Resolve from the original program, not cmd used internally for npm's
      // shim. Legacy shells need the console code page; node/project tools keep
      // UTF-8. The fixed host probe shares this command's time/cancel budget.
      const encoding = await resolveCommandEncoding(checked.argv, undefined, systemRoot ? {
        commandInterpreter: join(systemRoot, "System32", "cmd.exe"), env, cwd: temp,
        signal: executionSignal, timeoutMs: checked.timeoutMs,
      } : undefined);
      live(context);
      const recheck = await resolveSafePath(root, checked.cwd);
      if (!recheck.ok || !samePath(recheck.resolved, cwd) || !samePath(await fs.realpath(context.workspaceRoot), root)
        || !sameIdentity(rootStamp, await fs.stat(root)) || !sameIdentity(cwdStamp, await fs.stat(cwd))
        || !samePath(await fs.realpath(command), command) || !sameExecutable(commandStamp, await fs.stat(command))
        || (shimFile && (!samePath(await fs.realpath(shimFile), shimFile) || !sameExecutable(shimStamp!, await fs.stat(shimFile))))
        || await checkReaderArgvPaths(root, cwd, checked.argv, { allowHarnessPaths: false })) fail("capability-denied");
      live(context);
      const remaining = checked.timeoutMs - elapsed();
      if (remaining <= 0 || executionSignal.aborted) return Object.freeze({ exitCode: null, signal: null, timedOut: true, durationMs: elapsed(),
        stdout: "", stderr: "", stdoutBytes: 0, stderrBytes: 0, stdoutTruncated: false, stderrTruncated: false });
      const raw = await runCommand(execArgv, { cwd, timeoutMs: remaining, signal: executionSignal, maxBytesPerStream: CAPTURE_BYTES, env,
        ...(shim.kind === "wrapped" && shim.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}) });
      live(context);
      if (raw.cause === "aborted") fail("cancelled");
      if (raw.cause === "not_found" || raw.cause === "spawn_error") fail("runner-unavailable");
      const stdout = boundedOutput(raw.stdout, raw.stdoutBytes, encoding), stderr = boundedOutput(raw.stderr, raw.stderrBytes, encoding);
      return Object.freeze({ exitCode: raw.exitCode, signal: raw.signal, timedOut: raw.timedOut, durationMs: elapsed(),
        stdout: stdout.text, stderr: stderr.text, stdoutBytes: raw.stdoutBytes, stderrBytes: raw.stderrBytes,
        stdoutTruncated: stdout.truncated, stderrTruncated: stderr.truncated });
    });
  } catch (error) {
    if (error instanceof PluginCommandFault) throw error;
    live(context); throw new PluginCommandFault("host-error");
  } finally {
    // Delete only the temp directory we created, with stable parent/root identity.
    // A child replacing it with a link never causes recursive deletion elsewhere.
    if (temporary) {
      try {
        const stamp = await fs.lstat(temporary.path);
        if (!stamp.isSymbolicLink() && stamp.isDirectory() && sameIdentity(stamp, temporary.stamp)
          && samePath(await fs.realpath(temporary.path), temporary.path)
          && samePath(await fs.realpath(dirname(temporary.path)), temporary.parent)
          && isPathInside(temporary.parent, temporary.path, { strict: true })
          && basename(temporary.path).startsWith("herta-plugin-command-")) await fs.rm(temporary.path, { recursive: true, force: true });
      } catch { /* A failed cleanup never rewrites a completed command outcome. */ }
    }
  }
}
