// @vitest-environment node
import type { IpcMainInvokeEvent, WebContents } from "electron";
import { describe, expect, it } from "vitest";
import { createTrustedSessionIpcGuard } from "./trusted-session-ipc.js";

function fixture(installed = true, devRendererUrl?: string) {
  const frame = { url: "file:///C:/TheHerta/app.asar/out/renderer/index.html" };
  const wc = {
    mainFrame: frame,
    isDestroyed: () => false,
  } as unknown as WebContents;
  const event = {
    sender: wc,
    senderFrame: frame,
  } as unknown as IpcMainInvokeEvent;
  return {
    frame,
    wc,
    event,
    guard: createTrustedSessionIpcGuard(wc, {
      appFileUrl: frame.url,
      installed,
      devRendererUrl,
    }),
  };
}
describe("privileged session IPC source", () => {
  it("accepts owned main frame only, including renderer hash routing", () => {
    const { guard, event, frame, wc } = fixture();
    expect(guard(event)).toBe(true);
    frame.url += "#task";
    expect(guard(event)).toBe(true);
    expect(guard({ ...event, sender: {} as WebContents })).toBe(false);
    expect(guard({ ...event, senderFrame: null })).toBe(false);
    expect(
      guard({
        ...event,
        senderFrame: { url: frame.url } as typeof event.senderFrame,
      }),
    ).toBe(false);
    wc.isDestroyed = () => true;
    expect(guard(event)).toBe(false);
  });
  it("rejects other local documents and remote origins in installed builds even with env override", () => {
    const { guard, event, frame } = fixture(true, "http://localhost:5173");
    for (const url of [
      "file:///C:/other.html",
      "https://example.com",
      "http://localhost:5173",
      "about:blank",
      "data:text/html,test",
    ]) {
      frame.url = url;
      expect(guard(event)).toBe(false);
    }
  });
  it("permits only explicitly configured dev origin in noninstalled runs", () => {
    const { guard, event, frame } = fixture(false, "http://localhost:5173/");
    frame.url = "http://localhost:5173/?x=1";
    expect(guard(event)).toBe(true);
    for (const url of [
      "http://localhost:5173.evil.com",
      "http://localhost:5174",
      "https://localhost:5173",
    ]) {
      frame.url = url;
      expect(guard(event)).toBe(false);
    }
    const noDev = fixture(false);
    noDev.frame.url = "http://localhost:5173";
    expect(noDev.guard(noDev.event)).toBe(false);
  });
});
