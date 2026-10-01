<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, computed, watch, nextTick } from "vue";
import Select from "primevue/select";
import ToggleButton from "primevue/togglebutton";
import InputText from "primevue/inputtext";
import InputNumber from "primevue/inputnumber";
import Button from "primevue/button";
import { useRealtimeBus } from "@/composables/useRealtimeBus";
import { useExplain } from "@/composables/useExplain";
import { useChartParams } from "@/composables/useChartParams";
import { ChartRenderer } from "@/render/ChartRenderer";
import { seriesToCsv, downloadText } from "@/utils/csv";

// Realtime chart host. The user picks up to two series, each as a model then a
// parameter of that model. Picks are added to the shared fast watchlist
// (additive — never clear it, the PV loop and ECG live there too) and the
// renderer is told which channels to draw. Series A is red, series B is blue.
//
// Two view options:
//  - Shared axis: both series on one y-axis (compare same-unit params).
//  - Split: series A and B in two separate stacked charts.
const elTop = ref<HTMLDivElement | null>(null);
const elBottom = ref<HTMLDivElement | null>(null);
const { addRenderer, removeRenderer } = useRealtimeBus();
const { watch: watchProps } = useExplain();
const { modelNames, numericProps, pathToSel, presetNames, presets, savePreset, deletePreset } =
  useChartParams("RealTimeCharts");
let adapterTop: ChartRenderer | null = null;
let adapterBottom: ChartRenderer | null = null;

const SERIES_COLORS = ["#f87171", "#60a5fa"]; // must match ChartRenderer COLORS order

const modelA = ref<string | null>(null);
const propA = ref<string | null>(null);
const modelB = ref<string | null>(null);
const propB = ref<string | null>(null);

const propsA = computed(() => numericProps(modelA.value));
const propsB = computed(() => numericProps(modelB.value));

// drop a parameter that no longer belongs to the chosen model
watch(modelA, () => {
  if (propA.value && !propsA.value.includes(propA.value)) propA.value = null;
});
watch(modelB, () => {
  if (propB.value && !propsB.value.includes(propB.value)) propB.value = null;
});

const pathA = computed(() => (modelA.value && propA.value ? `${modelA.value}.${propA.value}` : null));
const pathB = computed(() => (modelB.value && propB.value ? `${modelB.value}.${propB.value}` : null));

// view options
const split = ref(false); // two separate charts
const sharedAxis = ref(false); // single shared y-axis (ignored when split)
const fill = ref(false); // translucent area fill under each trace (Doppler-like)

// fill is held in the renderer and re-applied on every rebuild, so it survives
// series/view changes; just push the flag to both charts when it toggles.
watch(fill, (v) => {
  adapterTop?.setFill(v);
  adapterBottom?.setFill(v);
});

// presets (configuration.presets.RealTimeCharts + session-saved). Selecting one
// fills the A/B selectors with its first two paths; from there it behaves like a
// manual selection.
const preset = ref<string | null>(null);
const newPresetName = ref("");
const canSavePreset = computed(() => !!newPresetName.value.trim() && !!(pathA.value || pathB.value));
function onSavePreset() {
  savePreset(newPresetName.value, [pathA.value, pathB.value].filter(Boolean) as string[]);
  newPresetName.value = "";
}
function onDeletePreset(name: string) {
  if (window.confirm(`Delete preset "${name}"?`)) deletePreset(name);
}

// load a preset into the manual selectors (one-shot action). A preset may also
// ship view options — `fill` and a fixed y-scale (`autoscale:false` + yMin/yMax)
// — which are applied after the path watchers have rebuilt the renderer(s).
watch(preset, async (name) => {
  if (!name) return;
  const p = presets.value[name];
  const paths: string[] = Array.isArray(p?.paths) ? p.paths : [];
  [modelA.value, propA.value] = pathToSel(paths[0]);
  [modelB.value, propB.value] = pathToSel(paths[1]); // only two allowed
  // more than one parameter → default to a dual y-axis (single overlaid chart)
  if (paths[1]) {
    split.value = false;
    sharedAxis.value = false;
  }
  preset.value = null; // selectors now drive the chart

  // let the [pathA, pathB, …] watcher run applyView() (which rebuilds the
  // renderers and resets autoY) before we layer the preset's view options on.
  await nextTick();
  if (typeof p?.fill === "boolean") fill.value = p.fill;
  if (p?.autoscale === false && typeof p?.yMin === "number" && typeof p?.yMax === "number") {
    autoY.value = false; // reflect the lock in the UI (reveals the min/max inputs)
    await nextTick(); // onAutoYChange snapshots a range; override it with the preset's
    const roles: ("top" | "bottom")[] = split.value ? ["top", "bottom"] : ["top"];
    for (const role of roles) adapterFor(role)?.applyFixedYRange(p.yMin, p.yMax);
    refreshYAxes();
  } else if (p?.autoscale === true) {
    autoY.value = true;
  }
});

// minimal custom legend (uPlot's own legend is disabled). Top chart carries
// both series unless split, in which case A is on top and B on the bottom.
const legendTop = computed(() => {
  const items: { label: string; color: string }[] = [];
  if (pathA.value) items.push({ label: pathA.value, color: SERIES_COLORS[0] });
  if (!split.value && pathB.value) items.push({ label: pathB.value, color: SERIES_COLORS[1] });
  return items;
});
const legendBottom = computed(() =>
  split.value && pathB.value ? [{ label: pathB.value, color: SERIES_COLORS[1] }] : [],
);

// Y-axis autoscaling. On by default; switching it off locks each y-axis to the
// range it currently shows (snapshotted in the renderer) and reveals min/max
// inputs so the user can dial in the scale. `yAxes` mirrors the renderer's
// editable axes for the controls — `role` (not the renderer object) is stored
// so the array stays plain/reactive.
type YAxisCtl = { role: "top" | "bottom"; key: string; label: string; color: string; min: number; max: number };
const autoY = ref(true);
const yAxes = ref<YAxisCtl[]>([]);

function adapterFor(role: "top" | "bottom") {
  return role === "top" ? adapterTop : adapterBottom;
}

// pull the current editable axes off the active renderer(s) into reactive state
function refreshYAxes() {
  const list: YAxisCtl[] = [];
  const add = (role: "top" | "bottom") => {
    for (const ax of adapterFor(role)?.getYAxes() ?? []) list.push({ role, ...ax });
  };
  add("top");
  if (split.value) add("bottom");
  yAxes.value = list;
}

function onAutoYChange(on: boolean) {
  const roles: ("top" | "bottom")[] = split.value ? ["top", "bottom"] : ["top"];
  for (const role of roles) adapterFor(role)?.setAutoScaleY(on);
  if (on) yAxes.value = [];
  else refreshYAxes();
}
watch(autoY, onAutoYChange);

function onRangeEdit(ax: YAxisCtl) {
  adapterFor(ax.role)?.setYRange(ax.key, ax.min, ax.max);
}

// rolling time window shown on the x-axis (seconds)
const WINDOW_OPTIONS = [
  { label: "1 s", value: 1 },
  { label: "3 s", value: 3 },
  { label: "5 s", value: 5 },
  { label: "10 s", value: 10 },
  { label: "30 s", value: 30 },
  { label: "60 s", value: 60 },
];
const windowS = ref(3);

// route series to the renderer(s) per the current view
function applyView() {
  const a = pathA.value;
  const b = pathB.value;
  const paths = [a, b].filter(Boolean) as string[];
  if (paths.length) watchProps(paths); // ensure they're sampled (additive)

  if (split.value) {
    // one series per chart, each on its own axis
    adapterTop?.setSharedAxis(false);
    adapterTop?.setVisible(a ? [a] : []);
    adapterBottom?.setSharedAxis(false);
    adapterBottom?.setVisible(b ? [b] : []);
  } else {
    adapterTop?.setSharedAxis(sharedAxis.value);
    adapterTop?.setVisible(paths);
    adapterBottom?.setVisible([]); // hidden, draw nothing
  }
}
watch([pathA, pathB, split, sharedAxis], () => {
  applyView();
  // a different view/series invalidates any locked ranges → back to autoscale
  if (autoY.value) yAxes.value = [];
  else autoY.value = true; // triggers onAutoYChange → renderers back to auto
});
watch(windowS, (v) => {
  adapterTop?.setWindow(v);
  adapterBottom?.setWindow(v);
});

// export the currently buffered window (rolling, ~windowS seconds) to CSV
const canDownload = computed(() => !!(pathA.value || pathB.value));
function onDownload() {
  if (!adapterTop) return;
  const top = adapterTop.getSeries();
  let { time } = top;
  let labels = [...top.labels];
  let cols = [...top.cols];
  if (split.value && adapterBottom) {
    const bot = adapterBottom.getSeries(); // shares the same time base
    labels = [...labels, ...bot.labels];
    cols = [...cols, ...bot.cols];
    if (bot.time.length > time.length) time = bot.time;
  }
  if (!labels.length || !time.length) return;
  downloadText("realtime_chart.csv", seriesToCsv(time, labels, cols));
}

onMounted(() => {
  adapterTop = new ChartRenderer(elTop.value!);
  adapterTop.setWindow(windowS.value);
  addRenderer(adapterTop);

  adapterBottom = new ChartRenderer(elBottom.value!);
  adapterBottom.setWindow(windowS.value);
  adapterBottom.setColorOffset(1); // split: series B → blue
  addRenderer(adapterBottom);

  // sensible default: aortic pressure on series A if the model has it
  if (modelNames.value.includes("AA") && numericProps("AA").includes("pres")) {
    modelA.value = "AA";
    propA.value = "pres";
  }
  applyView();
});

onBeforeUnmount(() => {
  for (const a of [adapterTop, adapterBottom]) {
    if (a) {
      removeRenderer(a);
      a.dispose();
    }
  }
});
</script>

<template>
  <div class="flex flex-col gap-2">
    <div class="flex flex-col gap-0.5 text-xs" data-tour="chart.presets">
      <span class="opacity-60">preset</span>
      <div class="flex items-center gap-1.5">
        <Select
          v-if="presetNames.length"
          v-model="preset"
          :options="presetNames"
          placeholder="load preset…"
          size="small"
          class="w-44"
        >
          <template #option="{ option }">
            <div class="flex items-center justify-between w-full gap-2">
              <span class="truncate">{{ option }}</span>
              <i
                class="pi pi-trash text-xs opacity-50 hover:opacity-100"
                @mousedown.stop.prevent
                @click.stop.prevent="onDeletePreset(option)"
              ></i>
            </div>
          </template>
        </Select>
        <InputText
          v-model="newPresetName"
          placeholder="new preset name"
          size="small"
          class="w-40"
          @keyup.enter="onSavePreset"
        />
        <Button
          v-tooltip.top="'Save current selection as a preset'"
          icon="pi pi-save"
          size="small"
          severity="secondary"
          :disabled="!canSavePreset"
          @click="onSavePreset"
        />
      </div>
    </div>

    <div class="flex items-center gap-1.5 flex-wrap text-xs" data-tour="chart.series">
      <Select v-model="modelA" :options="modelNames" filter show-clear placeholder="model" size="small" class="w-44" />
      <Select
        v-model="propA"
        :options="propsA"
        filter
        show-clear
        placeholder="parameter"
        size="small"
        class="w-44"
        :disabled="!modelA"
      />
      <span class="inline-block w-3 h-3 rounded-sm" :style="{ background: SERIES_COLORS[0] }"></span>
      <span class="mx-1 opacity-30">|</span>
      <Select v-model="modelB" :options="modelNames" filter show-clear placeholder="model" size="small" class="w-44" />
      <Select
        v-model="propB"
        :options="propsB"
        filter
        show-clear
        placeholder="parameter"
        size="small"
        class="w-44"
        :disabled="!modelB"
      />
      <span class="inline-block w-3 h-3 rounded-sm" :style="{ background: SERIES_COLORS[1] }"></span>
    </div>

    <div
      class="flex items-center justify-center gap-3 text-xs h-4"
      :class="{ invisible: !legendTop.length }"
    >
      <span v-for="it in legendTop" :key="it.label" class="flex items-center gap-1">
        <span class="inline-block w-3 rounded-sm" style="height: 3px" :style="{ background: it.color }"></span>
        {{ it.label }}
      </span>
    </div>
    <div
      ref="elTop"
      data-tour="chart.plot"
      class="rt-chart"
      :style="{ width: '100%', height: split ? '150px' : '240px' }"
    ></div>

    <div v-show="split" class="flex items-center justify-center gap-3 text-xs h-4">
      <span v-for="it in legendBottom" :key="it.label" class="flex items-center gap-1">
        <span class="inline-block w-3 rounded-sm" style="height: 3px" :style="{ background: it.color }"></span>
        {{ it.label }}
      </span>
    </div>
    <div v-show="split" ref="elBottom" class="rt-chart" style="width: 100%; height: 150px"></div>

    <div class="flex items-center justify-end gap-1.5 flex-wrap text-xs" data-tour="chart.view">
      <ToggleButton
        v-model="split"
        on-label="Split"
        off-label="Split"
        on-icon="pi pi-clone"
        off-icon="pi pi-clone"
        size="small"
      />
      <ToggleButton
        v-model="sharedAxis"
        on-label="Shared Y"
        off-label="Shared Y"
        size="small"
        :disabled="split"
      />
      <ToggleButton
        v-model="fill"
        on-label="Fill"
        off-label="Fill"
        on-icon="pi pi-chart-bar"
        off-icon="pi pi-chart-bar"
        size="small"
      />
      <ToggleButton
        v-model="autoY"
        on-label="Auto Y"
        off-label="Lock Y"
        on-icon="pi pi-arrows-v"
        off-icon="pi pi-lock"
        size="small"
        :disabled="!canDownload"
      />
      <!-- y-axis range editors, inline next to the lock toggle (only while locked) -->
      <template v-if="!autoY">
        <span
          v-for="ax in yAxes"
          :key="ax.role + ax.key"
          class="flex items-center gap-1"
        >
          <span class="inline-block w-3 rounded-sm" style="height: 3px" :style="{ background: ax.color }"></span>
          <InputNumber
            v-tooltip.top="`${ax.label} min`"
            :model-value="ax.min"
            :max-fraction-digits="4"
            size="small"
            input-class="!w-14 !px-1 text-center"
            @update:model-value="(v) => { ax.min = (v as number) ?? 0; onRangeEdit(ax); }"
          />
          <span class="opacity-40">–</span>
          <InputNumber
            v-tooltip.top="`${ax.label} max`"
            :model-value="ax.max"
            :max-fraction-digits="4"
            size="small"
            input-class="!w-14 !px-1 text-center"
            @update:model-value="(v) => { ax.max = (v as number) ?? 0; onRangeEdit(ax); }"
          />
        </span>
      </template>
      <span class="opacity-60 ml-2">window</span>
      <Select
        v-model="windowS"
        :options="WINDOW_OPTIONS"
        option-label="label"
        option-value="value"
        size="small"
        class="w-24"
      />
      <Button
        data-tour="chart.download"
        v-tooltip.top="'Download data (CSV)'"
        icon="pi pi-download"
        size="small"
        severity="secondary"
        :disabled="!canDownload"
        @click="onDownload"
      />
    </div>
  </div>
</template>
