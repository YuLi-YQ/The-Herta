/**
 * Vitest global setup (root `vitest.config.ts`, once per run): remove the
 * `herta-*` directories under `os.tmpdir()` that earlier runs left behind.
 *
 * `track-tmp-dirs.ts` removes what a test file makes when the file is done,
 * but it cannot remove a directory the test process itself still holds — a
 * knowledge test's open SQLite database, say — because that handle is only
 * released when the worker exits. Those few survive every per-file hook and
 * would pile up run after run (3 752 `herta-knowledge-*` directories had by
 * 2026-09-18). By the NEXT run their holders are long gone, so this sweep
 * takes anything older than an hour and leaves the current run's own
 * directories alone. Errors are ignored: a directory that still cannot be
 * removed is tomorrow's sweep's problem, never this run's failure.
 */
import { readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STALE_MS = 60 * 60 * 1_000;
const PREFIX = "herta-";

export default function sweepTmpDirs(): void {
  const root = tmpdir();
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_MS;
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(PREFIX)) continue;
    const full = join(root, name);
    try {
      const st = statSync(full);
      if (!st.isDirectory() || st.mtimeMs > cutoff) continue;
      rmSync(full, { recursive: true, force: true, maxRetries: 2 });
      removed += 1;
    } catch {
      // Held or vanished; the next run tries again.
    }
  }
  if (removed > 0) {
    console.log(`[test-setup] swept ${removed} stale herta-* temp dir(s)`);
  }
}
