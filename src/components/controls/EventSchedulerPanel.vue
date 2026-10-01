<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import Panel from "primevue/panel";
import Select from "primevue/select";
import InputNumber from "primevue/inputnumber";
import InputText from "primevue/inputtext";
import ToggleSwitch from "primevue/toggleswitch";
import Button from "primevue/button";
import ProgressBar from "primevue/progressbar";
import ConfirmDialog from "primevue/confirmdialog";
import { useConfirm } from "primevue/useconfirm";
import { useExplain } from "@/composables/useExplain";
import { useModelInterface, type InterfaceField } from "@/composables/useModelInterface";
import { useEventsStore, type EventChange, type ScheduledEvent } from "@/stores/events";

// Event scheduler. An *event* is a named bundle of property changes; each change
// picks a model + property (current value shown), a target value, and a ramp
// duration. Saved into the scenario JSON (configuration.events). Events can be
// applied on demand or armed to auto-fire at a chosen simulation time. The ramp
// mechanic is the engine's setPropValue(prop, value, it) — numeric props tween
// over `it` seconds; booleans/lists swap instantly (duration ignored).
const { modelState, setProp, slowValues, modelReady, refreshState } = useExplain();
const { getInterface } = useModelInterface();
const store = useEventsStore();

// types that are meaningfully settable as an event change (read-only string /
// reference / function / prop-list / dict are excluded)
const SETTABLE = new Set(["number", "factor", "boolean", "list"]);
type ChangeType = "number" | "boolean" | "list";
function normType(t: string): ChangeType {
  return t === "boolean" ? "boolean" : t === "list" ? "list" : "number";
}

// ----- builder state ----------------------------------------------------------
interface ChangeDraft {
  model: string | null;
  target: string | null;
  type: ChangeType;
  value: any; // DISPLAY value for numbers; raw for boolean/list
  it: number; // ramp seconds
  at: number; // delay seconds before the change starts
}
const editingId = ref<string | null>(null);
const eventName = ref("");
const fireAt = ref<number | null>(null);
const armed = ref(false);
const drafts = ref<ChangeDraft[]>([]);

const modelNames = computed(() => {
  const m = (modelState.value as any)?.models;
  return m ? Object.keys(m).sort() : [];
});
function instance(name: string | null): any {
  if (!name) return null;
  return (modelState.value as any)?.models?.[name] ?? null;
}
function fieldsOf(model: string | null): InterfaceField[] {
  if (!model) return [];
  return getInterface(model).filter((f) => SETTABLE.has(f.type));
}
// property-select options ({label, value}) for a model
function propOptions(model: string | null) {
  return fieldsOf(model).map((f) => ({ label: f.caption || f.target, value: f.target }));
}
function fieldOf(model: string | null, target: string | null): InterfaceField | undefined {
  if (!model || !target) return undefined;
  return getInterface(model).find((f) => f.target === target);
}
const numFactor = (f?: InterfaceField) => f?.factor ?? 1;
const toDisplay = (f: InterfaceField | undefined, raw: number) =>
  typeof raw === "number" ? raw * numFactor(f) : raw;
const toRaw = (f: InterfaceField | undefined, ui: number) => ui / numFactor(f);
// literal choices override model-type options when present (see ModelEditor)
function listOptions(f?: InterfaceField): string[] {
  if (!f) return [];
  const candidates = [f.custom_options ? f.choices : f.options, f.choices, f.options];
  return candidates.find((c) => Array.isArray(c) && c.length > 0) ?? [];
}
// current engine value, display-scaled for numbers
function currentValue(model: string | null, target: string | null) {
  const m = instance(model);
  const f = fieldOf(model, target);
  if (!m || !target || !(target in m)) return undefined;
  return f && (f.type === "number" || f.type === "factor") ? toDisplay(f, m[target]) : m[target];
}
function currentValueLabel(d: ChangeDraft): string {
  const v = currentValue(d.model, d.target);
  if (v === undefined) return "—";
  if (typeof v === "number") {
    const f = fieldOf(d.model, d.target);
    return v.toFixed(f?.rounding ?? 2);
  }
  return String(v);
}

function blankDraft(): ChangeDraft {
  return { model: null, target: null, type: "number", value: 0, it: 5, at: 0 };
}
function addDraft() {
  drafts.value.push(blankDraft());
}
function removeDraft(i: number) {
  drafts.value.splice(i, 1);
}
function onModelChange(d: ChangeDraft) {
  d.target = null;
  d.type = "number";
  d.value = 0;
}
// selecting a property seeds the target with the model's current value so the
// user adjusts from the live state
function onTargetChange(d: ChangeDraft) {
  const f = fieldOf(d.model, d.target);
  d.type = f ? normType(f.type) : "number";
  const cur = currentValue(d.model, d.target);
  d.value = d.type === "boolean" ? Boolean(cur) : d.type === "list" ? String(cur ?? "") : Number(cur ?? 0);
}

// ----- saved-event list -------------------------------------------------------
function changeSummary(c: EventChange): string {
  const f = fieldOf(c.model, c.target);
  const head =
    c.type === "number"
      ? `${c.model}.${c.target} → ${toDisplay(f, c.value as number)} over ${c.it}s`
      : `${c.model}.${c.target} → ${c.value}`;
  return c.at ? `${head} after ${c.at}s` : head;
}

function buildEvent(): ScheduledEvent {
  const changes: EventChange[] = drafts.value
    .filter((d) => d.model && d.target)
    .map((d) => {
      const f = fieldOf(d.model, d.target);
      const value =
        d.type === "number" ? toRaw(f, Number(d.value)) : d.type === "boolean" ? Boolean(d.value) : String(d.value);
      return {
        model: d.model as string,
        target: d.target as string,
        type: d.type,
        value,
        it: d.type === "number" ? Number(d.it) || 0 : 0,
        at: Number(d.at) || 0,
      };
    });
  return {
    id: editingId.value ?? (crypto.randomUUID?.() ?? String(Math.random())),
    name: eventName.value.trim() || "event",
    changes,
    fire_at: fireAt.value,
    armed: armed.value,
  };
}

const canSave = computed(
  () => eventName.value.trim().length > 0 && drafts.value.some((d) => d.model && d.target),
);

async function saveEvent() {
  if (!canSave.value) return;
  store.upsert(buildEvent());
  await store.persist();
  resetBuilder();
}
function resetBuilder() {
  editingId.value = null;
  eventName.value = "";
  fireAt.value = null;
  armed.value = false;
  drafts.value = [];
}
// load a saved event back into the builder (raw → display for numbers)
function editEvent(ev: ScheduledEvent) {
  editingId.value = ev.id;
  eventName.value = ev.name;
  fireAt.value = ev.fire_at;
  armed.value = ev.armed;
  drafts.value = ev.changes.map((c) => {
    const f = fieldOf(c.model, c.target);
    return {
      model: c.model,
      target: c.target,
      type: c.type,
      value: c.type === "number" ? toDisplay(f, c.value as number) : c.value,
      it: c.it,
      at: c.at ?? 0,
    };
  });
}
// Deleting can't be undone, so ask first — same dialog as deleting a saved
// state. Its own `group` keeps it from also opening SaveStatePanel's
// ConfirmDialog (both are mounted on MainPage at once).
const confirm = useConfirm();
function deleteEvent(ev: ScheduledEvent) {
  confirm.require({
    group: "events",
    message: `Delete event "${ev.name}"? This cannot be undone.`,
    header: "Delete event",
    icon: "pi pi-trash",
    acceptLabel: "Delete",
    rejectLabel: "Cancel",
    acceptProps: { severity: "danger" },
    accept: async () => {
      store.remove(ev.id);
      if (editingId.value === ev.id) resetBuilder();
      await store.persist();
    },
  });
}

// dispatch every change of an event to the engine now (at=0). Missing models
// (event references a model not in the loaded scenario) are skipped.
function applyEvent(ev: ScheduledEvent) {
  const models = (modelState.value as any)?.models ?? {};
  for (const c of ev.changes) {
    if (!models[c.model]) continue;
    setProp(`${c.model}.${c.target}`, c.value, c.it ?? 0, c.at ?? 0);
  }
  markRunning(ev);
}

// ----- running indicator ------------------------------------------------------
// An applied event's changes ramp over sim time: each change starts after `at`
// seconds and tweens over `it` seconds, so the event is "running" until the last
// change finishes. Track that sim-time window per event so the saved-event card
// can show a pulsing badge + progress bar (works for manual apply and auto-fire).
interface RunStatus {
  start: number;
  end: number;
}
const running = ref<Record<string, RunStatus>>({});
// longest (delay + ramp) across the event's changes = total run duration
function eventDuration(ev: ScheduledEvent): number {
  return ev.changes.reduce((m, c) => Math.max(m, (c.at ?? 0) + (c.it ?? 0)), 0);
}
function markRunning(ev: ScheduledEvent) {
  const start = simTime.value;
  const dur = eventDuration(ev);
  running.value = { ...running.value, [ev.id]: { start, end: start + dur } };
  // instant (zero-duration) events have no sim window to advance through, so the
  // sim-time watcher would never clear them — flash briefly on wall-clock instead.
  if (dur <= 0) window.setTimeout(() => clearRunning(ev.id), 1200);
}
function clearRunning(id: string) {
  if (!(id in running.value)) return;
  const next = { ...running.value };
  delete next[id];
  running.value = next;
  // the engine just settled the event's changed props, but `modelState` is a
  // static snapshot — pull a fresh one so the builder's "now:" reflects reality.
  refreshState();
}
function isRunning(id: string): boolean {
  return id in running.value;
}
// 0–100% through the run window (instant events render as a full-width flash)
function runProgress(id: string): number {
  const r = running.value[id];
  if (!r) return 0;
  if (r.end <= r.start) return 100;
  const p = ((simTime.value - r.start) / (r.end - r.start)) * 100;
  return Math.max(0, Math.min(100, p));
}

// ----- auto-fire --------------------------------------------------------------
// Watch the ~1 Hz slow stream's `time` field. Fire each armed event with a
// fire_at once when sim time crosses it. A backwards jump (reload / restart)
// clears the fired set so events can fire again on the next run.
const firedIds = new Set<string>();
const simTime = ref(0);
watch(slowValues, (rows: any) => {
  if (!Array.isArray(rows) || rows.length === 0) return;
  const now = rows[rows.length - 1]?.time;
  if (typeof now !== "number") return;
  if (now < simTime.value) {
    firedIds.clear();
    running.value = {}; // sim restarted/reloaded — drop any stale running flags
  }
  simTime.value = now;
  for (const ev of store.events) {
    if (ev.armed && ev.fire_at != null && !firedIds.has(ev.id) && now >= ev.fire_at) {
      applyEvent(ev);
      firedIds.add(ev.id);
    }
  }
  // retire ramped events whose sim-time window has elapsed
  for (const [id, r] of Object.entries(running.value)) {
    if (r.end > r.start && now >= r.end) clearRunning(id);
  }
});

// (re)load events whenever a scenario finishes (re)building
watch(modelReady, (ready) => {
  if (ready) {
    store.syncFromScenario();
    firedIds.clear();
    running.value = {};
    simTime.value = 0;
  }
});
onMounted(() => modelReady.value && store.syncFromScenario());
</script>

<template>
  <Panel header="Event scheduler" toggleable>
    <div class="flex flex-col gap-4">
      <!-- ===== Builder ===== -->
      <div class="flex flex-col gap-3 border border-surface-700 rounded p-3">
        <div class="flex items-center gap-2">
          <InputText
            v-model="eventName"
            placeholder="Event name"
            size="small"
            class="flex-1"
          />
          <span v-if="editingId" class="text-xs opacity-60">editing</span>
        </div>

        <div class="flex items-center gap-3 text-sm">
          <label class="opacity-80">fire at (s)</label>
          <InputNumber
            v-model="fireAt"
            :min="0"
            placeholder="manual"
            size="small"
            class="w-24"
            :input-class="'w-full'"
          />
          <label class="opacity-80 ml-auto">armed</label>
          <ToggleSwitch v-model="armed" />
        </div>

        <!-- change rows -->
        <div class="flex flex-col gap-2">
          <div
            v-for="(d, i) in drafts"
            :key="i"
            class="flex flex-col gap-1.5 rounded bg-surface-800/40 p-2"
          >
            <div class="flex items-start gap-2">
              <div class="flex flex-1 min-w-0 flex-col gap-1.5">
                <Select
                  v-model="d.model"
                  :options="modelNames"
                  filter
                  placeholder="Model"
                  size="small"
                  class="w-full min-w-0"
                  @update:model-value="onModelChange(d)"
                />
                <Select
                  v-model="d.target"
                  :options="propOptions(d.model)"
                  option-label="label"
                  option-value="value"
                  filter
                  placeholder="Property"
                  size="small"
                  class="w-full min-w-0"
                  :disabled="!d.model"
                  @update:model-value="onTargetChange(d)"
                />
              </div>
              <Button
                v-tooltip.top="'Remove change'"
                icon="pi pi-times"
                severity="secondary"
                size="small"
                text
                class="shrink-0"
                @click="removeDraft(i)"
              />
            </div>

            <template v-if="d.target">
              <!-- value-change line: now → target -->
              <div class="flex flex-wrap items-center gap-2 text-sm">
                <span class="opacity-60 truncate max-w-full">now: {{ currentValueLabel(d) }}</span>

                <span class="opacity-80">→</span>

                <!-- target value control by type -->
                <InputNumber
                  v-if="d.type === 'number'"
                  v-model="d.value"
                  :min="fieldOf(d.model, d.target)?.ll"
                  :max="fieldOf(d.model, d.target)?.ul"
                  :step="fieldOf(d.model, d.target)?.delta || 1"
                  :max-fraction-digits="fieldOf(d.model, d.target)?.rounding ?? 4"
                  size="small"
                  class="w-24"
                  :input-class="'w-full'"
                />
                <ToggleSwitch
                  v-else-if="d.type === 'boolean'"
                  v-model="d.value"
                />
                <Select
                  v-else-if="d.type === 'list'"
                  v-model="d.value"
                  :options="listOptions(fieldOf(d.model, d.target))"
                  size="small"
                  class="w-32"
                />
              </div>

              <!-- timing line: ramp duration + start delay -->
              <div class="flex flex-wrap items-center gap-2 text-sm">
                <!-- ramp duration: numbers only -->
                <template v-if="d.type === 'number'">
                  <span class="opacity-60">over</span>
                  <InputNumber
                    v-model="d.it"
                    :min="0"
                    :step="1"
                    suffix=" s"
                    size="small"
                    class="w-20"
                    :input-class="'w-full'"
                  />
                </template>

                <!-- start delay: all types -->
                <span class="opacity-60">after</span>
                <InputNumber
                  v-model="d.at"
                  :min="0"
                  :step="1"
                  suffix=" s"
                  size="small"
                  class="w-20"
                  :input-class="'w-full'"
                />
              </div>
            </template>
          </div>
        </div>

        <div class="flex items-center gap-2">
          <Button
            label="Add change"
            icon="pi pi-plus"
            severity="secondary"
            size="small"
            text
            @click="addDraft"
          />
          <Button
            v-if="editingId"
            label="Cancel"
            severity="secondary"
            size="small"
            text
            class="ml-auto"
            @click="resetBuilder"
          />
          <Button
            label="Save event"
            icon="pi pi-check"
            size="small"
            :class="editingId ? '' : 'ml-auto'"
            :disabled="!canSave"
            @click="saveEvent"
          />
        </div>
      </div>

      <!-- ===== Saved events ===== -->
      <div class="flex flex-col gap-2">
        <span class="text-sm opacity-70">Saved events</span>
        <p v-if="!store.events.length" class="text-sm opacity-50">
          No saved events yet.
        </p>
        <div
          v-for="ev in store.events"
          :key="ev.id"
          class="flex flex-col gap-1 rounded border p-2 transition-colors"
          :class="isRunning(ev.id) ? 'border-primary-500' : 'border-surface-700'"
        >
          <div class="flex items-center gap-2">
            <span class="font-medium text-sm flex-1 truncate">{{ ev.name }}</span>
            <span
              v-if="isRunning(ev.id)"
              class="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-primary-700/60"
            >
              <i class="pi pi-spin pi-spinner text-[0.7rem]" />
              running
            </span>
            <span
              v-else-if="ev.fire_at != null"
              class="text-xs px-1.5 py-0.5 rounded"
              :class="ev.armed ? 'bg-primary-700/50' : 'bg-surface-700'"
            >
              @{{ ev.fire_at }}s{{ ev.armed ? " · armed" : "" }}
            </span>
            <Button
              v-tooltip.top="isRunning(ev.id) ? 'Running…' : 'Apply now'"
              :icon="isRunning(ev.id) ? 'pi pi-spin pi-spinner' : 'pi pi-play'"
              severity="secondary"
              size="small"
              @click="applyEvent(ev)"
            />
            <Button
              v-tooltip.top="'Edit'"
              icon="pi pi-pencil"
              severity="secondary"
              size="small"
              text
              @click="editEvent(ev)"
            />
            <Button
              v-tooltip.top="'Delete'"
              icon="pi pi-trash"
              severity="danger"
              size="small"
              text
              @click="deleteEvent(ev)"
            />
          </div>
          <ul class="text-xs opacity-70 pl-1">
            <li v-for="(c, ci) in ev.changes" :key="ci">{{ changeSummary(c) }}</li>
          </ul>
          <ProgressBar
            v-if="isRunning(ev.id)"
            :value="runProgress(ev.id)"
            :show-value="false"
            class="h-1.5 mt-1"
          />
        </div>
      </div>
    </div>
    <ConfirmDialog group="events" />
  </Panel>
</template>
