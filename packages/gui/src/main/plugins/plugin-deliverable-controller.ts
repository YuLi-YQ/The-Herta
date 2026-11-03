import type { WorkspaceOperationContext } from "@herta/app-server";
import { promises as fs } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { PluginArtifact, PluginOutputOwner, PluginOutputProducer, PluginOutputReply, PluginPatchContent, PluginPatchProposal } from "../../shared/plugin-deliverables.js";
import { PluginBrokerFault, type PluginCapabilityContext } from "./capability-broker.js";
import type { ExecutablePluginOwner } from "./executable-plugin-controller.js";
import type { ExecutablePluginStore } from "./executable-plugin-store.js";
import { assertPluginArtifactCurrent, PluginArtifactFault, PluginArtifactStore, type PluginArtifactGuard } from "./plugin-artifact-store.js";
import { createPluginArtifactSaver } from "./plugin-artifact-save.js";
import { PLUGIN_PATCH_LIMITS, PluginPatchFault, PluginPatchService } from "./plugin-patch-service.js";
import type { PluginStorageCoordinator } from "./plugin-storage-coordinator.js";

export interface PluginDeliverableControllerOptions {
  readonly profile: string;
  readonly protectedPaths: readonly string[];
  readonly store: ExecutablePluginStore;
  readonly storage?: PluginStorageCoordinator;
  readonly owner: (scope: "chat" | "workbench") => ExecutablePluginOwner | null;
  readonly chooseArtifactPath?: (suggested: string) => Promise<{ canceled: boolean; filePath?: string }>;
  readonly withWorkspaceOperation?: <T>(owner: PluginOutputOwner, workspaceRoot: string, signal: AbortSignal,
    work: (lease: WorkspaceOperationContext) => Promise<T>) => Promise<T>;
}
interface Operation { readonly controller: AbortController; readonly guard: PluginArtifactGuard; readonly captured: ExecutablePluginOwner; close(): void }
interface ApplyJob {
  readonly owner: PluginOutputOwner;
  readonly id: string;
  readonly captured: ExecutablePluginOwner;
  readonly storeRevision: number;
  readonly original: PluginPatchContent;
  readonly abort: AbortController;
  readonly guard: PluginArtifactGuard;
  phase: "waiting" | "applying" | "cancelling";
  promise: Promise<void>;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const KINDS = new Set(["outputs-list", "artifact-read", "artifact-save", "patch-read", "patch-apply", "patch-cancel"]);
const RETRY = new Set(["pending", "denied", "cancelled", "failed"]);
const detached: PluginArtifactGuard = { signal: new AbortController().signal, assertCurrent() {} };
const keyFor = (owner: PluginOutputOwner, id: string) => JSON.stringify([owner.scope, owner.target, id]);
const fail = (message: string): PluginOutputReply => ({ ok: false, message });
const targetText = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
const samePath = (a: string, b: string) => process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
function combine(signals: readonly AbortSignal[]) {
  const abort = new AbortController(), cancel = () => abort.abort();
  for (const signal of signals) { if (signal.aborted) abort.abort(); else signal.addEventListener("abort", cancel, { once: true }); }
  return { signal: abort.signal, close() { for (const signal of signals) signal.removeEventListener("abort", cancel); } };
}

/** User-owned results have a longer lifetime than a popup, Guest run or installation grant. */
export function createPluginDeliverableController(options: PluginDeliverableControllerOptions) {
  const artifacts = new PluginArtifactStore(options.profile, { storage: options.storage });
  const patches = new PluginPatchService({ profile: options.profile, protectedPaths: options.protectedPaths, storage: options.storage });
  const lifetime = new AbortController(), requests = new Set<AbortController>(), jobs = new Map<string, ApplyJob>();
  // A service can return an honest terminal receipt even when persisting its status failed.
  // Keep a bounded overlay until a later read confirms durable terminal state.
  const outcomes = new Map<string, PluginPatchContent>();
  // Small keys outlive evicted preview bodies: an unknown write outcome cannot
  // become retryable merely because another session produced many later results.
  const uncertain = new Set<string>();
  let disposed = false, poll: ReturnType<typeof setInterval> | undefined;
  const saver = options.chooseArtifactPath ? createPluginArtifactSaver({ store: artifacts, profile: options.profile,
    protectedPaths: options.protectedPaths, choose: options.chooseArtifactPath }) : undefined;
  const current = (scope: PluginOutputOwner["scope"]) => { try { return options.owner(scope); } catch { return null; } };
  const sameIdentity = (start: ExecutablePluginOwner, now: ExecutablePluginOwner | null) =>
    !!now && start.id === now.id && start.revision === now.revision && start.workspaceRoot === now.workspaceRoot;
  function operation(owner: PluginOutputOwner): Operation {
    if (disposed || requests.size >= 64) throw new PluginBrokerFault(disposed ? "revoked" : "busy");
    const selected = current(owner.scope);
    if (!selected || selected.id !== owner.target) throw new PluginBrokerFault("revoked");
    const captured = Object.freeze({ ...selected }), controller = new AbortController(); requests.add(controller);
    const guard: PluginArtifactGuard = { signal: controller.signal, assertCurrent() {
      if (disposed || !sameIdentity(captured, current(owner.scope))) throw new PluginBrokerFault("revoked");
    } };
    return { controller, captured, guard, close() { requests.delete(controller); controller.abort(); } };
  }
  function sourceCurrent(producer: PluginOutputProducer): boolean {
    const installed = options.store.current(producer.id);
    return !!installed && installed.enabled && installed.contentHash === producer.contentHash && installed.grantRevision === producer.grantRevision
      && installed.manifest.capabilities.some(cap => cap.name === "workspace.proposePatch")
      && installed.grantedCapabilities.some(cap => cap.name === "workspace.proposePatch");
  }
  function assertApply(job: ApplyJob): void {
    if (disposed || job.abort.signal.aborted) throw new PluginBrokerFault("cancelled");
    const now = current(job.owner.scope), start = job.captured;
    if (!sameIdentity(start, now) || !now || now.planActive || now.permissionMode === "read-only"
      || now.permissionMode !== start.permissionMode || now.permissionRevision !== start.permissionRevision
      || options.store.hostRevision !== job.storeRevision || !sourceCurrent(job.original.proposal.producer)) throw new PluginBrokerFault("revoked");
    // A real workspace lease may itself make the owner busy. Its assertCurrent
    // owns the business-operation gate; checking that flag here would revoke ourselves.
  }
  function abortJob(job: ApplyJob) { job.phase = "cancelling"; job.abort.abort(); }
  function ensurePoll() {
    if (poll) return;
    poll = setInterval(() => { for (const job of jobs.values()) { try { assertApply(job); } catch { abortJob(job); } } }, 100);
    poll.unref?.();
  }
  const unsubscribe = options.store.subscribe(() => { for (const job of jobs.values()) abortJob(job); });

  function remember(key: string, content: PluginPatchContent) {
    outcomes.delete(key);
    if (content.proposal.status === "applied" || content.proposal.status === "needs-review") { uncertain.delete(key); return; }
    outcomes.set(key, content);
    while (outcomes.size > 100) outcomes.delete(outcomes.keys().next().value!);
  }
  async function reconcileUnknown(owner: PluginOutputOwner, id: string, guard: PluginArtifactGuard): Promise<PluginPatchContent | undefined> {
    const key = keyFor(owner, id); if (!uncertain.has(key)) return undefined;
    try {
      const marked = await patches.markNeedsReview(owner, id, guard);
      assertPluginArtifactCurrent(guard); uncertain.delete(key); remember(key, marked); return marked;
    } catch {
      assertPluginArtifactCurrent(guard);
      // Keep only the unresolved key. A refused disk write cannot be advertised
      // as a durable marker, and must not turn a later refresh into a safe retry.
      return undefined;
    }
  }

  function overlay(owner: PluginOutputOwner, proposal: PluginPatchProposal): PluginPatchProposal {
    const key = keyFor(owner, proposal.id), job = jobs.get(key), outcome = outcomes.get(key);
    // A real commit or an interrupted persisted write intent takes precedence.
    if (proposal.status === "applied" || proposal.status === "needs-review") { outcomes.delete(key); uncertain.delete(key); return proposal; }
    if (job) return { ...proposal, status: "applying", message: job.phase === "cancelling" ? "正在取消，请稍候…"
      : job.phase === "waiting" ? "正在检查修改…" : "正在应用修改…" };
    if (uncertain.has(key)) return { ...proposal, status: "needs-review", message: "上次操作的完成状态无法确认，请核对文件；不能直接重试。" };
    if (outcome && outcome.proposal.nextHash === proposal.nextHash && outcome.proposal.baseHash === proposal.baseHash) {
      if (outcome.proposal.status === proposal.status && outcome.proposal.message === proposal.message) outcomes.delete(key);
      return outcome.proposal;
    }
    return proposal;
  }
  async function settleFailure(job: ApplyJob): Promise<void> {
    const key = keyFor(job.owner, job.id);
    let content = job.original;
    try {
      content = await patches.read(job.owner, job.id, detached);
      if (["applied", "needs-review", "conflict"].includes(content.proposal.status)) { remember(key, content); return; }
      // A callback can fail before entering PatchService. Archive its still-pending
      // proposal, so a refresh/restart cannot silently pretend the attempt never ran.
      if (RETRY.has(content.proposal.status)) {
        try { content = await patches.cancel(job.owner, job.id, detached); } catch { /* Preserve a visible terminal overlay below. */ }
      }
    } catch {
      uncertain.add(key); outcomes.delete(key);
      // Detached is limited to archiving this already-known job's status. It
      // never authorizes a fresh workspace write or a new Guest capability.
      await reconcileUnknown(job.owner, job.id, detached);
      return;
    }
    const cancelled = job.abort.signal.aborted;
    remember(key, { ...content, proposal: { ...content.proposal, status: cancelled ? "cancelled" : "failed",
      message: cancelled ? "操作已停止。请核对提案记录后决定下一步。" : "应用未能完成，请检查提案记录；不会自动重试。" } });
  }
  async function runJob(job: ApplyJob): Promise<void> {
    const key = keyFor(job.owner, job.id);
    try {
      assertApply(job);
      const result = await options.withWorkspaceOperation!(job.owner, job.captured.workspaceRoot!, job.abort.signal, async lease => {
        const signals = combine([job.abort.signal, lease.signal, lifetime.signal]);
        const guard: PluginArtifactGuard = { signal: signals.signal, assertCurrent() {
          if (signals.signal.aborted) throw new PluginBrokerFault("cancelled"); assertApply(job); lease.assertCurrent();
        } };
        try {
          assertPluginArtifactCurrent(guard);
          return await patches.apply(job.owner, job.id, { workspaceRoot: job.captured.workspaceRoot!, guard,
            authorize: async preview => {
              job.phase = "waiting"; assertPluginArtifactCurrent(guard);
              const allowed = await lease.authorizeFileChange({ path: preview.proposal.path, diff: preview.diff, isNew: preview.before === null });
              assertPluginArtifactCurrent(guard); job.phase = "applying"; return allowed;
            } });
        } finally { signals.close(); }
      });
      // The service's commit receipt remains authoritative after cancellation.
      if (result.proposal.status === "pending" || result.proposal.status === "applying") {
        await settleFailure(job);
      } else remember(key, result);
    } catch { await settleFailure(job); }
    finally {
      if (jobs.get(key) === job) jobs.delete(key);
      job.abort.abort();
      if (!jobs.size) { clearInterval(poll); poll = undefined; }
    }
  }
  async function beginApply(owner: PluginOutputOwner, id: string, op: Operation): Promise<PluginOutputReply> {
    const key = keyFor(owner, id);
    if (jobs.has(key)) return { ok: true, applying: true };
    if (owner.scope !== "workbench" || !op.captured.workspaceRoot || op.captured.busy || op.captured.planActive || op.captured.permissionMode === "read-only") return fail("请在空闲工作台中检查权限，退出只读或计划模式后再应用。");
    if (!options.withWorkspaceOperation) return fail("当前工作台尚不能应用这份提案。");
    if (jobs.size >= 2) return fail("请先等待已有操作结束。");
    if (uncertain.size + jobs.size >= PLUGIN_PATCH_LIMITS.totalFiles) return fail("待核对的操作记录已达到本地限制，请先检查文件记录。");
    const original = await reconcileUnknown(owner, id, op.guard) ?? await patches.read(owner, id, op.guard); assertPluginArtifactCurrent(op.guard);
    const shown = overlay(owner, original.proposal);
    if (!RETRY.has(shown.status)) return fail("这份提案不能直接重试，请核对文件后重新提出修改。");
    const loaded = await options.store.request({ kind: "list" }); assertPluginArtifactCurrent(op.guard);
    if (!loaded.ok || !sourceCurrent(original.proposal.producer)) return fail("来源插件或权限已变化，请重新运行插件并检查新提案。");
    // Two requests may await disk validation concurrently; admit only one job.
    if (jobs.has(key)) return { ok: true, applying: true };
    if (jobs.size >= 2) return fail("已有工作区操作正在处理，请稍候。");
    if (uncertain.size + jobs.size >= PLUGIN_PATCH_LIMITS.totalFiles) return fail("待核对的操作记录已达到本地限制，请先检查文件记录。");
    const abort = new AbortController();
    const job: ApplyJob = { owner, id, captured: op.captured, storeRevision: options.store.hostRevision, original, abort,
      guard: { signal: abort.signal, assertCurrent() { assertApply(job); } }, phase: "waiting", promise: Promise.resolve() };
    assertApply(job); outcomes.delete(key); jobs.set(key, job); ensurePoll();
    job.promise = runJob(job); return { ok: true, applying: true };
  }

  async function request(raw: unknown): Promise<PluginOutputReply> {
    let op: Operation | undefined;
    try {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("文件操作请求格式不正确。");
      const input = raw as Record<string, unknown>;
      if (typeof input.kind !== "string" || !KINDS.has(input.kind) || (input.scope !== "chat" && input.scope !== "workbench") || !targetText(input.target)
        || Object.keys(input).some(key => !["kind", "scope", "target", ...(input.kind === "outputs-list" ? [] : ["id"])].includes(key))
        || (input.kind !== "outputs-list" && (typeof input.id !== "string" || !UUID.test(input.id)))) return fail("文件操作请求格式不正确。");
      const owner: PluginOutputOwner = Object.freeze({ scope: input.scope, target: input.target });
      op = operation(owner); assertPluginArtifactCurrent(op.guard);
      const id = input.id as string;
      if (input.kind === "outputs-list") {
        const files = await artifacts.list(owner, op.guard); assertPluginArtifactCurrent(op.guard);
        const changes = owner.scope === "workbench" ? await patches.list(owner, op.guard) : { items: [], damagedCount: 0 };
        assertPluginArtifactCurrent(op.guard);
        const proposals: PluginPatchProposal[] = [];
        for (const item of changes.items) {
          const reconciled = await reconcileUnknown(owner, item.id, op.guard); assertPluginArtifactCurrent(op.guard);
          proposals.push(overlay(owner, reconciled?.proposal ?? item));
        }
        return { ok: true, outputs: { artifacts: files.items, proposals, damagedArtifacts: files.damagedCount, damagedProposals: changes.damagedCount } };
      }
      if (input.kind === "artifact-read") {
        const read = await artifacts.read(owner, id, op.guard); assertPluginArtifactCurrent(op.guard);
        return { ok: true, artifact: read.artifact, content: read.content };
      }
      if (input.kind === "artifact-save") {
        if (!saver) return fail("当前窗口不能另存文件。");
        const result = await saver(owner, id, op.guard);
        if (result.saved) return { ok: true, saved: true };
        assertPluginArtifactCurrent(op.guard);
        return result.conflict ? fail("未覆盖目标文件，请检查文件状态或另选保存位置。") : result.failed ? fail("文件未能另存，原产物仍保留。") : { ok: true, saved: false };
      }
      if (owner.scope !== "workbench") return fail("修改提案只属于工作台。");
      if (input.kind === "patch-apply") return await beginApply(owner, id, op);
      if (input.kind === "patch-cancel") {
        const job = jobs.get(keyFor(owner, id));
        if (job) { abortJob(job); return { ok: true, applying: true }; }
        const saved = await reconcileUnknown(owner, id, op.guard) ?? await patches.read(owner, id, op.guard); assertPluginArtifactCurrent(op.guard);
        if (!RETRY.has(overlay(owner, saved.proposal).status)) return fail("这份提案已经结束，请先核对它的结果。");
        const cancelled = await patches.cancel(owner, id, op.guard); assertPluginArtifactCurrent(op.guard);
        outcomes.delete(keyFor(owner, id)); return { ok: true, patch: cancelled };
      }
      const patch = await reconcileUnknown(owner, id, op.guard) ?? await patches.read(owner, id, op.guard); assertPluginArtifactCurrent(op.guard);
      return { ok: true, patch: { ...patch, proposal: overlay(owner, patch.proposal) } };
    } catch (error) {
      if (error instanceof PluginBrokerFault && ["cancelled", "revoked"].includes(error.code)) return fail("会话或操作已变化，请在当前会话重新打开文件。");
      if (error instanceof PluginArtifactFault && error.reason === "limit" || error instanceof PluginPatchFault && error.reason === "limit") return fail("文件记录达到本地限制，原资料已保留。");
      return fail("文件记录暂时无法读取或处理，原资料已保留。");
    } finally { op?.close(); }
  }
  function creation(owner: PluginOutputOwner, producer: PluginOutputProducer, context: PluginCapabilityContext) {
    const op = operation(owner), binding = context.binding;
    if (binding.scope !== owner.scope || binding.sessionId !== owner.target || binding.pluginId !== producer.id
      || binding.contentHash !== producer.contentHash || binding.grantRevision !== producer.grantRevision
      || binding.sessionRevision !== op.captured.revision || binding.permissionRevision !== op.captured.permissionRevision) { op.close(); throw new PluginBrokerFault("revoked"); }
    const signals = combine([context.signal, op.guard.signal, lifetime.signal]);
    const guard: PluginArtifactGuard = { signal: signals.signal, assertCurrent() { context.assertCurrent(); op.guard.assertCurrent(); } };
    return { op, guard, close() { signals.close(); op.close(); } };
  }
  return {
    request,
    /** Maintenance never cancels a save dialog, approval or committed result to
     * manufacture an idle state. Capture this before closing new admission. */
    isBusy() { return requests.size > 0 || jobs.size > 0; },
    async createArtifact(owner: PluginOutputOwner, producer: PluginOutputProducer, runId: string, args: { name: string; mime: string; text: string }, context: PluginCapabilityContext): Promise<PluginArtifact> {
      const held = creation(owner, producer, context);
      try { return await artifacts.create(owner, producer, runId, args, held.guard); } finally { held.close(); }
    },
    async createProposal(owner: PluginOutputOwner, producer: PluginOutputProducer, runId: string, args: { path: string; baseHash: string | null; content: string }, workspaceRoot: string, context: PluginCapabilityContext, expectedPhysicalRoot?: string): Promise<PluginPatchProposal> {
      const selected = Object.freeze({ scope: owner.scope, target: owner.target }), source = Object.freeze({ ...producer });
      const input = Object.freeze({ path: args.path, baseHash: args.baseHash, content: args.content });
      const held = creation(selected, source, context);
      try {
        const actual = held.op.captured;
        if (selected.scope !== "workbench" || actual.workspaceRoot !== workspaceRoot || actual.busy || actual.planActive || actual.permissionMode === "read-only") throw new PluginBrokerFault("capability-denied");
        let root = workspaceRoot;
        if (expectedPhysicalRoot !== undefined) {
          if (typeof expectedPhysicalRoot !== "string" || !isAbsolute(expectedPhysicalRoot) || expectedPhysicalRoot.length > 32768) throw new PluginBrokerFault("invalid-input");
          const physical = await fs.realpath(workspaceRoot); assertPluginArtifactCurrent(held.guard);
          if (!samePath(physical, expectedPhysicalRoot)) throw new PluginBrokerFault("revoked");
          // The original handler owns this run-start realpath. Never resolve the
          // logical alias again in the service after the validation await.
          root = expectedPhysicalRoot;
        }
        return await patches.create(selected, source, runId, input, root, held.guard);
      } finally { held.close(); }
    },
    dispose() {
      if (disposed) return;
      disposed = true; unsubscribe(); lifetime.abort();
      for (const controller of requests) controller.abort();
      for (const job of jobs.values()) abortJob(job);
      clearInterval(poll); poll = undefined;
    },
  };
}
