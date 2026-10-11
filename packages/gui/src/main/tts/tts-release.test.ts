import { describe, expect, it } from "vitest";
import {
  TTS_ARCHIVE_BYTES,
  TTS_ARCHIVE_SHA256,
  TTS_ARCHIVE_URL,
  TTS_BUNDLE_BYTES,
} from "./tts-release.js";

/** The pins are what make the download safe; an unfilled pin ships a
 *  download that can never verify. This fails until pack-tts's numbers are
 *  pasted in. */
describe("tts-release pins", () => {
  it("names a release asset on the public repo", () => {
    expect(TTS_ARCHIVE_URL).toMatch(
      /^https:\/\/github\.com\/PersonaCLI\/Herta\/releases\/download\/voice-herta-best-e72\/herta-best-e72\.tar\.gz$/,
    );
  });

  it("carries a real SHA-256 and sizes", () => {
    expect(TTS_ARCHIVE_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(TTS_ARCHIVE_BYTES).toBeGreaterThan(50_000_000);
    expect(TTS_BUNDLE_BYTES).toBeGreaterThan(TTS_ARCHIVE_BYTES);
  });
});
