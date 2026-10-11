import type { BanzhuanDeviceState } from "../../hooks/useDeviceState.js";
import { STATE_TARGETS } from "./device-scene/lighting.js";

/**
 * CPU side of the device LED shader (2026-07-12): per-state targets plus
 * the frame step that eases the live uniforms toward them, so a state
 * change MORPHS the lamp (blue → amber over ~a third of a second) instead
 * of snapping, and the success flash and error double-blink are time
 * envelopes. Pure functions + a mutable anim record, so the whole thing
 * unit-tests without GL; DeviceGlow's render loop is a thin uniform-upload
 * shell.
 *
 * Since the flat art is rendered from the 3D scene (2026-09-07, ADR 0057
 * §2.14) the 2D lamp is the 3D indicator's: its colour, its strength
 * relative to idle, and its breath come from the scene's STATE_TARGETS
 * (device-scene/lighting.ts) — one table for both cards.
 */

type Rgb = readonly [number, number, number];

export interface DeviceVisualTarget {
  /** The lamp's colour, display-space 0–1 (the 3D indicator's). */
  readonly lampColor: Rgb;
  /** The lamp's strength relative to the idle lamp the layer was rendered
   *  at (device-scene/art-export.ts). */
  readonly lamp: number;
  /** Breathing rate and depth (fraction of the strength). */
  readonly breathHz: number;
  readonly breathDepth: number;
}

function hexToRgb(hex: string): Rgb {
  const channel = (i: number): number =>
    Number.parseInt(hex.slice(i, i + 2), 16) / 255;
  return [channel(1), channel(3), channel(5)];
}

const STATES: readonly BanzhuanDeviceState[] = [
  "idle",
  "delegated",
  "reading",
  "writing",
  "runningCommand",
  "waitingApproval",
  "verifying",
  "succeeded",
  "failed",
];

export const DEVICE_STATE_VISUALS: Record<
  BanzhuanDeviceState,
  DeviceVisualTarget
> = Object.fromEntries(
  STATES.map((state) => {
    const t = STATE_TARGETS[state];
    return [
      state,
      {
        lampColor: hexToRgb(t.color),
        lamp: t.intensity / STATE_TARGETS.idle.intensity,
        breathHz: t.hz,
        breathDepth: t.depth,
      },
    ];
  }),
) as Record<BanzhuanDeviceState, DeviceVisualTarget>;

/** Time constant of the state-change ease (63% of the way in ~0.35s). */
const COLOR_EASE_S = 0.35;
/** A flash on top of the steady lamp, as the 3D's (+1.5 on 2.4). */
const FLASH_LAMP = 0.6;

export interface DeviceVisualUniforms {
  readonly lampColor: Rgb;
  /** Strength relative to idle, breath-modulated. */
  readonly lamp: number;
  readonly flash: number;
}

export interface DeviceVisualAnim {
  lampColor: [number, number, number];
  lamp: number;
  breathHz: number;
  breathPhase: number;
  breathDepth: number;
  /** Last state seen, for flash edge detection. */
  state: BanzhuanDeviceState;
  flashKind: "none" | "success" | "error";
  flashClockS: number;
}

export function initialDeviceVisual(
  state: BanzhuanDeviceState = "idle",
): DeviceVisualAnim {
  const t = DEVICE_STATE_VISUALS[state];
  return {
    lampColor: [...t.lampColor],
    lamp: t.lamp,
    breathHz: t.breathHz,
    breathPhase: 0,
    breathDepth: t.breathDepth,
    state,
    flashKind: "none",
    flashClockS: 0,
  };
}

/** Mirrors the CSS devSuccess flash: fast rise, ~1.5s glide back down. */
export function successEnvelope(t: number): number {
  if (t < 0) return 0;
  if (t < 0.3) return t / 0.3;
  if (t < 1.5) return 1 - (t - 0.3) / 1.2;
  return 0;
}

/** Mirrors devError's double blink: two pulses inside the first ~0.6s,
 *  then the steady dim-red target carries the state on its own. */
export function errorEnvelope(t: number): number {
  const pulse = (center: number, halfWidth: number): number =>
    Math.max(0, 1 - Math.abs(t - center) / halfWidth);
  return Math.max(pulse(0.1, 0.12), pulse(0.42, 0.15));
}

function lerp(a: number, b: number, k: number): number {
  return a + (b - a) * k;
}

/**
 * Advance the live uniforms one frame toward `state`'s targets.
 * `reduced` (prefers-reduced-motion) pins the breath and skips flashes —
 * colors still ease so a state change reads, it just doesn't blink.
 */
export function stepDeviceVisual(
  anim: DeviceVisualAnim,
  state: BanzhuanDeviceState,
  dtS: number,
  reduced: boolean,
): DeviceVisualUniforms {
  if (state !== anim.state) {
    anim.state = state;
    if (!reduced && state === "succeeded") {
      anim.flashKind = "success";
      anim.flashClockS = 0;
    } else if (!reduced && state === "failed") {
      anim.flashKind = "error";
      anim.flashClockS = 0;
    } else {
      anim.flashKind = "none";
    }
  }

  const t = DEVICE_STATE_VISUALS[state];
  const k = 1 - Math.exp(-dtS / COLOR_EASE_S);
  for (let i = 0; i < 3; i++) {
    anim.lampColor[i] = lerp(anim.lampColor[i] ?? 0, t.lampColor[i] ?? 0, k);
  }
  anim.lamp = lerp(anim.lamp, t.lamp, k);
  anim.breathHz = lerp(anim.breathHz, t.breathHz, k);
  anim.breathDepth = lerp(anim.breathDepth, t.breathDepth, k);

  anim.breathPhase += dtS * 2 * Math.PI * anim.breathHz;
  const breath = reduced
    ? 1
    : 1 + Math.sin(anim.breathPhase) * anim.breathDepth;

  anim.flashClockS += dtS;
  const flash = reduced
    ? 0
    : anim.flashKind === "success"
      ? successEnvelope(anim.flashClockS)
      : anim.flashKind === "error"
        ? errorEnvelope(anim.flashClockS)
        : 0;

  return {
    lampColor: anim.lampColor,
    lamp: anim.lamp * breath + flash * FLASH_LAMP,
    flash,
  };
}
