import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const LOCK_FILE = "pass.lock";

/** A lock older than this is presumed abandoned even if its pid looks alive
 *  (pid recycling): no healthy pass runs this long. Generous vs. the longest
 *  plausible pass (dozens of max-effort LLM calls). */
const STALE_LOCK_MS = 6 * 60 * 60_000; // 6 h

export interface DreamLock {
  release(): void;
}

interface LockPayload {
  pid?: number;
  at?: string;
}

/** Is the pid a live process? EPERM means "alive but not ours" — still alive. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Cross-process mutual exclusion for the Dream pass (the deferred G4 guard).
 * Without it, a manual `herta knowledge dream` racing the idle trigger can
 * double-reconsolidate the same record and last-writer-wins the manifest,
 * silently dropping the other pass's ledger entries (= lost dedup history).
 *
 * O_EXCL create of `pass.lock` in the dream dir, payload `{pid, at}`. A lock
 * whose holder pid is dead, whose payload is unreadable, or whose timestamp is
 * older than STALE_LOCK_MS is stolen (unlink + one retry). Returns undefined
 * when a live holder owns the lock — the caller should skip the pass.
 *
 * Known residual race: two processes that BOTH observe the same stale lock can
 * both steal it (no atomic compare-and-delete exists). This needs a crashed
 * holder plus two simultaneous starts — strictly rarer than the unguarded race
 * this lock closes.
 */
export function acquireDreamLock(
  dreamDir: string,
  nowMs: number,
): DreamLock | undefined {
  mkdirSync(dreamDir, { recursive: true });
  const path = join(dreamDir, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      try {
        writeFileSync(
          fd,
          JSON.stringify({
            pid: process.pid,
            at: new Date(nowMs).toISOString(),
          }),
        );
      } finally {
        closeSync(fd);
      }
      return {
        release(): void {
          try {
            unlinkSync(path);
          } catch {
            // already gone — releasing twice is fine
          }
        },
      };
    } catch {
      // Lock exists. Steal it only if the holder is provably gone or ancient.
      let holder: LockPayload = {};
      try {
        holder = JSON.parse(readFileSync(path, "utf8")) as LockPayload;
      } catch {
        // unreadable/corrupt payload → treat as abandoned
      }
      const at = Date.parse(holder.at ?? "");
      const ancient = Number.isNaN(at) || nowMs - at > STALE_LOCK_MS;
      const dead = typeof holder.pid !== "number" || !pidAlive(holder.pid);
      if (dead || ancient) {
        try {
          unlinkSync(path);
        } catch {
          // holder released it in the meantime — retry the create either way
        }
        continue;
      }
      return undefined; // live holder — skip this pass
    }
  }
  return undefined;
}
