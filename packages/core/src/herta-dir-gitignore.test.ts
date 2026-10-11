import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureHertaGitignore } from "./herta-dir-gitignore.js";

describe("ensureHertaGitignore (audit BL6)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "herta-ignore-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const file = () => join(root, ".herta", ".gitignore");

  it("writes a self-ignoring .gitignore, creating the dir if needed", () => {
    ensureHertaGitignore(root);
    const body = readFileSync(file(), "utf8");
    // `*` covers the .gitignore itself, so creating it does not itself show up
    // as an untracked change.
    expect(body).toContain("*");
    expect(body.split("\n").some((l) => l.trim() === "*")).toBe(true);
  });

  it("never overwrites one the user has edited", () => {
    mkdirSync(join(root, ".herta"), { recursive: true });
    writeFileSync(file(), "!keep-this\n", "utf8");
    ensureHertaGitignore(root);
    expect(readFileSync(file(), "utf8")).toBe("!keep-this\n");
  });

  it("is idempotent", () => {
    ensureHertaGitignore(root);
    const first = readFileSync(file(), "utf8");
    ensureHertaGitignore(root);
    expect(readFileSync(file(), "utf8")).toBe(first);
  });

  it("swallows an unwritable root rather than failing the session", () => {
    // A read-only workspace, a path that is a file, a race with another
    // process — none of these should take down the operation that happened to
    // be first to create the directory.
    const asFile = join(root, "not-a-dir");
    writeFileSync(asFile, "x", "utf8");
    expect(() => ensureHertaGitignore(asFile)).not.toThrow();
    expect(existsSync(join(asFile, ".herta", ".gitignore"))).toBe(false);
  });
});
