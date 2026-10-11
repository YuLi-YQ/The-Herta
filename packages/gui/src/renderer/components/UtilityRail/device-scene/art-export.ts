import * as THREE from "three/webgpu";
import type { ResolvedTheme } from "../../../hooks/useResolvedTheme.js";
import {
  confineHorizontally,
  downsampleToStraight,
  type FractionBox,
  lampLayer,
  meanChannel,
  measureOpaqueBox,
  peakChannel,
  type RgbaBytes,
  shadowLayer,
  unpadRows,
} from "./art-export-math.js";
import {
  applyCloudy,
  DARK_HOUR,
  lightingAt,
  STATE_TARGETS,
  type WeatheredLighting,
} from "./lighting.js";

/**
 * The flat card's art, rendered from the scene (ADR 0057 §2.14; owner,
 * 2026-09-07: "update our 2D image to the 3D rendered 2D images — it feels
 * weird that 2D and 3D are different"). Profiling-only: scene.ts exposes
 * this on the canvas as `__export` and `scripts/device-art-export.mjs`
 * drives it over CDP, writing the PNGs the card imports.
 *
 * Three layers, each framed to the flat card's preview box (216 × 270
 * CSS px, the device at its silhouette height — the live framing in a
 * box of that size) and rendered offscreen at a supersample with MSAA,
 * then box-filtered to the output size. The 2D card is the DEVICE, not
 * the room (owner, 2026-09-07: "better not render background like the
 * wall and floor in the 2D image"): nothing of the walls or the floor —
 * no cast shadow on the wall, no lamp glow on the room — reaches the art.
 *
 * - `device`: the device alone over a transparent clear, its indicator
 *   UNLIT (a neutral annulus, no emission, no lamp transport) — the LED is
 *   the lamp layer's. The room is hidden; the device's own shadowing and
 *   the baked bounce stay.
 * - `shadow`: the contact shadow only — the room's floor with the
 *   device's contact occlusion on (the device itself hidden, casting
 *   nothing; the walls hidden) against the floor without it, as a black
 *   layer whose alpha multiplies the card to the same ratio: the soft
 *   band under the base the 3D card has, without the key's shadow on the
 *   wall behind, and confined to the device's footprint (the occlusion's
 *   40 cm reach along the floor is a band across the whole card at this
 *   camera). Daylight only; the night floor has no daylight to shade.
 * - `lamp`: what the ring adds to the DEVICE — the device alone with a
 *   WHITE lamp at the idle strength (the annulus's emission and the baked
 *   transport onto the device) minus the same with the lamp off, per
 *   theme, in display space. The glow shader adds it back tinted by the
 *   state colour and scaled by the state's strength, so the 2D LED has
 *   the 3D's geometry and a 2D night device is lit by its lamp the way
 *   the 3D one is, in any state's colour. (An additive difference of
 *   tone-mapped pictures: base + layer reproduces the idle white lamp
 *   exactly and approximates the rest.)
 *
 * Renders go through `renderer.render` with the target as the OUTPUT
 * target, so tone mapping and the sRGB encoding apply per fragment
 * before the MSAA resolve: an edge pixel resolves to encoded colour ×
 * coverage over the transparent clear, which un-premultiplies exactly.
 * (The live graph's pass renders linear and encodes after the resolve,
 * which would darken the fringe.) The direct render compiles its own
 * pipeline variants, synchronously, the first time — seconds; a tool.
 */

/** What the scene hands the export: its objects and the recipe closures
 *  the frame loop itself uses, so the art is a frame of the live card. */
export interface ArtExportInternals {
  readonly renderer: THREE.WebGPURenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.OrthographicCamera;
  readonly device: THREE.Object3D;
  readonly room: THREE.Object3D;
  readonly ringMeshes: readonly THREE.Mesh[];
  readonly ringMaterials: readonly THREE.MeshStandardNodeMaterial[];
  readonly shadowLights: readonly (THREE.DirectionalLight | THREE.SpotLight)[];
  /** The contact shadow's strength uniform. */
  readonly contact: { value: number };
  /** Frame the camera to the flat card's preview box. */
  frameFlatBox(): void;
  /** Frame the camera to the rail card's content box (the live canvas's
   *  own framing) and say how big that box is, CSS px. */
  frameCardBox(): { readonly width: number; readonly height: number };
  applyLighting(light: WeatheredLighting, phase: number): void;
  applyRing(color: THREE.Color, intensity: number): void;
  applyBake(
    hour: number,
    light: WeatheredLighting,
    lift: number,
    liftPx: number,
  ): void;
  /** Take the scene from the live loop / give it back (reframed, woken). */
  begin(): void;
  end(): void;
}

/** The three layers the card imports; `frost`: the whole scene at the
 *  rail card's own framing with the idle lamp, small — the glass the card
 *  shows while its scene builds until the scene has left a picture of its
 *  own (§2.13); and `frame`: the scene as it stands at the request's
 *  lighting and lamp — a check of the framing and of the layers'
 *  ingredients, opaque. */
export type ArtLayer = "device" | "shadow" | "lamp" | "frost" | "frame";

export interface ArtExportRequest {
  readonly layer: ArtLayer;
  readonly theme: ResolvedTheme;
  /** The light theme's hour (the dark theme is always midnight). */
  readonly hour?: number;
  /** The cloud drift, seconds (§2.11); 0 by default. */
  readonly cloudPhase?: number;
  /** Output width, px; the height follows the preview box's aspect. */
  readonly width?: number;
  /** The encoding: PNG (straight alpha) or lossy WebP at `quality`. */
  readonly format?: "png" | "webp";
  readonly quality?: number;
  /** Render at this multiple and box-filter down. */
  readonly supersample?: number;
  /** MSAA samples of the offscreen target. */
  readonly samples?: number;
  /** The lamp layer's white lamp strength (the idle ring's by default);
   *  a `frame`'s lamp strength and colour. */
  readonly lampStrength?: number;
  readonly lampColor?: string;
  /** The CSS opacity the card shows the shadow layer at, divided out. */
  readonly shadowOpacity?: number;
  /** The device's silhouette (the device layer's result): the shadow is
   *  confined to its width, fading over `footprintMargin` of the width
   *  beyond each side (0.06 by default). Without one the contact band
   *  runs across the whole box. */
  readonly footprint?: FractionBox;
  readonly footprintMargin?: number;
}

export interface ArtExportResult {
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
  /** The device layer's opaque extent (the drag silhouette). */
  readonly silhouette: FractionBox | null;
  /** The layer's brightest channel and its mean over the covered pixels,
   *  0–255 (the lamp and shadow layers' weight). */
  readonly peak: number;
  readonly mean: number;
  readonly ms: number;
}

/** Where the LED is in the preview box: the indicator meshes' projected
 *  extent (fractions of the box) and their vertices' radii relative to it,
 *  for the glow shader's geometry. */
export interface RingMeasurement {
  readonly center: readonly [number, number];
  readonly halfExtent: readonly [number, number];
  readonly relativeRadius: { readonly min: number; readonly max: number };
  readonly vertices: number;
}

export interface ArtExport {
  render(request: ArtExportRequest): Promise<ArtExportResult>;
  measureRing(): RingMeasurement;
}

/** The light theme's hour for the art: mid-morning, the key from the
 *  left at a modest elevation, the shadow on the wall in view. */
export const DEFAULT_ART_HOUR = 10;
/** The preview box's aspect (216 × 270) at this width. */
const DEFAULT_WIDTH = 1120;
const PREVIEW_ASPECT = 270 / 216;
/** The frost picture: half the card's CSS size, like the live snapshot
 *  (a quarter of the buffer at 2×), shown under an 8 px blur. */
const DEFAULT_FROST_WIDTH = 168;
const DEFAULT_FROST_QUALITY = 0.8;
const DEFAULT_SUPERSAMPLE = 2;
const DEFAULT_SAMPLES = 4;
/** `.agent-shadow`'s opacity in reference-ux.css. */
const DEFAULT_SHADOW_OPACITY = 0.85;
/** How far past the device's sides the contact shadow fades, as a
 *  fraction of the box's width. */
const DEFAULT_FOOTPRINT_MARGIN = 0.06;
/** The unlit annulus: a neutral, slightly cool grey. */
const UNLIT_RING = new THREE.Color(0.72, 0.74, 0.76);
const WHITE = new THREE.Color(1, 1, 1);

function encodeImage(
  pixels: RgbaBytes,
  width: number,
  height: number,
  format: "png" | "webp",
  quality: number,
): string {
  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const ctx = out.getContext("2d");
  if (ctx === null) throw new Error("2d context unavailable");
  ctx.putImageData(new ImageData(pixels, width, height), 0, 0);
  return format === "webp"
    ? out.toDataURL("image/webp", quality)
    : out.toDataURL("image/png");
}

export function createArtExport(internals: ArtExportInternals): ArtExport {
  const { renderer, scene, camera, device, room, ringMeshes, shadowLights } =
    internals;

  /** The device alone over a transparent clear. */
  const deviceOnly = (): void => {
    room.visible = false;
    scene.background = null;
    renderer.setClearColor(0x000000, 0);
  };
  /** The room's floor alone (the walls hidden), the device hidden. */
  const floorOnly = (): void => {
    device.visible = false;
    room.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh && !mesh.name.includes("ground")) mesh.visible = false;
    });
  };

  /** One render of the scene as it stands into a fresh target, read back
   *  as tight RGBA rows. The shadow maps are re-rendered every time (the
   *  loop's reuse logic is not running). */
  const renderPixels = async (
    width: number,
    height: number,
    samples: number,
  ): Promise<RgbaBytes> => {
    for (const light of shadowLights) light.shadow.needsUpdate = true;
    const target = new THREE.RenderTarget(width, height, {
      samples,
      depthBuffer: true,
    });
    try {
      renderer.setOutputRenderTarget(target);
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      renderer.setOutputRenderTarget(null);
      const raw = await renderer.readRenderTargetPixelsAsync(
        target,
        0,
        0,
        width,
        height,
      );
      const bytes =
        raw instanceof Uint8Array
          ? raw
          : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
      return unpadRows(bytes, width, height);
    } finally {
      renderer.setRenderTarget(null);
      renderer.setOutputRenderTarget(null);
      target.dispose();
    }
  };

  const render = async (req: ArtExportRequest): Promise<ArtExportResult> => {
    const t0 = performance.now();
    const hour =
      req.theme === "dark" ? DARK_HOUR : (req.hour ?? DEFAULT_ART_HOUR);
    const phase = req.cloudPhase ?? 0;
    const light = applyCloudy(lightingAt(hour), phase);
    const frost = req.layer === "frost";
    const width = req.width ?? (frost ? DEFAULT_FROST_WIDTH : DEFAULT_WIDTH);
    const ss = Math.max(1, Math.round(req.supersample ?? DEFAULT_SUPERSAMPLE));
    const samples = req.samples ?? DEFAULT_SAMPLES;
    const savedBackground = scene.background;
    internals.begin();
    try {
      // The framing decides the height: the preview box's aspect, or the
      // rail card's for the frost picture.
      let height = Math.round(width * PREVIEW_ASPECT);
      if (frost) {
        const card = internals.frameCardBox();
        height = Math.round((width * card.height) / card.width);
      } else {
        internals.frameFlatBox();
      }
      const fullWidth = width * ss;
      const fullHeight = height * ss;
      internals.applyLighting(light, phase);
      internals.applyBake(hour, light, 0, 0);
      let pixels: RgbaBytes;
      let silhouette: FractionBox | null = null;
      // The FIRST render after a visibility change is not the steady
      // picture (measured 2026-09-07: the day lamp layer came out with the
      // whole body lifted, a mean of 10.7 against 0.2 once a render had
      // been discarded, and the shadow layer differed the same way). Every
      // layer renders once into the void before its own renders.
      const warm = (): Promise<RgbaBytes> =>
        renderPixels(fullWidth, fullHeight, samples);
      if (req.layer === "device") {
        deviceOnly();
        internals.applyRing(UNLIT_RING, 0);
        await warm();
        const raw = await renderPixels(fullWidth, fullHeight, samples);
        pixels = downsampleToStraight(raw, fullWidth, fullHeight, ss).pixels;
        silhouette = measureOpaqueBox(pixels, width, height);
      } else if (req.layer === "shadow") {
        // The contact occlusion alone, on the floor alone: the device
        // hidden (so it casts nothing) and the walls hidden (the occlusion
        // reaches a few centimetres up the wall behind, which would show
        // beside the device on a flat card), its base still darkening the
        // floor.
        internals.applyRing(UNLIT_RING, 0);
        floorOnly();
        await warm();
        const withContact = await renderPixels(fullWidth, fullHeight, samples);
        internals.contact.value = 0;
        const withoutContact = await renderPixels(
          fullWidth,
          fullHeight,
          samples,
        );
        pixels = downsampleToStraight(
          shadowLayer(
            withContact,
            withoutContact,
            req.shadowOpacity ?? DEFAULT_SHADOW_OPACITY,
          ),
          fullWidth,
          fullHeight,
          ss,
        ).pixels;
        if (req.footprint !== undefined) {
          pixels = confineHorizontally(
            pixels,
            width,
            height,
            req.footprint,
            req.footprintMargin ?? DEFAULT_FOOTPRINT_MARGIN,
          );
        }
      } else if (frost) {
        // The live card at rest: the room, the device, the idle lamp.
        internals.applyRing(
          new THREE.Color(STATE_TARGETS.idle.color),
          STATE_TARGETS.idle.intensity,
        );
        await warm();
        const raw = await renderPixels(fullWidth, fullHeight, samples);
        pixels = downsampleToStraight(raw, fullWidth, fullHeight, ss).pixels;
      } else if (req.layer === "frame") {
        internals.applyRing(
          new THREE.Color(req.lampColor ?? "#ffffff"),
          req.lampStrength ?? STATE_TARGETS.idle.intensity,
        );
        await warm();
        const raw = await renderPixels(fullWidth, fullHeight, samples);
        pixels = downsampleToStraight(raw, fullWidth, fullHeight, ss).pixels;
      } else {
        // The device alone, so the lamp's light on the room stays out.
        deviceOnly();
        // Off: the annulus a neutral surface, no emission, no transport.
        internals.applyRing(UNLIT_RING, 0);
        await warm();
        const off = await renderPixels(fullWidth, fullHeight, samples);
        // On: a white lamp — the annulus emits, the bakes carry its light.
        internals.applyRing(
          WHITE,
          req.lampStrength ?? STATE_TARGETS.idle.intensity,
        );
        const on = await renderPixels(fullWidth, fullHeight, samples);
        pixels = downsampleToStraight(
          lampLayer(on, off),
          fullWidth,
          fullHeight,
          ss,
        ).pixels;
      }
      return {
        dataUrl: encodeImage(
          pixels,
          width,
          height,
          req.format ?? (frost ? "webp" : "png"),
          req.quality ?? (frost ? DEFAULT_FROST_QUALITY : 0.92),
        ),
        width,
        height,
        silhouette,
        peak: peakChannel(pixels),
        mean: Math.round(meanChannel(pixels) * 10) / 10,
        ms: Math.round(performance.now() - t0),
      };
    } finally {
      scene.background = savedBackground;
      renderer.setClearColor(0x000000, 1);
      room.visible = true;
      room.traverse((obj) => {
        obj.visible = true;
      });
      device.visible = true;
      internals.end();
    }
  };

  const measureRing = (): RingMeasurement => {
    internals.begin();
    try {
      internals.frameFlatBox();
      scene.updateMatrixWorld(true);
      camera.updateMatrixWorld();
      const v = new THREE.Vector3();
      const points: number[] = [];
      let minX = Number.POSITIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
      for (const mesh of ringMeshes) {
        const position = mesh.geometry.attributes.position;
        if (position === undefined) continue;
        for (let i = 0; i < position.count; i += 1) {
          v.fromBufferAttribute(position, i)
            .applyMatrix4(mesh.matrixWorld)
            .project(camera);
          const fx = (v.x + 1) / 2;
          const fy = (1 - v.y) / 2;
          points.push(fx, fy);
          if (fx < minX) minX = fx;
          if (fx > maxX) maxX = fx;
          if (fy < minY) minY = fy;
          if (fy > maxY) maxY = fy;
        }
      }
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const hw = Math.max(1e-6, (maxX - minX) / 2);
      const hh = Math.max(1e-6, (maxY - minY) / 2);
      let rMin = Number.POSITIVE_INFINITY;
      let rMax = 0;
      for (let i = 0; i < points.length; i += 2) {
        const r = Math.hypot(
          ((points[i] ?? 0) - cx) / hw,
          ((points[i + 1] ?? 0) - cy) / hh,
        );
        if (r < rMin) rMin = r;
        if (r > rMax) rMax = r;
      }
      return {
        center: [cx, cy],
        halfExtent: [hw, hh],
        relativeRadius: { min: rMin, max: rMax },
        vertices: points.length / 2,
      };
    } finally {
      internals.end();
    }
  };

  return { render, measureRing };
}
