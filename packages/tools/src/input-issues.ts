import type { ZodError } from "zod";

/**
 * Format zod issues for a model-visible `invalid_input` message.
 *
 * Root-level issues (cross-field refines, strict-mode unrecognized keys)
 * have an EMPTY path — the naive `path.join(".") + ": " + message` every
 * tool used to hand-roll rendered those as ": give either `match` or
 * `fromLine`", which the record then showed as "invalid_input: : give…"
 * (user 2026-07-31). Field-level issues keep their `field: message` shape.
 */
export function formatInputIssues(error: ZodError): string {
  return error.issues
    .map((i) =>
      i.path.length === 0 ? i.message : `${i.path.join(".")}: ${i.message}`,
    )
    .join("; ");
}
