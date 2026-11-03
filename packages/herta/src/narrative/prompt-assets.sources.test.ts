import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * The compiled prompt bundle matches its sources (R53). The generator is run
 * by hand, so nothing else notices a source edited without regenerating, a
 * source tree missing files (the public repository shipped without the
 * Chinese-named prompt files until R53 and could not regenerate at all), or a
 * mis-decoded duplicate (R41). The real generator runs on a temporary copy of
 * the two trees, never on the checkout.
 */
const repo = ((): string => {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, "scripts", "generate-prompt-assets.mjs")))
      return dir;
    const parent = dirname(dir);
    if (parent === dir)
      throw new Error(
        "scripts/generate-prompt-assets.mjs not found above the test",
      );
    dir = parent;
  }
})();
const GENERATED = join(
  "packages",
  "herta",
  "src",
  "narrative",
  "prompt-assets.generated.ts",
);
/** LF-normalized digest: a checkout may convert line endings (git autocrlf). */
const digest = (file: string) =>
  createHash("sha256")
    .update(readFileSync(file, "utf8").replace(/\r\n/g, "\n"))
    .digest("hex");

describe("prompt-assets.generated.ts", () => {
  const scratch = mkdtempSync(join(tmpdir(), "herta-prompt-assets-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it("is exactly what the generator builds from packages/herta/prompts{,-en}", () => {
    mkdirSync(join(scratch, "scripts"));
    cpSync(
      join(repo, "scripts", "generate-prompt-assets.mjs"),
      join(scratch, "scripts", "generate-prompt-assets.mjs"),
    );
    for (const tree of ["prompts", "prompts-en"])
      cpSync(
        join(repo, "packages", "herta", tree),
        join(scratch, "packages", "herta", tree),
        {
          recursive: true,
        },
      );
    mkdirSync(join(scratch, "packages", "herta", "src", "narrative"), {
      recursive: true,
    });
    execFileSync(
      process.execPath,
      [join(scratch, "scripts", "generate-prompt-assets.mjs")],
      {
        stdio: "pipe",
      },
    );
    expect(
      digest(join(scratch, GENERATED)),
      "Sources and the checked-in bundle differ: run node scripts/generate-prompt-assets.mjs and commit both",
    ).toBe(digest(join(repo, GENERATED)));
  }, 30_000);
});
