import { useEffect, useMemo } from "react";

/**
 * A `blob:` URL for bytes the renderer holds (ADR 0054 §5): pictures, PDF
 * pages, deck media all draw from these — `img-src blob:` is already
 * granted for the lightbox. Revoked when the bytes change or the owner
 * unmounts, so a long session does not accumulate object URLs.
 */
export function useBlobUrl(
  bytes: Uint8Array | null,
  mime: string,
): string | null {
  const url = useMemo(
    () =>
      bytes === null
        ? null
        : URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime })),
    [bytes, mime],
  );
  useEffect(() => {
    return () => {
      if (url !== null) URL.revokeObjectURL(url);
    };
  }, [url]);
  return url;
}

/** MIME by extension for the picture kinds the viewer draws through
 *  <img>. Unknown → octet-stream, which Chromium still sniffs for <img>. */
export function imageMimeFor(path: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(path);
  switch ((m?.[1] ?? "").toLowerCase()) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "bmp":
      return "image/bmp";
    case "ico":
      return "image/x-icon";
    case "avif":
      return "image/avif";
    case "svg":
      return "image/svg+xml";
    case "emf":
      return "image/emf";
    case "wmf":
      return "image/wmf";
    case "tif":
    case "tiff":
      return "image/tiff";
    default:
      return "application/octet-stream";
  }
}
