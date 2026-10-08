<script setup lang="ts">
import { computed } from "vue";
import { MON_SINGLE, MON_DOUBLE, type MonValue } from "./sleUi";

// The monitored-values column (IFU p151): grouped dark tiles with a small label and unit at the
// top left and the value right-aligned. Single column (8 values, the factory default) or double
// column (16); touch and hold for 1 s to switch.
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
        <div class="sle-mon-cap">
          <span>{{ m.label }}</span>
          <span class="unit">{{ m.unit }}</span>
        </div>
        <div class="sle-mon-val">{{ show(m) }}</div>
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
  background: #6b6e73;
  border: 2px solid #1d1e21;
  border-radius: 6px;
  padding: 2px 8px;
}
.sle-mon-group.double {
  grid-template-columns: 1fr 1fr;
  column-gap: 10px;
}
.sle-mon-cell {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  min-height: 42px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.12);
}
.sle-mon-group.double .sle-mon-cell {
  min-height: 34px;
}
.sle-mon-cell:last-child,
.sle-mon-group.double .sle-mon-cell:nth-last-child(2) {
  border-bottom: none;
}
.sle-mon-cap {
  display: flex;
  flex-direction: column;
  font-size: 11px;
  color: #e6e7e8;
  padding-top: 3px;
  line-height: 1.15;
}
.sle-mon-cap .unit {
  font-size: 9px;
  opacity: 0.75;
}
.sle-mon-val {
  font-size: 26px;
  color: #ffffff;
  align-self: center;
}
.sle-mon-group.double .sle-mon-val {
  font-size: 18px;
}
</style>
