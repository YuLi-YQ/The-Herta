import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomicSync } from "@herta/core";
import { computeStrength } from "./retention.js";
import type {
  DreamConfig,
  DreamCreatedRecord,
  DreamManifest,
} from "./types.js";

const FILE = "manifest.json";

export function emptyManifest(): DreamManifest {
  return { version: 1, episodes: [], created: [] };
}

/** Back-fill fields added after a record may have been written: `sourceEpisodes`
 *  (was singular `sourceEpisodeHash`) and `reactivationCount` (dormant until
 *  slice 2). Defensive read, matching the `episodes ?? []` pattern — no
 *  destructive migration.
 *
 *  The one field it drops is `estimatedPrefixTokens`, removed 2026-09-23
 *  (ADR 0069 §12). Despite the name it held the page's CHAR count, and
 *  nothing ever read it. Every write re-spreads a loaded record, so a
 *  record written before then would carry that number in the file forever
 *  under a name that says tokens; dropped here, the next write sheds it. */
function normalizeCreated(
  r: DreamCreatedRecord & { readonly estimatedPrefixTokens?: unknown },
): DreamCreatedRecord {
  const { estimatedPrefixTokens: _chars, ...rest } = r;
  const sourceEpisodes =
    Array.isArray(rest.sourceEpisodes) && rest.sourceEpisodes.length > 0
      ? rest.sourceEpisodes
      : [rest.sourceEpisodeHash];
  return {
    ...rest,
    sourceEpisodes,
    reactivationCount:
      typeof rest.reactivationCount === "number" ? rest.reactivationCount : 0,
  };
}

/** A manifest read that says what went wrong instead of guessing. */
export type ManifestRead =
  | { readonly ok: true; readonly manifest: DreamManifest }
  | { readonly ok: false; readonly reason: string };

/**
 * Read the manifest, telling a FRESH corpus (no file — an empty ledger)
 * from a BROKEN one. A corrupt manifest used to become an empty one with no
 * warning and no copy: dedup, provenance, retention state and the cadence
 * anchor vanished, the next pass re-dreamed everything as new, and the old
 * 废案 files stayed forever as untracked "seeds" (dream review 2026-09-22,
 * finding 8). Now an unparseable file is copied aside once
 * (`manifest.corrupt-<hash>.json`) and reported; an unreadable one (a lock)
 * is reported and left alone. The pass refuses to run on either; the
 * lenient `readManifest` below still answers empty for the readers that
 * only need a best guess.
 */
export function readManifestStrict(dreamDir: string): ManifestRead {
  let raw: string;
  try {
    raw = readFileSync(join(dreamDir, FILE), "utf8");
  } catch (err) {
    const code = (err as { code?: string }).code ?? "unknown";
    if (code === "ENOENT") return { ok: true, manifest: emptyManifest() };
    return { ok: false, reason: `manifest unreadable: ${code}` };
  }
  const manifest = parseManifest(raw);
  if (manifest === null) {
    const backup = backUpCorrupt(dreamDir, raw);
    console.warn(
      `[herta] dream manifest in ${dreamDir} is corrupt; ${
        backup === null
          ? "the copy could not be written"
          : `copied to ${backup}`
      }. Dream passes stop until it is repaired or removed.`,
    );
    return { ok: false, reason: "manifest corrupt" };
  }
  return { ok: true, manifest };
}

/** The manifest in `raw`, or null when it is not one. */
function parseManifest(raw: string): DreamManifest | null {
  let parsed: Partial<DreamManifest> | null;
  try {
    parsed = JSON.parse(raw) as Partial<DreamManifest> | null;
  } catch {
    return null;
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    (parsed.episodes !== undefined && !Array.isArray(parsed.episodes)) ||
    (parsed.created !== undefined && !Array.isArray(parsed.created))
  ) {
    return null;
  }
  return {
    version: 1,
    episodes: parsed.episodes ?? [],
    created: (parsed.created ?? []).map(normalizeCreated),
    ...(parsed.lastRunAt !== undefined ? { lastRunAt: parsed.lastRunAt } : {}),
    ...(Array.isArray(parsed.pendingFold) && parsed.pendingFold.length > 0
      ? { pendingFold: parsed.pendingFold }
      : {}),
    ...(typeof parsed.segmentationV2Since === "string"
      ? { segmentationV2Since: parsed.segmentationV2Since }
      : {}),
  };
}

/** The segmenter option that agrees with this manifest's ledger:
 *  segmentation v2 applies from the cutover the manifest recorded, and not
 *  at all when it recorded none (ADR 0069 §4 and §7). */
export function segmentationV2SinceMs(m: DreamManifest): number | undefined {
  if (m.segmentationV2Since === undefined) return undefined;
  const t = Date.parse(m.segmentationV2Since);
  return Number.isNaN(t) ? undefined : t;
}

/** One copy per distinct corrupt content, beside the manifest. Null when
 *  it could not be written. */
function backUpCorrupt(dreamDir: string, raw: string): string | null {
  const tag = createHash("sha256").update(raw).digest("hex").slice(0, 8);
  const name = `manifest.corrupt-${tag}.json`;
  try {
    const path = join(dreamDir, name);
    if (!existsSync(path)) writeFileSync(path, raw, "utf8");
    return name;
  } catch {
    return null;
  }
}

/** The manifest, or an empty ledger when it is absent OR broken — silently,
 *  for the readers that only need a best guess (the reopen filter, the
 *  cadence anchor, listings). The pass uses `readManifestStrict`. */
export function readManifest(dreamDir: string): DreamManifest {
  try {
    return (
      parseManifest(readFileSync(join(dreamDir, FILE), "utf8")) ??
      emptyManifest()
    );
  } catch {
    return emptyManifest();
  }
}

/** Ms-epoch of the last completed pass (`lastRunAt`), or null when the pipeline
 *  has never finished or the stored value is unparseable. This is the durable
 *  anchor for the Dream cadence floor — it advances at the end of every pass. */
export function lastFullPassAtMs(m: DreamManifest): number | null {
  if (m.lastRunAt === undefined) return null;
  const t = Date.parse(m.lastRunAt);
  return Number.isNaN(t) ? null : t;
}

export function writeManifest(dreamDir: string, m: DreamManifest): void {
  mkdirSync(dreamDir, { recursive: true });
  // Durable atomic replace (core's helper, fsync on): the new manifest's
  // data is durable BEFORE the rename publishes it, so even a true power-off
  // can only leave the prior manifest or the new one fully intact — never a
  // renamed-but-empty file that readManifest would reset to an empty ledger
  // (losing all dedup history, provenance, and the cadence anchor). fsync is
  // best-effort inside the helper: if the platform/FS rejects it, rename-only
  // atomicity remains (still safe against process-kill, the dominant crash
  // mode for this detached pass).
  writeFileAtomicSync(join(dreamDir, FILE), `${JSON.stringify(m, null, 2)}\n`, {
    fsync: true,
  });
}

/** Linear scan of the episode ledger. Fine for a one-off query; `runDreamPass`
 *  builds a Set instead, because calling this once per candidate episode over
 *  a manifest that only ever grows was quadratic (audit BL10). */
export function isEpisodeDreamed(
  m: DreamManifest,
  sessionId: string,
  episodeHash: string,
): boolean {
  return m.episodes.some(
    (e) => e.sessionId === sessionId && e.episodeHash === episodeHash,
  );
}

export function liveDreamRecords(m: DreamManifest): DreamCreatedRecord[] {
  return m.created.filter((r) => r.state === "live");
}

/** Reinforce a live record in place (immutably): bump its reactivationCount and
 *  reset its decay clock. Repetition strengthens (consolidation, §6) without
 *  rewriting the text.
 *
 *  Spacing guard (ADR 0022): when `spacingMs` > 0 and the record was last
 *  reactivated (or born) within that window of `atIso`, the reinforcement is
 *  a retention NO-OP — massed repetition (five retellings in one afternoon)
 *  must not multiply strength or keep resetting the forgetting curve. The
 *  caller learns it was spaced via `spaced` (ledger transparency).
 *
 *  Returns undefined if the id is not found. */
export function reinforceRecord(
  m: DreamManifest,
  id: string,
  atIso: string,
  spacingMs = 0,
): { record: DreamCreatedRecord; spaced: boolean } | undefined {
  const idx = m.created.findIndex((r) => r.id === id);
  if (idx === -1) return undefined;
  const prev = m.created[idx];
  if (prev === undefined) return undefined;
  if (spacingMs > 0) {
    const anchorMs = Date.parse(prev.lastReactivatedAt ?? prev.generatedAt);
    const atMs = Date.parse(atIso);
    if (
      !Number.isNaN(anchorMs) &&
      !Number.isNaN(atMs) &&
      atMs - anchorMs < spacingMs
    ) {
      return { record: prev, spaced: true };
    }
  }
  const updated: DreamCreatedRecord = {
    ...prev,
    reactivationCount: prev.reactivationCount + 1,
    lastReactivatedAt: atIso,
  };
  m.created.splice(idx, 1, updated);
  return { record: updated, spaced: false };
}

/** Flag live records whose gist has been folded into the notes page while
 *  they LIVE ON (living-memory semanticization, ADR 0023). Immutable
 *  per-record replace, like reinforceRecord. One-way: the flag is never
 *  cleared, so a record folds at most once; the caller sets it only when the
 *  fold outcome was "updated" (a failed fold retries next pass for free).
 *  Unknown ids are ignored. */
export function markGistFolded(m: DreamManifest, ids: readonly string[]): void {
  const wanted = new Set(ids);
  for (let i = 0; i < m.created.length; i++) {
    const r = m.created[i];
    if (r === undefined || !wanted.has(r.id)) continue;
    m.created.splice(i, 1, { ...r, gistFolded: true });
  }
}

/** The eviction target when over the prefix cap: lowest voice score, oldest.
 *  Superseded by `weakestByRetention` in the pass; retained for callers/tests
 *  that key on raw voice. */
export function weakestLiveRecord(
  m: DreamManifest,
): DreamCreatedRecord | undefined {
  return [...liveDreamRecords(m)].sort((a, b) => {
    if (a.critiqueScores.voice !== b.critiqueScores.voice)
      return a.critiqueScores.voice - b.critiqueScores.voice;
    return a.generatedAt.localeCompare(b.generatedAt);
  })[0];
}

/** Cap-eviction target: the live record with the lowest retention strength,
 *  tiebreak oldest `generatedAt`. Unlike `weakestLiveRecord`, a high-voice but
 *  stale/never-reactivated dream can now rank below a fresher lower-voice one. */
export function weakestByRetention(
  m: DreamManifest,
  nowMs: number,
  cfg: DreamConfig,
): DreamCreatedRecord | undefined {
  return weakestOf(liveDreamRecords(m), nowMs, cfg);
}

function weakestOf(
  pool: readonly DreamCreatedRecord[],
  nowMs: number,
  cfg: DreamConfig,
): DreamCreatedRecord | undefined {
  return [...pool].sort((a, b) => {
    const sa = computeStrength(a, nowMs, cfg);
    const sb = computeStrength(b, nowMs, cfg);
    if (sa !== sb) return sa - sb;
    return a.generatedAt.localeCompare(b.generatedAt);
  })[0];
}

/**
 * Cap-eviction target with INTERFERENCE priority (ADR 0022): real forgetting
 * is largely competition between similar memories, and the corpus's few-shot
 * job wants DIVERSITY — two 废案 teaching the same register situation are
 * worth less than two teaching different ones. So when 2+ live dreams share
 * a `situationTag` (the corpus's own register taxonomy — deterministic, no
 * LLM in the eviction path), the eviction pool is the duplicated-tag records
 * and the weakest by retention WITHIN it goes: its gist folds into the notes
 * page, and a same-tag sibling keeps the situation covered. Only when every
 * live tag is unique does this fall back to the globally weakest — a
 * unique-tag memory survives even when weaker than a redundant one; that
 * asymmetry is the point. The stale-floor pass stays pure-decay (untouched).
 */
export function pickEvictionTarget(
  m: DreamManifest,
  nowMs: number,
  cfg: DreamConfig,
): DreamCreatedRecord | undefined {
  const live = liveDreamRecords(m);
  const counts = new Map<string, number>();
  for (const r of live) {
    counts.set(r.situationTag, (counts.get(r.situationTag) ?? 0) + 1);
  }
  const dupes = live.filter((r) => (counts.get(r.situationTag) ?? 0) >= 2);
  return weakestOf(dupes.length > 0 ? dupes : live, nowMs, cfg);
}

/** Live records whose retention strength has decayed below `cfg.retentionFloor`
 *  — the stale-floor forgetting set. Empty when the floor is 0 (disabled) or no
 *  live record is below it. Seeds are never in `created`, so never returned. */
export function staleLiveRecords(
  m: DreamManifest,
  nowMs: number,
  cfg: DreamConfig,
): DreamCreatedRecord[] {
  if (cfg.retentionFloor <= 0) return [];
  return liveDreamRecords(m).filter(
    (r) => computeStrength(r, nowMs, cfg) < cfg.retentionFloor,
  );
}
