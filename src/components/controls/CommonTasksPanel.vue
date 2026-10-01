<script setup lang="ts">
import { computed, reactive } from "vue";
import Panel from "primevue/panel";
import Button from "primevue/button";
import InputNumber from "primevue/inputnumber";
import { useExplain } from "@/composables/useExplain";
import {
  COMMON_TASKS,
  TASK_CATEGORY_LABELS,
  nextAbsoluteValue,
  nextScaleFactor,
  nextSetPropValue,
  type CommonTask,
  type NudgeDirection,
  type TaskCategory,
} from "@/services/commonTasks";

// Quick-action directional nudges ("raise PVR 30%", "halve contractility").
// Human surface like ScalerPanel — routes straight through useExplain (not the
// bot validate gate). The catalog (COMMON_TASKS) is shared with the bot.
const { scale, setProp, modelState, refreshState } = useExplain();

// Client-side tracking for SCALE levers (ModelScaler factors aren't in the state
// snapshot, so we remember them here; baseline 1.0). Re-zeroes automatically on
// reload/revert because the panel unmounts with the modelReady v-if in MainPage.
const factors = reactive<Record<string, number>>({});
// Per-task step, in the field the user types into: a PERCENT for factor tasks
// (30 = ±30%), or the raw increment for absolute tasks (e.g. 0.1 / 1 mm).
const stepSel = reactive<Record<string, number>>(
  Object.fromEntries(COMMON_TASKS.map((t) => [t.id, t.mode === "absolute" ? t.step : t.step * 100])),
);
const stepSuffix = (t: CommonTask) => (t.mode === "absolute" ? (t.unit ? ` ${t.unit}` : "") : "%");
// the displayed step converted back to the raw fraction/increment the helpers expect
function rawStep(t: CommonTask): number {
  const sel = stepSel[t.id] ?? (t.mode === "absolute" ? t.step : t.step * 100);
  return t.mode === "absolute" ? sel : sel / 100;
}

// Per-category collapse state — sections start COLLAPSED.
const collapsed = reactive<Record<string, boolean>>({});
const isCollapsed = (cat: TaskCategory) => collapsed[cat] !== false; // default true
const toggle = (cat: TaskCategory) => {
  collapsed[cat] = !isCollapsed(cat);
};

function models(): Record<string, any> {
  return (modelState.value as any)?.models ?? {};
}

// Resolve a setProp lever to the live instance name(s) carrying its target prop.
// Singleton levers use the model name directly; resolveByType levers match every
// instance of that model_type (e.g. GasExchanger → GASEX_LL/RL).
function resolveInstances(task: CommonTask): string[] {
  if (task.lever.kind !== "setProp") return [];
  const { model, target, resolveByType } = task.lever;
  const m = models();
  if (resolveByType) {
    return Object.keys(m).filter((n) => m[n]?.model_type === model && target in (m[n] ?? {}));
  }
  return m[model] && target in m[model] ? [model] : [];
}

// A task is shown when its lever can act on the current scenario. Scale groups are
// topology-robust (ModelScaler skips missing components) so they always show;
// instance-targeted setProp tasks are hidden when no matching instance exists.
function isAvailable(task: CommonTask): boolean {
  return task.lever.kind === "scale" || resolveInstances(task).length > 0;
}

const categories = computed<{ category: TaskCategory; label: string; tasks: CommonTask[] }[]>(() => {
  const out: { category: TaskCategory; label: string; tasks: CommonTask[] }[] = [];
  for (const task of COMMON_TASKS) {
    if (!isAvailable(task)) continue;
    let group = out.find((g) => g.category === task.category);
    if (!group) {
      group = { category: task.category, label: TASK_CATEGORY_LABELS[task.category], tasks: [] };
      out.push(group);
    }
    group.tasks.push(task);
  }
  return out;
});

// Live readout: tracked factor for scale tasks, current prop value for setProp.
function readout(task: CommonTask): string {
  if (task.lever.kind === "scale") return `×${(factors[task.id] ?? 1).toFixed(2)}`;
  const inst = resolveInstances(task)[0];
  if (!inst) return "";
  const v = Number(models()[inst]?.[task.lever.target]);
  if (!Number.isFinite(v)) return "";
  const unit = task.unit ? ` ${task.unit}` : task.lever.field === "factor" ? "×" : "";
  return task.lever.field === "factor" ? `×${v.toFixed(2)}` : `${v.toFixed(2)}${unit}`;
}

function nudge(task: CommonTask, dir: NudgeDirection) {
  const eff: CommonTask = { ...task, step: rawStep(task) };
  if (task.lever.kind === "scale") {
    const next = nextScaleFactor(factors[task.id] ?? 1, eff, dir);
    const groups = Array.isArray(task.lever.group) ? task.lever.group : [task.lever.group];
    for (const g of groups) scale(g, next);
    factors[task.id] = next;
  } else {
    const { target, field } = task.lever;
    for (const inst of resolveInstances(task)) {
      const raw = Number(models()[inst]?.[target]);
      const cur = Number.isFinite(raw) ? raw : field === "factor" ? 1 : NaN;
      if (!Number.isFinite(cur)) continue;
      const next =
        task.mode === "absolute" ? nextAbsoluteValue(cur, eff, dir) : nextSetPropValue(cur, eff, dir);
      setProp(`${inst}.${target}`, next);
    }
  }
  refreshState();
}

function resetScale(task: CommonTask) {
  if (task.lever.kind !== "scale") return;
  const groups = Array.isArray(task.lever.group) ? task.lever.group : [task.lever.group];
  for (const g of groups) scale(g, 1.0);
  factors[task.id] = 1.0;
  refreshState();
}
</script>

<template>
  <Panel toggleable data-tour="commontasks.panel">
    <template #header>
      <span class="font-semibold">Common tasks</span>
    </template>

    <div class="flex flex-col gap-4">
      <p class="text-xs opacity-60 -mt-1">
        Directional nudges — click − / + to adjust by the step you enter. Up then down by the same step
        returns to baseline.
      </p>

      <div
        v-for="cat in categories"
        :key="cat.category"
        class="rounded border border-surface-700"
      >
        <button
          type="button"
          data-tour="commontasks.category"
          class="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-surface-800"
          @click="toggle(cat.category)"
        >
          <i
            :class="isCollapsed(cat.category) ? 'pi pi-chevron-right' : 'pi pi-chevron-down'"
            class="text-xs opacity-70"
          ></i>
          <span class="text-sm font-semibold">{{ cat.label }}</span>
          <span class="ml-auto text-xs opacity-40">{{ cat.tasks.length }}</span>
        </button>

        <div v-show="!isCollapsed(cat.category)" class="flex flex-col gap-2 p-2 pt-0">
          <div
            v-for="task in cat.tasks"
            :key="task.id"
            data-tour="commontasks.task"
            class="flex items-center gap-2"
            v-tooltip.left="task.help"
          >
          <div class="flex-1 min-w-0">
            <div class="text-sm truncate">{{ task.short }}</div>
            <div class="text-xs opacity-50">{{ readout(task) }}</div>
          </div>

          <Button
            v-tooltip.top="'Decrease'"
            icon="pi pi-minus"
            size="small"
            severity="secondary"
            aria-label="Decrease"
            @click="nudge(task, 'down')"
          />
          <Button
            v-tooltip.top="'Increase'"
            icon="pi pi-plus"
            size="small"
            severity="secondary"
            aria-label="Increase"
            @click="nudge(task, 'up')"
          />
          <InputNumber
            v-model="stepSel[task.id]"
            data-tour="commontasks.step"
            v-tooltip.top="'Step size'"
            :suffix="stepSuffix(task)"
            :min="0"
            :min-fraction-digits="0"
            :max-fraction-digits="2"
            size="small"
            input-class="w-16"
            class="w-20"
          />
          <Button
            v-if="task.lever.kind === 'scale'"
            data-tour="commontasks.reset"
            v-tooltip.top="'Reset to baseline'"
            icon="pi pi-refresh"
            size="small"
            severity="secondary"
            text
            aria-label="Reset"
            @click="resetScale(task)"
          />
          </div>
        </div>
      </div>
    </div>
  </Panel>
</template>
