import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveDeepSeekKey } from "./resolve-deepseek-key.js";

let tmpRepo: string;
let tmpHome: string;
let prevEnv: string | undefined;

beforeEach(async () => {
  tmpRepo = await mkdtemp(join(tmpdir(), "herta-repo-"));
  tmpHome = await mkdtemp(join(tmpdir(), "herta-home-"));
  prevEnv = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
});

afterEach(async () => {
  if (prevEnv === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = prevEnv;
  await rm(tmpRepo, { recursive: true, force: true });
  await rm(tmpHome, { recursive: true, force: true });
});

describe("resolveDeepSeekKey", () => {
  it("returns env var when set", async () => {
    process.env.DEEPSEEK_API_KEY = "sk-env";
    const key = await resolveDeepSeekKey({ cwd: tmpRepo, homedir: tmpHome });
    expect(key).toBe("sk-env");
  });

  it("trims env var", async () => {
    process.env.DEEPSEEK_API_KEY = "  sk-env  \n";
    const key = await resolveDeepSeekKey({ cwd: tmpRepo, homedir: tmpHome });
    expect(key).toBe("sk-env");
  });

  it("env wins over repo file", async () => {
    process.env.DEEPSEEK_API_KEY = "sk-env";
    await writeFile(join(tmpRepo, "deepseek-api-key.txt"), "sk-repo");
    const key = await resolveDeepSeekKey({ cwd: tmpRepo, homedir: tmpHome });
    expect(key).toBe("sk-env");
  });

  it("repo file wins over homedir file", async () => {
    await writeFile(join(tmpRepo, "deepseek-api-key.txt"), "sk-repo\n");
    await mkdir(join(tmpHome, ".herta", "keys"), { recursive: true });
    await writeFile(join(tmpHome, ".herta", "keys", "deepseek"), "sk-home");
    const key = await resolveDeepSeekKey({ cwd: tmpRepo, homedir: tmpHome });
    expect(key).toBe("sk-repo");
  });

  it("homedir file used when others absent", async () => {
    await mkdir(join(tmpHome, ".herta", "keys"), { recursive: true });
    await writeFile(join(tmpHome, ".herta", "keys", "deepseek"), "sk-home\n");
    const key = await resolveDeepSeekKey({ cwd: tmpRepo, homedir: tmpHome });
    expect(key).toBe("sk-home");
  });

  it("whitespace-only repo file falls through to homedir", async () => {
    await writeFile(join(tmpRepo, "deepseek-api-key.txt"), "   \n");
    await mkdir(join(tmpHome, ".herta", "keys"), { recursive: true });
    await writeFile(join(tmpHome, ".herta", "keys", "deepseek"), "sk-home");
    const key = await resolveDeepSeekKey({ cwd: tmpRepo, homedir: tmpHome });
    expect(key).toBe("sk-home");
  });

  it("throws ProviderError{missing-key} when nothing is found", async () => {
    await expect(
      resolveDeepSeekKey({ cwd: tmpRepo, homedir: tmpHome }),
    ).rejects.toMatchObject({
      name: "ProviderError",
      code: "missing-key",
      retryable: false,
    });
  });
});
