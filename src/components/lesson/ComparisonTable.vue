<script setup lang="ts">
import { computed } from "vue";
import Button from "primevue/button";
import ProgressBar from "primevue/progressbar";
import { fmt, withinTolerance } from "@explain/papers/evaluate.js";
import type { ExperimentRun } from "@/composables/useLesson";
import type { Experiment, ExperimentMeasure } from "@/lessons/types";
import { t, UI, type Lang } from "@/lessons/i18n";

// One experiment of a paper companion: the paper's value, the literature target
// and the value this engine produced when the reader ran it here. The run is
// driven by the lesson runtime (useLesson.runExperiment); this component only
// shows it and offers the Run button.
const props = defineProps<{
  experiment: Experiment;
  run?: ExperimentRun;
  references: Record<string, string>;
  lang: Lang;
  running: boolean; // any experiment currently running (disables Run)
}>();
const emit = defineEmits<{ run: [] }>();

const status = computed(() => props.run?.status ?? "idle");
const done = computed(() => status.value === "done");
const busy = computed(() => ["loading", "settling", "sampling"].includes(status.value));

const statusLabel = computed(() => {
  switch (status.value) {
    case "loading":
      return t(UI.loadingScenario, props.lang);
    case "settling":
      return t(UI.settling, props.lang);
    case "sampling":
      return t(UI.sampling, props.lang);
    case "error":
      return props.run?.error ?? "error";
    default:
      return "";
  }
});

function engineValue(m: ExperimentMeasure): string {
  if (!done.value) return "–";
  return fmt(props.run?.values[m.key], m.round);
}
function paperValue(m: ExperimentMeasure): string {
  if (typeof m.paper === "number") return fmt(m.paper, m.round);
  return m.paper ?? "";
}
function verdict(m: ExperimentMeasure): boolean | null {
  if (!done.value) return null;
  return withinTolerance(m, props.run?.values[m.key]);
}
function litText(m: ExperimentMeasure): string {
  return (m.literature ?? []).map((l) => `${l.value} [${l.ref}]`).join("; ");
}
function litTitle(m: ExperimentMeasure): string {
  return (m.literature ?? [])
    .map((l) => props.references[String(l.ref)] ?? "")
    .filter(Boolean)
    .join("\n");
}
</script>

<template>
  <div class="flex flex-col gap-2 rounded border border-surface-700 bg-surface-800/50 p-2">
    <div class="flex items-center justify-between gap-2 flex-wrap">
      <div class="min-w-0">
        <div class="text-sm font-semibold leading-tight">{{ experiment.title }}</div>
        <div class="text-xs opacity-60">
          {{ experiment.paper_table }} · {{ experiment.scenario }} · settle {{ experiment.settle_s }} s, window
          {{ experiment.window_s }} s
        </div>
      </div>
      <Button
        :label="t(done ? UI.rerun : UI.run, lang)"
        :icon="busy ? 'pi pi-spin pi-spinner' : 'pi pi-play'"
        size="small"
        :disabled="running"
        @click="emit('run')"
      />
    </div>
    <p v-if="experiment.description" class="text-xs opacity-80 m-0">{{ experiment.description }}</p>
    <div v-if="busy" class="flex items-center gap-2 text-xs">
      <ProgressBar :value="status === 'sampling' ? run?.progress ?? 0 : 0" :show-value="false" class="flex-1 h-2" />
      <span class="opacity-70 whitespace-nowrap">{{ statusLabel }}</span>
    </div>
    <p v-else-if="status === 'error'" class="text-xs text-red-400 m-0">{{ statusLabel }}</p>

    <table class="comparison text-xs w-full">
      <thead>
        <tr class="opacity-60">
          <th class="text-left font-normal">{{ t(UI.measure, lang) }}</th>
          <th class="text-right font-normal">{{ t(UI.literature, lang) }}</th>
          <th class="text-right font-normal">{{ t(UI.paper, lang) }}</th>
          <th class="text-right font-normal">{{ t(UI.thisRun, lang) }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="m in experiment.measures" :key="m.key">
          <td>
            {{ m.label }}
            <span v-if="m.unit" class="opacity-50">({{ m.unit }})</span>
          </td>
          <td class="text-right tabular-nums opacity-80" :title="litTitle(m)">{{ litText(m) }}</td>
          <td class="text-right tabular-nums">{{ paperValue(m) }}</td>
          <td
            class="text-right tabular-nums font-medium"
            :class="{
              'text-emerald-400': verdict(m) === true,
              'text-amber-400': verdict(m) === false,
              'opacity-50': !done,
            }"
            :title="verdict(m) === null ? '' : t(verdict(m) ? UI.within : UI.outside, lang)"
          >
            {{ engineValue(m) }}
          </td>
        </tr>
      </tbody>
    </table>
    <p v-if="!done && !busy" class="text-xs opacity-50 m-0">{{ t(UI.notRun, lang) }}</p>
  </div>
</template>

<style scoped>
.comparison th,
.comparison td {
  padding: 0.15rem 0.35rem;
  border-bottom: 1px solid rgb(255 255 255 / 0.06);
  vertical-align: top;
}
.comparison tbody tr:last-child td {
  border-bottom: 0;
}
</style>
