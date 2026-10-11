/**
 * Voice-clip wire contract shared by the Electron main (which serves the files)
 * and the renderer (which plays them). No electron / DOM deps, so both bundles
 * can import it.
 */

/** Custom scheme the renderer's <audio> loads from; `protocol.handle`d in main. */
export const VOICE_SCHEME = "herta-voice";

/**
 * Build the renderer-side audio URL for a voice clip under
 * `<voiceRoot>/<category>/<clipId>.opus` (Ogg/Opus since the 2026-07-16
 * wav→opus cutover — the wavs remain the local source masters, only Opus
 * ships). Each path segment is percent-encoded (particle categories carry
 * Chinese names); the main-process handler decodes it back to a file path.
 * `clip` is a fixed authority the handler ignores.
 *
 * e.g. voiceClipUrl("openings", "004-late-night-audit")
 *      → "herta-voice://clip/openings/004-late-night-audit.opus"
 */
export function voiceClipUrl(category: string, clipId: string): string {
  const segments = `${category}/${clipId}.opus`
    .split("/")
    .map(encodeURIComponent);
  return `${VOICE_SCHEME}://clip/${segments.join("/")}`;
}
