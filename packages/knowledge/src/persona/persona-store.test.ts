import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PersonaStore } from "./persona-store.js";

describe("PersonaStore", () => {
  let dir: string;
  let store: PersonaStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "persona-store-"));
    store = new PersonaStore({ root: dir });
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("load returns undefined when file is missing", () => {
    expect(store.load("wardrobe")).toBeUndefined();
  });

  it("save then load round-trips a structured object", () => {
    const data = { hello: "world", n: 42 };
    store.save("wardrobe", data);
    expect(store.load("wardrobe")).toEqual(data);
  });

  it("save uses atomic write — no partial files visible", () => {
    store.save("wardrobe", { v: 1 });
    const p = path.join(dir, "wardrobe.json");
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.readFileSync(p, "utf8")).toContain('"v": 1');
    const tmp = `${p}.tmp`;
    expect(fs.existsSync(tmp)).toBe(false);
  });

  it("save creates the persona directory if missing", () => {
    fs.rmSync(dir, { recursive: true, force: true });
    store.save("today", { mood: "bored" });
    expect(fs.existsSync(path.join(dir, "today.json"))).toBe(true);
  });

  it("load throws DAMAGED_FILE on JSON parse failure", () => {
    const p = path.join(dir, "wardrobe.json");
    fs.writeFileSync(p, "not json");
    expect(() => store.load("wardrobe")).toThrow(/wardrobe\.json/);
  });
});
