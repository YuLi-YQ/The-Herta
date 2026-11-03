import { expect, it, vi } from "vitest";
import { NeutralDriver } from "./neutral-driver.js";

it("keeps the original record when a crossed recap boundary cannot be invalidated", () => {
  const truncate = vi.fn();
  const driver = new NeutralDriver({
    sessionId: "recap-rewind",
    journalPath: "unused-recap-rewind",
    persister: { truncateToBlockCount: truncate },
    sink: { setPersistHook() {} },
    recap: {
      cacheRead: () => ({ boundaryIndex: 2 }),
      cacheInvalidate: () => {
        throw new Error("synthetic invalidation error");
      },
    },
  } as never);
  const record = [
    { kind: "user", text: "first" },
    { kind: "herta", surface: "speech", text: "reply" },
    { kind: "user", text: "second" },
  ] as const;
  driver.loadRecord(record);
  expect(() => driver.rewindLastUserTurn()).toThrow("invalidation error");
  expect(truncate).not.toHaveBeenCalled();
  expect(driver.getRecord()).toEqual(record);
});
