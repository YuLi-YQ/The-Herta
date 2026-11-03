import { gsap } from "gsap";
import { type RefObject, useLayoutEffect, useRef } from "react";

/**
 * Entrance motion for the observatory appearance, driven by GSAP (R46).
 *
 * The rules follow the shared feedback layer in motion.css: the in-app "off"
 * switch and the OS reduce-motion request
 * both mean none. Only opacity and transform move (never layout), every tween
 * belongs to a gsap.context that is reverted on unmount, and nothing loops.
 * Timings: popovers ~200ms and messages ~320ms on a power3.out curve
 * (an ease-out, so the move starts the instant the element appears); no
 * overshoot or bounce on interface elements.
 */
export function motionAllowed(): boolean {
  if (typeof document === "undefined") return false;
  const root = document.documentElement;
  if (root.dataset.appearance !== "observatory" || root.dataset.motion === "off")
    return false;
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: no-preference)").matches
  );
}

/**
 * Calls `stop` when motion stops being allowed — the in-app switch, the
 * appearance or the OS reduce-motion request changing on its own, with no
 * new message to re-run an effect (R60). One observer and one media listener
 * serve every subscriber and are removed with the last one. Returns the
 * unsubscribe.
 */
const watchers = new Set<() => void>();
let unwatchAll: (() => void) | null = null;
function notify(): void {
  if (motionAllowed()) return;
  for (const stop of [...watchers]) stop();
}
export function onMotionStopped(stop: () => void): () => void {
  watchers.add(stop);
  if (!unwatchAll && typeof document !== "undefined") {
    const observer =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(notify);
    observer?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-motion", "data-appearance"],
    });
    const media =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: no-preference)")
        : null;
    media?.addEventListener?.("change", notify);
    unwatchAll = () => {
      observer?.disconnect();
      media?.removeEventListener?.("change", notify);
    };
  }
  return () => {
    watchers.delete(stop);
    if (watchers.size === 0 && unwatchAll) {
      unwatchAll();
      unwatchAll = null;
    }
  };
}

/**
 * Only what a tween animates is cleared afterwards, never React's own styles.
 * Fades use plain opacity, not autoAlpha: autoAlpha's first frame is
 * visibility:hidden, and a menu that moves focus to its first item as it
 * opens would lose that focus (found in the packaged audit, R46).
 */
const CLEAR = "opacity,transform";

export type EntranceKind = "popover-up" | "popover-down" | "panel" | "row";

const ENTRANCES: Record<EntranceKind, gsap.TweenVars> = {
  // Opens upward out of a control in a bottom bar (composer pickers).
  "popover-up": {
    opacity: 0,
    y: 6,
    scale: 0.97,
    transformOrigin: "50% 100%",
    duration: 0.2,
    ease: "power3.out",
  },
  // Drops from a control above it (row menus, sidebar menus).
  "popover-down": {
    opacity: 0,
    y: -6,
    scale: 0.97,
    transformOrigin: "100% 0%",
    duration: 0.2,
    ease: "power3.out",
  },
  // A whole surface swapping in (workbench ⇄ chat).
  panel: { opacity: 0, duration: 0.18, ease: "power2.out" },
  // A list row that just appeared.
  row: { opacity: 0, x: -6, duration: 0.22, ease: "power3.out" },
};

/** One entrance on an element that stays mounted (a native <details> menu
 *  opening). Returns the tween so a caller can kill it, or null when off. */
export function playEntrance(
  el: HTMLElement,
  kind: EntranceKind,
): gsap.core.Tween | null {
  if (!motionAllowed()) return null;
  let unwatch = (): void => {};
  const tween = gsap.from(el, {
    ...ENTRANCES[kind],
    clearProps: CLEAR,
    onComplete: () => unwatch(),
    onInterrupt: () => unwatch(),
  });
  // A caller ending the entrance itself (closing a menu) also unsubscribes.
  const revert = tween.revert.bind(tween);
  tween.revert = () => {
    unwatch();
    return revert();
  };
  unwatch = onMotionStopped(() => tween.revert());
  return tween;
}

/** Play one entrance when the element mounts (or when `trigger` changes). */
export function useEntrance(
  ref: RefObject<HTMLElement>,
  kind: EntranceKind,
  trigger?: unknown,
  enabled = true,
): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: the caller's trigger replays the entrance.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !enabled || !motionAllowed()) return;
    const ctx = gsap.context(() => {
      gsap.from(el, { ...ENTRANCES[kind], clearProps: CLEAR });
    }, el);
    const unwatch = onMotionStopped(() => ctx.revert());
    return () => {
      unwatch();
      ctx.revert();
    };
  }, [trigger, enabled]);
}

/** How appended items enter: messages rise, list rows slide in (R54). */
const APPENDS = {
  message: {
    opacity: 0,
    y: 10,
    duration: 0.32,
    ease: "power3.out",
    stagger: 0.06,
  },
  row: { ...ENTRANCES.row, stagger: 0.04 },
} satisfies Record<string, gsap.TweenVars>;
export type AppendKind = keyof typeof APPENDS;

/**
 * Bring new items into a growing list: messages appended while the reader is
 * here, or a chat just created in the sidebar — never the history shown on
 * load or on switching chats (`scope`). Items are found by `data-entrance`
 * inside `container`; a burst (the user's message and the reply placeholder)
 * staggers.
 */
export function useAppendEntrance(
  container: RefObject<HTMLElement>,
  keys: readonly string[],
  scope: string | null,
  kind: AppendKind = "message",
  enabled = true,
): void {
  const seen = useRef<{ scope: string | null; keys: Set<string>; enabled: boolean } | null>(null);
  // Concurrent bursts keep moving independently, but completed batches release
  // their context's target references immediately (R134). Only live batches
  // remain to be reverted on hiding, scope change, motion-off or unmount.
  const batches = useRef(new Set<gsap.Context>());
  const stop = (): void => {
    for (const batch of batches.current) batch.revert();
    batches.current.clear();
  };
  useLayoutEffect(() => {
    // The switch can change with no new message to re-run the effect below (R60).
    const unwatch = onMotionStopped(stop);
    return () => {
      unwatch();
      stop();
    };
  }, []);
  const signature = keys.join("\u0001");
  // biome-ignore lint/correctness/useExhaustiveDependencies: the joined keys and scope are the trigger.
  useLayoutEffect(() => {
    const previous = seen.current;
    seen.current = { scope, keys: new Set(keys), enabled };
    if (!previous || previous.scope !== scope || !enabled || !previous.enabled || !motionAllowed()) {
      stop();
      return;
    }
    const root = container.current;
    if (!root) return;
    const fresh = keys
      .filter((key) => !previous.keys.has(key))
      .map((key) =>
        root.querySelector<HTMLElement>(
          `[data-entrance="${key.replace(/["\\]/g, "\\$&")}"]`,
        ),
      )
      .filter((el): el is HTMLElement => el !== null);
    if (fresh.length === 0) return;
    const batch = gsap.context(() => undefined, root);
    batches.current.add(batch);
    batch.add(() => {
      gsap.from(fresh, {
        ...APPENDS[kind],
        clearProps: CLEAR,
        onComplete: () => {
          // clearProps has already restored the animated styles. Clearing the
          // context drops completed tweens without rewinding other batches.
          batch.clear();
          batches.current.delete(batch);
        },
      });
    });
  }, [signature, scope, enabled]);
}

/** How a conversation comes in on a switch: the messages in view rise like
 *  appended ones, one after another (R71). */
const SWITCH = {
  opacity: 0,
  y: 10,
  duration: 0.32,
  ease: "power3.out",
} satisfies gsap.TweenVars;
/** At most this many items take part, spread over at most SWITCH_SPREAD
 *  seconds, so the whole sequence ends within about two thirds of a second. */
const SWITCH_LIMIT = 8;
const SWITCH_SPREAD = 0.3;

/**
 * Bring a conversation in item by item when the reader switches to it, or it
 * first shows with history (R71). Only the items `selector` finds that are in
 * view take part, top to bottom: the owner lands on the newest line in a
 * layout effect declared before this hook, so history above the fold never
 * moves. With `lateMs`, items that mount that soon after the switch (a task's
 * round results come from a second read) join the sequence instead of popping
 * in. Later appends belong to useAppendEntrance. A new scope, unmounting or
 * motion stopping reverts whatever is still running.
 */
export function useSwitchEntrance(
  container: RefObject<HTMLElement>,
  scope: string | null,
  selector: string,
  lateMs = 0,
  enabled = true,
): void {
  const previousScope = useRef<string | null | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new scope is the trigger.
  useLayoutEffect(() => {
    const isNewScope = previousScope.current !== scope;
    previousScope.current = scope;
    const root = container.current;
    // Returning to a surface is not a conversation switch. Hidden updates
    // consume the scope as well, so their history is not replayed on return.
    if (!root || scope === null || !enabled || !isNewScope || !motionAllowed()) return;
    const box = root.getBoundingClientRect();
    if (box.height === 0) return; // a hidden surface shows instantly later
    const inView = (el: HTMLElement): boolean => {
      const rect = el.getBoundingClientRect();
      return rect.height > 0 && rect.bottom > box.top && rect.top < box.bottom;
    };
    const present = [...root.querySelectorAll<HTMLElement>(selector)];
    const seen = new WeakSet<Element>(present);
    const first = present.filter(inView).slice(-SWITCH_LIMIT);
    const each =
      first.length > 1
        ? Math.min(0.05, SWITCH_SPREAD / (first.length - 1))
        : 0.05;
    const started = performance.now();
    let slot = first.length;
    const ctx = gsap.context(() => {
      if (first.length > 0)
        gsap.from(first, { ...SWITCH, stagger: each, clearProps: CLEAR });
    }, root);
    let observer: MutationObserver | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (lateMs > 0 && slot < SWITCH_LIMIT && typeof MutationObserver !== "undefined") {
      // Runs before the next paint, so a late item is hidden before it shows.
      observer = new MutationObserver((records) => {
        const elapsed = (performance.now() - started) / 1000;
        const remaining = SWITCH_LIMIT - slot;
        if (remaining <= 0 || elapsed >= SWITCH_SPREAD) {
          observer?.disconnect();
          return;
        }
        // Child mutations inside a streamed paragraph need not rescan every
        // earlier message. Inspect only newly inserted elements/subtrees.
        const candidates = new Set<HTMLElement>();
        for (const record of records) for (const node of record.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (node.matches(selector)) candidates.add(node);
          for (const child of node.querySelectorAll<HTMLElement>(selector)) candidates.add(child);
        }
        const eligible: HTMLElement[] = [];
        for (const el of candidates) {
          if (!root.contains(el)) continue;
          if (seen.has(el)) continue;
          seen.add(el);
          if (inView(el) && !gsap.isTweening(el)) eligible.push(el);
        }
        const late = eligible.sort((a, b) =>
          a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
        ).slice(-remaining);
        if (late.length === 0) return;
        const delay = Math.max(
          0,
          Math.min(slot * each, SWITCH_SPREAD) - elapsed,
        );
        const stagger = late.length > 1
          ? Math.min(each, Math.max(0, (SWITCH_SPREAD - elapsed - delay) / (late.length - 1)))
          : 0;
        slot += late.length;
        ctx.add(() => {
          gsap.from(late, { ...SWITCH, delay, stagger, clearProps: CLEAR });
        });
        if (slot >= SWITCH_LIMIT) observer?.disconnect();
      });
      observer.observe(root, { childList: true, subtree: true });
      timer = setTimeout(() => observer?.disconnect(), Math.min(lateMs, SWITCH_SPREAD * 1000));
    }
    const stop = (): void => {
      observer?.disconnect();
      clearTimeout(timer);
    };
    const unwatch = onMotionStopped(() => {
      stop();
      ctx.revert();
    });
    return () => {
      stop();
      unwatch();
      ctx.revert();
    };
  }, [scope, enabled]);
}
