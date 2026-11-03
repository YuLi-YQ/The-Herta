import { createHash, randomUUID } from "node:crypto";
import fsSync, { promises as fs, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { countDiffLines, isPathInside, withPermissionMode } from "@herta/core";
import { computeUnifiedDiff, resolveSafePath } from "@herta/tools";
import type { PluginOutputOwner, PluginOutputProducer, PluginPatchContent, PluginPatchProposal, PluginPatchStatus } from "../../shared/plugin-deliverables.js";
import { parsePluginJson } from "../../shared/plugin-runtime.js";
import { PluginBrokerFault } from "./capability-broker.js";
import { getPluginStorageCoordinator, PluginStorageBudgetFault, type PluginStorageCoordinator } from "./plugin-storage-coordinator.js";

export interface PluginPatchGuard { readonly signal: AbortSignal; assertCurrent(): void }
export const PLUGIN_PATCH_LIMITS = Object.freeze({ originalBytes: 128 * 1024, recordBytes: 1024 * 1024, ownerBytes: 16 * 1024 * 1024, proposals: 50, totalBytes: 100 * 1024 * 1024, totalFiles: 5000 });
type Reason = "damaged" | "unavailable" | "limit" | "conflict" | "busy" | "invalid-input";
export class PluginPatchFault extends PluginBrokerFault {
  constructor(readonly reason: Reason) {
    super(reason === "limit" ? "resource-limit" : reason === "busy" ? "busy" : reason === "invalid-input" || reason === "conflict" ? "invalid-input" : "host-error");
    this.name = "PluginPatchFault";
  }
}
interface Identity { dev: number; ino: number }
interface RootIdentity { dev: string; ino: string }
interface PatchRecord { schemaVersion: 1; owner: PluginOutputOwner; physicalRoot: string; rootIdentity: RootIdentity; content: PluginPatchContent; integrity: string }
interface Snapshot { path: string; bytes: Buffer | null; stamp?: Stats }
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const STATES: readonly PluginPatchStatus[] = ["pending", "applying", "applied", "denied", "cancelled", "conflict", "failed", "needs-review"];
const RETRY: readonly PluginPatchStatus[] = ["pending", "denied", "cancelled", "failed"];
const detached: PluginPatchGuard = { signal: new AbortController().signal, assertCurrent() {} };
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const missing = (e: unknown) => (e as NodeJS.ErrnoException)?.code === "ENOENT";
const samePath = (a: string, b: string) => process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
const sameInode = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;
const sameFile = (a: Stats, b: Stats) => sameInode(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
function live(g: PluginPatchGuard): void { if (g.signal.aborted) throw new PluginBrokerFault("cancelled"); g.assertCurrent(); }
function fail(reason: Reason): never { throw new PluginPatchFault(reason); }
function text(value: unknown, maximum: number, empty = true): asserts value is string {
  if (typeof value !== "string" || value.length > maximum || (!empty && !value.trim()) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) fail("invalid-input");
}
function validPath(path: unknown): asserts path is string {
  text(path, 1024, false);
  const parts = path.split("/");
  if (parts.some(p => !p || p === "." || p === ".." || /[\u0000-\u001f\u007f<>:"|?*\\]/u.test(p) || /[. ]$/u.test(p) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(p))) fail("invalid-input");
}
function ownerKey(owner: PluginOutputOwner): string {
  if (!owner || owner.scope !== "workbench") fail("invalid-input");
  text(owner.target, 512, false);
  return hash(JSON.stringify({ scope: owner.scope, target: owner.target }));
}
function producerCopy(p: PluginOutputProducer): PluginOutputProducer {
  if (!p || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(p.id) || p.id.length > 80 || !HASH.test(p.contentHash)
    || !Number.isSafeInteger(p.grantRevision) || p.grantRevision < 0) fail("invalid-input");
  text(p.name, 80, false); text(p.version, 64, false);
  return { id: p.id, name: p.name, version: p.version, contentHash: p.contentHash, grantRevision: p.grantRevision };
}
function output(record: PatchRecord): PluginPatchContent {
  return parsePluginJson(JSON.stringify(record.content), PLUGIN_PATCH_LIMITS.recordBytes) as unknown as PluginPatchContent;
}
function immutable(record: Omit<PatchRecord, "integrity"> | PatchRecord): string {
  const p = record.content.proposal;
  return hash(JSON.stringify({ owner: record.owner, physicalRoot: record.physicalRoot, rootIdentity: record.rootIdentity,
    id: p.id, path: p.path, baseHash: p.baseHash, nextHash: p.nextHash, createdAt: p.createdAt,
    producer: p.producer, runId: p.runId, additions: p.additions, deletions: p.deletions,
    before: record.content.before, after: record.content.after, diff: record.content.diff }));
}
function decode(bytes: Buffer): string {
  if (bytes.includes(0)) fail("invalid-input");
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return fail("invalid-input"); }
}
async function boundedRead(path: string, max: number, g: PluginPatchGuard): Promise<{ bytes: Buffer; stamp: Stats }> {
  const before = await fs.lstat(path); live(g);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > max) fail("damaged");
  const handle = await fs.open(path, "r");
  try {
    live(g); const opened = await handle.stat(); live(g);
    if (!sameFile(before, opened)) fail("conflict");
    const buffer = Buffer.alloc(max + 1); let length = 0;
    while (length < buffer.length) { const part = await handle.read(buffer, length, buffer.length - length, length); live(g); if (!part.bytesRead) break; length += part.bytesRead; }
    if (length > max) fail("limit");
    const after = await handle.stat(); const named = await fs.lstat(path); live(g);
    if (!sameFile(opened, after) || !sameFile(after, named) || named.isSymbolicLink() || named.nlink !== 1) fail("conflict");
    return { bytes: buffer.subarray(0, length), stamp: named };
  } finally { await handle.close().catch(() => undefined); }
}

/** Persistent proposals are independent of model rounds. No record is automatically replayed. */
export class PluginPatchService {
  private profilePhysical?: string;
  private profileIdentity?: RootIdentity;
  private saving: Promise<unknown> = Promise.resolve();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly applying = new Set<string>();
  private readonly activeWrites = new Set<string>();
  private readonly paths = new Set<string>();
  private readonly receipts = new Map<string, PatchRecord>();
  private readonly storage: PluginStorageCoordinator;
  constructor(private readonly options: { profile: string; protectedPaths: readonly string[]; storage?: PluginStorageCoordinator }) {
    this.storage = options.storage ?? getPluginStorageCoordinator(options.profile);
    this.options = { profile: resolve(options.profile), protectedPaths: Object.freeze([...options.protectedPaths]) };
  }

  private serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(key) ?? Promise.resolve()).then(operation);
    this.queues.set(key, next.then(() => undefined, () => undefined));
    return next;
  }
  private async directory(key: string, create: boolean, g: PluginPatchGuard): Promise<string | null> {
    live(g); const physical = await fs.realpath(this.options.profile); live(g);
    const profileInfo = await fs.lstat(physical, { bigint: true }); live(g);
    if (this.profilePhysical && !samePath(physical, this.profilePhysical)) fail("unavailable");
    if (!profileInfo.isDirectory() || profileInfo.isSymbolicLink() || this.profileIdentity && (profileInfo.dev.toString() !== this.profileIdentity.dev || profileInfo.ino.toString() !== this.profileIdentity.ino)) fail("unavailable");
    this.profilePhysical ??= physical;
    this.profileIdentity ??= { dev: profileInfo.dev.toString(), ino: profileInfo.ino.toString() };
    let path = physical;
    for (const segment of ["plugin-patches-v2", key]) {
      path = join(path, segment);
      if (create) { await fs.mkdir(path).catch(e => { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }); live(g); }
      let info: Stats;
      try { info = await fs.lstat(path); } catch (e) { if (!create && missing(e)) return null; throw e; }
      live(g); const actual = await fs.realpath(path); live(g);
      if (!info.isDirectory() || info.isSymbolicLink() || !samePath(path, actual) || !isPathInside(physical, actual, { strict: true })) fail("unavailable");
    }
    return path;
  }
  private async entries(folder: string, g: PluginPatchGuard): Promise<{ names: string[]; bytes: number; count: number }> {
    const names = await this.names(folder, 300, g);
    let bytes = 0, count = 0;
    for (const name of names) {
      const info = await fs.lstat(join(folder, name)); live(g);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail("damaged");
      bytes += info.size;
      if (name.endsWith(".json")) count++;
    }
    return { names, bytes, count };
  }
  private async names(folder: string, limit: number, g: PluginPatchGuard): Promise<string[]> {
    const dir = await fs.opendir(folder), names: string[] = [];
    try { for (;;) { live(g); const entry = await dir.read(); live(g); if (!entry) break; if (names.length >= limit) fail("limit"); names.push(entry.name); } }
    finally { await dir.close().catch(() => undefined); }
    return names;
  }
  private async totalQuota(root: string, g: PluginPatchGuard): Promise<{ bytes: number; files: number }> {
    let bytes = 0, files = 0, scanned = 0;
    const inspect = async (path: string) => {
      const entry = await fs.lstat(path); live(g);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) fail("damaged");
      files++; bytes += entry.size;
      if (++scanned > 12000 || files > PLUGIN_PATCH_LIMITS.totalFiles || bytes > PLUGIN_PATCH_LIMITS.totalBytes) fail("limit");
    };
    for (const name of await this.names(root, 6000, g)) {
      const path = join(root, name), entry = await fs.lstat(path); live(g);
      if (++scanned > 12000) fail("limit");
      if (entry.isFile() && !entry.isSymbolicLink()) { await inspect(path); continue; }
      if (!HASH.test(name) || !entry.isDirectory() || entry.isSymbolicLink() || !samePath(await fs.realpath(path), path)) fail("damaged");
      live(g); for (const file of await this.names(path, 6000, g)) await inspect(join(path, file));
    }
    return { bytes, files };
  }
  private parse(json: string, owner: PluginOutputOwner, id: string): PatchRecord {
    try {
      const r = parsePluginJson(json, PLUGIN_PATCH_LIMITS.recordBytes) as unknown as PatchRecord;
      if (!r || Object.keys(r).sort().join() !== "content,integrity,owner,physicalRoot,rootIdentity,schemaVersion" || r.schemaVersion !== 1
        || Object.keys(r.owner).sort().join() !== "scope,target" || ownerKey(r.owner) !== ownerKey(owner) || typeof r.physicalRoot !== "string" || !isAbsolute(r.physicalRoot) || r.physicalRoot.includes("\0")
        || !samePath(r.physicalRoot, resolve(r.physicalRoot)) || Object.keys(r.content).sort().join() !== "after,before,diff,proposal") fail("damaged");
      if (!r.rootIdentity || Object.keys(r.rootIdentity).sort().join() !== "dev,ino" || typeof r.rootIdentity.dev !== "string" || typeof r.rootIdentity.ino !== "string"
        || !/^(0|[1-9][0-9]{0,24})$/.test(r.rootIdentity.dev) || !/^(0|[1-9][0-9]{0,24})$/.test(r.rootIdentity.ino)) fail("damaged");
      const p = r.content.proposal;
      if (!p || Object.keys(p).some(k => !["id", "path", "baseHash", "nextHash", "createdAt", "producer", "runId", "status", "additions", "deletions", "appliedAt", "message"].includes(k))
        || p.id !== id || !UUID.test(p.id) || !STATES.includes(p.status) || (p.baseHash !== null && !HASH.test(p.baseHash)) || !HASH.test(p.nextHash)
        || !Number.isFinite(Date.parse(p.createdAt)) || (p.appliedAt !== undefined && !Number.isFinite(Date.parse(p.appliedAt))) || (p.status === "applied" && p.appliedAt === undefined)) fail("damaged");
      validPath(p.path); producerCopy(p.producer); text(p.runId, 100, false);
      if (p.message !== undefined) text(p.message, 300);
      if (Object.keys(p.producer).sort().join() !== "contentHash,grantRevision,id,name,version") fail("damaged");
      text(r.content.after, PLUGIN_PATCH_LIMITS.recordBytes); text(r.content.diff, PLUGIN_PATCH_LIMITS.recordBytes);
      if (r.content.before !== null) text(r.content.before, PLUGIN_PATCH_LIMITS.originalBytes);
      if (r.content.after.includes("\0") || r.content.before?.includes("\0")) fail("damaged");
      const before = r.content.before === null ? null : Buffer.from(r.content.before, "utf8");
      if (before && before.length > PLUGIN_PATCH_LIMITS.originalBytes) fail("damaged");
      if ((before === null ? null : hash(before)) !== p.baseHash || hash(Buffer.from(r.content.after, "utf8")) !== p.nextHash
        || r.content.diff !== computeUnifiedDiff(r.content.before ?? "", r.content.after, p.path)) fail("damaged");
      const counts = countDiffLines(r.content.diff);
      if (p.additions !== counts.add || p.deletions !== counts.del || r.integrity !== immutable(r)) fail("damaged");
      return JSON.parse(JSON.stringify(r)) as PatchRecord;
    } catch (error) { if (error instanceof PluginPatchFault && error.reason === "damaged") throw error; return fail("damaged"); }
  }
  private async load(owner: PluginOutputOwner, id: string, g: PluginPatchGuard): Promise<PatchRecord> {
    const key = ownerKey(owner); if (!UUID.test(id)) fail("invalid-input");
    const saved = this.receipts.get(`${key}:${id}`); if (saved) { live(g); return structuredClone(saved); }
    const folder = await this.directory(key, false, g); if (!folder) fail("unavailable");
    const data = await boundedRead(join(folder, `${id}.json`), PLUGIN_PATCH_LIMITS.recordBytes, g);
    const record = this.parse(new TextDecoder("utf-8", { fatal: true }).decode(data.bytes), owner, id);
    if (await this.directory(key, false, g) !== folder) fail("unavailable");
    if (record.content.proposal.status === "applying" && !this.activeWrites.has(`${key}:${id}`)) {
      record.content = { ...record.content, proposal: { ...record.content.proposal, status: "needs-review", message: "上次应用未完成记录，请核对文件；不会自动重放。" } };
    }
    return record;
  }
  private serializeSaving<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.saving.then(work);
    this.saving = pending.then(() => undefined, () => undefined); return pending;
  }
  private async withBudget<T>(additionalPeakBytes: number, g: PluginPatchGuard, work: () => Promise<T>): Promise<T> {
    try { return await this.storage.withWrite(additionalPeakBytes, g, work); }
    catch (error) {
      if (!(error instanceof PluginStorageBudgetFault)) throw error;
      if (error.reason === "cancelled") throw new PluginBrokerFault("cancelled");
      live(g); return fail(error.reason === "limit" ? "limit" : "unavailable");
    }
  }
  private save(record: PatchRecord, g: PluginPatchGuard, fresh = false): Promise<void> {
    const bytes = Buffer.byteLength(JSON.stringify(record), "utf8");
    return this.serializeSaving(() => this.withBudget(bytes * (fresh ? 2 : 1), g, () => this.saveLocked(record, g, fresh)));
  }
  private async saveLocked(record: PatchRecord, g: PluginPatchGuard, fresh: boolean, reserveRecordBytes = 0): Promise<void> {
    const key = ownerKey(record.owner), folder = await this.directory(key, true, g); if (!folder) fail("unavailable");
    const encoded = JSON.stringify(record); if (Buffer.byteLength(encoded, "utf8") > PLUGIN_PATCH_LIMITS.recordBytes) fail("limit");
    this.parse(encoded, record.owner, record.content.proposal.id);
    const file = join(folder, `${record.content.proposal.id}.json`), quota = await this.entries(folder, g);
    const total = await this.totalQuota(dirname(folder), g);
    let previous: Stats | undefined;
    try { previous = await fs.lstat(file); } catch (e) { if (!missing(e)) throw e; } live(g);
    if (fresh && previous) fail("conflict");
    if (!fresh && !previous) fail("damaged");
    if (previous && (!previous.isFile() || previous.isSymbolicLink() || previous.nlink !== 1)) fail("damaged");
    if (previous) {
      const prior = await boundedRead(file, PLUGIN_PATCH_LIMITS.recordBytes, g);
      if (!sameFile(previous, prior.stamp) || this.parse(new TextDecoder("utf-8", { fatal: true }).decode(prior.bytes), record.owner, record.content.proposal.id).integrity !== record.integrity) fail("damaged");
    }
    const prospectiveBytes = Math.max(Buffer.byteLength(encoded, "utf8"), reserveRecordBytes);
    if ((!previous && quota.count >= PLUGIN_PATCH_LIMITS.proposals) || quota.bytes - (previous?.size ?? 0) + prospectiveBytes > PLUGIN_PATCH_LIMITS.ownerBytes) fail("limit");
    if ((!previous && total.files >= PLUGIN_PATCH_LIMITS.totalFiles) || total.bytes - (previous?.size ?? 0) + prospectiveBytes > PLUGIN_PATCH_LIMITS.totalBytes) fail("limit");
    const temp = join(folder, `.${record.content.proposal.id}.${randomUUID()}.tmp`); let stamp: Stats | undefined;
    try {
      const handle = await fs.open(temp, "wx", 0o600);
      try { stamp = await handle.stat(); live(g); await handle.writeFile(encoded, { encoding: "utf8", signal: g.signal }); live(g); await handle.sync(); live(g); }
      finally { await handle.close().catch(() => undefined); }
      if (await this.directory(key, false, g) !== folder) fail("unavailable");
      let current: Stats | undefined; try { current = await fs.lstat(file); } catch (e) { if (!missing(e)) throw e; } live(g);
      if (current ? !previous || !sameFile(current, previous) : !!previous) fail("conflict");
      if (fresh) {
        await fs.link(temp, file);
        // Publication already happened. Cleanup failure or a later cancellation
        // cannot turn this persisted proposal into a claim that nothing was created.
        await fs.unlink(temp).catch(() => undefined);
      }
      else await fs.rename(temp, file);
    } finally { await this.cleanup(temp, stamp); }
  }
  private async cleanup(path: string, stamp?: Stats): Promise<void> {
    if (!stamp) return;
    try {
      const parent = dirname(path), dir = await fs.lstat(parent), actual = await fs.realpath(parent);
      const current = await fs.lstat(path);
      if (dir.isDirectory() && !dir.isSymbolicLink() && samePath(parent, actual) && current.isFile() && !current.isSymbolicLink() && sameInode(current, stamp)) await fs.unlink(path);
    } catch { /* An uncertain path belongs to someone else; preserve it. */ }
  }
  private async path(root: string, path: string, g: PluginPatchGuard, expectedRoot?: string, expectedIdentity?: RootIdentity): Promise<{ physical: string; target: string; identity: RootIdentity }> {
    live(g); validPath(path); const physical = await fs.realpath(root); live(g);
    if (expectedRoot && !samePath(physical, expectedRoot)) fail("conflict");
    const rootInfo = await fs.lstat(physical, { bigint: true }); live(g);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || expectedIdentity && (rootInfo.dev.toString() !== expectedIdentity.dev || rootInfo.ino.toString() !== expectedIdentity.ino)) fail("conflict");
    const safe = await withPermissionMode({ getPermissionMode: () => ({ mode: "workspace-edit", revision: 1 }),
      permissionProtectedPaths: [this.options.profile, ...this.options.protectedPaths] }, () => resolveSafePath(root, path, { mutation: true }));
    live(g); if (!safe.ok || !isPathInside(physical, safe.resolved, { strict: true })) throw new PluginBrokerFault("capability-denied");
    let cursor = physical;
    for (const part of path.split("/")) {
      cursor = join(cursor, part);
      try { const info = await fs.lstat(cursor); live(g); if (info.isSymbolicLink()) throw new PluginBrokerFault("capability-denied"); }
      catch (e) { if (!missing(e)) throw e; }
    }
    if (!samePath(cursor, safe.resolved)) throw new PluginBrokerFault("capability-denied");
    return { physical, target: cursor, identity: { dev: rootInfo.dev.toString(), ino: rootInfo.ino.toString() } };
  }
  private async snapshot(root: string, path: string, g: PluginPatchGuard, physical?: string, identity?: RootIdentity): Promise<Snapshot> {
    const safe = await this.path(root, path, g, physical, identity);
    try {
      const read = await boundedRead(safe.target, PLUGIN_PATCH_LIMITS.originalBytes, g);
      await this.path(root, path, g, safe.physical, safe.identity);
      decode(read.bytes);
      return { path: safe.target, bytes: read.bytes, stamp: read.stamp };
    } catch (e) { if (missing(e)) { live(g); return { path: safe.target, bytes: null }; } throw e; }
  }
  private matches(snapshot: Snapshot, base: string | null): void {
    if ((snapshot.bytes === null ? null : hash(snapshot.bytes)) !== base) fail("conflict");
  }
  private snapshotSync(root: string, record: PatchRecord, g: PluginPatchGuard): Snapshot {
    live(g); const physical = realpathSync(root); if (!samePath(physical, record.physicalRoot)) fail("conflict");
    const rootInfo = lstatSync(physical, { bigint: true });
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || rootInfo.dev.toString() !== record.rootIdentity.dev || rootInfo.ino.toString() !== record.rootIdentity.ino) fail("conflict");
    let path = physical;
    const parts = record.content.proposal.path.split("/");
    for (let index = 0; index < parts.length; index++) {
      path = join(path, parts[index]!);
      try { const info = lstatSync(path); if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory())) fail("conflict"); }
      catch (e) { if (missing(e) && index === parts.length - 1) return { path, bytes: null }; throw e; }
    }
    const before = lstatSync(path); if (!before.isFile() || before.nlink !== 1 || before.size > PLUGIN_PATCH_LIMITS.originalBytes) fail("conflict");
    const fd = openSync(path, "r");
    try {
      const opened = fstatSync(fd); if (!sameFile(before, opened)) fail("conflict");
      const buffer = Buffer.alloc(PLUGIN_PATCH_LIMITS.originalBytes + 1); let count = 0;
      while (count < buffer.length) { const n = readSync(fd, buffer, count, buffer.length - count, count); if (!n) break; count += n; }
      const after = fstatSync(fd), named = lstatSync(path);
      if (count > PLUGIN_PATCH_LIMITS.originalBytes || !sameFile(opened, after) || !sameFile(after, named) || named.isSymbolicLink() || named.nlink !== 1) fail("conflict");
      live(g); return { path, bytes: buffer.subarray(0, count), stamp: named };
    } finally { closeSync(fd); }
  }
  private async parents(root: string, record: PatchRecord, g: PluginPatchGuard): Promise<void> {
    let cursor = record.physicalRoot;
    for (const part of record.content.proposal.path.split("/").slice(0, -1)) {
      await this.path(root, record.content.proposal.path, g, record.physicalRoot, record.rootIdentity);
      cursor = join(cursor, part);
      await fs.mkdir(cursor).catch(e => { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }); live(g);
      const info = await fs.lstat(cursor); live(g);
      if (!info.isDirectory() || info.isSymbolicLink()) fail("conflict");
    }
  }
  async create(owner: PluginOutputOwner, producer: PluginOutputProducer, runId: string, args: { path: string; baseHash: string | null; content: string }, workspaceRoot: string, guard: PluginPatchGuard): Promise<PluginPatchProposal> {
    const key = ownerKey(owner); validPath(args.path); text(args.content, 48000); text(runId, 100, false);
    if ((args.baseHash !== null && !HASH.test(args.baseHash)) || args.content.includes("\0") || Buffer.byteLength(JSON.stringify(args), "utf8") > 65536) fail("invalid-input");
    const input = { path: args.path, baseHash: args.baseHash, content: args.content };
    const copiedProducer = producerCopy(producer), copiedOwner = { scope: owner.scope, target: owner.target };
    return this.serial(key, async () => {
      const safe = await this.path(workspaceRoot, input.path, guard), before = await this.snapshot(workspaceRoot, input.path, guard, safe.physical, safe.identity);
      this.matches(before, input.baseHash);
      const beforeText = before.bytes === null ? null : decode(before.bytes);
      // readText returns text without BOM; changing an existing BOM file preserves those bytes.
      const after = beforeText?.startsWith("\uFEFF") && !input.content.startsWith("\uFEFF") ? `\uFEFF${input.content}` : input.content;
      const diff = computeUnifiedDiff(beforeText ?? "", after, input.path), counts = countDiffLines(diff);
      const content: PluginPatchContent = { before: beforeText, after, diff, proposal: {
        id: randomUUID(), path: input.path, baseHash: input.baseHash, nextHash: hash(Buffer.from(after, "utf8")), createdAt: new Date().toISOString(),
        producer: copiedProducer, runId, status: "pending", additions: counts.add, deletions: counts.del } };
      const record: PatchRecord = { schemaVersion: 1, owner: copiedOwner, physicalRoot: safe.physical, rootIdentity: safe.identity, content, integrity: "" };
      record.integrity = immutable(record); await this.save(record, guard, true);
      return output(record).proposal;
    });
  }
  async list(owner: PluginOutputOwner, guard: PluginPatchGuard): Promise<{ items: PluginPatchProposal[]; damagedCount: number }> {
    const key = ownerKey(owner);
    return this.serial(key, async () => {
      const folder = await this.directory(key, false, guard); if (!folder) return { items: [], damagedCount: 0 };
      const names = await this.names(folder, 300, guard);
      const items: PluginPatchProposal[] = []; let damagedCount = 0;
      for (const name of names.filter(name => name.endsWith(".json"))) {
        const id = name.slice(0, -5);
        try { items.push(output(await this.load(owner, id, guard)).proposal); }
        catch (e) { live(guard); if (e instanceof PluginBrokerFault && ["cancelled", "revoked"].includes(e.code)) throw e; damagedCount++; }
      }
      return { items: items.sort((a, b) => b.createdAt.localeCompare(a.createdAt)), damagedCount };
    });
  }
  read(owner: PluginOutputOwner, id: string, guard: PluginPatchGuard): Promise<PluginPatchContent> {
    return this.serial(ownerKey(owner), async () => output(await this.load(owner, id, guard)));
  }
  /** Host failure recovery only: persist uncertainty without guessing or replaying a write. */
  markNeedsReview(owner: PluginOutputOwner, id: string, guard: PluginPatchGuard): Promise<PluginPatchContent> {
    const key = ownerKey(owner);
    return this.serial(key, async () => {
      try {
        const record = await this.load(owner, id, guard);
        // A real commit receipt wins even when its final metadata write failed.
        // Never write cached content back over a damaged authoritative file.
        if (record.content.proposal.status === "applied" || record.content.proposal.status === "needs-review") return output(record);
        if (this.applying.has(`${key}:${id}`)) fail("busy");
        record.content = { ...record.content, proposal: { ...record.content.proposal, status: "needs-review",
          message: "此次应用的最终状态未能确认，请核对项目文件并重新提出修改；不会自动重试。" } };
        await this.save(record, guard);
        return output(record);
      } catch (error) {
        if (error instanceof PluginBrokerFault) throw error;
        throw new PluginPatchFault("unavailable");
      }
    });
  }
  async cancel(owner: PluginOutputOwner, id: string, guard: PluginPatchGuard): Promise<PluginPatchContent> {
    const key = ownerKey(owner); if (this.applying.has(`${key}:${id}`)) fail("busy");
    return this.serial(key, async () => {
      const r = await this.load(owner, id, guard); if (!RETRY.includes(r.content.proposal.status)) fail("conflict");
      r.content = { ...r.content, proposal: { ...r.content.proposal, status: "cancelled", message: "已取消，未写入项目文件。" } };
      await this.save(r, guard); return output(r);
    });
  }
  async apply(owner: PluginOutputOwner, id: string, options: { workspaceRoot: string; guard: PluginPatchGuard; authorize: (preview: PluginPatchContent) => Promise<boolean> }): Promise<PluginPatchContent> {
    const key = ownerKey(owner), lock = `${key}:${id}`, g = options.guard;
    if (this.applying.has(lock)) fail("busy"); this.applying.add(lock);
    let r: PatchRecord | undefined, temp: string | undefined, tempStamp: Stats | undefined, pathKey: string | undefined, committed = false;
    const persist = async (state: PluginPatchStatus, message?: string) => {
      r!.content = { ...r!.content, proposal: { ...r!.content.proposal, status: state, ...(message ? { message } : {}) } };
      await this.serial(key, () => this.save(r!, detached));
    };
    const settleFailure = async (e: unknown, insideBudget = false): Promise<PluginPatchContent> => {
      if (!r || committed) throw e;
      if (!RETRY.includes(r.content.proposal.status) && r.content.proposal.status !== "applying") throw e;
      if (e instanceof PluginPatchFault && e.reason === "busy") throw e;
      let state: PluginPatchStatus = "failed", message = "应用未完成，未提交项目文件。";
      if (e instanceof PluginPatchFault && e.reason === "conflict") { state = "conflict"; message = "文件或项目已变化，未提交修改；请重新读取并提出修改。"; }
      else if (e instanceof PluginPatchFault && e.reason === "limit") message = "插件资料空间不足，未提交项目修改；请检查已有资料后再试。";
      else if (g.signal.aborted || e instanceof PluginBrokerFault && ["cancelled", "revoked"].includes(e.code)) { state = "cancelled"; message = "操作已取消或权限已变化，未提交项目文件。"; }
      try {
        if (insideBudget) {
          r.content = { ...r.content, proposal: { ...r.content.proposal, status: state, message } };
          await this.saveLocked(r, detached, false);
        } else await persist(state, message);
      } catch { /* Keep an unfinalized applying intent; restart requires manual review. */ }
      return output(r);
    };
    try {
      r = await this.serial(key, () => this.load(owner, id, g));
      if (!RETRY.includes(r.content.proposal.status)) fail("conflict");
      const initial = await this.snapshot(options.workspaceRoot, r.content.proposal.path, g, r.physicalRoot, r.rootIdentity); this.matches(initial, r.content.proposal.baseHash);
      pathKey = resolve(initial.path).toLowerCase(); if (this.paths.has(pathKey)) { pathKey = undefined; fail("busy"); } this.paths.add(pathKey);
      if (!await options.authorize(output(r))) { live(g); await persist("denied", "未获批准，项目文件保持不变。"); return output(r); }
      live(g);
      const approved = await this.snapshot(options.workspaceRoot, r.content.proposal.path, g, r.physicalRoot, r.rootIdentity); this.matches(approved, r.content.proposal.baseHash);
      // Never hold the shared storage lock while asking the user. Lock order is
      // owner queue -> local saving queue -> profile budget; inner saves must not
      // re-enter any of these queues. The reserve covers intent growth plus the
      // final temporary record, including bounded status/message/timestamp fields.
      const recordPeak = Buffer.byteLength(JSON.stringify(r), "utf8") + 2048;
      // Reserve the bounded terminal fields within the per-record limit too;
      // clamping this amount could defer a predictable failure until after commit.
      if (recordPeak > PLUGIN_PATCH_LIMITS.recordBytes) fail("limit");
      return await this.serial(key, () => this.serializeSaving(() => this.withBudget(2 * recordPeak, g, async () => {
        try {
          const record = r!;
          // The persisted intent contains the exact old UTF-8/BOM bytes as a backup.
          // File fsync plus rename is not a power-loss transaction for directory entries.
          this.activeWrites.add(lock);
          record.content = { ...record.content, proposal: { ...record.content.proposal, status: "applying", message: "正在应用；若意外退出，需要核对文件后重新提出修改。" } };
          await this.saveLocked(record, detached, false, recordPeak); live(g);
          await this.parents(options.workspaceRoot, record, g);
          const target = join(record.physicalRoot, ...record.content.proposal.path.split("/")); temp = join(dirname(target), `.herta-plugin-${randomUUID()}.tmp`);
          const handle = await fs.open(temp, "wx", 0o600);
          try { tempStamp = await handle.stat(); live(g); await handle.writeFile(Buffer.from(record.content.after, "utf8"), { signal: g.signal }); live(g); await handle.sync(); live(g); }
          finally { await handle.close().catch(() => undefined); }
          await this.path(options.workspaceRoot, record.content.proposal.path, g, record.physicalRoot, record.rootIdentity);
          // No await from the final live/base check to existing-file rename. This
          // serializes our writers, but is NOT an OS-level hash compare-and-swap.
          const final = this.snapshotSync(options.workspaceRoot, record, g); this.matches(final, record.content.proposal.baseHash); live(g);
          const staged = lstatSync(temp);
          if (!tempStamp || !staged.isFile() || staged.isSymbolicLink() || staged.nlink !== 1 || !sameInode(staged, tempStamp)) fail("conflict");
          const stageFd = openSync(temp, "r");
          try {
            if (!sameFile(fstatSync(stageFd), staged)) fail("conflict");
            const bytes = Buffer.alloc(PLUGIN_PATCH_LIMITS.originalBytes + 1); let length = 0;
            while (length < bytes.length) { const n = readSync(stageFd, bytes, length, bytes.length - length, length); if (!n) break; length += n; }
            if (length > PLUGIN_PATCH_LIMITS.originalBytes || hash(bytes.subarray(0, length)) !== record.content.proposal.nextHash
              || !sameFile(fstatSync(stageFd), staged) || !sameFile(lstatSync(temp), staged)) fail("conflict");
          } finally { closeSync(stageFd); }
          live(g);
          if (record.content.proposal.baseHash === null) {
            try { fsSync.linkSync(temp, final.path); committed = true; }
            catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") fail("conflict"); throw e; }
          } else { fsSync.renameSync(temp, final.path); committed = true; }
          // Do not assert the now possibly revoked run before recording a real commit.
          record.content = { ...record.content, proposal: { ...record.content.proposal, status: "applied", appliedAt: new Date().toISOString(), message: "已应用到项目文件。" } };
          this.receipts.set(lock, structuredClone(record));
          try { await this.saveLocked(record, detached, false); }
          catch { record.content = { ...record.content, proposal: { ...record.content.proposal, message: "文件已写入，但完成记录未能保存；本次凭据仍保留，重启后请核对文件，不要直接重试。" } }; this.receipts.set(lock, structuredClone(record)); }
          return output(record);
        } catch (error) { return settleFailure(error, true); }
      })));
    } catch (e) {
      return await settleFailure(e);
    } finally {
      await this.cleanup(temp ?? "", tempStamp);
      if (pathKey) this.paths.delete(pathKey);
      this.applying.delete(lock);
      this.activeWrites.delete(lock);
    }
  }
}
