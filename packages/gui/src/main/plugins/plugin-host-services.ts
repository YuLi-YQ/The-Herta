import { createHash, randomUUID } from "node:crypto";
import { promises as fs, type Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isPathInside, withPermissionMode } from "@herta/core";
import { resolveSafePath } from "@herta/tools";
import { parsePluginJson, PLUGIN_RUNTIME_LIMITS, type PluginJsonValue } from "../../shared/plugin-runtime.js";
import { PluginBrokerFault, type PluginCapabilityContext } from "./capability-broker.js";
import { getPluginStorageCoordinator, PluginStorageBudgetFault, type PluginStorageCoordinator, type PluginStorageGuard } from "./plugin-storage-coordinator.js";
import type { PrivatePluginDataAction, PrivatePluginDataInfo, PrivatePluginDataPreview, PrivatePluginDataResult } from "../../shared/plugin-private-data.js";

const TEXT_LIMIT = 128 * 1024;
const PRIVATE_LIMIT = 256 * 1024;
const PRIVATE_KEYS = 100;
const PRIVATE_DIRECTORY = "plugin-data-v2";
const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const PLUGIN_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
type Handle = Awaited<ReturnType<typeof fs.open>>;
function assertLive(context: PluginStorageGuard): void {
  if (context.signal.aborted) throw new PluginBrokerFault("cancelled");
  context.assertCurrent();
}
function denied(): never { throw new PluginBrokerFault("capability-denied"); }
function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function samePath(a: string, b: string): boolean {
  return process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
}
function textJson(text: string, maximum = PLUGIN_RUNTIME_LIMITS.outputBytes): string {
  if (Buffer.byteLength(text, "utf8") > maximum) throw new PluginBrokerFault("resource-limit");
  return text;
}
async function boundedRead(file: Handle, maximum: number, context: PluginStorageGuard): Promise<Buffer> {
  const bytes = Buffer.alloc(maximum + 1);
  let length = 0;
  while (length < bytes.length) {
    assertLive(context);
    const part = await file.read(bytes, length, bytes.length - length, length);
    assertLive(context);
    if (!part.bytesRead) break;
    length += part.bytesRead;
  }
  if (length > maximum) throw new PluginBrokerFault("resource-limit");
  return bytes.subarray(0, length);
}

/** Plugin read policy is narrower than the user-only viewer, even in full-access mode. */
export async function readPluginWorkspaceText(
  root: string, path: string, maxBytes: number | undefined,
  context: PluginCapabilityContext, protectedPaths: readonly string[], expectedPhysicalRoot?: string,
): Promise<string> {
  assertLive(context);
  const maximum = maxBytes ?? 64 * 1024;
  if (typeof root !== "string" || typeof path !== "string" || !path || path.length > 1024
    || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > TEXT_LIMIT) throw new PluginBrokerFault("invalid-input");
  let handle: Handle | undefined;
  try {
    const physicalRoot = await fs.realpath(root); assertLive(context);
    // Bind the selected project at run start, not only at the first capability call.
    if (expectedPhysicalRoot !== undefined && !samePath(physicalRoot, expectedPhysicalRoot)) denied();
    const safe = await withPermissionMode({
      getPermissionMode: () => ({ mode: "read-only", revision: Math.max(1, context.binding.permissionRevision) }),
      permissionProtectedPaths: protectedPaths,
    }, () => resolveSafePath(root, path));
    assertLive(context);
    if (!safe.ok || !isPathInside(physicalRoot, safe.resolved, { strict: true })) denied();
    const before = await fs.lstat(safe.resolved); assertLive(context);
    if (!before.isFile() || before.isSymbolicLink()) denied();
    if (before.size > maximum) throw new PluginBrokerFault("resource-limit");
    handle = await fs.open(safe.resolved, "r"); assertLive(context);
    const opened = await handle.stat(); assertLive(context);
    if (!opened.isFile() || !sameFile(before, opened)) denied();
    const openedPath = await fs.realpath(safe.resolved); assertLive(context);
    const openedRoot = await fs.realpath(root); assertLive(context);
    if (!samePath(openedPath, safe.resolved) || !samePath(openedRoot, physicalRoot) || !isPathInside(physicalRoot, openedPath, { strict: true })) denied();
    const bytes = await boundedRead(handle, maximum, context);
    const after = await handle.stat(); assertLive(context);
    const linked = await fs.lstat(safe.resolved); assertLive(context);
    const finalRoot = await fs.realpath(root); assertLive(context);
    const finalPath = await fs.realpath(safe.resolved); assertLive(context);
    if (!sameFile(opened, after) || !sameFile(after, linked) || linked.isSymbolicLink()
      || !samePath(finalRoot, physicalRoot) || !samePath(finalPath, safe.resolved)) denied();
    if (bytes.includes(0)) throw new PluginBrokerFault("invalid-input");
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new PluginBrokerFault("invalid-input"); }
    return textJson(JSON.stringify({ text, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }));
  } catch (error) {
    if (error instanceof PluginBrokerFault) throw error;
    assertLive(context);
    throw new PluginBrokerFault("host-error");
  } finally { if (handle) { await handle.close().catch(() => undefined); assertLive(context); } }
}

export class PluginStorageFault extends PluginBrokerFault {
  constructor(readonly reason: "damaged" | "unavailable" | "limit") {
    super(reason === "limit" ? "resource-limit" : "host-error");
    this.name = "PluginStorageFault";
  }
}
interface StorageRecord { schemaVersion: 1; pluginIdHash: string; values: Record<string, PluginJsonValue> }
interface Loaded { record: StorageRecord; stamp?: Stats }
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === "ENOENT";
function ownValues(): Record<string, PluginJsonValue> { return Object.create(null); }
function checkIdentity(pluginId: string, key: string, context: PluginCapabilityContext): string {
  assertLive(context);
  if (typeof pluginId !== "string" || pluginId.length < 3 || pluginId.length > 80 || !PLUGIN_ID.test(pluginId)
    || pluginId !== context.binding.pluginId || typeof key !== "string" || !KEY.test(key)
    || ["__proto__", "constructor", "prototype"].includes(key)) throw new PluginBrokerFault("invalid-input");
  return createHash("sha256").update(pluginId, "utf8").digest("hex");
}

const BACKUP_LIMIT = PRIVATE_LIMIT + 256, PREVIEW_TTL = 600000;
interface CapturedPrivateData { info: PrivatePluginDataInfo; safe: boolean; hash: string; stamp?: Stats; bytes?: Buffer; record?: StorageRecord }
interface PrivateRecovery { view: PrivatePluginDataPreview; current: CapturedPrivateData; backup: CapturedPrivateData; folder: string | null }
interface OwnedTemporary { path: string; stamp: Stats }
const PRIVATE_MESSAGES = {
  invalid: "插件资料请求格式不正确。", changed: "资料、插件状态或确认预览已变化，请重新预览。",
  unavailable: "插件资料操作未完成，保留的资料不会自动删除，请重新检查。",
  limit: "插件资料空间不足，原件保持不变。", cancelled: "插件资料操作已取消。",
  "no-backup": "没有可用的有效备份，不能恢复资料；可检查后明确重建并保留原件归档。",
} as const;
export class PluginPrivateDataFault extends Error {
  constructor(readonly reason: keyof typeof PRIVATE_MESSAGES) { super(PRIVATE_MESSAGES[reason]); this.name = "PluginPrivateDataFault"; }
}
function privateHash(bytes: Buffer | string): string { return createHash("sha256").update(bytes).digest("hex"); }
function hostPluginHash(pluginId: string): string {
  if (typeof pluginId !== "string" || pluginId.length < 3 || pluginId.length > 80 || !PLUGIN_ID.test(pluginId)) throw new PluginPrivateDataFault("invalid");
  return privateHash(pluginId);
}
function privateManagementError(error: unknown, guard: PluginStorageGuard): never {
  if (error instanceof PluginPrivateDataFault) throw error;
  if (guard.signal.aborted) throw new PluginPrivateDataFault("cancelled");
  if (error instanceof PluginStorageBudgetFault) throw new PluginPrivateDataFault(error.reason === "limit" ? "limit" : error.reason === "changed" ? "changed" : "unavailable");
  if (error instanceof PluginBrokerFault && error.code === "revoked") throw new PluginPrivateDataFault("changed");
  throw new PluginPrivateDataFault("unavailable");
}
function decodePrivateRecord(bytes: Buffer, id: string, backup: boolean): { record: StorageRecord; savedAt?: string } {
  const parsed = parsePluginJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes), backup ? BACKUP_LIMIT : PRIVATE_LIMIT);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new PluginStorageFault("damaged");
  const raw = parsed as Record<string, PluginJsonValue>;
  if (Object.keys(raw).length !== (backup ? 4 : 3) || raw.schemaVersion !== 1 || raw.pluginIdHash !== id
    || !raw.values || typeof raw.values !== "object" || Array.isArray(raw.values)) throw new PluginStorageFault("damaged");
  if (backup && (typeof raw.savedAt !== "string" || !Number.isFinite(Date.parse(raw.savedAt))
    || new Date(raw.savedAt).toISOString() !== raw.savedAt)) throw new PluginStorageFault("damaged");
  const keys = Object.keys(raw.values);
  if (keys.length > PRIVATE_KEYS || keys.some(key => !KEY.test(key) || ["__proto__", "constructor", "prototype"].includes(key))) throw new PluginStorageFault("damaged");
  const record: StorageRecord = { schemaVersion: 1, pluginIdHash: id, values: Object.assign(ownValues(), raw.values) };
  if (Buffer.byteLength(JSON.stringify(record), "utf8") > PRIVATE_LIMIT) throw new PluginStorageFault("damaged");
  return { record, ...(backup ? { savedAt: raw.savedAt as string } : {}) };
}
function missingPrivate(): CapturedPrivateData { return { info: Object.freeze({ state: "missing", bytes: 0 }), safe: true, hash: "missing" }; }
function sameCaptured(a: CapturedPrivateData, b: CapturedPrivateData): boolean {
  return a.safe && b.safe && a.hash === b.hash && (a.stamp ? !!b.stamp && sameFile(a.stamp, b.stamp) : !b.stamp);
}

/** Guest storage and explicit host recovery share one queue and the profile budget. */
export class PrivatePluginStorage {
  private tail: Promise<unknown> = Promise.resolve();
  private profilePhysical: string | undefined;
  private readonly profile: string;
  private readonly storage: PluginStorageCoordinator;
  private readonly recoveries = new Map<string, PrivateRecovery>();
  private readonly confirming = new Set<string>();
  constructor(profile: string, storage?: PluginStorageCoordinator) {
    this.profile = resolve(profile); this.storage = storage ?? getPluginStorageCoordinator(this.profile);
  }
  private serial<T>(context: PluginStorageGuard, operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => { assertLive(context); return operation(); });
    this.tail = result.then(() => undefined, () => undefined); return result;
  }
  private async directory(create: boolean, context: PluginStorageGuard): Promise<string | null> {
    const physical = await fs.realpath(this.profile); assertLive(context);
    if (this.profilePhysical !== undefined && physical !== this.profilePhysical) throw new PluginStorageFault("unavailable");
    this.profilePhysical ??= physical;
    const folder = join(physical, PRIVATE_DIRECTORY);
    if (create) { await fs.mkdir(folder, { recursive: true }); assertLive(context); }
    let entry: Stats;
    try { entry = await fs.lstat(folder); } catch (error) { assertLive(context); if (!create && missing(error)) return null; throw error; }
    assertLive(context);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new PluginStorageFault("unavailable");
    const actual = await fs.realpath(folder); assertLive(context);
    if (actual !== folder || !isPathInside(physical, actual, { strict: true })) throw new PluginStorageFault("unavailable");
    return folder;
  }
  private async capture(folder: string | null, id: string, backup: boolean, context: PluginStorageGuard): Promise<CapturedPrivateData> {
    if (!folder) return missingPrivate();
    const file = join(folder, id + ".json" + (backup ? ".backup" : "")), maximum = backup ? BACKUP_LIMIT : PRIVATE_LIMIT;
    let before: Stats;
    try { before = await fs.lstat(file); } catch (error) { assertLive(context); if (missing(error)) return missingPrivate(); throw error; }
    assertLive(context);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1 || before.size > maximum)
      return { info: Object.freeze({ state: "damaged", bytes: before.size }), safe: false, hash: "unsafe" };
    const handle = await fs.open(file, "r");
    try {
      assertLive(context); const opened = await handle.stat(); assertLive(context);
      if (!sameFile(before, opened)) throw new PluginStorageFault("unavailable");
      const bytes = await boundedRead(handle, maximum, context);
      const after = await handle.stat(), linked = await fs.lstat(file); assertLive(context);
      if (!sameFile(opened, after) || !sameFile(after, linked) || linked.isSymbolicLink() || linked.nlink > 1
        || await this.directory(false, context) !== folder) throw new PluginStorageFault("unavailable");
      const base = { safe: true, hash: privateHash(bytes), stamp: after, bytes };
      try {
        const decoded = decodePrivateRecord(bytes, id, backup);
        return { ...base, record: decoded.record, info: Object.freeze({ state: "valid", bytes: bytes.length,
          keys: Object.keys(decoded.record.values).length, ...(decoded.savedAt ? { savedAt: decoded.savedAt } : {}) }) };
      } catch { return { ...base, info: Object.freeze({ state: "damaged", bytes: bytes.length }) }; }
    } finally { await handle.close().catch(() => undefined); }
  }
  private async load(folder: string, id: string, context: PluginStorageGuard): Promise<Loaded> {
    const captured = await this.capture(folder, id, false, context);
    if (captured.info.state === "missing") return { record: { schemaVersion: 1, pluginIdHash: id, values: ownValues() } };
    if (!captured.record) throw new PluginStorageFault("damaged");
    return { record: captured.record, stamp: captured.stamp };
  }
  private async removeTemporary(temp: OwnedTemporary): Promise<void> {
    try {
      const parent = dirname(temp.path), directory = await fs.lstat(parent);
      if (directory.isDirectory() && !directory.isSymbolicLink() && samePath(await fs.realpath(parent), parent)) {
        const current = await fs.lstat(temp.path);
        if (current.isFile() && !current.isSymbolicLink() && current.dev === temp.stamp.dev && current.ino === temp.stamp.ino) await fs.unlink(temp.path);
      }
    } catch { /* Preserve uncertain or already-published paths. */ }
  }
  /** Only called while holding the profile write lock. */
  private async temporary(folder: string, id: string, bytes: Buffer, guard: PluginStorageGuard): Promise<OwnedTemporary> {
    const path = join(folder, "." + id + "." + randomUUID() + ".tmp"), handle = await fs.open(path, "wx", 0o600);
    let owned: OwnedTemporary | undefined;
    try {
      owned = { path, stamp: await handle.stat() }; assertLive(guard);
      await handle.writeFile(bytes, { signal: guard.signal }); assertLive(guard); await handle.sync(); assertLive(guard);
      return owned;
    } catch (error) {
      await handle.close().catch(() => undefined); if (owned) await this.removeTemporary(owned); throw error;
    } finally { await handle.close().catch(() => undefined); }
  }
  private async replace(folder: string, id: string, backup: boolean, bytes: Buffer, expected: CapturedPrivateData, guard: PluginStorageGuard): Promise<void> {
    const temp = await this.temporary(folder, id, bytes, guard);
    try {
      if (!sameCaptured(expected, await this.capture(folder, id, backup, guard))) throw new PluginPrivateDataFault("changed");
      assertLive(guard); await fs.rename(temp.path, join(folder, id + ".json" + (backup ? ".backup" : "")));
      // A committed file remains a fact even when cancellation arrives afterward.
    } finally { await this.removeTemporary(temp); }
  }
  get(pluginId: string, key: string, context: PluginCapabilityContext): Promise<string> {
    return this.serial(context, async () => {
      try {
        const id = checkIdentity(pluginId, key, context), folder = await this.directory(false, context);
        if (!folder) return "null";
        const loaded = await this.load(folder, id, context); assertLive(context);
        return textJson(JSON.stringify(loaded.record.values[key] ?? null));
      } catch (error) {
        if (error instanceof PluginBrokerFault) throw error;
        assertLive(context); throw new PluginStorageFault("unavailable");
      }
    });
  }
  set(pluginId: string, key: string, value: unknown, context: PluginCapabilityContext): Promise<string> {
    return this.serial(context, async () => {
      try {
        const id = checkIdentity(pluginId, key, context);
        let safeValue: PluginJsonValue;
        try { safeValue = parsePluginJson(JSON.stringify(value), PLUGIN_RUNTIME_LIMITS.argsBytes); }
        catch { throw new PluginBrokerFault("invalid-input"); }
        const folder = await this.directory(false, context) ?? await this.storage.withWrite(0, context, () => this.directory(true, context));
        if (!folder) throw new PluginStorageFault("unavailable");
        const current = await this.capture(folder, id, false, context), backup = await this.capture(folder, id, true, context);
        if (current.info.state === "damaged" || backup.info.state === "damaged") throw new PluginStorageFault("damaged");
        const values = Object.assign(ownValues(), current.record?.values); values[key] = safeValue;
        if (Object.keys(values).length > PRIVATE_KEYS) throw new PluginStorageFault("limit");
        const record: StorageRecord = { schemaVersion: 1, pluginIdHash: id, values }, encoded = JSON.stringify(record);
        if (Buffer.byteLength(encoded, "utf8") > PRIVATE_LIMIT) throw new PluginStorageFault("limit");
        try { parsePluginJson(encoded, PRIVATE_LIMIT); } catch { throw new PluginStorageFault("limit"); }
        const backupText = JSON.stringify({ ...(current.record ?? record), savedAt: new Date().toISOString() });
        const next = Buffer.from(encoded), previous = Buffer.from(backupText);
        try { decodePrivateRecord(previous, id, true); } catch { throw new PluginStorageFault("limit"); }
        return await this.storage.withWrite(next.length + previous.length, context, async () => {
          if (!sameCaptured(current, await this.capture(folder, id, false, context))
            || !sameCaptured(backup, await this.capture(folder, id, true, context))) throw new PluginPrivateDataFault("changed");
          await this.replace(folder, id, true, previous, backup, context);
          await this.replace(folder, id, false, next, current, context);
          return "null";
        });
      } catch (error) {
        if (error instanceof PluginBrokerFault) throw error;
        assertLive(context);
        if (error instanceof PluginStorageBudgetFault && error.reason === "limit") throw new PluginStorageFault("limit");
        throw new PluginStorageFault("unavailable");
      }
    });
  }
  previewRecovery(pluginId: string, action: PrivatePluginDataAction, hostRevision: number, guard: PluginStorageGuard): Promise<PrivatePluginDataPreview> {
    return this.serial(guard, async () => {
      const id = hostPluginHash(pluginId);
      if ((action !== "restore" && action !== "reset") || !Number.isSafeInteger(hostRevision) || hostRevision < 0) throw new PluginPrivateDataFault("invalid");
      // Snapshot participates in the shared queue without the create-capable
      // write admission path: preview must never create even a missing profile.
      await this.storage.snapshot(guard);
        const folder = await this.directory(false, guard), current = await this.capture(folder, id, false, guard), backup = await this.capture(folder, id, true, guard);
        const canConfirm = current.safe && backup.safe && (action === "reset" || backup.info.state === "valid");
        const view: PrivatePluginDataPreview = Object.freeze({ id: randomUUID(), pluginId, action, hostRevision,
          expiresAt: new Date(Date.now() + PREVIEW_TTL).toISOString(), current: current.info, backup: backup.info, canConfirm,
          ...(!current.safe || !backup.safe ? { warning: "资料无法安全核验，暂时不能恢复或重建。" }
            : action === "restore" && backup.info.state !== "valid" ? { warning: PRIVATE_MESSAGES["no-backup"] } : {}) });
        for (const [token, entry] of this.recoveries) if (Date.parse(entry.view.expiresAt) <= Date.now()) this.recoveries.delete(token);
        while (this.recoveries.size >= 8) this.recoveries.delete(this.recoveries.keys().next().value!);
        this.recoveries.set(view.id, { view, current, backup, folder }); return view;
    }).catch(error => privateManagementError(error, guard));
  }
  discardRecovery(previewId: string): void { this.recoveries.delete(previewId); }
  confirmRecovery(previewId: string, hostRevision: number, guard: PluginStorageGuard): Promise<PrivatePluginDataResult> {
    return this.serial(guard, async () => {
      const entry = this.recoveries.get(previewId);
      if (!entry || this.confirming.has(previewId) || entry.view.hostRevision !== hostRevision || Date.parse(entry.view.expiresAt) <= Date.now()) throw new PluginPrivateDataFault("changed");
      if (!entry.view.canConfirm) throw new PluginPrivateDataFault(entry.view.action === "restore" ? "no-backup" : "unavailable");
      this.confirming.add(previewId);
      const id = hostPluginHash(entry.view.pluginId), action = entry.view.action;
      const checked: PluginStorageGuard = { signal: guard.signal, assertCurrent: () => {
        assertLive(guard);
        if (this.recoveries.get(previewId) !== entry || Date.parse(entry.view.expiresAt) <= Date.now()) throw new PluginPrivateDataFault("changed");
      } };
      const record: StorageRecord = action === "restore" ? entry.backup.record! : { schemaVersion: 1, pluginIdHash: id, values: ownValues() };
      const next = Buffer.from(JSON.stringify(record));
      const nextBackup = action === "reset" ? Buffer.from(JSON.stringify({ ...record, savedAt: new Date().toISOString() })) : undefined;
      const archiveEntries = [
        ...(entry.current.bytes ? [{ name: "current.bin", bytes: entry.current.bytes }] : []),
        ...(action === "reset" && entry.backup.bytes ? [{ name: "backup.bin", bytes: entry.backup.bytes }] : []),
      ];
      const receipt = Buffer.from(JSON.stringify({ schemaVersion: 1, pluginIdHash: id, action, createdAt: new Date().toISOString(),
        files: archiveEntries.map(item => ({ name: item.name, bytes: item.bytes.length, sha256: privateHash(item.bytes) })) }));
      // Publishing an archive uses a hard link before removing its temp name.
      // Cleanup may fail for every entry, so reserve both logical names for all
      // archive files and the receipt, not only one transient maximum entry.
      const archiveBytes = archiveEntries.reduce((total, item) => total + item.bytes.length, 0)
        + (archiveEntries.length ? receipt.length : 0);
      const peak = next.length + (nextBackup?.length ?? 0) + 2 * archiveBytes;
      return this.storage.withWrite(peak, checked, async () => {
        const folder = await this.directory(false, checked);
        if (folder !== entry.folder || !sameCaptured(entry.current, await this.capture(folder, id, false, checked))
          || !sameCaptured(entry.backup, await this.capture(folder, id, true, checked))) throw new PluginPrivateDataFault("changed");
        const destination = folder ?? await this.directory(true, checked);
        if (!destination) throw new PluginPrivateDataFault("unavailable");
        if (archiveEntries.length) {
          const archive = join(destination, id + ".archive-" + randomUUID()); await fs.mkdir(archive); assertLive(checked);
          if (!samePath(await fs.realpath(archive), archive)) throw new PluginPrivateDataFault("changed");
          for (const file of [...archiveEntries, { name: "receipt.json", bytes: receipt }]) {
            const temp = await this.temporary(archive, id, file.bytes, checked);
            try { assertLive(checked); await fs.link(temp.path, join(archive, file.name)); }
            finally { await this.removeTemporary(temp); }
          }
        }
        if (nextBackup) await this.replace(destination, id, true, nextBackup, entry.backup, checked);
        await this.replace(destination, id, false, next, entry.current, checked);
        return Object.freeze({ pluginId: entry.view.pluginId, action, keys: Object.keys(record.values).length, bytes: next.length, archived: archiveEntries.length > 0 });
      });
    }).catch(error => privateManagementError(error, guard)).finally(() => { this.recoveries.delete(previewId); this.confirming.delete(previewId); });
  }
}
