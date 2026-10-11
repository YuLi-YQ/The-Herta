import type { HertaBridge } from "./ipc/bridge-types.js";

// Renderer-only global augmentation: the preload contextBridge exposes
// the HertaBridge as `window.herta`. Kept separate from bridge-types.ts
// so that file remains DOM-free and importable by the main + preload
// TypeScript projects (which have no DOM lib).
declare global {
  interface Window {
    // Optional: present only after the preload contextBridge runs. If the
    // preload fails to load, this is `undefined` — App guards for it and
    // renders an error screen rather than crashing on mount.
    readonly herta?: HertaBridge;
  }
}
