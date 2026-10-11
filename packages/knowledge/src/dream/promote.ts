import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { isPathInside, writeFileAtomicSync } from "@herta/core";
import { nextFeianIndex } from "./feian-format.js";

/** D4 guard: throws unless `target` resolves to a path inside `root` (core's
 *  one containment rule). */
export function assertUnderDreamRoot(target: string, root: string): void {
  if (!isPathInside(root, target)) {
    throw new Error(
      `dream: refusing to write outside ${resolve(root)}: ${resolve(target)}`,
    );
  }
}

export interface PromoteInput {
  narrativeDir: string;
  dreamDir: string;
  title: string;
  /** The validated 废案 body. Its header is rewritten to the assigned NN. */
  feianBody: string;
  runId: string;
  /** Pre-assigned index. When omitted, the next free index is scanned from the
   *  narrative dir. The reconsolidation junction assigns it BEFORE archiving
   *  OLD so the merged file can never reuse OLD's number. */
  nn?: number;
}

export interface PromoteResult {
  nn: number;
  file: string;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function promoteCandidate(input: PromoteInput): PromoteResult {
  mkdirSync(input.narrativeDir, { recursive: true });
  const nn = input.nn ?? nextFeianIndex(readdirSync(input.narrativeDir));
  // Fix 2: sanitize filename chars that would break paths, but keep the
  // original title in the internal line-1 header.
  const safeTitle = input.title.replace(/[/\\:*?"<>|]/g, "_");
  const file = `### 废案_${pad(nn)}：${safeTitle}.txt`;
  // Rewrite the internal line-1 header to the assigned NN (Dream always emits
  // the numbered form). Replace only the first header line (uses original title).
  const body = input.feianBody.replace(
    /^### 废案(?:_\d+)?：.*$/m,
    `### 废案_${pad(nn)}：${input.title}`,
  );
  // Fix 1 (D4 guard): target path must be inside narrativeDir. The atomic
  // write's temp sits beside the target, so it is inside too.
  const target = join(input.narrativeDir, file);
  assertUnderDreamRoot(target, input.narrativeDir);
  writeFileAtomicSync(target, body);
  return { nn, file };
}

export interface ArchiveInput {
  narrativeDir: string;
  dreamDir: string;
  file: string;
  reason: string;
}

/** Move a live file into the dream archive. Returns the name it has THERE —
 *  its own, unless an earlier archived file already held it. */
export function archiveLiveRecord(input: ArchiveInput): string {
  const archiveDir = join(input.dreamDir, "archive");
  mkdirSync(archiveDir, { recursive: true });
  // Fix 1 (D4 guard): archive target must be inside dreamDir.
  assertUnderDreamRoot(join(archiveDir, input.file), input.dreamDir);
  const archivedAs = freeArchiveName(archiveDir, input.file);
  renameSync(
    join(input.narrativeDir, input.file),
    join(archiveDir, archivedAs),
  );
  return archivedAs;
}

/**
 * A name in the archive nothing holds yet. A later 废案 can take an archived
 * one's exact `NN：title`, and a rename onto an existing name REPLACES it on
 * every platform this ships on — the earlier archived memory was overwritten,
 * breaking "archive, never delete" (dream review 2026-09-22, finding 19). The
 * second copy gets ` (2)` before the extension, then ` (3)`, and so on.
 */
function freeArchiveName(archiveDir: string, file: string): string {
  if (!existsSync(join(archiveDir, file))) return file;
  const dot = file.lastIndexOf(".");
  const stem = dot > 0 ? file.slice(0, dot) : file;
  const ext = dot > 0 ? file.slice(dot) : "";
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!existsSync(join(archiveDir, candidate))) return candidate;
  }
}
