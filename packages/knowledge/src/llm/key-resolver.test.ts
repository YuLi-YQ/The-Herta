import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveDeepSeekApiKey } from "./key-resolver.js";

let workspace: string;
beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "herta-key-"));
  delete process.env.HERTA_DEEPSEEK_API_KEY;
});
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  delete process.env.HERTA_DEEPSEEK_API_KEY;
});

describe("resolveDeepSeekApiKey", () => {
  it("returns missing=true when no env var, no file, no override", async () => {
    const out = await resolveDeepSeekApiKey({ workspaceRoot: workspace });
    expect(out).toEqual({ missing: true });
  });

  it("reads from caller-supplied keyFile when present", async () => {
    const keyFile = join(workspace, "custom-key.txt");
    writeFileSync(keyFile, "  sk-xxxxx  \n", "utf8");
    const out = await resolveDeepSeekApiKey({
      workspaceRoot: workspace,
      keyFile,
    });
    expect(out).toEqual({ key: "sk-xxxxx" });
  });

  it("falls back to HERTA_DEEPSEEK_API_KEY env var when no keyFile", async () => {
    process.env.HERTA_DEEPSEEK_API_KEY = "sk-fromenv";
    const out = await resolveDeepSeekApiKey({ workspaceRoot: workspace });
    expect(out).toEqual({ key: "sk-fromenv" });
  });

  it("falls back to .herta/secrets/deepseek-api-key when no env var", async () => {
    mkdirSync(join(workspace, ".herta/secrets"), { recursive: true });
    writeFileSync(
      join(workspace, ".herta/secrets/deepseek-api-key"),
      "sk-fromfile\n",
      "utf8",
    );
    const out = await resolveDeepSeekApiKey({ workspaceRoot: workspace });
    expect(out).toEqual({ key: "sk-fromfile" });
  });

  it("caller-supplied keyFile beats env var", async () => {
    process.env.HERTA_DEEPSEEK_API_KEY = "sk-fromenv";
    const keyFile = join(workspace, "custom.txt");
    writeFileSync(keyFile, "sk-fromcustom\n", "utf8");
    const out = await resolveDeepSeekApiKey({
      workspaceRoot: workspace,
      keyFile,
    });
    expect(out).toEqual({ key: "sk-fromcustom" });
  });

  it("env var beats default secrets file", async () => {
    mkdirSync(join(workspace, ".herta/secrets"), { recursive: true });
    writeFileSync(
      join(workspace, ".herta/secrets/deepseek-api-key"),
      "sk-fromfile\n",
      "utf8",
    );
    process.env.HERTA_DEEPSEEK_API_KEY = "sk-fromenv";
    const out = await resolveDeepSeekApiKey({ workspaceRoot: workspace });
    expect(out).toEqual({ key: "sk-fromenv" });
  });

  it("returns missing=true when env var is empty string", async () => {
    process.env.HERTA_DEEPSEEK_API_KEY = "";
    const out = await resolveDeepSeekApiKey({ workspaceRoot: workspace });
    expect(out).toEqual({ missing: true });
  });

  it("returns missing=true when keyFile exists but is whitespace-only", async () => {
    const keyFile = join(workspace, "blank.txt");
    writeFileSync(keyFile, "   \n  \n", "utf8");
    const out = await resolveDeepSeekApiKey({
      workspaceRoot: workspace,
      keyFile,
    });
    expect(out).toEqual({ missing: true });
  });
});
