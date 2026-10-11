import { describe, expect, it } from "vitest";
import { isDangerRisk, RISK_KEY } from "./risk-label.js";

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
});
