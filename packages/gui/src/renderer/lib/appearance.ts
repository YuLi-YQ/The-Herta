import { useSyncExternalStore } from "react";
export type Appearance = "classic" | "observatory";
const key = "the-herta.appearance.v1";
const event = "herta-appearance-change";
export function appearance(): Appearance {
  try { return localStorage.getItem(key) === "classic" ? "classic" : "observatory"; }
  catch { return "classic"; }
}
export function initializeAppearance() {
  document.documentElement.dataset.appearance = appearance();
}
export function setAppearance(value: Appearance) {
  if (!["classic", "observatory"].includes(value)) return;
  // A failed write leaves both the current view and preference unchanged.
  localStorage.setItem(key, value);
  document.documentElement.dataset.appearance = value;
  window.dispatchEvent(new Event(event));
}
function subscribe(change: () => void) {
  window.addEventListener(event, change);
  return () => window.removeEventListener(event, change);
}
export const useAppearance = () => useSyncExternalStore(subscribe, appearance, () => "classic" as Appearance);
