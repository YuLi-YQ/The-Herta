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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionGoalStore } from "./session-goal-store.js";

const faults = vi.hoisted(() => ({ write: false }));
vi.mock("@herta/core", async (original) => {
  const actual = await original<typeof import("@herta/core")>();
  return {
    ...actual,
    writeFileAtomicSync: (
      ...args: Parameters<typeof actual.writeFileAtomicSync>
    ) => {
      if (faults.write) throw new Error("synthetic disk failure");
      return actual.writeFileAtomicSync(...args);
    },
  };
});
let root: string;
const links: string[] = [];
beforeEach(() => {
  faults.write = false;
  root = mkdtempSync(join(tmpdir(), "herta-goals-"));
});
afterEach(() => {
  for (const link of links.splice(0)) unlinkSync(link);
  rmSync(root, { recursive: true, force: true });
});
const path = () => join(root, ".herta", "goals", "s.json");

describe("SessionGoalStore (F09)", () => {
  it("reads absence without writing; changes persist, ended history stays separate and stale writes fail", () => {
    const store = new SessionGoalStore(root, "s");
    expect(store.read()).toEqual({
      ok: true,
      view: { state: { revision: 0, active: null, history: [] } },
    });
    expect(existsSync(join(root, ".herta"))).toBe(false);
    expect(store.update(0, { type: "set", text: "First goal" })).toMatchObject({
      ok: true,
      view: { state: { revision: 1, active: { text: "First goal" } } },
    });
    const restarted = new SessionGoalStore(root, "s");
    expect(restarted.context("en")).toContain('"First goal"');
    expect(restarted.update(0, { type: "set", text: "Stale" })).toMatchObject({
      ok: false,
      reason: "conflict",
    });
    expect(
      restarted.update(1, {
        type: "end",
        status: "done",
        result: "Verified result",
      }),
    ).toMatchObject({
      ok: true,
      view: {
        state: {
          revision: 2,
          active: null,
          history: [
            { text: "First goal", status: "done", result: "Verified result" },
          ],
        },
      },
    });
    expect(restarted.context("en")).toBe("");
    expect(restarted.update(2, { type: "set", text: "Next goal" }).ok).toBe(
      true,
    );
    expect(restarted.read()).toMatchObject({
      view: {
        state: { active: { text: "Next goal" }, history: [{ status: "done" }] },
      },
    });
  });

  it("preserves disk and last readable state when a write fails; equal text is a no-op", () => {
    const store = new SessionGoalStore(root, "s");
    store.update(0, { type: "set", text: "Kept" });
    const bytes = readFileSync(path());
    faults.write = true;
    expect(store.update(1, { type: "set", text: "Kept" }).ok).toBe(true);
    expect(
      store.update(1, { type: "set", text: "Not committed" }),
    ).toMatchObject({
      ok: false,
      reason: "storage",
      view: { state: { revision: 1, active: { text: "Kept" } } },
    });
    expect(readFileSync(path())).toEqual(bytes);
    expect(store.context("en")).toContain('"Kept"');
  });

  it.each([
    "bad json",
    JSON.stringify({ version: 2 }),
    JSON.stringify({
      version: 1,
      sessionId: "s",
      state: { revision: 0, active: null, history: [] },
      futureField: true,
    }),
    JSON.stringify({ version: 1, sessionId: "other", state: {} }),
  ])("preserves damaged/future/mismatched state until explicit reset: %s", (raw) => {
    const store = new SessionGoalStore(root, "s");
    mkdirSync(join(root, ".herta", "goals"), { recursive: true });
    writeFileSync(path(), raw);
    expect(store.read()).toMatchObject({ ok: true, view: { damaged: true } });
    expect(store.update(0, { type: "set", text: "Overwrite?" })).toMatchObject({
      ok: false,
      reason: "damaged",
    });
    expect(() => store.context("zh")).toThrow(/cannot be read/);
    expect(readFileSync(path(), "utf8")).toBe(raw);
    expect(store.update(0, { type: "reset" })).toMatchObject({
      ok: true,
      view: { state: { revision: 0, active: null } },
    });
    const backups = readdirSync(join(root, ".herta", "goals")).filter((name) =>
      name.startsWith("s.json.damaged-"),
    );
    expect(backups).toHaveLength(1);
    expect(
      readFileSync(join(root, ".herta", "goals", backups[0]!), "utf8"),
    ).toBe(raw);
    expect(store.update(0, { type: "set", text: "Recovered" }).ok).toBe(true);
    store.remove();
    expect(existsSync(path())).toBe(false);
    expect(existsSync(join(root, ".herta", "goals", backups[0]!))).toBe(true);
  });

  it("refuses reset of healthy data and validates the shape before creating anything", () => {
    const store = new SessionGoalStore(root, "s");
    expect(store.update(0, { type: "reset" })).toMatchObject({
      ok: false,
      reason: "invalid",
    });
    expect(
      store.update(0, { type: "set", text: "x".repeat(501) }),
    ).toMatchObject({ ok: false, reason: "invalid" });
    expect(existsSync(join(root, ".herta"))).toBe(false);
    expect(() => new SessionGoalStore(root, "../outside")).toThrow(/session/);
  });

  it.each([
    ".herta",
    "goals",
    "file",
  ])("rejects a link at %s rather than reading or replacing its target", (part) => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    const target = join(outside, "data.json");
    writeFileSync(target, "keep synthetic bytes");
    let link: string;
    if (part === ".herta") link = join(root, ".herta");
    else {
      mkdirSync(join(root, ".herta"));
      link = join(root, ".herta", "goals");
    }
    if (part === "file") {
      mkdirSync(link);
      link = join(link, "s.json");
    }
    symlinkSync(
      part === "file" ? target : outside,
      link,
      part === "file" ? "file" : "junction",
    );
    links.push(link);
    const store = new SessionGoalStore(root, "s");
    expect(store.read()).toMatchObject({ ok: false, reason: "storage" });
    expect(
      store.update(0, { type: "set", text: "Do not write" }),
    ).toMatchObject({ ok: false, reason: "storage" });
    expect(store.update(0, { type: "reset" })).toMatchObject({
      ok: false,
      reason: "storage",
    });
    expect(() => store.remove()).toThrow(/Unsafe/);
    expect(readFileSync(target, "utf8")).toBe("keep synthetic bytes");
  });
});
