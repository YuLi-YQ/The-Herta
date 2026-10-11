import { expect, it, vi } from "vitest";

vi.mock("./provider-probes.js", () => ({
  discoverProviderModels: vi.fn(async (input) => ({ input, cached: false })),
  validateProviderModel: vi.fn(async (input) => ({ input })),
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
    CMD.saveProvider,
    CMD.deleteProvider,
    CMD.setProviderBindings,
  ]);
  expect(handlers.get(CMD.getProviderSettings)?.({} as never)).toEqual({
    runtimeActive: false,
  });
  expect(() => handlers.get(CMD.saveProvider)?.({} as never, null)).toThrow(
    "invalid input",
  );
});
