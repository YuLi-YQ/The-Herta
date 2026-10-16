import { useSyncExternalStore } from "react";
export type MotionPreference = "system" | "off";
const key = "the-herta.motion.v1";
const event = "herta-motion-change";
export function motionPreference(): MotionPreference {
  try { return localStorage.getItem(key) === "off" ? "off" : "system"; }
  catch { return "off"; }
}
export function initializeMotion() {
  document.documentElement.dataset.motion = motionPreference();
}
export function setMotionPreference(value: MotionPreference) {
  if (value !== "system" && value !== "off") return;
  localStorage.setItem(key, value);
  initializeMotion();
  window.dispatchEvent(new Event(event));
}
function subscribe(change: () => void) {
  window.addEventListener(event, change);
  return () => window.removeEventListener(event, change);
}
export const useMotionPreference = () => useSyncExternalStore(subscribe, motionPreference, () => "off" as MotionPreference);
