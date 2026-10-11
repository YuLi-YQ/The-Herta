import { describe, expect, it } from "vitest";
import { resolveWindowsShim } from "./shim-wrapper.js";

const isWin = process.platform === "win32";

describe("resolveWindowsShim", () => {
  it("is a no-op on non-Windows (POSIX runs shims directly)", () => {
    if (isWin) return;
    const r = resolveWindowsShim(["npm", "run", "build"]);
    expect(r.kind).toBe("unwrapped");
    if (r.kind !== "unsafe_args")
      expect(r.argv).toEqual(["npm", "run", "build"]);
  });

  it("leaves non-shim commands unwrapped on every platform", () => {
    const r = resolveWindowsShim(["node", "script.js"]);
    expect(r.kind).toBe("unwrapped");
    if (r.kind !== "unsafe_args") expect(r.argv).toEqual(["node", "script.js"]);
  });

  describe.skipIf(!isWin)("Windows", () => {
    it("rejects args containing cmd metacharacters", () => {
      const r = resolveWindowsShim(["npm", "run", "build && del *"]);
      expect(r.kind).toBe("unsafe_args");
      if (r.kind === "unsafe_args") expect(r.offending).toContain("&&");
    });

    it("wraps a known shim in cmd /c with the resolved shim path when present", () => {
      // pnpm/npm may or may not be installed on the CI runner; only assert
      // the wrapping SHAPE when resolution succeeds, else the unwrapped
      // (let-ENOENT-report) fallback.
      const r = resolveWindowsShim(["npm", "--version"]);
      if (r.kind === "wrapped") {
        expect(r.argv[0]).toBe("cmd");
        expect(r.argv[1]).toBe("/c");
        expect(String(r.argv[2]).toLowerCase()).toContain("npm");
        expect(r.argv[3]).toBe("--version");
      } else {
        expect(r.kind).toBe("unwrapped");
      }
    });
  });
});
