import { createHash, randomUUID } from "node:crypto";
import fsSync, { promises as fs, type Stats } from "node:fs";
import { join, resolve } from "node:path";
import { EXECUTABLE_PLUGIN_LIMITS, parseExecutablePluginPackage } from "../../shared/executable-plugins.js";
import type { PluginWorkshopDraft, PluginWorkshopDraftList, PluginWorkshopModel } from "../../shared/plugin-workshop.js";
import { PLUGIN_AUTHORING_BRIEF_MAX } from "../../shared/plugin-authoring-guide.js";
import type { PluginWorkshopDeletePreview, PluginWorkshopDeleteResult } from "../../shared/plugin-workshop-deletion.js";
import { getPluginStorageCoordinator, PluginStorageBudgetFault, type PluginStorageCoordinator, type PluginStorageGuard } from "./plugin-storage-coordinator.js";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const LIMIT = 3 * 1024 * 1024, MAX_DRAFTS = 16, MAX_ENTRIES = 64;
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const iso = (value: unknown): value is string => typeof value === "string" && value.length === 24 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.nlink === b.nlink && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const samePath = (a: string, b: string) => process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
const MESSAGES = { invalid: "制作草稿格式不正确。", changed: "草稿已变化，请重新打开后再保存。", damaged: "制作草稿无法完整读取，原文件仍保留。", limit: "制作草稿达到存储限制，请先整理已有资料。", cancelled: "制作草稿操作已取消。", unavailable: "制作草稿操作未完成，请重新打开后核对。" } as const;
export class PluginWorkshopFault extends Error {
  constructor(readonly reason: keyof typeof MESSAGES) { super(MESSAGES[reason]); this.name = "PluginWorkshopFault"; }
}
function live(guard: PluginStorageGuard) { if (guard.signal.aborted) throw new PluginWorkshopFault("cancelled"); guard.assertCurrent(); }
function validId(id: string) { if (typeof id !== "string" || !UUID.test(id)) throw new PluginWorkshopFault("invalid"); }
function modelOf(model: PluginWorkshopModel): PluginWorkshopModel {
  if (!model || typeof model !== "object" || Array.isArray(model) || Object.keys(model).some(key => !["providerId", "modelId", "providerRevision", "reasoningEffort"].includes(key))
    || [model.providerId, model.modelId].some(value => typeof value !== "string" || !value.trim() || value.length > 256 || /[\x00-\x1f]/.test(value))
    || !Number.isSafeInteger(model.providerRevision) || model.providerRevision < 1
    || model.reasoningEffort !== undefined && (typeof model.reasoningEffort !== "string" || !model.reasoningEffort || model.reasoningEffort.length > 64)) throw new PluginWorkshopFault("invalid");
  return { providerId: model.providerId, modelId: model.modelId, providerRevision: model.providerRevision, ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}) };
}
type Stored = Omit<PluginWorkshopDraft, "package"> & { schemaVersion: 1 };
interface Captured { record: Stored; text: string; stamp: Stats; folder: string; folderStamp: Stats }
interface DeleteFile { name: string; stamp: Stats; digest: string }
interface DeleteSnapshot { root: string; folder: string; rootStamp: Stats; folderStamp: Stats; files: DeleteFile[]; fingerprint: string }
function encode(id: string, revision: number, createdAt: string, brief: string, packageJson: string, model: PluginWorkshopModel): Stored {
  validId(id);
  if (!Number.isSafeInteger(revision) || revision < 1 || revision >= Number.MAX_SAFE_INTEGER || typeof brief !== "string" || !brief.trim() || brief.length > PLUGIN_AUTHORING_BRIEF_MAX
    || typeof packageJson !== "string" || Buffer.byteLength(packageJson, "utf8") > EXECUTABLE_PLUGIN_LIMITS.jsonBytes) throw new PluginWorkshopFault("invalid");
  const pkg = parseExecutablePluginPackage(packageJson), canonical = JSON.stringify(pkg);
  return { schemaVersion: 1, id, revision, createdAt, updatedAt: new Date().toISOString(), brief, model: modelOf(model), packageJson: canonical, contentHash: sha(canonical) };
}
function view(record: Stored): PluginWorkshopDraft { const { schemaVersion: _, ...data } = record; return { ...data, package: parseExecutablePluginPackage(record.packageJson) }; }

/** Independent, non-installed candidate directories. All growth uses the same
 * profile budget as installed plugins. No model call, Guest code or install runs here. */
export class PluginWorkshopStore {
  private tail: Promise<unknown> = Promise.resolve();
  private physical?: string;
  private profileStamp?: Stats;
  private readonly budget: PluginStorageCoordinator;
  private readonly deletions = new Map<string, { view: PluginWorkshopDeletePreview; snapshot?: DeleteSnapshot }>();
  private readonly deleting = new Set<string>();
  constructor(private readonly profile: string, budget?: PluginStorageCoordinator) { this.budget = budget ?? getPluginStorageCoordinator(profile); }
  private serial<T>(guard: PluginStorageGuard, work: () => Promise<T>): Promise<T> {
    const pending = this.tail.then(() => { live(guard); return work(); }).catch(error => {
      if (error instanceof PluginWorkshopFault) throw error;
      if (error instanceof PluginStorageBudgetFault) throw new PluginWorkshopFault(error.reason === "limit" ? "limit" : error.reason === "cancelled" ? "cancelled" : "unavailable");
      if (guard.signal.aborted) throw new PluginWorkshopFault("cancelled");
      throw new PluginWorkshopFault("unavailable");
    });
    this.tail = pending.then(() => undefined, () => undefined); return pending;
  }
  private async directory(guard: PluginStorageGuard, create = false): Promise<string | undefined> {
    let profile: Stats;
    try { profile = await fs.lstat(this.profile); } catch (error) { if (!create && !this.profileStamp && missing(error)) return undefined; throw error; }
    live(guard);
    if (!profile.isDirectory() || profile.isSymbolicLink() || this.profileStamp && (profile.dev !== this.profileStamp.dev || profile.ino !== this.profileStamp.ino)) throw new PluginWorkshopFault("changed");
    const physical = await fs.realpath(this.profile); live(guard);
    if (this.physical && !samePath(physical, this.physical)) throw new PluginWorkshopFault("changed");
    this.physical ??= physical; this.profileStamp ??= profile;
    const folder = join(physical, "plugin-workshop-v1");
    if (create) { await fs.mkdir(folder, { recursive: true }); live(guard); }
    let stat: Stats; try { stat = await fs.lstat(folder); } catch (error) { if (!create && missing(error)) return undefined; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await fs.realpath(folder), folder)) throw new PluginWorkshopFault("damaged");
    live(guard); return folder;
  }
  private async read(id: string, guard: PluginStorageGuard): Promise<Captured> {
    validId(id); const root = await this.directory(guard); if (!root) throw new PluginWorkshopFault("changed");
    const folder = join(root, id), dir = await fs.lstat(folder); live(guard);
    if (!dir.isDirectory() || dir.isSymbolicLink() || !samePath(await fs.realpath(folder), folder)) throw new PluginWorkshopFault("damaged");
    const file = join(folder, "draft.json"), before = await fs.lstat(file); live(guard);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink < 1 || before.size > LIMIT) throw new PluginWorkshopFault("damaged");
    await this.assertDraftLinks(folder, before, guard);
    const handle = await fs.open(file, "r"), bytes = Buffer.alloc(LIMIT + 1); let length = 0, stamp: Stats;
    try {
      if (!same(before, await handle.stat())) throw new PluginWorkshopFault("changed");
      while (length < bytes.length) { const chunk = await handle.read(bytes, length, bytes.length - length, length); live(guard); if (!chunk.bytesRead) break; length += chunk.bytesRead; }
      stamp = await handle.stat(); live(guard);
      if (length > LIMIT || !same(before, stamp) || !same(stamp, await fs.lstat(file)) || await this.directory(guard) !== root
        || !same(dir, await fs.lstat(folder)) || !samePath(await fs.realpath(folder), folder)) throw new PluginWorkshopFault("changed");
    } finally { await handle.close().catch(() => {}); }
    let raw: Stored, text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
      raw = JSON.parse(text);
      if (!raw || raw.schemaVersion !== 1 || Object.keys(raw).length !== 9 || raw.id !== id || !iso(raw.createdAt) || !iso(raw.updatedAt)) throw new Error();
      const checked = encode(id, raw.revision, raw.createdAt, raw.brief, raw.packageJson, raw.model);
      if (checked.contentHash !== raw.contentHash || checked.packageJson !== raw.packageJson || JSON.stringify({ ...checked, updatedAt: raw.updatedAt }) !== text) throw new Error();
    } catch { throw new PluginWorkshopFault("damaged"); }
    return { record: raw, text, stamp, folder, folderStamp: dir };
  }
  private async assertDraftLinks(folder: string, stamp: Stats, guard: PluginStorageGuard): Promise<void> {
    if (stamp.nlink === 1) return;
    if (stamp.nlink > MAX_ENTRIES) throw new PluginWorkshopFault("damaged");
    const names = await fs.readdir(folder); live(guard); if (names.length > MAX_ENTRIES) throw new PluginWorkshopFault("damaged");
    let links = 0;
    for (const name of names) {
      const info = await fs.lstat(join(folder, name)); live(guard);
      if (info.dev !== stamp.dev || info.ino !== stamp.ino) continue;
      if ((name !== "draft.json" && !(name.startsWith(".draft-") && name.endsWith(".tmp") && UUID.test(name.slice(7, -4))))
        || !info.isFile() || info.isSymbolicLink() || !same(stamp, info)) throw new PluginWorkshopFault("damaged");
      links++;
    }
    // A failed cleanup can leave the immutable publication's second name. It is
    // safe only when every hard-link name is an exact host temporary in this draft.
    if (links !== stamp.nlink) throw new PluginWorkshopFault("damaged");
  }
  list(guard: PluginStorageGuard): Promise<PluginWorkshopDraftList> {
    return this.serial(guard, async () => {
      const folder = await this.directory(guard); if (!folder) return { items: [], unreadable: 0 };
      const names = await fs.readdir(folder); live(guard); if (names.length > MAX_ENTRIES) throw new PluginWorkshopFault("limit");
      const items: PluginWorkshopDraftList["items"][number][] = [], damagedIds: string[] = []; let unreadable = 0;
      for (const name of names) {
        if (!UUID.test(name)) { unreadable++; continue; }
        try { const { record } = await this.read(name, guard), pkg = parseExecutablePluginPackage(record.packageJson);
          items.push({ id: name, revision: record.revision, name: pkg.manifest.name, version: pkg.manifest.version, updatedAt: record.updatedAt, contentHash: record.contentHash });
        } catch { live(guard); unreadable++; damagedIds.push(name); }
      }
      return { items: items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), unreadable, ...(damagedIds.length ? { damagedIds } : {}) };
    });
  }
  get(id: string, guard: PluginStorageGuard): Promise<PluginWorkshopDraft> { return this.serial(guard, async () => view((await this.read(id, guard)).record)); }
  private async deletionSnapshot(id: string, guard: PluginStorageGuard): Promise<DeleteSnapshot> {
    validId(id); const root = await this.directory(guard); if (!root) throw new PluginWorkshopFault("changed");
    const rootStamp = await fs.lstat(root), folder = join(root, id), folderStamp = await fs.lstat(folder); live(guard);
    if (!folderStamp.isDirectory() || folderStamp.isSymbolicLink() || !samePath(await fs.realpath(folder), folder)) throw new PluginWorkshopFault("damaged");
    const names = (await fs.readdir(folder)).sort(); live(guard);
    if (names.length > MAX_ENTRIES || names.some(name => name !== "draft.json" && !(name.startsWith(".draft-") && name.endsWith(".tmp") && UUID.test(name.slice(7, -4))))) throw new PluginWorkshopFault("damaged");
    const stamps: { name: string; stamp: Stats }[] = [];
    for (const name of names) {
      const stamp = await fs.lstat(join(folder, name)); live(guard);
      if (!stamp.isFile() || stamp.isSymbolicLink() || stamp.nlink < 1 || stamp.size > LIMIT) throw new PluginWorkshopFault("damaged");
      stamps.push({ name, stamp });
    }
    for (const { stamp } of stamps) {
      const group = stamps.filter(item => item.stamp.dev === stamp.dev && item.stamp.ino === stamp.ino);
      if (group.length !== stamp.nlink || group.some(item => !same(item.stamp, stamp))) throw new PluginWorkshopFault("damaged");
    }
    const files: DeleteFile[] = [];
    for (const { name, stamp } of stamps) {
      const path = join(folder, name), handle = await fs.open(path, "r"), digest = createHash("sha256"); let length = 0;
      try {
        if (!same(stamp, await handle.stat())) throw new PluginWorkshopFault("changed");
        const buffer = Buffer.alloc(65536);
        for (;;) { const part = await handle.read(buffer, 0, buffer.length, length); live(guard); if (!part.bytesRead) break;
          length += part.bytesRead; if (length > stamp.size || length > LIMIT) throw new PluginWorkshopFault("changed"); digest.update(buffer.subarray(0, part.bytesRead)); }
        if (length !== stamp.size || !same(stamp, await handle.stat()) || !same(stamp, await fs.lstat(path))) throw new PluginWorkshopFault("changed");
      } finally { await handle.close().catch(() => {}); }
      files.push({ name, stamp, digest: digest.digest("hex") });
    }
    if (await this.directory(guard) !== root || !same(folderStamp, await fs.lstat(folder)) || !samePath(await fs.realpath(folder), folder)) throw new PluginWorkshopFault("changed");
    const key = (stat: Stats) => [stat.dev, stat.ino, stat.size, stat.nlink, stat.mtimeMs, stat.ctimeMs];
    return { root, folder, rootStamp, folderStamp, files, fingerprint: sha(JSON.stringify({ root: [rootStamp.dev, rootStamp.ino], folder: key(folderStamp), files: files.map(file => [file.name, key(file.stamp), file.digest]) })) };
  }
  prepareDelete(id: string, guard: PluginStorageGuard): Promise<PluginWorkshopDeletePreview> {
    return this.serial(guard, async () => {
      validId(id); let name: string | undefined, damaged = true, snapshot: DeleteSnapshot | undefined;
      try { const current = await this.read(id, guard); name = parseExecutablePluginPackage(current.record.packageJson).manifest.name; damaged = false; } catch { live(guard); }
      try { snapshot = await this.deletionSnapshot(id, guard); } catch { live(guard); }
      const view: PluginWorkshopDeletePreview = { id: randomUUID(), draftId: id, ...(name ? { name } : {}), damaged,
        bytes: snapshot ? snapshot.files.reduce((sum, file) => sum + file.stamp.size, 0) : null, fileCount: snapshot?.files.length ?? null,
        expiresAt: new Date(Date.now() + 600000).toISOString(), canConfirm: !!snapshot,
        ...(!snapshot ? { warning: "无法完整核验这份草稿的范围，原文件保留，暂不能删除。" } : {}) };
      for (const [key, value] of this.deletions) if (Date.parse(value.view.expiresAt) <= Date.now()) this.deletions.delete(key);
      while (this.deletions.size >= 4) this.deletions.delete(this.deletions.keys().next().value!);
      this.deletions.set(view.id, { view, snapshot }); return view;
    });
  }
  discardDelete(previewId: string): void { this.deletions.delete(previewId); }
  confirmDelete(previewId: string, guard: PluginStorageGuard): Promise<PluginWorkshopDeleteResult> {
    return this.serial(guard, async () => {
      const plan = this.deletions.get(previewId);
      if (!plan || !plan.view.canConfirm || !plan.snapshot || this.deleting.has(previewId) || Date.parse(plan.view.expiresAt) <= Date.now()) throw new PluginWorkshopFault("changed");
      this.deleting.add(previewId);
      const checked: PluginStorageGuard = { signal: guard.signal, assertCurrent: () => {
        live(guard); if (this.deletions.get(previewId) !== plan || Date.parse(plan.view.expiresAt) <= Date.now()) throw new PluginWorkshopFault("changed");
      } };
      return this.budget.withWrite(0, checked, async () => {
        const current = await this.deletionSnapshot(plan.view.draftId, checked);
        if (current.fingerprint !== plan.snapshot!.fingerprint) throw new PluginWorkshopFault("changed");
        let deletedFiles = 0, deletedBytes = 0, deleted = false;
        const removedLinks = new Map<string, number>();
        const ancestors = () => {
          live(checked); const root = fsSync.lstatSync(current.root), folder = fsSync.lstatSync(current.folder);
          if (!root.isDirectory() || root.isSymbolicLink() || root.dev !== current.rootStamp.dev || root.ino !== current.rootStamp.ino || !samePath(fsSync.realpathSync(current.root), current.root)
            || !folder.isDirectory() || folder.isSymbolicLink() || folder.dev !== current.folderStamp.dev || folder.ino !== current.folderStamp.ino || !samePath(fsSync.realpathSync(current.folder), current.folder)) throw new PluginWorkshopFault("changed");
        };
        try {
          for (const file of current.files) {
            ancestors(); const path = join(current.folder, file.name), now = fsSync.lstatSync(path), key = file.stamp.dev + ":" + file.stamp.ino, removed = removedLinks.get(key) ?? 0;
            if (!now.isFile() || now.isSymbolicLink() || (!removed ? !same(now, file.stamp)
              : now.dev !== file.stamp.dev || now.ino !== file.stamp.ino || now.size !== file.stamp.size || now.mtimeMs !== file.stamp.mtimeMs || now.nlink !== file.stamp.nlink - removed)) throw new PluginWorkshopFault("changed");
            fsSync.unlinkSync(path); deletedFiles++; deletedBytes += file.stamp.size; removedLinks.set(key, removed + 1);
            if (deletedFiles % 16 === 0) await new Promise<void>(done => setImmediate(done));
          }
          ancestors(); fsSync.rmdirSync(current.folder); deleted = true;
        } catch { /* Preserve partial deletion facts; never retry an old token. */ }
        return { draftId: plan.view.draftId, deleted, deletedFiles, deletedBytes, remainingFiles: current.files.length - deletedFiles, cancelled: guard.signal.aborted,
          message: deleted ? "草稿已删除，已安装的插件不受影响。" : "草稿未全部删除，已完成的部分会保留；请重新检查后再决定。" };
      });
    }).finally(() => { this.deletions.delete(previewId); this.deleting.delete(previewId); });
  }
  save(input: { id?: string; expectedRevision?: number; brief: string; packageJson: string; model: PluginWorkshopModel }, guard: PluginStorageGuard): Promise<PluginWorkshopDraft> {
    return this.serial(guard, async () => {
      const previous = input.id ? await this.read(input.id, guard) : undefined;
      if (previous ? input.expectedRevision !== previous.record.revision : input.expectedRevision !== undefined) throw new PluginWorkshopFault("changed");
      const id = input.id ?? randomUUID(), now = new Date().toISOString();
      const record = encode(id, previous ? previous.record.revision + 1 : 1, previous?.record.createdAt ?? now, input.brief, input.packageJson, input.model);
      const text = JSON.stringify(record), size = Buffer.byteLength(text, "utf8"); if (size > LIMIT) throw new PluginWorkshopFault("limit");
      return this.budget.withWrite(size * (previous ? 1 : 2), guard, async () => {
        const root = await this.directory(guard, true); if (!root) throw new PluginWorkshopFault("unavailable");
        const names = await fs.readdir(root); live(guard);
        if (!previous && names.length >= MAX_DRAFTS) throw new PluginWorkshopFault("limit");
        const folder = join(root, id);
        let created: Stats | undefined, committed = false;
        try {
        if (!previous) { await fs.mkdir(folder); created = await fs.lstat(folder); live(guard); }
        const dir = await fs.lstat(folder); live(guard);
        if (!dir.isDirectory() || dir.isSymbolicLink() || !samePath(await fs.realpath(folder), folder)
          || previous && (dir.dev !== previous.folderStamp.dev || dir.ino !== previous.folderStamp.ino)) throw new PluginWorkshopFault("changed");
        const target = join(folder, "draft.json"), temporary = join(folder, `.draft-${randomUUID()}.tmp`);
        let owned: Stats | undefined;
        try {
          const handle = await fs.open(temporary, "wx", 0o600);
          try { owned = await handle.stat(); live(guard); await handle.writeFile(text, { encoding: "utf8", signal: guard.signal }); live(guard); await handle.sync(); live(guard); }
          finally { await handle.close().catch(() => {}); }
          const finalDir = await fs.lstat(folder);
          if (await this.directory(guard) !== root || !samePath(await fs.realpath(folder), folder) || !finalDir.isDirectory() || finalDir.isSymbolicLink()
            || finalDir.dev !== dir.dev || finalDir.ino !== dir.ino) throw new PluginWorkshopFault("changed");
          if (previous) {
            const current = await this.read(id, guard);
            if (!same(current.stamp, previous.stamp) || current.text !== previous.text) throw new PluginWorkshopFault("changed");
            live(guard); await fs.rename(temporary, target);
          } else { live(guard); await fs.link(temporary, target); }
          committed = true;
          return view(record);
        } finally {
          if (owned) try {
            const parent = await fs.lstat(folder), current = await fs.lstat(temporary);
            if (parent.isDirectory() && !parent.isSymbolicLink() && samePath(await fs.realpath(folder), folder)
              && current.isFile() && !current.isSymbolicLink() && current.dev === owned.dev && current.ino === owned.ino) await fs.unlink(temporary);
          } catch { /* Keep uncertain residues; shared budget counts them. */ }
        }
        } finally {
          if (created && !committed) try {
            const current = await fs.lstat(folder);
            if (current.isDirectory() && !current.isSymbolicLink() && current.dev === created.dev && current.ino === created.ino
              && samePath(await fs.realpath(folder), folder)) await fs.rmdir(folder);
          } catch { /* rmdir removes only our still-empty directory; residue is preserved. */ }
        }
      });
    });
  }
}
