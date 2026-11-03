import { deflateSync } from "node:zlib";

/** The colours the image probe draws with: far apart, and named the same way by every model. */
const COLORS = {
  red: [220, 38, 38],
  green: [22, 163, 74],
  blue: [37, 99, 235],
  yellow: [234, 179, 8],
  black: [17, 17, 17],
  white: [250, 250, 250],
} as const;
export type ProbeColor = keyof typeof COLORS;
export const PROBE_COLORS = Object.keys(COLORS) as ProbeColor[];
export { COLORS as PROBE_PALETTE };

const SIZE = 128;
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

/**
 * The image probe's picture: four solid squares, each a different colour picked at random, so
 * a model that cannot see it guesses right once in 360 tries. Generated here, never read from
 * disk, and nothing personal goes into it.
 */
export function quadrantPicture(random: () => number = Math.random): {
  readonly png: Buffer;
  /** Top-left, top-right, bottom-left, bottom-right. */
  readonly colors: readonly ProbeColor[];
} {
  const pool = [...PROBE_COLORS];
  const colors: ProbeColor[] = [];
  while (colors.length < 4)
    colors.push(pool.splice(Math.floor(random() * pool.length) % pool.length, 1)[0]!);
  const row = SIZE * 3 + 1;
  const raw = Buffer.alloc(row * SIZE);
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++)
      raw.set(
        COLORS[colors[(y < SIZE / 2 ? 0 : 2) + (x < SIZE / 2 ? 0 : 1)]!],
        y * row + 1 + x * 3,
      );
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour, no alpha
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return { png, colors };
}

/** The colour words of a reply, in order; anything else in it is ignored. */
export function colorsNamed(reply: string): ProbeColor[] {
  const words: string[] = reply.toLowerCase().match(/[a-z]+/g) ?? [];
  return words.filter((word): word is ProbeColor =>
    (PROBE_COLORS as string[]).includes(word),
  );
}
