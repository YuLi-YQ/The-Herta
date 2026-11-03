import fsSync, { promises as fs, type BigIntStats } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { PluginStorageCategory, PluginStorageCategoryId, PluginStorageSnapshot } from "../../shared/plugin-storage.js";
import type { PluginMaintenanceItem, PluginMaintenancePreview, PluginMaintenanceResult } from "../../shared/plugin-maintenance.js";
import { assertMaintenanceAncestors, assertMaintenanceNode, compactMaintenanceInspection, inspectMaintenanceFiles,
  maintenancePath, PluginMaintenanceFault, type MaintenanceInspection, type MaintenanceNode, type MaintenanceReference } from "./plugin-storage-maintenance-files.js";

export const PLUGIN_STORAGE_LIMITS = Object.freeze({ bytes: 512 * 1024 * 1024, entries: 40000, depth: 8 });
export interface PluginStorageGuard { readonly signal: AbortSignal; assertCurrent(): void }
export type PluginStorageBudgetReason = "limit" | "unavailable" | "cancelled" | "changed";
const MESSAGES: Record<PluginStorageBudgetReason, string> = Object.freeze({
  limit: "插件资料空间不足，请先检查或清理已有资料。",
  unavailable: "无法完整核对插件资料空间，原有文件保持不变。",
  cancelled: "插件资料操作已取消。",
  changed: "插件资料位置或当前操作已变化，请重新检查。",
});
export class PluginStorageBudgetFault extends Error {
  constructor(readonly reason: PluginStorageBudgetReason) { super(MESSAGES[reason]); this.name = "PluginStorageBudgetFault"; }
}
/** A repair has persisted evidence or detached the link; never claim no change. */
export class PluginStorageRepairFault extends PluginStorageBudgetFault {
  constructor(reason: PluginStorageBudgetReason, readonly phase: "recorded" | "detached") {
    super(reason); this.name = "PluginStorageRepairFault";
    this.message = phase === "detached"
      ? "损坏链接已隔离，描述记录仍保留，但插件列表重建未完成。链接目标未被读取或修改，请重试重建。"
      : "损坏链接的描述已保存，但隔离未完成。链接目标未被读取或修改，请重试重建。";
  }
}
interface RepairLink { readonly path: string; readonly stamp: BigIntStats; readonly target: string }
const fail = (reason: PluginStorageBudgetReason): never => { throw new PluginStorageBudgetFault(reason); };
const NAMESPACES: readonly { readonly id: PluginStorageCategoryId; readonly name: string }[] = Object.freeze([
  { id: "packages", name: "plugins-v2" }, { id: "private-data", name: "plugin-data-v2" },
  { id: "artifacts", name: "plugin-artifacts-v1" }, { id: "proposals", name: "plugin-patches-v2" },
  { id: "workshop", name: "plugin-workshop-v1" },
]);
const normalized = (path: string): string => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const sameIdentity = (left: BigIntStats, right: BigIntStats): boolean => left.dev === right.dev && left.ino === right.ino;
const sameFile = (left: BigIntStats, right: BigIntStats): boolean => sameIdentity(left, right)
  && left.size === right.size && left.nlink === right.nlink && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
const mutexes = new Map<string, Promise<void>>();
const defaults = new Map<string, PluginStorageCoordinator>();
interface MaintenancePlan {
  readonly view: PluginMaintenancePreview;
  readonly inspection: MaintenanceInspection;
  readonly selected: ReadonlyMap<string, MaintenanceInspection["candidates"][number]>;
}

function live(guard: PluginStorageGuard): void {
  if (!guard || !(guard.signal instanceof AbortSignal) || typeof guard.assertCurrent !== "function") fail("unavailable");
  if (guard.signal.aborted) fail("cancelled");
  try { guard.assertCurrent(); } catch { fail(guard.signal.aborted ? "cancelled" : "changed"); }
}

/** One host-process mutex per normalized profile; no filesystem-wide or OS transaction claim.
 * Callers enter their own local queue before withWrite and MUST NOT nest withWrite or wait
 * for user approval inside it. The callback must conservatively bound all new file bytes,
 * including temporary/backup peaks; existing file sizes are never deducted in advance. */
export class PluginStorageCoordinator {
  private readonly profile: string;
  private readonly key: string;
  private readonly limitBytes: number;
  private physical?: string;
  private identity?: BigIntStats;
  private readonly maintenanceInspections = new Map<string, { inspection: MaintenanceInspection; expires: number }>();
  private readonly maintenancePlans = new Map<string, MaintenancePlan>();
  constructor(profile: string, options: { limitBytes?: number } = {}) {
    if (typeof profile !== "string" || !profile.trim() || profile.includes("\0")) fail("unavailable");
    if (!options || typeof options !== "object" || Array.isArray(options)
      || Object.keys(options).some(key => key !== "limitBytes")) fail("unavailable");
    const limit = options.limitBytes ?? PLUGIN_STORAGE_LIMITS.bytes;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > PLUGIN_STORAGE_LIMITS.bytes) fail("unavailable");
    this.profile = resolve(profile); this.key = normalized(this.profile); this.limitBytes = limit;
  }
  private serial<T>(guard: PluginStorageGuard, work: () => Promise<T>): Promise<T> {
    const previous = mutexes.get(this.key) ?? Promise.resolve();
    const result = previous.then(() => { live(guard); return work(); });
    const tail = result.then(() => undefined, () => undefined);
    mutexes.set(this.key, tail);
    void tail.then(() => { if (mutexes.get(this.key) === tail) mutexes.delete(this.key); });
    return result;
  }
  private async io<T>(guard: PluginStorageGuard, operation: () => Promise<T>): Promise<T> {
    live(guard);
    try { const value = await operation(); live(guard); return value; }
    catch (error) { live(guard); if (error instanceof PluginStorageBudgetFault) throw error; throw error; }
  }
  private async root(guard: PluginStorageGuard, create: boolean): Promise<string | null> {
    let entry: BigIntStats;
    try { entry = await this.io(guard, () => fs.lstat(this.profile, { bigint: true })); }
    catch (error) {
      if (!missing(error)) throw error;
      if (this.identity) fail("changed");
      if (!create) return null;
      await this.io(guard, () => fs.mkdir(this.profile, { recursive: true }));
      entry = await this.io(guard, () => fs.lstat(this.profile, { bigint: true }));
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) fail("unavailable");
    const physical = await this.io(guard, () => fs.realpath(this.profile));
    const actual = await this.io(guard, () => fs.lstat(physical, { bigint: true }));
    if (!actual.isDirectory() || actual.isSymbolicLink() || !sameIdentity(entry, actual)) fail("changed");
    if ((this.physical && normalized(physical) !== normalized(this.physical)) || (this.identity && !sameIdentity(actual, this.identity))) fail("changed");
    this.physical ??= physical; this.identity ??= actual;
    return physical;
  }
  private async scan(guard: PluginStorageGuard, create: boolean, repairLink?: RepairLink): Promise<PluginStorageSnapshot> {
    try {
      const root = await this.root(guard, create);
      const categories: PluginStorageCategory[] = [];
      let entries = 0, usedBytes = 0, fileCount = 0;
      const linked = new Map<string, { stamp: BigIntStats; paths: string[] }>();
      const count = () => { if (++entries > PLUGIN_STORAGE_LIMITS.entries) fail("unavailable"); };
      if (root) for (const namespace of NAMESPACES) {
        const folder = join(root, namespace.name);
        let stat: BigIntStats;
        try { stat = await this.io(guard, () => fs.lstat(folder, { bigint: true })); }
        catch (error) { if (missing(error)) { categories.push(Object.freeze({ id: namespace.id, usedBytes: 0, fileCount: 0 })); continue; } throw error; }
        let bytes = 0, files = 0;
        const visit = async (path: string, current: BigIntStats, depth: number): Promise<void> => {
          count(); if (depth > PLUGIN_STORAGE_LIMITS.depth) fail("unavailable");
          if (current.isSymbolicLink()) {
            // Internal repair preflight only, never returned by snapshot(). Count
            // the known link representation; its target is deliberately unknown,
            // not zero-sized storage. Every other link still fails closed.
            if (!repairLink || normalized(path) !== normalized(repairLink.path)) return fail("unavailable");
            if (!sameFile(current, repairLink.stamp)
              || await this.io(guard, () => fs.readlink(path)) !== repairLink.target) fail("changed");
            const ownBytes = Number(current.size);
            if (!Number.isSafeInteger(ownBytes) || ownBytes < 0) fail("unavailable");
            bytes += Math.max(ownBytes, Buffer.byteLength(repairLink.target, "utf8")); files++;
            return;
          }
          if (current.isFile()) {
            if (current.size < 0n || current.size > BigInt(Number.MAX_SAFE_INTEGER) || current.nlink < 1n) fail("unavailable");
            bytes += Number(current.size); files++;
            if (!Number.isSafeInteger(bytes)) fail("unavailable");
            if (current.nlink > 1n) {
              const key = `${current.dev}:${current.ino}`, group = linked.get(key);
              if (group) { if (!sameFile(group.stamp, current)) fail("changed"); group.paths.push(path); }
              else linked.set(key, { stamp: current, paths: [path] });
            }
            return;
          }
          if (!current.isDirectory()) fail("unavailable");
          const physical = await this.io(guard, () => fs.realpath(path));
          if (normalized(physical) !== normalized(path)) fail("unavailable");
          // Capture the owned handle before checking a late cancellation so an
          // abort during opendir cannot leak it outside the cleanup block.
          live(guard);
          const handle = await fs.opendir(path);
          try {
            live(guard);
            for (;;) {
              const item = await this.io(guard, () => handle.read()); if (!item) break;
              const child = join(path, item.name);
              const childStat = await this.io(guard, () => fs.lstat(child, { bigint: true }));
              await visit(child, childStat, depth + 1); live(guard);
            }
          } finally { await handle.close(); }
          live(guard);
          const after = await this.io(guard, () => fs.lstat(path, { bigint: true }));
          if (!after.isDirectory() || after.isSymbolicLink() || !sameIdentity(current, after)
            || after.mtimeNs !== current.mtimeNs || after.ctimeNs !== current.ctimeNs) fail("changed");
        };
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail("unavailable");
        await visit(folder, stat, 0); live(guard);
        usedBytes += bytes; fileCount += files;
        if (!Number.isSafeInteger(usedBytes)) fail("unavailable");
        categories.push(Object.freeze({ id: namespace.id, usedBytes: bytes, fileCount: files }));
      }
      else for (const namespace of NAMESPACES) categories.push(Object.freeze({ id: namespace.id, usedBytes: 0, fileCount: 0 }));
      // A hard link is accountable only if every name is inside the scanned
      // namespaces. Each name counts its complete logical length, conservatively.
      for (const group of linked.values()) {
        if (BigInt(group.paths.length) !== group.stamp.nlink) fail("unavailable");
        for (const path of group.paths) {
          const after = await this.io(guard, () => fs.lstat(path, { bigint: true }));
          if (!after.isFile() || after.isSymbolicLink() || !sameFile(group.stamp, after)) fail("changed");
        }
      }
      if (root && await this.root(guard, false) !== root) fail("changed");
      live(guard);
      return Object.freeze({ status: "ready", usedBytes, limitBytes: this.limitBytes,
        availableBytes: Math.max(0, this.limitBytes - usedBytes), fileCount, overLimit: usedBytes > this.limitBytes,
        categories: Object.freeze(categories) });
    } catch (error) { live(guard); if (error instanceof PluginStorageBudgetFault) throw error; return fail("unavailable"); }
  }
  snapshot(guard: PluginStorageGuard): Promise<PluginStorageSnapshot> {
    return this.serial(guard, () => this.scan(guard, false));
  }
  withWrite<T>(additionalPeakBytes: number, guard: PluginStorageGuard, write: () => Promise<T>): Promise<T> {
    return this.serial(guard, async () => {
      if (!Number.isSafeInteger(additionalPeakBytes) || additionalPeakBytes < 0 || typeof write !== "function") fail("unavailable");
      const snapshot = await this.scan(guard, true); live(guard);
      if (additionalPeakBytes > 0 && (snapshot.overLimit || additionalPeakBytes > snapshot.availableBytes)) fail("limit");
      live(guard);
      // The trusted callback owns its commit point. Do not turn a published
      // success into cancellation because the signal changed after publication.
      // Any failed-write residue is counted by the next disk scan, never a ledger.
      return write();
    });
  }

  /** Read-only host inspection. No ordinary scan exception or write callback. */
  inspectMaintenance(guard: PluginStorageGuard): Promise<{
    id: string; references: readonly MaintenanceReference[]; referencesSafe: boolean; warnings: readonly string[]; empty: boolean;
  }> {
    return this.serial(guard, async () => {
      const root = await this.root(guard, false); if (!root) throw new PluginMaintenanceFault("unavailable");
      const inspection = await inspectMaintenanceFiles(root, guard), id = randomUUID(), now = Date.now();
      for (const [key, value] of this.maintenanceInspections) if (value.expires <= now) this.maintenanceInspections.delete(key);
      while (this.maintenanceInspections.size >= 4) this.maintenanceInspections.delete(this.maintenanceInspections.keys().next().value!);
      this.maintenanceInspections.set(id, { inspection, expires: now + 600000 });
      return { id, references: inspection.references, referencesSafe: inspection.referencesSafe, warnings: inspection.warnings, empty: !inspection.folder };
    });
  }
  /** Store supplies hashes obtained with its strict index parser, never renderer paths. */
  prepareMaintenance(inspectionId: string, protectedHashes: readonly string[], referencesComplete: boolean,
    reasons: readonly string[], hostRevision: number, guard: PluginStorageGuard): Promise<PluginMaintenancePreview> {
    return this.serial(guard, async () => {
      const captured = this.maintenanceInspections.get(inspectionId); this.maintenanceInspections.delete(inspectionId);
      if (!captured || captured.expires <= Date.now()) throw new PluginMaintenanceFault("changed");
      if (!Array.isArray(protectedHashes) || protectedHashes.some(hash => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))
        || typeof referencesComplete !== "boolean" || !Number.isSafeInteger(hostRevision) || hostRevision < 0
        || !Array.isArray(reasons) || reasons.length > 32 || reasons.some(reason => typeof reason !== "string" || reason.length > 300)) throw new PluginMaintenanceFault("invalid");
      const root = await this.root(guard, false); if (!root || root !== captured.inspection.root) throw new PluginMaintenanceFault("changed");
      const current = await inspectMaintenanceFiles(root, guard);
      if (current.fingerprint !== captured.inspection.fingerprint) throw new PluginMaintenanceFault("changed");
      let usageKnown = true;
      try { await this.scan(guard, false); } catch { live(guard); usageKnown = false; }
      const protectedSet = new Set(protectedHashes), blockedReasons = new Set([...current.warnings, ...reasons]);
      if (!referencesComplete || !current.referencesSafe) blockedReasons.add("安装包引用无法完整确认，未提供孤儿包删除；独立旧归档和精确临时文件仍可逐项确认。");
      if (!usageKnown) blockedReasons.add("总占用仍无法核对，仅可删除独立核验的旧资料；普通写入与链接保护仍有效。");
      const candidates = current.candidates.filter(item => item.category !== "blob"
        || referencesComplete && current.referencesSafe && usageKnown && !protectedSet.has(item.hash!));
      if (candidates.length > 256) blockedReasons.add("本次最多展示256项，完成后可重新检查剩余资料。");
      const inspection = compactMaintenanceInspection(current), selected = new Map<string, MaintenanceInspection["candidates"][number]>();
      const items: PluginMaintenanceItem[] = candidates.slice(0, 256).map(candidate => {
        const id = randomUUID(), stored = inspection.candidates.find(item => item.name === candidate.name)!; selected.set(id, stored);
        const label = candidate.category === "blob" ? "未引用插件包 " + candidate.hash!.slice(0, 12)
          : candidate.category === "temporary" ? "安装临时文件 " + new Date(Number(candidate.node.stamp.mtimeMs)).toISOString()
          : "旧安装归档 " + new Date(Number(candidate.node.stamp.mtimeMs)).toISOString();
        return Object.freeze({ id, category: candidate.category, label, bytes: candidate.bytes, fileCount: candidate.fileCount, linkCount: candidate.linkCount,
          ...(candidate.category === "archive" ? { warning: "删除后不能再从这份旧资料恢复；其中的链接仅解除入口，不读取目标。" }
            : candidate.damaged ? { warning: "这是未被引用的损坏包文件，不代表可运行的健康插件。" } : {}) });
      });
      const view: PluginMaintenancePreview = Object.freeze({ id: randomUUID(), hostRevision, expiresAt: new Date(Date.now() + 600000).toISOString(),
        items: Object.freeze(items), blockedReasons: Object.freeze([...blockedReasons]), protectedBlobCount: protectedSet.size, usageKnown });
      for (const [key, value] of this.maintenancePlans) if (Date.parse(value.view.expiresAt) <= Date.now()) this.maintenancePlans.delete(key);
      while (this.maintenancePlans.size >= 4) this.maintenancePlans.delete(this.maintenancePlans.keys().next().value!);
      this.maintenancePlans.set(view.id, { view, inspection, selected }); return view;
    });
  }
  discardMaintenance(planId: string): void { this.maintenancePlans.delete(planId); }
  /** Fixed, zero-growth deletion only: no paths or arbitrary write callback accepted. */
  deleteConfirmedMaintenance(planId: string, selectedIds: readonly string[], guard: PluginStorageGuard): Promise<PluginMaintenanceResult> {
    return this.serial(guard, async () => {
      const plan = this.maintenancePlans.get(planId); this.maintenancePlans.clear(); this.maintenanceInspections.clear();
      if (!plan || Date.parse(plan.view.expiresAt) <= Date.now()) throw new PluginMaintenanceFault("changed");
      if (!Array.isArray(selectedIds) || !selectedIds.length || selectedIds.length > 256 || new Set(selectedIds).size !== selectedIds.length
        || selectedIds.some(id => typeof id !== "string" || !plan.selected.has(id))) throw new PluginMaintenanceFault("invalid");
      const chosen = selectedIds.map(id => plan.selected.get(id)!);
      const root = await this.root(guard, false);
      if (!root || root !== plan.inspection.root) throw new PluginMaintenanceFault("changed");
      const current = await inspectMaintenanceFiles(root, guard);
      if (current.fingerprint !== plan.inspection.fingerprint || !current.folder) throw new PluginMaintenanceFault("changed");
      if (chosen.some(item => item.category === "blob")) {
        try { await this.scan(guard, false); } catch { live(guard); throw new PluginMaintenanceFault("unavailable"); }
      }
      live(guard);
      let deletedCount = 0, deletedBytes = 0, failedCount = 0, cancelled = false, usageKnown = false;
      const issues: string[] = [], removedLinks = new Map<string, number>(); let removedEntries = 0;
      const remove = async (node: MaintenanceNode): Promise<void> => {
        live(guard); assertMaintenanceAncestors(root, current.folder!, node);
        const key = node.stamp.dev + ":" + node.stamp.ino;
        assertMaintenanceNode(root, node, true, removedLinks.get(key) ?? 0);
        const path = maintenancePath(root, node);
        if (node.kind === "directory") {
          for (const child of node.children ?? []) await remove(child);
          live(guard); assertMaintenanceAncestors(root, current.folder!, node); assertMaintenanceNode(root, node, false);
          fsSync.rmdirSync(path);
        } else {
          // No await separates the final identity check from this exact unlink.
          fsSync.unlinkSync(path);
          if (node.kind === "file") { deletedBytes += Number(node.stamp.size); removedLinks.set(key, (removedLinks.get(key) ?? 0) + 1); }
        }
        if (++removedEntries % 32 === 0) await new Promise<void>(resolve => setImmediate(resolve));
      };
      for (const item of chosen) {
        try { await remove(item.node); deletedCount++; }
        catch {
          cancelled = guard.signal.aborted;
          if (!cancelled) failedCount++;
          issues.push(cancelled ? "清理已停止，已完成的删除会保留；其余确认项未继续处理。"
            : "清理途中有资料变化或删除失败；部分文件可能已删除，其余确认项已保留，请重新检查。");
          break;
        }
      }
      try { await this.scan(guard, false); usageKnown = true; } catch { /* Post-delete failure never erases completed facts. */ }
      if (!usageKnown) issues.push("总占用仍无法核对。若安装包目录损坏，请返回重建入口再次明确修复；没有放宽普通写入保护。");
      return Object.freeze({ deletedCount, deletedBytes, retainedCount: chosen.length - deletedCount, failedCount, cancelled, usageKnown, issues: Object.freeze(issues) });
    });
  }

  /** Explicit damaged-install reset only. This is NOT a general scan exception:
   * the sole repairable path is plugins-v2/blobs, all target contents remain
   * uninspected, and normal accounting must succeed before resetWrite starts. */
  withBlobsLinkRepair<T>(additionalPeakBytes: number, guard: PluginStorageGuard, resetWrite: () => Promise<T>): Promise<T> {
    return this.serial(guard, async () => {
      if (!Number.isSafeInteger(additionalPeakBytes) || additionalPeakBytes < 0 || typeof resetWrite !== "function") fail("unavailable");
      let recorded = false, detached = false;
      try {
        const root = await this.root(guard, false); if (!root) return fail("unavailable");
        const folder = join(root, "plugins-v2"), entry = join(folder, "blobs");
        const parent = await this.io(guard, () => fs.lstat(folder, { bigint: true }));
        if (!parent.isDirectory() || parent.isSymbolicLink()
          || normalized(await this.io(guard, () => fs.realpath(folder))) !== normalized(folder)) fail("unavailable");
        const stamp = await this.io(guard, () => fs.lstat(entry, { bigint: true }));
        if (!stamp.isSymbolicLink()) fail("changed");
        const target = await this.io(guard, () => fs.readlink(entry));
        if (target.length > 32768 || !sameFile(stamp, await this.io(guard, () => fs.lstat(entry, { bigint: true })))) fail("changed");
        const description = JSON.stringify({ schemaVersion: 1, kind: "untrusted-link-description", source: "plugins-v2/blobs",
          target, targetContents: "not-read", link: { dev: stamp.dev.toString(), ino: stamp.ino.toString(),
            size: stamp.size.toString(), mtimeNs: stamp.mtimeNs.toString(), ctimeNs: stamp.ctimeNs.toString() } });
        const bytes = Buffer.from(description, "utf8");
        const digest = createHash("sha256").update(bytes).digest("hex"), record = join(folder, `isolated-blobs-link-${digest}.json`);
        const checked = await this.scan(guard, false, { path: entry, stamp, target }); live(guard);
        // A previous unlink failure may already have recorded this exact entry.
        // Validate and reuse it instead of consuming space on every retry.
        let exists: BigIntStats | undefined;
        try { exists = await this.io(guard, () => fs.lstat(record, { bigint: true })); }
        catch (error) { if (!missing(error)) throw error; }
        if (exists) {
          if (!exists.isFile() || exists.isSymbolicLink() || exists.size !== BigInt(bytes.length)) fail("unavailable");
          const handle = await fs.open(record, "r");
          try {
            live(guard); const opened = await this.io(guard, () => handle.stat({ bigint: true }));
            if (!sameFile(exists, opened)) fail("changed");
            const buffer = Buffer.alloc(bytes.length + 1); let length = 0;
            while (length < buffer.length) {
              const chunk = await this.io(guard, () => handle.read(buffer, length, buffer.length - length, length));
              if (!chunk.bytesRead) break; length += chunk.bytesRead;
            }
            const after = await this.io(guard, () => handle.stat({ bigint: true }));
            if (!sameFile(opened, after) || !sameFile(after, await this.io(guard, () => fs.lstat(record, { bigint: true })))
              || length !== bytes.length || !buffer.subarray(0, length).equals(bytes)) fail("changed");
          } finally { await handle.close(); }
          recorded = true;
        }
        const peak = additionalPeakBytes + (exists ? 0 : bytes.length * 2);
        if (!Number.isSafeInteger(peak) || (peak > 0 && (checked.overLimit || peak > checked.availableBytes))) fail("limit");
        if (!exists) {
          const temp = join(folder, `.isolated-blobs-link-${digest}.${randomUUID()}.tmp`);
          let owned: BigIntStats | undefined, complete: BigIntStats | undefined;
          try {
            const handle = await fs.open(temp, "wx", 0o600);
            try {
              owned = await handle.stat({ bigint: true }); live(guard);
              await this.io(guard, () => handle.writeFile(bytes, { signal: guard.signal }));
              await this.io(guard, () => handle.sync());
              complete = await this.io(guard, () => handle.stat({ bigint: true }));
            } finally { await handle.close(); }
            await this.root(guard, false); live(guard);
            if (!sameIdentity(parent, await this.io(guard, () => fs.lstat(folder, { bigint: true })))
              || normalized(await this.io(guard, () => fs.realpath(folder))) !== normalized(folder)) fail("changed");
            const written = await this.io(guard, () => fs.lstat(temp, { bigint: true }));
            if (!owned || !complete || !written.isFile() || written.isSymbolicLink() || written.nlink !== 1n || !sameIdentity(owned, written) || !sameFile(complete, written)
              || written.size !== BigInt(bytes.length)) fail("changed");
            // Publishing the description is a fact even if cancellation follows.
            await fs.link(temp, record); recorded = true;
          } finally {
            if (owned) {
              try {
                const currentParent = await fs.lstat(folder, { bigint: true }), current = await fs.lstat(temp, { bigint: true });
                if (currentParent.isDirectory() && !currentParent.isSymbolicLink() && sameIdentity(parent, currentParent)
                  && normalized(await fs.realpath(folder)) === normalized(folder)
                  && current.isFile() && !current.isSymbolicLink() && sameIdentity(current, owned)) await fs.unlink(temp);
              } catch { /* Keep uncertain residue; normal scanning counts it. */ }
            }
          }
        }
        live(guard); await this.root(guard, false); live(guard);
        const finalParent = fsSync.lstatSync(folder, { bigint: true }), finalLink = fsSync.lstatSync(entry, { bigint: true });
        if (!finalParent.isDirectory() || finalParent.isSymbolicLink() || !sameIdentity(parent, finalParent)
          || normalized(fsSync.realpathSync(folder)) !== normalized(folder) || !finalLink.isSymbolicLink()
          || !sameFile(stamp, finalLink) || fsSync.readlinkSync(entry) !== target) fail("changed");
        live(guard);
        // Remove this exact link entry only, never recurse or visit its target.
        // The final identity check and unlink have no intervening await, but this
        // is still a single-host guarantee, not an OS compare-and-swap primitive.
        fsSync.unlinkSync(entry); detached = true;
        const normal = await this.scan(guard, false); live(guard);
        if (additionalPeakBytes > 0 && (normal.overLimit || additionalPeakBytes > normal.availableBytes)) fail("limit");
        // No post-success guard: do not overwrite the reset callback's commit fact.
        return await resetWrite();
      } catch (error) {
        const reason = error instanceof PluginStorageBudgetFault ? error.reason : guard.signal.aborted ? "cancelled" : "unavailable";
        if (recorded) throw new PluginStorageRepairFault(reason, detached ? "detached" : "recorded");
        if (error instanceof PluginStorageBudgetFault) throw error;
        return fail(reason);
      }
    });
  }
}

export function getPluginStorageCoordinator(profile: string): PluginStorageCoordinator {
  if (typeof profile !== "string" || !profile.trim() || profile.includes("\0")) fail("unavailable");
  const key = normalized(profile);
  let coordinator = defaults.get(key);
  if (!coordinator) { coordinator = new PluginStorageCoordinator(profile); defaults.set(key, coordinator); }
  return coordinator;
}
