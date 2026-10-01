<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import Select from "primevue/select";
import InputNumber from "primevue/inputnumber";
import ToggleSwitch from "primevue/toggleswitch";
import Panel from "primevue/panel";
import { useExplain } from "@/composables/useExplain";

// Bespoke ECLS (ECMO) console, modelled on VentilatorPanel. Control writes go
// straight to engine props via setProp() — the Ecls model has no setter
// functions; calc_model() picks up changes each tick (it re-derives gas
// composition when gas_fio2/gas_fico2 change, and toggles its sub-circuit's
// is_enabled from ecls_running / ecls_clamped). Cannula pickers write the
// type string; calc_model() looks up resistance + geometry from the model's
// built-in cannula libraries.
//
// Live measured read-outs come off the ~1 Hz slow stream (watchSlow),
// re-registered on every (re)build since build() resets the DataCollector
// watchlist. so2 values are stored in percent and pco2 in mmHg on the model.
const { modelState, slowValues, setProp, watchSlow, modelReady } = useExplain();

interface Field {
  p: string; // model property
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  rounding: number;
  factor?: number; // display = raw × factor (e.g. fio2 fraction → %)
}

// Primary pump + sweep-gas settings. Pump speed's upper bound follows the
// selected pump (see maxOf).
const SETTINGS: Field[] = [
  { p: "pump_rpm", label: "Pump speed", unit: "RPM", min: 0, max: 5000, step: 50, rounding: 0 },
  { p: "gas_flow", label: "Sweep gas", unit: "L/min", min: 0, max: 10, step: 0.1, rounding: 1 },
  { p: "gas_fio2", label: "Sweep FiO₂", unit: "%", min: 21, max: 100, step: 1, rounding: 0, factor: 100 },
  { p: "gas_fico2", label: "Sweep FiCO₂", unit: "%", min: 0, max: 10, step: 0.01, rounding: 2, factor: 100 },
  { p: "gas_humidity", label: "Humidity", unit: "", min: 0, max: 1, step: 0.05, rounding: 2 },
  { p: "gas_temp", label: "Gas temp", unit: "°C", min: 0, max: 42, step: 0.5, rounding: 1 },
];

// Component resistance-factor multipliers (advanced tuning).
const RES_FACTORS: Field[] = [
  { p: "pump_res_factor", label: "Pump R×", unit: "", min: 0, max: 1000, step: 0.1, rounding: 1 },
  { p: "oxy_res_factor", label: "Oxy R×", unit: "", min: 0, max: 1000, step: 0.1, rounding: 1 },
  { p: "drainage_res_factor", label: "Drain R×", unit: "", min: 0, max: 1000, step: 0.1, rounding: 1 },
  { p: "return_res_factor", label: "Return R×", unit: "", min: 0, max: 1000, step: 0.1, rounding: 1 },
  { p: "tubing_res_factor", label: "Tubing R×", unit: "", min: 0, max: 1000, step: 0.1, rounding: 1 },
];

const running = ref(false);
const clamped = ref(false);
// Pump device from the engine's library (Ecls.pumps). Selecting one sets
// pump_type; the engine then copies its H-Q / roller coefficients and sets
// pump_mode from its type, so the mode is not set separately here.
const pumpType = ref<string | null>(null);
const pumps = ref<Record<string, { type?: string; max_rpm?: number; prime?: number }>>({});
const pumpOptions = computed(() => Object.keys(pumps.value));
const selectedPump = computed(() => (pumpType.value ? pumps.value[pumpType.value] : undefined));
// Oxygenator from the engine's library (Ecls.oxygenators). Selecting one sets
// oxygenator_type; the engine copies its O2/CO2 transfer ceilings into the gas
// exchanger. Rated flow and surface area are informational.
const oxygenatorType = ref<string | null>(null);
const oxygenators = ref<
  Record<string, { rated_flow?: number; surface_area?: number; prime?: number }>
>({});
const oxygenatorOptions = computed(() => Object.keys(oxygenators.value));
const selectedOxygenator = computed(() =>
  oxygenatorType.value ? oxygenators.value[oxygenatorType.value] : undefined,
);
// circuit flow above the oxygenator's rating: transfer is capped, so warn
const overRated = computed(() => {
  const rated = selectedOxygenator.value?.rated_flow;
  const flow = latest.value["Ecls.flow_avg"];
  return rated != null && Number.isFinite(flow) && flow > rated;
});
function maxOf(f: Field): number {
  return f.p === "pump_rpm" ? (selectedPump.value?.max_rpm ?? f.max) : f.max;
}
const drainageCannula = ref<string | null>(null);
const returnCannula = ref<string | null>(null);
const drainageOptions = ref<string[]>([]);
const returnOptions = ref<string[]>([]);
const drainageSite = ref<string | null>(null);
const returnSite = ref<string | null>(null);

// Blood-compartment instances the drainage/return cannulas can connect to.
// The engine applies these live each tick (ECLS_DRAINAGE.comp_from / ECLS_RETURN.comp_to).
const SITE_MODEL_TYPES = new Set([
  "BloodCapacitance",
  "BloodTimeVaryingElastance",
  "BloodVessel",
  "HeartChamber",
]);
const siteOptions = computed<string[]>(() => {
  const models = (modelState.value as any)?.models ?? {};
  return Object.keys(models)
    .filter((name) => SITE_MODEL_TYPES.has(models[name]?.model_type))
    .sort();
});
// editable display values keyed by field/knob prop
const vals = ref<Record<string, number>>({});

const SLOW_PATHS = [
  "Ecls.flow_avg",
  "Ecls.flow",
  "Ecls.pump_pressure",
  "Ecls.p_ven",
  "Ecls.p_int",
  "Ecls.p_art",
  "Ecls.sat_ven_o2",
  "Ecls.sat_postoxy_o2",
  "Ecls.pco2_postoxy",
];

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
    { label: "Flow", value: fmt(l["Ecls.flow_avg"], 2), unit: "L/min" },
    { label: "Flow inst", value: fmt(l["Ecls.flow"], 2), unit: "L/min" },
    { label: "Pump P", value: fmt(l["Ecls.pump_pressure"], 0), unit: "mmHg" },
    { label: "P venous", value: fmt(l["Ecls.p_ven"], 0), unit: "mmHg" },
    { label: "P internal", value: fmt(l["Ecls.p_int"], 0), unit: "mmHg" },
    { label: "P arterial", value: fmt(l["Ecls.p_art"], 0), unit: "mmHg" },
    { label: "SvO₂", value: fmt(l["Ecls.sat_ven_o2"], 0), unit: "%" },
    { label: "post-oxy SO₂", value: fmt(l["Ecls.sat_postoxy_o2"], 0), unit: "%" },
    { label: "post-oxy pCO₂", value: fmt(l["Ecls.pco2_postoxy"], 0), unit: "mmHg" },
  ];
});

// pull a fresh editable snapshot from engine state (mount / rebuild / refresh)
function syncLocal() {
  const e = (modelState.value as any)?.models?.Ecls;
  if (!e) return;
  running.value = !!e.ecls_running;
  clamped.value = !!e.ecls_clamped;
  pumpType.value = e.pump_type ?? null;
  pumps.value = e.pumps && typeof e.pumps === "object" ? e.pumps : {};
  oxygenatorType.value = e.oxygenator_type ?? null;
  oxygenators.value = e.oxygenators && typeof e.oxygenators === "object" ? e.oxygenators : {};
  drainageCannula.value = e.drainage_cannula_type ?? null;
  returnCannula.value = e.return_cannula_type ?? null;
  drainageSite.value = e.drainage_site ?? null;
  returnSite.value = e.return_site ?? null;
  drainageOptions.value = e.drainage_cannulas ? Object.keys(e.drainage_cannulas) : [];
  returnOptions.value = e.return_cannulas ? Object.keys(e.return_cannulas) : [];
  for (const f of [...SETTINGS, ...RES_FACTORS]) {
    const raw = e[f.p];
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
  setProp(`Ecls.${f.p}`, v / (f.factor ?? 1), 0);
}
function onOxygenatorType(v: string) {
  if (!v) return;
  oxygenatorType.value = v;
  setProp("Ecls.oxygenator_type", v, 0);
}
function onRunning(v: boolean) {
  running.value = v;
  setProp("Ecls.ecls_running", v, 0);
}
function onClamp(v: boolean) {
  clamped.value = v;
  setProp("Ecls.ecls_clamped", v, 0);
}
function onPumpType(v: string) {
  if (!v) return;
  pumpType.value = v;
  setProp("Ecls.pump_type", v, 0);
  // The engine doesn't clamp speed to the pump's range: a roller pump (max
  // ~250 rpm) left at a centrifugal 1500 rpm would run far too fast. Bring the
  // speed down to the new pump's maximum when it is above it.
  const max = pumps.value[v]?.max_rpm;
  const rpm = vals.value.pump_rpm;
  if (max != null && rpm != null && rpm > max) {
    vals.value.pump_rpm = max;
    setProp("Ecls.pump_rpm", max, 0);
  }
}
function onDrainageCannula(v: string) {
  drainageCannula.value = v;
  setProp("Ecls.drainage_cannula_type", v, 0);
}
function onReturnCannula(v: string) {
  returnCannula.value = v;
  setProp("Ecls.return_cannula_type", v, 0);
}
function onDrainageSite(v: string) {
  drainageSite.value = v;
  setProp("Ecls.drainage_site", v, 0);
}
function onReturnSite(v: string) {
  returnSite.value = v;
  setProp("Ecls.return_site", v, 0);
}
</script>

<template>
  <Panel toggleable data-tour="ecls.panel">
    <template #header>
      <div class="flex items-center gap-2 w-full">
        <span class="font-semibold">ECLS</span>
        <!-- ecls.on only exists while running: the manual waits on it -->
        <span
          :data-tour="running ? 'ecls.on' : undefined"
          class="text-xs px-1.5 py-0.5 rounded"
          :class="running ? 'bg-green-600/20 text-green-500' : 'bg-zinc-500/20 opacity-60'"
        >
          {{ running ? "● on" : "off" }}
        </span>
        <ToggleSwitch
          class="ml-auto"
          data-tour="ecls.switch"
          :model-value="running"
          @update:model-value="onRunning"
        />
      </div>
    </template>

    <div class="flex flex-col gap-3" :class="{ 'opacity-40 pointer-events-none': !running }">
      <!-- pump mode + clamp -->
      <div class="flex items-center justify-between gap-2" data-tour="ecls.pump">
        <label class="text-sm opacity-80">Pump</label>
        <div class="flex min-w-0 flex-col items-end gap-0.5">
          <Select
            :model-value="pumpType"
            :options="pumpOptions"
            size="small"
            class="w-52"
            placeholder="Select pump"
            @update:model-value="onPumpType"
          />
          <span v-if="selectedPump" class="text-xs opacity-60">
            {{ selectedPump.type }}<template v-if="selectedPump.max_rpm"> · max {{ selectedPump.max_rpm }} RPM</template><template v-if="selectedPump.prime"> · prime {{ Math.round(selectedPump.prime * 1000) }} mL</template>
          </span>
        </div>
      </div>
      <div class="flex items-center justify-between gap-2">
        <label class="text-sm opacity-80">Oxygenator</label>
        <div class="flex min-w-0 flex-col items-end gap-0.5">
          <Select
            :model-value="oxygenatorType"
            :options="oxygenatorOptions"
            size="small"
            class="w-52"
            placeholder="Select oxygenator"
            @update:model-value="onOxygenatorType"
          />
          <span v-if="selectedOxygenator" class="text-xs opacity-60">
            <template v-if="selectedOxygenator.rated_flow">rated {{ selectedOxygenator.rated_flow }} L/min</template><template v-if="selectedOxygenator.surface_area"> · {{ selectedOxygenator.surface_area }} m²</template><template v-if="selectedOxygenator.prime"> · prime {{ Math.round(selectedOxygenator.prime * 1000) }} mL</template>
          </span>
          <span v-if="overRated" class="text-xs text-amber-400">
            flow above the rated flow: gas transfer is capped
          </span>
        </div>
      </div>
      <label class="text-sm flex items-center justify-between gap-2" data-tour="ecls.clamp">
        <span class="opacity-80">Clamped</span>
        <ToggleSwitch :model-value="clamped" @update:model-value="onClamp" />
      </label>

      <!-- pump + sweep-gas settings -->
      <div class="grid grid-cols-2 gap-x-3 gap-y-2" data-tour="ecls.settings">
        <div v-for="f in SETTINGS" :key="f.p" class="flex flex-col gap-0.5">
          <span class="text-xs opacity-70">{{ f.label }} <span class="opacity-50">{{ f.unit }}</span></span>
          <InputNumber
            :model-value="vals[f.p]"
            :min="f.min"
            :max="maxOf(f)"
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

      <!-- cannulas + sites -->
      <div class="grid grid-cols-1 gap-2 border-t border-surface-700 pt-2" data-tour="ecls.cannulas">
        <div class="flex flex-col gap-0.5">
          <span class="text-xs opacity-70">Drainage cannula</span>
          <Select
            :model-value="drainageCannula"
            :options="drainageOptions"
            size="small"
            class="w-full"
            placeholder="Select cannula"
            @update:model-value="onDrainageCannula"
          />
        </div>
        <div class="flex flex-col gap-0.5">
          <span class="text-xs opacity-70">Drainage site</span>
          <Select
            :model-value="drainageSite"
            :options="siteOptions"
            size="small"
            class="w-full"
            placeholder="Select site"
            @update:model-value="onDrainageSite"
          />
        </div>
        <div class="flex flex-col gap-0.5">
          <span class="text-xs opacity-70">Return cannula</span>
          <Select
            :model-value="returnCannula"
            :options="returnOptions"
            size="small"
            class="w-full"
            placeholder="Select cannula"
            @update:model-value="onReturnCannula"
          />
        </div>
        <div class="flex flex-col gap-0.5">
          <span class="text-xs opacity-70">Return site</span>
          <Select
            :model-value="returnSite"
            :options="siteOptions"
            size="small"
            class="w-full"
            placeholder="Select site"
            @update:model-value="onReturnSite"
          />
        </div>
      </div>

      <!-- resistance-factor tuning -->
      <div class="border-t border-surface-700 pt-2" data-tour="ecls.resistances">
        <div class="text-xs opacity-60 mb-1">resistance factors</div>
        <div class="grid grid-cols-2 gap-x-3 gap-y-2">
          <div v-for="f in RES_FACTORS" :key="f.p" class="flex flex-col gap-0.5">
            <span class="text-xs opacity-70">{{ f.label }}</span>
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
      <div class="border-t border-surface-700 pt-2" data-tour="ecls.measured">
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
