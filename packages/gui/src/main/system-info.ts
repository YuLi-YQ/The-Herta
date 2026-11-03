import { arch, release } from "node:os";
import type { SystemInfo } from "../renderer/ipc/bridge-types.js";

/**
 * What `/feedback` says about the system (R125, F09 4.5): the OS, its version and the
 * CPU architecture. Nothing that names the user or the computer — no host name, user
 * name or path — and the handler takes no input.
 */
export function systemInfo(): SystemInfo {
  return { platform: process.platform, release: release(), arch: arch() };
}
