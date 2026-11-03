import { describe, expect, it } from "vitest";
import { permissionModeCoversRequest } from "./workspace-trust.js";
import type { PermissionRequest } from "./types/events.js";

function request(change: Partial<PermissionRequest> = {}): PermissionRequest {
  return { id: "fixture", call: { id: "fixture", tool: "plugin_workspace_patch", input: { path: "file.txt" } },
    reason: "Reviewed local file change", risk: "workspace_write", code: "edit_file_ask", ...change };
}
describe("shared permission-mode coverage for classified requests", () => {
  it.each(["edit_file_ask", "write_new_file_ask", "str_replace_editor_ask"])("keeps ordinary %s covered in workspace-edit and full-access", code => {
    expect(permissionModeCoversRequest("workspace-edit", request({ code }))).toBe(true);
    expect(permissionModeCoversRequest("full-access", request({ code }))).toBe(true);
  });
  it.each([undefined, "read-only", "unknown", "workspace_edit", "FULL-ACCESS", null, 1])("does not auto-allow a missing/unknown/read-only mode %s", mode => {
    expect(permissionModeCoversRequest(mode as Parameters<typeof permissionModeCoversRequest>[0], request())).toBe(false);
  });
  it.each(["network", "workspace_destructive"] as const)("workspace-edit does not cover %s even with a familiar code", risk => {
    expect(permissionModeCoversRequest("workspace-edit", request({ risk }))).toBe(false);
  });
  it("retains full-access coverage of an already-classified ask without pretending this replaces deny rules", () => {
    for (const risk of ["network", "workspace_destructive", "workspace_read", "workspace_write"] as const) {
      expect(permissionModeCoversRequest("full-access", request({ risk, code: "unfamiliar_ask" }))).toBe(true);
    }
  });
  it.each([undefined, "unknown", "permission_ask_outside_workspace", "command_ask_network"])("workspace-edit does not cover untrusted ask class %s", code => {
    expect(permissionModeCoversRequest("workspace-edit", request({ code }))).toBe(false);
  });
  it("covers workspace reads only when their classification is in the existing trust set", () => {
    expect(permissionModeCoversRequest("workspace-edit", request({ risk: "workspace_read", code: "command_ask_recursive_read" }))).toBe(true);
    expect(permissionModeCoversRequest("workspace-edit", request({ risk: "workspace_read", code: "permission_ask_outside_workspace" }))).toBe(false);
  });
  it("requires every code in a multi-class request to be covered", () => {
    expect(permissionModeCoversRequest("workspace-edit", request({ codes: ["edit_file_ask", "write_new_file_ask"] }))).toBe(true);
    expect(permissionModeCoversRequest("workspace-edit", request({ codes: ["edit_file_ask", "command_ask_network"] }))).toBe(false);
  });
  it("preserves empty-list fallback and uses nonempty classes instead of the label code", () => {
    expect(permissionModeCoversRequest("workspace-edit", request({ codes: [] }))).toBe(true);
    expect(permissionModeCoversRequest("workspace-edit", request({ code: "unfamiliar_ask", codes: ["edit_file_ask"] }))).toBe(true);
    expect(permissionModeCoversRequest("workspace-edit", request({ code: undefined, codes: [] }))).toBe(false);
  });
});
