import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { imageMimeType, sniffImage } from "./image.js";
import { makeGif, makeJpeg, makePng } from "./testing/image-fixtures.js";

describe("sniffImage", () => {
  it("reads a PNG's dimensions from IHDR", () => {
    expect(sniffImage(makePng(1920, 1080))).toEqual({
      format: "png",
      width: 1920,
      height: 1080,
    });
  });

  it("reads a GIF's dimensions from its header", () => {
    expect(sniffImage(makeGif(48, 32))).toEqual({
      format: "gif",
      width: 48,
      height: 32,
    });
  });

  it("walks a JPEG's segment chain to SOF0", () => {
    expect(sniffImage(makeJpeg(640, 480))).toEqual({
      format: "jpeg",
      width: 640,
      height: 480,
    });
  });

  it("skips intervening JPEG segments (EXIF/JFIF) to reach the frame", () => {
    // A real camera JPEG carries APP0/APP1 before SOF0; a walk that assumed
    // the frame came first would read dimensions out of the EXIF payload.
    const app1 = Buffer.alloc(4 + 60);
    app1.writeUInt16BE(0xffe1, 0);
    app1.writeUInt16BE(62, 2); // length covers itself
    const jpeg = makeJpeg(800, 600);
    const withExif = Buffer.concat([
      jpeg.subarray(0, 2),
      app1,
      jpeg.subarray(2),
    ]);
    expect(sniffImage(withExif)).toEqual({
      format: "jpeg",
      width: 800,
      height: 600,
    });
  });

  it("identifies WebP and BMP without claiming dimensions", () => {
    const webp = Buffer.concat([
      Buffer.from("RIFF", "ascii"),
      Buffer.alloc(4),
      Buffer.from("WEBPVP8 ", "ascii"),
      Buffer.alloc(16),
    ]);
    expect(sniffImage(webp)).toEqual({ format: "webp" });

    const bmp = Buffer.concat([Buffer.from("BM", "ascii"), Buffer.alloc(40)]);
    expect(sniffImage(bmp)).toEqual({ format: "bmp" });
  });

  it("sniffs by magic bytes, not by extension", () => {
    // The extension is the user's claim; the header is the fact. A .png that
    // is really text must not be sent to a vision model as an image.
    expect(sniffImage(Buffer.from("this is plain text, not a picture\n"))).toBe(
      null,
    );
  });

  it("returns null for image formats the vision API cannot read", () => {
    // AVIF/HEIC (ISO-BMFF 'ftyp') deliberately fall through to the ordinary
    // binary path rather than becoming an image row that can never be read.
    const avif = Buffer.concat([
      Buffer.alloc(4),
      Buffer.from("ftypavif", "ascii"),
      Buffer.alloc(16),
    ]);
    expect(sniffImage(avif)).toBe(null);

    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(sniffImage(svg)).toBe(null);
  });

  it("survives a truncated or malformed file without throwing", () => {
    expect(sniffImage(Buffer.alloc(0))).toBe(null);
    expect(sniffImage(Buffer.from([0x89, 0x50, 0x4e]))).toBe(null);

    // PNG signature with a non-IHDR first chunk: still a PNG, dimensions
    // unknown — never guessed.
    const odd = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(4),
      Buffer.from("sRGB", "ascii"),
      Buffer.alloc(16),
    ]);
    expect(sniffImage(odd)).toEqual({ format: "png" });

    // JPEG whose entropy-coded data starts before any frame header.
    const sos = Buffer.from([
      0xff, 0xd8, 0xff, 0xda, 0x00, 0x08, 0, 0, 0, 0, 0, 0,
    ]);
    expect(sniffImage(sos)).toEqual({ format: "jpeg" });
  });

  it("a PNG larger than one chunk still parses (deflate payload ignored)", () => {
    const big = makePng(64, 64, deflateSync(Buffer.alloc(64 * 65)));
    expect(sniffImage(big)).toMatchObject({ width: 64, height: 64 });
  });
});

describe("imageMimeType", () => {
  it("maps each format to its data-URI type", () => {
    expect(imageMimeType("png")).toBe("image/png");
    expect(imageMimeType("jpeg")).toBe("image/jpeg");
    expect(imageMimeType("webp")).toBe("image/webp");
  });
});
