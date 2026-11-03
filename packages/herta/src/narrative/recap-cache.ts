import { lstatSync, readFileSync, unlinkSync } from "node:fs";
import { guardedRecapCachePath, writeFileAtomicSync } from "@herta/core";
import type { RecapCache } from "./session-recap.js";

const MAX_RECAP_BYTES = 2 * 1024 * 1024;

/** The sidecar path, from core — `deleteSessionFiles` removes this same file
 *  when a session is deleted (audit BL8), so the two must not drift. */
const cacheFile = guardedRecapCachePath;

export function readRecapCache(
  workspaceRoot: string,
  sessionId: string,
): RecapCache | null {
  try {
    const file = cacheFile(workspaceRoot, sessionId);
    if (lstatSync(file).size > MAX_RECAP_BYTES) return null;
    const raw = readFileSync(file, "utf8");
    const p = JSON.parse(raw) as RecapCache;
    if (
      !Number.isSafeInteger(p.boundaryIndex) ||
      p.boundaryIndex <= 0 ||
      typeof p.recapText !== "string"
    ) {
      return null;
    }
    return {
      boundaryIndex: p.boundaryIndex,
      recapText: p.recapText,
      ...(typeof p.generatedAt === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(p.generatedAt) &&
      Number.isFinite(Date.parse(p.generatedAt))
        ? { generatedAt: p.generatedAt }
        : {}),
      // Legacy sidecars (pre-lang schema, wrote a dead `model` field) read
      // as "zh": every cache written before the field existed came from a
      // zh session. The runtime discards a lang-mismatched cache on read.
      lang: p.lang === "en" ? "en" : "zh",
      advancesSinceRederive:
        typeof p.advancesSinceRederive === "number"
          ? p.advancesSinceRederive
          : 0,
    };
  } catch {
    return null;
  }
}

/** Remove a session's recap sidecar (missing file is a no-op). Called on
 *  rewind when the truncated record no longer validates the cached
 *  boundary — validate-on-first-use would discard it anyway, but deleting
 *  keeps a knowably-stale file from outliving the record state it
 *  described. */
export function deleteRecapCache(
  workspaceRoot: string,
  sessionId: string,
): void {
  try {
    unlinkSync(cacheFile(workspaceRoot, sessionId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function writeRecapCache(
  workspaceRoot: string,
  sessionId: string,
  cache: RecapCache,
): void {
  const serialized = `${JSON.stringify(cache, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_RECAP_BYTES)
    throw new Error("Recap cache exceeds its storage limit");
  // fsync'd: the cache must survive a power loss intact or not at all — a
  // renamed-but-empty file would read as "no cache" and cost a re-derive.
  writeFileAtomicSync(cacheFile(workspaceRoot, sessionId, true), serialized, {
    fsync: true,
  });
}
