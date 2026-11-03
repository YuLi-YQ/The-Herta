import type { MessageImage } from "@herta/providers/images";

/** Longest side a rescaled picture keeps: ample for screenshots and photos to stay legible. */
const LONGEST_SIDE = 2048;
const LIMIT = 2 * 1024 * 1024;

/**
 * R77: a workbench picture the request cannot carry as it is (over the 2 MB per-picture limit)
 * is rescaled with the platform codec before it goes to the model: longest side 2048 px, PNG
 * when that fits, else JPEG. Only PNG and JPEG decode here; anything else, or a picture that
 * still does not fit, returns null and the turn says so. The stored copy is never changed.
 */
export async function prepareAttachedImage(
  bytes: Buffer,
): Promise<MessageImage | null> {
  const { nativeImage } = await import("electron");
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) return null;
  const { width, height } = image.getSize();
  const scale = Math.min(1, LONGEST_SIDE / Math.max(width, height));
  const sized =
    scale < 1
      ? image.resize({
          width: Math.max(1, Math.round(width * scale)),
          height: Math.max(1, Math.round(height * scale)),
          quality: "best",
        })
      : image;
  const candidates: [MessageImage["mimeType"], () => Buffer][] = [
    ["image/png", () => sized.toPNG()],
    ["image/jpeg", () => sized.toJPEG(85)],
    ["image/jpeg", () => sized.toJPEG(70)],
  ];
  for (const [mimeType, encode] of candidates) {
    const out = encode();
    if (out.length > 0 && out.length <= LIMIT)
      return { mimeType, data: out.toString("base64") };
  }
  return null;
}
