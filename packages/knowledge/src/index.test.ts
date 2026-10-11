import { describe, expect, it } from "vitest";
import { KNOWLEDGE_PACKAGE_NAME } from "./index.js";

describe("@herta/knowledge", () => {
  it("exports its package name marker", () => {
    expect(KNOWLEDGE_PACKAGE_NAME).toBe("@herta/knowledge");
  });
});
