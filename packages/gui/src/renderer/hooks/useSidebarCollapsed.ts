import { useCallback, useState } from "react";

const STORAGE_KEY = "herta.sidebar.collapsed";

/** Read the persisted collapsed flag. Guarded so test/SSR environments
 *  without localStorage degrade to expanded (false). */
function readCollapsed(): boolean {
  try {
    if (typeof window === "undefined" || window.localStorage === undefined) {
      return false;
    }
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Sidebar collapsed/expanded preference, persisted to localStorage so it
 * survives app launches. Returns `[collapsed, toggle]`.
 */
export function useSidebarCollapsed(): readonly [boolean, () => void] {
  const [collapsed, setCollapsed] = useState<boolean>(readCollapsed);
  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        if (
          typeof window !== "undefined" &&
          window.localStorage !== undefined
        ) {
          window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
        }
      } catch {
        // ignore storage failures — in-memory state still updates
      }
      return next;
    });
  }, []);
  return [collapsed, toggle];
}
