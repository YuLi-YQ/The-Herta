import type { ValidationResult } from "./wardrobe.js";

export type DollStatus = "active" | "broken" | "in_pieces" | "in_storage";

export interface DollEntry {
  id: string;
  nickname?: string;
  deployedTo: string;
  status: DollStatus;
  lastReportedAt: string;
  notes?: string;
}

export interface DollFleetState {
  dolls: DollEntry[];
}

const VALID_DOLL_STATUS: ReadonlySet<DollStatus> = new Set([
  "active",
  "broken",
  "in_pieces",
  "in_storage",
]);

export function validateDollFleetState(
  input: unknown,
): ValidationResult<DollFleetState> {
  if (typeof input !== "object" || input === null) {
    return { ok: false, errors: ["state must be an object"] };
  }
  const r = input as Record<string, unknown>;
  if (!Array.isArray(r.dolls)) {
    return { ok: false, errors: ["dolls must be an array"] };
  }
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const [i, d] of (r.dolls as unknown[]).entries()) {
    if (typeof d !== "object" || d === null) {
      errors.push(`dolls[${i}] must be an object`);
      continue;
    }
    const x = d as Record<string, unknown>;
    if (typeof x.id !== "string") errors.push(`dolls[${i}].id must be string`);
    else {
      if (seen.has(x.id)) errors.push(`dolls[${i}].id "${x.id}" is duplicated`);
      seen.add(x.id);
    }
    if (typeof x.deployedTo !== "string")
      errors.push(`dolls[${i}].deployedTo must be string`);
    if (
      typeof x.status !== "string" ||
      !VALID_DOLL_STATUS.has(x.status as DollStatus)
    )
      errors.push(
        `dolls[${i}].status must be one of ${Array.from(VALID_DOLL_STATUS).join("|")}`,
      );
    if (typeof x.lastReportedAt !== "string")
      errors.push(`dolls[${i}].lastReportedAt must be string`);
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: r as unknown as DollFleetState };
}
