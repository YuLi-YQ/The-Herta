import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { liveDreamRecords } from "./manifest.js";
import type { DreamManifest } from "./types.js";

const FEIAN_FILE_RE = /^### 废案_\d{2,}：.*\.txt$/;
/** The pre-2026-09-11 temp names (the promotion and notes writers' own). */
const LEGACY_TEMP_PREFIXES = [".dream-tmp-", ".dream-notes-tmp-"];
/** What core's `writeFileAtomicSync` leaves when it dies between write and
 *  rename: `.<target name>.<pid>.<seq>.<rand>.tmp`. The 2026-09-11 refactor
 *  moved the dream's writes onto it and the sweep kept matching only the
 *  old prefixes — dead, while the new orphans piled up (dream review
 *  2026-09-22, finding 19). Only corpus targets (`### 废案` / `### 记录`). */
const ATOMIC_TEMP_RE = /^\.### (废案|记录).*\.tmp$/;
/** An atomic-write temp younger than this may belong to a write in flight —
 *  a seed being materialized by an opening session — and is left alone. */
const ATOMIC_TEMP_MIN_AGE_MS = 10 * 60_000;

export interface ReconcileInput {
  narrativeDir: string;
  /** Mutated in place: phantom live records (file gone) flip to "archived". */
  manifest: DreamManifest;
  /** Pass-time clock for the atomic-temp age check; without it only the
   *  legacy temp names are swept. */
  nowMs?: number;
}

export interface ReconcileResult {
  /** Stale `.dream-tmp-*` / `.dream-notes-tmp-*` files removed (interrupted
   *  promotion / notes writes). */
  sweptTemp: number;
  /** Live records whose 废案 file has vanished, flipped to "archived". */
  prunedPhantom: number;
}

/**
 * Reconcile on-disk state with the manifest before a pass runs the cap + dedup.
 * This is crash-recovery, NOT generation:
 *  - sweep stale `.dream-tmp-*` / `.dream-notes-tmp-*` files left by a
 *    promotion or notes write killed mid-write;
 *  - prune phantom live records whose 废案 file has vanished (deleted
 *    out-of-band, or a cap-eviction killed between the file move and the
 *    manifest flush) so the cap stops counting them and never tries to archive
 *    a missing file.
 *
 * It deliberately does NOT adopt untracked `### 废案` files into the ledger: a
 * 废案 file absent from the manifest is indistinguishable from a hand-authored
 * seed, and claiming a user-owned seed as dream-created would expose it to
 * cap-eviction — a violation of the never-touch-user-owned guard (D7). Because
 * the pass now flushes the manifest after every episode, a promotion is tracked
 * the instant it lands; the only untracked promotion is one killed in the
 * microsecond between the file rename and that flush, which is then left live
 * and unmanaged, exactly like a seed (safe, never re-promoted to a live dup
 * thanks to the title/similarity gates).
 */
export function reconcileDreamState(input: ReconcileInput): ReconcileResult {
  const res: ReconcileResult = { sweptTemp: 0, prunedPhantom: 0 };

  let entries: string[];
  try {
    entries = readdirSync(input.narrativeDir);
  } catch {
    return res; // no narrative dir yet → nothing to reconcile
  }

  // 1. Sweep stale temp files from interrupted promotions. They are ignored by
  //    the live loader (don't start with `### 废案`) but accumulate otherwise.
  //    Single active pass per workspace is now enforced by the cross-process
  //    lockfile (`acquireDreamLock`, the formerly-deferred G4 guard), on top of
  //    the app's interval-gated, re-entrancy-guarded idle trigger — so any temp
  //    file seen here is from a crashed pass, never a live concurrent one.
  for (const name of entries) {
    const legacy = LEGACY_TEMP_PREFIXES.some((p) => name.startsWith(p));
    if (!legacy && !isStaleAtomicTemp(input, name)) continue;
    try {
      unlinkSync(join(input.narrativeDir, name));
      res.sweptTemp++;
    } catch {
      // already gone / locked — ignore
    }
  }

  // 2. Prune phantom live records: the manifest says live but the file is gone.
  const filesOnDisk = new Set(entries.filter((n) => FEIAN_FILE_RE.test(n)));
  for (const rec of liveDreamRecords(input.manifest)) {
    if (filesOnDisk.has(rec.file)) continue;
    const idx = input.manifest.created.indexOf(rec);
    if (idx !== -1) {
      input.manifest.created.splice(idx, 1, { ...rec, state: "archived" });
      res.prunedPhantom++;
    }
  }

  return res;
}

function isStaleAtomicTemp(input: ReconcileInput, name: string): boolean {
  if (input.nowMs === undefined || !ATOMIC_TEMP_RE.test(name)) return false;
  try {
    const age = input.nowMs - statSync(join(input.narrativeDir, name)).mtimeMs;
    return age > ATOMIC_TEMP_MIN_AGE_MS;
  } catch {
    return false;
  }
}
