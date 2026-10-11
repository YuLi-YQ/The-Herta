import type { BanzhuanDeviceState } from "../../../hooks/useDeviceState.js";

/**
 * The device scene's lighting tables (ADR 0057 §2, amended 2026-09-06 §2.1b:
 * the pale room). Ported from the owner's study (reference_UX_design/
 * banzhuan-3d-demo: study-model.js anchors, webgpu-lighting.js daylight and
 * adaptation, baked-material.js#timeWeights) in its "Previous · pale room"
 * configuration — the anchor key positions as authored, fill / rim / sky /
 * environment at full strength, the softbox a fraction of the key. Pure numbers
 * and interpolation, no three.js, so the theme mapping and the day/night
 * blend unit-test in node.
 *
 * Time of day is the study's parameter. In the light theme it follows the
 * CLOCK, folded so the card never leaves daylight (`cardHourFor`); the dark
 * theme is the study's midnight, static — its night has no daylight term
 * left to move (owner, 2026-09-06).
 */

/** Ring indicator targets per device state: colour, emissive strength, the
 *  breath's rate (Hz) and depth. Same nine states as the flat card. */
export interface StateTarget {
  readonly color: string;
  readonly intensity: number;
  readonly hz: number;
  readonly depth: number;
}

export const STATE_TARGETS: Record<BanzhuanDeviceState, StateTarget> = {
  idle: { color: "#86cdf2", intensity: 2.4, hz: 1 / 3.8, depth: 0.065 },
  delegated: { color: "#77c8ff", intensity: 3.8, hz: 1 / 1.7, depth: 0.13 },
  reading: { color: "#77c8ff", intensity: 3.4, hz: 1 / 2, depth: 0.11 },
  writing: { color: "#77c8ff", intensity: 3.9, hz: 1 / 1.5, depth: 0.12 },
  runningCommand: {
    color: "#77c8ff",
    intensity: 4.0,
    hz: 1 / 1.35,
    depth: 0.13,
  },
  verifying: { color: "#77c8ff", intensity: 3.8, hz: 1 / 1.8, depth: 0.1 },
  waitingApproval: {
    color: "#ffc97e",
    intensity: 3.2,
    hz: 1 / 2.7,
    depth: 0.1,
  },
  succeeded: { color: "#87e5b0", intensity: 2.7, hz: 1 / 3, depth: 0.04 },
  failed: { color: "#f99586", intensity: 2.6, hz: 1 / 4, depth: 0.025 },
};

/** The dark theme's hour: the study's midnight (ring and outline), which is
 *  also what the flat night render shows. The light theme's hour comes from
 *  the clock (`cardHourFor`). */
export const DARK_HOUR = 0;

/** The card's daylight window. It starts at 07:00, not 06:00: the study's
 *  dawn ramp runs 05:00–08:00, so 06:00 is a quarter lit and 07:00 three
 *  quarters — the light theme must never look like night. Dusk is 18:00,
 *  the last full-daylight hour before the study's evening ramp. */
const CARD_DAWN = 7;
const CARD_DUSK = 18;

/**
 * The card's hour for a theme and a real clock time.
 *
 * Light theme: daylight around the whole clock. Twenty-four real hours
 * fold onto the eleven daylight ones at real dawn and dusk — during the
 * real day (06:00–18:00) the card runs from its dawn to its dusk with the
 * real sun, and through the real night it runs back from dusk to dawn, so
 * real midnight is card noon-ish (12:30). Continuous at 06:00, 18:00 and
 * midnight; the card's sun reverses at dusk and dawn, which nobody watches
 * happen.
 *
 * Dark theme: midnight, always.
 */
export function cardHourFor(theme: "light" | "dark", date: Date): number {
  if (theme === "dark") return DARK_HOUR;
  const t = date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
  const span = (CARD_DUSK - CARD_DAWN) / 12;
  if (t >= 6 && t <= 18) return CARD_DAWN + (t - 6) * span;
  const sinceDusk = t > 18 ? t - 18 : t + 6;
  return CARD_DUSK - sinceDusk * span;
}

/** The key's path across the day, in the study's design units around the
 *  device (metres × 20). The AZIMUTH is pinned ~10° left of the camera's
 *  front: further left, the left wall's shadow bands the device's front;
 *  any less, or from the right, the device's own shadow hides behind the
 *  device (measured against the alcove GLB, 2026-09-06). Only the
 *  ELEVATION travels — 12° at dawn and dusk, 20° at the accepted 08:30
 *  morning, 50° at noon — so the shadow on the wall runs long → short →
 *  long and stays in view all day. */
const KEY_DISTANCE = 6.48;
const KEY_AZIMUTH = Math.atan2(1.1, 6);
const KEY_TARGET = [0, 1.9, 0] as const;

export function keyElevationAt(hour: number): number {
  const h = Math.min(18, Math.max(6, wrapHour(hour)));
  const arc = Math.sin((Math.PI * (h - 6)) / 12);
  return ((12 + 38 * arc ** 3) * Math.PI) / 180;
}

export function keyPositionAt(hour: number): [number, number, number] {
  const elevation = keyElevationAt(hour);
  const flat = Math.cos(elevation);
  return [
    KEY_TARGET[0] - KEY_DISTANCE * flat * Math.sin(KEY_AZIMUTH),
    KEY_TARGET[1] + KEY_DISTANCE * Math.sin(elevation),
    KEY_TARGET[2] + KEY_DISTANCE * flat * Math.cos(KEY_AZIMUTH),
  ];
}

export interface Lighting {
  readonly background: string;
  readonly keyColor: string;
  readonly key: number;
  readonly fill: number;
  readonly rim: number;
  readonly sky: number;
  readonly environment: number;
  /** The auxiliary softbox: SOFTBOX_PER_KEY × key in the pale room. */
  readonly softbox: number;
  readonly exposure: number;
  readonly rotation: number;
  readonly night: number;
  /** Key light position in the study's design units (`keyPositionAt`). */
  readonly position: readonly [number, number, number];
  /** Daylight presence, 0 after hours (22:00–05:00) → 1 in the day, with
   *  smooth dawn/dusk ramps. */
  readonly external: number;
  readonly afterHours: boolean;
  /** The weak night outline spotlight's intensity. */
  readonly contour: number;
  /** Scheduled camera exposure adaptation (≤ +log2(12) stops). */
  readonly adaptation: number;
}

interface Anchor {
  readonly h: number;
  readonly background: string;
  readonly keyColor: string;
  readonly key: number;
  readonly fill: number;
  readonly rim: number;
  readonly sky: number;
  readonly environment: number;
  readonly exposure: number;
  readonly rotation: number;
  readonly night: number;
}

/** The study's anchors: colour, intensities, exposure and environment
 *  rotation by hour. The key's POSITION is not theirs any more — it comes
 *  from `keyPositionAt` (see there for why the study's positions could not
 *  stay). */
const ANCHORS: readonly Anchor[] = [
  {
    h: 0,
    background: "#101b2b",
    keyColor: "#9abef4",
    key: 0.5,
    fill: 0.14,
    rim: 0.85,
    sky: 0.16,
    environment: 0.18,
    exposure: 0.87,
    rotation: -0.2,
    night: 1,
  },
  {
    h: 5,
    background: "#333e52",
    keyColor: "#bcbed9",
    key: 0.7,
    fill: 0.25,
    rim: 0.9,
    sky: 0.25,
    environment: 0.3,
    exposure: 0.95,
    rotation: -0.3,
    night: 0.65,
  },
  {
    h: 8,
    background: "#e2e9e7",
    keyColor: "#ffe1b5",
    key: 2.7,
    fill: 0.75,
    rim: 1.25,
    sky: 0.64,
    environment: 0.72,
    exposure: 1.08,
    rotation: -0.15,
    night: 0,
  },
  {
    h: 13,
    background: "#e5ecee",
    keyColor: "#f1f8ff",
    key: 3.1,
    fill: 1.0,
    rim: 1.25,
    sky: 0.9,
    environment: 0.83,
    exposure: 1.03,
    rotation: 0.18,
    night: 0,
  },
  {
    h: 18,
    background: "#a5a4ab",
    keyColor: "#ffb779",
    key: 2.5,
    fill: 0.48,
    rim: 1.4,
    sky: 0.42,
    environment: 0.53,
    exposure: 1.02,
    rotation: 0.7,
    night: 0.12,
  },
  {
    h: 21,
    background: "#162539",
    keyColor: "#9ac9fc",
    key: 0.63,
    fill: 0.2,
    rim: 1.0,
    sky: 0.22,
    environment: 0.25,
    exposure: 0.91,
    rotation: 0.1,
    night: 0.88,
  },
  {
    h: 24,
    background: "#101b2b",
    keyColor: "#9abef4",
    key: 0.5,
    fill: 0.14,
    rim: 0.85,
    sky: 0.16,
    environment: 0.18,
    exposure: 0.87,
    rotation: -0.2,
    night: 1,
  },
];

/** The study's 5×5 LTC panel ran at 0.32 × key; the card's softbox is a
 *  directional light from the same place, matched by eye at 0.45 of that
 *  (ADR 0057 §2.9). */
const SOFTBOX_PER_KEY = 0.144;

const smooth = (t: number): number => t * t * (3 - 2 * t);
const wrapHour = (hour: number): number => ((hour % 24) + 24) % 24;

const srgbToLinear = (v: number): number =>
  v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
const linearToSrgb = (v: number): number =>
  v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;

/** Blend two `#rrggbb` colours in linear light. */
export function mixHexColor(a: string, b: string, t: number): string {
  const channels = [1, 3, 5].map((i) => {
    const x = srgbToLinear(Number.parseInt(a.slice(i, i + 2), 16) / 255);
    const y = srgbToLinear(Number.parseInt(b.slice(i, i + 2), 16) / 255);
    const v = Math.min(1, Math.max(0, linearToSrgb(x + (y - x) * t)));
    return Math.round(v * 255)
      .toString(16)
      .padStart(2, "0");
  });
  return `#${channels.join("")}`;
}

/** Daylight presence: off 22:00–05:00, smooth ramps 05–08 and 18–22. */
export function externalLightAt(hour: number): number {
  const h = wrapHour(hour);
  if (h <= 5 || h >= 22) return 0;
  if (h < 8) return smooth((h - 5) / 3);
  if (h > 18) return 1 - smooth((h - 18) / 4);
  return 1;
}

/** The complete live-light recipe at an hour: the study's anchors blended
 *  with a smoothstep, daylight presence, the night outline and the exposure
 *  adaptation applied. */
export function lightingAt(hour: number): Lighting {
  const h = wrapHour(hour);
  const next = ANCHORS.findIndex((a) => a.h > h);
  const a = ANCHORS[next - 1] as Anchor;
  const b = ANCHORS[next] as Anchor;
  const t = smooth((h - a.h) / (b.h - a.h));
  const lerp = (
    k: keyof Omit<Anchor, "h" | "background" | "keyColor">,
  ): number => a[k] + (b[k] - a[k]) * t;
  const external = externalLightAt(h);
  const adaptation = 12 / (1 + 11 * external);
  const key = lerp("key") * external;
  return {
    background: mixHexColor(a.background, b.background, t),
    keyColor: mixHexColor(a.keyColor, b.keyColor, t),
    key,
    fill: lerp("fill") * external,
    rim: lerp("rim") * external,
    sky: lerp("sky") * external,
    environment: lerp("environment") * external,
    softbox: key * SOFTBOX_PER_KEY,
    exposure: lerp("exposure") * adaptation,
    rotation: lerp("rotation"),
    night: lerp("night"),
    position: keyPositionAt(h),
    external,
    afterHours: external === 0,
    contour: 0.003 * (1 - external) ** 2,
    adaptation,
  };
}

/** The card's weather is the study's "Passing clouds", fixed (ADR 0057
 *  §2.11; WEATHER-STUDY.md, weather.js): ratios of the sunny daylight, a
 *  cooler key, dimmer baked bounce, and a cloud field of this darkness
 *  drifting across the key (scene.ts). The lamp is never weather. */
export const CLOUDY = {
  key: 0.96,
  fill: 1.02,
  rim: 0.86,
  sky: 1.16,
  environment: 0.86,
  bounce: 0.82,
  background: 0.9,
  /** How far the key is mixed toward CLOUDY_KEY_COLOR, and the daylight
   *  bounce's tint (1 − 0.16c, 1 − 0.055c, 1). */
  cool: 0.32,
  cloudDepth: 0.76,
} as const;
export const CLOUDY_KEY_COLOR = "#dbe7f2";

export interface WeatheredLighting extends Lighting {
  /** Multiplier on the background colour (the study scales the colour,
   *  not the anchor). */
  readonly backgroundScale: number;
  /** Multiplier on the baked daylight bounce. */
  readonly bounce: number;
  /** 0 = sunny daylight, 1 = fully cooled. */
  readonly cool: number;
  /** The cloud field's darkness on the key, 0 = none. */
  readonly cloudDepth: number;
}

/** The cloudy recipe over the sunny one. After hours there is no daylight
 *  to cloud: the night outline and the lamp are untouched. `phase` is the
 *  cloud drift in seconds; the baked bounce breathes with it slowly (a
 *  33 s cycle of up to 7 %), the study's stand-in for a changing sky over
 *  bakes that were not re-baked per weather. */
export function applyCloudy(light: Lighting, phase = 0): WeatheredLighting {
  if (light.afterHours) {
    return { ...light, backgroundScale: 1, bounce: 1, cool: 0, cloudDepth: 0 };
  }
  const sky = 0.5 + 0.5 * Math.sin(phase * 0.19);
  return {
    ...light,
    keyColor: mixHexColor(light.keyColor, CLOUDY_KEY_COLOR, CLOUDY.cool),
    key: light.key * CLOUDY.key,
    fill: light.fill * CLOUDY.fill,
    rim: light.rim * CLOUDY.rim,
    sky: light.sky * CLOUDY.sky,
    environment: light.environment * CLOUDY.environment,
    softbox: light.softbox * CLOUDY.key,
    backgroundScale: CLOUDY.background,
    bounce: CLOUDY.bounce * (1 - 0.07 * sky),
    cool: CLOUDY.cool,
    cloudDepth: CLOUDY.cloudDepth,
  };
}

/** Weights of the three baked daylight presets (morning, midday, evening)
 *  plus the textureless night slot, blended by hour. Sums to 1. */
export function timeWeights(hour: number): [number, number, number, number] {
  const h = wrapHour(hour);
  const anchors = [
    { h: 0, i: 3 },
    { h: 5, i: 3 },
    { h: 8, i: 0 },
    { h: 13, i: 1 },
    { h: 18, i: 2 },
    { h: 22, i: 3 },
    { h: 24, i: 3 },
  ];
  const j = anchors.findIndex((x) => x.h > h);
  const a = anchors[j - 1] as (typeof anchors)[number];
  const b = anchors[j] as (typeof anchors)[number];
  const t = smooth((h - a.h) / (b.h - a.h));
  const w: [number, number, number, number] = [0, 0, 0, 0];
  w[a.i] = (w[a.i] ?? 0) + (1 - t);
  w[b.i] = (w[b.i] ?? 0) + t;
  return w;
}

/** Shortest signed distance from `from` to `to` around the 24-hour circle,
 *  so a theme flip eases through dusk rather than the long way round. */
export function hourDelta(from: number, to: number): number {
  let d = wrapHour(to) - wrapHour(from);
  if (d > 12) d -= 24;
  if (d < -12) d += 24;
  return d;
}
