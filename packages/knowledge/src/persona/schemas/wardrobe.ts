export interface WardrobeOutfit {
  id: string;
  name: string;
  description: string;
  canonGrounded: boolean;
  notes?: string;
}

export interface WardrobeState {
  outfits: WardrobeOutfit[];
  currentlyWorn: string;
  lastChangedAt: string;
}

export interface ValidationResult<T> {
  ok: boolean;
  value?: T;
  errors?: string[];
}

export function validateWardrobeState(
  input: unknown,
): ValidationResult<WardrobeState> {
  const errors: string[] = [];
  if (typeof input !== "object" || input === null) {
    return { ok: false, errors: ["state must be an object"] };
  }
  const r = input as Record<string, unknown>;
  if (!Array.isArray(r.outfits)) errors.push("outfits must be an array");
  if (typeof r.currentlyWorn !== "string")
    errors.push("currentlyWorn must be a string");
  if (typeof r.lastChangedAt !== "string")
    errors.push("lastChangedAt must be a string");

  if (errors.length > 0) return { ok: false, errors };
  const outfits = r.outfits as unknown[];
  for (const [i, o] of outfits.entries()) {
    if (typeof o !== "object" || o === null) {
      errors.push(`outfits[${i}] must be an object`);
      continue;
    }
    const x = o as Record<string, unknown>;
    if (typeof x.id !== "string")
      errors.push(`outfits[${i}].id must be string`);
    if (typeof x.name !== "string")
      errors.push(`outfits[${i}].name must be string`);
    if (typeof x.description !== "string")
      errors.push(`outfits[${i}].description must be string`);
    if (typeof x.canonGrounded !== "boolean")
      errors.push(`outfits[${i}].canonGrounded must be boolean`);
  }
  if (errors.length > 0) return { ok: false, errors };

  const ids = new Set((outfits as WardrobeOutfit[]).map((o) => o.id));
  if (!ids.has(r.currentlyWorn as string)) {
    return {
      ok: false,
      errors: [
        `currentlyWorn "${r.currentlyWorn}" must match an existing outfit id`,
      ],
    };
  }

  return { ok: true, value: r as unknown as WardrobeState };
}
