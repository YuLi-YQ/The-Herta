import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changePlan, emptyPlanState } from "@herta/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionPlanStore } from "./session-plan-store.js";

const faults = vi.hoisted(() => ({ write: false, copy: false }));
vi.mock("@herta/core", async (original) => {
  const actual = await original<typeof import("@herta/core")>();
  return {
    ...actual,
    writeFileAtomicSync: (
      ...args: Parameters<typeof actual.writeFileAtomicSync>
    ) => {
      if (faults.write) throw new Error("synthetic write failure");
      return actual.writeFileAtomicSync(...args);
    },
  };
});
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    copyFileSync: (...args: Parameters<typeof actual.copyFileSync>) => {
      if (faults.copy) throw new Error("synthetic backup failure");
      return actual.copyFileSync(...args);
    },
  };
});
let root: string;
const links: string[] = [];
beforeEach(() => {
  faults.write = false;
  faults.copy = false;
  root = mkdtempSync(join(tmpdir(), "herta-plan-store-"));
});
afterEach(() => {
  for (const link of links.splice(0)) unlinkSync(link);
  rmSync(root, { recursive: true, force: true });
});
const file = () => join(root, ".herta", "plans", "s.json");
const now = "2026-11-01T00:00:00.000Z";
function entered() {
  const result = changePlan(
    emptyPlanState(),
    0,
    { type: "enter" },
    now,
    "workspace-edit",
  );
  if (!result.ok) throw new Error("transition failed");
  return result.view.state;
}
describe("SessionPlanStore", () => {
  it("reads without writes, persists a lock across restart and rejects stale revisions", () => {
    const store = new SessionPlanStore(root, "s");
    expect(store.read()).toMatchObject({
      ok: true,
      view: { locked: false, state: { revision: 0 } },
    });
    expect(existsSync(join(root, ".herta"))).toBe(false);
    expect(store.commit(0, entered()).ok).toBe(true);
    expect(new SessionPlanStore(root, "s").read()).toMatchObject({
      view: {
        locked: true,
        state: { previousMode: "workspace-edit", revision: 1 },
      },
    });
    expect(store.commit(0, entered())).toMatchObject({
      ok: false,
      reason: "conflict",
    });
    faults.write = true;
    expect(store.commit(1, entered()).ok).toBe(true);
    const exit = changePlan(entered(), 1, { type: "exit" }, now);
    if (!exit.ok) throw new Error("exit failed");
    expect(store.commit(1, exit.view.state)).toMatchObject({
      ok: false,
      reason: "storage",
      view: { locked: true },
    });
    expect(store.read()).toMatchObject({ view: { locked: true } });
  });
  it.each([
    "broken",
    '{"version":2}',
    JSON.stringify({
      version: 1,
      sessionId: "s",
      state: emptyPlanState(),
      extra: true,
    }),
    JSON.stringify({ version: 1, sessionId: "other", state: emptyPlanState() }),
  ])("keeps damaged/future content locked until a backed-up read-only reset: %s", (raw) => {
    const store = new SessionPlanStore(root, "s");
    mkdirSync(join(root, ".herta", "plans"), { recursive: true });
    writeFileSync(file(), raw);
    expect(store.read()).toMatchObject({
      view: { damaged: true, locked: true },
    });
    expect(store.commit(0, entered())).toMatchObject({
      ok: false,
      reason: "damaged",
    });
    expect(store.reset(0)).toMatchObject({
      ok: true,
      view: {
        locked: true,
        state: { active: true, revision: 1, previousMode: "read-only" },
      },
    });
    const backups = readdirSync(join(root, ".herta", "plans")).filter((name) =>
      name.includes(".damaged-"),
    );
    expect(backups).toHaveLength(1);
    expect(
      readFileSync(join(root, ".herta", "plans", backups[0]!), "utf8"),
    ).toBe(raw);
    store.remove();
    expect(existsSync(file())).toBe(false);
    expect(existsSync(join(root, ".herta", "plans", backups[0]!))).toBe(true);
  });
  it.each([
    "copy",
    "write",
  ] as const)("does not remove the damaged lock when reset %s fails", (fault) => {
    const store = new SessionPlanStore(root, "s");
    mkdirSync(join(root, ".herta", "plans"), { recursive: true });
    writeFileSync(file(), "keep exact bytes");
    faults[fault] = true;
    expect(store.reset(0)).toMatchObject({
      ok: false,
      reason: "storage",
      view: { locked: true, damaged: true },
    });
    expect(readFileSync(file(), "utf8")).toBe("keep exact bytes");
    expect(store.read()).toMatchObject({
      view: { locked: true, damaged: true },
    });
  });
  it("rejects invalid ids and linked storage without touching the destination", () => {
    expect(() => new SessionPlanStore(root, "../escape")).toThrow();
    const elsewhere = join(root, "destination");
    mkdirSync(elsewhere);
    const link = join(root, ".herta");
    symlinkSync(elsewhere, link, "junction");
    links.push(link);
    const store = new SessionPlanStore(root, "s");
    expect(store.read()).toMatchObject({
      ok: false,
      reason: "storage",
      view: { locked: true },
    });
    expect(store.commit(0, entered())).toMatchObject({
      ok: false,
      reason: "storage",
    });
    expect(readdirSync(elsewhere)).toEqual([]);
  });
  it("rejects oversized state and healthy reset without silently clearing data", () => {
    const store = new SessionPlanStore(root, "s");
    expect(store.reset(0)).toMatchObject({ ok: false, reason: "invalid" });
    mkdirSync(join(root, ".herta", "plans"), { recursive: true });
    writeFileSync(file(), "x".repeat(32 * 1024 * 1024 + 1));
    expect(store.read()).toMatchObject({
      view: { damaged: true, locked: true },
    });
  });
});
