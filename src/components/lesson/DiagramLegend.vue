<script setup lang="ts">
import { ref, watch } from "vue";
import { t, useLessonLang } from "@/lessons/i18n";
import { to2RampCss } from "@/render/diagramConstants";

// Small collapsible key to the diagram's visual encoding, overlaid on the
// diagram's bottom-left corner. The colour bar samples the renderer's own
// to2 ramp, so it shows the same gamma curve (mixed blood stays blue).
const lang = useLessonLang();
const ramp = to2RampCss();

const STORAGE_KEY = "explain.lesson.legend";
function initialOpen(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "closed";
  } catch {
    return true;
  }
}
const open = ref(initialOpen());
watch(open, (v) => {
  try {
    localStorage.setItem(STORAGE_KEY, v ? "open" : "closed");
  } catch {
    /* ignore */
  }
});

const L = {
  title: { nl: "Legenda", en: "Legend" },
  colour: { nl: "Zuurstofgehalte", en: "Oxygen content" },
  low: { nl: "laag", en: "low" },
  high: { nl: "hoog", en: "high" },
  size: { nl: "Grootte = bloedvolume", en: "Size = blood volume" },
  dots: { nl: "Stipjes = stroomrichting en -hoeveelheid", en: "Dots = direction and amount of flow" },
  noDots: { nl: "Geen stipjes = geen stroming", en: "No dots = no flow" },
  lines: { nl: "Lijnen = vaten, kleppen, shunts", en: "Lines = vessels, valves, shunts" },
};
</script>

<template>
  <div
    class="absolute left-2 bottom-2 z-10 rounded border border-surface-700 bg-surface-900/85 backdrop-blur-sm text-xs shadow"
  >
    <button
      type="button"
      class="flex w-full items-center gap-1.5 px-2 py-1 opacity-80 hover:opacity-100"
      :aria-expanded="open"
      @click="open = !open"
    >
      <i class="pi pi-info-circle"></i>
      <span class="font-medium">{{ t(L.title, lang) }}</span>
      <i class="pi ml-auto text-[0.6rem]" :class="open ? 'pi-chevron-down' : 'pi-chevron-up'"></i>
    </button>
    <div v-if="open" class="flex flex-col gap-1.5 px-2 pb-2 w-56">
      <div class="flex flex-col gap-0.5">
        <span class="opacity-80">{{ t(L.colour, lang) }}</span>
        <div class="h-2.5 rounded-sm" :style="{ background: ramp }"></div>
        <div class="flex justify-between opacity-60 text-[10px]">
          <span>{{ t(L.low, lang) }}</span><span>{{ t(L.high, lang) }}</span>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <span class="flex items-end gap-0.5 w-6 justify-center">
          <span class="inline-block size-1.5 rounded-full bg-surface-300"></span>
          <span class="inline-block size-3 rounded-full bg-surface-300"></span>
        </span>
        <span class="opacity-80">{{ t(L.size, lang) }}</span>
      </div>
      <div class="flex items-center gap-2">
        <span class="flex items-center gap-0.5 w-6 justify-center">
          <span class="inline-block size-1 rounded-full bg-surface-200"></span>
          <span class="inline-block size-1 rounded-full bg-surface-200"></span>
          <i class="pi pi-angle-right text-[0.6rem] opacity-70"></i>
        </span>
        <span class="opacity-80">{{ t(L.dots, lang) }}</span>
      </div>
      <div class="flex items-center gap-2">
        <span class="w-6 flex justify-center"><span class="block h-0.5 w-5 bg-surface-500"></span></span>
        <span class="opacity-80">{{ t(L.lines, lang) }}</span>
      </div>
      <span class="opacity-50 text-[10px] pl-8">{{ t(L.noDots, lang) }}</span>
    </div>
  </div>
</template>
