<script setup lang="ts">
import { computed } from "vue";
import { MON_SINGLE, MON_DOUBLE, type MonValue } from "./sleUi";

// The monitored-values column (IFU p151; look from the device photos, see sleTheme.ts): white values
// on black, right-aligned, each with a small grey "label (unit)" under it, in dark group boxes.
// Single column (8 values) or double column (16, as on the photos); touch and hold 1 s to switch.
const props = defineProps<{ values: Record<string, unknown>; double: boolean; active: boolean }>();
const emit = defineEmits<{ (e: "toggle"): void }>();

const groups = computed(() => (props.double ? MON_DOUBLE : MON_SINGLE));
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
    <div v-for="(g, gi) in groups" :key="gi" class="sle-mon-group" :class="{ double }">
      <div v-for="m in g" :key="m.path + m.label" class="sle-mon-cell">
        <div class="sle-mon-val">{{ show(m) }}</div>
        <div class="sle-mon-cap">{{ m.unit ? `${m.label} (${m.unit})` : m.label }}</div>
      </div>
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
  display: grid;
  grid-template-columns: 1fr;
  background: #0b0c0e;
  border: 1px solid #3a3c41;
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
  padding: 3px 0 2px;
}
.sle-mon-val {
  font-size: 28px;
  line-height: 1.05;
  color: #f2f2f2;
}
.sle-mon-group.double .sle-mon-val {
  font-size: 20px;
}
.sle-mon-cap {
  font-size: 10px;
  font-style: italic;
  color: #a9acb1;
}
</style>
