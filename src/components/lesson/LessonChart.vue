<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRealtimeBus } from "@/composables/useRealtimeBus";
import { useExplain } from "@/composables/useExplain";
import { ChartRenderer } from "@/render/ChartRenderer";
import type { LessonChart } from "@/lessons/types";
import { t, useLessonLang } from "@/lessons/i18n";

// A fixed-series realtime chart for a lesson step (no selectors): the step says
// which "Model.prop" series to draw, the y range and whether to fill the area
// (a Doppler-like envelope). Series are added to the shared fast watchlist,
// which a rebuild clears, so they are re-registered whenever the model is ready.
const props = defineProps<{ chart: LessonChart }>();
const lang = useLessonLang();
const { addRenderer, removeRenderer } = useRealtimeBus();
const { watch: watchProps, modelReady } = useExplain();
const el = ref<HTMLDivElement | null>(null);
let renderer: ChartRenderer | null = null;

function apply() {
  if (!renderer) return;
  const c = props.chart;
  watchProps(c.paths);
  renderer.setWindow(c.windowS ?? 3);
  renderer.setSharedAxis(c.paths.length > 1);
  renderer.setVisible(c.paths);
  renderer.setFill(!!c.fill);
  if (typeof c.yMin === "number" && typeof c.yMax === "number") renderer.applyFixedYRange(c.yMin, c.yMax);
  else renderer.setAutoScaleY(true);
}

// the renderer only knows its series once the bus delivers the channel
// registry (after the watchlist change reaches the engine), so a fixed range set
// before that has nothing to pin: re-apply shortly after
let retry: number | undefined;
function applyLater() {
  apply();
  window.clearTimeout(retry);
  retry = window.setTimeout(apply, 2000);
}

onMounted(() => {
  renderer = new ChartRenderer(el.value!);
  addRenderer(renderer);
  applyLater();
});
watch(() => props.chart, applyLater, { deep: true });
watch(modelReady, (ready) => {
  if (ready) applyLater();
});
onBeforeUnmount(() => {
  window.clearTimeout(retry);
  if (renderer) {
    removeRenderer(renderer);
    renderer.dispose();
  }
});
</script>

<template>
  <div class="flex flex-col gap-1">
    <div class="flex items-center justify-between text-xs opacity-70">
      <span>{{ t(chart.title, lang) || chart.paths.join(" · ") }}</span>
      <span class="tabular-nums">{{ chart.paths.join(" · ") }}</span>
    </div>
    <div ref="el" class="w-full h-40 rounded border border-surface-700 bg-surface-950"></div>
  </div>
</template>
