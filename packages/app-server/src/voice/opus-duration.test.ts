import { describe, expect, it } from "vitest";
import { opusDurationMs, readOpusDurationMs } from "./opus-duration.js";

/** Build one Ogg page. Each segment must be < 255 bytes so the lacing table
 *  is one byte per segment (all these fixtures are tiny). CRC is left zero —
 *  the parser walks structure only, like a player skipping CRC checks. */
function oggPage(granule: bigint, segments: readonly Buffer[]): Buffer {
  const header = Buffer.alloc(27);
  header.write("OggS", 0, "ascii");
  header.writeUInt8(0, 4); // version
  header.writeUInt8(0, 5); // header type
  header.writeBigUInt64LE(granule, 6);
  header.writeUInt32LE(1, 14); // serial
  header.writeUInt32LE(0, 18); // page seq
  header.writeUInt32LE(0, 22); // crc (unchecked)
  header.writeUInt8(segments.length, 26);
  const lacing = Buffer.from(segments.map((s) => s.length));
  return Buffer.concat([header, lacing, ...segments]);
}

/** Minimal 19-byte OpusHead (RFC 7845 §5.1): magic, version 1, 1 channel,
 *  preSkip, 48 kHz input rate, 0 gain, mapping family 0. */
function opusHead(preSkip: number): Buffer {
  const b = Buffer.alloc(19);
  b.write("OpusHead", 0, "ascii");
  b.writeUInt8(1, 8); // version
  b.writeUInt8(1, 9); // channels
  b.writeUInt16LE(preSkip, 10);
  b.writeUInt32LE(48000, 12);
  return b;
}

const NO_PACKET = 0xffffffffffffffffn;
const audio = Buffer.from([0xfc, 0x00, 0x01]); // opaque packet bytes

describe("opusDurationMs", () => {
  it("duration = (last granule − preSkip) / 48 kHz", () => {
    const buf = Buffer.concat([
      oggPage(0n, [opusHead(312)]),
      oggPage(0n, [Buffer.from("OpusTagsxxxx", "ascii")]),
      oggPage(24312n, [audio]),
      oggPage(48312n, [audio]),
    ]);
    expect(opusDurationMs(buf)).toBe(1000); // (48312 − 312) / 48
  });

  it("ignores continuation pages whose granule is -1 (no packet ends there)", () => {
    const buf = Buffer.concat([
      oggPage(0n, [opusHead(0)]),
      oggPage(4800n, [audio]),
      oggPage(NO_PACKET, [audio]),
    ]);
    expect(opusDurationMs(buf)).toBe(100); // trailing -1 page doesn't regress it
  });

  it("null on: not Ogg, first page not OpusHead, truncated page, no audio page", () => {
    expect(opusDurationMs(Buffer.from("RIFFxxxxWAVE"))).toBeNull();
    expect(
      opusDurationMs(oggPage(0n, [Buffer.from("NotOpusHead", "ascii")])),
    ).toBeNull();
    const truncated = Buffer.concat([
      oggPage(0n, [opusHead(0)]),
      oggPage(4800n, [audio]),
    ]).subarray(0, 30);
    expect(opusDurationMs(truncated)).toBeNull();
    expect(opusDurationMs(oggPage(0n, [opusHead(0)]))).toBeNull(); // head only
    expect(opusDurationMs(Buffer.alloc(0))).toBeNull();
  });

  it("null when the last granule does not exceed preSkip (empty audio)", () => {
    const buf = Buffer.concat([
      oggPage(0n, [opusHead(312)]),
      oggPage(312n, [audio]),
    ]);
    expect(opusDurationMs(buf)).toBeNull();
  });
});

describe("readOpusDurationMs", () => {
  it("resolves null for a missing file (best-effort, never throws)", async () => {
    await expect(
      readOpusDurationMs("Z:\\does\\not\\exist\\clip.opus"),
    ).resolves.toBeNull();
  });
});
