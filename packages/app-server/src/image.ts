/**
 * Image attachments (ADR 0048): what the bytes are, and how big.
 *
 * Pure and byte-level — no decoder, no dependency. An image attachment does
 * not need to be decoded to be stored and captioned; all this file answers is
 * "is this a picture, which kind, and what size", from the header alone.
 *
 * Sniffing is by MAGIC BYTES, never by extension. The extension is the user's
 * spelling of what they think the file is; the header is what it actually is,
 * and the caption call must not be made about bytes the API will reject.
 */

export type ImageFormat = "png" | "jpeg" | "gif" | "webp" | "bmp";

export interface ImageInfo {
  readonly format: ImageFormat;
  /** Absent when the format's header does not make dimensions cheap (WebP's
   *  three sub-formats, BMP's variants) — never estimated. */
  readonly width?: number;
  readonly height?: number;
}

/** MIME type for the data URI the captioner sends. */
export function imageMimeType(format: ImageFormat): string {
  return `image/${format}`;
}

/**
 * Identify an image from its leading bytes, or null for anything else.
 *
 * Only the formats the DeepSeek vision API accepts are recognized. An
 * unrecognized picture (AVIF, HEIC, SVG, TIFF) deliberately falls through to
 * the ordinary text/binary path rather than being stored as an image that can
 * never be captioned — the honest row for those is today's `binary`.
 */
export function sniffImage(bytes: Buffer): ImageInfo | null {
  if (bytes.length < 12) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A, then IHDR with width/height as BE u32.
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    // IHDR must be the first chunk; if it is not, the file is malformed and
    // the dimensions are simply unknown (the caption still works).
    if (bytes.length >= 24 && bytes.toString("ascii", 12, 16) === "IHDR") {
      return {
        format: "png",
        width: bytes.readUInt32BE(16),
        height: bytes.readUInt32BE(20),
      };
    }
    return { format: "png" };
  }

  // JPEG: FF D8 FF. Dimensions live in a SOF marker somewhere after the
  // header, so walk the segment chain.
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    const size = jpegSize(bytes);
    return size === null ? { format: "jpeg" } : { format: "jpeg", ...size };
  }

  // GIF: "GIF87a" / "GIF89a", then width/height as LE u16.
  if (bytes.toString("ascii", 0, 3) === "GIF") {
    return {
      format: "gif",
      width: bytes.readUInt16LE(6),
      height: bytes.readUInt16LE(8),
    };
  }

  // WebP: RIFF....WEBP. Dimensions differ per sub-format (VP8/VP8L/VP8X);
  // not worth three parsers for a row detail.
  if (
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return { format: "webp" };
  }

  // BMP: "BM".
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return { format: "bmp" };

  return null;
}

/**
 * Walk a JPEG's segment chain to the first Start-Of-Frame and read its
 * dimensions. Returns null on anything unexpected — a truncated file, a
 * progressive variant this walk does not reach, an arithmetic-coded frame.
 * Dimensions are a nicety; refusing to guess is the contract.
 */
function jpegSize(bytes: Buffer): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1] as number;
    // Standalone markers carry no length payload.
    if (
      marker === 0xd8 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      i += 2;
      continue;
    }
    // SOS: entropy-coded data follows; no SOF was found before it.
    if (marker === 0xda) return null;
    const length = bytes.readUInt16BE(i + 2);
    if (length < 2) return null;
    // SOF0-SOF15 except the DHT/JPG/DAC markers interleaved in that range.
    const isSof =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isSof) {
      // Payload: precision(1) height(2) width(2)
      return {
        height: bytes.readUInt16BE(i + 5),
        width: bytes.readUInt16BE(i + 7),
      };
    }
    i += 2 + length;
  }
  return null;
}
