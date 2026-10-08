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

// Mode-specific primary settings. Ranges cover neonates to adults.
const RATE: Field = { p: "vent_rate", label: "Rate", unit: "/min", min: 0, max: 120, step: 1, rounding: 0 };
const TINSP: Field = { p: "insp_time", label: "Tinsp", unit: "s", min: 0.1, max: 3, step: 0.05, rounding: 2 };
const TI_MAX: Field = { ...TINSP, label: "Ti max" };
const INSP_FLOW: Field = { p: "insp_flow", label: "Insp flow", unit: "L/min", min: 0, max: 120, step: 0.5, rounding: 1 };
const PIP: Field = { p: "pip_cmh2o", label: "PIP", unit: "cmH₂O", min: 5, max: 50, step: 1, rounding: 0 };
const PIP_MAX: Field = { p: "pip_cmh2o_max", label: "PIP max", unit: "cmH₂O", min: 5, max: 50, step: 1, rounding: 0 };
const P_LIMIT: Field = { ...PIP_MAX, label: "Pmax" }; // VC pop-off, VG pressure limit
const PS_LEVEL: Field = { p: "ps_cmh2o", label: "PS above PEEP", unit: "cmH₂O", min: 0, max: 40, step: 1, rounding: 0 };
const VT: Field = { p: "tidal_volume", label: "Vt target", unit: "mL", min: 1, max: 1000, step: 1, rounding: 0, factor: 1000 };
const TRIG_VOL: Field = { p: "trigger_volume_perc", label: "Trigger", unit: "%", min: 5, max: 20, step: 0.5, rounding: 1 };
// end-inspiratory hold (plateau → static compliance, resistance); the setter keeps it < Tinsp
const PAUSE: Field = { p: "insp_pause", label: "Pause", unit: "s", min: 0, max: 1, step: 0.05, rounding: 2, fn: "set_pause" };
const RISE: Field = { p: "rise_time", label: "Rise time", unit: "s", min: 0, max: 0.5, step: 0.05, rounding: 2 };

// HFOV
const HFO_MAP: Field = { p: "hfo_map_cmh2o", label: "MAP", unit: "cmH₂O", min: 3, max: 35, step: 1, rounding: 0 };
const HFO_AMP: Field = { p: "hfo_amplitude_cmh2o", label: "Amplitude", unit: "cmH₂O", min: 5, max: 80, step: 1, rounding: 0 };
const HFO_FREQ: Field = { p: "hfo_freq", label: "Frequency", unit: "Hz", min: 3, max: 15, step: 0.5, rounding: 1 };
const HFO_TI: Field = { p: "hfo_insp_fraction", label: "Ti", unit: "%", min: 20, max: 60, step: 1, rounding: 0, factor: 100 };
const HFO_BIAS: Field = { p: "hfo_bias_flow", label: "Bias flow", unit: "L/min", min: 2, max: 40, step: 1, rounding: 0 };

const MODE_FIELDS: Record<string, Field[]> = {
  PC: [PIP, RATE, TINSP, INSP_FLOW, RISE, PAUSE],
  PRVC: [PIP_MAX, VT, RATE, TINSP, INSP_FLOW, RISE, PAUSE],
  // VC: constant flow until the volume is in; Pmax is only the pop-off
  VC: [VT, RATE, TINSP, INSP_FLOW, P_LIMIT, PAUSE],
  // PS: support level above PEEP; rate and Tinsp are the apnea backup and Ti max.
  PS: [PS_LEVEL, RATE, TI_MAX, INSP_FLOW, TRIG_VOL, RISE],
  // Pure CPAP: a single continuous distending pressure (PEEP, from COMMON) plus the
  // bias/insp flow. No mandatory breaths — the patient breathes spontaneously on top.
  CPAP: [INSP_FLOW],
  HFOV: [HFO_MAP, HFO_AMP, HFO_FREQ, HFO_TI, HFO_BIAS],
};
// volume guarantee replaces the set pressure with a Vt target and a pressure limit
const VG_FIELDS: Record<string, Field[]> = {
  PC: [VT, P_LIMIT, RATE, TINSP, INSP_FLOW, RISE, PAUSE],
  PS: [VT, P_LIMIT, RATE, TI_MAX, INSP_FLOW, TRIG_VOL],
};

// ET-tube geometry (always available; go through setters) and the leak around it.
const TUBE: Field[] = [
  { p: "ettube_diameter", label: "ET ⌀", unit: "mm", min: 2, max: 9, step: 0.5, rounding: 1, fn: "set_ettube_diameter", type: "tube" },
  { p: "ettube_length", label: "ET length", unit: "mm", min: 50, max: 350, step: 5, rounding: 0, fn: "set_ettube_length", type: "tube" },
  // equivalent gap around an uncuffed tube: ~0.5–1.25 mm neonatal, 1–3 mm adult
  { p: "leak_size", label: "Leak gap", unit: "mm", min: 0, max: 4, step: 0.05, rounding: 2 },
];

const MODES = ["PC", "PRVC", "VC", "PS", "CPAP", "HFOV"];
const VG_MODES = ["PC", "PS"];

const enabled = ref(false);
const mode = ref("PRVC");
const synchronized = ref(false);
const volumeGuarantee = ref(false);
// editable display values keyed by field prop
const vals = ref<Record<string, number>>({});

// fields currently shown = mode primary + common; trigger %-only relevant when
// synchronized (PC/PRVC) — in PS it is already part of the mode fields.
const vgActive = computed(() => volumeGuarantee.value && VG_MODES.includes(mode.value));
const activeFields = computed<Field[]>(() => {
  const primary = vgActive.value ? VG_FIELDS[mode.value] : MODE_FIELDS[mode.value];
  // HFOV has no PEEP (MAP replaces it); FiO2 always applies
  const common = mode.value === "HFOV" ? COMMON.filter((f) => f.p !== "peep_cmh2o") : COMMON;
  const out = [...(primary ?? []), ...common];
  if (synchronized.value && ["PC", "PRVC", "VC"].includes(mode.value)) out.push(TRIG_VOL);
  return out;
});

const SLOW_PATHS = [
  "Ventilator.exp_tidal_volume",
  "Ventilator.minute_volume",
  "Ventilator.compliance",
  "Ventilator.compliance_static",
  "Ventilator.resistance",
  "Ventilator.p_peak",
  "Ventilator.p_plat",
  "Ventilator.etco2",
  "Ventilator.pip_delivered",
  "Ventilator.pressure_limited",
  "Ventilator.leak_perc",
  "Ventilator.hfo_tidal_volume",
  "Ventilator.hfo_dco2",
  "Ventilator.hfo_map_meas",
  "Ventilator.hfo_amplitude_meas",
];

const latest = computed<Record<string, number>>(() => {
  const arr = slowValues.value as any[];
  return Array.isArray(arr) && arr.length ? arr[arr.length - 1] : {};
});

function fmt(v: number | undefined, digits: number, scale = 1): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return (v * scale).toFixed(digits);
}

// mode-aware read-outs: only what the current mode actually measures
const measured = computed(() => {
  const l = latest.value;
  const v = (k: string) => l[`Ventilator.${k}`];
  if (mode.value === "HFOV") {
    return [
      { label: "Vt", value: fmt(v("hfo_tidal_volume"), 2, 1000), unit: "mL" },
      { label: "DCO₂", value: fmt(v("hfo_dco2"), 0), unit: "mL²/s" },
      { label: "MV", value: fmt(v("minute_volume"), 2), unit: "L/min" },
      { label: "MAP", value: fmt(v("hfo_map_meas"), 1), unit: "cmH₂O" },
      { label: "ΔP", value: fmt(v("hfo_amplitude_meas"), 0), unit: "cmH₂O" },
      ...(vals.value.leak_size > 0 ? [{ label: "Leak", value: fmt(v("leak_perc"), 0), unit: "%" }] : []),
    ];
  }
  const out = [
    { label: "Vt", value: fmt(v("exp_tidal_volume"), 1, 1000), unit: "mL" },
    { label: "MV", value: fmt(v("minute_volume"), 2), unit: "L/min" },
    { label: "Ppeak", value: fmt(v("p_peak"), 0), unit: "cmH₂O" },
    { label: "Cdyn", value: fmt(v("compliance"), 1), unit: "mL/cmH₂O" },
    { label: "etCO₂", value: fmt(v("etco2"), 0), unit: "mmHg" },
  ];
  // the working pressure of the volume-targeted modes
  if (mode.value === "PRVC" || vgActive.value) {
    out.push({ label: "Pinsp", value: fmt(v("pip_delivered"), 1), unit: "cmH₂O" });
  }
  // a plateau gives static compliance and airway resistance
  if (vals.value.insp_pause > 0 && ["PC", "PRVC", "VC"].includes(mode.value)) {
    out.push(
      { label: "Pplat", value: fmt(v("p_plat"), 0), unit: "cmH₂O" },
      { label: "Cstat", value: fmt(v("compliance_static"), 1), unit: "mL/cmH₂O" },
      { label: "Raw", value: fmt(v("resistance"), 0), unit: "cmH₂O/L/s" },
    );
  }
  if (vals.value.leak_size > 0) out.push({ label: "Leak", value: fmt(v("leak_perc"), 0), unit: "%" });
  return out;
});
// volume-targeted modes alarm when the pressure limit keeps Vt below target
const pressureLimited = computed(
  () => (mode.value === "PRVC" || vgActive.value) && (latest.value as Record<string, unknown>)["Ventilator.pressure_limited"] === true,
);

// pull a fresh editable snapshot from engine state (mount / rebuild / refresh)
function syncLocal() {
  const v = (modelState.value as any)?.models?.Ventilator;
  if (!v) return;
  enabled.value = !!v.is_enabled;
  mode.value = v.vent_mode ?? "PRVC";
  synchronized.value = !!v.synchronized;
  volumeGuarantee.value = !!v.volume_guarantee;
  const all = [...Object.values(MODE_FIELDS).flat(), ...Object.values(VG_FIELDS).flat(), ...COMMON, ...TUBE];
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
function onVolumeGuarantee(v: boolean) {
  volumeGuarantee.value = v;
  // the setter also restarts the working pressure from the set pressure
  call("Ventilator.set_volume_guarantee", [v], 0);
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
      <!-- six modes don't fit beside the label in the narrow column: label above, options share the width -->
      <div class="flex flex-col gap-1" data-tour="vent.mode">
        <label class="text-sm opacity-80">Mode</label>
        <SelectButton
          :model-value="mode"
          :options="MODES"
          :allow-empty="false"
          size="small"
          class="w-full flex"
          :pt="{ pcToggleButton: { root: { class: 'flex-1 min-w-0 !px-0.5 !text-xs' } } }"
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

      <!-- volume guarantee (PC / PS) -->
      <div
        v-if="VG_MODES.includes(mode)"
        class="flex items-center justify-between gap-2 border-t border-surface-700 pt-2"
        data-tour="vent.vg"
      >
        <label
          v-tooltip.top="'Servo the inspiratory pressure breath-to-breath to the Vt target, up to Pmax'"
          class="text-sm opacity-80 flex items-center gap-2"
        >
          Volume guarantee
          <ToggleSwitch :model-value="volumeGuarantee" @update:model-value="onVolumeGuarantee" />
        </label>
      </div>
      <div v-if="pressureLimited" class="text-xs text-red-400" data-tour="vent.plimit">
        Pmax reached — Vt below target
      </div>

      <!-- patient trigger + manual breath -->
      <div
        v-if="mode !== 'HFOV'"
        class="flex items-center justify-between gap-2 border-t border-surface-700 pt-2"
        data-tour="vent.trigger"
      >
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
