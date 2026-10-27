import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { useExplain } from "@/composables/useExplain";
import { useModelStore } from "@/stores/model";

// One numeric readout. `props` are full engine dot-paths ("Model.prop" or
// "Model.minmax.sub"); two props render as "a/b" (e.g. systolic/diastolic).
// `factor` scales the raw engine value for display, `rounding` is the decimal
// count, `weight_based` divides by patient weight (per-kg readouts).
export interface MonitorParam {
  label: string;
  unit?: string;
  factor?: number;
  rounding?: number;
  props?: string[];
  weight_based?: boolean;
}

// A monitor group (one collapsible Panel of readouts). `key` is the stable JSON
// object key; the editable in-memory form is an ORDERED ARRAY so groups can be
// reordered — JS object key order is insertion-ordered, so array order ⇄ object
// key order round-trips on persist.
export interface MonitorGroup {
  key: string;
  title: string;
  enabled: boolean;
  collapsed: boolean;
  parameters: MonitorParam[];
}

// A dashboard is an independent named set of groups. Scenarios can hold several
// (`configuration.monitor_dashboards`); the user switches between them.
export interface MonitorDashboard {
  id: string;
  name: string;
  groups: MonitorGroup[];
}

// strip Vue reactivity / proxies before persisting or storing as plain data
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v ?? null));
}

function newId(): string {
  return (crypto as any)?.randomUUID?.() ?? `d_${Date.now()}_${Math.round(Math.random() * 1e6)}`;
}

// parse a `configuration.monitors`-shaped object into an ordered group array
function parseMonitors(stored: any): MonitorGroup[] {
  if (!stored || typeof stored !== "object") return [];
  return Object.entries<any>(stored).map(([key, g]) => ({
    key,
    title: g?.title ?? key,
    enabled: g?.enabled ?? true,
    collapsed: g?.collapsed ?? false,
    // drop the vestigial cached `value` field engine never reads
    parameters: (Array.isArray(g?.parameters) ? g.parameters : []).map(
      (p: any): MonitorParam => ({
        label: p?.label ?? "",
        unit: p?.unit ?? "",
        factor: p?.factor ?? 1,
        rounding: p?.rounding ?? 0,
        props: Array.isArray(p?.props) ? [...p.props] : [],
        weight_based: p?.weight_based ?? false,
      }),
    ),
  }));
}

// rebuild the keyed `monitors` object from an ordered group array (order ⇄ keys)
function groupsToObject(groups: MonitorGroup[]): Record<string, any> {
  const obj: Record<string, any> = {};
  for (const g of groups) {
    obj[g.key] = {
      title: g.title,
      enabled: g.enabled,
      collapsed: g.collapsed,
      parameters: clone(g.parameters),
    };
  }
  return obj;
}

// Monitor dashboards live inside the loaded scenario JSON under
// `configuration.monitor_dashboards` (an array; each dashboard owns its own
// keyed `monitors` object). Legacy scenarios with only `configuration.monitors`
// are migrated into a single default dashboard on load. The store mirrors the
// dashboards in memory and auto-persists edits (debounced) through the dev
// save-snapshot endpoint. `groups` always reflects the active dashboard, so the
// panels/MainPage keep using `store.groups` unchanged.
export const useMonitorsStore = defineStore("monitors", () => {
  const { model } = useExplain();
  const modelStore = useModelStore();
  const dashboards = ref<MonitorDashboard[]>([]);
  const activeId = ref<string>("");

  const activeDashboard = computed<MonitorDashboard | null>(
    () => dashboards.value.find((d) => d.id === activeId.value) ?? dashboards.value[0] ?? null,
  );
  // active dashboard's groups — the editable list panels render
  const groups = computed<MonitorGroup[]>(() => activeDashboard.value?.groups ?? []);
  // every dashboard's groups with their dashboard name (export, slow-watch subscription)
  const allGroups = computed(() =>
    dashboards.value.flatMap((d) => d.groups.map((group) => ({ dashboard: d.name, group }))),
  );

  // the chosen dashboard (tab) is remembered per browser by NAME, so it survives a reload and a
  // scenario switch where a dashboard of that name exists. View state only, never in the scenario.
  const ACTIVE_KEY = "explain.monitors.activeDashboard";
  function rememberedName(): string | null {
    try {
      return localStorage.getItem(ACTIVE_KEY);
    } catch {
      return null;
    }
  }

  function scenarioName(): string {
    return (model as any).loadedFileData?.name || modelStore.current || "snapshot";
  }

  // (re)load dashboards from the currently-loaded scenario file
  function syncFromScenario() {
    const cfg = (model as any).loadedFileData?.configuration;
    const stored = cfg?.monitor_dashboards;
    if (Array.isArray(stored) && stored.length) {
      dashboards.value = stored.map((d: any) => ({
        id: d?.id || newId(),
        name: d?.name || "Monitor",
        groups: parseMonitors(d?.monitors),
      }));
    } else {
      // migrate the legacy single `configuration.monitors` object
      dashboards.value = [{ id: newId(), name: "Monitor", groups: parseMonitors(cfg?.monitors) }];
    }
    const remembered = rememberedName();
    activeId.value = (dashboards.value.find((d) => d.name === remembered) ?? dashboards.value[0])?.id ?? "";
  }

  // ----- dashboard CRUD -------------------------------------------------------
  function addDashboard() {
    const d: MonitorDashboard = { id: newId(), name: "New dashboard", groups: [] };
    dashboards.value.push(d);
    activeId.value = d.id;
    persist();
  }
  function removeDashboard(id: string) {
    if (dashboards.value.length <= 1) return; // keep at least one
    dashboards.value = dashboards.value.filter((d) => d.id !== id);
    if (!dashboards.value.some((d) => d.id === activeId.value)) {
      activeId.value = dashboards.value[0]?.id ?? "";
    }
    persist();
  }
  function renameDashboard(id: string, name: string) {
    const d = dashboards.value.find((x) => x.id === id);
    if (!d) return;
    d.name = name;
    persist();
  }
  function moveDashboard(id: string, dir: -1 | 1) {
    const i = dashboards.value.findIndex((d) => d.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= dashboards.value.length) return;
    [dashboards.value[i], dashboards.value[j]] = [dashboards.value[j], dashboards.value[i]];
    persist();
  }
  function setActive(id: string) {
    activeId.value = id; // view-only state, not persisted to the scenario
    const name = dashboards.value.find((d) => d.id === id)?.name;
    try {
      if (name) localStorage.setItem(ACTIVE_KEY, name);
    } catch {
      /* ignore disabled storage */
    }
  }

  // ----- group / param CRUD (operate on the active dashboard) -----------------
  // turn a title into a unique object key (slug + numeric suffix on collision)
  function uniqueKey(title: string): string {
    const base = (title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "group");
    let key = base;
    let i = 2;
    const taken = new Set(groups.value.map((g) => g.key));
    while (taken.has(key)) key = `${base}_${i++}`;
    return key;
  }

  function addGroup() {
    const d = activeDashboard.value;
    if (!d) return;
    d.groups.push({ key: uniqueKey("group"), title: "New group", enabled: true, collapsed: false, parameters: [] });
    persist();
  }

  function removeGroup(key: string) {
    const d = activeDashboard.value;
    if (!d) return;
    d.groups = d.groups.filter((g) => g.key !== key);
    persist();
  }

  // swap a group with its neighbour (dir -1 up / +1 down)
  function moveGroup(key: string, dir: -1 | 1) {
    const arr = activeDashboard.value?.groups;
    if (!arr) return;
    const i = arr.findIndex((g) => g.key === key);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    persist();
  }

  function addParam(key: string) {
    const g = groups.value.find((x) => x.key === key);
    if (!g) return;
    g.parameters.push({ label: "", unit: "", factor: 1, rounding: 0, props: [], weight_based: false });
    persist();
  }

  function removeParam(key: string, idx: number) {
    const g = groups.value.find((x) => x.key === key);
    if (!g) return;
    g.parameters.splice(idx, 1);
    persist();
  }

  function moveParam(key: string, idx: number, dir: -1 | 1) {
    const g = groups.value.find((x) => x.key === key);
    if (!g) return;
    const j = idx + dir;
    if (j < 0 || j >= g.parameters.length) return;
    [g.parameters[idx], g.parameters[j]] = [g.parameters[j], g.parameters[idx]];
    persist();
  }

  // Auto-save on every change, but debounced so a burst of keystrokes is one
  // file write. Writes `configuration.monitor_dashboards` (and mirrors the first
  // dashboard into the legacy `configuration.monitors` for backward-compat) into
  // the loaded scenario — the original model_definition is preserved (never
  // snapshots the live running sim).
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  function persist() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(persistNow, 500);
  }

  async function persistNow(): Promise<boolean> {
    const base = (model as any).loadedFileData;
    if (!base) return false;
    base.configuration = base.configuration || {};
    base.configuration.monitor_dashboards = dashboards.value.map((d) => ({
      id: d.id,
      name: d.name,
      monitors: groupsToObject(d.groups),
    }));
    // backward-compat mirror of the first dashboard
    base.configuration.monitors = groupsToObject(dashboards.value[0]?.groups ?? []);

    const name = scenarioName();
    try {
      const res = await fetch("/api/save-snapshot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, data: base }),
      });
      if (!res.ok) throw new Error(`save endpoint returned ${res.status}`);
      return true;
    } catch (err) {
      console.error("monitor persist failed (kept in memory)", err);
      return false;
    }
  }

  return {
    dashboards,
    activeId,
    activeDashboard,
    groups,
    allGroups,
    syncFromScenario,
    addDashboard,
    removeDashboard,
    renameDashboard,
    moveDashboard,
    setActive,
    addGroup,
    removeGroup,
    moveGroup,
    addParam,
    removeParam,
    moveParam,
    persist,
  };
});
