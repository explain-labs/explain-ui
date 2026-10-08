<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, computed, watch } from "vue";
import Select from "primevue/select";
import { useRealtimeBus } from "@/composables/useRealtimeBus";
import { useExplain } from "@/composables/useExplain";
import { MonitorRenderer, type MonitorLane } from "@/render/MonitorRenderer";

// Ventilator graphics — the pressure / flow / volume scalars drawn as three
// swept waveform lanes, exactly like the patient Monitor but fed from the
// Ventilator model's own per-step read-outs. Reuses MonitorRenderer: waveforms
// come off the fast chart stream (watchProps, never Vue-reactive); the gutter
// numerics come off the 1 Hz slow stream (watchSlow → setNumerics).
const el = ref<HTMLDivElement | null>(null);
const { addRenderer, removeRenderer } = useRealtimeBus();
const { watch: watchProps, watchSlow, slowValues, modelReady } = useExplain();
// HFOV has no peak/PEEP: the pressure numeric shows MAP / ΔP instead. The mode comes off the slow
// stream with the numerics (modelState only refreshes on a rebuild, not on a live mode change).
const hfov = (n: Record<string, unknown>) => n["Ventilator.vent_mode"] === "HFOV";
let adapter: MonitorRenderer | null = null;

const props = withDefaults(
  defineProps<{
    height?: string; // CSS height of the sweep canvas
    minHeight?: string;
  }>(),
  { height: "70vh", minHeight: "480px" },
);

// format a slow-stream value, "—" when absent
const f = (n: Record<string, number>, p: string, d: number, scale = 1) => {
  const v = n[p];
  return typeof v === "number" && Number.isFinite(v) ? (v * scale).toFixed(d) : "—";
};

const LANES: MonitorLane[] = [
  {
    signal: "Ventilator.pres",
    label: "Paw",
    color: "#facc15",
    unit: "cmH₂O",
    // measured peak (not the PIP setting: PS delivers PEEP + PS, PRVC/VC servo their own peak);
    // in HFOV the measured mean airway pressure and peak-to-peak swing
    readNumeric: (n) =>
      hfov(n)
        ? `${f(n, "Ventilator.hfo_map_meas", 0)}/${f(n, "Ventilator.hfo_amplitude_meas", 0)}`
        : `${f(n, "Ventilator.p_peak", 0)}/${f(n, "Ventilator.peep_cmh2o", 0)}`,
    readSub: (n) => (hfov(n) ? "MAP/ΔP" : ""),
  },
  {
    signal: "Ventilator.flow",
    label: "Flow",
    color: "#22d3ee",
    unit: "L/min",
    // minute ventilation lives next to the flow trace on most bedside vents
    readNumeric: (n) => f(n, "Ventilator.minute_volume", 2),
    readSub: () => "MV",
  },
  {
    signal: "Ventilator.vol",
    label: "Volume",
    color: "#4ade80",
    unit: "mL",
    fill: true,
    // expiratory tidal volume (L → mL)
    readNumeric: (n) => f(n, "Ventilator.exp_tidal_volume", hfov(n) ? 2 : 1, 1000),
    readSub: () => "Vt",
  },
];

const FAST_PATHS = LANES.map((l) => l.signal);
const SLOW_PATHS = [
  "Ventilator.p_peak",
  "Ventilator.peep_cmh2o",
  "Ventilator.minute_volume",
  "Ventilator.exp_tidal_volume",
  "Ventilator.hfo_map_meas",
  "Ventilator.hfo_amplitude_meas",
  "Ventilator.vent_mode",
];

// sweep window (full left→right travel time) — vent graphs run slower than the
// ECG sweep, so default a touch wider.
const WINDOW_OPTIONS = [
  { label: "1 s", value: 1 }, // HFOV oscillation
  { label: "3 s", value: 3 },
  { label: "6 s", value: 6 },
  { label: "8 s", value: 8 },
  { label: "12 s", value: 12 },
  { label: "16 s", value: 16 },
];
const windowS = ref(8);

const latest = computed<Record<string, number>>(() => {
  const arr = slowValues.value as any[];
  return Array.isArray(arr) && arr.length ? arr[arr.length - 1] : {};
});

watch(windowS, (v) => adapter?.setWindow(v));
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
    <div class="flex items-center justify-end gap-1.5 text-xs">
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
      :style="{ height: props.height, minHeight: props.minHeight, background: '#0a0e14' }"
    ></div>
  </div>
</template>
