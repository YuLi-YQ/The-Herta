import { describe, expect, it } from "vitest";
import { en } from "./messages/en.js";
import { zh } from "./messages/zh.js";

describe("don't-touch tokens survive localization", () => {
  it("banzhuan.intro keeps the literal @板砖 dispatch token in every locale", () => {
    for (const cat of [zh, en] as Array<Record<string, string>>) {
      expect(cat["banzhuan.intro"]).toContain("@板砖");
    }
  });

  it("no value mangles the dispatch token (@板砖 only — never @Brick or @板<other>)", () => {
    for (const cat of [zh, en] as Array<Record<string, string>>) {
      for (const v of Object.values(cat)) {
        expect(v).not.toContain("@Brick");
        // every "@板" occurrence must be the full "@板砖"
        expect(v.replace(/@板砖/g, "")).not.toContain("@板");
      }
    }
  });

  it("no value contains a real-looking sk- API key echo or window.herta literal", () => {
    for (const cat of [zh, en] as Array<Record<string, string>>) {
      for (const v of Object.values(cat)) {
        expect(v).not.toMatch(/\bsk-[a-z0-9]{6,}/i);
        expect(v).not.toContain("window.herta");
      }
    }
  });
});
