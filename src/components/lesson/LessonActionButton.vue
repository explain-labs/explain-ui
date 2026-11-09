<script setup lang="ts">
import { computed, inject } from "vue";
import Button from "primevue/button";
import { LessonKey } from "@/composables/useLesson";
import { t } from "@/lessons/i18n";
import type { LessonAction } from "@/lessons/types";

// One lesson action button, in the step text (at a `[[action:id]]` marker) or
// in the row under it. While the action plays out it fills as a progress bar.
const props = defineProps<{ action: LessonAction }>();
const rt = inject(LessonKey)!;

// Progress (0–100): a timed action (`duration`) playing out in model time, else
// the first control it drives that is currently moving in the button's own
// direction ("off" ops light up while closing, others while opening), so a
// close and an open button for the same control don't both fill. Undefined
// when idle.
const progress = computed<number | undefined>(() => {
  const a = props.action;
  const timed = rt.actionTimeProgress(a.id);
  if (timed !== undefined) return timed;
  for (const op of a.ops) {
    if (op.kind !== "control" || !rt.isPending(op.id)) continue;
    if ((op.state === "off") !== rt.isClosing(op.id)) continue;
    const p = rt.progress(op.id);
    if (p !== undefined) return p;
  }
  return undefined;
});
</script>

<template>
  <Button
    :severity="action.severity ?? 'primary'"
    size="small"
    class="action-btn relative overflow-hidden"
    :disabled="!rt.modelReady.value"
    @click="rt.runAction(action)"
  >
    <span v-if="progress !== undefined" class="action-fill" :style="{ width: `${progress}%` }"></span>
    <i v-if="progress !== undefined" class="pi pi-spin pi-spinner relative"></i>
    <i v-else-if="action.icon" :class="action.icon" class="relative"></i>
    <span class="relative">{{ t(action.label, rt.lang.value) }}</span>
    <span v-if="progress !== undefined" class="relative tabular-nums opacity-90">{{ progress }}%</span>
  </Button>
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
</style>
