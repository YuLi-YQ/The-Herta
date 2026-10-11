import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { verificationProfile } from "./verification-profile.js";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "herta-r4-profile-"));
  roots.push(root);
  const personal = join(root, "personal", "HertaAtelier");
  mkdirSync(dirname(personal));
  return { root, personal };
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

it("keeps the default identity and does not create the personal directory", () => {
  const { personal } = fixture();
  expect(verificationProfile(["electron", "app"], personal)).toBeNull();
  expect(existsSync(personal)).toBe(false);
});

it("uses separate absolute Chinese paths for two verification profiles without writes", () => {
  const { root, personal } = fixture();
  const first = join(root, "黑塔 验收", "甲");
  const second = join(root, "黑塔 验收", "乙");
  expect(
    verificationProfile(
      ["--herta-verification", `--herta-test-profile=${first}`],
      personal,
    ),
  ).toBe(first);
  expect(
    verificationProfile(
      ["--herta-verification", `--herta-test-profile=${second}`],
      personal,
    ),
  ).toBe(second);
  expect(existsSync(first)).toBe(false);
  expect(existsSync(personal)).toBe(false);
});

it("fails closed for missing, duplicate, malformed, relative and overlapping profiles", () => {
  const { root, personal } = fixture();
  const profile = `--herta-test-profile=${join(root, "test")}`;
  const inputs = [
    ["--herta-verification"],
    [profile],
    ["--herta-verification=yes", profile],
    ["--herta-verification", profile, profile],
    ["--herta-verification", "--herta-test-profile=relative"],
    ["--herta-verification", "--herta-test-profile="],
    ...[personal, join(personal, "child"), dirname(personal), root].map(
      (path) => ["--herta-verification", `--herta-test-profile=${path}`],
    ),
  ];
  for (const argv of inputs)
    expect(() => verificationProfile(argv, personal)).toThrow();
  expect(existsSync(personal)).toBe(false);
});

it("rejects junction aliases that resolve into personal data", () => {
  const { root, personal } = fixture();
  mkdirSync(personal);
  const alias = join(root, "alias");
  symlinkSync(
    personal,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  expect(() =>
    verificationProfile(
      ["--herta-verification", `--herta-test-profile=${join(alias, "child")}`],
      personal,
    ),
  ).toThrow();
});

it.runIf(process.platform === "win32")(
  "rejects Win32 path aliases, alternate streams and device paths",
  () => {
    const { root, personal } = fixture();
    for (const path of [
      join(root, "personal", "HertaAtelier."),
      join(root, "test:stream"),
      join(root, "NUL"),
      "\\\\server\\share\\profile",
      "\\\\?\\C:\\profile",
    ]) {
      expect(() =>
        verificationProfile(
          ["--herta-verification", `--herta-test-profile=${path}`],
          personal,
        ),
      ).toThrow();
    }
    expect(existsSync(personal)).toBe(false);
  },
);
