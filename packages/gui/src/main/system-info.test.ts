import { arch, release } from "node:os";
import { describe, expect, it } from "vitest";
import { systemInfo } from "./system-info.js";

describe("systemInfo (R125 /feedback)", () => {
  it("says the OS, its version and the architecture, and nothing that names the user or the computer", () => {
    const info = systemInfo();
    expect(info).toEqual({
      platform: process.platform,
      release: release(),
      arch: arch(),
    });
    expect(Object.keys(info).sort()).toEqual(["arch", "platform", "release"]);
  });
});
