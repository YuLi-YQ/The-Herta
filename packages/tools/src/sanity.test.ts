import type { HertaTool } from "@herta/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

describe("@herta/tools sanity", () => {
  it("compiles with workspace dep on @herta/core", () => {
    const t: Partial<HertaTool> = { name: "noop" };
    expect(t.name).toBe("noop");
  });

  it("zod and zod-to-json-schema resolve", () => {
    const schema = z.object({ x: z.number() });
    const json = zodToJsonSchema(schema);
    expect(json).toBeDefined();
    expect(typeof json).toBe("object");
  });
});
