import type { MemoryItem, MemoryManager, MemoryQuery } from "@herta/core";
import { FileMemoryManager } from "@herta/memory";
import { describe, expect, it } from "vitest";
import { mkTmpWorkspace } from "../testing/tmp-workspace.js";
import { mkToolContext } from "../testing/tool-context.js";
import { memorySaveTool } from "./index.js";

class CapturingMemoryManager implements MemoryManager {
  saved: MemoryItem[] = [];
  async recall(_q: MemoryQuery): Promise<MemoryItem[]> {
    return this.saved;
  }
  async save(item: MemoryItem): Promise<void> {
    this.saved.push(item);
  }
  currentItems(): readonly MemoryItem[] {
    return this.saved;
  }
}

describe("memory_save tool", () => {
  it("saves a valid item and returns ok with id+kind+text", async () => {
    const memory = new CapturingMemoryManager();
    const r = await memorySaveTool().run(
      {
        id: "c1",
        tool: "memory_save",
        input: { kind: "build_command", text: "pnpm build" },
      },
      mkToolContext({ workspaceRoot: "/tmp/x", memory }),
      () => {},
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data as { id: string; kind: string; text: string };
    expect(data.kind).toBe("build_command");
    expect(data.text).toBe("pnpm build");
    expect(typeof data.id).toBe("string");
    expect(memory.saved.length).toBe(1);
    expect(memory.saved[0]?.kind).toBe("build_command");
    expect(memory.saved[0]?.confidence).toBe(1);
    expect(memory.saved[0]?.scope).toBe("repo");
  });

  it("rejects invalid kind with invalid_input", async () => {
    const memory = new CapturingMemoryManager();
    const r = await memorySaveTool().run(
      {
        id: "c1",
        tool: "memory_save",
        input: { kind: "not_a_real_kind", text: "x" },
      },
      mkToolContext({ workspaceRoot: "/tmp/x", memory }),
      () => {},
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("invalid_input");
    expect(memory.saved.length).toBe(0);
  });

  it("rejects text > 500 characters with invalid_input", async () => {
    const memory = new CapturingMemoryManager();
    const r = await memorySaveTool().run(
      {
        id: "c1",
        tool: "memory_save",
        input: { kind: "repo_fact", text: "x".repeat(501) },
      },
      mkToolContext({ workspaceRoot: "/tmp/x", memory }),
      () => {},
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("invalid_input");
    expect(memory.saved.length).toBe(0);
  });

  it("dedupe is silent — same kind+text twice returns ok and writes once", async () => {
    const ws = await mkTmpWorkspace({});
    try {
      const memory = new FileMemoryManager({ workspaceRoot: ws.root });
      const ctx = mkToolContext({ workspaceRoot: ws.root, memory });
      const call = {
        id: "c1",
        tool: "memory_save",
        input: { kind: "test_command" as const, text: "pnpm vitest" },
      };
      const r1 = await memorySaveTool().run(call, ctx, () => {});
      const r2 = await memorySaveTool().run(call, ctx, () => {});
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      const items = await memory.recall({});
      expect(items.length).toBe(1);
    } finally {
      await ws.cleanup();
    }
  });

  it("redacts secret-shaped substrings in text before saving", async () => {
    const memory = new CapturingMemoryManager();
    await memorySaveTool().run(
      {
        id: "c1",
        tool: "memory_save",
        input: {
          kind: "herta_lesson",
          text: "AWS key leaked: AKIAIOSFODNN7EXAMPLE — rotated.",
        },
      },
      mkToolContext({ workspaceRoot: "/tmp/x", memory }),
      () => {},
    );
    expect(memory.saved.length).toBe(1);
    const stored = memory.saved[0]?.text ?? "";
    expect(stored).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(stored).toContain("[REDACTED:aws_access_key]");
  });
});
