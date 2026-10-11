/**
 * Demo stand-in for the renderer's `shared/attachment-image` module (aliased
 * in vite.config.ts). The desktop app serves stored pictures out of the
 * Electron main process over the `herta-attachment://` protocol; a browser
 * page has no such scheme, so the two pictures the showcase transcript cites
 * are bundled as ordinary vite assets and returned by stored path. Unknown
 * paths fall through to the real scheme and render as broken images — which
 * is exactly what an unserveable path IS here (staging is refused in the
 * demo, so no other stored path can ever reach an <img>).
 */
import panelAfter from "./assets/demo-panel-after.png";
import panelAlerts from "./assets/demo-panel-alerts.png";

export const ATTACHMENT_SCHEME = "herta-attachment";

/** Stored-path → bundled-asset map for the showcase record's pictures. Keys
 *  must match the `digest.path` of every imageRow in demo-bridge.ts. */
const DEMO_IMAGES: Record<string, string> = {
  ".herta/attachments/s-4f1c/sensor07-night-3fa1c220.png": panelAlerts,
  ".herta/attachments/s-4f1c/sensor07-today-b47d9e01.png": panelAfter,
};

export function attachmentImageUrl(relPath: string): string {
  const bundled = DEMO_IMAGES[relPath];
  if (bundled !== undefined) return bundled;
  const segments = relPath.split("/").map(encodeURIComponent);
  return `${ATTACHMENT_SCHEME}://file/${segments.join("/")}`;
}
