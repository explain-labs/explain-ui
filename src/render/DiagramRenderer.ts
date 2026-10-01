import { Application, Assets, Sprite, Graphics, Text, Texture } from "pixi.js";
import { ANIM_TIME_SLOT, animMagOffset, animTintOffset } from "@explain/helpers/RealtimeChannels";
import { DEOX_RGB, DEVICE_BAND_DEFAULT, TO2_HI, TO2_LO, rgbFromTo2 } from "./diagramConstants";
import type {
  AnimFrame,
  ChartFrame,
  ChannelsPayload,
  RendererAdapter,
} from "./types";

// PixiJS (v8) adapter for the sprite diagram. The VIEWER half of the diagram:
// compartments are sprites scaled by volume and tinted by oxygenation (to2);
// connectors are static paths recolored/faded by flow. Editor interactions are
// Phase E. Per-frame updates come from the RealtimeBus anim snapshot and never
// touch Vue reactivity.
//
// Geometry/colour math is ported from the old Quasar app's ui_elements/
// Compartment.js + Connector.js (Pixi v7 → v8: async Application.init,
// Assets.load, Graphics build-then-stroke, Container.tint for recolour).

const DEG = Math.PI / 180;

interface CompNode {
  x: number;
  y: number;
  posType: string;
  dgs: number;
  sprite: Sprite;
  glow: Sprite | null; // soft additive halo behind the disc (tinted by to2)
  rim: Sprite | null; // enlarged tinted disc behind, reads as a bright edge
  cr: number; // smoothed tint rgb (damps per-frame to2 flicker)
  cg: number;
  cb: number;
  label: Text | null; // caption, follows the sprite
  layout: any;
  lastR: number; // last volume-derived disc radius (so a live rescale can
  // re-apply sprite size immediately, even with the sim paused)
  lastTo2: number; // last raw to2 (so a live tint-window change re-colours now)
  group: string | null; // device group (shown/hidden at runtime), null = always
  spin: number; // live spin rate (rev/s, e.g. a pump), 0 = static
  spinAngle: number; // accumulated spin (rad), added on top of layout rotation
}

interface ConnNode {
  name: string;
  group: string | null;
  graphics: Graphics;
  layout: any;
  from: string;
  to: string;
  dots: Sprite[]; // train of flow indicators riding the path
  smFlow: number; // smoothed |flow| → dot size & opacity
  cr: number; // smoothed dot tint rgb
  cg: number;
  cb: number;
  pos: number; // normalized phase along the path [0,1)
  geom: any; // {type:'straight',x1,y1,x2,y2} | {type:'arc',cx,cy,r,from,to}
  lastTo2: number; // last raw upstream to2 (for a live tint-window change)
}

// ---- Flow indicator: a train of small discs that stream along each connector.
// Calibrated for Resistor.flow in L/s (~0.003-0.05 L/s). Direction and speed
// come from the instantaneous flow; a smoothed magnitude gently scales the dot
// size and fades the dots out on near-zero-flow vessels, so closed shunts read
// as still. The path itself stays a fixed neutral grey backbone.
// Sprite images live in public/gfx/. Always load them by ABSOLUTE path: a
// relative "gfx/x.png" resolves against the page URL, so on /lesson/<id> it
// became /lesson/gfx/x.png (the SPA's index.html) and the diagram failed to init.
const gfxPath = (picto: string) => "/gfx/" + picto.replace(/^.*gfx\//, "");

const DOT_PICTO = gfxPath("container.png"); // a small disc that rides the path
const DOT_SCALE = 0.03; // base dot size (container.png is ~318 px → ~10 px)
const DOT_ALPHA = 0.95;
const DOT_LIGHTEN = 0.4; // lift the dot tint toward white so it pops on the path
const DOT_SPEED = 2.0; // path fraction advanced per unit flow per frame
const DOT_SPACING_PX = 64; // target spacing between dots along a path
const DOT_MIN = 2; // min / max dots per connector
const DOT_MAX = 7;
const DOT_FLOW_REF = 0.004; // |flow| (L/s) at which dots reach full size/opacity.
// Lowered from 0.02 so low-flow beds (e.g. the uterine circulation ~50 mL/min ≈
// 0.00083 L/s) still render as full-size, opaque dot trains rather than dim
// near-invisible specks. Controls dot size/opacity only — dot *speed* tracks raw
// flow — so high-flow connectors simply saturate at full size sooner.
const DOT_SCALE_MIN = 0.8; // dot size multiplier at low flow …
const DOT_SCALE_MAX = 1.35; // … and at/above DOT_FLOW_REF
const FLOW_LERP = 0.12; // smoothing for the per-connector flow magnitude

// ---- Compartment depth: a soft additive glow behind each disc (tinted by
// oxygenation, brightened by fill) plus a brighter rim — an enlarged tinted copy
// of the disc that peeks out as a crisp edge against the backdrop.
const GLOW_SCALE = 1.95; // glow radius relative to the disc
const GLOW_ALPHA_MAX = 0.5; // glow opacity at full fill
const RIM_SCALE = 1.12; // rim disc size relative to the main disc
const RIM_LIGHTEN = 0.55; // how far the rim tint is lerped toward white
const TINT_LERP = 0.18; // per-frame smoothing of compartment / dot colour

// Connector paths are a fixed neutral dark grey backbone — flow is conveyed by
// the streaming dots, which take the upstream component's colour.
const CONNECTOR_COLOR = 0x4a4a4a;
// Backdrop vignette centre (lighter than the soft-faded edge), drawn behind the
// component ring so the inside of the ring reads with depth.
const DISC_COLOR = 0x2a2a2a;
// Editor alignment grid (toggleable). Subtle lines; snapping uses gridSize.
const GRID_COLOR = 0x3a3a3a;
const GRID_ALPHA = 0.6;
const GRID_SIZE_DEFAULT = 20;
// Margin (px at scaling 1) reserved between the layout ring and the panel edge
// for the component sprites/labels that sit ON the ring (anchor 0.5, so they
// extend ~half their size outward). The ring fills the panel minus this.
const RING_MARGIN = 60;

export class DiagramRenderer implements RendererAdapter {
  private el: HTMLElement;
  private diagram: any;
  private app: Application | null = null;
  private ready = false;

  private comps: Record<string, CompNode> = {};
  private conns: ConnNode[] = [];
  private animIndex: Record<string, number> = {};
  private bgSprite: Sprite | null = null; // vignette backdrop under the ring
  private glowTex: Texture | null = null; // soft radial halo (generated once)
  private vignetteTex: Texture | null = null; // backdrop gradient (generated once)
  private gridG: Graphics | null = null; // editor alignment grid overlay
  private gridOn = false;
  private gridSize = GRID_SIZE_DEFAULT;

  // stage geometry (computed once at build)
  private xCenter = 0;
  private yCenter = 0;
  private ringR = 0; // layout-circle radius (px), fits the smaller dimension
  private xOffset = 0;
  private yOffset = 0;
  private scaling = 1;
  private speed = 1;
  // to2 (O2 content) gradient window for tinting; per-diagram, live-editable
  private to2Lo = TO2_LO;
  private to2Hi = TO2_HI;
  private ro: ResizeObserver | null = null;
  // device groups (e.g. the ECLS circuit): built hidden, shown via
  // setGroupVisible. While any grouped node is visible the ring shrinks up to
  // open a band of `deviceBand` × ring radius below it.
  private shownGroups = new Set<string>();
  private deviceBand = DEVICE_BAND_DEFAULT;
  // edge margin (px at scaling 1) reserved for sprites sitting on the ring;
  // settings.ringMargin overrides it for diagrams whose sprites are large for
  // their scaling (adult volumes are ~15x a neonate's at scaling 0.4)
  private ringMargin = RING_MARGIN;
  private bandOn = false;
  private lastFrameMs = 0; // wall clock of the previous frame (drives spin)

  // editor state (Phase E)
  private editMode = false;
  private selected: string | null = null;
  private selectedKind: "comp" | "conn" | null = null;
  private selectionG: Graphics | null = null;
  // lesson "pointing": pulsing amber outlines + optional captions, independent
  // of the editor selection (see setHighlight)
  private highlightG: Graphics | null = null;
  private highlightNames: string[] = [];
  private highlightTexts = new Map<string, Text>();
  private highlightTick: (() => void) | null = null;
  private dragging: string | null = null;
  private dragOffsetX = 0;
  private dragOffsetY = 0;
  private dragStartX = 0; // pointer pos at press, to tell a click from a drag
  private dragStartY = 0;
  private dragMoved = false;
  private wasSelected = false; // was the pressed component already selected?
  private onSelectCb:
    | ((name: string | null, comp: any, kind: "comp" | "conn" | null) => void)
    | null = null;
  // fired after a structural edit that changes the animation binding
  // (add/connect/delete/models) so the host can push the diagram to the worker.
  private onChangeCb: (() => void) | null = null;
  private connectMode = false;
  private connectFrom: string | null = null;

  constructor(el: HTMLElement, diagramDefinition: any) {
    this.el = el;
    this.diagram = diagramDefinition;
  }

  /** Async setup: create the Pixi app, preload sprites, build the scene. */
  async init() {
    const settings = this.diagram?.settings ?? {};
    this.app = new Application();
    await this.app.init({
      resizeTo: this.el,
      antialias: true,
      autoDensity: true,
      resolution: globalThis.devicePixelRatio || 1,
      // transparent canvas so the page background shows through and the diagram
      // matches the surrounding UI (incl. theme changes)
      backgroundAlpha: 0,
    });
    this.el.appendChild(this.app.canvas);
    this.app.stage.sortableChildren = true;

    // stage-level pointer handling for editor drag
    this.app.stage.eventMode = "static";
    this.app.stage.hitArea = this.app.screen;
    this.app.stage.on("pointermove", (e: any) => this.onDragMove(e));
    this.app.stage.on("pointerup", () => this.onDragEnd());
    this.app.stage.on("pointerupoutside", () => this.onDragEnd());

    this.xOffset = numberOr(settings.xOffset, 0);
    this.yOffset = numberOr(settings.yOffset, 0);
    this.scaling = numberOr(settings.scaling, 1);
    this.speed = numberOr(settings.speed, 1);
    this.to2Lo = numberOr(settings.to2_lo, TO2_LO);
    this.to2Hi = numberOr(settings.to2_hi, TO2_HI);
    this.gridOn = settings.grid === true;
    this.gridSize = settings.gridSize > 0 ? settings.gridSize : GRID_SIZE_DEFAULT;
    this.deviceBand = settings.deviceBand >= 0 ? settings.deviceBand : DEVICE_BAND_DEFAULT;
    this.ringMargin = settings.ringMargin > 0 ? settings.ringMargin : RING_MARGIN;
    this.recomputeGeometry();

    await this.preloadTextures();
    this.buildTextures();
    this.drawBackdrop();
    this.drawGrid();
    this.buildCompartments();
    this.buildConnectors();
    this.ready = true;
    this.applyGroupVisibility(); // grouped (device) components start hidden

    // recompute layout when the canvas resizes
    this.ro = new ResizeObserver(() => this.onResize());
    this.ro.observe(this.el);
  }

  private async preloadTextures() {
    const pictos = new Set<string>([DOT_PICTO]); // flow indicator (streaming dots)
    for (const comp of Object.values<any>(this.diagram?.components ?? {})) {
      pictos.add(gfxPath(comp.picto || "container.png"));
    }
    await Assets.load([...pictos]);
  }

  /** Recompute stage centre and the layout-circle radius. The ring fills the
   *  panel exactly: based on the SMALLER half-dimension (so the circle fits even
   *  when the panel is much wider than it is tall) minus a margin that reserves
   *  room for the sprites/labels sitting on the ring. The scenario `radius`
   *  setting is intentionally NOT applied here — it would shrink the diagram.
   *  With the device band on, the ring + band (b × ringR) together fit the
   *  height: ringR = (H − 2·margin) / (2 + b), and the centre moves up by
   *  b·ringR/2 so the band opens below the ring. */
  private canvasHeight(): number {
    return this.app?.screen.height || this.el.clientHeight;
  }

  private recomputeGeometry() {
    if (!this.app) return;
    const w = this.app.screen.width || this.el.clientWidth;
    const h = this.app.screen.height || this.el.clientHeight;
    const margin = this.ringMargin * this.scaling;
    const b = this.bandOn ? this.deviceBand : 0;
    // bottom-pinned captions (the title) need their strip kept clear of the ring
    const bottom = Math.max(margin, this.footerHeight() + margin / 2);
    this.xCenter = w / 2;
    const fill = Math.min(w / 2 - margin, (h - margin - bottom) / (2 + b));
    this.ringR = Math.max(20, fill);
    // centre the ring (+ band) between the top margin and the bottom strip
    this.yCenter = (margin + h - bottom - b * this.ringR) / 2;
  }

  /** Height (px) of the strip that "bottom"-pinned components occupy: their
   *  distance from the edge plus half their caption, plus a small gap. */
  private footerHeight(): number {
    let need = 0;
    for (const comp of Object.values<any>(this.diagram?.components ?? {})) {
      if (comp.type === "Connector" || comp.enabled === false || !comp.layout) continue;
      const pos = this.activePos(comp.layout);
      if (pos?.type !== "bottom") continue;
      const text = comp.label ? ((numberOr(comp.layout.label?.size, 10) || 10) * this.scaling) / 2 : 0;
      need = Math.max(need, numberOr(pos.y, 0) + text + 6);
    }
    return need;
  }

  /** Generate the procedural radial textures used for depth: the soft compartment
   *  glow and the backdrop vignette. Built once (canvas → Texture). */
  private buildTextures() {
    // disc-sized so GLOW_SCALE is a true ratio against container.png (318 px)
    this.glowTex = makeRadialTexture(318, [
      [0.0, "rgba(255,255,255,1)"],
      [0.32, "rgba(255,255,255,0.65)"],
      [1.0, "rgba(255,255,255,0)"],
    ]);
    // lighter centre → darker → soft-faded transparent edge (blends on the page)
    this.vignetteTex = makeRadialTexture(512, [
      [0.0, "#343434"],
      [0.6, hexToCss(DISC_COLOR)],
      [0.92, "#1c1c1c"],
      [1.0, "rgba(18,18,18,0)"],
    ]);
  }

  /** Vignette backdrop under the component ring. Sits behind everything; its
   *  centre/size track the layout circle, so it is rescaled on resize. */
  private drawBackdrop() {
    if (!this.app || !this.vignetteTex) return;
    if (!this.bgSprite) {
      this.bgSprite = new Sprite(this.vignetteTex);
      this.bgSprite.anchor.set(0.5);
      this.bgSprite.zIndex = -1000; // behind paths, sprites and labels
      this.bgSprite.eventMode = "none";
      this.app.stage.addChild(this.bgSprite);
    }
    // a touch larger than the ring so the soft edge falls outside the sprites
    const d = this.ringR * 2.1;
    this.bgSprite.x = this.xCenter + this.xOffset;
    this.bgSprite.y = this.yCenter + this.yOffset;
    this.bgSprite.width = d;
    this.bgSprite.height = d;
  }

  /** Editor alignment grid. Drawn over the backdrop but under paths/sprites;
   *  cleared when off. Covers the whole canvas, so redrawn on resize. */
  private drawGrid() {
    if (!this.app) return;
    if (!this.gridG) {
      this.gridG = new Graphics();
      this.gridG.zIndex = -900; // above the disc, below paths
      this.gridG.eventMode = "none";
      this.app.stage.addChild(this.gridG);
    }
    const g = this.gridG;
    g.clear();
    if (!this.gridOn || this.gridSize <= 0) return;
    const w = this.app.screen.width || this.el.clientWidth;
    const h = this.app.screen.height || this.el.clientHeight;
    for (let x = 0; x <= w; x += this.gridSize) g.moveTo(x, 0).lineTo(x, h);
    for (let y = 0; y <= h; y += this.gridSize) g.moveTo(0, y).lineTo(w, y);
    g.stroke({ width: 1, color: GRID_COLOR, alpha: GRID_ALPHA });
  }

  /** Snap a coordinate to the grid when the grid is on (used while dragging). */
  private snap(v: number): number {
    if (!this.gridOn || this.gridSize <= 0) return v;
    return Math.round(v / this.gridSize) * this.gridSize;
  }

  /** Show/hide the alignment grid (also enables snap-to-grid while dragging). */
  setGrid(on: boolean) {
    this.gridOn = on;
    if (this.diagram?.settings) this.diagram.settings.grid = on;
    this.drawGrid();
  }

  /** Change the grid spacing (px) and snap granularity. */
  setGridSize(size: number) {
    if (!(size > 0)) return;
    this.gridSize = size;
    if (this.diagram?.settings) this.diagram.settings.gridSize = size;
    this.drawGrid();
  }

  /** Set the global diagram scale live (one knob for the whole picture). Scales
   *  the discs, captions, connector path widths and flow dots together; the ring
   *  layout still auto-fits the panel (its margin tracks the sprite size, so the
   *  ring nudges in/out a touch to keep room for the bigger/smaller sprites).
   *  Persists into settings.scaling so it round-trips on export. */
  setScaling(scaling: number) {
    if (!(scaling > 0)) return;
    this.scaling = scaling;
    if (this.diagram?.settings) this.diagram.settings.scaling = scaling;
    if (!this.ready) return;
    // sprite margin scales with scaling → recompute the ring, then reposition
    // and rescale everything at the new scale (mirrors onResize plus a rescale).
    this.recomputeGeometry();
    this.drawBackdrop();
    this.drawGrid();
    for (const name in this.comps) {
      const node = this.comps[name];
      const p = this.placeAt(node.layout);
      node.x = p.x;
      node.y = p.y;
      this.syncCompartmentPos(node);
      this.setCompartmentScale(node, node.lastR); // re-apply disc size now
      if (node.label) {
        const l = node.layout.label || {};
        node.label.style.fontSize = (numberOr(l.size, 10) || 10) * this.scaling;
      }
      this.positionLabel(node);
    }
    for (const conn of this.conns) {
      const f = this.comps[conn.from];
      const t = this.comps[conn.to];
      if (f && t) conn.geom = this.drawPath(conn.graphics, conn.layout, f, t);
    }
    this.drawSelection();
  }

  /** Set the to2 (O2 content) tint window [lo, hi] live. Compartments/dots map
   *  their oxygenation onto the deox→ox colour ramp across this window, so a
   *  lower-Hb circuit (adult) needs a lower `hi` than a neonate to swing arterial
   *  blood red instead of pegging the whole circuit blue. Re-colours immediately
   *  (so a paused sim updates) and persists into settings.to2_lo / to2_hi. */
  setTo2Range(lo: number, hi: number) {
    if (!(hi > lo)) return; // need a positive window
    this.to2Lo = lo;
    this.to2Hi = hi;
    if (this.diagram?.settings) {
      this.diagram.settings.to2_lo = lo;
      this.diagram.settings.to2_hi = hi;
    }
    if (!this.ready) return;
    // snap each tinted component/dot to the new window now (don't wait for a
    // frame — the sim may be paused while the user tunes the threshold)
    for (const name in this.comps) {
      const node = this.comps[name];
      if (!node.layout.general.tinting) continue;
      const rgb = rgbFromTo2(node.lastTo2, this.to2Lo, this.to2Hi);
      node.cr = rgb[0];
      node.cg = rgb[1];
      node.cb = rgb[2];
      node.sprite.tint = packRgb(rgb);
      if (node.rim) node.rim.tint = packRgb(lerpRgb(rgb, WHITE_RGB, RIM_LIGHTEN));
      if (node.glow) node.glow.tint = packRgb(rgb);
    }
    for (const conn of this.conns) {
      if (!conn.layout.general.tinting) continue;
      const rgb = rgbFromTo2(conn.lastTo2, this.to2Lo, this.to2Hi);
      conn.cr = rgb[0];
      conn.cg = rgb[1];
      conn.cb = rgb[2];
      const col = packRgb(lerpRgb(rgb, WHITE_RGB, DOT_LIGHTEN));
      for (const d of conn.dots) d.tint = col;
    }
  }

  private buildCompartments() {
    for (const [name, comp] of Object.entries<any>(this.diagram?.components ?? {})) {
      if (comp.type === "Connector") continue;
      if (comp.enabled === false) continue; // disabled components are not drawn
      this.makeCompartment(name, comp);
    }
  }

  private makeCompartment(name: string, comp: any) {
    const layout = comp.layout;
    const picto = gfxPath(comp.picto || "container.png");

    const baseZ = layout.general.z_index;
    // pre-frame tint: the deoxygenated end of the ramp for tinted compartments,
    // so unfilled compartments read as venous until the first volume frame.
    const baseRgb: [number, number, number] = layout.general.tinting
      ? [DEOX_RGB[0], DEOX_RGB[1], DEOX_RGB[2]]
      : hexToRgb(layout.sprite.color);

    // Depth layers (compartments only): a soft additive glow and a brighter rim
    // behind the disc. Devices (e.g. the invisible TITLE) get just the sprite.
    let glow: Sprite | null = null;
    let rim: Sprite | null = null;
    if (comp.type === "Compartment") {
      glow = new Sprite(this.glowTex!);
      glow.anchor.set(0.5);
      glow.zIndex = baseZ - 2;
      glow.eventMode = "none";
      glow.blendMode = "add";
      glow.alpha = 0; // raised by fill once frames arrive
      glow.tint = packRgb(baseRgb);
      this.app!.stage.addChild(glow);

      rim = new Sprite(Texture.from(picto));
      rim.anchor.set(layout.sprite.anchor.x, layout.sprite.anchor.y);
      rim.zIndex = baseZ - 1;
      rim.eventMode = "none";
      rim.tint = packRgb(lerpRgb(baseRgb, WHITE_RGB, RIM_LIGHTEN));
      this.app!.stage.addChild(rim);
    }

    const sprite = Sprite.from(picto);
    sprite.anchor.set(layout.sprite.anchor.x, layout.sprite.anchor.y);
    sprite.alpha = layout.general.alpha;
    sprite.rotation = layout.sprite.rotation;
    sprite.zIndex = baseZ;
    sprite.tint = packRgb(baseRgb);

    const { x, y } = this.placeAt(layout);
    sprite.eventMode = "static";
    sprite.cursor = "pointer";
    sprite.on("pointerdown", (e: any) => this.onSpriteDown(name, e));
    this.app!.stage.addChild(sprite);

    // caption: a Text that rides above the sprite. label.pos_x/pos_y are pixel
    // offsets from the sprite centre; size is the font size in px.
    let label: Text | null = null;
    if (comp.label) {
      label = this.buildLabelText(comp, layout);
      this.app!.stage.addChild(label);
    }

    const node: CompNode = {
      x,
      y,
      posType: this.activePos(layout).type,
      dgs: this.activePos(layout).dgs,
      sprite,
      glow,
      rim,
      cr: baseRgb[0],
      cg: baseRgb[1],
      cb: baseRgb[2],
      label,
      layout,
      lastR: fixedSize(layout) ?? radiusFromVolume(0.15),
      lastTo2: this.to2Lo, // venous end until the first frame arrives
      group: comp.group || null,
      spin: 0,
      spinAngle: 0,
    };
    this.comps[name] = node;
    // initial visible scale/position before the first frame arrives
    this.setCompartmentScale(node, node.lastR);
    this.syncCompartmentPos(node);
    this.positionLabel(node);
  }

  /** Scale a compartment's disc and its glow/rim layers together for radius r. */
  private setCompartmentScale(node: CompNode, r: number) {
    const l = node.layout;
    const sx = r * l.sprite.scale.x * this.scaling;
    const sy = r * l.sprite.scale.y * this.scaling;
    node.sprite.scale.set(sx, sy);
    if (node.rim) node.rim.scale.set(sx * RIM_SCALE, sy * RIM_SCALE);
    if (node.glow) node.glow.scale.set(sx * GLOW_SCALE, sy * GLOW_SCALE);
  }

  /** Move a compartment's disc and its glow/rim layers to the node position. */
  private syncCompartmentPos(node: CompNode) {
    node.sprite.x = node.x;
    node.sprite.y = node.y;
    if (node.rim) {
      node.rim.x = node.x;
      node.rim.y = node.y;
    }
    if (node.glow) {
      node.glow.x = node.x;
      node.glow.y = node.y;
    }
  }

  /** Place a compartment's caption at its sprite centre plus the configured
   *  pixel offset. Called whenever the sprite moves. */
  private positionLabel(node: CompNode) {
    const t = node.label;
    if (!t) return;
    const l = node.layout.label || {};
    t.x = node.sprite.x + numberOr(l.pos_x, 0) * this.scaling;
    t.y = node.sprite.y + numberOr(l.pos_y, 0) * this.scaling;
    t.rotation = numberOr(l.rotation, 0);
  }

  /** Build the caption Text for a component from its current label layout. */
  private buildLabelText(comp: any, layout: any): Text {
    const l = layout.label || {};
    const t = new Text({
      text: String(comp.label),
      style: {
        fontFamily: "Arial, Helvetica, sans-serif",
        fontSize: (numberOr(l.size, 10) || 10) * this.scaling,
        fill: l.color || "#ffffff",
        align: "center",
      },
    });
    t.anchor.set(0.5, 0.5);
    t.eventMode = "none";
    t.zIndex = layout.general.z_index + 2; // above sprite and arrow
    return t;
  }

  /** Set a component's caption text live, creating/removing the Text as needed. */
  setLabel(name: string, text: string) {
    const comp = this.diagram?.components?.[name];
    const node = this.comps[name];
    if (!comp || !node) return;
    comp.label = text;
    if (!text) {
      if (node.label) {
        this.app?.stage.removeChild(node.label);
        node.label = null;
      }
      return;
    }
    if (node.label) {
      node.label.text = text;
    } else {
      node.label = this.buildLabelText(comp, node.layout);
      this.app?.stage.addChild(node.label);
    }
    this.positionLabel(node);
  }

  /** Set which engine model(s) a component/connector represents. Affects the
   *  exported definition and the next engine build (the live anim binding is
   *  fixed at build time), not the current frame stream. */
  setModels(name: string, models: string[]) {
    const comp = this.diagram?.components?.[name];
    if (!comp) return;
    comp.models = [...models];
    this.onChangeCb?.();
  }

  /** Toggle oxygenation tinting for a component/connector. Affects both the live
   *  sprite tint and the animation binding (tint source), so it re-binds. */
  setTinting(name: string, on: boolean) {
    this.applyLayoutPatch(name, { general: { tinting: on } });
    this.onChangeCb?.();
  }

  /** Swap a component's sprite image (picto) live. */
  async setPicto(name: string, picto: string) {
    const comp = this.diagram?.components?.[name];
    const node = this.comps[name];
    if (!comp || !node || !picto) return;
    const path = gfxPath(picto);
    comp.picto = picto.replace(/^.*gfx\//, "");
    await Assets.load(path);
    node.sprite.texture = Texture.from(path);
  }

  // the position in effect: `sprite.band_pos` (when authored) while the device
  // band is open, so e.g. a caption below the ring can step clear of the band
  private activePos(layout: any): any {
    return this.bandOn && layout.sprite.band_pos ? layout.sprite.band_pos : layout.sprite.pos;
  }

  private placeAt(layout: any): { x: number; y: number } {
    const pos = this.activePos(layout);
    if (pos.type === "arc") {
      return {
        x: this.xCenter + this.xOffset + Math.cos(pos.dgs * DEG) * this.ringR,
        y: this.yCenter + this.yOffset + Math.sin(pos.dgs * DEG) * this.ringR,
      };
    }
    if (pos.type === "bottom") {
      // pinned to the canvas bottom edge: x relative to the ring like "rel",
      // y = pixels up from the bottom — e.g. the scenario title, which then sits
      // at the foot of the diagram whatever the panel height or device band.
      return {
        x: this.xCenter + this.xOffset + pos.x * this.ringR,
        y: this.canvasHeight() - pos.y,
      };
    }
    // "rel"
    return {
      x: this.xCenter + this.xOffset + pos.x * this.ringR,
      y: this.yCenter + this.yOffset + pos.y * this.ringR,
    };
  }

  private buildConnectors() {
    for (const [name, comp] of Object.entries<any>(this.diagram?.components ?? {})) {
      if (comp.type !== "Connector") continue;
      if (comp.enabled === false) continue; // disabled connectors are not drawn
      this.makeConnector(name, comp);
    }
  }

  private makeConnector(name: string, comp: any) {
    const from = this.comps[comp.dbcFrom];
    const to = this.comps[comp.dbcTo];
    if (!from || !to) return; // can't route without both endpoints

    const g = new Graphics();
    g.zIndex = comp.layout.general.z_index;
    g.alpha = comp.layout.general.alpha;
    const geom = this.drawPath(g, comp.layout, from, to);
    // make the path selectable in the editor (hit area set in drawPath)
    g.eventMode = "static";
    g.cursor = "pointer";
    g.on("pointerdown", (e: any) => this.onConnDown(name, e));
    this.app!.stage.addChildAt(g, 0); // paths under sprites

    const conn: ConnNode = {
      name,
      group: comp.group || null,
      graphics: g,
      layout: comp.layout,
      from: comp.dbcFrom,
      to: comp.dbcTo,
      dots: [],
      smFlow: 0,
      cr: DEOX_RGB[0],
      cg: DEOX_RGB[1],
      cb: DEOX_RGB[2],
      pos: 0,
      geom,
      lastTo2: this.to2Lo,
    };
    this.syncDotCount(conn);
    this.conns.push(conn);
  }

  /** Match a connector's dot train to its path length (one dot per ~spacing px),
   *  sitting just above the path but below the compartments it flows between.
   *  Re-run when the path changes length (e.g. a re-routed endpoint). */
  private syncDotCount(conn: ConnNode) {
    const count = dotCount(pathLength(conn.geom), this.scaling);
    while (conn.dots.length > count) this.app!.stage.removeChild(conn.dots.pop()!);
    while (conn.dots.length < count) {
      const d = Sprite.from(DOT_PICTO);
      d.anchor.set(0.5, 0.5);
      d.scale.set(DOT_SCALE * this.scaling);
      d.zIndex = conn.layout.general.z_index + 0.5;
      d.alpha = 0; // raised once flow arrives
      d.eventMode = "none";
      d.visible = conn.graphics.visible;
      this.app!.stage.addChild(d);
      conn.dots.push(d);
    }
  }

  /** Put a connector's dots back on its (possibly moved) path at the current
   *  phase, without touching size/opacity — for relayouts while paused. */
  private placeDots(conn: ConnNode) {
    const n = conn.dots.length;
    if (!conn.geom || !n) return;
    for (let k = 0; k < n; k++) {
      const p = pointOnPath(conn.geom, wrap01(conn.pos + k / n));
      conn.dots[k].x = p.x;
      conn.dots[k].y = p.y;
    }
  }

  private drawPath(g: Graphics, layout: any, from: CompNode, to: CompNode): any {
    g.clear();
    const width = numberOr(Number(layout.path.width), 5) * this.scaling;
    const pathType = layout.path.type;
    let geom: any;

    if (pathType === "straight") {
      g.moveTo(from.x, from.y).lineTo(to.x, to.y);
      geom = { type: "straight", x1: from.x, y1: from.y, x2: to.x, y2: to.y };
    } else if (pathType === "outer") {
      geom = polyGeom(this.outerRoute(from, to, layout));
      g.moveTo(geom.pts[0], geom.pts[1]);
      for (let i = 2; i < geom.pts.length; i += 2) g.lineTo(geom.pts[i], geom.pts[i + 1]);
    } else if (from.posType === "arc" && to.posType === "arc") {
      // arc along the main layout circle between the two angular positions
      const c = from.dgs > to.dgs ? 360 : 0;
      const a0 = from.dgs * DEG;
      const a1 = (to.dgs + c) * DEG;
      const r = this.ringR;
      const cx = this.xCenter + this.xOffset;
      const cy = this.yCenter + this.yOffset;
      g.arc(cx, cy, r, a0, a1, pathType === "arc_r");
      geom = { type: "arc", cx, cy, r, from: a0, to: a1 };
    } else if (pathType === "arc_flip") {
      // mirrored chord-arc: the centre on the other side of the chord, so the curve
      // bends the opposite way; the short arc then runs anticlockwise. a2 is unwrapped
      // below a1 so pointOnPath/samplePath interpolate along the drawn arc. (A separate
      // type because many shipped diagrams set "arc_r" on off-ring connectors, which
      // this branch has always drawn like "arc".)
      const r = this.ringR;
      const { cx, cy } = circleCenterThrough(to.x, to.y, from.x, from.y, r);
      const a1 = angleOnCircle(cx, cy, from.x, from.y);
      let a2 = angleOnCircle(cx, cy, to.x, to.y);
      while (a2 > a1) a2 -= 2 * Math.PI;
      g.arc(cx, cy, r, a1, a2, true);
      geom = { type: "arc", cx, cy, r, from: a1, to: a2 };
    } else {
      // chord-arc: circle of radius r passing through both endpoint sprites
      const r = this.ringR;
      const { cx, cy } = circleCenterThrough(from.x, from.y, to.x, to.y, r);
      const a1 = angleOnCircle(cx, cy, from.x, from.y);
      const a2 = angleOnCircle(cx, cy, to.x, to.y);
      g.arc(cx, cy, r, a1, a2, false);
      geom = { type: "arc", cx, cy, r, from: a1, to: a2 };
    }
    // fixed neutral grey backbone; never recoloured per frame
    g.stroke({ width, color: CONNECTOR_COLOR, alpha: 1 });
    // hit area: a fat polyline along the path so the thin stroke is easy to
    // click in the editor (stroke-only Graphics aren't hit-tested by default).
    g.hitArea = new PolylineHitArea(samplePath(geom), Math.max(width, 12));
    return geom;
  }

  /** "outer" route between a ring node and an off-ring (device) node: radially
   *  out from the ring node to a concentric track outside the ring, along it,
   *  and onto the device node. The track normally runs through the device node
   *  itself (so the line lands on it directly); if that arc would run through
   *  another node of the device group (e.g. a VV return line crossing the ECLS
   *  row) it switches to the bypass track `path.track` (ring radii, beyond the
   *  row), and as a last resort goes the long way round. Returns a flat [x,y,…]
   *  point list from → to. */
  private outerRoute(from: CompNode, to: CompNode, layout: any): number[] {
    const cx = this.xCenter + this.xOffset;
    const cy = this.yCenter + this.yOffset;
    const dist = (n: CompNode) => Math.hypot(n.x - cx, n.y - cy);
    // B = the endpoint nearer the ring centre (the patient side), A = the device
    const fromIsRing = dist(from) <= dist(to);
    const ring = fromIsRing ? from : to;
    const dev = fromIsRing ? to : from;
    const rDev = dist(dev);
    const rBypass = numberOr(Number(layout.path.track), OUTER_TRACK_DEFAULT) * this.ringR;
    const aA = Math.atan2(dev.y - cy, dev.x - cx);
    const aB = Math.atan2(ring.y - cy, ring.x - cx);
    let delta = aB - aA;
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta <= -Math.PI) delta += 2 * Math.PI;

    const arcPts = (r: number, d: number): number[] => {
      const steps = Math.max(2, Math.ceil(Math.abs(d) / (4 * DEG)));
      const pts: number[] = [];
      for (let i = 0; i <= steps; i++) {
        const a = aA + (d * i) / steps;
        pts.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
      }
      return pts;
    };
    // other device-group nodes the track must not run through
    const blockers = Object.values(this.comps).filter(
      (n) => n !== dev && n !== ring && n.group && n.group === dev.group,
    );
    const pad = 8 * this.scaling;
    const hits = (pts: number[]) =>
      blockers.some((n) => {
        const rad = Math.max(n.sprite.width, n.sprite.height) / 2 + pad;
        for (let i = 0; i < pts.length; i += 2) {
          if (Math.hypot(pts[i] - n.x, pts[i + 1] - n.y) < rad) return true;
        }
        return false;
      });
    // candidates in order of preference; the first that clears the group wins
    const longDelta = delta > 0 ? delta - 2 * Math.PI : delta + 2 * Math.PI;
    const candidates = [arcPts(rDev, delta), arcPts(rBypass, delta), arcPts(rDev, longDelta)];
    const arc = candidates.find((c) => !hits(c)) ?? candidates[0];
    // device → track → (arc) → track → ring node; reversed if the ring is `from`.
    // A radial run always meets the concentric track at 90°, so round those
    // elbows into smooth bends (`path.corner`, ring radii).
    const pts = [dev.x, dev.y, ...arc, ring.x, ring.y];
    const corner = numberOr(Number(layout.path.corner), OUTER_CORNER_DEFAULT) * this.ringR;
    const rounded = roundCorners(pts, corner);
    return fromIsRing ? reversePts(rounded) : rounded;
  }

  private onConnDown(name: string, e: any) {
    if (!this.editMode || this.connectMode) return;
    e.stopPropagation?.();
    // clicking the already-selected connector toggles the selection off
    if (this.selected === name && this.selectedKind === "conn") {
      this.clearSelection();
    } else {
      this.select(name, "conn");
    }
  }

  // ---- RendererAdapter ----

  onRegistry(payload: ChannelsPayload) {
    this.animIndex = {};
    const comps = payload?.anim?.components ?? [];
    for (const c of comps) this.animIndex[c.name] = c.index;
  }

  onFrame(_chart: ChartFrame | null, anim: AnimFrame | null) {
    if (!this.ready || !anim) return;
    const frame = anim.frame;
    // After a (re)build the reader hands over the fresh, still zero-filled anim
    // buffer once. Real frames are packed after model steps (time > 0); an
    // empty one would reset every disc to the placeholder volume.
    if (!(frame[ANIM_TIME_SLOT] > 0)) return;

    // spinning sprites (e.g. the ECLS pump) turn by wall-clock time between
    // frames — frames only flow while the sim runs, so a paused sim stops them.
    // dt is clamped so the first frame after a pause doesn't jump.
    const now = performance.now();
    const dt = this.lastFrameMs ? Math.min((now - this.lastFrameMs) / 1000, 0.1) : 0;
    this.lastFrameMs = now;
    if (dt > 0) {
      for (const name in this.comps) {
        const node = this.comps[name];
        if (!node.spin || !node.sprite.visible) continue;
        node.spinAngle = (node.spinAngle + node.spin * dt * 2 * Math.PI) % (2 * Math.PI);
        this.applyRotation(node);
      }
    }

    // compartments: scale by volume, tint by to2 (smoothed), glow by fill
    for (const name in this.comps) {
      const idx = this.animIndex[name];
      if (idx === undefined) continue;
      const node = this.comps[name];
      if (!node.sprite.visible) continue; // hidden device group
      this.applyCompartment(node, frame[animMagOffset(idx)], frame[animTintOffset(idx)], TINT_LERP);
    }

    // connectors: the path stays a fixed neutral grey; the dot train streams
    // along it, coloured from the upstream component (tint = dbcFrom's to2).
    for (const conn of this.conns) {
      const idx = this.animIndex[conn.name];
      if (idx === undefined || !conn.graphics.visible) continue;
      const flow = frame[animMagOffset(idx)];
      const tint = frame[animTintOffset(idx)];
      this.advanceDots(conn, flow, tint);
    }
  }

  /** Size a compartment by volume and ease its tint toward to2 by `lerp`
   *  (1 = snap). Shared by the realtime frames and the state-snapshot seed. */
  private applyCompartment(node: CompNode, vol: number, to2: number, lerp: number) {
    const r = fixedSize(node.layout) ?? radiusFromVolume(vol > 0 ? vol : 0.15);
    node.lastR = r;
    this.setCompartmentScale(node, r);
    if (!node.layout.general.tinting) return;

    // ease the tint toward the target colour to damp per-frame to2 flicker
    node.lastTo2 = to2;
    const tgt = rgbFromTo2(node.lastTo2, this.to2Lo, this.to2Hi);
    node.cr += (tgt[0] - node.cr) * lerp;
    node.cg += (tgt[1] - node.cg) * lerp;
    node.cb += (tgt[2] - node.cb) * lerp;
    const rgb: [number, number, number] = [node.cr, node.cg, node.cb];
    node.sprite.tint = packRgb(rgb);
    if (node.rim) node.rim.tint = packRgb(lerpRgb(rgb, WHITE_RGB, RIM_LIGHTEN));
    if (node.glow) {
      node.glow.tint = packRgb(rgb);
      const fill = clamp01((r - 0.2) / 0.35); // fuller → brighter halo
      node.glow.alpha = GLOW_ALPHA_MAX * (0.25 + 0.75 * fill);
    }
  }

  /** Size + tint compartments from a full model-state snapshot. Anim frames
   *  only flow while the sim runs, so without this a freshly loaded (or
   *  fast-forwarded) model shows placeholder-sized discs until Play. Mirrors
   *  AnimationPacker: volume summed over the compartment's models, tint from
   *  the first of them carrying a to2. */
  seedFromModels(models: Record<string, any> | null | undefined) {
    if (!this.ready || !models) return;
    for (const name in this.comps) {
      const node = this.comps[name];
      if (node.layout.general.animatedBy !== "vol") continue;
      const names = this.diagram.components[name]?.models;
      const refs = (Array.isArray(names) ? names : []).map((n: string) => models[n]).filter(Boolean);
      if (!refs.length) continue;
      let vol = 0;
      for (const m of refs) if (typeof m.vol === "number") vol += m.vol;
      const tintRef = refs.find((m: any) => typeof m.to2 === "number");
      this.applyCompartment(node, vol, tintRef ? tintRef.to2 : 0, 1);
    }
  }

  // stream a connector's dot train along its path: phase advances by flow
  // (speed + direction); a smoothed magnitude scales dot size and fades the dots
  // out near zero flow; colour comes from the upstream component (dbcFrom's to2).
  private advanceDots(conn: ConnNode, flow: number, tint: number) {
    const g = conn.geom;
    const n = conn.dots.length;
    if (!g || !n) return;

    // smoothed magnitude → size multiplier + opacity (kills flicker)
    conn.smFlow += (Math.abs(flow) - conn.smFlow) * FLOW_LERP;
    const m = clamp01(conn.smFlow / DOT_FLOW_REF);
    const sizeMul = DOT_SCALE_MIN + (DOT_SCALE_MAX - DOT_SCALE_MIN) * m;
    const alpha = DOT_ALPHA * clamp01(conn.smFlow / (DOT_FLOW_REF * 0.12));

    // advance the phase (keep the per-geometry calibration of the old arrow)
    if (g.type === "straight") {
      conn.pos = wrap01(conn.pos + flow * DOT_SPEED * this.speed);
    } else if (g.type === "poly") {
      // same px speed as an arc on the ring (arc phase is per radian of ringR)
      conn.pos = wrap01(conn.pos + (flow * DOT_SPEED * this.speed * this.ringR) / (g.len || 1));
    } else {
      const range = g.to - g.from || 1e-6;
      conn.pos = wrap01(conn.pos + (flow * DOT_SPEED * this.speed) / Math.abs(range));
    }

    // colour all dots from the smoothed upstream to2 (or white if untinted),
    // lifted toward white so even venous (dark blue) dots stand out on the path
    let col = 0xffffff;
    if (conn.layout.general.tinting) {
      conn.lastTo2 = tint;
      const tgt = rgbFromTo2(tint, this.to2Lo, this.to2Hi);
      conn.cr += (tgt[0] - conn.cr) * TINT_LERP;
      conn.cg += (tgt[1] - conn.cg) * TINT_LERP;
      conn.cb += (tgt[2] - conn.cb) * TINT_LERP;
      col = packRgb(lerpRgb([conn.cr, conn.cg, conn.cb], WHITE_RGB, DOT_LIGHTEN));
    }

    const sc = DOT_SCALE * this.scaling * sizeMul;
    for (let k = 0; k < n; k++) {
      const d = conn.dots[k];
      const p = pointOnPath(g, wrap01(conn.pos + k / n));
      d.x = p.x;
      d.y = p.y;
      d.scale.set(sc);
      d.alpha = alpha;
      d.tint = col;
    }
  }

  // recompute positions/paths when the canvas resizes
  private onResize() {
    if (!this.app || !this.ready) return;
    this.recomputeGeometry();
    this.drawBackdrop();
    this.drawGrid();
    for (const name in this.comps) {
      const node = this.comps[name];
      const p = this.placeAt(node.layout);
      node.x = p.x;
      node.y = p.y;
      node.posType = this.activePos(node.layout).type;
      node.dgs = this.activePos(node.layout).dgs;
      this.syncCompartmentPos(node);
      this.positionLabel(node);
    }
    for (const conn of this.conns) {
      const f = this.comps[conn.from];
      const t = this.comps[conn.to];
      if (f && t) conn.geom = this.drawPath(conn.graphics, conn.layout, f, t);
      this.placeDots(conn);
    }
    this.drawSelection();
  }

  // ---- Editor (Phase E) ----

  setEditMode(on: boolean) {
    this.editMode = on;
    if (!on) {
      this.dragging = null;
      this.clearSelection();
    }
    this.applyGroupVisibility(); // edit mode reveals every device group
  }

  setSelectCallback(fn: (name: string | null, comp: any, kind: "comp" | "conn" | null) => void) {
    this.onSelectCb = fn;
  }

  /** Notified after a structural edit (add/connect/delete/setModels) so the
   *  host can re-bind the live animation by pushing the diagram to the engine. */
  setChangeCallback(fn: () => void) {
    this.onChangeCb = fn;
  }

  /** Return the (mutated) diagram definition for serialization/export. */
  getDiagram() {
    return this.diagram;
  }

  // ---- Device groups ----

  /** Show or hide a device group (the components carrying `group: name`) at
   *  runtime. The first visible grouped node opens the device band below the
   *  ring (the ring shrinks up); the last one hidden closes it. Edit mode shows
   *  every group regardless, so the nodes can be positioned. */
  setGroupVisible(group: string, on: boolean) {
    if (on === this.shownGroups.has(group)) return;
    if (on) this.shownGroups.add(group);
    else this.shownGroups.delete(group);
    this.applyGroupVisibility();
  }

  private isGroupShown(group: string | null): boolean {
    return !group || this.editMode || this.shownGroups.has(group);
  }

  // a connector shows only with its group AND both endpoints, so a line into a
  // hidden device never dangles (e.g. an ungrouped connector to an ECLS node)
  private isConnShown(conn: ConnNode): boolean {
    const f = this.comps[conn.from];
    const t = this.comps[conn.to];
    return this.isGroupShown(conn.group) && !!f && !!t && this.isGroupShown(f.group) && this.isGroupShown(t.group);
  }

  private applyGroupVisibility() {
    if (!this.ready) return;
    let band = false;
    for (const name in this.comps) {
      const node = this.comps[name];
      const vis = this.isGroupShown(node.group);
      if (node.group && vis) band = true;
      node.sprite.visible = vis;
      if (node.glow) node.glow.visible = vis;
      if (node.rim) node.rim.visible = vis;
      if (node.label) node.label.visible = vis;
    }
    for (const conn of this.conns) {
      const vis = this.isConnShown(conn);
      conn.graphics.visible = vis;
      for (const d of conn.dots) d.visible = vis;
      if (!vis) {
        // hidden connectors skip frames, so drop their flow state now — otherwise
        // a re-shown circuit flashes its last (stale) dot train before fading
        conn.smFlow = 0;
        for (const d of conn.dots) d.alpha = 0;
      }
    }
    if (band !== this.bandOn) {
      this.bandOn = band;
      this.onResize(); // re-fit the ring around (or without) the band
    }
    if (this.selected && !this.isVisibleName(this.selected)) this.clearSelection();
    else this.drawSelection();
  }

  private isVisibleName(name: string): boolean {
    const conn = this.conns.find((c) => c.name === name);
    if (conn) return conn.graphics.visible;
    return this.comps[name]?.sprite.visible ?? false;
  }

  /** The drawn (ungrouped) diagram component that represents an engine model,
   *  e.g. "RASVC" → "RA" (whose `models` include it). Null when none does. */
  componentForModel(modelName: string): string | null {
    if (!modelName) return null;
    for (const [name, comp] of Object.entries<any>(this.diagram?.components ?? {})) {
      if (comp.type === "Connector" || comp.group || !this.comps[name]) continue;
      if (Array.isArray(comp.models) && comp.models.includes(modelName)) return name;
    }
    return null;
  }

  /** Spin a component's sprite at `revPerSec` (sign = direction; 0 stops it
   *  where it is). Runtime only — layout.sprite.rotation stays the authored
   *  base angle, so the export is unaffected. */
  setSpin(name: string, revPerSec: number) {
    const node = this.comps[name];
    if (node) node.spin = Number.isFinite(revPerSec) ? revPerSec : 0;
  }

  // sprite (and its rim copy) at the authored rotation plus any live spin
  private applyRotation(node: CompNode) {
    const r = numberOr(node.layout.sprite.rotation, 0) + node.spinAngle;
    node.sprite.rotation = r;
    if (node.rim) node.rim.rotation = r;
  }

  /** Re-route a connector's live endpoints (diagram component names; omit one
   *  to keep it). A runtime override only: the definition's dbcFrom/dbcTo — and
   *  so the export — keep their authored values. Unknown names are ignored. */
  setConnectorEnds(name: string, from?: string | null, to?: string | null) {
    const conn = this.conns.find((c) => c.name === name);
    if (!conn) return;
    const f = from && this.comps[from] ? from : conn.from;
    const t = to && this.comps[to] ? to : conn.to;
    if (f === conn.from && t === conn.to) return;
    conn.from = f;
    conn.to = t;
    conn.geom = this.drawPath(conn.graphics, conn.layout, this.comps[f], this.comps[t]);
    this.syncDotCount(conn);
    this.placeDots(conn);
    const vis = this.isConnShown(conn);
    conn.graphics.visible = vis;
    for (const d of conn.dots) d.visible = vis;
    this.drawSelection();
  }

  /** Apply a layout patch to a component or connector and re-render it live. */
  applyLayoutPatch(name: string, patch: any) {
    const comp = this.diagram?.components?.[name];
    if (!comp) return;
    deepMerge(comp.layout, patch);
    // connectors have no sprite: update the path graphics + arrow instead
    const conn = this.conns.find((c) => c.name === name);
    if (conn) {
      const l = conn.layout;
      conn.graphics.alpha = l.general.alpha;
      conn.graphics.zIndex = l.general.z_index;
      for (const d of conn.dots) {
        d.zIndex = l.general.z_index + 0.5;
        if (!l.general.tinting) d.tint = 0xffffff;
      }
      const f = this.comps[conn.from];
      const t = this.comps[conn.to];
      if (f && t) conn.geom = this.drawPath(conn.graphics, l, f, t);
      this.drawSelection();
      return;
    }
    const node = this.comps[name];
    if (node) {
      const l = node.layout;
      node.sprite.alpha = l.general.alpha;
      node.sprite.zIndex = l.general.z_index;
      this.applyRotation(node);
      if (node.glow) node.glow.zIndex = l.general.z_index - 2;
      if (node.rim) node.rim.zIndex = l.general.z_index - 1;
      if (!l.general.tinting) {
        // fixed colour: seed the smoothed tint and recolour all layers now
        const rgb = hexToRgb(l.sprite.color);
        node.cr = rgb[0];
        node.cg = rgb[1];
        node.cb = rgb[2];
        node.sprite.tint = packRgb(rgb);
        if (node.rim) node.rim.tint = packRgb(lerpRgb(rgb, WHITE_RGB, RIM_LIGHTEN));
        if (node.glow) node.glow.tint = packRgb(rgb);
      }
      const p = this.placeAt(l);
      node.x = p.x;
      node.y = p.y;
      this.syncCompartmentPos(node);
      node.posType = this.activePos(l).type;
      node.dgs = this.activePos(l).dgs;
      if (node.label) {
        node.label.text = String(comp.label ?? "");
        node.label.style.fontSize = (numberOr(l.label?.size, 10) || 10) * this.scaling;
        node.label.style.fill = l.label?.color || "#ffffff";
      }
      this.positionLabel(node);
      this.rerouteConnectors(name);
      this.drawSelection();
    }
  }

  private onSpriteDown(name: string, e: any) {
    if (!this.editMode) return;
    e.stopPropagation?.();
    if (this.connectMode) {
      // first click picks the source, second click creates the connection
      if (!this.connectFrom) {
        this.connectFrom = name;
        this.select(name);
      } else {
        if (name !== this.connectFrom) this.createConnection(this.connectFrom, name);
        this.connectFrom = null;
      }
      return;
    }
    const node = this.comps[name];
    // remember whether this component was already selected, so a plain click
    // (no drag) on it toggles the selection off in onDragEnd.
    this.wasSelected = this.selected === name && this.selectedKind === "comp";
    this.dragging = name;
    this.dragMoved = false;
    this.dragStartX = e.global.x;
    this.dragStartY = e.global.y;
    this.dragOffsetX = node.sprite.x - e.global.x;
    this.dragOffsetY = node.sprite.y - e.global.y;
    this.select(name);
  }

  private onDragMove(e: any) {
    if (!this.dragging) return;
    // ignore sub-pixel jitter so a click isn't mistaken for a drag
    if (Math.hypot(e.global.x - this.dragStartX, e.global.y - this.dragStartY) > 3) {
      this.dragMoved = true;
    }
    const node = this.comps[this.dragging];
    node.x = this.snap(e.global.x + this.dragOffsetX);
    node.y = this.snap(e.global.y + this.dragOffsetY);
    this.syncCompartmentPos(node); // moves disc + glow/rim together
    this.positionLabel(node);
    this.rerouteConnectors(this.dragging);
    this.drawSelection();
  }

  private onDragEnd() {
    if (!this.dragging) return;
    const name = this.dragging;
    // a plain click (no drag) on an already-selected component deselects it
    if (this.wasSelected && !this.dragMoved) {
      this.dragging = null;
      this.clearSelection();
      return;
    }
    const node = this.comps[name];
    const cx = this.xCenter + this.xOffset;
    const cy = this.yCenter + this.yOffset;
    const r = this.ringR;
    // snap to the layout circle if released near it, else commit as relative.
    // When the grid is on, grid-snapping wins — skip the circle snap so the
    // position stays on the grid.
    const dist = Math.abs(Math.hypot(node.sprite.x - cx, node.sprite.y - cy) - r);
    if (!this.gridOn && dist < 15) {
      const dgs = (Math.atan2(node.sprite.y - cy, node.sprite.x - cx) * 180) / Math.PI;
      this.commitPos(node, { type: "arc", x: 0, y: 0, dgs });
      node.posType = "arc";
      node.dgs = dgs;
      const p = this.placeAt(node.layout);
      node.x = p.x;
      node.y = p.y;
    } else if (node.posType === "bottom") {
      // stay pinned to the bottom edge; keep the dragged distance from it
      this.commitPos(node, { type: "bottom", x: (node.x - cx) / r, y: this.canvasHeight() - node.y, dgs: 0 });
    } else {
      this.commitPos(node, { type: "rel", x: (node.x - cx) / r, y: (node.y - cy) / r, dgs: 0 });
      node.posType = "rel";
    }
    this.syncCompartmentPos(node); // settle disc + glow/rim at the final position
    this.positionLabel(node);
    this.rerouteConnectors(name);
    this.drawSelection();
    this.dragging = null;
    this.onSelectCb?.(name, this.diagram.components[name], "comp");
  }

  // store a dragged position into whichever of pos / band_pos is in effect
  private commitPos(node: CompNode, pos: any) {
    if (this.bandOn && node.layout.sprite.band_pos) node.layout.sprite.band_pos = pos;
    else node.layout.sprite.pos = pos;
  }

  private select(name: string, kind: "comp" | "conn" = "comp") {
    this.selected = name;
    this.selectedKind = kind;
    this.drawSelection();
    this.onSelectCb?.(name, this.diagram.components[name], kind);
  }

  /** Clear the current selection (used by Escape / leaving edit mode). */
  clearSelection() {
    this.selected = null;
    this.selectedKind = null;
    this.connectFrom = null;
    this.drawSelection();
    this.onSelectCb?.(null, null, null);
  }

  /** Delete the selected component (sprite + attached connectors) and its
   *  entry in diagram_definition. */
  deleteSelected() {
    if (this.selected) this.removeByName(this.selected, this.selectedKind);
  }

  /** Delete a component or connector by name (sprite/graphics + attached
   *  connectors) and its entry in diagram_definition. Used by the editor
   *  (deleteSelected) and by programmatic/bot edits. `kind` is inferred from the
   *  diagram when omitted, so callers needn't track the selection. */
  removeByName(name: string, kind?: "comp" | "conn" | null) {
    if (!name || !this.app || !this.diagram?.components?.[name]) return;
    const k = kind ?? (this.diagram.components[name].type === "Connector" ? "conn" : "comp");
    if (k === "conn") {
      this.conns = this.conns.filter((c) => {
        if (c.name !== name) return true;
        this.app!.stage.removeChild(c.graphics);
        for (const d of c.dots) this.app!.stage.removeChild(d);
        return false;
      });
      delete this.diagram.components[name];
      if (this.selected === name) this.clearSelection();
      this.onChangeCb?.();
      return;
    }
    const node = this.comps[name];
    if (node) {
      this.app.stage.removeChild(node.sprite);
      if (node.glow) this.app.stage.removeChild(node.glow);
      if (node.rim) this.app.stage.removeChild(node.rim);
      if (node.label) this.app.stage.removeChild(node.label);
      delete this.comps[name];
    }
    this.conns = this.conns.filter((c) => {
      if (c.from === name || c.to === name) {
        this.app!.stage.removeChild(c.graphics);
        for (const d of c.dots) this.app!.stage.removeChild(d);
        return false;
      }
      return true;
    });
    delete this.diagram.components[name];
    if (this.selected === name) this.clearSelection();
    this.onChangeCb?.();
  }

  private drawSelection() {
    if (!this.app) return;
    if (!this.selectionG) {
      this.selectionG = new Graphics();
      this.selectionG.zIndex = 9999;
      this.selectionG.eventMode = "none";
      this.app.stage.addChild(this.selectionG);
    }
    const g = this.selectionG;
    g.clear();
    if (!this.selected) return;
    if (this.selectedKind === "conn") {
      const conn = this.conns.find((c) => c.name === this.selected);
      if (!conn?.geom) return;
      // trace the path with a translucent cyan highlight under the backbone
      const geom = conn.geom;
      if (geom.type === "straight") {
        g.moveTo(geom.x1, geom.y1).lineTo(geom.x2, geom.y2);
      } else {
        const pts = samplePath(geom);
        g.moveTo(pts[0], pts[1]);
        for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
      }
      const w = numberOr(Number(conn.layout.path.width), 5) * this.scaling;
      g.stroke({ width: w + 6, color: 0x22d3ee, alpha: 0.5 });
      return;
    }
    const node = this.comps[this.selected];
    if (!node) return;
    const b = node.sprite.getBounds();
    g.rect(b.x, b.y, b.width, b.height).stroke({ width: 2, color: 0x22d3ee });
  }

  // ---- Lesson highlight ----

  /** Point at components and/or connectors by diagram name: a pulsing amber
   *  outline (ring round a compartment, glow along a connector) plus an optional
   *  caption per name. Unknown names are ignored; [] clears. Independent of the
   *  editor selection and of edit mode. Redrawn every tick while active, so it
   *  follows volume-scaled sprites and resizes. */
  setHighlight(names: string[], labels: Record<string, string> = {}) {
    this.highlightNames = [...names];
    for (const t of this.highlightTexts.values()) t.destroy();
    this.highlightTexts.clear();
    if (!this.app) return;
    if (!this.highlightG) {
      this.highlightG = new Graphics();
      this.highlightG.zIndex = 9998; // under the editor selection
      this.highlightG.eventMode = "none";
      this.app.stage.addChild(this.highlightG);
    }
    for (const name of names) {
      const caption = labels[name];
      if (!caption) continue;
      const t = new Text({
        text: caption,
        style: {
          fontFamily: "system-ui, -apple-system, sans-serif",
          fontSize: 13 * this.scaling,
          fontWeight: "600",
          fill: HIGHLIGHT_COLOR,
          stroke: { color: 0x000000, width: 4 },
          align: "center",
        },
      });
      t.anchor.set(0.5, 0.5);
      t.eventMode = "none";
      t.zIndex = 10000;
      this.app.stage.addChild(t);
      this.highlightTexts.set(name, t);
    }
    if (names.length && !this.highlightTick) {
      this.highlightTick = () => this.drawHighlight();
      this.app.ticker.add(this.highlightTick);
    } else if (!names.length && this.highlightTick) {
      this.app.ticker.remove(this.highlightTick);
      this.highlightTick = null;
    }
    this.drawHighlight();
  }

  private drawHighlight() {
    const g = this.highlightG;
    if (!g) return;
    g.clear();
    if (!this.highlightNames.length) return;
    const pulse = 0.55 + 0.35 * Math.sin(performance.now() / 280);
    for (const name of this.highlightNames) {
      const text = this.highlightTexts.get(name);
      if (text) text.visible = this.isVisibleName(name);
      const conn = this.conns.find((c) => c.name === name);
      if (conn && !conn.graphics.visible) continue; // hidden device group
      if (conn?.geom) {
        const pts = samplePath(conn.geom);
        if (pts.length < 4) continue;
        g.moveTo(pts[0], pts[1]);
        for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
        const w = numberOr(Number(conn.layout.path.width), 5) * this.scaling;
        g.stroke({ width: w + 10, color: HIGHLIGHT_COLOR, alpha: 0.45 * pulse });
        if (text) {
          // caption at the path's midpoint, nudged off the line
          const m = Math.floor(pts.length / 4) * 2;
          text.position.set(pts[m], pts[m + 1] - 14 * this.scaling);
        }
        continue;
      }
      const node = this.comps[name];
      if (!node || !node.sprite.visible) continue;
      const b = node.sprite.getBounds();
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      const r = Math.max(b.width, b.height) / 2 + 6 * this.scaling;
      g.circle(cx, cy, r).stroke({ width: 3, color: HIGHLIGHT_COLOR, alpha: pulse });
      if (text) text.position.set(cx, cy + r + 10 * this.scaling);
    }
  }

  setConnectMode(on: boolean) {
    this.connectMode = on;
    this.connectFrom = null;
  }

  /** Add a new compartment bound to a model, placed at center. Note: newly added
   *  components are static until the engine is rebuilt with the exported diagram
   *  (the anim registry is fixed at model-build time). */
  async addCompartment(modelName: string, picto?: string) {
    if (!this.app || !this.diagram?.components) return null;
    const name = this.uniqueName(modelName || "NEW");
    const comp = defaultCompartment(modelName, picto);
    this.diagram.components[name] = comp;
    await Assets.load([gfxPath(comp.picto)]);
    this.makeCompartment(name, comp);
    this.select(name, "comp");
    this.onChangeCb?.();
    return name;
  }

  private createConnection(fromName: string, toName: string): string | null {
    if (!this.diagram?.components) return null;
    const name = this.uniqueName(fromName + "_" + toName);
    const comp = defaultConnector(fromName, toName);
    this.diagram.components[name] = comp;
    this.makeConnector(name, comp);
    this.select(name, "conn");
    this.onChangeCb?.();
    return name;
  }

  /** Create a connector between two existing components by name (programmatic
   *  equivalent of connect-mode's two clicks), optionally binding engine
   *  model(s) and applying a path patch. Returns the new connector name, or null
   *  if either endpoint is missing. */
  connect(
    from: string,
    to: string,
    opts?: { models?: string[]; path?: { type?: string; width?: number } },
  ): string | null {
    if (!this.comps[from] || !this.comps[to]) return null;
    const name = this.createConnection(from, to);
    if (!name) return null;
    if (opts?.models) this.setModels(name, opts.models);
    if (opts?.path) this.applyLayoutPatch(name, { path: opts.path });
    return name;
  }

  private uniqueName(base: string): string {
    let n = base || "NEW";
    let i = 1;
    while (this.diagram.components[n] || this.comps[n]) n = `${base}_${i++}`;
    return n;
  }

  private rerouteConnectors(name: string) {
    for (const conn of this.conns) {
      if (conn.from !== name && conn.to !== name) continue;
      const f = this.comps[conn.from];
      const t = this.comps[conn.to];
      if (f && t) conn.geom = this.drawPath(conn.graphics, conn.layout, f, t);
    }
  }

  dispose() {
    this.ready = false;
    if (this.ro) {
      this.ro.disconnect();
      this.ro = null;
    }
    if (this.app) {
      this.app.destroy(true, { children: true });
      this.app = null;
    }
    this.comps = {};
    this.conns = [];
    this.selectionG = null;
    this.highlightG = null; // destroyed with the stage (ticker goes with the app)
    this.highlightTick = null;
    this.highlightTexts.clear();
    this.highlightNames = [];
    this.bgSprite = null;
    this.glowTex = null;
    this.vignetteTex = null;
    this.gridG = null;
  }
}

function wrap01(v: number): number {
  return ((v % 1) + 1) % 1;
}

function defaultCompartment(modelName: string, picto?: string) {
  return {
    type: "Compartment",
    label: modelName || "",
    picto: (picto || "container.png").replace("gfx/", ""),
    enabled: true,
    models: modelName ? [modelName] : [],
    dbcFrom: "",
    dbcTo: "",
    layout: {
      general: { animatedBy: "vol", z_index: 10, alpha: 1, tinting: true },
      path: { type: "straight", width: 5, color: "#666666" },
      sprite: {
        color: "#ffffff",
        pos: { type: "rel", x: 0, y: 0, dgs: 0 },
        scale: { x: 1, y: 1 },
        anchor: { x: 0.5, y: 0.5 },
        rotation: 0,
      },
      label: { pos_x: 0, pos_y: 0, size: 10, rotation: 0, color: "#ffffff" },
    },
  };
}

function defaultConnector(from: string, to: string) {
  return {
    type: "Connector",
    label: "",
    picto: "container.png",
    enabled: true,
    models: [],
    dbcFrom: from,
    dbcTo: to,
    layout: {
      general: { animatedBy: "flow", z_index: 8, alpha: 1, tinting: true },
      path: { type: "straight", width: 7, color: "#666666" },
      sprite: {
        color: "#ffffff",
        pos: { type: "rel", x: 0, y: 0, dgs: 0 },
        scale: { x: 1, y: 1 },
        anchor: { x: 0.5, y: 0.5 },
        rotation: 0,
      },
      label: { pos_x: 0, pos_y: 0, size: 10, rotation: 0, color: "#ffffff" },
    },
  };
}

function numberOr(v: any, fallback: number): number {
  return typeof v === "number" && !Number.isNaN(v) ? v : fallback;
}

// shallow-recursive merge of a layout patch into the target (objects merged,
// primitives/arrays replaced).
function deepMerge(target: any, patch: any) {
  for (const k of Object.keys(patch)) {
    const v = patch[k];
    if (v && typeof v === "object" && !Array.isArray(v) && typeof target[k] === "object") {
      deepMerge(target[k], v);
    } else {
      target[k] = v;
    }
  }
}

// `sprite.fixed_size`: a constant disc radius (radiusFromVolume units) for nodes
// whose volume would mislead as a size cue — e.g. an ECLS oxygenator's priming
// volume dwarfing the neonatal heart. Null = size by volume.
function fixedSize(layout: any): number | null {
  const v = layout?.sprite?.fixed_size;
  return typeof v === "number" && v > 0 ? v : null;
}

function radiusFromVolume(vol: number): number {
  const cubic = vol / ((4.0 / 3.0) * Math.PI);
  return Math.cbrt(cubic);
}

// Anatomical oxygenation ramp (Theme C). Maps blood O2 content (to2) onto a
// deoxygenated slate-blue → oxygenated brick-red gradient via linear RGB interp.
//
// The gradient window [lo, hi] is in to2 (O2 CONTENT) units, not saturation.
// These module values are the defaults; a diagram overrides them via
// settings.to2_lo / settings.to2_hi (live-editable, see setTo2Range). The window
// matters because to2 content scales with Hb: at the same saturation an adult
// with lower Hb has a lower arterial to2 than a neonate, so a fixed window would
// peg the whole adult circuit to the venous (blue) end. Tuning the window per
// diagram restores genuine venous↔arterial colour separation. (The legacy
// per-diagram `max_to2` hint is unrelated and still ignored.)
// TO2_LO/TO2_HI, DEOX_RGB/OX_RGB, RAMP_GAMMA and rgbFromTo2 live in
// diagramConstants.ts (Pixi-free) so the lesson legend draws the same ramp.
const WHITE_RGB = [255, 255, 255];
const HIGHLIGHT_COLOR = 0xfbbf24; // lesson pointing (amber), distinct from the editor's cyan

// pack an rgb triple (floats ok) into a 0xRRGGBB tint int
function packRgb(rgb: number[]): number {
  return (clampByte(rgb[0]) << 16) | (clampByte(rgb[1]) << 8) | clampByte(rgb[2]);
}
function clampByte(v: number): number {
  v = Math.round(v);
  return v < 0 ? 0 : v > 255 ? 255 : v;
}
function lerpRgb(a: number[], b: number[], t: number): number[] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
function hexToRgb(hex: string): [number, number, number] {
  const h = (hex || "#ffffff").replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16) || 0;
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}
function hexToCss(n: number): string {
  return "#" + (n & 0xffffff).toString(16).padStart(6, "0");
}
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// number of streaming dots for a path of `len` px (one per ~DOT_SPACING_PX),
// clamped so short connectors keep at least a couple and long ones don't swarm.
function dotCount(len: number, scaling: number): number {
  const n = Math.round(len / (DOT_SPACING_PX * scaling));
  return n < DOT_MIN ? DOT_MIN : n > DOT_MAX ? DOT_MAX : n;
}

// default "outer" bypass track radius (ring radii) when a connector sets no
// path.track — used only when the direct track would cross other device nodes
const OUTER_TRACK_DEFAULT = 1.5;

// default corner radius (ring radii) for the bends of an "outer" route
const OUTER_CORNER_DEFAULT = 0.2;

// Round the sharp corners of a flat [x,y,…] polyline: every interior vertex that
// turns by more than `minTurnDeg` (so an arc's own small tessellation steps are
// left alone) is replaced by a quadratic Bézier from the point `d` before it to
// the point `d` after it, with the corner as control point, so the bend leaves
// and joins the runs tangentially. `d` = `radius`, capped at 45% of the run on
// either side (a run reaches to the next corner or end) so short stubs survive.
function roundCorners(pts: number[], radius: number, minTurnDeg = 25): number[] {
  // points, dropping zero-length steps (they would break the turn test)
  const P: [number, number][] = [];
  for (let i = 0; i < pts.length; i += 2) {
    const last = P[P.length - 1];
    if (!last || Math.hypot(pts[i] - last[0], pts[i + 1] - last[1]) > 1e-6) P.push([pts[i], pts[i + 1]]);
  }
  if (P.length < 3 || !(radius > 0)) return pts;
  const s = [0];
  for (let i = 1; i < P.length; i++) s.push(s[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
  const corners: number[] = [];
  const minTurn = minTurnDeg * DEG;
  for (let i = 1; i < P.length - 1; i++) {
    const a1 = Math.atan2(P[i][1] - P[i - 1][1], P[i][0] - P[i - 1][0]);
    const a2 = Math.atan2(P[i + 1][1] - P[i][1], P[i + 1][0] - P[i][0]);
    let turn = Math.abs(a2 - a1);
    if (turn > Math.PI) turn = 2 * Math.PI - turn;
    if (turn > minTurn) corners.push(i);
  }
  if (!corners.length) return pts;
  const at = (d: number): [number, number] => {
    let i = 1;
    while (i < s.length - 1 && s[i] < d) i++;
    const t = (d - s[i - 1]) / (s[i] - s[i - 1] || 1);
    return [P[i - 1][0] + (P[i][0] - P[i - 1][0]) * t, P[i - 1][1] + (P[i][1] - P[i - 1][1]) * t];
  };
  const bounds = [0, ...corners, P.length - 1];
  const spans = corners.map((ci, k) => {
    const d = Math.min(radius, 0.45 * (s[ci] - s[bounds[k]]), 0.45 * (s[bounds[k + 2]] - s[ci]));
    return { a: s[ci] - d, b: s[ci] + d, c: P[ci] };
  });
  const out: number[] = [P[0][0], P[0][1]];
  let k = 0;
  let skipTo = -1;
  const STEPS = 8;
  for (let i = 1; i < P.length; i++) {
    while (k < spans.length && spans[k].a <= s[i]) {
      const { a, b, c } = spans[k++];
      const p0 = at(a);
      const p2 = at(b);
      out.push(p0[0], p0[1]);
      for (let j = 1; j <= STEPS; j++) {
        const t = j / STEPS;
        const u = 1 - t;
        out.push(u * u * p0[0] + 2 * u * t * c[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * c[1] + t * t * p2[1]);
      }
      skipTo = b;
    }
    if (s[i] <= skipTo + 1e-6) continue;
    out.push(P[i][0], P[i][1]);
  }
  return out;
}

// polyline geometry with cumulative segment lengths, for "outer" routes
function polyGeom(pts: number[]): any {
  const cum = [0];
  for (let i = 2; i < pts.length; i += 2) {
    cum.push(cum[cum.length - 1] + Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]));
  }
  return { type: "poly", pts, cum, len: cum[cum.length - 1] };
}

// reverse a flat [x0,y0,x1,y1,…] point list
function reversePts(pts: number[]): number[] {
  const out: number[] = [];
  for (let i = pts.length - 2; i >= 0; i -= 2) out.push(pts[i], pts[i + 1]);
  return out;
}

// length of a connector path geometry in px (straight chord or arc length)
function pathLength(g: any): number {
  if (!g) return 0;
  if (g.type === "straight") return Math.hypot(g.x2 - g.x1, g.y2 - g.y1);
  if (g.type === "poly") return g.len;
  return Math.abs(g.to - g.from) * g.r;
}

// point at fraction `frac` [0,1] along a connector path geometry
function pointOnPath(g: any, frac: number): { x: number; y: number } {
  if (g.type === "straight") {
    return { x: g.x1 + (g.x2 - g.x1) * frac, y: g.y1 + (g.y2 - g.y1) * frac };
  }
  if (g.type === "poly") {
    const d = frac * g.len;
    let i = 1;
    while (i < g.cum.length - 1 && g.cum[i] < d) i++;
    const seg = g.cum[i] - g.cum[i - 1] || 1;
    const t = (d - g.cum[i - 1]) / seg;
    const p = g.pts;
    return { x: p[2 * i - 2] + (p[2 * i] - p[2 * i - 2]) * t, y: p[2 * i - 1] + (p[2 * i + 1] - p[2 * i - 1]) * t };
  }
  const ang = g.from + (g.to - g.from) * frac;
  return { x: g.cx + g.r * Math.cos(ang), y: g.cy + g.r * Math.sin(ang) };
}

// build a square radial-gradient Texture from canvas (centre → edge colour stops)
function makeRadialTexture(size: number, stops: [number, string][]): Texture {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [off, col] of stops) grad.addColorStop(off, col);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  return Texture.from(c);
}

// center of a circle of radius r passing through (x1,y1) and (x2,y2)
function circleCenterThrough(x1: number, y1: number, x2: number, y2: number, r: number) {
  const q = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2) || 1;
  const x3 = (x1 + x2) / 2;
  const y3 = (y1 + y2) / 2;
  const h = Math.sqrt(Math.max(0, r * r - (q / 2) ** 2));
  return {
    cx: x3 + h * ((y1 - y2) / q),
    cy: y3 + h * ((x2 - x1) / q),
  };
}

function angleOnCircle(cx: number, cy: number, x: number, y: number): number {
  return Math.atan2(y - cy, x - cx);
}

// Sample a connector path geometry into a flat [x0,y0,x1,y1,...] point list.
// Straight paths are 2 points; arcs are tessellated into ~24 segments.
function samplePath(geom: any): number[] {
  if (!geom) return [];
  if (geom.type === "straight") return [geom.x1, geom.y1, geom.x2, geom.y2];
  if (geom.type === "poly") return geom.pts;
  const steps = 24;
  const pts: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = geom.from + (geom.to - geom.from) * (i / steps);
    pts.push(geom.cx + geom.r * Math.cos(a), geom.cy + geom.r * Math.sin(a));
  }
  return pts;
}

// A Pixi-compatible hit area (anything with contains(x,y)) that tests whether a
// point lies within `tol` px of a polyline — used to make thin connector
// strokes comfortably clickable in the editor.
class PolylineHitArea {
  private pts: number[];
  private tol: number;
  constructor(pts: number[], tol: number) {
    this.pts = pts;
    this.tol = tol;
  }
  contains(x: number, y: number): boolean {
    const t2 = this.tol * this.tol;
    for (let i = 0; i + 3 < this.pts.length; i += 2) {
      if (distToSeg2(x, y, this.pts[i], this.pts[i + 1], this.pts[i + 2], this.pts[i + 3]) <= t2)
        return true;
    }
    return false;
  }
}

// squared distance from point (px,py) to segment (ax,ay)-(bx,by)
function distToSeg2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy || 1e-9;
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return (px - cx) ** 2 + (py - cy) ** 2;
}
