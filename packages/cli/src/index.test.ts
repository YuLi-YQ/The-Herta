import { describe, expect, it } from "vitest";
import { main } from "./index.js";
import { MockWritable } from "./testing/mock-streams.js";

describe("cli main", () => {
  it("--help resolves with code 0", async () => {
    const stdout = new MockWritable();
    const stderr = new MockWritable();
    const code = await main(["--help"], {
      stdin: process.stdin,
      stdout,
      stderr,
    });
    expect(code).toBe(0);
  });
});
