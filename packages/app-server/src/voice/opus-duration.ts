import { readFile } from "node:fs/promises";

/**
 * Duration (ms) of an Ogg/Opus clip, parsed from its container pages, or
 * `null` if the buffer isn't an Ogg/Opus stream we can read. Walks the Ogg
 * pages via their segment tables (no byte-pattern scanning, so payload bytes
 * that happen to contain "OggS" can't fool it): the first page must carry the
 * `OpusHead` (→ preSkip), and the duration is the last finished-packet
 * granule position minus preSkip, at Opus's fixed 48 kHz granule rate —
 * `durationMs = (lastGranule − preSkip) / 48`. Returns `null` on a malformed
 * header, a truncated page, or a stream with no finished packet.
 *
 * Replaces the WAV-header reader (2026-07-16 wav→opus cutover): used to match
 * the opening's text-stream cadence to its voice clip (SPEC 2026-06-23).
 * Pure (no I/O) so it's unit-testable with synthesized pages.
 */
export function opusDurationMs(buf: Buffer): number | null {
  // Ogg page: OggS(4) ver(1) type(1) granule(8 LE) serial(4) seq(4) crc(4)
  //           segCount(1) segTable(segCount) payload(sum of segTable).
  const NO_PACKET = 0xffffffffffffffffn; // granule -1: no packet ends here
  let offset = 0;
  let preSkip: number | null = null;
  let lastGranule: bigint | null = null;
  while (offset + 27 <= buf.length) {
    if (buf.toString("ascii", offset, offset + 4) !== "OggS") return null;
    const granule = buf.readBigUInt64LE(offset + 6);
    const segCount = buf.readUInt8(offset + 26);
    const payloadStart = offset + 27 + segCount;
    if (payloadStart > buf.length) return null;
    let payloadLen = 0;
    for (let i = 0; i < segCount; i++) {
      payloadLen += buf.readUInt8(offset + 27 + i);
    }
    const pageEnd = payloadStart + payloadLen;
    if (pageEnd > buf.length) return null;
    if (preSkip === null) {
      // First page: must be the OpusHead (id header). preSkip is the sample
      // count a decoder discards before playback starts — excluded from the
      // audible duration per RFC 7845 §4.2.
      if (
        payloadLen < 19 ||
        buf.toString("ascii", payloadStart, payloadStart + 8) !== "OpusHead"
      ) {
        return null;
      }
      preSkip = buf.readUInt16LE(payloadStart + 10);
    }
    if (granule !== NO_PACKET) lastGranule = granule;
    offset = pageEnd;
  }
  if (preSkip === null || lastGranule === null) return null;
  const samples = lastGranule - BigInt(preSkip);
  if (samples <= 0n) return null;
  return Number(samples) / 48; // 48 samples per ms at the 48 kHz granule rate
}

/**
 * Best-effort `opusDurationMs` from a file path. Any error (missing /
 * unreadable) resolves to `null` — voice timing is non-essential and must
 * never break the opening.
 */
export async function readOpusDurationMs(path: string): Promise<number | null> {
  try {
    // Clips are small (≤ ~200 KB as Opus); reading the whole file keeps the
    // parser buffer-simple, same stance as the old WAV reader.
    return opusDurationMs(await readFile(path));
  } catch {
    return null;
  }
}
