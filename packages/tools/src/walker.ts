import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, relative as relativePath, sep } from "node:path";

export const SKIP_DIR_NAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".herta",
  ".claude",
  "coverage",
]);

export interface WalkEntry {
  path: string;
  type: "file" | "dir";
}

export interface WalkOptions {
  recursive?: boolean;
  maxEntries?: number;
  onSkipped?: (name: string) => void;
  /** Interrupt support (audit M4, 2026-07-09): the walk checks this per
   *  directory and per entry, throwing the signal's reason (an AbortError)
   *  so a Ctrl-C lands within one entry instead of after the whole tree.
   *  Callers must let the throw propagate — the turn loop classifies it as
   *  `interrupted` (not `tool_failed`). */
  signal?: AbortSignal;
}

export async function* walkDir(
  workspaceRoot: string,
  startDir: string,
  opts: WalkOptions = {},
): AsyncGenerator<WalkEntry> {
  const recursive = opts.recursive ?? false;
  const max = opts.maxEntries ?? Number.POSITIVE_INFINITY;
  const reportSkipped = opts.onSkipped;
  const signal = opts.signal;
  const skippedSeen = new Set<string>();

  let yielded = 0;

  async function* visit(dir: string): AsyncGenerator<WalkEntry> {
    if (yielded >= max) return;
    signal?.throwIfAborted();

    let dirents: Dirent[];
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const dirent of dirents) {
      if (yielded >= max) return;
      signal?.throwIfAborted();

      const name = dirent.name;
      const abs = join(dir, name);

      if (dirent.isDirectory() && SKIP_DIR_NAMES.has(name)) {
        if (!skippedSeen.has(name)) {
          skippedSeen.add(name);
          reportSkipped?.(name);
        }
        continue;
      }

      let type: "file" | "dir";
      let isSymlink = false;
      if (dirent.isSymbolicLink()) {
        isSymlink = true;
        try {
          const s = await stat(abs);
          type = s.isDirectory() ? "dir" : "file";
        } catch {
          type = "file";
        }
      } else if (dirent.isDirectory()) {
        type = "dir";
      } else {
        type = "file";
      }

      const rel = relativePath(workspaceRoot, abs).split(sep).join("/");
      yield { path: rel, type };
      yielded++;
      if (yielded >= max) return;

      if (recursive && type === "dir" && !isSymlink) {
        yield* visit(abs);
      }
    }
  }

  yield* visit(startDir);
}
