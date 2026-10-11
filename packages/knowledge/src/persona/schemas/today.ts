import type { ValidationResult } from "./wardrobe.js";

export type TodayMood =
  | "bored"
  | "annoyed"
  | "interested"
  | "amused"
  | "preoccupied";

export interface TodayState {
  mood: TodayMood;
  annoyance?: string;
  preoccupation?: string;
  recentSuccess?: string;
  recentFailure?: string;
  generatedAt: string;
}

const VALID_MOODS: ReadonlySet<TodayMood> = new Set([
  "bored",
  "annoyed",
  "interested",
  "amused",
  "preoccupied",
]);

export function validateTodayState(
  input: unknown,
): ValidationResult<TodayState> {
  if (typeof input !== "object" || input === null) {
    return { ok: false, errors: ["state must be an object"] };
  }
  const r = input as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof r.mood !== "string" || !VALID_MOODS.has(r.mood as TodayMood)) {
    errors.push(`mood must be one of ${Array.from(VALID_MOODS).join("|")}`);
  }
  if (typeof r.generatedAt !== "string")
    errors.push("generatedAt must be string");
  for (const k of [
    "annoyance",
    "preoccupation",
    "recentSuccess",
    "recentFailure",
  ] as const) {
    if (r[k] !== undefined && typeof r[k] !== "string")
      errors.push(`${k} must be string when present`);
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: r as unknown as TodayState };
}
