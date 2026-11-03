import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

const NARROW_QUERY = "(max-width: 600px)";

function isNarrow(): boolean {
  return typeof window.matchMedia === "function"
    ? window.matchMedia(NARROW_QUERY).matches
    : window.innerWidth <= 600;
}

/** Narrow windows start with the navigation folded. Their temporary toggle is
 * separate from the normal-width choice, which is restored on widening. An
 * optional, stable storageKey preserves only that normal-width choice. */
export function useResponsiveSidebar(
  storageKey?: string,
): readonly [boolean, Dispatch<SetStateAction<boolean>>] {
  const [wideCollapsed, setWideCollapsed] = useState(() => {
    if (!storageKey) return false;
    try {
      return localStorage.getItem(storageKey) === "true";
    } catch {
      return false;
    }
  });
  const [narrow, setNarrow] = useState(isNarrow);
  const [narrowCollapsed, setNarrowCollapsed] = useState(true);
  const narrowRef = useRef(narrow);
  const previousWide = useRef(wideCollapsed);

  useEffect(() => {
    const media = typeof window.matchMedia === "function"
      ? window.matchMedia(NARROW_QUERY)
      : undefined;
    const update = () => {
      const next = media ? media.matches : window.innerWidth <= 600;
      if (next && !narrowRef.current) setNarrowCollapsed(true);
      narrowRef.current = next;
      setNarrow(next);
    };
    update();
    if (media) {
      media.addEventListener("change", update);
      return () => media.removeEventListener("change", update);
    }
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  useEffect(() => {
    if (previousWide.current === wideCollapsed) return;
    previousWide.current = wideCollapsed;
    if (!storageKey) return;
    try {
      localStorage.setItem(storageKey, String(wideCollapsed));
    } catch {
      // A blocked preference store does not make the current toggle unusable.
    }
  }, [storageKey, wideCollapsed]);

  // Stable like React's state setter: existing keyboard handlers need not be
  // re-registered every time the viewport crosses the breakpoint.
  const setCollapsed = useCallback<Dispatch<SetStateAction<boolean>>>((next) => {
    if (narrowRef.current) setNarrowCollapsed(next);
    else setWideCollapsed(next);
  }, []);

  return [narrow ? narrowCollapsed : wideCollapsed, setCollapsed];
}
