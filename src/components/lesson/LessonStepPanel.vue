<script setup lang="ts">
import { inject } from "vue";
import Button from "primevue/button";
import Tag from "primevue/tag";
import { LessonKey } from "@/composables/useLesson";
import { t, UI } from "@/lessons/i18n";
import type { LessonAction } from "@/lessons/types";

// Left column of the lesson page: the current step's title, markdown text,
// optional image, action buttons and prev/next. Lives outside the page's
// v-if="modelReady" so the text doesn't flicker when the model rebuilds.
const rt = inject(LessonKey)!;

// Progress (0–100) to show inside an action button: the first control it
// drives that is currently moving in the button's own direction ("off" ops
// light up while closing, others while opening), so a close and an open
// button for the same control don't both fill. Undefined when idle.
function actionProgress(a: LessonAction): number | undefined {
  for (const op of a.ops) {
    if (op.kind !== "control" || !rt.isPending(op.id)) continue;
    if ((op.state === "off") !== rt.isClosing(op.id)) continue;
    const p = rt.progress(op.id);
    if (p !== undefined) return p;
  }
  return undefined;
}
</script>

<template>
  <div class="flex flex-col gap-3 h-full min-h-0">
    <div class="flex items-baseline gap-2">
      <span class="text-xs uppercase tracking-wide opacity-50">
        {{ t(UI.step, rt.lang.value) }} {{ rt.stepIndex.value + 1 }}/{{ rt.steps.length }}
      </span>
      <Tag v-if="rt.step.value.draft" :value="t(UI.draft, rt.lang.value)" severity="warn" />
    </div>
    <h2 class="text-xl font-semibold leading-tight">{{ t(rt.step.value.title, rt.lang.value) }}</h2>

    <div class="flex-1 min-h-0 overflow-y-auto pr-1 flex flex-col gap-3">
      <div class="md-body leading-relaxed" v-html="rt.stepHtml.value"></div>

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

      <div v-if="rt.step.value.actions?.length" class="flex flex-wrap gap-2">
        <!-- while the control this button drives is moving, the button itself
             fills up as a progress bar and shows the percentage -->
        <Button
          v-for="a in rt.step.value.actions"
          :key="a.id"
          :severity="a.severity ?? 'primary'"
          size="small"
          class="action-btn relative overflow-hidden"
          :disabled="!rt.modelReady.value"
          @click="rt.applyOps(a.ops)"
        >
          <span
            v-if="actionProgress(a) !== undefined"
            class="action-fill"
            :style="{ width: `${actionProgress(a)}%` }"
          ></span>
          <i v-if="actionProgress(a) !== undefined" class="pi pi-spin pi-spinner relative"></i>
          <i v-else-if="a.icon" :class="a.icon" class="relative"></i>
          <span class="relative">{{ t(a.label, rt.lang.value) }}</span>
          <span v-if="actionProgress(a) !== undefined" class="relative tabular-nums opacity-90">
            {{ actionProgress(a) }}%
          </span>
        </Button>
      </div>
    </div>

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
/* progress fill inside an action button: a darker band growing left→right,
   eased over the ~1 Hz value updates */
.action-fill {
  position: absolute;
  inset: 0 auto 0 0;
  background: rgb(0 0 0 / 0.28);
  transition: width 1s linear;
  pointer-events: none;
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
