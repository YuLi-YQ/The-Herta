import { CMD } from "../preload/channels.js";
import { quarantineImageChecks } from "./provider-image-checks.js";
import {
  discoverProviderModels,
  validateProviderModel,
} from "./provider-probes.js";
import {
  deleteProvider,
  getProviderReadiness,
  getProviderSettings,
  saveProvider,
  setProviderBindings,
} from "./provider-settings.js";
import type { SettingsIpcDeps } from "./settings-ipc.js";

/** All mutation validation lives in the main-process store, never trusts IPC. */
export function registerProviderHandlers(
  handle: SettingsIpcDeps["handle"],
): void {
  handle(CMD.getProviderSettings, () => getProviderSettings());
  handle(CMD.getProviderReadiness, (_event, sessionId) =>
    getProviderReadiness(sessionId),
  );
  handle(CMD.discoverProviderModels, (_event, input) =>
    discoverProviderModels(input),
  );
  handle(CMD.validateProviderModel, (_event, input) =>
    validateProviderModel(input),
  );
  // R109 (F06): takes no input; refuses a readable file.
  handle(CMD.resetImageChecks, () => {
    const preserved = quarantineImageChecks();
    return { view: getProviderSettings(), preserved };
  });
  handle(CMD.saveProvider, (_event, input) => saveProvider(input));
  handle(CMD.deleteProvider, (_event, id) => deleteProvider(id));
  handle(CMD.setProviderBindings, (_event, input) =>
    setProviderBindings(input),
  );
}
