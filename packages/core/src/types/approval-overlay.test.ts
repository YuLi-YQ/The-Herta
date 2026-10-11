import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  ApprovalOverlayState,
  PendingCommandApproval,
  PendingPermissionApproval,
} from "./approval-overlay.js";

describe("ApprovalOverlayState", () => {
  it("idle state is the default", () => {
    const state: ApprovalOverlayState = { kind: "idle" };
    expect(state.kind).toBe("idle");
  });

  it("pending-permission carries the request id and risk", () => {
    const state: ApprovalOverlayState = {
      kind: "pending-permission",
      requestId: "perm-1",
      risk: "workspace_write",
      tool: "run_command",
      summary: "test",
    };
    if (state.kind === "pending-permission") {
      expect(state.requestId).toBe("perm-1");
      expect(state.risk).toBe("workspace_write");
    }
  });

  it("pending-command carries the proposed command string", () => {
    const state: ApprovalOverlayState = {
      kind: "pending-command",
      requestId: "cmd-1",
      command: "pnpm test -- parser",
    };
    if (state.kind === "pending-command") {
      expect(state.command).toContain("pnpm");
    }
  });

  it("kind discriminator narrows the union", () => {
    expectTypeOf<ApprovalOverlayState["kind"]>().toEqualTypeOf<
      "idle" | "pending-permission" | "pending-command"
    >();
    expectTypeOf<
      PendingPermissionApproval["kind"]
    >().toEqualTypeOf<"pending-permission">();
    expectTypeOf<
      PendingCommandApproval["kind"]
    >().toEqualTypeOf<"pending-command">();
  });
});
