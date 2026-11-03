import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { runApprovedPluginCommand, PluginCommandFault } from "@herta/tools";
import type { ExecutablePluginCapabilityName, ExecutablePluginManifest } from "../../shared/executable-plugins.js";
import type { ExecutablePluginReply, ExecutablePluginManagementRequest, ExecutablePluginRunView } from "../../shared/executable-plugin-management.js";
import { validatePluginActionInput, type PluginRunResult } from "../../shared/plugin-runtime.js";
import { parsePluginControlledView, type PluginControlledViewDefinition } from "../../shared/plugin-view.js";
import { PluginBrokerFault, PluginCapabilityBroker, type PluginBrokerPolicy, type PluginBrokerBinding } from "./capability-broker.js";
import type { PluginRuntimeService, PluginTask } from "./plugin-runtime-service.js";
import type { ExecutablePluginStore } from "./executable-plugin-store.js";
import { PrivatePluginStorage, PluginPrivateDataFault, readPluginWorkspaceText } from "./plugin-host-services.js";
import { createPluginDeliverableController, type PluginDeliverableControllerOptions } from "./plugin-deliverable-controller.js";
import { createPluginNetworkService, pluginNetworkDiagnostic, PluginNetworkFault } from "./plugin-network-service.js";
import { PluginNetworkSettingsStore, PluginNetworkSettingsFault } from "./plugin-network-settings-store.js";
import { getPluginStorageCoordinator, PluginStorageBudgetFault, type PluginStorageCoordinator } from "./plugin-storage-coordinator.js";
import { PluginMaintenanceFault } from "./plugin-storage-maintenance-files.js";
import { createPluginWorkshopController, type PluginWorkshopControllerOptions } from "./plugin-workshop-controller.js";

export interface ExecutablePluginOwner {
  readonly id: string;
  readonly revision: number;
  readonly busy: boolean;
  readonly permissionMode: "read-only" | "workspace-edit" | "full-access";
  readonly permissionRevision: number;
  readonly planActive: boolean;
  readonly workspaceRoot?: string;
}
interface Options extends Pick<PluginDeliverableControllerOptions, "chooseArtifactPath" | "withWorkspaceOperation"> {
  store: ExecutablePluginStore;
  runtime: Pick<PluginRuntimeService, "start" | "dispose">;
  profile: string;
  protectedPaths: readonly string[];
  owner(scope: "chat" | "workbench"): ExecutablePluginOwner | null;
  /** Trusted host injection only; never accepts a renderer-provided transport. */
  network?: ReturnType<typeof createPluginNetworkService>;
  networkSettings?: PluginNetworkSettingsStore;
  command?: typeof runApprovedPluginCommand;
  storage?: PluginStorageCoordinator;
  /** Trusted host/test injection; never supplied by a renderer request. */
  workshopGenerator?: PluginWorkshopControllerOptions["generator"];
}
const AVAILABLE: readonly ExecutablePluginCapabilityName[] = Object.freeze([
  "workspace.readText", "workspace.proposePatch", "artifacts.create", "storage.get", "storage.set", "draft.append", "log", "progress", "ui.present", "ui.update", "network.request", "commands.run",
]);
interface RunRecord {
  view: { -readonly [K in keyof ExecutablePluginRunView]: ExecutablePluginRunView[K] };
  owner: ExecutablePluginOwner;
  storeRevision: number;
  broker: PluginCapabilityBroker;
  task?: PluginTask;
  cancelled: boolean;
  pluginId: string;
  contentHash: string;
  viewActionPending?: boolean;
}
const fail = (message: string): ExecutablePluginReply => ({ ok: false, message });
const safeString = (value: unknown, max: number): value is string => typeof value === "string" && !!value && value.length <= max;

/** Trusted-window entry. No Guest source, path or identity is accepted outside installed packages. */
export function createExecutablePluginController(options: Options) {
  const records = new Map<string, RunRecord>();
  const budget = options.storage ?? getPluginStorageCoordinator(options.profile);
  const storage = new PrivatePluginStorage(options.profile, budget);
  const deliverables = createPluginDeliverableController({ ...options, storage: budget });
  const lifetime = new AbortController();
  let disposed = false;
  const networkSettings = options.networkSettings ?? new PluginNetworkSettingsStore(options.profile);
  const settingsGuard = { signal: lifetime.signal, assertCurrent() { if (disposed) throw new PluginNetworkSettingsFault("cancelled"); } };
  const networkReady = networkSettings.load(settingsGuard).catch(() => undefined);
  const network = options.network ?? createPluginNetworkService({ getEgressPolicy: () => networkSettings.current() });
  let starting = 0;
  let privateMaintenance = false;
  let cleanupMaintenance = false;
  const workshop = createPluginWorkshopController({ profile: options.profile, storage: budget, store: options.store, runtime: options.runtime,
    ...(options.workshopGenerator ? { generator: options.workshopGenerator } : {}),
    isHostBusy: () => disposed || privateMaintenance || cleanupMaintenance || starting > 0 || options.store.isBusy || deliverables.isBusy()
      || [...records.values()].some(record => record.view.status === "running"),
  });
  const currentOwner = (scope: "chat" | "workbench") => {
    try { return options.owner(scope); } catch { return null; }
  };
  const sameOwner = (a: ExecutablePluginOwner, b: ExecutablePluginOwner | null) =>
    !!b && !b.busy && a.id === b.id && a.revision === b.revision && a.workspaceRoot === b.workspaceRoot
      && a.permissionRevision === b.permissionRevision && a.permissionMode === b.permissionMode && a.planActive === b.planActive;
  const view = (record: RunRecord): ExecutablePluginRunView => structuredClone(record.view);
  const belongs = (record: RunRecord) => !disposed && record.storeRevision === options.store.hostRevision
    && sameOwner(record.owner, currentOwner(record.view.scope));
  const clearProposals = (record: RunRecord) => {
    record.view.draftProposal = undefined;
    record.view.controlledView = undefined;
  };
  // Only data accepted by the broker reaches this function. Match button targets
  // to this installed manifest, and normalize defaults with the real input schema.
  const checkedDefinition = (definition: PluginControlledViewDefinition, manifest: ExecutablePluginManifest, scope: "chat" | "workbench") => {
    try {
      const actions = definition.actions.map(button => {
        const action = manifest.actions.find(item => item.id === button.actionId);
        if (!action || (action.scope !== "both" && action.scope !== scope)) throw new Error("invalid target");
        return { ...button, inputJson: validatePluginActionInput(action, button.inputJson) };
      });
      return parsePluginControlledView(JSON.stringify({ ...definition, actions }));
    } catch { throw new PluginBrokerFault("invalid-input"); }
  };
  const unsubscribe = options.store.subscribe(() => {
    for (const record of records.values()) {
      record.broker.invalidate();
      clearProposals(record);
    }
  });
  const managementKinds = new Set(["list", "preview", "discard", "confirm", "rollback-preview", "enable", "remove", "grants", "restore", "reset"]);
  const outputKinds = new Set(["outputs-list", "artifact-read", "artifact-save", "patch-read", "patch-apply", "patch-cancel"]);

  async function request(raw: unknown): Promise<ExecutablePluginReply> {
    if (disposed) return fail("插件服务已关闭。");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("插件请求格式不正确。");
    const input = raw as Record<string, unknown>;
    if (typeof input.kind !== "string") return fail("插件请求格式不正确。");
    if (input.kind === "network-settings-get" || input.kind === "network-settings-set") {
      const saving = input.kind === "network-settings-set", keys = saving ? ["kind", "expectedRevision", "config"] : ["kind"];
      if (Object.keys(input).length !== keys.length || Object.keys(input).some(key => !keys.includes(key))
        || saving && (!Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 0)) return fail("插件联网设置请求格式不正确。");
      try {
        await networkReady; settingsGuard.assertCurrent();
        const snapshot = saving ? await networkSettings.save(input.expectedRevision as number, input.config, settingsGuard) : await networkSettings.load(settingsGuard);
        // A successful save already committed. Do not replace it with a late
        // cancellation error; revision polling revokes only old network requests.
        return { ok: true, networkSettings: snapshot };
      } catch (error) { return fail(error instanceof PluginNetworkSettingsFault ? error.message : "插件联网设置操作未完成，请重新读取后检查。"); }
    }
    if (input.kind.startsWith("workshop-")) return workshop.request(raw);
    if (input.kind === "maintenance-discard") {
      if (Object.keys(input).some(key => !["kind", "previewId"].includes(key)) || !safeString(input.previewId, 100)) return fail("清理请求格式不正确。");
      options.store.discardMaintenance(input.previewId); return { ok: true };
    }
    if (input.kind === "maintenance-preview" || input.kind === "maintenance-confirm") {
      const previewing = input.kind === "maintenance-preview";
      const keys = previewing ? ["kind", "hostRevision"] : ["kind", "previewId", "selectedIds", "hostRevision"];
      if (Object.keys(input).some(key => !keys.includes(key)) || !Number.isSafeInteger(input.hostRevision) || (input.hostRevision as number) < 0
        || (!previewing && (!safeString(input.previewId, 100) || !Array.isArray(input.selectedIds) || input.selectedIds.length < 1 || input.selectedIds.length > 256
          || input.selectedIds.some(id => !safeString(id, 100)) || new Set(input.selectedIds).size !== input.selectedIds.length))) return fail("清理请求格式不正确。");
      if (workshop.isBusy || cleanupMaintenance || privateMaintenance || starting || [...records.values()].some(record => record.view.status === "running")
        || options.store.isBusy || deliverables.isBusy()) return fail("还有插件操作未结束，请结束后再检查或清理资料。");
      // Take admission synchronously before the first await. Existing work is
      // never cancelled to gain entry, and store serialization covers installs.
      cleanupMaintenance = true;
      const revision = input.hostRevision as number;
      const guard = { signal: lifetime.signal, assertCurrent() {
        if (disposed) throw new PluginMaintenanceFault("cancelled");
        if (revision !== options.store.hostRevision) throw new PluginMaintenanceFault("changed");
      } };
      try {
        guard.assertCurrent();
        if (previewing) return { ok: true, maintenancePreview: await options.store.previewMaintenance(revision, guard) };
        // Confirm may have a partial result. Do not add a post-operation guard
        // that would erase already completed deletion facts.
        return { ok: true, maintenanceResult: await options.store.confirmMaintenance(input.previewId as string, input.selectedIds as string[], revision, guard) };
      } catch (error) {
        return fail(error instanceof PluginMaintenanceFault ? error.message : "未能取得完整清理结果，请重新检查资料后核对。");
      } finally { cleanupMaintenance = false; }
    }
    if (input.kind === "private-data-discard") {
      if (Object.keys(input).some(key => !["kind", "previewId"].includes(key)) || !safeString(input.previewId, 100)) return fail("插件请求格式不正确。");
      storage.discardRecovery(input.previewId); return { ok: true };
    }
    if (input.kind === "private-data-preview" || input.kind === "private-data-confirm") {
      const previewing = input.kind === "private-data-preview";
      const keys = previewing ? ["kind", "pluginId", "action", "hostRevision"] : ["kind", "previewId", "hostRevision"];
      if (Object.keys(input).some(key => !keys.includes(key)) || !Number.isSafeInteger(input.hostRevision) || (input.hostRevision as number) < 0
        || (previewing ? !safeString(input.pluginId, 80) || !["restore", "reset"].includes(input.action as string) : !safeString(input.previewId, 100))) return fail("插件资料请求格式不正确。");
      if (workshop.isBusy || cleanupMaintenance || privateMaintenance || starting || [...records.values()].some(record => record.view.status === "running")) return fail("请先等待插件运行结束，再处理插件资料。");
      privateMaintenance = true;
      const revision = input.hostRevision as number;
      const guard = { signal: lifetime.signal, assertCurrent() {
        if (disposed || revision !== options.store.hostRevision) throw new PluginPrivateDataFault("changed");
      } };
      try {
        guard.assertCurrent();
        const listed = await options.store.request({ kind: "list" }); guard.assertCurrent();
        if (!listed.ok || listed.snapshot.damaged) return fail("请先恢复插件列表，再处理插件资料。");
        if (previewing) {
          if (!listed.snapshot.items.some(item => item.manifest.id === input.pluginId)) return fail("插件已变化，请刷新列表。");
          return { ok: true, privateDataPreview: await storage.previewRecovery(input.pluginId as string, input.action as "restore" | "reset", revision, guard) };
        }
        // The storage service owns its commit point; do not revoke a successful
        // recovery receipt if the host changes after the atomic replacement.
        return { ok: true, privateDataResult: await storage.confirmRecovery(input.previewId as string, revision, guard) };
      } catch (error) {
        return fail(error instanceof PluginPrivateDataFault ? error.message : "插件资料操作未完成，请刷新后核对。");
      } finally { privateMaintenance = false; }
    }
    if (input.kind === "storage-usage") {
      if (Object.keys(input).length !== 1) return fail("插件请求格式不正确。");
      try {
        const snapshot = await budget.snapshot({ signal: lifetime.signal, assertCurrent() {
          if (disposed) throw new PluginStorageBudgetFault("cancelled");
        } });
        return { ok: true, storage: snapshot };
      } catch (error) {
        return fail(error instanceof PluginStorageBudgetFault ? error.message : "无法核对插件资料空间，请稍后刷新。");
      }
    }
    if (outputKinds.has(input.kind)) {
      if (cleanupMaintenance) return fail("正在清理插件资料，请稍后再操作文件。");
      if (workshop.isBusy && ["artifact-save", "patch-apply", "patch-cancel"].includes(input.kind)) return fail("请先结束工坊操作，再处理插件文件。");
      return deliverables.request(raw);
    }
    if (managementKinds.has(input.kind)) {
      if (workshop.isBusy && !["list", "discard"].includes(input.kind)) return fail("请先结束工坊操作，再调整已安装插件。");
      if (cleanupMaintenance && input.kind !== "discard") return fail("正在清理插件资料，请稍后再调整插件。");
      if (privateMaintenance && !["list", "discard"].includes(input.kind)) return fail("正在处理插件资料，请稍后再调整插件。");
      const reply = await options.store.request(raw as ExecutablePluginManagementRequest);
      return reply.ok ? { ...reply, availableCapabilities: AVAILABLE } : reply;
    }
    if (input.kind === "status" || input.kind === "cancel") {
      if (Object.keys(input).some(key => !["kind", "runId"].includes(key)) || !safeString(input.runId, 100)) return fail("插件请求格式不正确。");
      const record = records.get(input.runId);
      if (!record) return fail("这次运行记录已结束，请重新选择动作。");
      if (!belongs(record)) {
        record.broker.invalidate(); clearProposals(record);
        if (input.kind === "cancel") { record.task?.cancel(); return { ok: true }; }
        return fail("会话已变化，请在当前会话中重新选择动作。");
      }
      if (input.kind === "cancel" && record.view.status === "running") {
        record.cancelled = true; clearProposals(record); record.task?.cancel();
      }
      return { ok: true, run: view(record) };
    }
    if (input.kind === "view-action") {
      if (Object.keys(input).some(key => !["kind", "runId", "viewId", "viewRevision", "buttonId", "inputJson", "draftRevision"].includes(key))
        || !safeString(input.runId, 100) || !safeString(input.viewId, 100) || !safeString(input.buttonId, 64)
        || !Number.isSafeInteger(input.viewRevision) || (input.viewRevision as number) < 1
        || !Number.isSafeInteger(input.draftRevision) || (input.draftRevision as number) < 0
        || typeof input.inputJson !== "string" || input.inputJson.length > 32768) return fail("插件操作请求格式不正确。");
      const source = records.get(input.runId);
      const eligible = () => !!source && records.get(source.view.id) === source && belongs(source)
        && source.view.status === "completed" && source.view.result?.ok === true
        && source.view.draftRevision === input.draftRevision
        && source.view.controlledView?.id === input.viewId && source.view.controlledView?.revision === input.viewRevision;
      if (!source || !eligible() || source.viewActionPending) return fail("这份插件结果已变化，请重新运行并查看。");
      const button = source.view.controlledView!.actions.find(item => item.id === input.buttonId);
      if (!button) return fail("这项操作不在当前插件结果中。");
      source.viewActionPending = true;
      try {
        return await launch({ kind: "run", pluginId: source.pluginId, contentHash: source.contentHash, actionId: button.actionId,
          scope: source.view.scope, target: source.view.target, inputJson: input.inputJson, draftRevision: input.draftRevision },
          { current: eligible, consume: () => { source.view.controlledView = undefined; } });
      } finally { source.viewActionPending = false; }
    }
    return launch(input);
  }

  async function launch(input: Record<string, unknown>, origin?: { current(): boolean; consume(): void }): Promise<ExecutablePluginReply> {
    if (workshop.isBusy) return fail("请先结束工坊操作，再运行已安装插件。");
    if (cleanupMaintenance) return fail("正在清理插件资料，请稍后再运行插件。");
    if (privateMaintenance) return fail("正在处理插件资料，请稍后再运行插件。");
    if (input.kind !== "run" || Object.keys(input).some(key => !["kind", "pluginId", "contentHash", "actionId", "scope", "target", "inputJson", "draftRevision"].includes(key))) return fail("插件请求格式不正确。");
    if (!safeString(input.pluginId, 80) || !safeString(input.contentHash, 64) || !/^[a-f0-9]{64}$/.test(input.contentHash)
      || !safeString(input.actionId, 64) || !safeString(input.target, 512) || typeof input.inputJson !== "string" || input.inputJson.length > 32768
      || (input.scope !== "chat" && input.scope !== "workbench") || !Number.isSafeInteger(input.draftRevision) || (input.draftRevision as number) < 0) return fail("插件请求格式不正确。");
    const { scope, target, pluginId, contentHash, actionId } = input;
    const selectedOwner = currentOwner(scope);
    if (!selectedOwner || selectedOwner.id !== target || selectedOwner.busy || (scope === "workbench" && !selectedOwner.workspaceRoot)) return fail("请在空闲的当前会话中运行插件。");
    const owner = Object.freeze({ ...selectedOwner });
    if (origin && !origin.current()) return fail("这份插件结果已变化，请重新运行并查看。");
    // Bound retained output without dropping a running task or its cancellation handle.
    for (const [id, record] of records) if (record.view.status !== "running" && (records.size >= 20 || Date.now() - Date.parse(record.view.endedAt ?? record.view.startedAt) > 600000)) records.delete(id);
    if (starting + [...records.values()].filter(item => item.view.status === "running").length >= 2) return fail("已有插件正在运行，请先等待或停止。");
    starting++;
    try {
    const physicalRoot = scope === "workbench" && owner.workspaceRoot ? await realpath(owner.workspaceRoot) : undefined;
    let installed: Awaited<ReturnType<ExecutablePluginStore["resolve"]>>;
    try { installed = await options.store.resolve(pluginId, contentHash, scope, actionId); }
    catch { return fail("插件已变化或记录无法读取，请刷新插件列表。"); }
    if (disposed || !sameOwner(owner, currentOwner(scope)) || (origin && !origin.current())) return fail("会话或插件结果已变化，请重新选择动作。");
    const item = installed.item, action = item.manifest.actions.find(value => value.id === actionId);
    if (!action || action.capabilities.some(cap => !AVAILABLE.includes(cap))) return fail("这个动作需要尚未接入的能力，暂时不能运行。");
    if (action.capabilities.some(cap => !item.grantedCapabilities.some(grant => grant.name === cap))) return fail("请先在插件设置中确认这个动作需要的权限。");
    // Validate before spawning, including edited parameters from a controlled view.
    let inputJson: string;
    try { inputJson = validatePluginActionInput(action, input.inputJson); }
    catch { return fail("请检查插件参数，必填项和类型需要符合要求。"); }
    const hostRevision = options.store.hostRevision;
    const binding: PluginBrokerBinding = { pluginId, contentHash, grantRevision: item.grantRevision, sessionId: owner.id, sessionRevision: owner.revision,
      permissionRevision: owner.permissionRevision, scope, actionId };
    const policy = (): PluginBrokerPolicy | null => {
      if (disposed || options.store.hostRevision !== hostRevision) return null;
      const selected = currentOwner(scope), current = options.store.current(pluginId);
      if (!sameOwner(owner, selected) || !selected || !current) return null;
      return { pluginId: current.manifest.id, contentHash: current.contentHash, grantRevision: current.grantRevision, sessionId: selected.id,
        sessionRevision: selected.revision, permissionRevision: selected.permissionRevision, scope, enabled: current.enabled,
        permissionMode: selected.permissionMode, planActive: selected.planActive, grantedCapabilities: current.grantedCapabilities };
    };
    const publicId = randomUUID();
    const outputOwner = Object.freeze({ scope, target });
    const producer = Object.freeze({ id: item.manifest.id, name: item.manifest.name, version: item.manifest.version,
      contentHash: item.contentHash, grantRevision: item.grantRevision });
    let record!: RunRecord;
    const broker = new PluginCapabilityBroker({ manifest: item.manifest, binding, current: policy, handlers: {
      "network.request": async (args, context) => {
        try {
        await networkReady; await networkSettings.load(settingsGuard);
        context.assertCurrent();
        if (networkSettings.current().loadError !== undefined) throw new PluginNetworkFault("invalid-policy");
        if (scope === "chat") return await network.request(args, context);
        if (!owner.workspaceRoot || !options.withWorkspaceOperation) throw new PluginBrokerFault("capability-denied");
        // Installation grants constrain destinations; the current workspace tier
        // separately decides whether this individual request may leave the app.
        return await options.withWorkspaceOperation(outputOwner, owner.workspaceRoot, context.signal, async lease => {
          const signal = AbortSignal.any([context.signal, lease.signal]);
          const assertCurrent = () => { context.assertCurrent(); lease.assertCurrent(); };
          assertCurrent();
          record.view.progress = { message: "正在确认联网权限…" };
          const allowed = await lease.authorizeNetworkRequest({ url: args.url, method: args.method, bodyBytes: Buffer.byteLength(args.body ?? "", "utf8") });
          assertCurrent();
          if (!allowed) {
            record.view.logs = [...record.view.logs, { level: "warn" as const, message: "本次联网未获准，未发送请求。" }].slice(-64);
            throw new PluginBrokerFault("capability-denied");
          }
          record.view.progress = { message: "正在读取已授权地址…" };
          return network.request(args, { binding: context.binding, signal, assertCurrent });
        });
        } catch (error) {
          const diagnostic = pluginNetworkDiagnostic(error);
          if (diagnostic) record.view.logs = [...record.view.logs, { level: "error" as const, message: diagnostic }].slice(-64);
          throw error;
        }
      },
      "commands.run": async (args, context) => {
        context.assertCurrent();
        if (scope !== "workbench" || !owner.workspaceRoot || !physicalRoot || !options.withWorkspaceOperation) throw new PluginBrokerFault("capability-denied");
        try {
          return await options.withWorkspaceOperation(outputOwner, owner.workspaceRoot, context.signal, async lease => {
            const signal = AbortSignal.any([context.signal, lease.signal]);
            const assertCurrent = () => { context.assertCurrent(); lease.assertCurrent(); };
            assertCurrent();
            const result = await (options.command ?? runApprovedPluginCommand)(args, {
              workspaceRoot: owner.workspaceRoot!, expectedPhysicalRoot: physicalRoot, protectedPaths: options.protectedPaths, signal, assertCurrent,
              authorize: async preview => {
                assertCurrent(); record.view.progress = { message: "等待确认本机命令…" };
                const allowed = await lease.authorizeCommand(preview); assertCurrent();
                record.view.progress = { message: allowed ? "正在运行已确认的命令…" : "命令未获准，未启动。" };
                return allowed;
              },
            });
            assertCurrent();
            record.view.logs = [...record.view.logs, { level: result.exitCode === 0 && !result.timedOut ? "info" as const : "warn" as const,
              message: result.timedOut ? "本机命令超时，已请求停止。" : `本机命令已结束，退出码：${result.exitCode ?? "--"}。` }].slice(-64);
            return JSON.stringify(result);
          });
        } catch (error) {
          if (error instanceof PluginCommandFault) {
            const message = ({ "invalid-input": "命令参数不受支持，未启动。", "capability-denied": "命令未获准或不符合执行限制，未启动。",
              cancelled: "已请求停止本机命令；已经产生的改动会保留。", revoked: "任务或权限已变化，已请求停止本机命令。",
              "runner-unavailable": "未找到可用的命令程序，请检查本机安装。", "host-error": "本机命令未能正常完成，请先核对项目状态。" } as const)[error.code];
            record.view.logs = [...record.view.logs, { level: "error" as const, message }].slice(-64);
            throw new PluginBrokerFault(error.code);
          }
          throw error;
        }
      },
      "workspace.readText": (args, context) => {
        if (scope !== "workbench" || !owner.workspaceRoot) throw new PluginBrokerFault("capability-denied");
        return readPluginWorkspaceText(owner.workspaceRoot, args.path, args.maxBytes ?? 65536, context, options.protectedPaths, physicalRoot);
      },
      "artifacts.create": async (args, context) => {
        const artifact = await deliverables.createArtifact(outputOwner, producer, publicId, args, context);
        // Persisted output is a fact even if the Guest is later cancelled or fails.
        record.view.artifacts = [...(record.view.artifacts ?? []), artifact];
        return JSON.stringify({ artifactId: artifact.id, name: artifact.name, mime: artifact.mime, bytes: artifact.bytes, sha256: artifact.sha256, saved: true });
      },
      "workspace.proposePatch": async (args, context) => {
        if (scope !== "workbench" || !owner.workspaceRoot || !physicalRoot) throw new PluginBrokerFault("capability-denied");
        const proposal = await deliverables.createProposal(outputOwner, producer, publicId, args, owner.workspaceRoot, context, physicalRoot);
        record.view.proposals = [...(record.view.proposals ?? []), proposal];
        return JSON.stringify({ proposalId: proposal.id, path: proposal.path, baseHash: proposal.baseHash, nextHash: proposal.nextHash,
          additions: proposal.additions, deletions: proposal.deletions, status: proposal.status });
      },
      "storage.get": (args, context) => storage.get(pluginId, args.key, context),
      "storage.set": (args, context) => storage.set(pluginId, args.key, args.value, context),
      "draft.append": (args, context) => {
        context.assertCurrent();
        const next = record.view.draftProposal ? record.view.draftProposal + "\n\n" + args.text : args.text;
        if (next.length > 32000) throw new PluginBrokerFault("resource-limit");
        record.view.draftProposal = next;
        return '{"staged":true}';
      },
      log: (args, context) => { context.assertCurrent(); record.view.logs = [...record.view.logs, { level: args.level, message: args.message }].slice(-64); return "null"; },
      progress: (args, context) => { context.assertCurrent(); record.view.progress = args; return "null"; },
      "ui.present": (args, context) => {
        context.assertCurrent();
        if (record.view.controlledView) throw new PluginBrokerFault("invalid-input");
        const definition = checkedDefinition(args.view, item.manifest, scope);
        const next = Object.freeze({ ...definition, id: randomUUID(), revision: 1 });
        record.view.controlledView = next;
        return JSON.stringify({ viewId: next.id, revision: next.revision });
      },
      "ui.update": (args, context) => {
        context.assertCurrent();
        const current = record.view.controlledView;
        if (!current || current.id !== args.viewId || current.revision !== args.revision) throw new PluginBrokerFault("invalid-input");
        const definition = checkedDefinition(args.view, item.manifest, scope);
        const next = Object.freeze({ ...definition, id: current.id, revision: current.revision + 1 });
        record.view.controlledView = next;
        return JSON.stringify({ viewId: next.id, revision: next.revision });
      },
    } });
    record = { owner, pluginId, contentHash, storeRevision: hostRevision, broker, cancelled: false, view: { id: publicId, scope, target, draftRevision: input.draftRevision as number,
      status: "running", startedAt: new Date().toISOString(), logs: [] } };
    records.set(publicId, record);
    try {
      record.task = options.runtime.start({ packageJson: installed.packageJson, actionId, inputJson }, broker);
      if (!record.task.accepted) {
        records.delete(publicId); broker.dispose();
        void record.task.result.catch(() => {});
        return fail(origin ? "插件未能开始运行，原结果已保留，请稍后重试。" : "插件未能开始运行，请稍后重试。");
      }
      origin?.consume();
      void record.task.result.then((result: PluginRunResult) => {
        record.view.result = result; record.view.endedAt = new Date().toISOString();
        record.view.status = result.ok ? "completed" : result.code === "cancelled" ? "cancelled" : "failed";
        if (!result.ok || !sameOwner(owner, currentOwner(scope)) || options.store.hostRevision !== hostRevision) clearProposals(record);
      }, () => {
        record.view.result = { ok: false, code: "host-error" }; record.view.status = "failed"; clearProposals(record);
        record.view.endedAt = new Date().toISOString(); broker.dispose();
      });
      return { ok: true, run: view(record) };
    } catch {
      records.delete(publicId); broker.dispose(); return fail("插件未能开始运行，请重试。");
    }
    } finally { starting--; }
  }
  return {
    request: async (raw: unknown): Promise<ExecutablePluginReply> => { try { return await request(raw); } catch { return fail("插件操作未完成，现有资料保持不变。"); } },
    dispose() { disposed = true; lifetime.abort(); unsubscribe(); workshop.dispose(); deliverables.dispose(); for (const record of records.values()) { record.task?.cancel(); record.broker.dispose(); } network.dispose(); options.runtime.dispose(); records.clear(); },
  };
}
