import { randomUUID } from "node:crypto";
import { abortError, permissionModeCoversRequest, type PermissionModeState, type PermissionRequest } from "@herta/core";
import type { PluginCommandPreview } from "@herta/tools";

export interface WorkspaceOperationContext {
  readonly signal: AbortSignal;
  assertCurrent(): void;
  /** Called only with a host-validated, project-contained file preview. */
  authorizeFileChange(change: { readonly path: string; readonly diff: string; readonly isNew: boolean }): Promise<boolean>;
  /** Every local plugin command requires a fresh explicit decision, in every mode. */
  authorizeCommand(preview: PluginCommandPreview): Promise<boolean>;
  /** Approval summary only: bodies and headers never enter the permission card. */
  authorizeNetworkRequest(change: {
    readonly url: string;
    readonly method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";
    readonly bodyBytes: number;
  }): Promise<boolean>;
}
export interface WorkspaceOperationRequest { readonly workspaceRoot: string; readonly signal: AbortSignal }
export class WorkspaceOperationFault extends Error {
  constructor(readonly reason: "busy" | "unavailable" | "revoked" | "read-only") {
    super(reason === "busy" ? "当前任务还有操作未结束。" : "工作区操作已失效，请重新检查权限与提案。");
    this.name = "WorkspaceOperationFault";
  }
}
interface State {
  readonly closed: boolean;
  readonly busy: boolean;
  readonly workspaceRoot: string;
  readonly permission?: PermissionModeState;
  readonly planLocked: boolean;
}

function commandSnapshot(raw: PluginCommandPreview): PluginCommandPreview {
  const invalid = (): never => { throw new WorkspaceOperationFault("unavailable"); };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (Reflect.ownKeys(raw).some(key => typeof key !== "string"
    || !["argv", "cwd", "timeoutMs", "reason", "risk", "code", "consequence"].includes(key)
    || !("value" in descriptors[key as keyof typeof descriptors]!))) return invalid();
  const data = Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
  const text = (value: unknown, max: number, empty = false): value is string => {
    if (typeof value !== "string" || value.length > max || (!empty && !value.trim())
      || /[\u0000-\u001f\u007f]/.test(value)) return false;
    try { encodeURI(value); return true; } catch { return false; }
  };
  if (!Array.isArray(data.argv) || data.argv.length < 1 || data.argv.length > 64
    || Object.getPrototypeOf(data.argv) !== Array.prototype) return invalid();
  const args = Object.getOwnPropertyDescriptors(data.argv), argv: string[] = [];
  if (Reflect.ownKeys(data.argv).length !== data.argv.length + 1) return invalid();
  for (let index = 0; index < data.argv.length; index++) {
    const descriptor = args[String(index)];
    if (!descriptor || !("value" in descriptor) || !text(descriptor.value, 2048, index > 0)) return invalid();
    argv.push(descriptor.value);
  }
  if (Buffer.byteLength(JSON.stringify(argv), "utf8") > 65536 || !text(data.cwd, 1024)
    || /^[\/\\]/.test(data.cwd) || /[:<>"|?*]/.test(data.cwd)
    || (data.cwd !== "." && data.cwd.split(/[\/\\]/).some(part => !part || part === "." || part === ".." || part.trim() !== part || part.endsWith(".")))
    || typeof data.timeoutMs !== "number" || !Number.isSafeInteger(data.timeoutMs) || data.timeoutMs < 1 || data.timeoutMs > 60000
    || !text(data.reason, 4000) || !["workspace_read", "workspace_write", "workspace_destructive", "network"].includes(data.risk)
    || (data.code !== undefined && (typeof data.code !== "string" || !/^[a-z0-9_-]{1,100}$/i.test(data.code)))
    || (data.consequence !== undefined && !["discards_uncommitted", "deletes_untracked", "deletes_stash", "rewrites_local_history",
      "rewrites_remote_history", "concludes_in_progress_operation"].includes(data.consequence))) return invalid();
  return Object.freeze({ argv: Object.freeze(argv), cwd: data.cwd, timeoutMs: data.timeoutMs, reason: data.reason, risk: data.risk,
    ...(data.code === undefined ? {} : { code: data.code }), ...(data.consequence === undefined ? {} : { consequence: data.consequence }) });
}

/** One host-side write/approval lease, separate from model turns and their history. */
export class WorkspaceOperationGate {
  private active: { abort: AbortController; settled: Promise<void> } | undefined;
  private closed = false;
  constructor(private readonly deps: {
    state(): State;
    ask(request: PermissionRequest, signal: AbortSignal): Promise<"allow" | "deny">;
  }) {}
  get busy(): boolean { return this.active !== undefined; }
  assertIdle(): void { if (this.busy) throw new WorkspaceOperationFault("busy"); }
  async run<T>(request: WorkspaceOperationRequest, work: (context: WorkspaceOperationContext) => Promise<T>): Promise<T> {
    this.assertIdle();
    if (!request || typeof request !== "object" || Array.isArray(request)
      || Object.keys(request).some(key => !["workspaceRoot", "signal"].includes(key))
      || typeof request.workspaceRoot !== "string" || !request.workspaceRoot.trim() || request.workspaceRoot.length > 32768
      || !(request.signal instanceof AbortSignal) || typeof work !== "function") throw new WorkspaceOperationFault("unavailable");
    const observed = this.deps.state();
    const start = { ...observed, permission: observed.permission ? { ...observed.permission } : undefined };
    const permission = start.permission;
    if (this.closed || start.closed || start.busy || start.workspaceRoot !== request.workspaceRoot) throw new WorkspaceOperationFault("unavailable");
    if (!permission || !Number.isSafeInteger(permission.revision) || permission.revision < 1 || !["workspace-edit", "full-access"].includes(permission.mode) || start.planLocked) throw new WorkspaceOperationFault("read-only");
    if (request.signal.aborted) throw abortError("workspace operation cancelled");
    const abort = new AbortController();
    let settle!: () => void;
    const settled = new Promise<void>(resolve => { settle = resolve; });
    const owned = { abort, settled }; this.active = owned;
    const externalAbort = () => abort.abort();
    request.signal.addEventListener("abort", externalAbort, { once: true });
    const assertCurrent = () => {
      if (abort.signal.aborted || request.signal.aborted) throw abortError("workspace operation cancelled");
      const current = this.deps.state();
      if (this.active !== owned || this.closed || current.closed || current.busy || current.workspaceRoot !== start.workspaceRoot
        || current.planLocked || current.permission?.mode !== permission.mode || current.permission.revision !== permission.revision) throw new WorkspaceOperationFault("revoked");
    };
    // A native command or an approval wait may be quiet for a long time. Revoke
    // its signal even without renderer polling; explicit checks around effects
    // still determine whether each operation may proceed.
    const watch = setInterval(() => {
      try { assertCurrent(); } catch { abort.abort(); }
    }, 100);
    watch.unref?.();
    const context: WorkspaceOperationContext = {
      signal: abort.signal, assertCurrent,
      authorizeCommand: async preview => {
        assertCurrent();
        const selected = commandSnapshot(preview), id = randomUUID();
        const input = Object.freeze({ argv: selected.argv, cwd: selected.cwd, timeoutMs: selected.timeoutMs });
        const prompt: PermissionRequest = Object.freeze({ id,
          call: Object.freeze({ id, tool: "plugin_run_command", input }), argv: selected.argv,
          code: "plugin_command_ask", risk: selected.risk,
          reason: `插件请求执行本机命令。工作目录：${selected.cwd}；运行时限：${selected.timeoutMs} 毫秒。本机进程可以访问本机文件和网络，请核对完整命令后决定是否允许本次执行。分类说明：${selected.reason}`,
          ...(selected.consequence === undefined ? {} : { consequence: selected.consequence }) });
        assertCurrent();
        // Never use tier coverage here. The unique tool/code also prevents this
        // approval from inheriting ordinary command cache, rules or trust grants.
        const answer = await this.deps.ask(prompt, abort.signal);
        assertCurrent();
        return answer === "allow";
      },
      authorizeFileChange: async change => {
        assertCurrent();
        // The path and diff are computed by the trusted file service, never raw
        // plugin permissions. Only ordinary create/edit classes enter this gate.
        if (!change || typeof change !== "object" || Array.isArray(change) || Object.keys(change).some(key => !["path", "diff", "isNew"].includes(key))
          || typeof change.path !== "string" || !change.path.trim() || /[\x00-\x1f:]/.test(change.path) || /^[\/\\]/.test(change.path)
          || change.path.split(/[\/\\]+/).some(part => part === ".." || part === ".") || change.path.length > 1024
          || typeof change.diff !== "string" || change.diff.length > 512000 || typeof change.isNew !== "boolean") throw new WorkspaceOperationFault("unavailable");
        const id = randomUUID();
        const prompt: PermissionRequest = { id, call: { id, tool: "plugin_workspace_patch", input: { path: change.path } },
          reason: `Apply the reviewed plugin change to ${change.path}.`, risk: "workspace_write",
          code: change.isNew ? "write_new_file_ask" : "edit_file_ask", files: [change.path], diff: change.diff };
        // Same tier coverage as RulePermissionEngine. The installation grant
        // alone never substitutes for the current workspace mode and plan lock.
        if (permissionModeCoversRequest(permission.mode, prompt)) return true;
        const answer = await this.deps.ask(prompt, abort.signal);
        assertCurrent();
        return answer === "allow";
      },
      authorizeNetworkRequest: async change => {
        assertCurrent();
        // Trusted host summaries still have a strict data-only shape. Capture
        // primitives before any await; neither caller mutation nor an accessor
        // can change the destination the user approved.
        if (!change || typeof change !== "object" || Array.isArray(change)
          || ![Object.prototype, null].includes(Object.getPrototypeOf(change))) throw new WorkspaceOperationFault("unavailable");
        const keys = Reflect.ownKeys(change), descriptors = Object.getOwnPropertyDescriptors(change);
        if (keys.length !== 3 || keys.some(key => typeof key !== "string" || !["url", "method", "bodyBytes"].includes(key))
          || keys.some(key => !("value" in descriptors[key as keyof typeof descriptors]!))) throw new WorkspaceOperationFault("unavailable");
        const { url, method, bodyBytes } = { url: descriptors.url!.value, method: descriptors.method!.value, bodyBytes: descriptors.bodyBytes!.value };
        if (typeof url !== "string" || !url || url.length > 2048 || /[\u0000-\u0020\u007f\\#]/.test(url)
          || typeof method !== "string" || !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(method)
          || typeof bodyBytes !== "number" || !Number.isSafeInteger(bodyBytes) || bodyBytes < 0 || bodyBytes > 65536) throw new WorkspaceOperationFault("unavailable");
        let destination: URL;
        try { encodeURI(url); destination = new URL(url); }
        catch { throw new WorkspaceOperationFault("unavailable"); }
        if (destination.protocol !== "https:" || destination.username || destination.password || destination.hash) throw new WorkspaceOperationFault("unavailable");
        const input = Object.freeze({ method, url: destination.href, bodyBytes }), id = randomUUID();
        const prompt: PermissionRequest = Object.freeze({ id,
          call: Object.freeze({ id, tool: "plugin_network_request", input }),
          reason: `插件请求联网：${method} ${input.url}（请求正文 ${bodyBytes} 字节）。是否允许本次请求？`,
          risk: "network", code: "plugin_network_request_ask" });
        assertCurrent();
        if (permissionModeCoversRequest(permission.mode, prompt)) return true;
        // The existing broker's 60-second capability budget includes this wait.
        // Its abort signal closes approval; the gate does not extend that budget.
        const answer = await this.deps.ask(prompt, abort.signal);
        assertCurrent();
        return answer === "allow";
      },
    };
    try { assertCurrent(); return await work(context); }
    finally { clearInterval(watch); request.signal.removeEventListener("abort", externalAbort); abort.abort(); if (this.active === owned) this.active = undefined; settle(); }
  }
  /** Closing aborts owned work; the session waits for its settlement before teardown. */
  close(): Promise<void> | null {
    this.closed = true;
    const active = this.active;
    if (!active) return null;
    active.abort.abort(); return active.settled;
  }
}
