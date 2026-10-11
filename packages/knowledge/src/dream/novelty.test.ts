import { describe, expect, it } from "vitest";
import { normalizeTitle, titleNoveltyOk } from "./novelty.js";

describe("novelty", () => {
  it("rejects an exact-duplicate title", () => {
    expect(titleNoveltyOk("午后的噪声", ["午后的噪声"])).toBe(false);
  });
  it("accepts a clearly distinct title", () => {
    expect(titleNoveltyOk("地下室的回声", ["午后的噪声"])).toBe(true);
  });
  it("exempts the （其N）series convention", () => {
    expect(
      titleNoveltyOk("远程办公的一百种无聊方式（其七）", [
        "远程办公的一百种无聊方式（其一）",
      ]),
    ).toBe(true);
  });
  it("normalizeTitle strips the （其N）suffix and whitespace", () => {
    expect(normalizeTitle("远程办公（其三） ")).toBe("远程办公");
  });
  it("a raw title dedups against its filename-sanitized form (audit finding 24)", () => {
    // promoteCandidate stores `Unix/Windows 的抉择` as `Unix_Windows…` in the
    // filename, and existingTitles() reads titles back from filenames — the
    // raw re-submission must still be caught by the pre-screen.
    expect(titleNoveltyOk("Unix/Windows 的抉择", ["Unix_Windows 的抉择"])).toBe(
      false,
    );
    expect(normalizeTitle("午后:噪声?")).toBe("午后_噪声_");
  });
  it("case-folds EN titles for comparison (audit 2026-07-16)", () => {
    // "The Same Evening" vs "the same evening" must not pass the pre-screen.
    expect(titleNoveltyOk("The Same Evening", ["the same evening"])).toBe(
      false,
    );
    expect(titleNoveltyOk("A DIFFERENT evening", ["the same evening"])).toBe(
      true,
    );
    // The fold also applies through the （其N）series exemption's base compare.
    expect(
      titleNoveltyOk("Boring remote work（其二）", [
        "boring remote work（其一）",
      ]),
    ).toBe(true);
    // Comparison-only: normalizeTitle lowercases, but callers keep stored
    // titles/filenames in their original case.
    expect(normalizeTitle("The Same Evening")).toBe("the same evening");
  });
});
