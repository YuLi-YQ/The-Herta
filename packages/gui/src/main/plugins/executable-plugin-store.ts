import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { countDiffLines } from "@herta/core";
import { computeUnifiedDiff } from "@herta/tools";
import {
  EXECUTABLE_PLUGIN_LIMITS, parseExecutablePluginManifest, parseExecutablePluginPackage,
  type ExecutablePluginCapability, type ExecutablePluginCapabilityName, type ExecutablePluginManifest,
  type ExecutablePluginPackage,
} from "../../shared/executable-plugins.js";
import type {
  ExecutablePluginManagementReply, ExecutablePluginManagementRequest, ExecutablePluginPreview,
  ExecutablePluginSnapshot, ExecutablePluginVersion, InstalledExecutablePlugin, ExecutablePluginFileChange,
} from "../../shared/executable-plugin-management.js";
import { getPluginStorageCoordinator, PluginStorageBudgetFault, type PluginStorageCoordinator } from "./plugin-storage-coordinator.js";
import type { PluginStorageGuard } from "./plugin-storage-coordinator.js";
import { PluginMaintenanceFault } from "./plugin-storage-maintenance-files.js";
import type { PluginMaintenancePreview, PluginMaintenanceResult } from "../../shared/plugin-maintenance.js";

const INDEX_BYTES = 16 * 1024 * 1024, MAX_PLUGINS = 50, HISTORY = 3;
const PREVIEW_MS = 10 * 60 * 1000, MAX_PREVIEWS = 4;
const HASH = /^[a-f0-9]{64}$/;
interface Index { readonly schemaVersion: 1; readonly revision: number; readonly items: readonly InstalledExecutablePlugin[] }
interface PreviewRecord { readonly value: ExecutablePluginPreview; readonly packageJson: string; readonly expires: number; readonly revision: number; readonly hostRevision: number }
export interface ExecutablePluginStoreOptions {
  /** Trusted Electron profile directory, never provided by renderer/plugin content. */
  profileDir: string;
  chooseFile(): Promise<string | undefined | null>;
  now?: () => number;
  storage?: PluginStorageCoordinator;
}
export class ExecutablePluginStoreFault extends Error {}
function fault(message: string): never { throw new ExecutablePluginStoreFault(message); }
function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException | null)?.code === "ENOENT"; }
function hash(text: string): string { return createHash("sha256").update(text, "utf8").digest("hex"); }
function own<const T extends object>(value: T): Readonly<T> { return Object.freeze(Object.assign(Object.create(null) as T, value)); }
function record(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some((key) => !keys.includes(key))) fault("插件记录格式不正确。");
  return raw as Record<string, unknown>;
}
function counter(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0 || raw >= Number.MAX_SAFE_INTEGER) fault("插件记录版本不正确。");
  return raw;
}
function next(raw: number): number { if (raw >= Number.MAX_SAFE_INTEGER - 1) fault("插件记录版本已达到上限。"); return raw + 1; }
function digest(raw: unknown): string { if (typeof raw !== "string" || !HASH.test(raw)) fault("插件内容标识不正确。"); return raw; }
function date(raw: unknown): string {
  if (typeof raw !== "string" || raw.length !== 24 || !Number.isFinite(Date.parse(raw)) || new Date(raw).toISOString() !== raw) fault("插件记录日期不正确。");
  return raw;
}
function boundedList(raw: unknown, maximum: number): unknown[] {
  if (!Array.isArray(raw) || raw.length > maximum) fault("插件记录数量不正确。");
  return raw;
}
function selectedGrants(manifest: ExecutablePluginManifest, raw: unknown): readonly ExecutablePluginCapability[] {
  const names = boundedList(raw, manifest.capabilities.length);
  if (names.some((name) => typeof name !== "string") || new Set(names).size !== names.length) fault("请明确选择本次授予的能力，不能重复或添加未声明能力。");
  const capabilities = names.map((name) => {
    const capability = manifest.capabilities.find((item) => item.name === name);
    if (!capability) fault("不能授予插件未声明的能力。");
    return capability;
  });
  return Object.freeze(capabilities.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
function storedGrants(manifest: ExecutablePluginManifest, raw: unknown): readonly ExecutablePluginCapability[] {
  const entries = boundedList(raw, manifest.capabilities.length);
  const names = entries.map((item) => record(item, ["name", "origins", "methods"]).name);
  const grants = selectedGrants(manifest, names);
  for (const item of entries) {
    const entry = item as Record<string, unknown>, declared = grants.find((capability) => capability.name === entry.name)!;
    // First-stage grants select a complete declared capability. A persisted
    // network grant cannot quietly widen or narrow its origin/method preview.
    if (declared.name === "network.request") {
      if (Object.keys(entry).length !== 3 || !Array.isArray(entry.origins) || !Array.isArray(entry.methods)
        || JSON.stringify(entry.origins) !== JSON.stringify(declared.origins) || JSON.stringify(entry.methods) !== JSON.stringify(declared.methods)) fault("插件授权记录不匹配。");
    } else if (Object.keys(entry).length !== 1) fault("插件授权记录不匹配。");
  }
  return grants;
}
function parseIndex(text: string): Index {
  const raw = record(JSON.parse(text), ["schemaVersion", "revision", "items"]);
  if (raw.schemaVersion !== 1) fault("不支持此插件存储版本。");
  const revision = counter(raw.revision);
  const items = boundedList(raw.items, MAX_PLUGINS).map((input): InstalledExecutablePlugin => {
    const item = record(input, ["manifest", "contentHash", "enabled", "grantRevision", "grantedCapabilities", "history", "installedAt", "updatedAt"]);
    const manifest = parseExecutablePluginManifest(JSON.stringify(item.manifest)), contentHash = digest(item.contentHash);
    if (typeof item.enabled !== "boolean") fault("插件启用记录不正确。");
    const history = boundedList(item.history, HISTORY).map((input): ExecutablePluginVersion => {
      const version = record(input, ["contentHash", "version", "installedAt"]);
      if (typeof version.version !== "string" || !/^(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})$/.test(version.version)) fault("插件历史版本不正确。");
      return own({ contentHash: digest(version.contentHash), version: version.version, installedAt: date(version.installedAt) });
    });
    if (new Set([contentHash, ...history.map((entry) => entry.contentHash)]).size !== history.length + 1) fault("插件历史版本重复。");
    return own({ manifest, contentHash, enabled: item.enabled, grantRevision: counter(item.grantRevision),
      grantedCapabilities: storedGrants(manifest, item.grantedCapabilities), history: Object.freeze(history),
      installedAt: date(item.installedAt), updatedAt: date(item.updatedAt) });
  });
  if (new Set(items.map((item) => item.manifest.id)).size !== items.length) fault("插件标识重复。");
  return own({ schemaVersion: 1, revision, items: Object.freeze(items) });
}

/** Bounded read, including file growth after stat; never follows a selected symlink. */
async function readBounded(file: string, maximum: number): Promise<string> {
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximum) fault("文件不可读取或超过大小限制。");
  const handle = await open(file, "r");
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > maximum) fault("文件在读取前已变化。");
    const chunks: Buffer[] = [];
    let length = 0;
    while (length <= maximum) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, maximum + 1 - length));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, length);
      if (!bytesRead) break;
      chunks.push(chunk.subarray(0, bytesRead)); length += bytesRead;
    }
    if (length > maximum) fault("文件超过大小限制。");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, length));
  } finally { await handle.close(); }
}
async function safeDirectory(path: string, create: boolean): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) fault("插件存储目录不可用。");
    return true;
  } catch (error) {
    if (!isMissing(error)) throw error;
    if (!create) return false;
    await mkdir(path, { recursive: true });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) fault("插件存储目录不可用。");
    return true;
  }
}
interface OwnedFile { readonly dev: bigint; readonly ino: bigint }
async function removeOwned(file: string, identity: OwnedFile): Promise<void> {
  try {
    const current = await lstat(file, { bigint: true });
    if (current.isFile() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino) await unlink(file);
  } catch (error) { if (!isMissing(error)) throw error; }
}
async function writeNew(file: string, text: string): Promise<OwnedFile> {
  const handle = await open(file, "wx", 0o600);
  let identity: OwnedFile | undefined;
  try {
    const created = await handle.stat({ bigint: true }); identity = { dev: created.dev, ino: created.ino };
    await handle.writeFile(text, "utf8"); await handle.sync(); await handle.close();
    return identity;
  } catch (error) {
    await handle.close().catch(() => {});
    // A failed wx open never reaches this block. Preserve any pre-existing or
    // subsequently replaced file; only our own partial write can be removed.
    if (identity) await removeOwned(file, identity).catch(() => {});
    throw error;
  }
}

/**
 * One serialized store for the host profile. Blobs are immutable; uninstall and
 * history eviction never delete source files or blobs that backups may reference.
 * Cross-process writers are not supported by this single-instance desktop store.
 */
export class ExecutablePluginStore {
  private readonly directory: string;
  private readonly blobs: string;
  private readonly indexFile: string;
  private readonly backupFile: string;
  private readonly now: () => number;
  private readonly storage: PluginStorageCoordinator;
  private readonly profileDir: string;
  private readonly writeSignal = new AbortController().signal;
  private queue: Promise<unknown> = Promise.resolve();
  private pendingOperations = 0;
  private readonly maintenanceBindings = new Map<string, { hostRevision: number; signature: string; expiresAt: string }>();
  private previews = new Map<string, PreviewRecord>();
  private listeners = new Set<(snapshot: ExecutablePluginSnapshot) => void>();
  private snapshot: ExecutablePluginSnapshot = own({ revision: 0, hostRevision: 0, items: Object.freeze([]) });
  private fingerprint: string | undefined;
  private loadedText: string | undefined;
  private knownRevision = 0;
  private grantFloors = new Map<string, number>();
  private suspectBlobs = new Set<string>();
  private rejectedIndexHash: string | undefined;

  constructor(private readonly options: ExecutablePluginStoreOptions) {
    this.profileDir = options.profileDir;
    this.storage = options.storage ?? getPluginStorageCoordinator(options.profileDir);
    this.directory = join(options.profileDir, "plugins-v2");
    this.blobs = join(this.directory, "blobs");
    this.indexFile = join(this.directory, "index.json");
    this.backupFile = `${this.indexFile}.backup`;
    this.now = options.now ?? Date.now;
  }
  get hostRevision(): number { return this.snapshot.hostRevision; }
  get isBusy(): boolean { return this.pendingOperations > 0; }
  current(id: string): InstalledExecutablePlugin | undefined {
    return this.fingerprint !== undefined && !this.snapshot.damaged ? this.snapshot.items.find((item) => item.manifest.id === id) : undefined;
  }
  subscribe(listener: (snapshot: ExecutablePluginSnapshot) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  private publish(index: Pick<Index, "revision" | "items">, fingerprint: string, damaged = false): ExecutablePluginSnapshot {
    this.knownRevision = Math.max(this.knownRevision, index.revision);
    for (const item of index.items) this.grantFloors.set(item.manifest.id, Math.max(item.grantRevision, this.grantFloors.get(item.manifest.id) ?? 0));
    if (this.fingerprint === fingerprint && this.snapshot.damaged === (damaged || undefined)) return this.snapshot;
    this.fingerprint = fingerprint;
    this.snapshot = own({ revision: index.revision, hostRevision: next(this.snapshot.hostRevision), items: Object.freeze([...index.items]), ...(damaged ? { damaged: true } : {}) });
    this.previews.clear();
    for (const listener of this.listeners) { try { listener(this.snapshot); } catch { /* Observers cannot undo a completed disk commit. */ } }
    return this.snapshot;
  }
  private damaged(): ExecutablePluginSnapshot {
    this.loadedText = undefined;
    return this.publish({ revision: this.knownRevision, items: [] }, "damaged", true);
  }
  private async readBlob(contentHash: string): Promise<{ packageJson: string; pkg: ExecutablePluginPackage }> {
    try {
      const packageJson = await readBounded(join(this.blobs, `${digest(contentHash)}.json`), EXECUTABLE_PLUGIN_LIMITS.jsonBytes);
      const pkg = parseExecutablePluginPackage(packageJson);
      if (hash(packageJson) !== contentHash || JSON.stringify(pkg) !== packageJson) fault("插件文件内容与安装记录不一致。");
      this.suspectBlobs.delete(contentHash);
      return { packageJson, pkg };
    } catch (error) { this.suspectBlobs.add(contentHash); throw error; }
  }
  private async readIndex(file: string): Promise<{ index: Index; text: string }> {
    const text = await readBounded(file, INDEX_BYTES), index = parseIndex(text);
    if (index.items.length && !await safeDirectory(this.blobs, false)) fault("插件文件目录已缺失。");
    for (const item of index.items) {
      const { pkg } = await this.readBlob(item.contentHash);
      if (JSON.stringify(pkg.manifest) !== JSON.stringify(item.manifest)) fault("插件清单与安装记录不一致。");
    }
    return { index, text };
  }
  private async verifyHistory(index: Index, fingerprint?: string): Promise<void> {
    for (const item of index.items) for (const version of item.history) {
      const { pkg } = await this.readBlob(version.contentHash);
      if (pkg.manifest.id !== item.manifest.id || pkg.manifest.version !== version.version) {
        if (fingerprint) this.rejectedIndexHash = fingerprint;
        fault("历史插件信息与文件不一致。");
      }
    }
  }
  private async load(): Promise<ExecutablePluginSnapshot> {
    try {
      const exists = await safeDirectory(this.directory, false);
      if (!exists) {
        if (this.knownRevision > 0) return this.damaged();
        this.loadedText = undefined;
        return this.publish({ revision: 0, items: [] }, "empty");
      }
      try {
        const { index, text } = await this.readIndex(this.indexFile);
        const fingerprint = hash(text);
        if (fingerprint === this.rejectedIndexHash) return this.damaged();
        // Establish a full baseline once at initialization; subsequent UI lists
        // recheck active blobs plus previously discovered faults, not every archive.
        if (this.fingerprint === undefined) await this.verifyHistory(index, fingerprint);
        // A failed history/installation read must not become silently healthy on
        // the next active-only list. Recheck known faults until repaired/recovered.
        for (const contentHash of [...this.suspectBlobs]) await this.readBlob(contentHash);
        this.loadedText = text;
        this.rejectedIndexHash = undefined;
        return this.publish(index, fingerprint);
      } catch (error) {
        if (!isMissing(error)) return this.damaged();
        // Missing active blobs also throw ENOENT. Only a genuinely absent index
        // in an otherwise empty layout is a new store, not an automatic reset.
        try { await lstat(this.indexFile); return this.damaged(); } catch (indexError) { if (!isMissing(indexError)) return this.damaged(); }
        const entries = await readdir(this.directory);
        if (this.knownRevision > 0 || entries.some((entry) => entry !== "blobs")) return this.damaged();
        if (entries.includes("blobs") && (!await safeDirectory(this.blobs, false) || (await readdir(this.blobs)).length > 0)) return this.damaged();
        this.loadedText = undefined;
        return this.publish({ revision: 0, items: [] }, "empty");
      }
    } catch { return this.damaged(); }
  }
  private serialized<T>(run: () => Promise<T>): Promise<T> {
    this.pendingOperations++;
    const result = this.queue.then(run).finally(() => { this.pendingOperations--; });
    this.queue = result.catch(() => {}); return result;
  }
  private previewSignature(): string {
    return hash(JSON.stringify([...this.previews.values()].filter(entry => entry.expires > this.now())
      .map(entry => [entry.value.id, entry.value.contentHash, entry.expires, entry.revision, entry.hostRevision, hash(entry.packageJson)])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))));
  }
  private maintenanceGuard(hostRevision: number, signature: string, guard: PluginStorageGuard): PluginStorageGuard {
    return { signal: guard.signal, assertCurrent: () => {
      if (guard.signal.aborted) throw new PluginMaintenanceFault("cancelled");
      guard.assertCurrent();
      if (this.options.profileDir !== this.profileDir || hostRevision !== this.hostRevision || signature !== this.previewSignature())
        throw new PluginMaintenanceFault("changed");
    } };
  }
  private maintenanceError(error: unknown, guard: PluginStorageGuard): never {
    if (error instanceof PluginMaintenanceFault) throw error;
    if (guard.signal.aborted) throw new PluginMaintenanceFault("cancelled");
    throw new PluginMaintenanceFault(error instanceof PluginStorageBudgetFault && error.reason === "changed" ? "changed" : "unavailable");
  }
  previewMaintenance(hostRevision: number, guard: PluginStorageGuard): Promise<PluginMaintenancePreview> {
    if (this.isBusy) return Promise.reject(new PluginMaintenanceFault("busy"));
    return this.serialized(async () => {
      if (!Number.isSafeInteger(hostRevision) || hostRevision !== this.hostRevision) throw new PluginMaintenanceFault("changed");
      const signature = this.previewSignature(), checked = this.maintenanceGuard(hostRevision, signature, guard);
      checked.assertCurrent();
      const inspected = await this.storage.inspectMaintenance(checked);
      const hashes = new Set<string>(), reasons = new Set<string>(); let complete = inspected.referencesSafe;
      for (const reference of inspected.references) {
        if (reference.missing || reference.unavailable || reference.text === undefined) {
          complete = false;
          reasons.add(reference.name === "index.json" ? "当前安装索引缺失或无法核验，孤儿包已保留。"
            : reference.name === "index.json.backup" ? "安装备份缺失或无法核验，孤儿包已保留。" : "保留的旧归档引用无法核验，孤儿包已保留。");
          continue;
        }
        try {
          const index = parseIndex(reference.text);
          for (const item of index.items) {
            hashes.add(item.contentHash); for (const version of item.history) hashes.add(version.contentHash);
          }
        } catch { complete = false; reasons.add("部分安装索引或旧归档无法按完整格式解析，孤儿包已保留；可单独明确选择旧归档。"); }
      }
      for (const entry of this.previews.values()) if (entry.expires > this.now()) hashes.add(entry.value.contentHash);
      checked.assertCurrent();
      const view = await this.storage.prepareMaintenance(inspected.id, [...hashes], complete, [...reasons], hostRevision, checked);
      while (this.maintenanceBindings.size >= 4) {
        const id = this.maintenanceBindings.keys().next().value!; this.maintenanceBindings.delete(id); this.storage.discardMaintenance(id);
      }
      this.maintenanceBindings.set(view.id, { hostRevision, signature, expiresAt: view.expiresAt }); return view;
    }).catch(error => this.maintenanceError(error, guard));
  }
  confirmMaintenance(previewId: string, selectedIds: readonly string[], hostRevision: number, guard: PluginStorageGuard): Promise<PluginMaintenanceResult> {
    if (this.isBusy) { this.discardMaintenance(previewId); return Promise.reject(new PluginMaintenanceFault("busy")); }
    const ids = Array.isArray(selectedIds) ? Object.freeze([...selectedIds]) : selectedIds;
    return this.serialized(async () => {
      const binding = this.maintenanceBindings.get(previewId);
      if (!binding || binding.hostRevision !== hostRevision || Date.parse(binding.expiresAt) <= Date.now()) throw new PluginMaintenanceFault("changed");
      const checked = this.maintenanceGuard(hostRevision, binding.signature, guard); checked.assertCurrent();
      return this.storage.deleteConfirmedMaintenance(previewId, ids, checked);
    }).catch(error => this.maintenanceError(error, guard)).finally(() => {
      for (const id of this.maintenanceBindings.keys()) this.storage.discardMaintenance(id);
      this.maintenanceBindings.clear();
    });
  }
  discardMaintenance(id: string): void { this.maintenanceBindings.delete(id); this.storage.discardMaintenance(id); }
  request(raw: ExecutablePluginManagementRequest): Promise<ExecutablePluginManagementReply> {
    let input: ExecutablePluginManagementRequest;
    try { input = this.copyRequest(raw); }
    catch { return Promise.resolve({ ok: false, message: "插件请求格式不正确。" }); }
    return this.serialized(() => this.perform(input)).catch((error): ExecutablePluginManagementReply => ({
      ok: false, message: error instanceof ExecutablePluginStoreFault || error instanceof PluginStorageBudgetFault ? error.message : "插件操作未保存。原有安装记录仍保留，请检查存储后重试。",
    }));
  }
  /** The IPC boundary supplies structured-cloned data; copy selection arrays before queueing. */
  private copyRequest(raw: ExecutablePluginManagementRequest): ExecutablePluginManagementRequest {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) fault("请求格式不正确。");
    const keys: Record<ExecutablePluginManagementRequest["kind"], readonly string[]> = {
      list: ["kind"], preview: ["kind"], restore: ["kind"], reset: ["kind"], discard: ["kind", "previewId"],
      confirm: ["kind", "previewId", "revision", "grants"], "rollback-preview": ["kind", "id", "contentHash", "revision"],
      enable: ["kind", "id", "enabled", "revision"], remove: ["kind", "id", "revision"], grants: ["kind", "id", "grants", "revision"],
    };
    if (!Object.hasOwn(keys, raw.kind)) fault("请求格式不正确。");
    record(raw, keys[raw.kind]);
    if (Object.keys(raw).length !== keys[raw.kind].length) fault("请求缺少字段。");
    if ("revision" in raw) counter(raw.revision);
    if ("id" in raw && (typeof raw.id !== "string" || raw.id.length > 80)) fault("插件标识不正确。");
    if ("previewId" in raw && (typeof raw.previewId !== "string" || raw.previewId.length > 80)) fault("预览标识不正确。");
    if ("contentHash" in raw) digest(raw.contentHash);
    if ("enabled" in raw && typeof raw.enabled !== "boolean") fault("启用状态不正确。");
    if ("grants" in raw) {
      const grants = boundedList(raw.grants, 12);
      if (grants.some((value) => typeof value !== "string" || value.length > 40)) fault("能力选择不正确。");
      return { ...raw, grants: Object.freeze([...grants]) as readonly ExecutablePluginCapabilityName[] };
    }
    return { ...raw };
  }
  async resolve(id: string, contentHash: string, scope: "chat" | "workbench", actionId: string): Promise<{ packageJson: string; item: InstalledExecutablePlugin }> {
    return this.serialized(async () => {
      const snapshot = await this.load(), item = this.current(id);
      const action = item?.manifest.actions.find((entry) => entry.id === actionId);
      if (snapshot.damaged || !item?.enabled || item.contentHash !== contentHash || (scope !== "chat" && scope !== "workbench")
        || !action || (action.scope !== "both" && action.scope !== scope)) fault("插件已更新、停用或不可用，请重新选择。");
      try { return { packageJson: (await this.readBlob(item.contentHash)).packageJson, item }; }
      catch { this.damaged(); return fault("插件文件已缺失或变化，运行已停止。请在插件设置中恢复记录。"); }
    });
  }
  /** Host-only generated content entry. It neither runs code nor installs a package. */
  previewGenerated(packageJson: string, expectedHostRevision: number, guard: PluginStorageGuard): Promise<{ snapshot: ExecutablePluginSnapshot; preview: ExecutablePluginPreview }> {
    return this.serialized(async () => {
      const check = () => {
        if (guard.signal.aborted) fault("插件制作已取消，未创建安装预览。");
        guard.assertCurrent();
        if (!Number.isSafeInteger(expectedHostRevision) || expectedHostRevision < 0 || this.hostRevision !== expectedHostRevision)
          fault("插件列表已变化，请重新检查候选。");
      };
      check(); const snapshot = await this.load(); check();
      if (snapshot.damaged) fault("插件记录或文件损坏。请先恢复记录。");
      let pkg: ExecutablePluginPackage;
      try { pkg = parseExecutablePluginPackage(packageJson); }
      catch { fault("生成内容不是有效的 v2 插件包，请修正后重新检查。"); }
      const preview = await this.preview(pkg, "generated", check);
      return { snapshot, preview };
    });
  }
  /** Immediate host revocation; a discarded authoring preview cannot use the
   * ordinary renderer confirmation route or survive a changed draft. */
  discardPreview(id: string): void { this.previews.delete(id); }
  confirmGenerated(previewId: string, revision: number, grants: readonly ExecutablePluginCapabilityName[], expectedHostRevision: number, guard: PluginStorageGuard): Promise<ExecutablePluginManagementReply> {
    let input: ExecutablePluginManagementRequest;
    try { input = this.copyRequest({ kind: "confirm", previewId, revision, grants }); }
    catch { return Promise.resolve({ ok: false, message: "制作安装请求格式不正确。" }); }
    return this.serialized(() => this.perform(input, { expectedHostRevision, guard })).catch((error): ExecutablePluginManagementReply => ({
      ok: false, message: error instanceof ExecutablePluginStoreFault || error instanceof PluginStorageBudgetFault ? error.message : "制作候选已变化或操作未完成，请重新检查后安装。",
    }));
  }
  private async preview(pkg: ExecutablePluginPackage, source: ExecutablePluginPreview["source"], assertCurrent?: () => void): Promise<ExecutablePluginPreview> {
    const existing = this.current(pkg.manifest.id), revision = this.snapshot.revision, hostRevision = this.hostRevision;
    let previous: ExecutablePluginPackage | undefined;
    if (existing) {
      try { previous = (await this.readBlob(existing.contentHash)).pkg; }
      catch { this.damaged(); fault("当前插件内容已变化，无法生成真实差异，请先恢复记录。"); }
      if (JSON.stringify(previous.manifest) !== JSON.stringify(existing.manifest)) {
        this.damaged(); fault("当前插件清单与内容不一致，无法生成真实差异。");
      }
    }
    await this.assertUnchanged(); assertCurrent?.();
    if (revision !== this.snapshot.revision || hostRevision !== this.hostRevision) fault("插件列表已变化，请重新预览。");
    const change = (path: string, kind: ExecutablePluginFileChange["kind"], before: string | null, after: string | null): ExecutablePluginFileChange => {
      const diff = computeUnifiedDiff(before ?? "", after ?? "", path), counts = countDiffLines(diff);
      return own({ path, kind, before, after, diff, additions: counts.add, deletions: counts.del,
        change: before === null ? "added" : after === null ? "removed" : before === after ? "unchanged" : "modified" });
    };
    const changes: ExecutablePluginFileChange[] = [change("manifest.json", "manifest",
      previous ? JSON.stringify(previous.manifest, null, 2) + "\n" : null, JSON.stringify(pkg.manifest, null, 2) + "\n")];
    const before = new Map(previous?.files.map(file => [file.path, file.source]) ?? []), after = new Map(pkg.files.map(file => [file.path, file.source]));
    for (const path of [...new Set([...before.keys(), ...after.keys()])].sort())
      changes.push(change(path, "module", before.get(path) ?? null, after.get(path) ?? null));
    const now = this.now();
    for (const [id, item] of this.previews) if (item.expires <= now) this.previews.delete(id);
    while (this.previews.size >= MAX_PREVIEWS) this.previews.delete(this.previews.keys().next().value!);
    const packageJson = JSON.stringify(pkg), contentHash = hash(packageJson);
    const value = own({ id: randomUUID(), manifest: pkg.manifest, contentHash, files: pkg.files,
      baseContentHash: existing?.contentHash ?? null, changes: Object.freeze(changes),
      ...(existing ? { existing } : {}), source, identical: existing?.contentHash === contentHash });
    this.previews.set(value.id, { value, packageJson, expires: now + PREVIEW_MS, revision: this.snapshot.revision, hostRevision: this.hostRevision });
    return value;
  }
  private mutate<T>(additionalPeakBytes: number, write: () => Promise<T>, repairBlobsLink = false): Promise<T> {
    const revision = this.hostRevision;
    const guard = { signal: this.writeSignal, assertCurrent: () => {
      if (this.options.profileDir !== this.profileDir || this.hostRevision !== revision) fault("插件资料位置或列表已变化，请重新检查。");
    } };
    return repairBlobsLink ? this.storage.withBlobsLinkRepair(additionalPeakBytes, guard, write) : this.storage.withWrite(additionalPeakBytes, guard, write);
  }
  private async ensureLayout(): Promise<void> {
    await this.mutate(0, async () => { await safeDirectory(this.directory, true); await safeDirectory(this.blobs, true); });
  }
  private async writeBlob(contentHash: string, packageJson: string): Promise<void> {
    const file = join(this.blobs, `${contentHash}.json`);
    let exists = false;
    try { await lstat(file); exists = true; } catch (error) { if (!isMissing(error)) throw error; }
    if (exists) {
      try { if ((await this.readBlob(contentHash)).packageJson !== packageJson) throw new Error("different-content"); }
      catch { fault("已有插件内容不匹配，未覆盖原文件。"); }
      return;
    }
    try { await this.mutate(Buffer.byteLength(packageJson, "utf8"), () => writeNew(file, packageJson)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        if ((await this.readBlob(contentHash)).packageJson === packageJson) return;
      }
      throw error;
    }
  }
  private async atomicFile(file: string, text: string, assertCurrent?: () => void): Promise<void> {
    await this.mutate(Buffer.byteLength(text, "utf8"), async () => {
    assertCurrent?.();
    const temp = `${file}.tmp-${randomUUID()}`;
    let owned: OwnedFile | undefined;
    try {
      try { const existing = await lstat(file); if (!existing.isFile() || existing.isSymbolicLink()) fault("插件存储目标不可用。"); }
      catch (error) { if (!isMissing(error)) throw error; }
      owned = await writeNew(temp, text); assertCurrent?.(); await rename(temp, file);
    } finally { if (owned) await removeOwned(temp, owned); }
    });
  }
  private async assertUnchanged(): Promise<void> {
    let current: string | undefined;
    try { current = await readBounded(this.indexFile, INDEX_BYTES); }
    catch (error) { if (!isMissing(error)) throw error; }
    if (current !== this.loadedText) { await this.load(); fault("插件列表已被其他操作修改，请重新预览。"); }
  }
  private async commit(index: Index, assertCurrent?: () => void): Promise<ExecutablePluginSnapshot> {
    const text = JSON.stringify(index);
    if (Buffer.byteLength(text, "utf8") > INDEX_BYTES) fault("插件索引已达到存储上限，请先移除不需要的插件。");
    assertCurrent?.(); await this.ensureLayout(); await this.assertUnchanged(); assertCurrent?.();
    if (this.loadedText !== undefined) await this.atomicFile(this.backupFile, this.loadedText, assertCurrent);
    await this.atomicFile(this.indexFile, text, assertCurrent);
    this.loadedText = text;
    return this.publish(index, hash(text));
  }
  private async recover(reset: boolean): Promise<ExecutablePluginSnapshot> {
    if (!this.snapshot.damaged) fault("当前插件记录无需恢复。");
    // A damaged blobs link cannot enter ordinary accounting. Only explicit
    // reset may ask the coordinator to replace that one link with a description.
    // The namespace directory itself is never repairable through this exception.
    let repairBlobsLink = false;
    if (reset && await safeDirectory(this.directory, false)) {
      try { repairBlobsLink = (await lstat(this.blobs)).isSymbolicLink(); }
      catch (error) { if (!isMissing(error)) throw error; }
    }
    if (!repairBlobsLink) await this.mutate(0, async () => { await safeDirectory(this.directory, true); });
    if (!reset) await this.ensureLayout();
    let previous: Index;
    if (reset) previous = own({ schemaVersion: 1, revision: this.knownRevision, items: Object.freeze([]) });
    else {
      try {
        previous = (await this.readIndex(this.backupFile)).index;
        await this.verifyHistory(previous);
      }
      catch { fault("没有可用的完整备份。可以选择另存损坏记录并重新开始，原文件不会删除。"); }
    }
    const updatedAt = new Date(this.now()).toISOString();
    const index: Index = own({ schemaVersion: 1, revision: next(Math.max(this.knownRevision, previous.revision)),
      items: Object.freeze(previous.items.map((item) => own({ ...item, enabled: false, grantedCapabilities: Object.freeze([]),
        grantRevision: next(Math.max(item.grantRevision, this.grantFloors.get(item.manifest.id) ?? 0)), updatedAt }))) });
    const text = JSON.stringify(index), temp = `${this.indexFile}.recovery-${randomUUID()}`;
    let owned: OwnedFile | undefined;
    if (Buffer.byteLength(text, "utf8") > INDEX_BYTES) fault("恢复记录超过存储上限。");
    await this.mutate(Buffer.byteLength(text, "utf8"), async () => { try {
      owned = await writeNew(temp, text);
      if (reset) {
        // Reset is explicit. Preserve the whole previous generation so a corrupt
        // content-addressed blob cannot permanently prevent safe reinstallation.
        const root = await realpath(this.directory), archiveName = `damaged-${randomUUID()}`;
        const archive = join(this.directory, archiveName);
        await mkdir(archive);
        if (relative(root, await realpath(archive)) !== archiveName) fault("插件存储路径已变化，已停止恢复。");
        for (const name of ["index.json", "index.json.backup", "blobs"]) {
          if (!await safeDirectory(this.directory, false) || await realpath(this.directory) !== root
            || relative(root, await realpath(archive)) !== archiveName) fault("插件存储路径已变化，已停止恢复。");
          const source = join(this.directory, name);
          try {
            const info = await lstat(source);
            // Linked blobs have already been detached and recorded by the narrow
            // coordinator repair. Other live links cannot pass normal accounting.
            if (info.isDirectory() && !info.isSymbolicLink() && relative(root, await realpath(source)) !== name) fault("插件存储路径已变化，已停止恢复。");
            await rename(source, join(archive, name));
          } catch (error) { if (!isMissing(error)) throw error; }
        }
        await safeDirectory(this.blobs, true);
      } else {
        // Preserve the corrupt entry without following a bad link into another
        // file. All destination components are generated by this host store.
        try { await rename(this.indexFile, `${this.indexFile}.damaged-${this.now()}-${randomUUID()}`); }
        catch (error) { if (!isMissing(error)) throw error; }
      }
      await rename(temp, this.indexFile);
    } finally { if (owned) await removeOwned(temp, owned); } }, repairBlobsLink);
    this.suspectBlobs.clear();
    this.rejectedIndexHash = undefined;
    this.loadedText = text;
    return this.publish(index, hash(text));
  }
  private async perform(input: ExecutablePluginManagementRequest, generated?: { expectedHostRevision: number; guard: PluginStorageGuard }): Promise<ExecutablePluginManagementReply> {
    const checkGenerated = generated ? () => {
      if (generated.guard.signal.aborted) fault("插件制作已取消，未提交安装。");
      generated.guard.assertCurrent();
      if (!Number.isSafeInteger(generated.expectedHostRevision) || generated.expectedHostRevision < 0 || generated.expectedHostRevision !== this.hostRevision) fault("安装列表已变化，请重新检查制作候选。");
    } : undefined;
    checkGenerated?.(); let snapshot = await this.load(); checkGenerated?.();
    if (input.kind === "list") return { ok: true, snapshot };
    if (input.kind === "discard") { this.previews.delete(input.previewId); return { ok: true, snapshot }; }
    if (input.kind === "restore" || input.kind === "reset") return { ok: true, snapshot: await this.recover(input.kind === "reset") };
    if (snapshot.damaged) fault("插件记录或文件损坏。请先恢复备份或另存损坏记录后重新开始。");
    if (input.kind === "preview") {
      const file = await this.options.chooseFile();
      if (!file) return { ok: true, snapshot };
      let pkg: ExecutablePluginPackage;
      try {
        const text = await readBounded(file, EXECUTABLE_PLUGIN_LIMITS.jsonBytes);
        pkg = parseExecutablePluginPackage(text.startsWith("\uFEFF") ? text.slice(1) : text);
      }
      catch { fault("无法导入所选文件。请使用不超过 2 MiB 的 UTF-8 v2 插件 JSON 文件。"); }
      // A file picker may be open for a while; bind the preview to current disk state.
      snapshot = await this.load();
      if (snapshot.damaged) fault("插件记录已变化，请先处理存储问题。");
      return { ok: true, snapshot, preview: await this.preview(pkg, "file") };
    }
    if (input.revision !== snapshot.revision) fault("插件列表已变化，请刷新后重试。");
    if (input.kind === "rollback-preview") {
      const item = this.current(input.id), target = item?.history.find((entry) => entry.contentHash === input.contentHash);
      if (!item || !target) fault("该历史版本已不在当前可回退列表中。");
      try {
        const { pkg } = await this.readBlob(target.contentHash);
        if (pkg.manifest.id !== item.manifest.id || pkg.manifest.version !== target.version) {
          if (this.loadedText !== undefined) this.rejectedIndexHash = hash(this.loadedText);
          throw new Error("history-mismatch");
        }
        return { ok: true, snapshot, preview: await this.preview(pkg, "rollback") };
      } catch { this.damaged(); fault("历史插件文件已缺失或变化，请先恢复记录。"); }
    }
    const items = [...snapshot.items], updatedAt = new Date(this.now()).toISOString();
    if (input.kind === "confirm") {
      const preview = this.previews.get(input.previewId);
      if (!preview || preview.expires <= this.now() || preview.revision !== snapshot.revision || preview.hostRevision !== this.hostRevision) fault("安装预览已过期或列表已变化，请重新预览。");
      if ((preview.value.source === "generated") !== !!generated) fault("制作候选需要从工坊重新核对后明确安装。");
      const old = this.current(preview.value.manifest.id);
      if ((old?.contentHash ?? null) !== preview.value.baseContentHash) fault("安装差异的基线已变化，请重新预览。");
      if (!old && items.length >= MAX_PLUGINS) fault("插件数量已达到 50 个，请先移除不需要的插件。");
      const grantedCapabilities = selectedGrants(preview.value.manifest, input.grants);
      const changed = old?.contentHash !== preview.value.contentHash;
      const history = old && changed ? [own({ contentHash: old.contentHash, version: old.manifest.version, installedAt: old.installedAt }),
        ...old.history.filter((entry) => entry.contentHash !== preview.value.contentHash)].slice(0, HISTORY) : old?.history ?? [];
      const item: InstalledExecutablePlugin = own({ manifest: preview.value.manifest, contentHash: preview.value.contentHash,
        enabled: old?.enabled ?? true, grantRevision: next(Math.max(old?.grantRevision ?? 0, this.grantFloors.get(preview.value.manifest.id) ?? 0)), grantedCapabilities,
        history: Object.freeze(history), installedAt: changed ? updatedAt : old!.installedAt, updatedAt });
      checkGenerated?.(); await this.ensureLayout(); checkGenerated?.();
      try { await this.writeBlob(item.contentHash, preview.packageJson); }
      catch (error) {
        if (error instanceof ExecutablePluginStoreFault) this.damaged();
        throw error;
      }
      const position = items.findIndex((entry) => entry.manifest.id === item.manifest.id);
      if (position < 0) items.push(item); else items[position] = item;
    } else {
      const position = items.findIndex((item) => item.manifest.id === input.id), old = items[position];
      if (!old) fault("插件已不存在，请刷新列表。");
      if (input.kind === "remove") items.splice(position, 1);
      else if (input.kind === "enable") items[position] = own({ ...old, enabled: input.enabled, grantRevision: next(old.grantRevision), updatedAt });
      else if (input.kind === "grants") items[position] = own({ ...old, grantedCapabilities: selectedGrants(old.manifest, input.grants), grantRevision: next(old.grantRevision), updatedAt });
      else fault("不支持的插件操作。");
    }
    snapshot = await this.commit(own({ schemaVersion: 1, revision: next(snapshot.revision), items: Object.freeze(items) }), checkGenerated);
    return { ok: true, snapshot };
  }
}
