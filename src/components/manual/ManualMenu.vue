<script setup lang="ts">
import { ref } from "vue";
import Button from "primevue/button";
import Popover from "primevue/popover";
import { toursByChapter } from "@/manual/index";
import { useTour } from "@/composables/useTour";
import { useExplain } from "@/composables/useExplain";

// Header "Help" button: lists the manual's tours by chapter, with a check for
// the ones already finished. Starting a tour closes the menu.
const rt = useTour();
const { modelReady } = useExplain();
const chapters = toursByChapter();
const menu = ref<any>(null);

function launch(id: string) {
  menu.value?.hide();
  rt.start(id);
}
</script>

<template>
  <Button
    v-if="chapters.length"
    data-tour="header.help"
    icon="pi pi-question-circle"
    label="Help"
    size="small"
    severity="secondary"
    text
    @click="menu?.toggle($event)"
  />
  <Popover ref="menu">
    <div class="flex w-72 flex-col gap-3">
      <div class="text-sm font-semibold">Interactive manual</div>
      <div v-for="c in chapters" :key="c.chapter" class="flex flex-col gap-1">
        <div class="text-xs uppercase tracking-wide opacity-50">{{ c.chapter }}</div>
        <button
          v-for="t in c.tours"
          :key="t.id"
          type="button"
          class="flex items-start gap-2 rounded px-2 py-1.5 text-left hover:bg-surface-800 disabled:opacity-40 disabled:hover:bg-transparent"
          :disabled="t.needsModel !== false && !modelReady"
          @click="launch(t.id)"
        >
          <i
            class="pi mt-0.5 text-sm"
            :class="rt.isCompleted(t.id) ? 'pi-check-circle text-green-400' : 'pi-play-circle opacity-60'"
          ></i>
          <span class="flex min-w-0 flex-col">
            <span class="text-sm font-medium">{{ t.title }}</span>
            <span class="text-xs opacity-60">{{ t.summary }}</span>
          </span>
        </button>
      </div>
      <Button
        v-if="rt.progress.value.completed.length"
        label="Reset progress"
        icon="pi pi-replay"
        size="small"
        severity="secondary"
        text
        class="self-start"
        @click="rt.resetProgress()"
      />
    </div>
  </Popover>
</template>
