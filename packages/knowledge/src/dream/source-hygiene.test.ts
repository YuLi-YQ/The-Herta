import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A literal U+0000 in a source file makes ripgrep — and so the repo's own
 * search, and 板砖's `search_text` — treat the file as binary from that byte
 * on. `run-dream-pass.ts` carried three in its dedup key for weeks, and
 * every search into the pass's second half came back empty (dream review
 * 2026-09-22, finding 18). The escape `\u0000` is the same string at run
 * time; the byte is not.
 */
describe("dream sources carry no raw NUL byte", () => {
  it("every .ts file in the dream directory is text all the way through", () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => readFileSync(join(dir, f)).includes(0));
    expect(offenders).toEqual([]);
  });
});
