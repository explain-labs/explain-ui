<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, computed, watch } from "vue";
import { storeToRefs } from "pinia";
import Select from "primevue/select";
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import InputGroup from "primevue/inputgroup";
import Tabs from "primevue/tabs";
import TabList from "primevue/tablist";
import Tab from "primevue/tab";
import TabPanels from "primevue/tabpanels";
import TabPanel from "primevue/tabpanel";
import { useRouter } from "vue-router";
import { useModelStore } from "@/stores/model";
import { useAuthStore } from "@/stores/auth";
import { useStatesStore } from "@/stores/states";
import { useMonitorsStore } from "@/stores/monitors";
import { useMonitorPrefs } from "@/composables/useMonitorPrefs";
import { useExplain } from "@/composables/useExplain";
import { formatParam } from "@/utils/monitorFormat";
import { copyText, downloadText } from "@/utils/csv";
import Popover from "primevue/popover";
import RealtimeChart from "@/components/host/RealtimeChart.vue";
import Diagram from "@/components/host/Diagram.vue";
import ModelEditor from "@/components/controls/ModelEditor.vue";
import ScalerPanel from "@/components/controls/ScalerPanel.vue";
import CommonTasksPanel from "@/components/controls/CommonTasksPanel.vue";
import VentilatorPanel from "@/components/controls/VentilatorPanel.vue";
import EclsPanel from "@/components/controls/EclsPanel.vue";
import ResuscitationPanel from "@/components/controls/ResuscitationPanel.vue";
import PregnancyPanel from "@/components/controls/PregnancyPanel.vue";
import EventSchedulerPanel from "@/components/controls/EventSchedulerPanel.vue";
import SaveStatePanel from "@/components/controls/SaveStatePanel.vue";
import AdminUsersButton from "@/components/controls/AdminUsersButton.vue";
import NumericReadoutPanel from "@/components/numerics/NumericReadoutPanel.vue";
import ChatPanel from "@/components/controls/ChatPanel.vue";
import LoopChart from "@/components/host/LoopChart.vue";
import Monitor from "@/components/host/Monitor.vue";
import VentilatorScope from "@/components/host/VentilatorScope.vue";
import DocViewer from "@/components/host/DocViewer.vue";
import { listLessons } from "@/lessons/index";
import { t as tl } from "@/lessons/i18n";
import { useLayoutStore } from "@/stores/layout";
import { useTour } from "@/composables/useTour";
import TourOverlay from "@/components/manual/TourOverlay.vue";
import ManualMenu from "@/components/manual/ManualMenu.vue";

const store = useModelStore();
const auth = useAuthStore();
const router = useRouter();
const { scenarios, current } = storeToRefs(store);

async function logout() {
  await auth.logout();
  router.push({ name: "login" });
}
const { model, status, modelReady, isRunning, error, load, loadFromObject, start, stop, calculate, slowValues, modelState } =
  useExplain();
const statesStore = useStatesStore();
const monitorsStore = useMonitorsStore();

// SharedArrayBuffer transport is active only when cross-origin isolated.
const isolated = globalThis.crossOriginIsolated === true;
const calcSecs = ref(10);
const CALC_OPTIONS = [5, 10, 30, 60, 120, 300]; // seconds to calculate
// active tab per column; in a store so the interactive manual can switch them
const { controlTab, vizTab, monitorTab } = storeToRefs(useLayoutStore());
const tour = useTour();
// first visit (no manual progress stored yet): offer the getting-started tour
const offerTour = ref(!auth.lesson && tour.isFirstVisit());
function dismissTourOffer(take: boolean) {
  offerTour.value = false;
  tour.markSeen();
  if (take) tour.start("getting-started");
}
const editingMonitors = ref(false); // inline edit mode for the monitoring panel
const monitorPrefs = useMonitorPrefs(); // compact / unitSystem / sparkWindowSec (persisted)
const TREND_WINDOWS = [
  { label: "30s", value: 30 },
  { label: "1m", value: 60 },
  { label: "5m", value: 300 },
];

// ----- snapshot / export of the visible readout -------------------------------
const exportRef = ref<any>(null);
function latestSlowRow(): Record<string, any> | null {
  const arr = slowValues.value as any[];
  return Array.isArray(arr) && arr.length ? arr[arr.length - 1] : null;
}
function snapshotRows() {
  const l = latestSlowRow();
  const w = (modelState.value as any)?.weight ?? 1;
  const rows: { group: string; label: string; value: string; unit: string }[] = [];
  for (const g of monitorGroups.value) {
    for (const p of g.parameters ?? []) {
      rows.push({ group: g.title, label: p.label, value: formatParam(p, l, w), unit: p.unit ?? "" });
    }
  }
  return rows;
}
function simTime(): number {
  return Number(latestSlowRow()?.time ?? 0);
}
const q = (s: string) => `"${String(s).replace(/"/g, '""')}"`;
function snapshotCsv(): string {
  const t = simTime().toFixed(1);
  const header = ["group", "label", "value", "unit", "sim_time"].join(",");
  const lines = snapshotRows().map((r) => [q(r.group), q(r.label), q(r.value), q(r.unit), t].join(","));
  return [header, ...lines].join("\n");
}
function snapshotTsv(): string {
  return snapshotRows()
    .map((r) => [r.group, r.label, r.value, r.unit].join("\t"))
    .join("\n");
}
async function copySnapshot() {
  await copyText(snapshotTsv());
  exportRef.value?.hide();
}
function downloadSnapshot() {
  const name = (model as any).loadedFileData?.name || current.value || "snapshot";
  downloadText(`vitals_${name}_${simTime().toFixed(0)}s.csv`, snapshotCsv());
  exportRef.value?.hide();
}

// Monitor groups come from the monitors store, which mirrors the loaded
// scenario's `configuration.monitors` and persists edits back. Synced on every
// (re)build (modelReady). In edit mode every group is shown (so disabled ones
// can be re-enabled); read-only mode hides disabled groups.
const monitorGroups = computed(() =>
  editingMonitors.value
    ? monitorsStore.groups
    : monitorsStore.groups.filter((g) => g.enabled !== false),
);
watch(
  modelReady,
  (ready) => {
    if (ready) monitorsStore.syncFromScenario();
    else editingMonitors.value = false;
  },
  { immediate: true },
);

// dashboard switcher options
const dashboardOptions = computed(() =>
  monitorsStore.dashboards.map((d) => ({ label: d.name, value: d.id })),
);

// Name of the scenario / saved state currently loaded into the engine. Keyed on
// modelReady (toggles false→true on every (re)build) so it re-derives per load;
// uses the definition's embedded `name`, falling back to the selected scenario.
const loadedName = computed(() => {
  if (!modelReady.value) return null;
  return (model as any).loadedFileData?.name || current.value || null;
});

const DEFAULT_SCENARIO = "term_neonate";

// guided lesson pages (/lesson/:id), linked from the header for non-lesson users
const lessons = listLessons();
const lessonsRef = ref<any>(null);

// selecting a scenario loads it immediately (no Load button needed)
watch(current, (name) => {
  if (name) {
    load(name);
    statesStore.setCurrent(null); // a local scenario isn't a cloud state
  }
});

// Load the scenario a nicupicu.nl lesson account starts from: its curated cloud
// state if set, else its bundled scenario. Returns false if neither is available.
async function loadLesson(): Promise<boolean> {
  const l = auth.lesson;
  if (!l) return false;
  if (l.stateId) {
    const file = await statesStore.loadState(l.stateId);
    if (file) {
      loadFromObject(file);
      return true;
    }
  }
  if (l.scenario && scenarios.value.includes(l.scenario)) {
    // re-selecting the same name doesn't trigger the watcher, so load directly
    if (current.value === l.scenario) load(l.scenario);
    else current.value = l.scenario;
    return true;
  }
  return false;
}

onMounted(async () => {
  await store.fetchScenarios();
  const u = auth.user;
  // Startup priority:
  // 0. A lesson account (nicupicu.nl launch) always opens its own lesson.
  if (u?.lesson && (await loadLesson())) return;
  // 1. A model developer's chosen LOCAL scenario (highest priority).
  if (u?.modelDeveloper && u.defaultLocalState && scenarios.value.includes(u.defaultLocalState)) {
    current.value = u.defaultLocalState; // watcher loads it (and clears cloud currentId)
    return;
  }
  // 2. The user's default CLOUD state.
  if (u?.defaultState) {
    const file = await statesStore.loadState(u.defaultState);
    if (file) {
      loadFromObject(file);
      return;
    }
  }
  // 3. The bundled scenario.
  current.value = scenarios.value.includes(DEFAULT_SCENARIO)
    ? DEFAULT_SCENARIO
    : (scenarios.value[0] ?? null);
});

// model-developer preference: flag the selected local scenario as the one to load
// at startup (overrides the cloud default). Click again to clear it.
function toggleDefaultLocal() {
  if (!current.value) return;
  const next = auth.user?.defaultLocalState === current.value ? null : current.value;
  // In dev the developer account isn't backed by MongoDB — persist the choice to
  // localStorage instead of POSTing to /api/states/set-default-local.
  if (import.meta.env.DEV) auth.setDefaultLocalState(next);
  else statesStore.setDefaultLocal(next);
}

// delete a model definition file from public/model_definitions (dev endpoint)
async function deleteScenario(name: string) {
  if (!window.confirm(`Delete model definition "${name}"? This removes the file.`)) return;
  try {
    const res = await fetch("/api/delete-snapshot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    // a missing endpoint (stale dev server) falls through to the SPA → HTML 200,
    // so verify we actually got the JSON {ok:true} the endpoint returns.
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.ok) {
      throw new Error(
        body?.error ||
          `delete endpoint unavailable (status ${res.status}) — restart the dev server (npm run dev)`,
      );
    }
    if (current.value === name) current.value = null; // keep model loaded, clear selection
    await store.fetchScenarios();
  } catch (err) {
    console.error("delete model definition failed", err);
    window.alert(`Delete failed: ${(err as Error).message}`);
  }
}

function onStart() {
  // chart series are managed by the Chart panel (model→parameter selectors);
  // the PV-loop and ECG add their own channels. Just run.
  start();
}

// single play/stop toggle for realtime
function toggleRun() {
  if (isRunning.value) stop();
  else onStart();
}

// Spacebar toggles play/stop — but only when the user isn't typing in a field
// (inputs, textareas, selects, contenteditable) so it doesn't hijack text entry.
function onKeydown(e: KeyboardEvent) {
  if (e.code !== "Space" && e.key !== " ") return;
  if (e.repeat || !modelReady.value) return;
  const t = e.target as HTMLElement | null;
  if (
    t &&
    (t.isContentEditable ||
      ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(t.tagName))
  )
    return;
  e.preventDefault(); // stop the page from scrolling
  toggleRun();
}
onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <div class="p-4 flex flex-col gap-4 min-h-screen">
    <!-- Title + status, pinned to the top of the screen -->
    <div
      data-tour="layout.header"
      class="sticky top-0 z-20 -mx-4 -mt-4 mb-2 flex items-center gap-3 flex-wrap border-b border-surface-700 bg-surface-900 px-4 py-2"
    >
      <img
        src="/logo/explain-labs-logo.svg"
        alt="Explain Labs"
        class="h-12 w-auto shrink-0"
      />
      <span v-if="loadedName" class="min-w-0 truncate text-sm" v-tooltip.bottom="'Loaded state'">
        <span class="opacity-50">Active state:</span>
        <span class="ml-1 font-medium text-surface-100">{{ loadedName }}</span>
      </span>
      <div class="ml-auto flex items-center gap-3">
        <span
          v-if="offerTour && modelReady"
          class="flex items-center gap-1 rounded border border-amber-400/40 bg-amber-400/10 py-0.5 pl-2 text-sm"
        >
          New here?
          <Button label="Take the tour" size="small" text @click="dismissTourOffer(true)" />
          <Button
            icon="pi pi-times"
            size="small"
            severity="secondary"
            text
            aria-label="Dismiss"
            @click="dismissTourOffer(false)"
          />
        </span>
        <ManualMenu v-if="!auth.lesson" />
        <template v-if="auth.lesson">
          <span class="text-sm" v-tooltip.bottom="'nicupicu.nl lesson'">
            <i class="pi pi-book mr-1 opacity-60"></i>
            <span class="font-medium text-surface-100">{{ auth.lesson.title }}</span>
          </span>
          <Button
            icon="pi pi-refresh"
            label="Restart lesson"
            size="small"
            severity="secondary"
            text
            @click="loadLesson"
          />
        </template>
        <template v-else-if="lessons.length">
          <Button
            data-tour="header.lessons"
            icon="pi pi-book"
            label="Lessons"
            size="small"
            severity="secondary"
            text
            @click="lessonsRef?.toggle($event)"
          />
          <Popover ref="lessonsRef">
            <div class="flex flex-col gap-1">
              <Button
                v-for="l in lessons"
                :key="l.id"
                :label="tl(l.title, 'en')"
                size="small"
                severity="secondary"
                text
                @click="router.push({ name: 'lesson', params: { id: l.id } })"
              />
            </div>
          </Popover>
        </template>
        <span v-if="!auth.lesson && auth.user" class="text-sm opacity-70">{{ auth.user.email }}</span>
        <AdminUsersButton v-if="auth.user?.admin && auth.hasDb" />
        <Button
          icon="pi pi-sign-out"
          label="Sign out"
          size="small"
          severity="secondary"
          text
          @click="logout"
        />
      </div>
    </div>

    <!-- Parameters (left 1/4) · Diagram/Chart/PV-loop tabs (center 1/2) · Numerics/patient monitor/ventilator graphs (right 1/4) -->
    <div v-if="modelReady" class="flex flex-col lg:flex-row gap-3 items-start">
      <div class="w-full lg:w-1/4 min-w-0" data-tour="layout.controls">
        <Tabs v-model:value="controlTab">
          <TabList data-tour="tabs.control">
            <Tab value="editor" data-tour="tab.control.editor" v-tooltip.top="'Model editor'" aria-label="Model editor">
              <i class="pi pi-sliders-h"></i>
            </Tab>
            <Tab value="tasks" data-tour="tab.control.tasks" v-tooltip.top="'Common tasks'" aria-label="Common tasks">
              <i class="pi pi-bolt"></i>
            </Tab>
            <Tab value="ventilator" data-tour="tab.control.ventilator" v-tooltip.top="'Ventilator'" aria-label="Ventilator">
              <i class="pi pi-cloud"></i>
            </Tab>
            <Tab value="ecls" data-tour="tab.control.ecls" v-tooltip.top="'ECLS'" aria-label="ECLS">
              <i class="pi pi-sync"></i>
            </Tab>
            <Tab value="resuscitation" data-tour="tab.control.resuscitation" v-tooltip.top="'Resuscitation'" aria-label="Resuscitation">
              <i class="pi pi-heart"></i>
            </Tab>
            <Tab value="pregnancy" data-tour="tab.control.pregnancy" v-tooltip.top="'Pregnancy / Labor'" aria-label="Pregnancy / Labor">
              <i class="pi pi-venus"></i>
            </Tab>
            <Tab value="scaler" data-tour="tab.control.scaler" v-tooltip.top="'Scaler'" aria-label="Scaler">
              <i class="pi pi-expand"></i>
            </Tab>
            <Tab value="events" data-tour="tab.control.events" v-tooltip.top="'Event scheduler'" aria-label="Event scheduler">
              <i class="pi pi-clock"></i>
            </Tab>
          </TabList>
          <TabPanels>
            <TabPanel value="editor">
              <div class="flex flex-col gap-3">
                <ModelEditor />
              </div>
            </TabPanel>
            <TabPanel value="tasks">
              <div class="flex flex-col gap-3">
                <CommonTasksPanel />
              </div>
            </TabPanel>
            <TabPanel value="ventilator">
              <div class="flex flex-col gap-3">
                <VentilatorPanel />
              </div>
            </TabPanel>
            <TabPanel value="ecls">
              <div class="flex flex-col gap-3">
                <EclsPanel />
              </div>
            </TabPanel>
            <TabPanel value="resuscitation">
              <div class="flex flex-col gap-3">
                <ResuscitationPanel />
              </div>
            </TabPanel>
            <TabPanel value="pregnancy">
              <div class="flex flex-col gap-3">
                <PregnancyPanel />
              </div>
            </TabPanel>
            <TabPanel value="scaler">
              <div class="flex flex-col gap-3">
                <ScalerPanel />
              </div>
            </TabPanel>
            <TabPanel value="events">
              <div class="flex flex-col gap-3">
                <EventSchedulerPanel />
              </div>
            </TabPanel>
          </TabPanels>
        </Tabs>
      </div>
      <div class="w-full lg:w-1/2 min-w-0" data-tour="layout.viz">
        <Tabs v-model:value="vizTab">
          <TabList data-tour="tabs.viz">
            <Tab value="diagram" data-tour="tab.viz.diagram" v-tooltip.top="'Diagram'" aria-label="Diagram">
              <i class="pi pi-sitemap"></i>
            </Tab>
            <Tab value="chart" data-tour="tab.viz.chart" v-tooltip.top="'Chart'" aria-label="Chart">
              <i class="pi pi-chart-line"></i>
            </Tab>
            <Tab value="loop" data-tour="tab.viz.loop" v-tooltip.top="'PV-loop'" aria-label="PV-loop">
              <i class="pi pi-chart-scatter"></i>
            </Tab>
            <Tab value="chat" data-tour="tab.viz.chat" v-tooltip.top="'Explain AI Bot'" aria-label="Explain AI Bot">
              <i class="pi pi-comments"></i>
            </Tab>
            <Tab value="docs" data-tour="tab.viz.docs" v-tooltip.top="'Documentation'" aria-label="Documentation">
              <i class="pi pi-book"></i>
            </Tab>
          </TabList>
          <TabPanels>
            <TabPanel value="diagram">
              <Diagram data-tour="diagram.canvas" :highlight="tour.diagramHighlight.value" />
            </TabPanel>
            <TabPanel value="chart">
              <RealtimeChart />
            </TabPanel>
            <TabPanel value="loop">
              <LoopChart />
            </TabPanel>
            <TabPanel value="chat">
              <ChatPanel />
            </TabPanel>
            <TabPanel value="docs">
              <DocViewer />
            </TabPanel>
          </TabPanels>
        </Tabs>
      </div>
      <div class="w-full lg:w-1/4 min-w-0" data-tour="layout.monitors">
        <Tabs v-model:value="monitorTab">
          <TabList data-tour="tabs.monitor">
            <Tab value="monitoring" data-tour="tab.monitor.monitoring" v-tooltip.top="'Monitoring'" aria-label="Monitoring">
              <i class="pi pi-gauge"></i>
            </Tab>
            <Tab value="monitor" data-tour="tab.monitor.monitor" v-tooltip.top="'Patient monitor'" aria-label="Patient monitor">
              <i class="pi pi-desktop"></i>
            </Tab>
            <Tab value="ventilator" data-tour="tab.monitor.ventilator" v-tooltip.top="'Ventilator graphs'" aria-label="Ventilator graphs">
              <i class="pi pi-cloud"></i>
            </Tab>
          </TabList>
          <TabPanels>
            <TabPanel value="monitoring">
              <div class="flex flex-col gap-3">
                <div class="flex items-center justify-end gap-1.5" data-tour="monitoring.toolbar">
                  <Button
                    v-if="!editingMonitors"
                    v-tooltip.top="'Export readout'"
                    icon="pi pi-download"
                    severity="secondary"
                    size="small"
                    text
                    :disabled="!modelReady"
                    @click="exportRef?.toggle($event)"
                  />
                  <Popover ref="exportRef">
                    <div class="flex flex-col gap-1">
                      <Button
                        label="Copy to clipboard"
                        icon="pi pi-copy"
                        severity="secondary"
                        size="small"
                        text
                        @click="copySnapshot"
                      />
                      <Button
                        label="Download CSV"
                        icon="pi pi-file"
                        severity="secondary"
                        size="small"
                        text
                        @click="downloadSnapshot"
                      />
                    </div>
                  </Popover>
                  <Button
                    v-if="editingMonitors"
                    data-tour="monitoring.addgroup"
                    v-tooltip.top="'Add group'"
                    icon="pi pi-plus"
                    label="Group"
                    severity="secondary"
                    size="small"
                    :disabled="!modelReady"
                    @click="monitorsStore.addGroup()"
                  />
                  <Select
                    v-if="!editingMonitors && !monitorPrefs.compact"
                    v-model="monitorPrefs.sparkWindowSec"
                    v-tooltip.top="'Trend window'"
                    :options="TREND_WINDOWS"
                    option-label="label"
                    option-value="value"
                    size="small"
                    :disabled="!modelReady"
                  />
                  <Button
                    v-if="!editingMonitors"
                    v-tooltip.top="monitorPrefs.compact ? 'Show sparklines' : 'Compact view'"
                    :icon="monitorPrefs.compact ? 'pi pi-chart-line' : 'pi pi-bars'"
                    :severity="monitorPrefs.compact ? 'primary' : 'secondary'"
                    size="small"
                    text
                    :disabled="!modelReady"
                    @click="monitorPrefs.compact = !monitorPrefs.compact"
                  />
                  <Button
                    data-tour="monitoring.manage"
                    v-tooltip.top="editingMonitors ? 'Done managing' : 'Manage monitors'"
                    :icon="editingMonitors ? 'pi pi-check' : 'pi pi-pencil'"
                    :severity="editingMonitors ? 'primary' : 'secondary'"
                    size="small"
                    text
                    :disabled="!modelReady"
                    @click="editingMonitors = !editingMonitors"
                  />
                </div>

                <!-- dashboard switcher -->
                <Select
                  v-if="monitorsStore.dashboards.length > 1 || editingMonitors"
                  :model-value="monitorsStore.activeId"
                  :options="dashboardOptions"
                  option-label="label"
                  option-value="value"
                  size="small"
                  class="w-full"
                  :disabled="!modelReady"
                  @update:model-value="monitorsStore.setActive"
                />

                <!-- dashboard management (manage mode) -->
                <div
                  v-if="editingMonitors"
                  data-tour="monitoring.dashboards"
                  class="flex flex-col gap-1.5 rounded border border-surface-700 p-2"
                >
                  <div class="flex items-center gap-1.5">
                    <InputText
                      :model-value="monitorsStore.activeDashboard?.name"
                      placeholder="Dashboard name"
                      size="small"
                      class="flex-1 min-w-0"
                      @update:model-value="(v: string | undefined) => monitorsStore.renameDashboard(monitorsStore.activeId, v ?? '')"
                    />
                    <Button
                      v-tooltip.top="'Move dashboard up'"
                      icon="pi pi-chevron-up"
                      severity="secondary"
                      size="small"
                      text
                      @click="monitorsStore.moveDashboard(monitorsStore.activeId, -1)"
                    />
                    <Button
                      v-tooltip.top="'Move dashboard down'"
                      icon="pi pi-chevron-down"
                      severity="secondary"
                      size="small"
                      text
                      @click="monitorsStore.moveDashboard(monitorsStore.activeId, 1)"
                    />
                    <Button
                      v-tooltip.top="'Delete dashboard'"
                      icon="pi pi-trash"
                      severity="danger"
                      size="small"
                      text
                      :disabled="monitorsStore.dashboards.length <= 1"
                      @click="monitorsStore.removeDashboard(monitorsStore.activeId)"
                    />
                  </div>
                  <Button
                    label="Add dashboard"
                    icon="pi pi-plus"
                    severity="secondary"
                    size="small"
                    text
                    class="self-start"
                    @click="monitorsStore.addDashboard()"
                  />
                </div>

                <NumericReadoutPanel
                  v-for="g in monitorGroups"
                  :key="g.key"
                  :group="g"
                  :editable="editingMonitors"
                  :compact="monitorPrefs.compact"
                  :highlight="tour.numericHighlight.value"
                />
                <p
                  v-if="editingMonitors && !monitorGroups.length"
                  class="text-sm opacity-50 text-center py-2"
                >
                  No monitor groups. Add one to start.
                </p>
              </div>
            </TabPanel>
            <TabPanel value="monitor">
              <!-- shorter than the component default to suit the narrow column -->
              <Monitor
                data-tour="monitor.canvas"
                height="35vh"
                min-height="260px"
                :highlight="tour.monitorHighlight.value"
              />
            </TabPanel>
            <TabPanel value="ventilator">
              <VentilatorScope height="35vh" min-height="260px" />
            </TabPanel>
          </TabPanels>
        </Tabs>
      </div>
    </div>

    <!-- Status (left) · run/calculate controls (center) · model loading (right) -->
    <div
      data-tour="layout.bottombar"
      class="compact-bar sticky bottom-0 z-20 -mx-4 -mb-4 mt-auto grid grid-cols-3 items-center gap-1.5 border-t border-surface-700 bg-surface-900 px-3 py-1 text-sm"
    >
      <!-- left: COI / ready indicators + status -->
      <div class="flex items-center gap-3 flex-wrap justify-self-start" data-tour="run.status">
        <span class="flex items-center gap-3 flex-wrap opacity-70">
          <span>COI: <b>{{ isolated }}</b></span>
          <span>MODEL LOADED: <b>{{ modelReady }}</b></span>
          <span v-if="error" class="text-red-400">error: {{ error }}</span>
        </span>
        <span class="opacity-70">STATUS: <b>{{ status }}</b></span>
      </div>

      <!-- center: play / stop / calculate -->
      <div class="flex items-center gap-1.5 justify-self-center">
        <Button
          data-tour="run.start"
          v-tooltip.top="isRunning ? 'Stop (Space)' : 'Start (Space)'"
          :icon="isRunning ? 'pi pi-stop' : 'pi pi-play'"
          :aria-label="isRunning ? 'Stop' : 'Start'"
          size="small"
          severity="secondary"
          :disabled="!modelReady"
          @click="toggleRun"
        />
        <InputGroup style="width: auto" data-tour="run.fastforward">
          <Button
            v-tooltip.top="'Fast forward'"
            icon="pi pi-forward"
            aria-label="Fast forward"
            size="small"
            severity="secondary"
            :disabled="!modelReady"
            @click="calculate(calcSecs)"
          />
          <Select
            v-model="calcSecs"
            :options="CALC_OPTIONS"
            size="small"
            class="w-16"
            :disabled="!modelReady"
          />
        </InputGroup>
        <span class="opacity-60">seconds</span>
      </div>

      <!-- right: scenario picker (full for model developers, read-only for everyone else) + state save/load -->
      <div class="flex items-center gap-1.5 justify-self-end">
        <span class="flex items-center gap-1.5" data-tour="scenario.picker">
        <template v-if="auth.user?.modelDeveloper">
          <span class="opacity-70">local models</span>
          <Select
            v-model="current"
            :options="scenarios"
            placeholder="Select a scenario"
            size="small"
            class="w-56"
          />
          <Button
            v-tooltip.top="
              current && auth.user?.defaultLocalState === current
                ? 'Startup scenario (click to unset)'
                : 'Load this scenario at startup'
            "
            :icon="
              current && auth.user?.defaultLocalState === current
                ? 'pi pi-star-fill'
                : 'pi pi-star'
            "
            aria-label="Load this scenario at startup"
            severity="secondary"
            size="small"
            :disabled="!current"
            @click="toggleDefaultLocal"
          />
          <Button
            v-tooltip.top="'Delete selected model definition'"
            icon="pi pi-trash"
            aria-label="Delete model definition"
            severity="danger"
            text
            size="small"
            :disabled="!current"
            @click="current && deleteScenario(current)"
          />
        </template>
        <template
          v-if="!auth.user?.modelDeveloper && (!auth.lesson || auth.lesson.allowScenarioSwitch)"
        >
          <span class="opacity-70">scenario</span>
          <Select v-model="current" :options="scenarios" size="small" class="w-56" />
        </template>
        </span>
        <SaveStatePanel v-if="modelReady && !auth.lesson?.readonly" data-tour="save.panel" />
      </div>
    </div>
    <TourOverlay />
  </div>
</template>

<style scoped>
/* Make the bottom run-control bar denser than PrimeVue's "small" size. */
.compact-bar :deep(.p-button),
.compact-bar :deep(.p-select),
.compact-bar :deep(.p-inputtext),
.compact-bar :deep(.p-inputnumber-input) {
  font-size: 0.85rem;
  padding-top: 0.15rem;
  padding-bottom: 0.15rem;
  min-height: 0;
}
.compact-bar :deep(.p-button) {
  padding-left: 0.5rem;
  padding-right: 0.5rem;
}
/* Bump the run/calculate button icons in step with the larger bar text. */
.compact-bar :deep(.p-button) .pi {
  font-size: 1rem;
}

/* Slightly larger tab icons across the control / viz / monitor tab strips. */
:deep(.p-tab) .pi {
  font-size: 1.25rem;
  transition: filter 0.15s ease, transform 0.15s ease;
}
/* Hover affordance for the icon-only tabs: inactive icons brighten + lift so it
   reads as clickable (the active tab already has its own highlight). */
:deep(.p-tab:not(.p-tab-active):hover) .pi {
  filter: brightness(1.4);
  transform: translateY(-1px);
}
</style>
