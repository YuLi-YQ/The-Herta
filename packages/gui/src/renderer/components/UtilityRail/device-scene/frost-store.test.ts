import { afterEach, describe, expect, it } from "vitest";
import { clearFrostForTest, readFrost, writeFrost } from "./frost-store.js";

describe("frost-store (ADR 0057 §2.13)", () => {
  afterEach(() => clearFrostForTest());

  it("round-trips a data URL per theme and starts empty", () => {
    expect(readFrost("light")).toBeNull();
    writeFrost("light", "data:image/jpeg;base64,AAAA");
    expect(readFrost("light")).toBe("data:image/jpeg;base64,AAAA");
    expect(readFrost("dark")).toBeNull();
  });

  it("refuses anything that is not a small image data URL", () => {
    writeFrost("dark", "javascript:alert(1)");
    expect(readFrost("dark")).toBeNull();
    writeFrost("dark", `data:image/jpeg;base64,${"A".repeat(70_000)}`);
    expect(readFrost("dark")).toBeNull();
    // A foreign value under the key is not served either.
    localStorage.setItem("herta.deviceScene.frost.dark", "hello");
    expect(readFrost("dark")).toBeNull();
  });
});
