<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import Panel from "primevue/panel";
import InputText from "primevue/inputtext";
import InputNumber from "primevue/inputnumber";
import Select from "primevue/select";
import ToggleSwitch from "primevue/toggleswitch";
import Button from "primevue/button";
import { useExplain } from "@/composables/useExplain";
import { useSlowHistory } from "@/composables/useSlowHistory";
import { useModelInterface } from "@/composables/useModelInterface";
import { useMonitorPrefs } from "@/composables/useMonitorPrefs";
import { scaleValue, formatParam } from "@/utils/monitorFormat";
import Popover from "primevue/popover";
import Sparkline from "@/components/numerics/Sparkline.vue";
import { useMonitorsStore, type MonitorGroup, type MonitorParam } from "@/stores/monitors";

// Generic, reusable numeric readout panel for one `configuration.monitors`
// group. Read-only mode renders a dense card grid (label · value · unit · trend
// arrow + delta); values come from the ~1 Hz slow stream and trend from
// useSlowHistory. When `editing` is on it becomes an inline editor that mutates
// the monitors store directly (which auto-persists into the scenario JSON).
const props = defineProps<{
  group: MonitorGroup;
  editable?: boolean; // manage mode: show this group's edit pencil
  compact?: boolean; // hide sparklines + denser grid
  highlight?: string[]; // primary paths whose cards get a ring (lesson steps)
}>();

function isHighlighted(param: MonitorParam): boolean {
  const path = param.props?.[0];
  return !!path && !!props.highlight?.includes(path);
}

// per-group edit state — only this group becomes editable when its pencil is
// clicked, so groups are edited one at a time. Leaving manage mode closes it.
const editing = ref(false);
watch(
  () => props.editable,
  (v) => {
    if (!v) editing.value = false;
  },
);

const { slowValues, modelState, watchSlow } = useExplain();
const { history, stats, delta } = useSlowHistory();
const { getInterface } = useModelInterface();
const prefs = useMonitorPrefs();
const store = useMonitorsStore();

const parameters = computed(() => props.group.parameters ?? []);

// subscribe every path this group needs to the slow watchlist. The engine side
// accumulates + dedups, so several panels coexist without clobbering.
function subscribe() {
  const paths = new Set<string>();
  for (const p of parameters.value) {
    for (const path of p.props ?? []) paths.add(path);
  }
  if (paths.size) watchSlow([...paths]);
}
onMounted(subscribe);
watch(parameters, subscribe, { deep: true }); // re-subscribe when paths change

const latest = computed(() => {
  const arr = slowValues.value as any[];
  return Array.isArray(arr) && arr.length ? arr[arr.length - 1] : null;
});

const weight = computed(() => {
  const w = (modelState.value as any)?.weight;
  return typeof w === "number" && w > 0 ? w : 1;
});

function scaled(param: MonitorParam, raw: number): number {
  return scaleValue(param, raw, weight.value);
}

function fmt(param: MonitorParam): string {
  return formatParam(param, latest.value, weight.value);
}

// ----- trend sparkline, driven by the first prop ------------------------------
function primaryPath(param: MonitorParam): string | undefined {
  return param.props?.[0];
}
// raw history buffer for the sparkline (a constant factor/weight scale would not
// change the line's shape, so pass the raw buffer straight through)
function sparkPoints(param: MonitorParam): number[] {
  const path = primaryPath(param);
  return path ? history(path) : [];
}
// tint the line by overall direction over the recent window
function sparkClass(param: MonitorParam): string {
  const path = primaryPath(param);
  const d = path ? delta(path) : null;
  if (d == null || d === 0) return "text-surface-400";
  return d > 0 ? "text-emerald-400" : "text-rose-400";
}

// ----- min/max/mean over the trend window (single-prop params) ----------------
function isSingleProp(param: MonitorParam): boolean {
  return (param.props?.length ?? 0) === 1;
}
// scaled stats for the primary path, honouring active unit/factor + weight
function scaledStats(param: MonitorParam) {
  const path = primaryPath(param);
  if (!path) return null;
  const s = stats(path, prefs.sparkWindowSec);
  if (!s) return null;
  return {
    min: scaled(param, s.min),
    max: scaled(param, s.max),
    mean: scaled(param, s.mean),
    last: scaled(param, s.last),
  };
}
function rangeLabel(param: MonitorParam): string {
  if (!isSingleProp(param)) return "";
  const s = scaledStats(param);
  if (!s) return "";
  const r = param.rounding ?? 0;
  return `${s.min.toFixed(r)}–${s.max.toFixed(r)}`;
}

// ----- hover detail popover ---------------------------------------------------
const detailRef = ref<any>(null);
const detailParam = ref<MonitorParam | null>(null);
function openDetail(e: Event, param: MonitorParam) {
  detailParam.value = param;
  detailRef.value?.show(e);
}
function closeDetail() {
  detailRef.value?.hide();
}
const detailStats = computed(() => (detailParam.value ? scaledStats(detailParam.value) : null));

// local collapse state seeded from the group's default so the user can still
// toggle it without changing the saved default
const collapsedState = ref(props.group.collapsed ?? false);
watch(
  () => props.group.collapsed,
  (v) => (collapsedState.value = v ?? false),
);

// ===== editor =================================================================
const modelNames = computed(() => {
  const m = (modelState.value as any)?.models;
  return m ? Object.keys(m).sort() : [];
});
// numeric props of a model, as {label,value} for the prop Select
function propOptions(model: string | null) {
  if (!model) return [];
  return getInterface(model)
    .filter((f) => f.type === "number" || f.type === "factor")
    .map((f) => ({ label: f.caption || f.target, value: f.target }));
}

// a path is "Model.prop" or "Model.sub.prop"; the model is the first segment
function pathModel(path: string | undefined): string | null {
  if (!path) return null;
  const i = path.indexOf(".");
  return i < 0 ? path : path.slice(0, i);
}
function pathProp(path: string | undefined): string | null {
  if (!path) return null;
  const i = path.indexOf(".");
  return i < 0 ? null : path.slice(i + 1);
}

const touch = () => store.persist();

// resolve a dot-path against the full model-state snapshot (works while paused),
// returning the live numeric value or undefined. Used to validate raw paths in
// the editor and show the current value (mirrors EventScheduler's "now:").
function resolvePath(path: string): number | undefined {
  if (!path) return undefined;
  const segs = path.split(".");
  let cur: any = (modelState.value as any)?.models?.[segs[0]];
  for (let i = 1; i < segs.length; i++) {
    if (cur == null) return undefined;
    cur = cur[segs[i]];
  }
  return typeof cur === "number" ? cur : undefined;
}
function resolveText(param: MonitorParam, idx: number): string {
  const v = resolvePath(getPath(param, idx));
  if (v === undefined) return "";
  return scaled(param, v).toFixed(param.rounding ?? 0);
}
function resolves(param: MonitorParam, idx: number): boolean {
  return resolvePath(getPath(param, idx)) !== undefined;
}

// ensure props[idx] exists, returning the current value
function getPath(param: MonitorParam, idx: number): string {
  return param.props?.[idx] ?? "";
}
function setPath(param: MonitorParam, idx: number, value: string) {
  if (!param.props) param.props = [];
  // trim a removed secondary path (empty trailing slot) rather than keep ""
  if (!value && idx === param.props.length - 1) param.props.splice(idx, 1);
  else param.props[idx] = value;
  touch();
}
function onModelPick(param: MonitorParam, idx: number, model: string) {
  // keep any existing prop segment if the model is unchanged, else reset it
  const prop = pathModel(getPath(param, idx)) === model ? pathProp(getPath(param, idx)) : null;
  setPath(param, idx, prop ? `${model}.${prop}` : `${model}.`);
}
function onPropPick(param: MonitorParam, idx: number, prop: string) {
  const model = pathModel(getPath(param, idx));
  if (!model) return;
  setPath(param, idx, `${model}.${prop}`);
  // auto-suggest display metadata from the interface (primary prop only,
  // and never clobber a label the user already typed)
  if (idx === 0) {
    const f = getInterface(model).find((x) => x.target === prop);
    if (f) {
      param.factor = f.factor ?? 1;
      param.rounding = f.rounding ?? 0;
      if (!param.label) param.label = f.caption || prop;
      touch();
    }
  }
}
function hasSecondProp(param: MonitorParam): boolean {
  return (param.props?.length ?? 0) > 1;
}
function addSecondProp(param: MonitorParam) {
  if (!param.props) param.props = [];
  if (param.props.length < 2) {
    param.props.push("");
    touch();
  }
}
function removeSecondProp(param: MonitorParam) {
  param.props?.splice(1);
  touch();
}
</script>

<template>
  <!-- ===== read-only ===== -->
  <Panel
    v-if="!editing"
    :header="group.title"
    toggleable
    v-model:collapsed="collapsedState"
    :class="editable && !group.enabled ? 'opacity-60' : ''"
  >
    <template v-if="editable" #icons>
      <Button
        v-tooltip.top="'Edit this group'"
        icon="pi pi-pencil"
        severity="secondary"
        size="small"
        text
        @click="editing = true"
      />
    </template>
    <div class="grid gap-1.5" :class="compact ? 'grid-cols-4' : 'grid-cols-2'">
      <div
        v-for="(p, i) in parameters"
        :key="i"
        class="border bg-surface-800/40 rounded flex flex-col gap-0.5 cursor-help transition-colors"
        :class="[
          compact ? 'px-1 py-0.5' : 'px-1.5 py-1',
          isHighlighted(p) ? 'border-amber-400 ring-1 ring-amber-400/60 highlighted' : 'border-surface-700',
        ]"
        @mouseenter="openDetail($event, p)"
        @mouseleave="closeDetail"
      >
        <span class="text-[10px] uppercase tracking-wide opacity-60 truncate">{{ p.label }}</span>
        <div :class="compact ? 'flex flex-col leading-none' : 'flex items-baseline gap-1'">
          <span
            class="font-semibold tabular-nums leading-none"
            :class="compact ? 'text-sm' : 'text-lg'"
          >{{ fmt(p) }}</span>
          <span class="text-[10px] opacity-50">{{ p.unit }}</span>
        </div>
        <template v-if="!compact">
          <span v-if="rangeLabel(p)" class="text-[10px] opacity-40 tabular-nums leading-none">
            {{ rangeLabel(p) }}
          </span>
          <Sparkline
            :points="sparkPoints(p)"
            :height="18"
            :class="sparkClass(p)"
            class="mt-0.5"
          />
        </template>
      </div>
    </div>

    <!-- shared hover-detail popover -->
    <Popover ref="detailRef">
      <div v-if="detailParam" class="flex flex-col gap-1.5 w-56 text-xs">
        <div class="flex items-baseline justify-between gap-2">
          <span class="font-semibold uppercase tracking-wide opacity-80">{{ detailParam.label }}</span>
          <span class="opacity-50">{{ detailParam.unit }}</span>
        </div>
        <Sparkline
          :points="sparkPoints(detailParam)"
          :width="216"
          :height="48"
          :class="sparkClass(detailParam)"
        />
        <div v-if="detailStats" class="grid grid-cols-4 gap-1 tabular-nums text-center">
          <div><div class="opacity-50">min</div>{{ detailStats.min.toFixed(detailParam.rounding ?? 0) }}</div>
          <div><div class="opacity-50">mean</div>{{ detailStats.mean.toFixed(detailParam.rounding ?? 0) }}</div>
          <div><div class="opacity-50">max</div>{{ detailStats.max.toFixed(detailParam.rounding ?? 0) }}</div>
          <div><div class="opacity-50">now</div>{{ detailStats.last.toFixed(detailParam.rounding ?? 0) }}</div>
        </div>
        <div class="opacity-40 break-all leading-tight">{{ (detailParam.props ?? []).join("  ·  ") }}</div>
      </div>
    </Popover>
  </Panel>

  <!-- ===== editing ===== -->
  <div v-else class="rounded border border-surface-700 p-2 flex flex-col gap-2">
    <!-- group header controls -->
    <div class="flex items-center gap-1.5">
      <InputText
        v-model="group.title"
        size="small"
        placeholder="Group title"
        class="flex-1 min-w-0"
        @update:model-value="touch"
      />
      <Button
        v-tooltip.top="'Move up'"
        icon="pi pi-chevron-up"
        severity="secondary"
        size="small"
        text
        @click="store.moveGroup(group.key, -1)"
      />
      <Button
        v-tooltip.top="'Move down'"
        icon="pi pi-chevron-down"
        severity="secondary"
        size="small"
        text
        @click="store.moveGroup(group.key, 1)"
      />
      <Button
        v-tooltip.top="'Delete group'"
        icon="pi pi-trash"
        severity="danger"
        size="small"
        text
        @click="store.removeGroup(group.key)"
      />
      <Button
        v-tooltip.top="'Done editing this group'"
        icon="pi pi-check"
        severity="primary"
        size="small"
        text
        @click="editing = false"
      />
    </div>
    <div class="flex items-center gap-3 text-xs">
      <label class="flex items-center gap-1.5">
        <ToggleSwitch v-model="group.enabled" @update:model-value="touch" />
        <span class="opacity-70">shown</span>
      </label>
      <label class="flex items-center gap-1.5">
        <ToggleSwitch v-model="group.collapsed" @update:model-value="touch" />
        <span class="opacity-70">collapsed by default</span>
      </label>
    </div>

    <!-- parameter rows -->
    <div
      v-for="(p, i) in parameters"
      :key="i"
      class="flex flex-col gap-1.5 rounded bg-surface-800/40 p-2"
    >
      <div class="flex items-center gap-2">
        <InputText
          v-model="p.label"
          size="small"
          placeholder="Label"
          class="flex-1 min-w-0"
          @update:model-value="touch"
        />
        <Button
          v-tooltip.top="'Move up'"
          icon="pi pi-chevron-up"
          severity="secondary"
          size="small"
          text
          @click="store.moveParam(group.key, i, -1)"
        />
        <Button
          v-tooltip.top="'Move down'"
          icon="pi pi-chevron-down"
          severity="secondary"
          size="small"
          text
          @click="store.moveParam(group.key, i, 1)"
        />
        <Button
          v-tooltip.top="'Remove'"
          icon="pi pi-times"
          severity="secondary"
          size="small"
          text
          @click="store.removeParam(group.key, i)"
        />
      </div>

      <!-- primary prop: model → prop, with raw-path escape hatch -->
      <div class="flex flex-col gap-1.5">
        <div class="flex gap-1.5">
          <Select
            :model-value="pathModel(getPath(p, 0))"
            :options="modelNames"
            filter
            placeholder="Model"
            size="small"
            class="flex-1 min-w-0"
            @update:model-value="(v: string) => onModelPick(p, 0, v)"
          />
          <Select
            :model-value="pathProp(getPath(p, 0))"
            :options="propOptions(pathModel(getPath(p, 0)))"
            option-label="label"
            option-value="value"
            filter
            placeholder="Property"
            size="small"
            class="flex-1 min-w-0"
            :disabled="!pathModel(getPath(p, 0))"
            @update:model-value="(v: string) => onPropPick(p, 0, v)"
          />
        </div>
        <InputText
          :model-value="getPath(p, 0)"
          size="small"
          placeholder="raw path e.g. Monitor.minmax.abp_pres_max"
          class="w-full"
          @update:model-value="(v: string | undefined) => setPath(p, 0, v ?? '')"
        />
        <div v-if="getPath(p, 0)" class="flex items-center gap-1 text-[11px] -mt-0.5">
          <i
            :class="resolves(p, 0)
              ? 'pi pi-check text-emerald-400'
              : 'pi pi-exclamation-triangle text-amber-400'"
            class="text-[10px]"
          />
          <span class="opacity-60">{{ resolves(p, 0) ? `now: ${resolveText(p, 0)}` : "not resolving" }}</span>
        </div>
      </div>

      <!-- optional secondary prop (renders the value as a/b) -->
      <div v-if="hasSecondProp(p)" class="flex flex-col gap-1">
        <div class="flex gap-1.5 items-center">
          <InputText
            :model-value="getPath(p, 1)"
            size="small"
            placeholder="2nd raw path"
            class="flex-1 min-w-0"
            @update:model-value="(v: string | undefined) => setPath(p, 1, v ?? '')"
          />
          <Button
            v-tooltip.top="'Remove 2nd value'"
            icon="pi pi-times"
            severity="secondary"
            size="small"
            text
            @click="removeSecondProp(p)"
          />
        </div>
        <div v-if="getPath(p, 1)" class="flex items-center gap-1 text-[11px]">
          <i
            :class="resolves(p, 1)
              ? 'pi pi-check text-emerald-400'
              : 'pi pi-exclamation-triangle text-amber-400'"
            class="text-[10px]"
          />
          <span class="opacity-60">{{ resolves(p, 1) ? `now: ${resolveText(p, 1)}` : "not resolving" }}</span>
        </div>
      </div>
      <Button
        v-else
        label="Add 2nd value (a/b)"
        icon="pi pi-plus"
        severity="secondary"
        size="small"
        text
        class="self-start"
        @click="addSecondProp(p)"
      />

      <!-- display metadata -->
      <div class="flex flex-wrap items-center gap-2 text-xs">
        <span class="opacity-60">unit</span>
        <InputText v-model="p.unit" size="small" class="w-16" @update:model-value="touch" />
        <span class="opacity-60">×</span>
        <InputNumber
          v-model="p.factor"
          :min-fraction-digits="0"
          :max-fraction-digits="6"
          size="small"
          class="w-20"
          :input-class="'w-full'"
          @update:model-value="touch"
        />
        <span class="opacity-60">dp</span>
        <InputNumber
          v-model="p.rounding"
          :min="0"
          :max="6"
          size="small"
          class="w-14"
          :input-class="'w-full'"
          @update:model-value="touch"
        />
        <label class="flex items-center gap-1 ml-auto">
          <ToggleSwitch v-model="p.weight_based" @update:model-value="touch" />
          <span class="opacity-60">/kg</span>
        </label>
      </div>
    </div>

    <Button
      label="Add parameter"
      icon="pi pi-plus"
      severity="secondary"
      size="small"
      text
      class="self-start"
      @click="store.addParam(group.key)"
    />
  </div>
</template>

<style scoped>
/* brief pulse when a card becomes highlighted, so the eye finds it */
.highlighted {
  animation: highlight-pulse 1.2s ease-out 2;
}
@keyframes highlight-pulse {
  0% {
    box-shadow: 0 0 0 0 rgb(251 191 36 / 0.6);
  }
  100% {
    box-shadow: 0 0 0 8px rgb(251 191 36 / 0);
  }
}
</style>
