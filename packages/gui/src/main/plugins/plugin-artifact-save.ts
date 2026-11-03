import { createHash, randomUUID } from "node:crypto";
import { promises as fs, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { isPathInside } from "@herta/core";
import type { PluginOutputOwner } from "../../shared/plugin-deliverables.js";
import { PluginBrokerFault } from "./capability-broker.js";
import { assertPluginArtifactCurrent, PluginArtifactFault, type PluginArtifactGuard, type PluginArtifactStore } from "./plugin-artifact-store.js";

interface SaveOptions {
  readonly store: Pick<PluginArtifactStore, "read">;
  readonly profile: string;
  readonly protectedPaths: readonly string[];
  readonly choose: (defaultName: string) => Promise<{ canceled: boolean; filePath?: string }>;
}
export interface PluginArtifactSaveReply { readonly saved: boolean; readonly failed?: boolean; readonly conflict?: boolean }
type Handle = Awaited<ReturnType<typeof fs.open>>;
const MAX_EXISTING_BYTES = 16 * 1024 * 1024;
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const samePath = (a: string, b: string) => process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
interface Existing { readonly stamp: Stats; readonly hash: string }

async function inspect(file: string, guard: PluginArtifactGuard): Promise<Existing | null> {
  let before: Stats;
  try { before = await fs.lstat(file); } catch (error) { assertPluginArtifactCurrent(guard); if (missing(error)) return null; throw error; }
  assertPluginArtifactCurrent(guard);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_EXISTING_BYTES) throw new PluginArtifactFault("conflict");
  const handle = await fs.open(file, "r");
  try {
    assertPluginArtifactCurrent(guard);
    const opened = await handle.stat(); assertPluginArtifactCurrent(guard);
    if (!sameFile(before, opened)) throw new PluginArtifactFault("conflict");
    const digest = createHash("sha256"), buffer = Buffer.alloc(64 * 1024); let position = 0;
    while (position <= MAX_EXISTING_BYTES) {
      const part = await handle.read(buffer, 0, buffer.length, position); assertPluginArtifactCurrent(guard);
      if (!part.bytesRead) break; position += part.bytesRead; digest.update(buffer.subarray(0, part.bytesRead));
    }
    const after = await handle.stat(); assertPluginArtifactCurrent(guard);
    const current = await fs.lstat(file); assertPluginArtifactCurrent(guard);
    if (position !== before.size || !sameFile(opened, after) || !sameFile(after, current) || current.isSymbolicLink() || current.nlink !== 1) throw new PluginArtifactFault("conflict");
    return { stamp: current, hash: digest.digest("hex") };
  } finally { await handle.close().catch(() => undefined); }
}
async function checkedDestination(input: string, options: SaveOptions, guard: PluginArtifactGuard): Promise<{ destination: string; originalParent: string; physicalParent: string; parentIdentity: Pick<Stats, "dev" | "ino"> }> {
  if (!isAbsolute(input) || input.length > 4096 || /[\u0000-\u001f]/.test(input)) throw new PluginArtifactFault("invalid");
  const lexical = resolve(input), originalParent = dirname(lexical), physicalParent = await fs.realpath(originalParent); assertPluginArtifactCurrent(guard);
  const parentInfo = await fs.lstat(physicalParent); assertPluginArtifactCurrent(guard);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new PluginArtifactFault("conflict");
  const destination = join(physicalParent, basename(lexical));
  for (const protectedPath of [options.profile, ...options.protectedPaths]) {
    const named = resolve(protectedPath);
    if (isPathInside(named, lexical) || isPathInside(named, destination)) throw new PluginArtifactFault("invalid");
    let actual: string;
    try { actual = await fs.realpath(named); } catch (error) { assertPluginArtifactCurrent(guard); if (missing(error)) continue; throw error; }
    assertPluginArtifactCurrent(guard);
    if (isPathInside(actual, destination)) throw new PluginArtifactFault("invalid");
  }
  return { destination, originalParent, physicalParent, parentIdentity: { dev: parentInfo.dev, ino: parentInfo.ino } };
}
async function unchangedParent(path: { originalParent: string; physicalParent: string; parentIdentity: Pick<Stats, "dev" | "ino"> }, guard: PluginArtifactGuard): Promise<void> {
  const physical = await fs.realpath(path.originalParent); assertPluginArtifactCurrent(guard);
  const info = await fs.lstat(path.physicalParent); assertPluginArtifactCurrent(guard);
  if (!samePath(physical, path.physicalParent) || !info.isDirectory() || info.isSymbolicLink() || info.dev !== path.parentIdentity.dev || info.ino !== path.parentIdentity.ino
    || !samePath(await fs.realpath(path.physicalParent), path.physicalParent)) throw new PluginArtifactFault("conflict");
  assertPluginArtifactCurrent(guard);
}
async function cleanup(file: string, owned: Stats): Promise<void> {
  try {
    const parent = dirname(file), directory = await fs.lstat(parent);
    if (!directory.isDirectory() || directory.isSymbolicLink() || !samePath(await fs.realpath(parent), parent)) return;
    const current = await fs.lstat(file);
    if (current.isFile() && !current.isSymbolicLink() && current.dev === owned.dev && current.ino === owned.ino) await fs.unlink(file);
  } catch { /* An uncertain path is preserved; never delete a replacement owned by another writer. */ }
}

/** Only an explicit user-selected destination leaves the session's artifact library.
 * Atomic replacement keeps the old target on write failure; new targets use no-clobber link.
 * Node has no portable compare-and-swap rename: another OS process can still change an existing
 * target in the narrow interval between the final identity/hash check and atomic rename. */
export function createPluginArtifactSaver(options: SaveOptions) {
  let tail: Promise<unknown> = Promise.resolve();
  return (owner: PluginOutputOwner, id: string, guard: PluginArtifactGuard): Promise<PluginArtifactSaveReply> => {
    const selected: PluginOutputOwner = Object.freeze({ scope: owner?.scope, target: owner?.target });
    const job = tail.then(async (): Promise<PluginArtifactSaveReply> => {
      let temporary: string | undefined, owned: Stats | undefined, complete: Stats | undefined, handle: Handle | undefined;
      try {
        assertPluginArtifactCurrent(guard);
        const stored = await options.store.read(selected, id, guard); assertPluginArtifactCurrent(guard);
        const chosen = await options.choose(stored.artifact.name); assertPluginArtifactCurrent(guard);
        if (chosen.canceled || !chosen.filePath) return { saved: false };
        if (typeof chosen.filePath !== "string") throw new PluginArtifactFault("invalid");
        const path = await checkedDestination(chosen.filePath, options, guard);
        const original = await inspect(path.destination, guard);
        temporary = join(path.physicalParent, `.herta-artifact-${randomUUID()}.tmp`);
        handle = await fs.open(temporary, "wx", 0o600); owned = await handle.stat(); assertPluginArtifactCurrent(guard);
        await handle.writeFile(stored.content, { encoding: "utf8", signal: guard.signal }); assertPluginArtifactCurrent(guard);
        await handle.sync(); assertPluginArtifactCurrent(guard); complete = await handle.stat(); assertPluginArtifactCurrent(guard);
        await handle.close(); handle = undefined;
        await unchangedParent(path, guard);
        const current = await inspect(path.destination, guard);
        if (original ? !current || !sameFile(original.stamp, current.stamp) || original.hash !== current.hash : current !== null) throw new PluginArtifactFault("conflict");
        const staged = await fs.lstat(temporary); assertPluginArtifactCurrent(guard);
        if (!staged.isFile() || staged.isSymbolicLink() || staged.nlink !== 1 || !sameFile(staged, complete) || staged.dev !== owned.dev || staged.ino !== owned.ino) throw new PluginArtifactFault("conflict");
        await unchangedParent(path, guard);
        if (original) { await fs.rename(temporary, path.destination); owned = undefined; }
        else {
          try { await fs.link(temporary, path.destination); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new PluginArtifactFault("conflict"); throw error; }
          // No guard after publication: a cancelled caller must not be told a completed save did not happen.
          try { await fs.unlink(temporary); owned = undefined; }
          catch { /* Published successfully; finally retries only our temporary link. */ }
        }
        return { saved: true };
      } catch (error) {
        if (error instanceof PluginArtifactFault && error.reason === "conflict") return { saved: false, conflict: true };
        if (error instanceof PluginBrokerFault && ["cancelled", "revoked"].includes(error.code)) throw error;
        assertPluginArtifactCurrent(guard); return { saved: false, failed: true };
      } finally {
        await handle?.close().catch(() => undefined);
        if (temporary && owned) await cleanup(temporary, owned);
      }
    });
    tail = job.then(() => undefined, () => undefined); return job;
  };
}
