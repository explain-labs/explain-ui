<script setup lang="ts">
import { computed, onBeforeUnmount } from "vue";

// One SLE6000 parameter control (IFU p150, pp 68-76): a rounded tile with the label on top, a 270°
// arc gauge (black track, a fill coloured by parameter type from the minimum to the value) with the
// range ends and unit under it, and the value in the middle. A tap selects it; holding it emits
// `hold` (2 s switches an Off function on, 3 s on O2 starts O2 Boost).
const props = withDefaults(
  defineProps<{
    label: string;
    unit: string;
    min: number;
    max: number;
    value: number;
    decimals: number;
    kind: string; // time | pressure | o2 | sens
    state?: "available" | "selected" | "preview";
    canBeOff?: boolean; // value 0 shows "Off"
    holdMs?: number; // 0 = no hold gesture
    boost?: number | null; // O2 Boost level shown as a red arc segment
  }>(),
  { state: "available", canBeOff: false, holdMs: 0, boost: null },
);
const emit = defineEmits<{ (e: "tap"): void; (e: "hold"): void }>();

const COLORS: Record<string, string> = { time: "#2d9fdc", pressure: "#f0a032", o2: "#3fb54c", sens: "#f2f2f2" };
const off = computed(() => props.canBeOff && props.value === 0);
const text = computed(() => (off.value ? "Off" : props.value.toFixed(props.decimals)));
const fmtEnd = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

// arc geometry in a 100 x 100 box: centre (50, 56), radius 28, from 135° clockwise over 270°
const CX = 50, CY = 56, R = 28;
const pt = (deg: number) => {
  const a = (deg * Math.PI) / 180;
  return [CX + R * Math.cos(a), CY + R * Math.sin(a)];
};
function arc(from: number, to: number) {
  if (to - from < 0.01) return "";
  const [x0, y0] = pt(from);
  const [x1, y1] = pt(to);
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${R} ${R} 0 ${to - from > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}
const frac = (v: number) => Math.min(1, Math.max(0, (v - props.min) / (props.max - props.min || 1)));
const fillPath = computed(() => (off.value ? "" : arc(135, 135 + 270 * frac(props.value))));
const boostPath = computed(() =>
  props.boost != null && props.boost > props.value ? arc(135 + 270 * frac(props.value), 135 + 270 * frac(props.boost)) : "",
);

// tap vs hold
let timer: ReturnType<typeof setTimeout> | null = null;
let held = false;
function down(e: PointerEvent) {
  try {
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  } catch {
    // no active pointer with that id (synthetic events): the hold still works without capture
  }
  held = false;
  if (props.holdMs > 0) {
    timer = setTimeout(() => {
      held = true;
      timer = null;
      emit("hold");
    }, props.holdMs);
  }
}
function up() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!held) emit("tap");
  held = false;
}
function cancel() {
  if (timer) clearTimeout(timer);
  timer = null;
}
onBeforeUnmount(cancel);
</script>

<template>
  <div
    class="sle-tile"
    :class="state"
    role="button"
    :aria-label="`${label} ${text} ${unit}`"
    @pointerdown="down"
    @pointerup="up"
    @pointercancel="cancel"
    @pointerleave="cancel"
  >
    <div class="sle-tile-label">{{ label }}</div>
    <svg viewBox="0 0 100 100" class="sle-tile-svg">
      <path :d="arc(135, 405)" class="track" />
      <path v-if="fillPath" :d="fillPath" class="fill" :style="{ stroke: COLORS[kind] }" />
      <path v-if="boostPath" :d="boostPath" class="fill" style="stroke: #e53935" />
      <text :x="CX" :y="CY + 6" class="value" :class="{ off }">{{ text }}</text>
      <text :x="pt(135)[0] - 1" :y="94" class="end" text-anchor="start">{{ fmtEnd(min) }}</text>
      <text :x="pt(45)[0] + 1" :y="94" class="end" text-anchor="end">{{ fmtEnd(max) }}</text>
      <text :x="CX" :y="94" class="unit">{{ unit }}</text>
    </svg>
  </div>
</template>

<style scoped>
.sle-tile {
  position: relative;
  width: 108px;
  height: 108px;
  border-radius: 8px;
  border: 2px solid #1d1e21;
  background: #6b6e73;
  color: #f4f4f4;
  user-select: none;
  touch-action: none;
  cursor: pointer;
  font-family: Arial, Helvetica, sans-serif;
}
.sle-tile.selected {
  background: #f4f4f4;
  color: #1d1e21;
}
.sle-tile.preview {
  background: #111214;
  border-color: #f4f4f4;
}
.sle-tile.preview .track {
  stroke: #3a3c40; /* the black track would vanish on the black preview tile */
}
.sle-tile-label {
  position: absolute;
  top: 5px;
  width: 100%;
  text-align: center;
  font-size: 12px;
}
.sle-tile-svg {
  position: absolute;
  inset: 8px 0 0 0;
  width: 100%;
  height: calc(100% - 8px);
}
.track {
  fill: none;
  stroke: #111214;
  stroke-width: 7;
}
.fill {
  fill: none;
  stroke-width: 7;
}
.value {
  fill: currentColor;
  font-size: 19px;
  text-anchor: middle;
}
.value.off {
  font-size: 17px;
}
.end,
.unit {
  fill: currentColor;
  font-size: 7.5px;
  opacity: 0.85;
}
.unit {
  text-anchor: middle;
}
</style>
