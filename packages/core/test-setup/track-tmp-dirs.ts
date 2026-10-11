/**
 * Vitest setup file (every project, root `vitest.config.ts`): remove the
 * temp directories a test file makes, when the file is done.
 *
 * Forty-two test files across the packages call `mkdtempSync` under
 * `os.tmpdir()` with a `herta-` prefix, and most never remove the result:
 * 59 263 such directories sat under %TEMP% on 2026-09-18, two days after a
 * per-file cleanup had fixed the two worst offenders (46 684 then). Fixing
 * the pattern one file at a time does not hold — the next test file leaks
 * again — so the leak is closed where every such directory is born.
 *
 * Mechanism: the builtin `fs.mkdtempSync` and `fs.promises.mkdtemp` are
 * wrapped to record every directory they create whose name starts with
 * `herta-` (only those — a fixture's own temp scheme is left alone), and
 * `module.syncBuiltinESMExports()` pushes the wrappers into the ESM
 * bindings, so a test file's `import { mkdtempSync } from "node:fs"` sees
 * the wrapper without any change to the file. An `afterAll` registered here
 * applies to the test file this setup runs for, and removes what that file
 * recorded.
 *
 * Windows: a process's cwd holds its directory, and a session's `close()`
 * does not wait for the children whose cwd is the workspace (the repository
 * probe's `git`, the backend's shell — ADR 0058). `rm({ maxRetries })` alone
 * does not cover that: Node tries `rmdir` first, a busy directory answers
 * EBUSY at once, and the retries never engage (2026-09-16). So the whole
 * remove is retried, then given up silently — a leftover directory is not
 * a test failure. The removes run in parallel, so a file that made dozens
 * of directories (session-service.test.ts makes 33 per run) finishes in
 * one wait, not dozens.
 *
 * The retry window is three seconds, well inside vitest's default hook
 * timeout of ten, and the hook carries its own generous timeout on top:
 * the first full run tripped exactly that — a knowledge test's SQLite
 * handle held its directory, the ten-second retry met the ten-second hook
 * limit, and a suite with every test green was reported failed. A holder
 * that is a child process lets go within a few hundred milliseconds; a
 * holder that is the test process itself (an open database) never lets go
 * before the worker exits, and that directory is the once-per-run sweep's
 * job (`sweep-tmp-dirs.ts`), not this hook's.
 */
import { createRequire } from "node:module";
import { basename } from "node:path";
import { afterAll } from "vitest";

const require = createRequire(import.meta.url);
const fs = require("node:fs") as typeof import("node:fs");
const fsp = require("node:fs/promises") as typeof import("node:fs/promises");
const nodeModule = require("node:module") as typeof import("node:module");

const TRACKED_PREFIX = "herta-";
const created: string[] = [];

function track(dir: string): string {
  if (basename(dir).startsWith(TRACKED_PREFIX)) created.push(dir);
  return dir;
}

const origMkdtempSync = fs.mkdtempSync;
(fs as { mkdtempSync: unknown }).mkdtempSync = function mkdtempSyncTracked(
  this: unknown,
  ...args: Parameters<typeof fs.mkdtempSync>
) {
  const made = origMkdtempSync.apply(this, args);
  return typeof made === "string" ? track(made) : made;
};
const origMkdtemp = fsp.mkdtemp;
(fsp as { mkdtemp: unknown }).mkdtemp = async function mkdtempTracked(
  this: unknown,
  ...args: Parameters<typeof fsp.mkdtemp>
) {
  const made = await origMkdtemp.apply(this, args);
  return typeof made === "string" ? track(made) : made;
};
nodeModule.syncBuiltinESMExports();

const REMOVE_DEADLINE_MS = 3_000;
const HOOK_TIMEOUT_MS = 15_000;

async function removeTmpDir(root: string): Promise<void> {
  const deadline = Date.now() + REMOVE_DEADLINE_MS;
  for (;;) {
    try {
      await origRm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
      return;
    } catch (err) {
      const code = (err as { code?: string }).code;
      const transient =
        code === "EBUSY" || code === "ENOTEMPTY" || code === "EPERM";
      if (!transient || Date.now() > deadline) return;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}
// Captured before any test could mock `node:fs/promises`.
const origRm = fsp.rm;

afterAll(async () => {
  const dirs = created.splice(0);
  await Promise.all(dirs.map(removeTmpDir));
}, HOOK_TIMEOUT_MS);
