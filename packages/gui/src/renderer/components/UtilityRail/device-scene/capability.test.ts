import { describe, expect, it } from "vitest";
import { probeDeviceSceneBackend, probeDeviceScenePath } from "./capability.js";

function fakeCanvas(renderer: string | null): HTMLCanvasElement {
  const gl =
    renderer === null
      ? null
      : {
          RENDERER: 0x1f01,
          getExtension: (name: string) =>
            name === "WEBGL_debug_renderer_info"
              ? { UNMASKED_RENDERER_WEBGL: 0x9246 }
              : null,
          getParameter: () => renderer,
        };
  return { getContext: () => gl } as unknown as HTMLCanvasElement;
}

describe("probeDeviceSceneBackend (ADR 0057 §4)", () => {
  it("prefers WebGPU when an adapter and a device come back", async () => {
    let destroyed = 0;
    const gpu = {
      requestAdapter: async () => ({
        requestDevice: async () => ({
          destroy: () => {
            destroyed += 1;
          },
        }),
      }),
    };
    await expect(
      probeDeviceSceneBackend({ gpu, createCanvas: () => fakeCanvas("Intel") }),
    ).resolves.toBe("webgpu");
    // The probe device is released — the scene requests its own.
    expect(destroyed).toBe(1);
  });

  it("falls back to hardware WebGL2 when there is no adapter", async () => {
    const gpu = { requestAdapter: async () => null };
    await expect(
      probeDeviceSceneBackend({
        gpu,
        createCanvas: () =>
          fakeCanvas("ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11)"),
      }),
    ).resolves.toBe("webgl2");
  });

  it("falls back to WebGL2 when requestDevice throws", async () => {
    const gpu = {
      requestAdapter: async () => ({
        requestDevice: async () => {
          throw new Error("device lost");
        },
      }),
    };
    await expect(
      probeDeviceSceneBackend({
        gpu,
        createCanvas: () => fakeCanvas("NVIDIA"),
      }),
    ).resolves.toBe("webgl2");
  });

  it("refuses a software rasterizer — the flat card is cheaper than SwiftShader", async () => {
    for (const name of [
      "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))",
      "llvmpipe (LLVM 15.0.7, 256 bits)",
      "Microsoft Basic Render Driver",
    ]) {
      await expect(
        probeDeviceSceneBackend({ createCanvas: () => fakeCanvas(name) }),
      ).resolves.toBeNull();
    }
  });

  it("returns null with no GPU at all (jsdom: no navigator.gpu, no WebGL2)", async () => {
    await expect(
      probeDeviceSceneBackend({ createCanvas: () => fakeCanvas(null) }),
    ).resolves.toBeNull();
  });
});

describe("probeDeviceScenePath (M-opening-3)", () => {
  it("an adapter is enough — no device is created (it held the GPU process ~0.25 s mid-opening)", async () => {
    let devices = 0;
    const gpu = {
      requestAdapter: async () => ({
        requestDevice: async () => {
          devices += 1;
          return { destroy: () => undefined };
        },
      }),
    };
    await expect(
      probeDeviceScenePath({ gpu, createCanvas: () => fakeCanvas(null) }),
    ).resolves.toBe(true);
    expect(devices).toBe(0);
  });

  it("with no adapter, answers what the full probe's WebGL2 check answers", async () => {
    const noAdapter = { requestAdapter: async () => null };
    for (const renderer of [
      "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11)",
      "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))",
      null,
    ]) {
      const env = { gpu: noAdapter, createCanvas: () => fakeCanvas(renderer) };
      await expect(probeDeviceScenePath(env)).resolves.toBe(
        (await probeDeviceSceneBackend(env)) !== null,
      );
    }
  });

  it("an adapter request that throws falls through to WebGL2", async () => {
    const gpu = {
      requestAdapter: async () => {
        throw new Error("no GPU process");
      },
    };
    await expect(
      probeDeviceScenePath({ gpu, createCanvas: () => fakeCanvas("NVIDIA") }),
    ).resolves.toBe(true);
    await expect(
      probeDeviceScenePath({ gpu, createCanvas: () => fakeCanvas(null) }),
    ).resolves.toBe(false);
  });
});
