/**
 * The 板砖 device LED shader. First cut (2026-07-12): one fragment pass of
 * analytic fields — spill wash, halo, ring body, hot core — around the
 * LED's place on the flat art, replacing an SVG ellipse stack whose CSS
 * filters could never turn the core amber. Second cut (2026-09-07, ADR
 * 0057 §2.14): the flat art is rendered from the 3D scene, and so is the
 * lamp — `agent_lamp*.webp` is what the scene's white lamp at the idle
 * strength ADDS to the picture (the annulus's own glow and its light on
 * the device and the room, per theme, in display space; art-export.ts).
 * The pass samples that layer, tints it by the state colour, scales it by
 * the state's strength and breath, and adds a soft halo where the 3D's
 * bloom pass puts one. Everything is LIGHT: the canvas composites with
 * `mix-blend-mode: plus-lighter` (reference-ux.css) and the fragment is
 * premultiplied, so the layer adds to whatever is under it — the device
 * art, the shadow, the card — the way emission adds in the scene.
 *
 * Uniforms come from device-visual-engine's per-frame step: the colour
 * and strength eased between states, breath folded into the gain, and
 * the success/error flash envelopes in uFlash.
 */
export const DEVICE_SHADER_SOURCE = `
precision mediump float;

uniform vec2 iResolution;
uniform sampler2D uLamp;   /* the lamp layer: a white idle lamp's addition */
uniform float uLampReady;  /* 0 until the theme's layer is bound */
uniform vec2 uCenter;      /* ring centre, fraction of the canvas, y-down */
uniform vec2 uRingRadius;  /* the annulus's semi-axes, fraction of canvas w/h */
uniform vec3 uTint;        /* the state colour (the 3D indicator's) */
uniform float uWhiten;     /* how far the layer's brightest parts lean to white */
uniform float uGain;       /* strength relative to idle, breath-modulated */
uniform float uHalo;       /* the halo's strength */
uniform float uFlash;      /* success/error event envelope, 0..1 */

void main() {
  /* y-down fraction coords: the layer's rows and the CSS box read the
     same way. */
  vec2 uv = vec2(gl_FragCoord.x, iResolution.y - gl_FragCoord.y) / iResolution;

  vec3 lamp = texture2D(uLamp, uv).rgb * uLampReady;
  /* Tone mapping whitens a bright emitter: the brightest parts of the
     layer (the annulus) lean to white, the faint spill keeps the colour. */
  float peak = max(lamp.r, max(lamp.g, lamp.b));
  vec3 tint = mix(uTint, vec3(1.0), uWhiten * peak);

  /* The halo: the bloom pass's soft glow hugging the annulus. */
  float r = length((uv - uCenter) / uRingRadius);
  float halo = exp(-abs(r - 1.0) * 2.6) * uHalo * uLampReady;

  vec3 col = (lamp + vec3(halo)) * tint * uGain;
  /* Flash rides on top of the steady state: a white-leaning burst through
     the lamp and the halo (success pop, error double-blink). */
  col += (lamp + vec3(halo)) * 0.8 * uFlash * mix(vec3(1.0), tint, 0.35);

  col = clamp(col, 0.0, 1.0);
  /* Premultiplied: the colour is the light, the alpha its coverage. */
  gl_FragColor = vec4(col, max(col.r, max(col.g, col.b)));
}
`;

/**
 * Where the LED is on agent_device.png, as fractions of the 216×270
 * `.agent-preview` box (the glow canvas fills that box): the indicator
 * meshes' projected extent, measured by the art export (`measureRing`,
 * 2026-09-07: centre 0.4493 / 0.3356, half-extent 0.0495 × 0.0441, the
 * annulus between 0.83 and 1.01 of it). The halo hugs the annulus's
 * middle. If the art is re-rendered with a different framing, the export
 * prints the new numbers.
 */
export const DEVICE_GLOW_GEOMETRY = {
  center: [0.4493, 0.3356] as const,
  ringRadius: [0.0465, 0.0414] as const,
};

/** How far the layer's brightest parts lean to white (the tone curve's
 *  shoulder on the 3D annulus), and the halo's strength. */
export const DEVICE_GLOW_LOOK = { whiten: 0.5, halo: 0.3 } as const;
