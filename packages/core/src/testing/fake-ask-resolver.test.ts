import { describe, expect, it } from "vitest";
import type { PermissionRequest } from "../types/events.js";
import { FakeAskResolver } from "./fake-ask-resolver.js";

function makeRequest(id = "p1"): PermissionRequest {
  return {
    id,
    call: { id: "c1", tool: "edit_file", input: {} },
    reason: "writes file",
    risk: "workspace_write",
  };
}

describe("FakeAskResolver", () => {
  it("resolves allow when allow() is called", async () => {
    const r = new FakeAskResolver();
    const ac = new AbortController();
    const p = r.present(makeRequest(), ac.signal);
    expect(r.pending).toHaveLength(1);
    r.allow();
    expect(await p).toBe("allow");
  });

  it("resolves deny when deny() is called", async () => {
    const r = new FakeAskResolver();
    const ac = new AbortController();
    const p = r.present(makeRequest(), ac.signal);
    r.deny();
    expect(await p).toBe("deny");
  });

  it("rejects with abort reason when signal aborts mid-flight", async () => {
    const r = new FakeAskResolver();
    const ac = new AbortController();
    const p = r.present(makeRequest(), ac.signal);
    ac.abort(new Error("user-interrupt"));
    await expect(p).rejects.toThrow("user-interrupt");
  });

  it("rejects immediately when signal is already aborted", async () => {
    const r = new FakeAskResolver();
    const ac = new AbortController();
    ac.abort(new Error("preaborted"));
    const p = r.present(makeRequest(), ac.signal);
    await expect(p).rejects.toThrow("preaborted");
  });

  it("supports multiple concurrent pending requests by index", async () => {
    const r = new FakeAskResolver();
    const ac = new AbortController();
    const a = r.present(makeRequest("p1"), ac.signal);
    const b = r.present(makeRequest("p2"), ac.signal);
    r.allow(0);
    r.deny(1);
    expect(await a).toBe("allow");
    expect(await b).toBe("deny");
  });

  it("fail(idx) rejects the pending request", async () => {
    const r = new FakeAskResolver();
    const ac = new AbortController();
    const p = r.present(makeRequest(), ac.signal);
    r.fail(new Error("boom"));
    await expect(p).rejects.toThrow("boom");
  });
});
