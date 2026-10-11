// Shared filesystem helpers for the knowledge package.
// Mirrors the convention from packages/memory/src/file-memory-manager.ts.

export function isMissingFsError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: string }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}
