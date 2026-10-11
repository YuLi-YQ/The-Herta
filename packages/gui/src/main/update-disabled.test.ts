import { describe, expect, it } from "vitest";
import { createDisabledUpdateService } from "./update-service.js";

describe("personal desktop updater policy", () => {
  it("keeps update checks and installation disabled after start and attempted re-enabling", async () => {
    const service = createDisabledUpdateService();
    service.start();
    service.setAutoEnabled(true);
    expect(service.current()).toEqual({ phase: "idle", unsupported: true });
    await expect(service.checkNow()).rejects.toThrow("禁用自动更新");
    expect(() => service.restartAndInstall()).toThrow("禁用自动更新");
    expect(service.current()).toEqual({ phase: "idle", unsupported: true });
    service.dispose();
  });
});
