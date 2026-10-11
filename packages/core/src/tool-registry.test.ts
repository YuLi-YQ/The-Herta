import { describe, expect, it } from "vitest";
import { InMemoryToolRegistry } from "./tool-registry.js";
import type { HertaTool } from "./types/tool.js";

function tool(name: string): HertaTool {
  return {
    name,
    readOnly: true,
    schema: () => ({ name, description: name, inputSchema: {} }),
    run: async () => ({ ok: true, summary: name }),
  };
}

describe("InMemoryToolRegistry", () => {
  it("unregister removes a tool by name and ignores a name it never had (ADR 0067)", () => {
    const registry = new InMemoryToolRegistry();
    registry.register(tool("git_status"));
    registry.register(tool("git_diff"));
    registry.unregister("git_status");
    registry.unregister("never_there");
    expect(registry.list().map((t) => t.name)).toEqual(["git_diff"]);
    expect(registry.get("git_status")).toBeUndefined();
  });

  it("register replaces a tool of the same name", () => {
    const registry = new InMemoryToolRegistry();
    registry.register(tool("digest_document"));
    registry.register(tool("digest_document"));
    expect(registry.list()).toHaveLength(1);
  });
});
