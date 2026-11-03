import { randomUUID } from "node:crypto";
import { EXECUTABLE_PLUGIN_CAPABILITY_NAMES, EXECUTABLE_PLUGIN_LIMITS } from "../../shared/executable-plugins.js";
import { PLUGIN_AUTHORING_BRIEF_MAX } from "../../shared/plugin-authoring-guide.js";
import { PLUGIN_RUNTIME_LIMITS } from "../../shared/plugin-runtime.js";
import type { PluginTrialResult } from "../../shared/plugin-trial.js";
import type { PluginWorkshopDraft, PluginWorkshopInstallation, PluginWorkshopJob, PluginWorkshopModel, PluginWorkshopReply, PluginWorkshopRequest, PluginWorkshopTarget } from "../../shared/plugin-workshop.js";
import { ExecutablePluginStoreFault, type ExecutablePluginStore } from "./executable-plugin-store.js";
import { createPluginGenerator, PluginGeneratorFault } from "./plugin-generator.js";
import type { PluginRuntimeService } from "./plugin-runtime-service.js";
import { getPluginStorageCoordinator, PluginStorageBudgetFault, type PluginStorageCoordinator, type PluginStorageGuard } from "./plugin-storage-coordinator.js";
import { createPluginTrialService, PLUGIN_TRIAL_LIMITS, PluginTrialFault, type PluginTrialTask } from "./plugin-trial-service.js";
import { PluginWorkshopFault, PluginWorkshopStore } from "./plugin-workshop-store.js";

export interface PluginWorkshopControllerOptions {
  readonly profile: string;
  readonly storage?: PluginStorageCoordinator;
  readonly store: ExecutablePluginStore;
  readonly runtime: Pick<PluginRuntimeService, "start">;
  /** Other host operations only: this controller checks its own occupancy separately. */
  readonly isHostBusy: () => boolean;
  readonly generator?: Pick<ReturnType<typeof createPluginGenerator>, "generate"> & { dispose?(): void };
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const MESSAGES = {
  invalid: "工坊请求格式不正确，请重新打开后再试。",
  changed: "制作草稿、安装列表或当前目标已变化，请重新检查。",
  busy: "还有操作未结束，请先取消或等待结束。",
  cancelled: "制作操作已取消；未采用迟到结果。",
  unavailable: "制作操作未完成；已有草稿仍保留，请重新检查。",
} as const;
export class PluginWorkshopControllerFault extends Error {
  constructor(readonly reason: keyof typeof MESSAGES) { super(MESSAGES[reason]); this.name = "PluginWorkshopControllerFault"; }
}
function fail(reason: keyof typeof MESSAGES): never { throw new PluginWorkshopControllerFault(reason); }
function object(raw: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return fail("invalid");
  const descriptors = Object.getOwnPropertyDescriptors(raw), keys = Reflect.ownKeys(raw);
  if (keys.some(key => typeof key !== "string" || ![...required, ...optional].includes(key) || !("value" in descriptors[key]!))
    || required.some(key => !Object.hasOwn(descriptors, key))) return fail("invalid");
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}
function text(value: unknown, max: number, allowBlank = false): string {
  if (typeof value !== "string" || value.length > max || (!allowBlank && !value.trim()) || value.includes("\0")
    || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) return fail("invalid");
  return value;
}
function counter(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) >= Number.MAX_SAFE_INTEGER) return fail("invalid");
  return value as number;
}
function id(value: unknown): string { if (typeof value !== "string" || !UUID.test(value)) return fail("invalid"); return value; }
function target(value: unknown, nullable = false): PluginWorkshopTarget | null {
  if (nullable && value === null) return null;
  const raw = object(value, ["id", "revision", "contentHash"]);
  if (typeof raw.contentHash !== "string" || !HASH.test(raw.contentHash)) return fail("invalid");
  return Object.freeze({ id: id(raw.id), revision: counter(raw.revision, 1), contentHash: raw.contentHash });
}
function model(value: unknown): PluginWorkshopModel {
  const raw = object(value, ["providerId", "modelId", "providerRevision"], ["reasoningEffort"]);
  const providerId = text(raw.providerId, 256), modelId = text(raw.modelId, 256), reasoningEffort = raw.reasoningEffort === undefined ? undefined : text(raw.reasoningEffort, 64);
  if (/[\x00-\x1f\x7f]/.test(providerId + modelId + (reasoningEffort ?? ""))) return fail("invalid");
  return Object.freeze({ providerId, modelId, providerRevision: counter(raw.providerRevision, 1), ...(reasoningEffort === undefined ? {} : { reasoningEffort }) });
}
function capture(raw: unknown): PluginWorkshopRequest {
  if (!raw || typeof raw !== "object") return fail("invalid");
  const kindDescriptor = Object.getOwnPropertyDescriptor(raw, "kind");
  if (!kindDescriptor || !("value" in kindDescriptor) || typeof kindDescriptor.value !== "string") return fail("invalid");
  const kind = kindDescriptor.value;
  const fields: Record<string, readonly string[]> = {
    "workshop-list": [], "workshop-get": ["id"], "workshop-save": ["target", "brief", "packageJson", "model"],
    "workshop-generate": ["target", "brief", "model"], "workshop-status": ["jobId"], "workshop-cancel": ["jobId"],
    "workshop-trial": ["target", "actionId", "scope", "inputJson"], "workshop-preview": ["target", "hostRevision"],
    "workshop-install": ["target", "previewId", "hostRevision", "revision", "grants"], "workshop-discard": [],
    "workshop-delete-preview": ["id"], "workshop-delete-confirm": ["previewId"], "workshop-delete-discard": ["previewId"],
  };
  if (!Object.hasOwn(fields, kind)) return fail("invalid");
  const value = object(raw, ["kind", ...fields[kind]!], kind === "workshop-trial" ? ["fixturesJson"] : kind === "workshop-discard" ? ["previewId"] : []);
  if ("id" in value) value.id = id(value.id);
  if ("jobId" in value) value.jobId = id(value.jobId);
  if ("previewId" in value) value.previewId = id(value.previewId);
  if ("target" in value) value.target = target(value.target, kind === "workshop-save" || kind === "workshop-generate");
  if ("model" in value) value.model = model(value.model);
  if ("brief" in value) value.brief = text(value.brief, PLUGIN_AUTHORING_BRIEF_MAX);
  if ("packageJson" in value) {
    value.packageJson = text(value.packageJson, EXECUTABLE_PLUGIN_LIMITS.jsonBytes);
    if (Buffer.byteLength(value.packageJson as string, "utf8") > EXECUTABLE_PLUGIN_LIMITS.jsonBytes) return fail("invalid");
  }
  if ("hostRevision" in value) value.hostRevision = counter(value.hostRevision);
  if ("revision" in value) value.revision = counter(value.revision);
  if ("actionId" in value) value.actionId = text(value.actionId, 100);
  if ("scope" in value && value.scope !== "chat" && value.scope !== "workbench") return fail("invalid");
  if ("inputJson" in value) {
    value.inputJson = text(value.inputJson, PLUGIN_RUNTIME_LIMITS.inputBytes);
    if (Buffer.byteLength(value.inputJson as string, "utf8") > PLUGIN_RUNTIME_LIMITS.inputBytes) return fail("invalid");
  }
  if ("fixturesJson" in value) {
    value.fixturesJson = text(value.fixturesJson, PLUGIN_TRIAL_LIMITS.fixturesBytes);
    if (Buffer.byteLength(value.fixturesJson as string, "utf8") > PLUGIN_TRIAL_LIMITS.fixturesBytes) return fail("invalid");
  }
  if ("grants" in value) {
    if (!Array.isArray(value.grants) || value.grants.length > 12 || new Set(value.grants).size !== value.grants.length
      || value.grants.some(entry => typeof entry !== "string" || !(EXECUTABLE_PLUGIN_CAPABILITY_NAMES as readonly string[]).includes(entry))) return fail("invalid");
    value.grants = Object.freeze([...value.grants]);
  }
  return Object.freeze(value) as unknown as PluginWorkshopRequest;
}
const draftTarget = (draft: PluginWorkshopDraft): PluginWorkshopTarget => Object.freeze({ id: draft.id, revision: draft.revision, contentHash: draft.contentHash });
const sameTarget = (a: PluginWorkshopTarget | null, b: PluginWorkshopTarget | null): boolean => a === null ? b === null : !!b && a.id === b.id && a.revision === b.revision && a.contentHash === b.contentHash;
function message(error: unknown): string {
  return error instanceof PluginWorkshopControllerFault || error instanceof PluginWorkshopFault || error instanceof PluginGeneratorFault
    || error instanceof PluginTrialFault || error instanceof PluginStorageBudgetFault || error instanceof ExecutablePluginStoreFault ? error.message : MESSAGES.unavailable;
}
type MutableJob = { -readonly [K in keyof PluginWorkshopJob]: PluginWorkshopJob[K] };
interface JobRecord { readonly view: MutableJob; readonly abort: AbortController; readonly epoch: number; task?: PluginTrialTask }

/** A single trusted-window authoring session. It never installs implicitly, gives
 * generation real tools/history, or upgrades simulated evidence into real access. */
export function createPluginWorkshopController(options: PluginWorkshopControllerOptions) {
  const drafts = new PluginWorkshopStore(options.profile, options.storage ?? getPluginStorageCoordinator(options.profile));
  const generator = options.generator ?? createPluginGenerator(), trials = createPluginTrialService({ runtime: options.runtime });
  const lifetime = new AbortController();
  let disposed = false, epoch = 0, shortOperations = 0, committing = false;
  let selected: PluginWorkshopTarget | null = null, job: JobRecord | undefined, active: JobRecord | undefined;
  let installation: PluginWorkshopInstallation | undefined;
  const deletePreviews = new Set<string>(), evidence = new Map<string, { result: PluginTrialResult; bytes: number }>();
  const clone = <T>(value: T): T => structuredClone(value);
  function dropInstallation(previewId?: string): void {
    if (!installation || previewId !== undefined && installation.preview.id !== previewId) return;
    options.store.discardPreview(installation.preview.id); installation = undefined;
  }
  function invalidate(): void {
    epoch++; dropInstallation(); evidence.clear();
    for (const token of deletePreviews) drafts.discardDelete(token);
    deletePreviews.clear();
    if (active) stop(active);
  }
  const unsubscribe = options.store.subscribe(() => dropInstallation());
  function guard(at = epoch, signal = lifetime.signal): PluginStorageGuard {
    return { signal, assertCurrent() { if (disposed || signal.aborted || lifetime.signal.aborted) fail("cancelled"); if (at !== epoch) fail("changed"); } };
  }
  function available(allowJob = false): void {
    if (disposed) fail("cancelled");
    if (shortOperations || options.isHostBusy() || !allowJob && active) fail("busy");
  }
  async function short(work: (checked: PluginStorageGuard) => Promise<PluginWorkshopReply>, allowJob = false): Promise<PluginWorkshopReply> {
    available(allowJob); shortOperations++;
    try { return await work(guard()); } finally { shortOperations--; }
  }
  async function readTarget(wanted: PluginWorkshopTarget, checked: PluginStorageGuard): Promise<PluginWorkshopDraft> {
    const draft = await drafts.get(wanted.id, checked); checked.assertCurrent();
    if (!sameTarget(draftTarget(draft), wanted)) fail("changed"); return draft;
  }
  function stop(record: JobRecord): void {
    record.abort.abort(); record.task?.cancel();
    // Completion may already have committed a draft; never relabel that fact as cancelled.
    if (record.view.status === "running") { record.view.status = "cancelled"; record.view.message = MESSAGES.cancelled; }
  }
  function newJob(kind: PluginWorkshopJob["kind"], wanted: PluginWorkshopTarget | null, selection?: PluginWorkshopModel): JobRecord {
    const record: JobRecord = { epoch, abort: new AbortController(), view: { id: randomUUID(), kind, target: wanted, ...(selection ? { model: selection } : {}),
      status: "running", busy: true, chars: 0, startedAt: new Date().toISOString() } };
    active = job = record; return record;
  }
  function end(record: JobRecord): void {
    record.view.busy = false; record.view.endedAt ??= new Date().toISOString(); if (active === record) active = undefined;
  }
  function failed(record: JobRecord, error: unknown): void {
    record.view.status = record.abort.signal.aborted || record.epoch !== epoch || disposed ? "cancelled" : "failed";
    record.view.message = record.view.status === "cancelled" ? MESSAGES.cancelled : message(error); record.view.endedAt = new Date().toISOString();
  }
  async function generate(record: JobRecord, input: Extract<PluginWorkshopRequest, { kind: "workshop-generate" }>, previous?: PluginWorkshopDraft): Promise<void> {
    const checked = guard(record.epoch, record.abort.signal);
    try {
      const result = await generator.generate({ requestId: record.view.id, brief: input.brief, ...input.model,
        ...(previous ? { previousPackageJson: previous.packageJson } : {}) }, checked, chars => {
        if (!record.abort.signal.aborted && record.epoch === epoch && job === record) record.view.chars = chars;
      });
      checked.assertCurrent();
      if (result.providerId !== input.model.providerId || result.modelId !== input.model.modelId || result.providerRevision !== input.model.providerRevision) fail("changed");
      if (input.target) await readTarget(input.target, checked);
      const draft = await drafts.save({ ...(input.target ? { id: input.target.id, expectedRevision: input.target.revision } : {}),
        brief: input.brief, packageJson: result.packageJson, model: input.model }, checked);
      record.view.draft = draft; record.view.status = "completed"; record.view.endedAt = new Date().toISOString();
      // Successful storage already committed. Invalidation after commit cannot undo it.
      if (!disposed && record.epoch === epoch) selected = draftTarget(draft);
    } catch (error) { failed(record, error); } finally { end(record); }
  }
  async function collectTrial(record: JobRecord, task: PluginTrialTask): Promise<void> {
    try {
      const result = await task.result;
      if (record.abort.signal.aborted || record.epoch !== epoch || disposed) fail("cancelled");
      record.view.trial = result;
      record.view.status = result.outcome === "completed" ? "completed" : result.outcome === "cancelled" ? "cancelled" : "failed";
      record.view.endedAt = new Date().toISOString();
      // One result per action, at most the manifest's 24 actions and 4 MiB of
      // retained simulation output. Evicted evidence is explicitly not-run.
      evidence.delete(result.actionId); evidence.set(result.actionId, { result, bytes: Buffer.byteLength(JSON.stringify(result), "utf8") });
      let retained = [...evidence.values()].reduce((sum, item) => sum + item.bytes, 0);
      while (retained > 4 * 1024 * 1024 && evidence.size > 1) { const key = evidence.keys().next().value!; retained -= evidence.get(key)!.bytes; evidence.delete(key); }
    } catch (error) { failed(record, error); }
    finally { try { await task.closed; } finally { end(record); } }
  }
  async function request(raw: unknown): Promise<PluginWorkshopReply> {
    try {
      const input = capture(raw); if (disposed) fail("cancelled");
      if (input.kind === "workshop-status" || input.kind === "workshop-cancel") {
        if (!job || job.view.id !== input.jobId) fail("changed");
        if (input.kind === "workshop-cancel" && job.view.busy) stop(job);
        return { ok: true, job: clone(job.view) };
      }
      if (input.kind === "workshop-discard") {
        if (input.previewId !== undefined) { dropInstallation(input.previewId); return { ok: true }; }
        if (committing) fail("busy"); invalidate(); selected = null; return { ok: true };
      }
      if (input.kind === "workshop-delete-discard") {
        if (deletePreviews.delete(input.previewId)) drafts.discardDelete(input.previewId);
        return { ok: true };
      }
      if (input.kind === "workshop-list") return await short(async checked => ({ ok: true, drafts: await drafts.list(checked), ...(job ? { job: clone(job.view) } : {}) }), true);
      if (input.kind === "workshop-get") {
        if (committing) fail("busy"); available(true);
        if (selected?.id !== input.id) invalidate();
        return await short(async checked => {
          const draft = await drafts.get(input.id, checked);
          if (!sameTarget(selected, draftTarget(draft))) invalidate();
          selected = draftTarget(draft); return { ok: true, draft, trials: clone([...evidence.values()].map(item => item.result)) };
        }, true);
      }
      if (input.kind === "workshop-save") {
        if (committing) fail("busy"); available(true); invalidate();
        return await short(async checked => {
          if (input.target) await readTarget(input.target, checked);
          const draft = await drafts.save({ ...(input.target ? { id: input.target.id, expectedRevision: input.target.revision } : {}),
            brief: input.brief, packageJson: input.packageJson, model: input.model }, checked);
          selected = draftTarget(draft); return { ok: true, draft, trials: [] };
        }, true);
      }
      if (input.kind === "workshop-generate") return await short(async checked => {
        const previous = input.target ? await readTarget(input.target, checked) : undefined;
        invalidate(); selected = input.target;
        const record = newJob("generate", input.target, input.model); void generate(record, input, previous);
        return { ok: true, job: clone(record.view) };
      });
      if (input.kind === "workshop-trial") return await short(async checked => {
        const draft = await readTarget(input.target, checked);
        if (!sameTarget(selected, input.target)) { invalidate(); selected = input.target; }
        dropInstallation(); evidence.delete(input.actionId);
        const record = newJob("trial", input.target), trialGuard = guard(record.epoch, record.abort.signal);
        try {
          const task = trials.start({ candidateId: draft.id, revision: draft.revision, packageJson: draft.packageJson,
            contentHash: draft.contentHash, sourceHash: draft.contentHash },
          { actionId: input.actionId, scope: input.scope, inputJson: input.inputJson, ...(input.fixturesJson === undefined ? {} : { fixturesJson: input.fixturesJson }) }, trialGuard);
          record.task = task; void collectTrial(record, task);
          return { ok: true, job: clone(record.view) };
        } catch (error) { failed(record, error); end(record); throw error; }
      });
      if (input.kind === "workshop-preview") return await short(async checked => {
        const draft = await readTarget(input.target, checked);
        if (!sameTarget(selected, input.target)) { evidence.clear(); dropInstallation(); selected = input.target; }
        dropInstallation();
        const result = await options.store.previewGenerated(draft.packageJson, input.hostRevision, checked);
        try {
        checked.assertCurrent(); await readTarget(input.target, checked);
        installation = { target: input.target, hostRevision: result.snapshot.hostRevision, revision: result.snapshot.revision, preview: result.preview,
          actions: draft.package.manifest.actions.map(action => {
            const trial = evidence.get(action.id)?.result;
            return trial && trial.candidateId === draft.id && trial.revision === draft.revision && trial.contentHash === draft.contentHash
              ? { actionId: action.id, state: trial.outcome, scope: trial.scope, requestHash: trial.requestHash } : { actionId: action.id, state: "not-run" as const };
          }) };
        return { ok: true, installation: clone(installation), snapshot: result.snapshot };
        } catch (error) { options.store.discardPreview(result.preview.id); throw error; }
      });
      if (input.kind === "workshop-install") return await short(async checked => {
        const frozen = installation;
        if (!frozen || frozen.preview.id !== input.previewId || !sameTarget(frozen.target, input.target) || frozen.hostRevision !== input.hostRevision
          || frozen.revision !== input.revision || options.store.hostRevision !== input.hostRevision) fail("changed");
        await readTarget(input.target, checked); checked.assertCurrent();
        if (installation !== frozen || (options.store.current(frozen.preview.manifest.id)?.contentHash ?? null) !== frozen.preview.baseContentHash) fail("changed");
        committing = true;
        try {
          const installationGuard: PluginStorageGuard = { signal: checked.signal, assertCurrent() {
            checked.assertCurrent(); if (installation !== frozen) fail("changed");
          } };
          const result = await options.store.confirmGenerated(input.previewId, input.revision, input.grants, input.hostRevision, installationGuard);
          dropInstallation(input.previewId); return result;
        } finally { committing = false; }
      });
      if (input.kind === "workshop-delete-preview") return await short(async checked => {
        const deletePreview = await drafts.prepareDelete(input.id, checked);
        while (deletePreviews.size >= 8) { const token = deletePreviews.values().next().value!; deletePreviews.delete(token); drafts.discardDelete(token); }
        deletePreviews.add(deletePreview.id);
        return { ok: true, deletePreview };
      });
      if (input.kind === "workshop-delete-confirm") return await short(async checked => {
        if (!deletePreviews.delete(input.previewId)) fail("changed");
        // Consuming a delete confirmation invalidates all candidate evidence. A
        // partial delete remains a reported result, never a silently empty draft.
        dropInstallation(); evidence.clear();
        const deleteResult = await drafts.confirmDelete(input.previewId, checked); selected = null;
        return { ok: true, deleteResult };
      });
      return fail("invalid");
    } catch (error) { return { ok: false, message: message(error) }; }
  }
  return {
    request,
    get isBusy(): boolean { return shortOperations > 0 || !!active; },
    invalidate,
    dispose(): void { if (disposed) return; disposed = true; invalidate(); lifetime.abort(); unsubscribe(); generator.dispose?.(); trials.dispose(); },
  };
}

