import {
  chmodSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { app, safeStorage } from "electron";

/**
 * Secure, main-process-only store for API keys, over Electron `safeStorage`
 * (OS keychain — Keychain on macOS, libsecret on Linux, DPAPI on Windows).
 * The raw key NEVER crosses IPC: the renderer only ever sees the masked
 * status (`set` + last-4 `hint`). See the 2026-06-24-deepseek-key design.
 *
 * Three secrets live here, each in its own pair of files under
 * `app.getPath("userData")`:
 *  - `deepseek-key.enc` / `deepseek-key.txt` — the DeepSeek API key;
 *  - `minimax-key.enc` / `minimax-key.txt` — the MiniMax pay-as-you-go key
 *    for the cloud voice (ADR 0062, 2026-09-08): clones her voice, and
 *    speaks when no plan key is set;
 *  - `minimax-plan-key.enc` / `.txt` — the MiniMax token-plan (`sk-cp-…`)
 *    key (ADR 0062 §1.8): speaks under the plan; cannot clone.
 * New writes require OS-protected encryption. Legacy `.txt` files remain
 * readable for migration, but this application never creates them.
 *
 * All reads are best-effort: a missing / corrupt / undecryptable store resolves
 * to `null` rather than throwing — a bad store must never wedge the app.
 */
export type SecretName = "deepseek" | "minimax" | "minimax-plan";

function encPath(name: SecretName): string {
  return join(app.getPath("userData"), `${name}-key.enc`);
}

function txtPath(name: SecretName): string {
  return join(app.getPath("userData"), `${name}-key.txt`);
}

/** Delete both store files. Best-effort — a missing file is success. */
function clearFiles(name: SecretName): void {
  for (const p of [encPath(name), txtPath(name)]) {
    try {
      rmSync(p, { force: true });
    } catch {
      // Best effort: a locked/absent file must not block a key change.
    }
  }
}

/**
 * Whether `safeStorage` really protects a secret on this machine.
 *
 * On Linux without a keyring — a tiling window manager, a minimal distro, no
 * gnome-keyring / KWallet running — Electron picks its `basic_text` backend,
 * which "encrypts" with a password hard-coded into Chromium. The ciphertext
 * is then no protection at all, yet the store used to write it as `.enc` and
 * report `encrypted: true`, and Settings told the user the key was stored
 * encrypted (platform review 2026-09-23). That backend now counts as NOT
 * encrypted: the key goes to the owner-only plaintext file and the UI says so.
 */
function encryptionProtects(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  if (process.platform === "linux") {
    try {
      return safeStorage.getSelectedStorageBackend() !== "basic_text";
    } catch {
      return false;
    }
  }
  return true;
}

/** Owner-only on POSIX (the default 0644 let any local account read a
 *  plaintext key); `mode` only applies when the file is CREATED, so an
 *  existing file is tightened too. Best-effort: Windows ignores POSIX modes,
 *  and a failed chmod must not fail the save. */
function writeOwnerOnly(path: string, data: string | Buffer): void {
  writeFileSync(
    path,
    data,
    typeof data === "string"
      ? { encoding: "utf-8", mode: 0o600 }
      : { mode: 0o600 },
  );
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort */
  }
}

export interface KeyStatus {
  /** Whether a non-empty key is stored. */
  readonly set: boolean;
  /** Last 4 characters of the key, for the "Connected · …last4" UI. Null when
   *  unset. The full key is never sent to the renderer. */
  readonly hint: string | null;
  /** False when the key is stored as plaintext (encryption unavailable). */
  readonly encrypted: boolean;
}

/** The DeepSeek status's historical name; the same shape serves every key. */
export type DeepSeekKeyStatus = KeyStatus;

/** Persist `key` with OS encryption or fail without changing the old value.
 * An empty/whitespace key clears the store instead. */
export function setSecret(
  name: SecretName,
  key: string,
): { encrypted: boolean } {
  const trimmed = key.trim();
  if (trimmed.length === 0) {
    clearFiles(name);
    return { encrypted: false };
  }
  // Write the NEW key before clearing the old one (audit BL7). The old order
  // deleted both files first, so a failed write left the user with no stored
  // key at all — they had typed a valid key, seen an error, and lost the one
  // they already had. The running session was unaffected (the throw precedes
  // host.setDeepSeekKey), which is exactly what made the loss easy to miss
  // until the next launch.
  //
  // Clearing the OTHER file afterwards still keeps the two from coexisting and
  // shadowing each other, which is what clearFiles was here for.
  if (encryptionProtects()) {
    writeOwnerOnly(encPath(name), safeStorage.encryptString(trimmed));
    rmIfExists(txtPath(name));
    return { encrypted: true };
  }
  throw new Error("系统安全存储不可用，未保存 API Key；原有凭据保持不变。");
}

function rmIfExists(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    /* a stale sibling is shadowed by read order anyway; never fail a key save */
  }
}

/** Read the stored key in plaintext, or null when none is set / readable.
 *  Main-process only — used by `buildConfig` and the synthesizers, never sent
 *  to the renderer. */
export function readSecretPlain(name: SecretName): string | null {
  try {
    if (existsSync(encPath(name)) && safeStorage.isEncryptionAvailable()) {
      const decoded = safeStorage
        .decryptString(readFileSync(encPath(name)))
        .trim();
      return decoded.length > 0 ? decoded : null;
    }
  } catch {
    // Corrupt/undecryptable .enc — fall through to the plaintext fallback.
  }
  try {
    if (existsSync(txtPath(name))) {
      const raw = readFileSync(txtPath(name), "utf-8").trim();
      return raw.length > 0 ? raw : null;
    }
  } catch {
    // Unreadable .txt — treat as no key.
  }
  return null;
}

/** Masked status for the renderer. The raw key never leaves the main process. */
export function getSecretStatus(name: SecretName): KeyStatus {
  const key = readSecretPlain(name);
  if (key === null) return { set: false, hint: null, encrypted: false };
  // A `.enc` written under `basic_text` still DECRYPTS (readSecretPlain uses
  // the plain availability check, so a key saved before 2026-09-23 keeps
  // working) — but it is not reported as encrypted, because it is not.
  const encrypted = existsSync(encPath(name)) && encryptionProtects();
  // Last 4 only — never echo a whole (short) key back across IPC.
  const hint = key.length >= 4 ? key.slice(-4) : null;
  return { set: true, hint, encrypted };
}

/** Delete the stored key (both files). */
export function clearSecret(name: SecretName): void {
  clearFiles(name);
}

// ── the DeepSeek key, under its historical names ─────────────────────────────

export function setDeepSeekKey(key: string): { encrypted: boolean } {
  return setSecret("deepseek", key);
}
export function readDeepSeekKeyPlain(): string | null {
  return readSecretPlain("deepseek");
}
export function getDeepSeekKeyStatus(): DeepSeekKeyStatus {
  return getSecretStatus("deepseek");
}
export function clearDeepSeekKey(): void {
  clearSecret("deepseek");
}

// ── the MiniMax key (ADR 0062) ───────────────────────────────────────────────

export function setMiniMaxKey(key: string): { encrypted: boolean } {
  return setSecret("minimax", key);
}
export function readMiniMaxKeyPlain(): string | null {
  return readSecretPlain("minimax");
}
export function getMiniMaxKeyStatus(): KeyStatus {
  return getSecretStatus("minimax");
}
export function clearMiniMaxKey(): void {
  clearSecret("minimax");
}

// ── the MiniMax token-plan key (ADR 0062 §1.8) ──────────────────────────────

export function setMiniMaxPlanKey(key: string): { encrypted: boolean } {
  return setSecret("minimax-plan", key);
}
export function readMiniMaxPlanKeyPlain(): string | null {
  return readSecretPlain("minimax-plan");
}
export function getMiniMaxPlanKeyStatus(): KeyStatus {
  return getSecretStatus("minimax-plan");
}
export function clearMiniMaxPlanKey(): void {
  clearSecret("minimax-plan");
}
