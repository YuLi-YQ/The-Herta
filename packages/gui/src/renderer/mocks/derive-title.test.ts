import type { TerminalRecord } from "@herta/app-server";
import { describe, expect, it } from "vitest";
import { deriveTitle } from "./derive-title.js";

describe("deriveTitle", () => {
  it("returns the first user block text, truncated to 28 chars + ellipsis", () => {
    const record: TerminalRecord = [
      {
        kind: "user",
        text: "This is a long user message that exceeds the limit",
      },
    ];
    const out = deriveTitle(record);
    expect(out).toBe("This is a long user message…");
    expect(out.length).toBeLessThanOrEqual(29);
  });

  it("returns the full text if shorter than the limit", () => {
    const record: TerminalRecord = [{ kind: "user", text: "Short message" }];
    expect(deriveTitle(record)).toBe("Short message");
  });

  it("returns 'Untitled' when no user block exists", () => {
    const record: TerminalRecord = [
      { kind: "herta", surface: "speech", text: "I started the conversation." },
    ];
    expect(deriveTitle(record)).toBe("Untitled");
  });

  it("returns 'Untitled' for an empty record", () => {
    expect(deriveTitle([])).toBe("Untitled");
  });
});
