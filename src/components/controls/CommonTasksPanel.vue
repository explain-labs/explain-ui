<script setup lang="ts">
import { computed, reactive, watch } from "vue";
import Panel from "primevue/panel";
import Button from "primevue/button";
import InputNumber from "primevue/inputnumber";
import { useExplain } from "@/composables/useExplain";
import {
  COMMON_TASKS,
  TASK_CATEGORY_LABELS,
  TASK_CATEGORY_ORDER,
  currentScaleFactor,
  findInstance,
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
const { scale, setProp, call, modelState, refreshState, modelReady, isRunning, watchSlow, slowValues } =
  useExplain();

// Current factor of each SCALE lever. ModelScaler writes most groups as an
// absolute `*_factor_scaling_ps` on every component, which IS in the state
// snapshot, so read it from there (currentScaleFactor) — that keeps a loaded
// state's earlier change (e.g. ×1.30) instead of restarting at ×1.00.
// `factors` holds what this panel just sent, until a fresh snapshot catches up
// (so quick repeated clicks build on each other); it is the only source for
// volume groups, which the engine re-baselines to 1.0 on every build.
const factors = reactive<Record<string, number>>({});
function scaleFactor(task: CommonTask): number {
  return factors[task.id] ?? currentScaleFactor(task.lever, modelState.value) ?? 1;
}
// The same for setProp/call levers, per instance ("taskId:instance"): the engine
// applies them on its TaskScheduler (a setProp tweens over 1 s), after the
// refreshState() that follows the click, so without this the readout lagged one
// click behind and the next click stepped from the stale value again.
const pending = reactive<Record<string, number>>({});
// when each pending value was sent: some props also move by themselves in the engine
// (atelectasis recruits and re-collapses), so the snapshot may never equal what was
// sent; a pending value therefore lapses once the delayed refresh has had time to land
const pendingAt: Record<string, number> = {};
const PENDING_MS = 1000;
// the same for choice tasks (airway events): the value just chosen, until the engine shows it
const pendingChoice = reactive<Record<string, string | boolean>>({});
// a (re)build — load, revert, saved state — starts from the new snapshot
watch(modelReady, (ready) => {
  if (!ready) {
    for (const k of Object.keys(factors)) delete factors[k];
    for (const k of Object.keys(pending)) delete pending[k];
    for (const k of Object.keys(pendingChoice)) delete pendingChoice[k];
  }
});
// once a snapshot shows what we sent, let the snapshot lead again (so a later
// change from elsewhere — the bot, the model editor — shows up here)
watch(modelState, (st) => {
  for (const task of COMMON_TASKS) {
    if (!(task.id in factors)) continue;
    const f = currentScaleFactor(task.lever, st);
    if (f != null && Math.abs(f - factors[task.id]) < 1e-9) delete factors[task.id];
  }
  for (const key of Object.keys(pending)) {
    const [id, inst] = key.split(":");
    const task = COMMON_TASKS.find((t) => t.id === id);
    const v = task ? snapshotValue(inst, task) : NaN;
    const matches = Math.abs(v - pending[key]) <= 1e-9 * Math.max(1, Math.abs(pending[key]));
    if (!task || matches || Date.now() - (pendingAt[key] ?? 0) > PENDING_MS) delete pending[key];
  }
  for (const key of Object.keys(pendingChoice)) {
    const [id, inst] = key.split(":");
    const task = COMMON_TASKS.find((t) => t.id === id);
    const v = task ? findInstance(models(), inst)?.[readTarget(task)] : undefined;
    if (!task || v === pendingChoice[key] || Date.now() - (pendingAt[key] ?? 0) > PENDING_MS) delete pendingChoice[key];
  }
});
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

// Resolve a setProp/call lever to the live instance name(s) carrying its prop.
// Singleton levers use the model name directly (also a sub-model of a composite,
// e.g. VENT_ETTUBE inside the Ventilator); resolveByType levers match every
// instance of that model_type (e.g. GasExchanger → GASEX_LL/RL).
function resolveInstances(task: CommonTask): string[] {
  if (task.lever.kind === "scale") return [];
  const m = models();
  if (task.lever.kind === "call") {
    const inst = findInstance(m, task.lever.model);
    return inst && task.lever.read in inst ? [task.lever.model] : [];
  }
  const { model, target, resolveByType } = task.lever;
  if (resolveByType) {
    return Object.keys(m).filter((n) => m[n]?.model_type === model && target in (m[n] ?? {}));
  }
  const inst = findInstance(m, model);
  return inst && target in inst ? [model] : [];
}
// the prop holding a setProp/call lever's current value
const readTarget = (task: CommonTask) =>
  task.lever.kind === "call" ? task.lever.read : task.lever.kind === "setProp" ? task.lever.target : "";
const snapshotValue = (inst: string, task: CommonTask) => Number(findInstance(models(), inst)?.[readTarget(task)]);
// the latest slow-stream sample while running (fresher than the snapshot)
function liveRaw(inst: string, task: CommonTask): unknown {
  if (!isRunning.value) return undefined;
  const arr = slowValues.value as any[];
  const latest = Array.isArray(arr) && arr.length ? arr[arr.length - 1] : null;
  return latest?.[`${inst}.${readTarget(task)}`];
}
const liveValue = (inst: string, task: CommonTask) => Number(liveRaw(inst, task));
// a choice task's current value: just chosen, else live, else the snapshot
function choiceValue(inst: string, task: CommonTask): unknown {
  const key = `${task.id}:${inst}`;
  if (key in pendingChoice) return pendingChoice[key];
  const live = liveRaw(inst, task);
  return live !== undefined ? live : findInstance(models(), inst)?.[readTarget(task)];
}
function choose(task: CommonTask, value: string | boolean) {
  if (task.lever.kind !== "call") return;
  for (const inst of resolveInstances(task)) {
    call(`${inst}.${task.lever.fn}`, [value]);
    pendingChoice[`${task.id}:${inst}`] = value;
    pendingAt[`${task.id}:${inst}`] = Date.now();
  }
  refreshState();
  setTimeout(refreshState, 1200);
}
const isChosen = (task: CommonTask, value: string | boolean) => {
  const inst = resolveInstances(task)[0];
  return inst != null && choiceValue(inst, task) === value;
};
// what this panel last sent, until the engine shows it; else the live value, else the snapshot
function current(inst: string, task: CommonTask): number {
  const sent = pending[`${task.id}:${inst}`];
  if (sent != null) return sent;
  const live = liveValue(inst, task);
  return Number.isFinite(live) ? live : snapshotValue(inst, task);
}
// keep every setProp/call readout on the 1 Hz slow stream, so values the engine
// changes by itself (atelectasis recruiting under pressure) update while running.
// A rebuild starts a fresh watchlist, so watch again after one.
let watchedKey = "";
watch(
  [modelReady, modelState],
  () => {
    if (!modelReady.value) {
      watchedKey = "";
      return;
    }
    const paths = COMMON_TASKS.flatMap((t) => resolveInstances(t).map((inst) => `${inst}.${readTarget(t)}`));
    const key = paths.join("|");
    if (paths.length && key !== watchedKey) {
      watchSlow(paths); // the engine dedups its watchlist
      watchedKey = key;
    }
  },
  { immediate: true },
);

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
  return out.sort((a, b) => TASK_CATEGORY_ORDER.indexOf(a.category) - TASK_CATEGORY_ORDER.indexOf(b.category));
});

// Live readout: tracked factor for scale tasks, current prop value for setProp.
function readout(task: CommonTask): string {
  if (task.lever.kind === "scale") return `×${scaleFactor(task).toFixed(2)}`;
  if (task.choices) return task.choices.find((c) => isChosen(task, c.value))?.label ?? "";
  const inst = resolveInstances(task)[0];
  if (!inst) return "";
  const v = current(inst, task);
  if (!Number.isFinite(v)) return "";
  const isFactor = task.lever.kind === "setProp" && task.lever.field === "factor";
  return isFactor ? `×${v.toFixed(2)}` : `${v.toFixed(2)}${task.unit ? ` ${task.unit}` : ""}`;
}

function nudge(task: CommonTask, dir: NudgeDirection) {
  const eff: CommonTask = { ...task, step: rawStep(task) };
  if (task.lever.kind === "scale") {
    const next = nextScaleFactor(scaleFactor(task), eff, dir);
    const groups = Array.isArray(task.lever.group) ? task.lever.group : [task.lever.group];
    for (const g of groups) scale(g, next);
    factors[task.id] = next;
  } else if (task.lever.kind === "call") {
    // absolute stepping through the setter (it recomputes what depends on the value)
    for (const inst of resolveInstances(task)) {
      const cur = current(inst, task);
      if (!Number.isFinite(cur)) continue;
      const next = nextAbsoluteValue(cur, eff, dir);
      call(`${inst}.${task.lever.fn}`, [next]);
      pending[`${task.id}:${inst}`] = next;
      pendingAt[`${task.id}:${inst}`] = Date.now();
    }
  } else {
    const { target, field } = task.lever;
    for (const inst of resolveInstances(task)) {
      const raw = current(inst, task);
      const cur = Number.isFinite(raw) ? raw : field === "factor" ? 1 : NaN;
      if (!Number.isFinite(cur)) continue;
      const next =
        task.mode === "absolute" ? nextAbsoluteValue(cur, eff, dir) : nextSetPropValue(cur, eff, dir);
      setProp(`${inst}.${target}`, next);
      pending[`${task.id}:${inst}`] = next;
      pendingAt[`${task.id}:${inst}`] = Date.now();
    }
  }
  refreshState();
  // setProp/call land on the TaskScheduler (a setProp tweens over 1 s): fetch the
  // state again once they have, so the snapshot catches up with `pending`
  if (task.lever.kind !== "scale") setTimeout(refreshState, 1200);
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

          <div v-if="task.choices" class="flex flex-wrap justify-end gap-1">
            <Button
              v-for="c in task.choices"
              :key="String(c.value)"
              :label="c.label"
              size="small"
              :severity="isChosen(task, c.value) ? undefined : 'secondary'"
              :outlined="!isChosen(task, c.value)"
              class="!px-2 !py-1 !text-xs"
              @click="choose(task, c.value)"
            />
          </div>
          <template v-else>
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
          </template>
          </div>
        </div>
      </div>
    </div>
  </Panel>
</template>
