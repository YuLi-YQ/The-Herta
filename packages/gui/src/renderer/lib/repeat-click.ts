/**
 * Whether a click is the second (or a later) click of a multi-click, as the
 * platform counts them: `UIEvent.detail` is 1 for a single click, 2 for the
 * second click of a double-click, 0 for a keyboard or synthetic activation.
 *
 * A two-step control — a first click arms, a second confirms — must never
 * take its confirm from a repeat click. Its confirm appears where the arm
 * was, so a double-click on the arm landed the second click on the confirm:
 * a double-click on a session's trash deleted the session, and a
 * double-click mid-turn interrupted the very reply the arm exists to
 * protect (UX review 2026-09-22, item 3). The platform's own count is the
 * double-click threshold the user already lives with; a deliberate confirm
 * after reading the arm is a fresh click.
 */
export function isRepeatClick(e: { readonly detail: number }): boolean {
  return e.detail > 1;
}
