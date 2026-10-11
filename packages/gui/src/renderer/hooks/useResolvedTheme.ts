import { useSyncExternalStore } from "react";

export type ResolvedTheme = "light" | "dark";

function read(): ResolvedTheme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => observer.disconnect();
}

/**
 * The RESOLVED appearance — what the stylesheet is actually keyed on — read
 * from `<html data-theme>` (lib/theme.ts owns the one mutation). "system"
 * is already resolved there, so a consumer that needs to follow the theme
 * in JS (the 3D device card's lighting) sees the same light/dark the CSS
 * does, including the live OS flip.
 */
export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribe, read, () => "light");
}
