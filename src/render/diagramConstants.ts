// Shared diagram-editor constants — the single source of truth for what the
// diagram editor (Diagram.vue), the bot-command validator (botCommands.ts), and
// the bot-facing catalog generator (build_command_catalog.mjs) all agree on.
// Keep this list aligned with the sprite images in public/gfx.

// Sprite images available in public/gfx (arrow.png is the flow indicator, not a
// picto). A compartment/connector's `picto` must be one of these.
export const PICTOS = [
  "container.png",
  "vessel.png",
  "lung.png",
  "pump.png",
  "blood.png",
  "exchanger.png",
  "gas_container.png",
  "general.png",
  "placenta.png",
  "trachea.png",
] as const;

// Connector path shapes. "arc"/"arc_r" run clockwise/anticlockwise along the ring
// between two ring nodes; with an off-ring endpoint both draw the same chord-arc,
// and "arc_flip" draws that chord-arc bending the other way.
export const PATH_TYPES = ["straight", "arc", "arc_r", "arc_flip"] as const;

// Cosmetic layout-patch whitelist for the bot `setLayout` action. A patch may
// only touch these dotted paths into `component.layout` — never structural
// fields (`type`, `dbcFrom`, `dbcTo`, `models`). Mirrors what the human
// inspector in Diagram.vue can edit.
export const LAYOUT_PATCH_WHITELIST = [
  "general.alpha",
  "general.z_index",
  "general.tinting",
  "sprite.color",
  "sprite.scale.x",
  "sprite.scale.y",
  "sprite.rotation",
  "sprite.pos",
  "label.size",
  "label.color",
  "label.pos_x",
  "label.pos_y",
  "path.type",
  "path.width",
] as const;

// ---- O2-content colour ramp (compartment tint) ------------------------------
// Default to2 window; a diagram may override it with settings.to2_lo/to2_hi.
export const TO2_LO = 3.0;
export const TO2_HI = 8.8;
export const DEOX_RGB = [0x16, 0x48, 0xb0]; // dark blue (deoxygenated)
export const OX_RGB = [0xe2, 0x3a, 0x66]; // pink-red (oxygenated)
// Bias (>1) keeps the gradient blue across the venous range and swings to
// pink-red only near the oxygenated top, so mid-saturation (venous) blood reads
// blue-purple rather than pink. Linear interp would put systemic venous at the
// midpoint, i.e. magenta.
export const RAMP_GAMMA = 4.0;

// Map blood O2 content (to2) onto the deox→ox ramp, returning unrounded rgb so
// callers can smooth it over frames before packing to a tint int.
export function rgbFromTo2(to2: number, lo: number, hi: number): [number, number, number] {
  if (Number.isNaN(to2)) return [0x66, 0x66, 0x66];
  let t = (to2 - lo) / (hi - lo || 1e-6);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  t = Math.pow(t, RAMP_GAMMA);
  return [
    DEOX_RGB[0] + (OX_RGB[0] - DEOX_RGB[0]) * t,
    DEOX_RGB[1] + (OX_RGB[1] - DEOX_RGB[1]) * t,
    DEOX_RGB[2] + (OX_RGB[2] - DEOX_RGB[2]) * t,
  ];
}

// The ramp as a CSS linear-gradient (low → high to2), sampled so the legend
// shows the real gamma curve rather than a straight two-stop blend.
export function to2RampCss(stops = 12, direction = "to right"): string {
  const parts: string[] = [];
  for (let i = 0; i <= stops; i++) {
    const f = i / stops;
    const [r, g, b] = rgbFromTo2(TO2_LO + (TO2_HI - TO2_LO) * f, TO2_LO, TO2_HI);
    parts.push(`rgb(${Math.round(r)} ${Math.round(g)} ${Math.round(b)}) ${(f * 100).toFixed(0)}%`);
  }
  return `linear-gradient(${direction}, ${parts.join(", ")})`;
}
