import { ref, shallowRef } from "vue";
import Model from "@explain/Model";

// Singleton wrapper around the simulation engine. Exposes ONLY the control
// plane to Vue reactivity: status, readiness, errors, whole-model state, and
// the ~1 Hz slow stream. The fast per-frame stream (`rtf`/`data`) is owned by
// RealtimeBus and must never be subscribed into a ref here — doing so would
// diff/re-render 60×/second.
let _model: any = null;

const status = ref("");
const modelReady = ref(false);
const isRunning = ref(false); // realtime loop active (rt_start..rt_stop)
const realtimeFactor = ref(1); // simulated / wall time of the realtime loop (~1 s average); < 1 = behind
const error = ref<string | null>(null);
const modelState = shallowRef<any>(null);
const slowValues = shallowRef<any>(null); // latest `rts` slow-stream payload
const savedState = shallowRef<any>(null); // last saved state snapshot
const tuning = ref(false); // a live closed-loop tune is running in the worker
const tuneResult = shallowRef<any>(null); // last tune outcome { converged, residuals, iters }

function ensure() {
  if (_model) return _model;
  _model = new Model();
  _model.on("status", () => {
    status.value = _model.statusMessage;
  });
  _model.on("model_ready", () => {
    modelReady.value = true;
    // pull a full state snapshot so control panels can populate
    _model.getModelState();
  });
  _model.on("error", (e: any) => {
    error.value = e?.message ?? "unknown engine error";
  });
  _model.on("state", () => {
    modelState.value = _model.modelState;
  });
  _model.on("rts", () => {
    slowValues.value = _model.modelDataSlow;
  });
  _model.on("rt_start", () => {
    isRunning.value = true;
    realtimeFactor.value = 1;
  });
  _model.on("rt_perf", (f: number) => {
    if (Number.isFinite(f)) realtimeFactor.value = f;
  });
  _model.on("rt_stop", () => {
    isRunning.value = false;
  });
  _model.on("state_saved", () => {
    savedState.value = _model.savedState;
  });
  _model.on("tuned", (r: any) => {
    tuning.value = false;
    tuneResult.value = r;
  });
  return _model;
}

export function useExplain() {
  const model = ensure();
  return {
    model,
    status,
    modelReady,
    isRunning,
    realtimeFactor,
    error,
    modelState,
    slowValues,
    savedState,
    tuning,
    tuneResult,
    load: (name: string) => {
      modelReady.value = false;
      isRunning.value = false; // rebuilding stops the realtime loop
      error.value = null;
      model.load(name);
    },
    // build from a parsed JSON object (a scenario file or a saved state snapshot)
    loadFromObject: (obj: any) => {
      modelReady.value = false;
      isRunning.value = false; // rebuilding stops the realtime loop
      error.value = null;
      (model as any).loadedFileData = obj;
      const def = obj.model_definition || obj;
      if (obj.diagram_definition && def.diagram_definition === undefined)
        def.diagram_definition = obj.diagram_definition;
      if (obj.animation_definition && def.animation_definition === undefined)
        def.animation_definition = obj.animation_definition;
      model.build(def);
    },
    // revert all live changes (tunes / scales / setProps) by rebuilding the patient
    // exactly as it was loaded — loadedFileData is the originally-loaded object and
    // is NOT touched by live mutations, so this is a clean "undo my changes".
    revert: () => {
      const obj = (model as any).loadedFileData;
      if (!obj) return;
      modelReady.value = false;
      isRunning.value = false;
      error.value = null;
      const def = obj.model_definition || obj;
      if (obj.diagram_definition && def.diagram_definition === undefined)
        def.diagram_definition = obj.diagram_definition;
      if (obj.animation_definition && def.animation_definition === undefined)
        def.animation_definition = obj.animation_definition;
      model.build(def);
    },
    start: () => model.start(),
    stop: () => model.stop(),
    calculate: (seconds: number) => model.calculate(seconds),
    setProp: (
      prop: string,
      value: number | string | boolean | string[],
      it = 1,
      at = 0,
    ) => model.setPropValue(prop, value, it, at),
    call: (fn: string, args: any[] = [], at = 0) =>
      model.callModelFunction(fn, args, at),
    scale: (group: string, factor = 1.0) => model.scaleModel(group, factor),
    tune: (targets: Record<string, number>, opts: Record<string, unknown> = {}) => {
      tuning.value = true;
      model.tune(targets, opts);
    },
    refreshState: () => model.getModelState(),
    watchSlow: (paths: string | string[]) => model.watchModelPropsSlow(paths),
    watch: (paths: string | string[]) => model.watchModelProps(paths),
    saveState: () => model.saveModelState(),
    bloodComposition: (name: string) => model.getBloodComposition(name),
  };
}

export function disposeExplain() {
  if (_model) {
    _model.dispose();
    _model = null;
  }
  modelReady.value = false;
}
