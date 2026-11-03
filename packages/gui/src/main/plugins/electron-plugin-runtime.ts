import { app, utilityProcess } from "electron";
import { dirname, join } from "node:path";
import { PluginRuntimeService } from "./plugin-runtime-service.js";
export { PluginCapabilityBroker } from "./capability-broker.js";
export { executablePluginPackageHash } from "./plugin-runtime-service.js";
export { parseExecutablePluginPackage } from "../../shared/executable-plugins.js";
export { ExecutablePluginStore } from "./executable-plugin-store.js";
export { PluginStorageCoordinator, getPluginStorageCoordinator } from "./plugin-storage-coordinator.js";
export { createPluginWorkshopController } from "./plugin-workshop-controller.js";
export { PluginWorkshopStore } from "./plugin-workshop-store.js";
export { createExecutablePluginController } from "./executable-plugin-controller.js";

/** No provider keys, NODE_OPTIONS, preload or user-selected executable inheritance. */
export function pluginProcessEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"]) {
    if (source[key]) env[key] = source[key];
  }
  return env;
}
/** Called after app.ready; the trusted controller owns installation, IPC and per-run identity. */
export function createElectronPluginRuntime(): PluginRuntimeService {
  // This factory can be hoisted into a shared Rollup chunk when the main app
  // imports it. Resolve from the application root, not that chunk's directory.
  const entry = join(app.getAppPath(), "out/main/plugin-utility.js");
  return new PluginRuntimeService({ createProcess: () => utilityProcess.fork(entry, [], {
    // app.asar/out/main is virtual and cannot be an OS working directory.
    cwd: dirname(process.execPath), env: pluginProcessEnvironment(process.env), stdio: "ignore",
    serviceName: "The Herta plugin", execArgv: ["--max-old-space-size=128"],
  }) });
}
