import { createHash, randomUUID } from "node:crypto";
import { promises as fs, type Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { PluginArtifact, PluginArtifactMime, PluginOutputOwner, PluginOutputProducer } from "../../shared/plugin-deliverables.js";
import { PluginBrokerFault } from "./capability-broker.js";
import { getPluginStorageCoordinator, PluginStorageBudgetFault, type PluginStorageCoordinator } from "./plugin-storage-coordinator.js";

export interface PluginArtifactGuard { readonly signal: AbortSignal; assertCurrent(): void }
export class PluginArtifactFault extends PluginBrokerFault {
  constructor(readonly reason: "invalid" | "not-found" | "damaged" | "unavailable" | "limit" | "conflict") {
    super(reason === "invalid" ? "invalid-input" : reason === "limit" ? "resource-limit" : "host-error");
    this.name = "PluginArtifactFault";
  }
}
export const PLUGIN_ARTIFACT_LIMITS = Object.freeze({ textUnits: 48000, bytes: 128 * 1024, sessionRecords: 100,
  sessionBytes: 10 * 1024 * 1024, totalRecords: 5000, totalBytes: 100 * 1024 * 1024 });
const DIRECTORY = "plugin-artifacts-v1", ENVELOPE_BYTES = 512 * 1024, SCAN_ENTRIES = 12000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const MIMES = new Set<PluginArtifactMime>(["text/plain", "text/markdown", "text/csv", "application/json"]);
type Handle = Awaited<ReturnType<typeof fs.open>>;
type Limits = Record<"sessionRecords" | "sessionBytes" | "totalRecords" | "totalBytes", number>;
interface Envelope { schemaVersion: 1; owner: PluginOutputOwner; artifact: PluginArtifact; content: string }
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export function assertPluginArtifactCurrent(guard: PluginArtifactGuard): void {
  if (guard.signal.aborted) throw new PluginBrokerFault("cancelled");
  guard.assertCurrent();
}
function samePath(a: string, b: string): boolean { return process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b); }
function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function safeText(value: unknown, maximum: number, empty = false): value is string {
  if (typeof value !== "string" || value.length > maximum || (!empty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value)) return false;
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) { const low = value.charCodeAt(++i); if (!(low >= 0xdc00 && low <= 0xdfff)) return false; }
    else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
export function isPluginArtifactName(value: unknown): value is string {
  return safeText(value, 160) && value.trim() === value && !/[\\/:*?"<>|\r\n\t]/.test(value)
    && value !== "." && value !== ".." && !value.endsWith(".") && !/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(value);
}
function ownerOf(value: PluginOutputOwner): PluginOutputOwner {
  if (!value || (value.scope !== "chat" && value.scope !== "workbench") || !safeText(value.target, 512)) throw new PluginArtifactFault("invalid");
  return Object.freeze({ scope: value.scope, target: value.target });
}
function producerOf(value: PluginOutputProducer): PluginOutputProducer {
  if (!value || !safeText(value.id, 80) || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(value.id)
    || !safeText(value.name, 120) || !safeText(value.version, 80) || !HASH.test(value.contentHash)
    || !Number.isSafeInteger(value.grantRevision) || value.grantRevision < 0) throw new PluginArtifactFault("invalid");
  return Object.freeze({ id: value.id, name: value.name, version: value.version, contentHash: value.contentHash, grantRevision: value.grantRevision });
}
function contentOf(args: { name: string; mime: string; text: string }) {
  if (!args || !isPluginArtifactName(args.name) || !MIMES.has(args.mime as PluginArtifactMime)
    || !safeText(args.text, PLUGIN_ARTIFACT_LIMITS.textUnits, true)) throw new PluginArtifactFault("invalid");
  const bytes = Buffer.from(args.text, "utf8");
  if (bytes.length > PLUGIN_ARTIFACT_LIMITS.bytes) throw new PluginArtifactFault("limit");
  return { name: args.name, mime: args.mime as PluginArtifactMime, text: args.text, bytes: bytes.length, sha256: hash(bytes) };
}
function keys(value: unknown, allowed: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === allowed.length && Object.keys(value).every(key => allowed.includes(key));
}

/** Durable user outputs, independent of install grants, run history and model conversations. */
export class PluginArtifactStore {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly profile: string;
  private physicalProfile: string | undefined;
  private profileIdentity: Pick<Stats, "dev" | "ino"> | undefined;
  private readonly limits: Limits;
  private readonly storage: PluginStorageCoordinator;
  /** The optional host-only policy may lower quotas for embedding/tests; it cannot widen them. */
  constructor(profile: string, options: Partial<Limits> & { storage?: PluginStorageCoordinator } = {}) {
    this.profile = resolve(profile);
    const { storage, ...limits } = options;
    this.storage = storage ?? getPluginStorageCoordinator(this.profile);
    const chosen = { sessionRecords: PLUGIN_ARTIFACT_LIMITS.sessionRecords, sessionBytes: PLUGIN_ARTIFACT_LIMITS.sessionBytes,
      totalRecords: PLUGIN_ARTIFACT_LIMITS.totalRecords, totalBytes: PLUGIN_ARTIFACT_LIMITS.totalBytes, ...limits };
    for (const key of Object.keys(chosen) as (keyof Limits)[]) if (!Number.isSafeInteger(chosen[key]) || chosen[key] < 1 || chosen[key] > PLUGIN_ARTIFACT_LIMITS[key]) throw new PluginArtifactFault("invalid");
    this.limits = chosen;
  }
  private serial<T>(guard: PluginArtifactGuard, operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      assertPluginArtifactCurrent(guard);
      try { return await operation(); } catch (error) {
        if (error instanceof PluginBrokerFault) throw error;
        if (error instanceof PluginStorageBudgetFault) {
          if (error.reason === "cancelled") throw new PluginBrokerFault("cancelled");
          assertPluginArtifactCurrent(guard); throw new PluginArtifactFault(error.reason === "limit" ? "limit" : "unavailable");
        }
        assertPluginArtifactCurrent(guard); throw new PluginArtifactFault("unavailable");
      }
    });
    this.tail = result.then(() => undefined, () => undefined); return result;
  }
  private async plainDirectory(path: string, guard: PluginArtifactGuard, create: boolean): Promise<boolean> {
    if (create) { await fs.mkdir(path).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }); assertPluginArtifactCurrent(guard); }
    let info: Stats;
    try { info = await fs.lstat(path); } catch (error) { assertPluginArtifactCurrent(guard); if (!create && missing(error)) return false; throw error; }
    assertPluginArtifactCurrent(guard);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new PluginArtifactFault("damaged");
    const physical = await fs.realpath(path); assertPluginArtifactCurrent(guard);
    if (!samePath(physical, path)) throw new PluginArtifactFault("damaged"); return true;
  }
  private async directory(owner: PluginOutputOwner, guard: PluginArtifactGuard, create: boolean): Promise<{ root: string; folder: string } | null> {
    const info = await fs.lstat(this.profile); assertPluginArtifactCurrent(guard);
    const physical = await fs.realpath(this.profile); assertPluginArtifactCurrent(guard);
    const actual = await fs.lstat(physical); assertPluginArtifactCurrent(guard);
    if (!info.isDirectory() || info.isSymbolicLink() || !actual.isDirectory() || actual.isSymbolicLink() || info.dev !== actual.dev || info.ino !== actual.ino
      || (this.physicalProfile && !samePath(this.physicalProfile, physical))
      || (this.profileIdentity && (actual.dev !== this.profileIdentity.dev || actual.ino !== this.profileIdentity.ino))) throw new PluginArtifactFault("damaged");
    this.physicalProfile ??= physical;
    this.profileIdentity ??= { dev: actual.dev, ino: actual.ino };
    const root = join(physical, DIRECTORY), folder = join(root, hash(JSON.stringify(owner)));
    if (!await this.plainDirectory(root, guard, create) || !await this.plainDirectory(folder, guard, create)) return null;
    return { root, folder };
  }
  private async entries(folder: string, guard: PluginArtifactGuard, maximum = SCAN_ENTRIES): Promise<string[]> {
    const handle = await fs.opendir(folder);
    const names: string[] = [];
    try {
      assertPluginArtifactCurrent(guard);
      for (;;) {
        const entry = await handle.read(); assertPluginArtifactCurrent(guard); if (!entry) break;
        if (names.length >= maximum) throw new PluginArtifactFault("limit"); names.push(entry.name);
      }
    } finally { await handle.close().catch(() => undefined); }
    return names;
  }
  /** Counts every regular file, including damaged envelopes and abandoned temporaries. Unknown
   * nested directories/links make accounting unverifiable, so create refuses without deleting them. */
  private async quota(root: string, folder: string, guard: PluginArtifactGuard): Promise<void> {
    let count = 0, bytes = 0, ownCount = 0, ownBytes = 0, scanned = 0;
    const inspect = async (file: string, own: boolean) => {
      if (++scanned > SCAN_ENTRIES) throw new PluginArtifactFault("limit");
      const stat = await fs.lstat(file); assertPluginArtifactCurrent(guard);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !Number.isSafeInteger(stat.size)) throw new PluginArtifactFault("damaged");
      count++; bytes += stat.size; if (own) { ownCount++; ownBytes += stat.size; }
      if (count > this.limits.totalRecords || bytes > this.limits.totalBytes || ownCount > this.limits.sessionRecords || ownBytes > this.limits.sessionBytes) throw new PluginArtifactFault("limit");
    };
    for (const name of await this.entries(root, guard)) {
      if (++scanned > SCAN_ENTRIES) throw new PluginArtifactFault("limit");
      const path = join(root, name), stat = await fs.lstat(path); assertPluginArtifactCurrent(guard);
      if (stat.isFile() && !stat.isSymbolicLink()) { await inspect(path, false); continue; }
      if (!HASH.test(name) || !stat.isDirectory() || stat.isSymbolicLink()) throw new PluginArtifactFault("damaged");
      await this.plainDirectory(path, guard, false);
      for (const file of await this.entries(path, guard)) await inspect(join(path, file), samePath(path, folder));
    }
  }
  private async readEnvelope(folder: string, id: string, owner: PluginOutputOwner, guard: PluginArtifactGuard): Promise<{ artifact: PluginArtifact; content: string }> {
    const file = join(folder, `${id}.json`); let handle: Handle | undefined;
    try {
      const before = await fs.lstat(file); assertPluginArtifactCurrent(guard);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > ENVELOPE_BYTES) throw new PluginArtifactFault("damaged");
      handle = await fs.open(file, "r"); assertPluginArtifactCurrent(guard);
      const opened = await handle.stat(); assertPluginArtifactCurrent(guard);
      if (!sameFile(before, opened)) throw new PluginArtifactFault("damaged");
      const bytes = Buffer.alloc(Math.min(before.size + 1, ENVELOPE_BYTES + 1)); let length = 0;
      while (length < bytes.length) { const part = await handle.read(bytes, length, bytes.length - length, length); assertPluginArtifactCurrent(guard); if (!part.bytesRead) break; length += part.bytesRead; }
      const after = await handle.stat(); assertPluginArtifactCurrent(guard);
      const linked = await fs.lstat(file); assertPluginArtifactCurrent(guard);
      if (!sameFile(opened, after) || !sameFile(after, linked) || linked.isSymbolicLink() || linked.nlink !== 1 || length !== before.size) throw new PluginArtifactFault("damaged");
      const current = await this.directory(owner, guard, false);
      if (!current || !samePath(current.folder, folder)) throw new PluginArtifactFault("damaged");
      let raw: unknown;
      try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length))); } catch { throw new PluginArtifactFault("damaged"); }
      if (!keys(raw, ["schemaVersion", "owner", "artifact", "content"]) || raw.schemaVersion !== 1
        || !keys(raw.owner, ["scope", "target"]) || raw.owner.scope !== owner.scope || raw.owner.target !== owner.target
        || !keys(raw.artifact, ["id", "name", "mime", "bytes", "sha256", "createdAt", "producer", "runId"])) throw new PluginArtifactFault("damaged");
      const a = raw.artifact;
      try {
        const content = contentOf({ name: a.name as string, mime: a.mime as string, text: raw.content as string });
        if (a.id !== id || a.bytes !== content.bytes || a.sha256 !== content.sha256 || !safeText(a.runId, 100)
          || typeof a.createdAt !== "string" || !Number.isFinite(Date.parse(a.createdAt)) || new Date(a.createdAt).toISOString() !== a.createdAt
          || !keys(a.producer, ["id", "name", "version", "contentHash", "grantRevision"])) throw new PluginArtifactFault("damaged");
        const artifact: PluginArtifact = Object.freeze({ id, name: content.name, mime: content.mime, bytes: content.bytes, sha256: content.sha256,
          createdAt: a.createdAt, producer: producerOf(a.producer as unknown as PluginOutputProducer), runId: a.runId });
        return { artifact, content: content.text };
      } catch { throw new PluginArtifactFault("damaged"); }
    } catch (error) {
      assertPluginArtifactCurrent(guard);
      if (missing(error)) throw new PluginArtifactFault("not-found");
      if (error instanceof PluginBrokerFault) throw error;
      throw new PluginArtifactFault("damaged");
    }
    finally { await handle?.close().catch(() => undefined); }
  }
  async create(owner: PluginOutputOwner, producer: PluginOutputProducer, runId: string, args: { name: string; mime: string; text: string }, guard: PluginArtifactGuard): Promise<PluginArtifact> {
    // Snapshot trusted caller data before waiting in the host queue; a later edit
    // cannot move this write into another owner or replace the promised content.
    const selected = ownerOf(owner), source = producerOf(producer), content = contentOf(args);
    if (!safeText(runId, 100)) throw new PluginArtifactFault("invalid");
    return this.serial(guard, async () => {
      const location = await this.directory(selected, guard, true); if (!location) throw new PluginArtifactFault("unavailable");
      const artifact: PluginArtifact = Object.freeze({ id: randomUUID(), name: content.name, mime: content.mime, bytes: content.bytes, sha256: content.sha256,
        createdAt: new Date().toISOString(), producer: source, runId });
      const envelope: Envelope = { schemaVersion: 1, owner: selected, artifact, content: content.text };
      const encoded = JSON.stringify(envelope); if (Buffer.byteLength(encoded) > ENVELOPE_BYTES) throw new PluginArtifactFault("limit");
      // Count both paths during no-clobber hard-link publication, even though
      // they briefly name the same inode. Local queue precedes the shared lock.
      return this.storage.withWrite(2 * Buffer.byteLength(encoded, "utf8"), guard, async () => {
        const ready = await this.directory(selected, guard, false);
        if (!ready || !samePath(ready.folder, location.folder)) throw new PluginArtifactFault("damaged");
        const temporary = join(location.folder, `.${artifact.id}.${randomUUID()}.tmp`), destination = join(location.folder, `${artifact.id}.json`);
        let owned: Stats | undefined, complete: Stats | undefined, handle: Handle | undefined;
        try {
          handle = await fs.open(temporary, "wx", 0o600); owned = await handle.stat(); assertPluginArtifactCurrent(guard);
          await handle.writeFile(encoded, { encoding: "utf8", signal: guard.signal }); assertPluginArtifactCurrent(guard);
          await handle.sync(); assertPluginArtifactCurrent(guard); complete = await handle.stat(); assertPluginArtifactCurrent(guard);
          await handle.close(); handle = undefined;
          const current = await this.directory(selected, guard, false);
          if (!current || !samePath(current.folder, location.folder)) throw new PluginArtifactFault("damaged");
          // The fully written temporary already counts as the prospective record.
          await this.quota(location.root, location.folder, guard);
          const checked = await this.directory(selected, guard, false);
          if (!checked || !samePath(checked.folder, location.folder)) throw new PluginArtifactFault("damaged");
          const stamp = await fs.lstat(temporary); assertPluginArtifactCurrent(guard);
          if (!stamp.isFile() || stamp.isSymbolicLink() || stamp.nlink !== 1 || !sameFile(stamp, complete) || stamp.dev !== owned.dev || stamp.ino !== owned.ino) throw new PluginArtifactFault("damaged");
          // link is an atomic no-clobber publication. No guard after it: cancellation
          // can arrive during the OS call, but an already published output is durable.
          await fs.link(temporary, destination);
          try { await fs.unlink(temporary); owned = undefined; }
          catch { /* The output exists. Retry owned cleanup in finally, never claim no output. */ }
          return artifact;
        } finally {
          await handle?.close().catch(() => undefined);
          if (owned) await this.cleanup(temporary, owned);
        }
      });
    });
  }
  private async cleanup(file: string, owned: Stats): Promise<void> {
    try {
      const parent = dirname(file), directory = await fs.lstat(parent);
      if (!directory.isDirectory() || directory.isSymbolicLink() || !samePath(await fs.realpath(parent), parent)) return;
      const current = await fs.lstat(file);
      if (current.isFile() && !current.isSymbolicLink() && current.dev === owned.dev && current.ino === owned.ino) await fs.unlink(file);
    } catch { /* Keep uncertain/corrupt paths for explicit recovery, never delete someone else's file. */ }
  }
  async list(owner: PluginOutputOwner, guard: PluginArtifactGuard): Promise<{ items: readonly PluginArtifact[]; damagedCount: number }> {
    const selected = ownerOf(owner);
    return this.serial(guard, async () => {
      const location = await this.directory(selected, guard, false);
      if (!location) return { items: [], damagedCount: 0 };
      // Normal libraries contain <=100 records. Refuse an externally inflated
      // directory rather than read thousands of hostile 512KiB envelopes.
      const names = await this.entries(location.folder, guard, 512), items: PluginArtifact[] = []; let damagedCount = 0;
      for (const name of names) {
        if (!name.endsWith(".json") || !UUID.test(name.slice(0, -5))) { damagedCount++; continue; }
        try { items.push((await this.readEnvelope(location.folder, name.slice(0, -5), selected, guard)).artifact); }
        catch (error) { assertPluginArtifactCurrent(guard); if (error instanceof PluginArtifactFault && ["damaged", "not-found"].includes(error.reason)) damagedCount++; else throw error; }
      }
      const current = await this.directory(selected, guard, false); if (!current || !samePath(current.folder, location.folder)) throw new PluginArtifactFault("damaged");
      return { items: Object.freeze(items.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))), damagedCount };
    });
  }
  async read(owner: PluginOutputOwner, id: string, guard: PluginArtifactGuard): Promise<{ artifact: PluginArtifact; content: string }> {
    const selected = ownerOf(owner); if (typeof id !== "string" || !UUID.test(id)) throw new PluginArtifactFault("invalid");
    return this.serial(guard, async () => {
      const location = await this.directory(selected, guard, false); if (!location) throw new PluginArtifactFault("not-found");
      return this.readEnvelope(location.folder, id, selected, guard);
    });
  }
}
