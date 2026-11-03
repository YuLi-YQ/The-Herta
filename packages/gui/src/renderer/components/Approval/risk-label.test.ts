import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isDangerRisk, REASON_KEY, RISK_KEY } from "./risk-label.js";

describe("risk-label", () => {
  it("maps each RiskLevel to its message key", () => {
    expect(RISK_KEY.workspace_read).toBe("approval.risk.read");
    expect(RISK_KEY.workspace_write).toBe("approval.risk.write");
    expect(RISK_KEY.workspace_destructive).toBe("approval.risk.destructive");
    expect(RISK_KEY.network).toBe("approval.risk.network");
  });

  it("flags only destructive risk as danger", () => {
    expect(isDangerRisk("workspace_destructive")).toBe(true);
    expect(isDangerRisk("workspace_write")).toBe(false);
    expect(isDangerRisk("workspace_read")).toBe(false);
    expect(isDangerRisk("network")).toBe(false);
  });
  it("translates every ask class the permission rules can emit (R45)", () => {
    // Six classes were missing, so their English rule text showed verbatim
    // on zh approval cards. Scan the rule sources so a new class cannot.
    const packages = join(import.meta.dirname, "../../../../..");
    const codes = new Set<string>();
    for (const root of ["tools/src", "core/src"]) {
      for (const entry of readdirSync(join(packages, root), {
        recursive: true,
        withFileTypes: true,
      })) {
        if (!entry.isFile() || !/(?<!.test).ts$/.test(entry.name)) continue;
        const text = readFileSync(join(entry.parentPath, entry.name), "utf8");
        for (const m of text.matchAll(/code: "([a-z_]+_ask[a-z_]*)"/g))
          codes.add(m[1] as string);
      }
    }
    expect(codes.size).toBeGreaterThan(10);
    expect([...codes].filter((code) => !(code in REASON_KEY))).toEqual([]);
  });
});
