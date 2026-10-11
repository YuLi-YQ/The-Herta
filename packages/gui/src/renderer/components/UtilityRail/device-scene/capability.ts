import { SOFTWARE_RENDERER } from "../webgl.js";

/**
 * Which GPU path the 3D device card can take on this machine (ADR 0057 §4).
 *
 *   "webgpu"  — navigator.gpu hands out an adapter AND a device.
 *   "webgl2"  — no WebGPU, but a hardware WebGL2 context. three's
 *               WebGPURenderer runs its WebGL2 backend (`forceWebGL`).
 *   null      — neither, or only a software rasterizer: the card keeps its
 *               flat renders. SwiftShader would draw the scene at a crawl
 *               and burn a CPU core for a decoration.
 *
 * Probed ONCE per renderer lifetime (memoised): adapters do not appear
 * mid-session, and the probe itself is not free (it asks the GPU process).
 */
export type DeviceSceneBackend = "webgpu" | "webgl2";

interface GpuLike {
  requestAdapter(): Promise<{
    requestDevice(): Promise<{ destroy(): void }>;
  } | null>;
}

interface ProbeEnv {
  readonly gpu?: GpuLike | undefined;
  readonly createCanvas: () => HTMLCanvasElement;
}

/** The uncached probe — injectable for tests. */
export async function probeDeviceSceneBackend(
  env: ProbeEnv,
): Promise<DeviceSceneBackend | null> {
  if (env.gpu !== undefined) {
    try {
      const adapter = await env.gpu.requestAdapter();
      if (adapter !== null) {
        const device = await adapter.requestDevice();
        device.destroy();
        return "webgpu";
      }
    } catch {
      // fall through to WebGL2
    }
  }
  return probeWebGL2(env);
}

/**
 * Whether the card can expect a scene at all: the question it asks at mount
 * (2026-09-10), so a machine with no path shows the flat card from the first
 * answer. An adapter answers it. The full probe's device held the GPU
 * process ~0.25 s in the middle of the opening (M-opening-3), and was only
 * destroyed again; the scene's own build, after the opening, makes the full
 * probe. With no adapter, the full probe's WebGL2 check. Uncached; for tests.
 */
export async function probeDeviceScenePath(env: ProbeEnv): Promise<boolean> {
  if (env.gpu !== undefined) {
    try {
      if ((await env.gpu.requestAdapter()) !== null) return true;
    } catch {
      // fall through to WebGL2
    }
  }
  return probeWebGL2(env) !== null;
}

function probeWebGL2(env: ProbeEnv): "webgl2" | null {
  try {
    const canvas = env.createCanvas();
    const gl = canvas.getContext("webgl2");
    if (gl === null) return null;
    // Read here rather than through `isSoftwareRenderer`: a query that throws
    // lands in the catch below and keeps the flat card — the stricter answer
    // the 3D scene has always had.
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = String(
      ext !== null
        ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
        : gl.getParameter(gl.RENDERER),
    );
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return SOFTWARE_RENDERER.test(renderer) ? null : "webgl2";
  } catch {
    return null;
  }
}

let cached: Promise<DeviceSceneBackend | null> | null = null;
let cachedPath: Promise<boolean> | null = null;

function realEnv(): ProbeEnv {
  return {
    gpu: (navigator as Navigator & { gpu?: GpuLike }).gpu,
    createCanvas: () => document.createElement("canvas"),
  };
}

/** The memoised probe against the real window. */
export function detectDeviceSceneBackend(): Promise<DeviceSceneBackend | null> {
  if (cached === null) cached = probeDeviceSceneBackend(realEnv());
  return cached;
}

/** The memoised path question against the real window: the full probe's
 *  answer when that has run, else the cheaper `probeDeviceScenePath`. */
export function detectDeviceScenePath(): Promise<boolean> {
  if (cached !== null) return cached.then((backend) => backend !== null);
  if (cachedPath === null) cachedPath = probeDeviceScenePath(realEnv());
  return cachedPath;
}

/** Test hook. */
export function resetDeviceSceneBackendForTest(): void {
  cached = null;
  cachedPath = null;
}
