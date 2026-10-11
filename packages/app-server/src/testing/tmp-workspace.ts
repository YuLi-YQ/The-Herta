import { rm } from "node:fs/promises";

/**
 * Remove a test's temp workspace without ever failing the test in teardown.
 *
 * Windows: a process's cwd holds its directory, and a session's `close()`
 * does not wait for the children whose cwd is the workspace — the
 * repository probe's `git` (fire-and-forget on create and at every turn's
 * end, ADR 0058), the backend's own probe, the ADR 0040 persistent shell
 * after a @板砖 turn. The first `rmdir` then answers EBUSY, and
 * `rm({ maxRetries })` alone does not help: Node retries only after it has
 * emptied the directory, and a busy directory fails before that, files
 * untouched. So the whole remove is retried for up to ~10 s, then given up
 * silently — a leftover dir under %TEMP% is not a test failure. Mirrors
 * packages/tools/src/testing/tmp-workspace.ts.
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
