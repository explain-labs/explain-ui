<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import SelectButton from "primevue/selectbutton";
import InputNumber from "primevue/inputnumber";
import ToggleSwitch from "primevue/toggleswitch";
import Button from "primevue/button";
import Panel from "primevue/panel";
import { useExplain } from "@/composables/useExplain";

// Bespoke ventilator console. Mode-aware: the SelectButton picks the ventilation
// mode and only the settings relevant to that mode are shown. Control writes go
// through the engine's API — plain props via setProp(), but FiO2 and ET-tube
// geometry MUST go through their setter functions (call()) because those re-derive
// gas composition / tube-resistance coefficients. Enable/disable goes through
// switch_ventilator() so the gas-circuit sub-models toggle and the spontaneous
// MOUTH_DS path is blocked — setting is_enabled directly would not do that.
//
// Live measured read-outs come off the ~1 Hz slow stream (watchSlow), re-registered
// on every (re)build since build() resets the DataCollector watchlist.
const { modelState, slowValues, setProp, call, watchSlow, modelReady } =
  useExplain();

type FieldType = "number" | "fio2" | "tube";
interface Field {
  p: string; // model property (or setter arg name)
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  rounding: number;
  factor?: number; // display = raw × factor (e.g. tidal_volume L → mL)
  fn?: string; // setter function to call() instead of setProp()
  type?: FieldType;
}

// Settings shown for every mode.
const COMMON: Field[] = [
  { p: "peep_cmh2o", label: "PEEP", unit: "cmH₂O", min: 0, max: 20, step: 1, rounding: 0 },
  { p: "fio2", label: "FiO₂", unit: "%", min: 21, max: 100, step: 1, rounding: 0, type: "fio2", fn: "set_fio2" },
];

// Mode-specific primary settings.
const RATE: Field = { p: "vent_rate", label: "Rate", unit: "/min", min: 0, max: 100, step: 1, rounding: 0 };
const TINSP: Field = { p: "insp_time", label: "Tinsp", unit: "s", min: 0.1, max: 1.5, step: 0.05, rounding: 2 };
const INSP_FLOW: Field = { p: "insp_flow", label: "Insp flow", unit: "L/min", min: 0, max: 20, step: 0.5, rounding: 1 };
const PIP: Field = { p: "pip_cmh2o", label: "PIP", unit: "cmH₂O", min: 5, max: 50, step: 1, rounding: 0 };
const PIP_MAX: Field = { p: "pip_cmh2o_max", label: "PIP max", unit: "cmH₂O", min: 5, max: 50, step: 1, rounding: 0 };
const VT: Field = { p: "tidal_volume", label: "Vt target", unit: "mL", min: 1, max: 500, step: 1, rounding: 0, factor: 1000 };
const TRIG_VOL: Field = { p: "trigger_volume_perc", label: "Trigger", unit: "%", min: 5, max: 20, step: 0.5, rounding: 1 };

const MODE_FIELDS: Record<string, Field[]> = {
  PC: [PIP, RATE, TINSP, INSP_FLOW],
  PRVC: [PIP_MAX, VT, RATE, TINSP, INSP_FLOW],
  PS: [PIP, INSP_FLOW, TRIG_VOL],
  // Pure CPAP: a single continuous distending pressure (PEEP, from COMMON) plus the
  // bias/insp flow. No mandatory breaths — the patient breathes spontaneously on top.
  CPAP: [INSP_FLOW],
};

// ET-tube geometry (always available; go through setters).
const TUBE: Field[] = [
  { p: "ettube_diameter", label: "ET ⌀", unit: "mm", min: 2, max: 5, step: 0.5, rounding: 1, fn: "set_ettube_diameter", type: "tube" },
  { p: "ettube_length", label: "ET length", unit: "mm", min: 50, max: 200, step: 5, rounding: 0, fn: "set_ettube_length", type: "tube" },
];

const MODES = ["PC", "PRVC", "PS", "CPAP"];

const enabled = ref(false);
const mode = ref("PRVC");
const synchronized = ref(false);
// editable display values keyed by field prop
const vals = ref<Record<string, number>>({});

// fields currently shown = mode primary + common; trigger %-only relevant when
// synchronized (PC/PRVC) — in PS it is already part of the mode fields.
const activeFields = computed<Field[]>(() => {
  const out = [...(MODE_FIELDS[mode.value] ?? []), ...COMMON];
  if (synchronized.value && mode.value !== "PS" && mode.value !== "CPAP") out.push(TRIG_VOL);
  return out;
});

const SLOW_PATHS = [
  "Ventilator.exp_tidal_volume",
  "Ventilator.minute_volume",
  "Ventilator.compliance",
  "Ventilator.pip_cmh2o",
  "Ventilator.etco2",
];

const latest = computed<Record<string, number>>(() => {
  const arr = slowValues.value as any[];
  return Array.isArray(arr) && arr.length ? arr[arr.length - 1] : {};
});

function fmt(v: number | undefined, digits: number, scale = 1): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return (v * scale).toFixed(digits);
}

const measured = computed(() => {
  const l = latest.value;
  return [
    { label: "Vt", value: fmt(l["Ventilator.exp_tidal_volume"], 1, 1000), unit: "mL" },
    { label: "MV", value: fmt(l["Ventilator.minute_volume"], 2), unit: "L/min" },
    { label: "Cdyn", value: fmt(l["Ventilator.compliance"], 1), unit: "mL/cmH₂O" },
    { label: "PIP", value: fmt(l["Ventilator.pip_cmh2o"], 0), unit: "cmH₂O" },
    { label: "etCO₂", value: fmt(l["Ventilator.etco2"], 0), unit: "mmHg" },
  ];
});

// pull a fresh editable snapshot from engine state (mount / rebuild / refresh)
function syncLocal() {
  const v = (modelState.value as any)?.models?.Ventilator;
  if (!v) return;
  enabled.value = !!v.is_enabled;
  mode.value = v.vent_mode ?? "PRVC";
  synchronized.value = !!v.synchronized;
  const all = [...Object.values(MODE_FIELDS).flat(), ...COMMON, ...TUBE];
  for (const f of all) {
    const raw = v[f.p];
    if (typeof raw !== "number") continue;
    vals.value[f.p] = f.type === "fio2" ? raw * 100 : raw * (f.factor ?? 1);
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
  if (f.type === "fio2") {
    call(`Ventilator.${f.fn}`, [v / 100], 0); // setter takes a fraction
  } else if (f.fn) {
    call(`Ventilator.${f.fn}`, [v], 0); // ET-tube setters re-derive coefficients
  } else {
    setProp(`Ventilator.${f.p}`, v / (f.factor ?? 1), 0);
  }
}
function onEnable(v: boolean) {
  enabled.value = v;
  call("Ventilator.switch_ventilator", [v], 0);
}
function onMode(v: string) {
  if (!v) return; // SelectButton can emit null on re-click; ignore
  mode.value = v;
  setProp("Ventilator.vent_mode", v, 0);
}
function onSync(v: boolean) {
  synchronized.value = v;
  setProp("Ventilator.synchronized", v, 0);
}
function manualBreath() {
  call("Ventilator.trigger_breath", [], 0);
}
</script>

<template>
  <Panel toggleable data-tour="vent.panel">
    <template #header>
      <div class="flex items-center gap-2 w-full">
        <span class="font-semibold">Ventilator</span>
        <!-- vent.on only exists while enabled: the manual waits on it -->
        <span
          :data-tour="enabled ? 'vent.on' : undefined"
          class="text-xs px-1.5 py-0.5 rounded"
          :class="enabled ? 'bg-green-600/20 text-green-500' : 'bg-zinc-500/20 opacity-60'"
        >
          {{ enabled ? "● on" : "off" }}
        </span>
        <ToggleSwitch
          class="ml-auto"
          data-tour="vent.switch"
          :model-value="enabled"
          @update:model-value="onEnable"
        />
      </div>
    </template>

    <div class="flex flex-col gap-3" :class="{ 'opacity-40 pointer-events-none': !enabled }">
      <!-- mode -->
      <div class="flex items-center justify-between gap-2" data-tour="vent.mode">
        <label class="text-sm opacity-80">Mode</label>
        <SelectButton
          :model-value="mode"
          :options="MODES"
          :allow-empty="false"
          size="small"
          @update:model-value="onMode"
        />
      </div>

      <!-- mode-aware settings grid -->
      <div class="grid grid-cols-2 gap-x-3 gap-y-2" data-tour="vent.settings">
        <div
          v-for="f in activeFields"
          :key="f.p"
          class="flex flex-col gap-0.5"
        >
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

      <!-- ET tube -->
      <div class="grid grid-cols-2 gap-x-3 gap-y-2 border-t border-surface-700 pt-2" data-tour="vent.tube">
        <div v-for="f in TUBE" :key="f.p" class="flex flex-col gap-0.5">
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

      <!-- patient trigger + manual breath -->
      <div class="flex items-center justify-between gap-2 border-t border-surface-700 pt-2" data-tour="vent.trigger">
        <!-- PS is always patient-triggered (the engine runs triggering in PS whatever
             `synchronized` says), so the switch shows on and is locked there -->
        <label
          v-tooltip.top="mode === 'PS' ? 'Pressure support is always patient-triggered' : undefined"
          class="text-sm opacity-80 flex items-center gap-2"
        >
          Synchronized
          <ToggleSwitch
            :model-value="synchronized || mode === 'PS'"
            :disabled="mode === 'PS'"
            @update:model-value="onSync"
          />
          <span v-if="mode === 'PS'" class="text-xs opacity-60">always in PS</span>
        </label>
        <Button
          label="Manual breath"
          icon="pi pi-arrow-up"
          size="small"
          severity="secondary"
          @click="manualBreath"
        />
      </div>

      <!-- measured read-outs (slow stream) -->
      <div class="border-t border-surface-700 pt-2" data-tour="vent.measured">
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
