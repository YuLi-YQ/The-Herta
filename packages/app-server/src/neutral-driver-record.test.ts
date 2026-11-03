import { describe, expect, it, vi } from "vitest";
import { NeutralDriver } from "./neutral-driver.js";

describe("NeutralDriver atomic record replacement", () => {
  it("keeps memory unchanged on persistence failure or an unresolved batch", () => {
    const replaceBlocksAt = vi.fn().mockImplementation(() => {
      throw new Error("disk full");
    });
    const driver = new NeutralDriver({
      sessionId: "atomic-record",
      journalPath: "unused-audit-journal",
      persister: { replaceBlocksAt },
      sink: { setPersistHook() {} },
    } as never);
    const before = [
      { kind: "system", label: "系统", body: "one" },
      { kind: "system", label: "系统", body: "two" },
    ] as const;
    const changes = before.map((block, index) => ({
      index,
      block: { ...block, body: "changed" },
    }));
    driver.loadRecord(before);
    expect(() => driver.replaceBlocksAt(changes)).toThrow("disk full");
    expect(driver.getRecord()).toEqual(before);
    replaceBlocksAt.mockReturnValue(false);
    expect(driver.replaceBlocksAt(changes)).toBe(false);
    expect(driver.getRecord()).toEqual(before);
    replaceBlocksAt.mockReturnValue(true);
    expect(driver.replaceBlocksAt(changes)).toBe(true);
    expect(
      driver.getRecord().map((block) => block.kind === "system" && block.body),
    ).toEqual(["changed", "changed"]);
  });
});
