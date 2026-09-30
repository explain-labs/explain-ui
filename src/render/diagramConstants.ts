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
