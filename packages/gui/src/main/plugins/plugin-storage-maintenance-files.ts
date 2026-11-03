import fsSync, { promises as fs, type BigIntStats } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, resolve } from "node:path";
import { parseExecutablePluginPackage, EXECUTABLE_PLUGIN_LIMITS } from "../../shared/executable-plugins.js";
import type { PluginMaintenanceCategory } from "../../shared/plugin-maintenance.js";
import type { PluginStorageGuard } from "./plugin-storage-coordinator.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ARCHIVE = new RegExp("^damaged-" + UUID + "$", "i");
const DAMAGED_INDEX = new RegExp("^index\\.json\\.damaged-[0-9]+-" + UUID + "$", "i");
const TEMP = new RegExp("^(?:index\\.json(?:\\.backup)?\\.tmp-|index\\.json\\.recovery-)" + UUID + "$", "i");
const LINK_DESCRIPTION = /^isolated-blobs-link-[a-f0-9]{64}\.json$/;
const LINK_TEMP = new RegExp("^\\.isolated-blobs-link-[a-f0-9]{64}\\." + UUID + "\\.tmp$", "i");
const BLOB = /^([a-f0-9]{64})\.json$/;
const INDEX_LIMIT = 16 * 1024 * 1024;
const FILE_LIMIT = 64 * 1024 * 1024;
const HASH_LIMIT = 1024 * 1024 * 1024;
const ENTRY_LIMIT = 20000;
const norm = (path: string) => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function live(guard: PluginStorageGuard): void { if (guard.signal.aborted) throw new PluginMaintenanceFault("cancelled"); guard.assertCurrent(); }
const MESSAGES = {
  changed: "资料或安装预览已变化，请重新检查；本次尚未开始删除。",
  unavailable: "无法完整核验这些安装资料，未开始删除。",
  invalid: "清理选择不符合当前预览。",
  cancelled: "清理已取消，未开始删除。",
  busy: "还有插件操作未结束，请结束后重试。",
} as const;
export class PluginMaintenanceFault extends Error {
  constructor(readonly reason: keyof typeof MESSAGES) { super(MESSAGES[reason]); this.name = "PluginMaintenanceFault"; }
}
export interface MaintenanceNode {
  readonly name: string;
  readonly kind: "file" | "directory" | "link";
  readonly stamp: BigIntStats;
  readonly digest: string;
  readonly target?: string;
  readonly text?: string;
  readonly children?: readonly MaintenanceNode[];
}
export interface MaintenanceCandidate {
  readonly name: string;
  readonly category: PluginMaintenanceCategory;
  readonly node: MaintenanceNode;
  readonly hash?: string;
  readonly damaged?: boolean;
  readonly bytes: number;
  readonly fileCount: number;
  readonly linkCount: number;
}
export interface MaintenanceReference { readonly name: string; readonly text?: string; readonly missing?: boolean; readonly unavailable?: boolean }
export interface MaintenanceInspection {
  readonly root: string;
  readonly folder?: MaintenanceNode;
  readonly fingerprint: string;
  readonly candidates: readonly MaintenanceCandidate[];
  readonly references: readonly MaintenanceReference[];
  readonly warnings: readonly string[];
  readonly referencesSafe: boolean;
}
export function maintenanceSameIdentity(a: BigIntStats, b: BigIntStats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return maintenanceSameIdentity(a, b) && a.size === b.size && a.nlink === b.nlink && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function stampText(s: BigIntStats): string { return [s.dev, s.ino, s.size, s.nlink, s.mtimeNs, s.ctimeNs].join(":"); }
function childFingerprint(node: MaintenanceNode): string { return node.name + "=" + node.kind + ":" + stampText(node.stamp) + ":" + node.digest; }
function count(node: MaintenanceNode): { bytes: number; fileCount: number; linkCount: number } {
  if (node.kind === "link") return { bytes: 0, fileCount: 0, linkCount: 1 };
  if (node.kind === "file") return { bytes: Number(node.stamp.size), fileCount: 1, linkCount: 0 };
  return (node.children ?? []).reduce((sum, child) => { const n = count(child); return { bytes: sum.bytes + n.bytes, fileCount: sum.fileCount + n.fileCount, linkCount: sum.linkCount + n.linkCount }; },
    { bytes: 0, fileCount: 0, linkCount: 0 });
}
/** Fixed namespace inspection only. Links are bound as entries, never traversed. */
export async function inspectMaintenanceFiles(root: string, guard: PluginStorageGuard): Promise<MaintenanceInspection> {
  const folder = join(root, "plugins-v2"), warnings = new Set<string>(), references: MaintenanceReference[] = [];
  const candidates: MaintenanceCandidate[] = [];
  let entries = 0, hashBytes = 0, retainedTextBytes = 0, referencesSafe = true;
  const hardlinks = new Map<string, MaintenanceNode[]>();
  const scan = async (path: string, name: string, depth: number): Promise<MaintenanceNode> => {
    live(guard);
    if (++entries > ENTRY_LIMIT || depth > 8) throw new PluginMaintenanceFault("unavailable");
    const before = await fs.lstat(path, { bigint: true }); live(guard);
    if (before.isSymbolicLink()) {
      const target = await fs.readlink(path); live(guard);
      if (target.length > 32768 || !sameFile(before, await fs.lstat(path, { bigint: true }))) throw new PluginMaintenanceFault("changed");
      return { name, kind: "link", stamp: before, target, digest: sha("link:" + stampText(before) + ":" + target) };
    }
    if (norm(await fs.realpath(path)) !== norm(path)) throw new PluginMaintenanceFault("changed");
    if (before.isDirectory()) {
      const names = (await fs.readdir(path)).sort(), children: MaintenanceNode[] = [];
      for (const child of names) children.push(await scan(join(path, child), name ? name + "/" + child : child, depth + 1));
      const after = await fs.lstat(path, { bigint: true }); live(guard);
      if (!sameFile(before, after)) throw new PluginMaintenanceFault("changed");
      return { name, kind: "directory", stamp: after, children, digest: sha("dir:" + stampText(after) + ":" + children.map(childFingerprint).join("\n")) };
    }
    if (!before.isFile() || before.size < 0n || before.size > BigInt(Number.MAX_SAFE_INTEGER) || before.nlink < 1n) throw new PluginMaintenanceFault("unavailable");
    const node: MaintenanceNode = { name, kind: "file", stamp: before, digest: sha("unread:" + stampText(before)) };
    if (before.nlink > 1n) { const key = before.dev + ":" + before.ino; const group = hardlinks.get(key) ?? []; group.push(node); hardlinks.set(key, group); }
    return node;
  };
  try { await fs.lstat(folder); }
  catch (error) { if (missing(error)) return { root, fingerprint: "missing", candidates: [], references: [], warnings: [], referencesSafe: true }; throw error; }
  let tree: MaintenanceNode;
  try { tree = await scan(folder, "", 0); }
  catch (error) { if (missing(error)) throw new PluginMaintenanceFault("changed"); throw error; }
  if (tree.kind !== "directory") throw new PluginMaintenanceFault("unavailable");
  const unsafeLinks = new Set<string>();
  for (const group of hardlinks.values()) {
    if (BigInt(group.length) !== group[0]!.stamp.nlink || group.some(node => !sameFile(node.stamp, group[0]!.stamp))) {
      group.forEach(node => unsafeLinks.add(node.name));
      warnings.add("部分文件存在无法确认的硬链接，已保留相关资料。");
    }
  }
  // Enumerate every hard-link name before opening any ordinary file. A link to
  // an outside object is preserved without reading its body merely to hash it.
  const hydrate = async (node: MaintenanceNode): Promise<MaintenanceNode> => {
    const path = join(folder, ...node.name.split("/")); live(guard);
    if (node.kind === "link") return node;
    if (node.kind === "directory") {
      const children: MaintenanceNode[] = [];
      for (const child of node.children ?? []) children.push(await hydrate(child));
      if (!sameFile(node.stamp, await fs.lstat(path, { bigint: true })) || norm(await fs.realpath(path)) !== norm(path)) throw new PluginMaintenanceFault("changed");
      return { ...node, children, digest: sha("dir:" + stampText(node.stamp) + ":" + children.map(childFingerprint).join("\n")) };
    }
    if (unsafeLinks.has(node.name)) return node;
    if (node.stamp.size > BigInt(FILE_LIMIT) || hashBytes + Number(node.stamp.size) > HASH_LIMIT) {
      unsafeLinks.add(node.name); warnings.add("部分资料超出本次完整核验范围，已保留相关确认项。"); return node;
    }
    hashBytes += Number(node.stamp.size);
    if (norm(await fs.realpath(path)) !== norm(path)) throw new PluginMaintenanceFault("changed");
    const shouldRetain = (/(?:^|\/)index\.json(?:\.backup|\.damaged-.*)?$/.test(node.name) && node.stamp.size <= BigInt(INDEX_LIMIT)
      || /^blobs\/[a-f0-9]{64}\.json$/.test(node.name) && node.stamp.size <= BigInt(EXECUTABLE_PLUGIN_LIMITS.jsonBytes))
      && retainedTextBytes + Number(node.stamp.size) <= 32 * 1024 * 1024;
    if (shouldRetain) retainedTextBytes += Number(node.stamp.size);
    const handle = await fs.open(path, "r"), chunks: Buffer[] = [], digest = createHash("sha256"); let length = 0;
    try {
      const opened = await handle.stat({ bigint: true }); live(guard);
      if (!sameFile(node.stamp, opened)) throw new PluginMaintenanceFault("changed");
      for (;;) {
        const buffer = Buffer.alloc(65536), read = await handle.read(buffer, 0, buffer.length, length); live(guard);
        if (!read.bytesRead) break;
        length += read.bytesRead; if (length > Number(node.stamp.size)) throw new PluginMaintenanceFault("changed");
        const part = buffer.subarray(0, read.bytesRead); digest.update(part); if (shouldRetain) chunks.push(part);
      }
      const after = await handle.stat({ bigint: true }), linked = await fs.lstat(path, { bigint: true }); live(guard);
      if (length !== Number(node.stamp.size) || !sameFile(opened, after) || !sameFile(after, linked)
        || norm(await fs.realpath(path)) !== norm(path)) throw new PluginMaintenanceFault("changed");
      let text: string | undefined;
      if (shouldRetain) { try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)); } catch { /* Invalid UTF8 is unavailable reference data. */ } }
      return { ...node, digest: digest.digest("hex"), ...(text !== undefined ? { text } : {}) };
    } finally { await handle.close(); }
  };
  tree = await hydrate(tree);
  const unsafeTree = (node: MaintenanceNode): boolean => unsafeLinks.has(node.name) || (node.children ?? []).some(unsafeTree);
  const addReference = (node: MaintenanceNode | undefined, name: string) => {
    references.push(!node ? { name, missing: true } : node.kind !== "file" || unsafeTree(node) || node.text === undefined
      ? { name, unavailable: true } : { name, text: node.text });
  };
  const top = tree.children ?? [];
  addReference(top.find(node => node.name === "index.json"), "index.json");
  addReference(top.find(node => node.name === "index.json.backup"), "index.json.backup");
  const addCandidate = (node: MaintenanceNode, category: PluginMaintenanceCategory, extra: { hash?: string; damaged?: boolean } = {}) => {
    if (unsafeTree(node)) return;
    candidates.push({ name: node.name, node, category, ...count(node), ...extra });
  };
  const archiveReferences = (node: MaintenanceNode) => {
    if (node.kind === "link") { referencesSafe = false; return; }
    const children = node.children ?? [];
    if (children.some(child => child.name.endsWith("/blobs"))
      && !children.some(child => child.name.endsWith("/index.json") || child.name.endsWith("/index.json.backup"))) referencesSafe = false;
    for (const child of children) {
      const name = child.name.slice(node.name.length + 1);
      if (name === "index.json" || name === "index.json.backup" || DAMAGED_INDEX.test(name)) addReference(child, child.name);
      else if (name === "blobs") {
        if (child.kind !== "directory" || (child.children ?? []).some(blob => blob.kind !== "file" || !BLOB.test(blob.name.slice(child.name.length + 1)))) referencesSafe = false;
      }
      else if (ARCHIVE.test(name)) archiveReferences(child);
      else if (!LINK_DESCRIPTION.test(name) && !TEMP.test(name) && !LINK_TEMP.test(name)) referencesSafe = false;
    }
  };
  for (const node of top) {
    if (node.name === "index.json" || node.name === "index.json.backup") continue;
    if (node.name === "blobs") {
      if (node.kind !== "directory") { referencesSafe = false; warnings.add("当前安装包目录无法完整核对；仅可确认删除独立旧资料，链接目标不会读取。"); continue; }
      for (const blob of node.children ?? []) {
        const match = BLOB.exec(blob.name.slice(6));
        if (!match || blob.kind !== "file") { referencesSafe = false; warnings.add("安装包目录含未知或链接条目，相关条目已保留。"); continue; }
        let damaged = true;
        if (blob.text !== undefined && blob.digest === match[1]) {
          try { damaged = JSON.stringify(parseExecutablePluginPackage(blob.text)) !== blob.text; } catch { /* Keep damaged marker. */ }
        }
        addCandidate(blob, "blob", { hash: match[1]!, damaged });
      }
    } else if (TEMP.test(node.name) || LINK_TEMP.test(node.name)) {
      if (node.kind === "file") addCandidate(node, "temporary"); else warnings.add("安装临时条目类型异常，已保留。");
    } else if (ARCHIVE.test(node.name)) {
      if (node.kind !== "directory") { referencesSafe = false; warnings.add("旧归档入口类型异常，已保留。"); continue; }
      archiveReferences(node); addCandidate(node, "archive");
    } else if (DAMAGED_INDEX.test(node.name)) {
      addReference(node, node.name); if (node.kind === "file") addCandidate(node, "archive");
    } else if (LINK_DESCRIPTION.test(node.name)) {
      if (node.kind === "file") addCandidate(node, "archive"); else warnings.add("链接描述记录类型异常，已保留。");
    } else { referencesSafe = false; warnings.add("存在未识别安装资料，已保留；无法确认全部安装包引用。"); }
  }
  return { root, folder: tree, fingerprint: tree.digest, candidates, references, warnings: [...warnings], referencesSafe };
}
/** Checks one frozen node without following links. Called again immediately before deletion. */
export function assertMaintenanceNode(root: string, node: MaintenanceNode, directoryContents = true, removedLinks = 0): void {
  const path = join(root, "plugins-v2", ...node.name.split("/")), current = fsSync.lstatSync(path, { bigint: true });
  if (node.kind === "link") {
    if (!current.isSymbolicLink() || !sameFile(current, node.stamp) || fsSync.readlinkSync(path) !== node.target) throw new PluginMaintenanceFault("changed");
    return;
  }
  if (norm(fsSync.realpathSync(path)) !== norm(path) || current.isSymbolicLink() || !maintenanceSameIdentity(current, node.stamp)) throw new PluginMaintenanceFault("changed");
  if (node.kind === "directory") {
    if (!current.isDirectory()) throw new PluginMaintenanceFault("changed");
    if (directoryContents) {
      const names = fsSync.readdirSync(path).sort(), expected = (node.children ?? []).map(child => child.name.slice(node.name.length ? node.name.length + 1 : 0)).sort();
      if (JSON.stringify(names) !== JSON.stringify(expected)) throw new PluginMaintenanceFault("changed");
    }
  } else {
    const unchanged = removedLinks === 0 ? sameFile(current, node.stamp)
      : maintenanceSameIdentity(current, node.stamp) && current.size === node.stamp.size
        && current.mtimeNs === node.stamp.mtimeNs && current.nlink === node.stamp.nlink - BigInt(removedLinks);
    if (!current.isFile() || !unchanged) throw new PluginMaintenanceFault("changed");
    // The full content hash was checked in the immediately preceding complete scan.
  }
}
export function compactMaintenanceInspection(input: MaintenanceInspection): MaintenanceInspection {
  const nodes = new Map<string, MaintenanceNode>();
  const compact = (node: MaintenanceNode): MaintenanceNode => {
    const { text: _text, children, ...rest } = node;
    const result = { ...rest, ...(children ? { children: children.map(compact) } : {}) };
    nodes.set(node.name, result); return result;
  };
  const folder = input.folder ? compact(input.folder) : undefined;
  return { ...input, folder, references: [], candidates: input.candidates.map(item => ({ ...item, node: nodes.get(item.name)! })) };
}
export function maintenancePath(root: string, node: MaintenanceNode): string {
  const path = join(root, "plugins-v2", ...node.name.split("/"));
  if (relative(join(root, "plugins-v2"), path).startsWith("..") || node.name === "") throw new PluginMaintenanceFault("invalid");
  return path;
}
export function assertMaintenanceAncestors(root: string, tree: MaintenanceNode, node: MaintenanceNode): void {
  assertMaintenanceNode(root, tree, false);
  const parts = node.name.split("/"); let at = tree;
  for (const name of parts.slice(0, -1)) {
    const next = at.children?.find(child => child.name === (at.name ? at.name + "/" : "") + name);
    if (!next || next.kind !== "directory") throw new PluginMaintenanceFault("changed");
    assertMaintenanceNode(root, next, false); at = next;
  }
}
