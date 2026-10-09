<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import InputNumber from "primevue/inputnumber";
import ToggleSwitch from "primevue/toggleswitch";
import Panel from "primevue/panel";
import { useExplain } from "@/composables/useExplain";

// Bespoke CPR / resuscitation console, modelled on EclsPanel.
// Enable/disable goes through switch_cpr() (call()) — NOT a plain prop write —
// because switching CPR on also takes over the ventilator (switch_ventilator +
// set_pc using the vent_pres_* / vent_insp_time props) and suspends spontaneous
// breathing. FiO₂ MUST go through set_fio2() (call()) since that re-derives the
// ventilator's inspired-gas composition. All other settings are plain props the
// model's calc_model() picks up each tick, so they write straight through setProp().
//
// chest_comp_pres is the only live output; it oscillates rapidly (sine at the
// compression frequency) so the ~1 Hz slow sample is just an instantaneous peek.
const { modelState, slowValues, setProp, call, watchSlow, modelReady } =
  useExplain();

interface Field {
  p: string; // model property (or setter arg name)
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  rounding: number;
  factor?: number; // display = raw × factor (e.g. fio2 fraction → %)
  fn?: string; // setter function to call() instead of setProp()
  live?: string[]; // Ventilator props to mirror-write while CPR runs (apply live)
}

// Chest-compression settings.
const COMPRESSIONS: Field[] = [
  { p: "chest_comp_freq", label: "Rate", unit: "/min", min: 0, max: 200, step: 5, rounding: 0 },
  { p: "chest_comp_max_pres", label: "Force", unit: "mmHg", min: 0, max: 50, step: 1, rounding: 0 },
  { p: "chest_comp_no", label: "Comp count", unit: "", min: 1, max: 50, step: 1, rounding: 0 },
];

// Ventilation settings (apply on the next switch_cpr for pressures; rate/fio2 live).
const VENTILATIONS: Field[] = [
  { p: "vent_freq", label: "Rate", unit: "/min", min: 0, max: 100, step: 5, rounding: 0 },
  { p: "vent_no", label: "Breaths", unit: "", min: 1, max: 10, step: 1, rounding: 0 },
  { p: "vent_pres_pip", label: "PIP", unit: "cmH₂O", min: 5, max: 50, step: 1, rounding: 0, live: ["pip_cmh2o", "pip_cmh2o_max"] },
  { p: "vent_pres_peep", label: "PEEP", unit: "cmH₂O", min: 0, max: 20, step: 1, rounding: 0, live: ["peep_cmh2o"] },
  { p: "vent_insp_time", label: "Tinsp", unit: "s", min: 0.1, max: 2, step: 0.05, rounding: 2, live: ["insp_time"] },
  { p: "vent_fio2", label: "FiO₂", unit: "%", min: 21, max: 100, step: 1, rounding: 0, factor: 100, fn: "set_fio2" },
];

const enabled = ref(false);
const continuous = ref(false);
// editable display values keyed by field prop
const vals = ref<Record<string, number>>({});

// compression : ventilation ratio shown in the header (e.g. 15:2)
const ratio = computed(
  () => `${vals.value["chest_comp_no"] ?? 0}:${vals.value["vent_no"] ?? 0}`
);

const SLOW_PATHS = ["Resuscitation.chest_comp_pres"];

const latest = computed<Record<string, number>>(() => {
  const arr = slowValues.value as any[];
  return Array.isArray(arr) && arr.length ? arr[arr.length - 1] : {};
});

function fmt(v: number | undefined, digits: number): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toFixed(digits);
}

const measured = computed(() => {
  const l = latest.value;
  return [
    { label: "Comp pressure", value: fmt(l["Resuscitation.chest_comp_pres"], 1), unit: "mmHg" },
  ];
});

// pull a fresh editable snapshot from engine state (mount / rebuild / refresh)
function syncLocal() {
  const r = (modelState.value as any)?.models?.Resuscitation;
  if (!r) return;
  enabled.value = !!r.cpr_enabled;
  continuous.value = !!r.chest_comp_cont;
  for (const f of [...COMPRESSIONS, ...VENTILATIONS]) {
    const raw = r[f.p];
    if (typeof raw !== "number") continue;
    vals.value[f.p] = raw * (f.factor ?? 1);
  }
}

watch(modelState, syncLocal);
// build() resets the DataCollector watchlist — re-register on every (re)build
watch(modelReady, (ready) => {
  if (ready) watchSlow(SLOW_PATHS);
});

onMounted(() => {
  watchSlow(SLOW_PATHS);
  syncLocal();
});

function onField(f: Field, v: number | null) {
  if (v == null) return;
  vals.value[f.p] = v;
  const raw = v / (f.factor ?? 1);
  if (f.fn) {
    call(`Resuscitation.${f.fn}`, [raw], 0); // set_fio2 takes a fraction
  } else {
    setProp(`Resuscitation.${f.p}`, raw, 0);
  }
  // The PIP/PEEP/Tinsp props are only pushed to the ventilator inside
  // switch_cpr() (via set_pc). Mirror them onto the live ventilator props so
  // edits take effect immediately while CPR runs — the Resuscitation prop write
  // above keeps a later re-toggle consistent.
  if (f.live && enabled.value) {
    for (const vp of f.live) setProp(`Ventilator.${vp}`, raw, 0);
  }
}
function onEnable(v: boolean) {
  enabled.value = v;
  call("Resuscitation.switch_cpr", [v], 0);
}
function onContinuous(v: boolean) {
  continuous.value = v;
  setProp("Resuscitation.chest_comp_cont", v, 0);
}
</script>

<template>
  <Panel toggleable>
    <template #header>
      <div class="flex items-center gap-2 w-full">
        <span class="font-semibold">Resuscitation</span>
        <span
          class="text-xs px-1.5 py-0.5 rounded"
          :class="enabled ? 'bg-red-600/20 text-red-500' : 'bg-zinc-500/20 opacity-60'"
        >
          {{ enabled ? "● CPR" : "off" }}
        </span>
        <ToggleSwitch
          class="ml-auto"
          :model-value="enabled"
          @update:model-value="onEnable"
        />
      </div>
    </template>

    <div class="flex flex-col gap-3" :class="{ 'opacity-40 pointer-events-none': !enabled }">
      <!-- compression mode -->
      <div class="flex items-center justify-between gap-2">
        <label class="text-sm opacity-80 flex items-center gap-2">
          Continuous
          <ToggleSwitch :model-value="continuous" @update:model-value="onContinuous" />
        </label>
        <span class="text-xs opacity-70">
          ratio <span class="tabular-nums text-sm opacity-100">{{ ratio }}</span>
        </span>
      </div>

      <!-- compression settings -->
      <div class="border-t border-surface-700 pt-2">
        <div class="text-xs opacity-60 mb-1">compressions</div>
        <div class="grid grid-cols-2 gap-x-3 gap-y-2">
          <div v-for="f in COMPRESSIONS" :key="f.p" class="flex flex-col gap-0.5">
            <span class="text-xs opacity-70">{{ f.label }} <span class="opacity-50">{{ f.unit }}</span></span>
            <InputNumber
              :model-value="vals[f.p]"
              :min="f.min"
              :max="f.max"
              :step="f.step"
              :max-fraction-digits="f.rounding"
              show-buttons
              button-layout="horizontal"
              size="small"
              class="w-full"
              :input-class="'w-full text-center'"
              @update:model-value="(v: number) => onField(f, v)"
            >
              <template #incrementbuttonicon><i class="pi pi-plus" /></template>
              <template #decrementbuttonicon><i class="pi pi-minus" /></template>
            </InputNumber>
          </div>
        </div>
      </div>

      <!-- ventilation settings -->
      <div class="border-t border-surface-700 pt-2">
        <div class="text-xs opacity-60 mb-1">ventilations</div>
        <div class="grid grid-cols-2 gap-x-3 gap-y-2">
          <div v-for="f in VENTILATIONS" :key="f.p" class="flex flex-col gap-0.5">
            <span class="text-xs opacity-70">{{ f.label }} <span class="opacity-50">{{ f.unit }}</span></span>
            <InputNumber
              :model-value="vals[f.p]"
              :min="f.min"
              :max="f.max"
              :step="f.step"
              :max-fraction-digits="f.rounding"
              show-buttons
              button-layout="horizontal"
              size="small"
              class="w-full"
              :input-class="'w-full text-center'"
              @update:model-value="(v: number) => onField(f, v)"
            >
              <template #incrementbuttonicon><i class="pi pi-plus" /></template>
              <template #decrementbuttonicon><i class="pi pi-minus" /></template>
            </InputNumber>
          </div>
        </div>
      </div>

      <!-- measured read-outs (slow stream) -->
      <div class="border-t border-surface-700 pt-2">
        <div class="text-xs opacity-60 mb-1">measured</div>
        <div class="grid grid-cols-3 gap-x-3 gap-y-2">
          <div v-for="m in measured" :key="m.label" class="flex flex-col">
            <span class="text-xs opacity-60">{{ m.label }}</span>
            <span class="text-sm tabular-nums">
              {{ m.value }}
              <span class="text-xs opacity-50">{{ m.unit }}</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  </Panel>
</template>
