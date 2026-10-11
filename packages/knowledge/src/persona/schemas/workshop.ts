import type { ValidationResult } from "./wardrobe.js";

export type WorkshopItemState = "idle" | "in_progress" | "abandoned" | "broken";

export interface WorkshopItem {
  id: string;
  label: string;
  description: string;
  state: WorkshopItemState;
  notes?: string;
}

export interface WorkshopState {
  desk: WorkshopItem[];
  shelves: WorkshopItem[];
  recentActivity: string[];
}

const VALID_STATES: ReadonlySet<WorkshopItemState> = new Set([
  "idle",
  "in_progress",
  "abandoned",
  "broken",
]);

export function validateWorkshopState(
  input: unknown,
): ValidationResult<WorkshopState> {
  if (typeof input !== "object" || input === null) {
    return { ok: false, errors: ["state must be an object"] };
  }
  const r = input as Record<string, unknown>;
  const errors: string[] = [];
  if (!Array.isArray(r.desk)) errors.push("desk must be an array");
  if (!Array.isArray(r.shelves)) errors.push("shelves must be an array");
  if (!Array.isArray(r.recentActivity))
    errors.push("recentActivity must be an array");
  if (errors.length > 0) return { ok: false, errors };

  for (const which of ["desk", "shelves"] as const) {
    const arr = r[which] as unknown[];
    for (const [i, item] of arr.entries()) {
      if (typeof item !== "object" || item === null) {
        errors.push(`${which}[${i}] must be an object`);
        continue;
      }
      const x = item as Record<string, unknown>;
      if (typeof x.id !== "string")
        errors.push(`${which}[${i}].id must be string`);
      if (typeof x.label !== "string")
        errors.push(`${which}[${i}].label must be string`);
      if (typeof x.description !== "string")
        errors.push(`${which}[${i}].description must be string`);
      if (
        typeof x.state !== "string" ||
        !VALID_STATES.has(x.state as WorkshopItemState)
      ) {
        errors.push(
          `${which}[${i}].state must be one of ${Array.from(VALID_STATES).join("|")}`,
        );
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: r as unknown as WorkshopState };
}
