import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Electron is a path string under Node, so the real `app`/`safeStorage` are
// absent in tests. Mock them: `app.getPath` points at a per-test temp dir, and
// `safeStorage` does a reversible toy "encryption" so the round-trip is real.
const state = vi.hoisted(() => ({
  userData: "",
  encAvailable: true,
  backend: "gnome_libsecret",
}));
vi.mock("electron", () => ({
  app: { getPath: () => state.userData },
  safeStorage: {
    isEncryptionAvailable: () => state.encAvailable,
    getSelectedStorageBackend: () => state.backend,
    encryptString: (s: string) => Buffer.from(`enc:${s}`, "utf-8"),
    decryptString: (b: Buffer) => b.toString("utf-8").replace(/^enc:/, ""),
  },
}));

/** Run `fn` as if on `platform` (the store reads process.platform). */
function onPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const real = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
  try {
    return fn();
  } finally {
    if (real !== undefined) Object.defineProperty(process, "platform", real);
  }
}

import {
  clearDeepSeekKey,
  clearMiniMaxKey,
  clearMiniMaxPlanKey,
  getDeepSeekKeyStatus,
  getMiniMaxKeyStatus,
  getMiniMaxPlanKeyStatus,
  readDeepSeekKeyPlain,
  readMiniMaxKeyPlain,
  readMiniMaxPlanKeyPlain,
  setDeepSeekKey,
  setMiniMaxKey,
  setMiniMaxPlanKey,
} from "./key-store.js";

describe("key-store", () => {
  beforeEach(() => {
    state.userData = mkdtempSync(join(tmpdir(), "herta-key-store-"));
    state.encAvailable = true;
    state.backend = "gnome_libsecret";
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("round-trips: set → readPlain returns the key, status is masked (last4)", () => {
    const r = setDeepSeekKey("sk-abcd1234");
    expect(r.encrypted).toBe(true);
    expect(readDeepSeekKeyPlain()).toBe("sk-abcd1234");
    expect(getDeepSeekKeyStatus()).toEqual({
      set: true,
      hint: "1234",
      encrypted: true,
    });
  });

  it("trims the key on write", () => {
    setDeepSeekKey("  sk-spaced  ");
    expect(readDeepSeekKeyPlain()).toBe("sk-spaced");
  });

  it("reports no key before anything is stored", () => {
    expect(readDeepSeekKeyPlain()).toBeNull();
    expect(getDeepSeekKeyStatus()).toEqual({
      set: false,
      hint: null,
      encrypted: false,
    });
  });

  it("clear removes the key", () => {
    setDeepSeekKey("sk-tobecleared");
    clearDeepSeekKey();
    expect(readDeepSeekKeyPlain()).toBeNull();
    expect(getDeepSeekKeyStatus().set).toBe(false);
  });

  it("setting an empty key clears the store", () => {
    setDeepSeekKey("sk-first");
    const r = setDeepSeekKey("   ");
    expect(r.encrypted).toBe(false);
    expect(readDeepSeekKeyPlain()).toBeNull();
  });

  it("rejects a new key when OS encryption is unavailable without writing plaintext", () => {
    state.encAvailable = false;
    expect(() => setDeepSeekKey("sk-plain1234")).toThrow("系统安全存储不可用");
    expect(existsSync(join(state.userData, "deepseek-key.txt"))).toBe(false);
    expect(existsSync(join(state.userData, "deepseek-key.enc"))).toBe(false);
  });

  it("a fresh write does not leave a stale file from the other mode", () => {
    writeFileSync(join(state.userData, "deepseek-key.txt"), "sk-plainfirst");
    // Encryption becomes available; the next write must clear the .txt fallback
    // so readPlain does not see the stale plaintext.
    state.encAvailable = true;
    setDeepSeekKey("sk-enc-second99");
    expect(readDeepSeekKeyPlain()).toBe("sk-enc-second99");
    expect(getDeepSeekKeyStatus().encrypted).toBe(true);
  });

  // ── Linux without a keyring (platform review 2026-09-23) ──────────────────

  it("rejects Linux basic_text without creating a credential file", () => {
    state.backend = "basic_text"; // available, but a hard-coded password
    expect(() =>
      onPlatform("linux", () => setDeepSeekKey("sk-basic-9999")),
    ).toThrow("系统安全存储不可用");
    expect(existsSync(join(state.userData, "deepseek-key.txt"))).toBe(false);
    expect(existsSync(join(state.userData, "deepseek-key.enc"))).toBe(false);
  });

  it("a key saved as `.enc` under `basic_text` before the fix still reads — but is not called encrypted", () => {
    // Written by the old store: libsecret-less Linux, `.enc` via basic_text.
    writeFileSync(
      join(state.userData, "deepseek-key.enc"),
      Buffer.from("enc:sk-legacy-7777", "utf-8"),
    );
    state.backend = "basic_text";
    expect(onPlatform("linux", () => readDeepSeekKeyPlain())).toBe(
      "sk-legacy-7777",
    );
    expect(onPlatform("linux", () => getDeepSeekKeyStatus().encrypted)).toBe(
      false,
    );
  });

  it("a real Linux keyring still encrypts", () => {
    state.backend = "gnome_libsecret";
    const r = onPlatform("linux", () => setDeepSeekKey("sk-keyring-5555"));
    expect(r.encrypted).toBe(true);
  });

  it("retains the previous encrypted credential when a replacement cannot be encrypted", () => {
    setDeepSeekKey("sk-original-1234");
    state.encAvailable = false;
    expect(() => setDeepSeekKey("sk-replacement-5678")).toThrow(
      "系统安全存储不可用",
    );
    state.encAvailable = true;
    expect(readDeepSeekKeyPlain()).toBe("sk-original-1234");
    expect(existsSync(join(state.userData, "deepseek-key.txt"))).toBe(false);
  });

  // ── the MiniMax key (ADR 0062) ────────────────────────────────────────────

  it("the MiniMax key has its own store: setting one never touches the other", () => {
    setDeepSeekKey("sk-deepseek-1111");
    const r = setMiniMaxKey("sk-api-minimax-2222");
    expect(r.encrypted).toBe(true);
    expect(readMiniMaxKeyPlain()).toBe("sk-api-minimax-2222");
    expect(getMiniMaxKeyStatus()).toEqual({
      set: true,
      hint: "2222",
      encrypted: true,
    });
    expect(readDeepSeekKeyPlain()).toBe("sk-deepseek-1111");
    clearMiniMaxKey();
    expect(readMiniMaxKeyPlain()).toBeNull();
    expect(getMiniMaxKeyStatus().set).toBe(false);
    expect(readDeepSeekKeyPlain()).toBe("sk-deepseek-1111");
  });

  it("the MiniMax token-plan key is a third store beside the pay-as-you-go one (ADR 0062 §1.8)", () => {
    setMiniMaxKey("sk-api-minimax-2222");
    const r = setMiniMaxPlanKey("sk-cp-plan-3333");
    expect(r.encrypted).toBe(true);
    expect(readMiniMaxPlanKeyPlain()).toBe("sk-cp-plan-3333");
    expect(getMiniMaxPlanKeyStatus()).toEqual({
      set: true,
      hint: "3333",
      encrypted: true,
    });
    expect(readMiniMaxKeyPlain()).toBe("sk-api-minimax-2222");
    clearMiniMaxPlanKey();
    expect(readMiniMaxPlanKeyPlain()).toBeNull();
    expect(readMiniMaxKeyPlain()).toBe("sk-api-minimax-2222");
  });
});
