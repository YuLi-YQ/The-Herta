import { expect, it, vi } from "vitest";

vi.mock("./provider-probes.js", () => ({
  discoverProviderModels: vi.fn(async (input) => ({ input, cached: false })),
  validateProviderModel: vi.fn(async (input) => ({ input })),
}));

vi.mock("./provider-image-checks.js", () => ({
  quarantineImageChecks: vi.fn(() => "provider-image-checks.json.damaged-x"),
}));

vi.mock("./provider-settings.js", () => ({
  getProviderSettings: vi.fn(() => ({ runtimeActive: false })),
  getProviderReadiness: vi.fn(() => ({ ready: false })),
  saveProvider: vi.fn(() => {
    throw new Error("invalid input");
  }),
  deleteProvider: vi.fn(),
  setProviderBindings: vi.fn(),
}));

import { CMD } from "../preload/channels.js";
import { registerProviderHandlers } from "./provider-ipc.js";
import type { SettingsIpcDeps } from "./settings-ipc.js";

it("registers explicit configuration channels and passes untrusted mutations to validated store", () => {
  const handlers = new Map<string, Parameters<SettingsIpcDeps["handle"]>[1]>();
  registerProviderHandlers(((channel, fn) =>
    handlers.set(channel, fn)) as SettingsIpcDeps["handle"]);
  expect([...handlers.keys()]).toEqual([
    CMD.getProviderSettings,
    CMD.getProviderReadiness,
    CMD.discoverProviderModels,
    CMD.validateProviderModel,
    CMD.resetImageChecks,
    CMD.saveProvider,
    CMD.deleteProvider,
    CMD.setProviderBindings,
  ]);
  expect(handlers.get(CMD.getProviderSettings)?.({} as never)).toEqual({
    runtimeActive: false,
  });
  // R109: the reset answers with the moved file's name and a fresh view; it takes no input.
  expect(handlers.get(CMD.resetImageChecks)?.({} as never)).toEqual({
    view: { runtimeActive: false },
    preserved: "provider-image-checks.json.damaged-x",
  });
  expect(() => handlers.get(CMD.saveProvider)?.({} as never, null)).toThrow(
    "invalid input",
  );
});
