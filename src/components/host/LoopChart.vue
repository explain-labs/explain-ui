<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, computed, watch } from "vue";
import Select from "primevue/select";
import InputText from "primevue/inputtext";
import Button from "primevue/button";
import { useRealtimeBus } from "@/composables/useRealtimeBus";
import { useExplain } from "@/composables/useExplain";
import { useChartParams } from "@/composables/useChartParams";
import { LoopRenderer } from "@/render/LoopRenderer";
import { seriesToCsv, downloadText } from "@/utils/csv";

// X-Y "loop" host (e.g. pressure–volume loop). The user picks an x-axis and a
// y-axis parameter (each model → parameter). Picks are added to the shared fast
// watchlist (additive) and the renderer plots y against x. Presets work the
// same as the realtime chart (configuration.presets.LoopCharts): load fills the
// x/y selectors with the first two paths, plus save/delete.
const el = ref<HTMLDivElement | null>(null);
const { addRenderer, removeRenderer } = useRealtimeBus();
const { watch: watchProps } = useExplain();
const { modelNames, numericProps, pathToSel, presetNames, presets, savePreset, deletePreset } =
  useChartParams("LoopCharts");
let adapter: LoopRenderer | null = null;

const modelX = ref<string | null>(null);
const propX = ref<string | null>(null);
const modelY = ref<string | null>(null);
const propY = ref<string | null>(null);

const propsX = computed(() => numericProps(modelX.value));
const propsY = computed(() => numericProps(modelY.value));

watch(modelX, () => {
  if (propX.value && !propsX.value.includes(propX.value)) propX.value = null;
});
watch(modelY, () => {
  if (propY.value && !propsY.value.includes(propY.value)) propY.value = null;
});

const pathX = computed(() => (modelX.value && propX.value ? `${modelX.value}.${propX.value}` : null));
const pathY = computed(() => (modelY.value && propY.value ? `${modelY.value}.${propY.value}` : null));

// presets
const preset = ref<string | null>(null);
watch(preset, (name) => {
  if (!name) return;
  const p = presets.value[name];
  const paths: string[] = Array.isArray(p?.paths) ? p.paths : [];
  [modelX.value, propX.value] = pathToSel(paths[0]); // first path → x
  [modelY.value, propY.value] = pathToSel(paths[1]); // second path → y
  preset.value = null; // selectors now drive the chart
});

const newPresetName = ref("");
const canSavePreset = computed(() => !!newPresetName.value.trim() && !!pathX.value && !!pathY.value);
function onSavePreset() {
  savePreset(newPresetName.value, [pathX.value, pathY.value].filter(Boolean) as string[]);
  newPresetName.value = "";
}
function onDeletePreset(name: string) {
  if (window.confirm(`Delete preset "${name}"?`)) deletePreset(name);
}

// rolling trail window (seconds)
const WINDOW_OPTIONS = [
  { label: "1 s", value: 1 },
  { label: "3 s", value: 3 },
  { label: "5 s", value: 5 },
  { label: "10 s", value: 10 },
  { label: "30 s", value: 30 },
  { label: "60 s", value: 60 },
];
const windowS = ref(3);

function applyView() {
  const x = pathX.value;
  const y = pathY.value;
  if (x && y) watchProps([x, y]); // ensure both are sampled (additive)
  adapter?.setSignals(x ?? "", y ?? "");
}
watch([pathX, pathY], applyView);
watch(windowS, (v) => adapter?.setWindow(v));

// export the currently buffered trail (rolling, ~windowS seconds) to CSV
const canDownload = computed(() => !!(pathX.value && pathY.value));
function onDownload() {
  if (!adapter) return;
  const { time, labels, cols } = adapter.getSeries();
  if (!time.length) return;
  downloadText("loop_chart.csv", seriesToCsv(time, labels, cols));
}

onMounted(() => {
  adapter = new LoopRenderer(el.value!);
  adapter.setWindow(windowS.value);
  addRenderer(adapter);
  // sensible default: LV volume (x) vs LV pressure (y) if present
  if (modelNames.value.includes("LV")) {
    const props = numericProps("LV");
    if (props.includes("vol") && props.includes("pres")) {
      modelX.value = "LV";
      propX.value = "vol";
      modelY.value = "LV";
      propY.value = "pres";
    }
  }
  applyView();
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
    <div class="flex flex-col gap-0.5 text-xs" data-tour="loop.presets">
      <span class="opacity-60">preset</span>
      <div class="flex items-center gap-1.5">
        <Select
          v-if="presetNames.length"
          v-model="preset"
          :options="presetNames"
          placeholder="load preset…"
          size="small"
          class="w-48"
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

    <div class="flex items-center gap-1.5 flex-wrap text-xs" data-tour="loop.axes">
      <span class="opacity-60 w-4">x</span>
      <Select v-model="modelX" :options="modelNames" filter placeholder="model" size="small" class="w-32" />
      <Select
        v-model="propX"
        :options="propsX"
        filter
        placeholder="parameter"
        size="small"
        class="w-32"
        :disabled="!modelX"
      />
      <span class="opacity-60 w-4 ml-2">y</span>
      <Select v-model="modelY" :options="modelNames" filter placeholder="model" size="small" class="w-32" />
      <Select
        v-model="propY"
        :options="propsY"
        filter
        placeholder="parameter"
        size="small"
        class="w-32"
        :disabled="!modelY"
      />
    </div>

    <div ref="el" data-tour="loop.plot" style="width: 100%; height: 240px"></div>

    <div class="flex items-center justify-end gap-1.5 flex-wrap text-xs" data-tour="loop.controls">
      <span class="opacity-60">window</span>
      <Select
        v-model="windowS"
        :options="WINDOW_OPTIONS"
        option-label="label"
        option-value="value"
        size="small"
        class="w-24"
      />
      <Button
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
