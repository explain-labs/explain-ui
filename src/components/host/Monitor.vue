<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, computed, watch } from "vue";
import Select from "primevue/select";
import { useRealtimeBus } from "@/composables/useRealtimeBus";
import { useExplain } from "@/composables/useExplain";
import { MonitorRenderer } from "@/render/MonitorRenderer";
import { ALL_LANES, LANE_DEFS, type LaneId } from "@/render/monitorLanes";

// Bedside patient-monitor host. Streams the Monitor model's purpose-built
// waveform signals (fast chart channel) into a single sweep canvas, and feeds
// the big numerics from the 1 Hz slow stream (rts). Waveforms never touch Vue
// reactivity; only the slow numerics do (safe at ~1 Hz).
const el = ref<HTMLDivElement | null>(null);
const { addRenderer, removeRenderer } = useRealtimeBus();
const { watch: watchProps, watchSlow, slowValues, modelReady } = useExplain();
let adapter: MonitorRenderer | null = null;

const props = withDefaults(
  defineProps<{
    lanes?: LaneId[]; // subset + order of lanes to show (default: all six)
    height?: string; // CSS height of the sweep canvas
    minHeight?: string;
    showWindowSelect?: boolean; // show the sweep-window picker
    highlight?: LaneId[]; // lanes to frame (lesson steps); must be among `lanes`
  }>(),
  { lanes: () => ALL_LANES, height: "70vh", minHeight: "480px", showWindowSelect: true },
);

// Lanes are fixed for the component's lifetime (the renderer is built once on
// mount); hosts that need a different set remount it.
const LANES = props.lanes.map((id) => LANE_DEFS[id]);
const FAST_PATHS = LANES.map((l) => l.signal);
const SLOW_PATHS = LANES.flatMap((l) => l.slow);

// sweep window (full left→right travel time)
const WINDOW_OPTIONS = [
  { label: "4 s", value: 4 },
  { label: "6 s", value: 6 },
  { label: "8 s", value: 8 },
  { label: "12 s", value: 12 },
];
const windowS = ref(6);

const latest = computed<Record<string, number>>(() => {
  const arr = slowValues.value as any[];
  return Array.isArray(arr) && arr.length ? arr[arr.length - 1] : {};
});

watch(windowS, (v) => adapter?.setWindow(v));

function applyHighlight() {
  const ids = props.highlight ?? [];
  adapter?.setHighlight(ids.map((id) => props.lanes.indexOf(id)).filter((i) => i >= 0));
}
watch(() => props.highlight, applyHighlight);
watch(latest, (n) => adapter?.setNumerics(n));

// build() replaces the DataCollector (watchlist is reset), so re-register every (re)build
watch(modelReady, (ready) => {
  if (ready) {
    watchProps(FAST_PATHS);
    watchSlow(SLOW_PATHS);
  }
});

onMounted(() => {
  adapter = new MonitorRenderer(el.value!, LANES, windowS.value);
  addRenderer(adapter);
  watchProps(FAST_PATHS); // stream the waveform signals (additive)
  watchSlow(SLOW_PATHS); // numerics on the slow stream
  adapter.setNumerics(latest.value);
  applyHighlight();
});

onBeforeUnmount(() => {
  if (adapter) {
    removeRenderer(adapter);
    adapter.dispose();
  }
});
</script>

<template>
  <div class="flex flex-col gap-2">
    <div v-if="showWindowSelect" class="flex items-center justify-end gap-1.5 text-xs">
      <span class="opacity-60">sweep</span>
      <Select
        v-model="windowS"
        :options="WINDOW_OPTIONS"
        option-label="label"
        option-value="value"
        size="small"
        class="w-20"
      />
    </div>
    <div
      ref="el"
      class="w-full rounded overflow-hidden"
      :style="{ height, minHeight, background: '#0a0e14' }"
    ></div>
  </div>
</template>
