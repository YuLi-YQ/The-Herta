/**
 * Attachment-image wire contract (ADR 0048 §4), shared by the Electron main
 * process (which serves the files) and the renderer (which draws them). No
 * electron / DOM deps, so both bundles can import it.
 */

/** Custom scheme the renderer's <img> loads from; `protocol.handle`d in main. */
export const ATTACHMENT_SCHEME = "herta-attachment";

/**
 * Build the renderer-side URL for a stored attachment image.
 *
 * The path is workspace-RELATIVE, exactly as the record's digest carries it
 * (`.herta/attachments/<sessionId>/<name>-<hash>.png`), so the renderer never
 * learns an absolute filesystem path and the main process resolves it against
 * the one root it trusts. Every segment is percent-encoded: a user's filename
 * is arbitrary text, and `安装 (1).png` must survive the round trip.
 *
 * Example:
 *   attachmentImageUrl(".herta/attachments/s1/shot-ab12cd34.png")
 *     → "herta-attachment://file/.herta/attachments/s1/shot-ab12cd34.png"
 */
export function attachmentImageUrl(relPath: string): string {
  const segments = relPath.split("/").map(encodeURIComponent);
  return `${ATTACHMENT_SCHEME}://file/${segments.join("/")}`;
}
