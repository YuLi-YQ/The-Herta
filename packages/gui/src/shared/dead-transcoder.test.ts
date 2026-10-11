import { describe, expect, it } from "vitest";
import { isDeadTranscoderAsset } from "./dead-transcoder.js";

describe("isDeadTranscoderAsset (ADR 0057 §6.5)", () => {
  it("names three's own emitted copy of the Basis transcoder under assets/, never the scheme-served one", () => {
    expect(isDeadTranscoderAsset("assets/basis_transcoder-Cw3kYy1a.wasm")).toBe(
      true,
    );
    expect(isDeadTranscoderAsset("assets/basis_transcoder-DkQ9x1.js")).toBe(
      true,
    );
    expect(
      isDeadTranscoderAsset("device-scene/basis/basis_transcoder.wasm"),
    ).toBe(false);
    expect(isDeadTranscoderAsset("assets/index-abc123.js")).toBe(false);
    expect(isDeadTranscoderAsset("assets/basis_transcoder-x.map")).toBe(false);
  });
});
