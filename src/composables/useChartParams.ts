import { computed, ref } from "vue";
import { useExplain } from "./useExplain";

// Shared model/parameter + preset logic for the realtime chart and the loop
// chart. Each component supplies its own selectors and decides how a preset's
// paths map onto them; this composable just provides the model/param catalog
// and the preset store (configuration.presets of the loaded scenario).
//
// `presetKey` selects the configuration.presets sub-object:
//   "RealTimeCharts" for the time chart, "LoopCharts" for the PV loop.
export function useChartParams(presetKey: string) {
  const { model, modelState } = useExplain();

  const modelNames = computed(() => {
    const m = (modelState.value as any)?.models;
    return m ? Object.keys(m).sort() : [];
  });

  function numericProps(modelName: string | null): string[] {
    if (!modelName) return [];
    const m = (modelState.value as any)?.models?.[modelName];
    if (!m) return [];
    return Object.keys(m)
      .filter((k) => typeof m[k] === "number")
      .sort();
  }

  // "Model.prop" → [model, prop]
  function pathToSel(path: string | undefined): [string | null, string | null] {
    if (!path) return [null, null];
    const dot = path.indexOf(".");
    return dot < 0 ? [path, null] : [path.slice(0, dot), path.slice(dot + 1)];
  }

  // Presets live in the loaded scenario file under configuration.presets
  // [presetKey] — the scenario's own and the ones the user saves, side by side.
  // Writing user presets there (instead of component-local state) means they
  // survive the chart remounting, a Revert, and are carried into a saved state
  // (SaveStatePanel copies the loaded file's configuration), like monitor
  // dashboards and events. loadedFileData isn't reactive, so `version` is
  // bumped after each write to recompute.
  const version = ref(0);
  function scenarioPresets(create = false): Record<string, any> | null {
    const file = (model as any).loadedFileData;
    if (!file) return null;
    if (!create) {
      const scen = file.configuration?.presets?.[presetKey];
      return scen && typeof scen === "object" ? scen : null;
    }
    file.configuration = file.configuration || {};
    file.configuration.presets = file.configuration.presets || {};
    const cur = file.configuration.presets[presetKey];
    if (!cur || typeof cur !== "object") file.configuration.presets[presetKey] = {};
    return file.configuration.presets[presetKey];
  }

  const presets = computed<Record<string, any>>(() => {
    void modelState.value; // re-evaluate when a new scenario loads
    void version.value; // …and after a save/delete
    return { ...(scenarioPresets() ?? {}) };
  });
  const presetNames = computed(() => Object.keys(presets.value));

  function savePreset(name: string, paths: string[]) {
    const n = name.trim();
    if (!n || !paths.length) return;
    const target = scenarioPresets(true);
    if (!target) return; // nothing loaded yet
    target[n] = { paths };
    version.value++;
  }

  function deletePreset(name: string) {
    const scen = scenarioPresets();
    if (scen && name in scen) {
      delete scen[name];
      version.value++;
    }
  }

  return {
    modelNames,
    numericProps,
    pathToSel,
    presets,
    presetNames,
    savePreset,
    deletePreset,
  };
}
