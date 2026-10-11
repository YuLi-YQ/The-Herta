import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface TmpWorkspaceFiles {
  [relPath: string]: string | Uint8Array;
}

export interface TmpWorkspace {
  root: string;
  cleanup: () => Promise<void>;
}

/**
 * Remove a temp dir without ever failing a test in teardown. Windows: a
 * just-killed child (the ADR 0040 persistent shell, a background command)
 * can hold its cwd handle for a while after its exit event — `rmdir`
 * reports EBUSY. Retry for up to ~10 s, then give up silently: a leftover
 * dir under %TEMP% is not a test failure.
 */
export async function removeTmpDir(root: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
      return;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (
        (code !== "EBUSY" && code !== "ENOTEMPTY" && code !== "EPERM") ||
        Date.now() > deadline
      ) {
        return;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

export async function mkTmpWorkspace(
  files: TmpWorkspaceFiles,
): Promise<TmpWorkspace> {
  const raw = await mkdtemp(join(tmpdir(), "herta-tools-"));
  const root = await realpath(raw);

  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }

  const cleanup = async () => {
    await removeTmpDir(root);
  };

  return { root, cleanup };
}
