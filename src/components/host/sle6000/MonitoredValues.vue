<script setup lang="ts">
import { computed } from "vue";
import { monGroups, type MonValue } from "./sleUi";

// The monitored-values column (IFU p151; look from the device photos, see sleTheme.ts): white values
// on black, right-aligned, each with a small grey "label (unit)" under it, in dark group boxes.
// Single column (8 values) or double column (16, as on the photos); touch and hold 1 s to switch.
// The sets follow the mode (conventional, HFOV, HFOV+CMV); an empty cell keeps the device's layout.
// Sizes from a ward photo of the device (HFO, double column): the boxes share the column height by
// their number of rows, values about 36 px (single) / 32 px (double), captions 13 px.
const props = defineProps<{ values: Record<string, unknown>; double: boolean; active: boolean; mode: string | null }>();
const emit = defineEmits<{ (e: "toggle"): void }>();

const groups = computed(() => monGroups(props.mode, props.double));
const rows = (g: unknown[]) => (props.double ? Math.ceil(g.length / 2) : g.length);
function show(m: MonValue): string {
  const v = props.values[m.path];
  if (!props.active || typeof v !== "number" || !Number.isFinite(v)) return "---";
  return m.fmt ? m.fmt(v) : v.toFixed(m.d);
}

let timer: ReturnType<typeof setTimeout> | null = null;
function down() {
  timer = setTimeout(() => {
    timer = null;
    emit("toggle");
  }, 1000);
}
function cancel() {
  if (timer) clearTimeout(timer);
  timer = null;
}
</script>

<template>
  <div class="sle-mon" @pointerdown="down" @pointerup="cancel" @pointerleave="cancel" @pointercancel="cancel">
    <div v-for="(g, gi) in groups" :key="gi" class="sle-mon-group" :class="{ double }" :style="{ flexGrow: rows(g) }">
      <template v-for="(m, i) in g" :key="(m?.path ?? 'gap') + i">
        <div v-if="m" class="sle-mon-cell">
          <div class="sle-mon-val">{{ show(m) }}</div>
          <div class="sle-mon-cap">{{ m.unit ? `${m.label} (${m.unit})` : m.label }}</div>
        </div>
        <div v-else class="sle-mon-cell"></div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.sle-mon {
  display: flex;
  flex-direction: column;
  gap: 6px;
  height: 100%;
  user-select: none;
  font-family: Arial, Helvetica, sans-serif;
}
.sle-mon-group {
  flex: 1 1 0;
  min-height: 0;
  display: grid;
  grid-template-columns: 1fr;
  grid-auto-rows: 1fr;
  background: var(--sle-panel);
  border: 1px solid #000;
  border-radius: 6px;
  padding: 2px 8px;
}
.sle-mon-group.double {
  grid-template-columns: 1fr 1fr;
  column-gap: 12px;
}
.sle-mon-cell {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  justify-content: center;
  padding: 2px 0;
}
.sle-mon-val {
  font-size: 36px;
  line-height: 1.05;
  color: #f2f2f2;
}
.sle-mon-group.double .sle-mon-val {
  font-size: 32px;
}
.sle-mon-cap {
  font-size: 13px;
  font-style: italic;
  color: #d8d8d8; /* light on the grey box, as on the captures */
}
</style>
