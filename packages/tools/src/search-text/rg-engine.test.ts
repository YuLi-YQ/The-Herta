import { describe, expect, it } from "vitest";
import { rgRelPath } from "./rg-engine.js";

describe("rgRelPath (platform review 2026-09-23)", () => {
  it("Windows: rg's backslashes become the forward slashes the verifier loads, and the ./ prefix goes", () => {
    expect(rgRelPath(".\\src\\a.ts", "win32")).toBe("src/a.ts");
    expect(rgRelPath("src\\a.ts", "win32")).toBe("src/a.ts");
  });

  it("macOS / Linux: a backslash is part of the NAME and stays — `a\\b.ts` is not `a/b.ts`", () => {
    for (const platform of ["darwin", "linux"] as const) {
      expect(rgRelPath("./notes/a\\b.ts", platform)).toBe("notes/a\\b.ts");
      expect(rgRelPath("src/a.ts", platform)).toBe("src/a.ts");
    }
  });
});
