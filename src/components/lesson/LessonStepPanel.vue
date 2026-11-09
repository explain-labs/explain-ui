<script setup lang="ts">
import { inject } from "vue";
import Button from "primevue/button";
import Tag from "primevue/tag";
import { computed } from "vue";
import ComparisonTable from "@/components/lesson/ComparisonTable.vue";
import LessonActionButton from "@/components/lesson/LessonActionButton.vue";
import { LessonKey } from "@/composables/useLesson";
import { t, UI } from "@/lessons/i18n";
import type { LessonAction } from "@/lessons/types";

// Left column of the lesson page: the current step's title, markdown text,
// optional image, action buttons and prev/next. Lives outside the page's
// v-if="modelReady" so the text doesn't flicker when the model rebuilds.
const rt = inject(LessonKey)!;

// paper companions: the step's experiment (comparison table + Run) and the
// reference list, cited as [n] in the text
const experiment = computed(() => {
  const id = rt.step.value.experiment;
  return id ? rt.lesson.experiments?.experiments.find((e) => e.id === id) : undefined;
});
const references = computed(() => rt.lesson.experiments?.references ?? {});
const anyRunning = computed(() =>
  Object.values(rt.runs.value).some((r) => ["loading", "settling", "sampling"].includes(r.status)),
);

// action buttons: those placed in the text by a `[[action:id]]` marker render
// there; the rest stay in the row under the text
const actionsById = computed(
  () => new Map((rt.step.value.actions ?? []).map((a) => [a.id, a] as [string, LessonAction])),
);
function blockActions(ids: string[]): LessonAction[] {
  return ids.flatMap((id) => {
    const a = actionsById.value.get(id);
    if (!a) console.warn(`lesson step "${rt.step.value.id}": [[action:${id}]] names no action of this step`);
    return a ? [a] : [];
  });
}
const restActions = computed(() =>
  (rt.step.value.actions ?? []).filter((a) => !rt.inlineActionIds.value.has(a.id)),
);
</script>

<template>
  <div class="flex flex-col gap-3 h-full min-h-0">
    <div class="flex items-baseline gap-2">
      <span class="text-xs uppercase tracking-wide opacity-50">
        {{ t(UI.step, rt.lang.value) }} {{ rt.stepIndex.value + 1 }}/{{ rt.steps.length }}
      </span>
      <Tag v-if="rt.step.value.draft" :value="t(UI.draft, rt.lang.value)" severity="warn" />
      <span v-if="rt.computing.value" class="ml-auto text-xs opacity-70 flex items-center gap-1">
        <i class="pi pi-spin pi-spinner text-xs"></i>{{ t(UI.computing, rt.lang.value) }}
      </span>
    </div>
    <h2 class="text-xl font-semibold leading-tight">{{ t(rt.step.value.title, rt.lang.value) }}</h2>

    <div class="flex-1 min-h-0 overflow-y-auto pr-1 flex flex-col gap-3">
      <template v-for="(b, i) in rt.visibleBlocks.value" :key="`${rt.step.value.id}-${i}`">
        <div v-if="b.kind === 'html'" class="md-body leading-relaxed" v-html="b.html"></div>
        <!-- a reveal point: an unopened one shows Continue, opened ones nothing -->
        <div v-else-if="b.kind === 'reveal'" v-show="b.pending" class="flex items-center gap-3 my-1">
          <Button
            :label="t(UI.reveal, rt.lang.value)"
            icon="pi pi-angle-double-down"
            size="small"
            severity="secondary"
            @click="rt.revealNext"
          />
          <span class="text-xs opacity-60 italic">{{ t(UI.revealHint, rt.lang.value) }}</span>
        </div>
        <div v-else class="flex flex-wrap gap-2 my-1">
          <LessonActionButton v-for="a in blockActions(b.ids)" :key="a.id" :action="a" />
        </div>
      </template>

      <figure v-if="rt.stepImageUrl.value" class="flex flex-col gap-1">
        <img
          :src="rt.stepImageUrl.value"
          :alt="t(rt.step.value.image?.caption, rt.lang.value)"
          class="w-full rounded border border-surface-700 bg-surface-950"
        />
        <figcaption v-if="rt.step.value.image?.caption" class="text-xs opacity-60">
          {{ t(rt.step.value.image.caption, rt.lang.value) }}
        </figcaption>
      </figure>

      <ComparisonTable
        v-if="experiment"
        :experiment="experiment"
        :run="rt.runs.value[experiment.id]"
        :references="references"
        :lang="rt.lang.value"
        :running="anyRunning"
        @run="rt.runExperiment(experiment.id)"
      />

      <div v-if="restActions.length" class="flex flex-wrap gap-2">
        <LessonActionButton v-for="a in restActions" :key="a.id" :action="a" />
      </div>
    </div>

    <details v-if="rt.lesson.references?.length" class="text-xs opacity-80">
      <summary class="cursor-pointer select-none">{{ t(UI.references, rt.lang.value) }}</summary>
      <ol class="refs mt-1">
        <li v-for="r in rt.lesson.references" :key="r.id" :value="r.id">
          <span class="opacity-60 mr-1">[{{ r.id }}]</span>
          <a v-if="r.url" :href="r.url" target="_blank" rel="noopener">{{ r.text }}</a>
          <span v-else>{{ r.text }}</span>
        </li>
      </ol>
    </details>

    <div class="flex items-center justify-between gap-2 border-t border-surface-700 pt-3">
      <Button
        :label="t(UI.previous, rt.lang.value)"
        icon="pi pi-arrow-left"
        severity="secondary"
        size="small"
        text
        :disabled="rt.isFirst.value"
        @click="rt.prev"
      />
      <Button
        :label="t(UI.next, rt.lang.value)"
        icon="pi pi-arrow-right"
        icon-pos="right"
        size="small"
        :disabled="rt.isLast.value"
        @click="rt.next"
      />
    </div>
  </div>
</template>

<style scoped>
.refs {
  max-height: 10rem;
  overflow-y: auto;
  padding-left: 0;
  list-style: none;
}
.refs li {
  margin: 0.15rem 0;
}
.refs a {
  text-decoration: underline;
  text-underline-offset: 2px;
}
/* Markdown styling (Tailwind preflight strips list markers and heading sizes).
   Mirrors DocViewer's .md-body block with slightly roomier text for reading. */
.md-body :deep(> *:first-child) {
  margin-top: 0;
}
.md-body :deep(p) {
  margin: 0.5rem 0;
}
.md-body :deep(ul),
.md-body :deep(ol) {
  margin: 0.5rem 0;
  padding-left: 1.25rem;
}
.md-body :deep(ul) {
  list-style: disc;
}
.md-body :deep(ol) {
  list-style: decimal;
}
.md-body :deep(li) {
  margin: 0.2rem 0;
}
.md-body :deep(h2),
.md-body :deep(h3),
.md-body :deep(h4) {
  font-weight: 600;
  line-height: 1.25;
  margin: 0.9rem 0 0.4rem;
}
.md-body :deep(h2) {
  font-size: 1.1rem;
}
.md-body :deep(h3),
.md-body :deep(h4) {
  font-size: 1rem;
}
.md-body :deep(strong) {
  font-weight: 600;
}
.md-body :deep(a) {
  text-decoration: underline;
  text-underline-offset: 2px;
}
.md-body :deep(img) {
  max-width: 100%;
  border-radius: 0.375rem;
}
.md-body :deep(blockquote) {
  margin: 0.5rem 0;
  padding: 0.4rem 0.7rem;
  border-left: 3px solid rgb(251 191 36 / 0.7);
  background: rgb(251 191 36 / 0.06);
  border-radius: 0 0.375rem 0.375rem 0;
}
</style>
