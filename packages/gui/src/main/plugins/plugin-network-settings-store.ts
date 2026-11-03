import { createHash, randomUUID } from "node:crypto";
import { promises as fs, type Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parsePluginNetworkConfig, PLUGIN_NETWORK_DEFAULT_CONFIG, type PluginNetworkConfig, type PluginNetworkSettingsSnapshot } from "../../shared/plugin-network-settings.js";
import { isPublicPluginAddress } from "./plugin-network-address.js";

export const PLUGIN_NETWORK_SETTINGS_FILE = "plugin-network-settings.json";
const MAX_BYTES = 16384, ARCHIVES = "plugin-network-settings-archives", MAX_ARCHIVES = 8;
const TEMP_NAME = /^\.network-settings-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.tmp$/;
const LOAD_ERROR = "插件联网设置无法完整读取，联网已暂停。可明确保存有效配置修复；可安全读取的损坏原件会先保留。";
export interface PluginNetworkSettingsGuard { readonly signal: AbortSignal; assertCurrent(): void }
const always: PluginNetworkSettingsGuard = { signal: new AbortController().signal, assertCurrent() {} };
const messages = { invalid: "插件联网设置不符合要求，请检查后保存。", conflict: "插件联网设置已变化；当前编辑仍保留，请明确重新读取后再保存。",
  unavailable: "网络配置未保存。无法安全核验或保留旧记录，请检查资料后重试。", archive: "网络配置原件归档已达到上限，请先整理保留的记录。", cancelled: "插件联网设置保存已取消。" } as const;
export class PluginNetworkSettingsFault extends Error {
  constructor(readonly reason: keyof typeof messages) { super(messages[reason]); this.name = "PluginNetworkSettingsFault"; }
}
interface Captured { readonly exists: boolean; readonly bytes?: Buffer; readonly stamp?: Stats; readonly fingerprint: string; readonly safe: boolean }
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const samePath = (a: string, b: string) => process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.nlink === b.nlink;
function live(guard: PluginNetworkSettingsGuard): void { if (guard.signal.aborted) throw new PluginNetworkSettingsFault("cancelled"); guard.assertCurrent(); }
function hostConfig(raw: unknown): PluginNetworkConfig {
  let config: PluginNetworkConfig; try { config = parsePluginNetworkConfig(raw); } catch { throw new PluginNetworkSettingsFault("invalid"); }
  if (config.dohBootstrapAddress && !isPublicPluginAddress(config.dohBootstrapAddress)) throw new PluginNetworkSettingsFault("invalid");
  return config;
}

/** Small host configuration, separate from provider secrets and plugin-owned data.
 * Corrupt reads carry loadError; a displayed default never enables networking. */
export class PluginNetworkSettingsStore {
  private readonly profile: string;
  private physical?: string;
  private identity?: Pick<Stats, "dev" | "ino">;
  private tail: Promise<unknown> = Promise.resolve();
  private fingerprint?: string;
  private observedFile = false;
  private snapshot: PluginNetworkSettingsSnapshot = Object.freeze({ revision: 0, config: PLUGIN_NETWORK_DEFAULT_CONFIG, loadError: "插件联网设置尚未读取。" });
  constructor(profile: string) { this.profile = resolve(profile); }
  current(): PluginNetworkSettingsSnapshot { return this.snapshot; }
  private serial<T>(guard: PluginNetworkSettingsGuard, work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => { live(guard); return work(); });
    this.tail = result.then(() => undefined, () => undefined); return result;
  }
  private async root(create: boolean, guard: PluginNetworkSettingsGuard): Promise<string | undefined> {
    let stamp: Stats;
    try { stamp = await fs.lstat(this.profile); }
    catch (error) {
      live(guard); if (!missing(error) || this.identity) throw error;
      if (!create) return undefined;
      await fs.mkdir(this.profile, { recursive: true }); live(guard); stamp = await fs.lstat(this.profile);
    }
    live(guard); const physical = await fs.realpath(this.profile); live(guard);
    if (!stamp.isDirectory() || stamp.isSymbolicLink() || this.physical && !samePath(this.physical, physical)
      || this.identity && (stamp.dev !== this.identity.dev || stamp.ino !== this.identity.ino)) throw new PluginNetworkSettingsFault("unavailable");
    this.physical ??= physical; this.identity ??= { dev: stamp.dev, ino: stamp.ino }; return physical;
  }
  private async captureFile(file: string, guard: PluginNetworkSettingsGuard): Promise<Captured> {
    let stamp: Stats;
    try { stamp = await fs.lstat(file); } catch (error) { live(guard); if (missing(error)) return { exists: false, safe: true, fingerprint: "missing" }; throw error; }
    live(guard);
    if (!stamp.isFile() || stamp.isSymbolicLink() || stamp.nlink < 1 || stamp.nlink > 8 || stamp.size > MAX_BYTES) return { exists: true, safe: false, fingerprint: "unsafe" };
    if (stamp.nlink > 1) {
      // A failed publication cleanup can retain our exact temporary alias.
      // Account for every inode name before reading; links elsewhere stay denied.
      const folder = dirname(file), directory = await fs.opendir(folder); let scanned = 0, aliases = 1;
      try { for (;;) {
        const entry = await directory.read(); live(guard); if (!entry) break;
        if (++scanned > 4096) throw new PluginNetworkSettingsFault("unavailable");
        if (!TEMP_NAME.test(entry.name)) continue;
        const candidate = await fs.lstat(join(folder, entry.name)); live(guard);
        if (candidate.dev !== stamp.dev || candidate.ino !== stamp.ino) continue;
        if (!candidate.isFile() || candidate.isSymbolicLink() || !same(candidate, stamp)) throw new PluginNetworkSettingsFault("unavailable");
        aliases++;
      } } finally { await directory.close(); }
      if (aliases !== stamp.nlink) throw new PluginNetworkSettingsFault("unavailable");
    }
    const handle = await fs.open(file, "r");
    try {
      live(guard); const opened = await handle.stat(); live(guard); if (!same(stamp, opened)) throw Error();
      const buffer = Buffer.alloc(MAX_BYTES + 1); let length = 0;
      while (length < buffer.length) { const part = await handle.read(buffer, length, buffer.length - length, length); live(guard); if (!part.bytesRead) break; length += part.bytesRead; }
      const after = await handle.stat(), named = await fs.lstat(file); live(guard);
      if (length !== stamp.size || length > MAX_BYTES || !same(opened, after) || !same(after, named) || named.isSymbolicLink()) throw Error();
      const bytes = buffer.subarray(0, length); return { exists: true, safe: true, bytes, stamp: named, fingerprint: hash(bytes) };
    } finally { await handle.close().catch(() => undefined); }
  }
  private async read(guard: PluginNetworkSettingsGuard): Promise<Captured> {
    try { const root = await this.root(false, guard); const captured = root ? await this.captureFile(join(root, PLUGIN_NETWORK_SETTINGS_FILE), guard) : { exists: false, safe: true, fingerprint: "missing" };
      if (root && await this.root(false, guard) !== root) throw Error(); return captured;
    } catch { live(guard); return { exists: true, safe: false, fingerprint: "unavailable" }; }
  }
  private publish(captured: Captured): PluginNetworkSettingsSnapshot {
    if (captured.exists) this.observedFile = true;
    if (captured.fingerprint === this.fingerprint) return this.snapshot;
    let config = PLUGIN_NETWORK_DEFAULT_CONFIG, storedRevision = 0, loadError: string | undefined;
    try {
      if (!captured.safe) throw Error();
      if (!captured.exists && this.observedFile) throw Error();
      if (captured.exists) {
        const raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(captured.bytes!));
        if (!raw || Object.keys(raw).length !== 3 || raw.schemaVersion !== 1 || !Number.isSafeInteger(raw.revision) || raw.revision < 1 || raw.revision >= Number.MAX_SAFE_INTEGER - 1) throw Error();
        config = hostConfig(raw.config); storedRevision = raw.revision;
      }
    } catch { loadError = LOAD_ERROR; }
    const revision = this.fingerprint === undefined && !captured.exists ? 0 : Math.max(this.snapshot.revision + 1, storedRevision);
    this.fingerprint = captured.fingerprint; this.snapshot = Object.freeze({ revision, config, ...(loadError ? { loadError } : {}) }); return this.snapshot;
  }
  load(guard: PluginNetworkSettingsGuard = always): Promise<PluginNetworkSettingsSnapshot> { return this.serial(guard, async () => this.publish(await this.read(guard))); }
  private async cleanup(file: string, owned?: Stats): Promise<void> {
    if (!owned) return;
    try { const parent = dirname(file), directory = await fs.lstat(parent);
      if (!directory.isDirectory() || directory.isSymbolicLink() || !samePath(await fs.realpath(parent), parent)) return;
      const now = await fs.lstat(file); if (now.isFile() && !now.isSymbolicLink() && now.dev === owned.dev && now.ino === owned.ino) await fs.unlink(file); }
    catch { /* Published files and uncertain paths are not a cleanup failure. */ }
  }
  private async temporary(root: string, bytes: Buffer, guard: PluginNetworkSettingsGuard): Promise<{ path: string; stamp: Stats }> {
    const path = join(root, `.network-settings-${randomUUID()}.tmp`), handle = await fs.open(path, "wx", 0o600); let stamp: Stats | undefined;
    try { stamp = await handle.stat(); live(guard); await handle.writeFile(bytes, { signal: guard.signal }); live(guard); await handle.sync(); live(guard); return { path, stamp }; }
    catch (error) { await handle.close().catch(() => undefined); await this.cleanup(path, stamp); throw error; }
    finally { await handle.close().catch(() => undefined); }
  }
  private async archive(root: string, bytes: Buffer, guard: PluginNetworkSettingsGuard): Promise<void> {
    const folder = join(root, ARCHIVES); await fs.mkdir(folder).catch(error => { if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error; }); live(guard);
    const info = await fs.lstat(folder); live(guard);
    if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await fs.realpath(folder), folder)) throw new PluginNetworkSettingsFault("unavailable");
    const file = join(folder, hash(bytes) + ".json"), existing = await this.captureFile(file, guard);
    if (existing.exists) { if (!existing.safe || !existing.bytes?.equals(bytes)) throw new PluginNetworkSettingsFault("unavailable"); return; }
    const directory = await fs.opendir(folder); let entries = 0;
    try { for (;;) { const entry = await directory.read(); live(guard); if (!entry) break; if (++entries >= MAX_ARCHIVES) throw new PluginNetworkSettingsFault("archive"); } }
    finally { await directory.close(); }
    const temp = await this.temporary(folder, bytes, guard);
    try { const current = await fs.lstat(folder); live(guard);
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== info.dev || current.ino !== info.ino || !samePath(await fs.realpath(folder), folder)) throw new PluginNetworkSettingsFault("unavailable");
      live(guard); await fs.link(temp.path, file);
    } finally { await this.cleanup(temp.path, temp.stamp); }
  }
  async save(expectedRevision: number, raw: unknown, guard: PluginNetworkSettingsGuard = always): Promise<PluginNetworkSettingsSnapshot> {
    const config = hostConfig(raw);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return Promise.reject(new PluginNetworkSettingsFault("invalid"));
    return this.serial(guard, async () => {
      try {
        const before = await this.read(guard), snapshot = this.publish(before);
        if (snapshot.revision !== expectedRevision) throw new PluginNetworkSettingsFault("conflict");
        if (!before.safe) throw new PluginNetworkSettingsFault("unavailable");
        if (!snapshot.loadError && JSON.stringify(snapshot.config) === JSON.stringify(config)) return snapshot;
        const root = await this.root(true, guard); if (!root) throw Error();
        if (snapshot.loadError && before.bytes) await this.archive(root, before.bytes, guard);
        const revision = snapshot.revision + 1; if (!Number.isSafeInteger(revision) || revision >= Number.MAX_SAFE_INTEGER - 1) throw new PluginNetworkSettingsFault("unavailable");
        const encoded = Buffer.from(JSON.stringify({ schemaVersion: 1, revision, config }), "utf8"); if (encoded.length > MAX_BYTES) throw new PluginNetworkSettingsFault("invalid");
        const temp = await this.temporary(root, encoded, guard);
        try {
          const current = await this.read(guard); live(guard);
          if (!current.safe || current.fingerprint !== before.fingerprint || !!current.stamp !== !!before.stamp
            || current.stamp && before.stamp && !same(current.stamp, before.stamp) || await this.root(false, guard) !== root) {
            this.publish(current); throw new PluginNetworkSettingsFault("conflict");
          }
          live(guard);
          if (before.exists) await fs.rename(temp.path, join(root, PLUGIN_NETWORK_SETTINGS_FILE));
          else await fs.link(temp.path, join(root, PLUGIN_NETWORK_SETTINGS_FILE));
          // Commit is authoritative: later cancellation or best-effort temp
          // cleanup cannot change this success into a claim that nothing saved.
          this.fingerprint = hash(encoded); this.snapshot = Object.freeze({ revision, config }); return this.snapshot;
        } finally { await this.cleanup(temp.path, temp.stamp); }
      } catch (error) { if (error instanceof PluginNetworkSettingsFault) throw error; live(guard); throw new PluginNetworkSettingsFault("unavailable"); }
    });
  }
}
