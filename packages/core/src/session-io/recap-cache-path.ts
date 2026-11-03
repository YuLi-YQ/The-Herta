import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

/** Application-owned recap storage: reject linked directories/files on read, write and task deletion. */
export function guardedRecapCachePath(
  workspaceRoot: string,
  sessionId: string,
  create = false,
): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(sessionId))
    throw new Error("Invalid recap session ID");
  let current = realpathSync(workspaceRoot);
  for (const part of [".herta", "compaction"]) {
    current = join(current, part);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error("Unsafe recap directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (create) mkdirSync(current);
    }
  }
  const file = join(current, `${sessionId}.json`);
  try {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new Error("Unsafe recap file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return file;
}
