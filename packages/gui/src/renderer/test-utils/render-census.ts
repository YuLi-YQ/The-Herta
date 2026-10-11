import type { CommitHook } from "./react-commit-hook.js";

/**
 * Render census: which components React actually re-rendered, commit by
 * commit, while a census is running. Deterministic — a count, not a clock —
 * so it can hold a line in the test gate the way a timing never could.
 *
 * The walk is React DevTools' own: from the root, a fiber whose `child` is
 * the same object as its previous version's `child` kept its whole subtree
 * (React reused it without rendering), so the walk stops there; a component
 * fiber reached otherwise counts when React flagged it `PerformedWork` (the
 * flag DevTools reads — React pins its value for exactly that reason); a
 * fiber with no previous version is a mount and counts with its subtree.
 *
 * Why not <Profiler>: a Profiler inside a re-rendering parent reports on
 * every parent commit, so it cannot tell a memo bail-out from a render
 * (perf audit 2026-09-21). The census counts the components themselves.
 */

/** React's `PerformedWork` flag ("Don't change these two values. They're
 *  used by React Dev Tools." — react-reconciler's fiber flags). */
const PERFORMED_WORK = 0b1;

/** Fiber tags of a component someone wrote: function (0), class (1),
 *  forwardRef (11), simple memo (15). A non-simple memo (14) wraps its
 *  component in a child fiber, which is counted there. */
const COMPONENT_TAGS = new Set([0, 1, 11, 15]);

interface Fiber {
  readonly tag: number;
  readonly type: unknown;
  readonly flags: number;
  readonly child: Fiber | null;
  readonly sibling: Fiber | null;
  readonly alternate: Fiber | null;
}

export interface Census {
  /** React commits while the census ran. */
  readonly commits: number;
  /** Component renders, summed over those commits. */
  readonly renders: number;
  /** Renders per component name, most first. */
  readonly byComponent: ReadonlyArray<readonly [string, number]>;
}

function nameOf(fiber: Fiber): string {
  const t = fiber.type as
    | { displayName?: string; name?: string; render?: { name?: string } }
    | null
    | undefined;
  if (t === null || t === undefined) return "?";
  return t.displayName || t.name || t.render?.name || "Anonymous";
}

function mounted(fiber: Fiber, hit: (f: Fiber) => void): void {
  if (COMPONENT_TAGS.has(fiber.tag)) hit(fiber);
  for (let c = fiber.child; c !== null; c = c.sibling) mounted(c, hit);
}

function updated(next: Fiber, prev: Fiber, hit: (f: Fiber) => void): void {
  if (COMPONENT_TAGS.has(next.tag) && (next.flags & PERFORMED_WORK) !== 0) {
    hit(next);
  }
  // Same child object: React reused the subtree without touching it.
  if (next.child === prev.child) return;
  for (let c = next.child; c !== null; c = c.sibling) {
    if (c.alternate === null) mounted(c, hit);
    else updated(c, c.alternate, hit);
  }
}

/** Start counting. Call `stop()` for the result; the census detaches. */
export function startRenderCensus(): { stop: () => Census } {
  const hook = (
    globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: Partial<CommitHook> }
  ).__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (hook?.listeners === undefined) {
    throw new Error(
      "render census: no commit hook — test-utils/react-commit-hook.ts must be the first jsdom setup file",
    );
  }
  let commits = 0;
  const counts = new Map<string, number>();
  const hit = (f: Fiber): void => {
    const name = nameOf(f);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  };
  const listen = (root: unknown): void => {
    commits += 1;
    const next = (root as { current: Fiber }).current;
    if (next.alternate === null) mounted(next, hit);
    else updated(next, next.alternate, hit);
  };
  hook.listeners.add(listen);
  return {
    stop: () => {
      hook.listeners?.delete(listen);
      const byComponent = [...counts.entries()].sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
      );
      return {
        commits,
        renders: byComponent.reduce((n, [, c]) => n + c, 0),
        byComponent,
      };
    },
  };
}
