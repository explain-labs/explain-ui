import { computed, onBeforeUnmount, ref, shallowRef, watch, type InjectionKey } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useExplain } from "@/composables/useExplain";
import { useAuthStore } from "@/stores/auth";
import { useStatesStore } from "@/stores/states";
import { t, useLessonLang } from "@/lessons/i18n";
import { imageUrl, lessonFolder, loadStepMarkdown } from "@/lessons/index";
import { DIAGRAM_LABELS } from "@/lessons/diagramLabels";
import {
  getIntervention,
  type ControlValue,
  type Intervention,
  type SliderIntervention,
  type ToggleIntervention,
} from "@/lessons/interventions";
import type { Lesson, LessonStep, Op } from "@/lessons/types";
import { renderMarkdown } from "@/utils/markdown";

// Runtime for one lesson page: loads the lesson's starting state, tracks the
// current step (mirrored in ?step=), applies ops, and derives the state of
// every intervention control from the engine.
//
// Two engine facts shape this:
// - setProp/call only QUEUE work on the engine's TaskScheduler, which runs
//   inside the model step loop. A paused model ignores them until it runs, so
//   applying an op starts the realtime loop (unless the lesson opts out).
// - While running, current values come from the ~1 Hz slow stream; while
//   paused they come from a model-state snapshot (refreshed on pause).

type ToggleState = "on" | "off";

interface Pending {
  state?: ToggleState; // toggles: the state being moved to
  from?: number; // raw value when the tween was requested (for progress)
  target: number; // raw value being tweened to
  until: number; // wall-clock ms after which we stop waiting
}

export function useLesson(lesson: Lesson) {
  const explain = useExplain();
  const { model, modelReady, isRunning, slowValues, modelState, error } = explain;
  const auth = useAuthStore();
  const statesStore = useStatesStore();
  const route = useRoute();
  const router = useRouter();
  const lang = useLessonLang();

  // ----- steps ------------------------------------------------------------------
  const steps = lesson.steps.filter((s) => !s.draft || import.meta.env.DEV);

  function indexOfStep(id: unknown): number {
    const i = steps.findIndex((s) => s.id === id);
    return i < 0 ? 0 : i;
  }
  const stepIndex = ref(indexOfStep(route.query.step));
  const step = computed(() => steps[stepIndex.value]);
  const isFirst = computed(() => stepIndex.value === 0);
  const isLast = computed(() => stepIndex.value === steps.length - 1);

  function goTo(i: number) {
    const next = Math.max(0, Math.min(steps.length - 1, i));
    if (next === stepIndex.value) return;
    stepIndex.value = next;
    router.replace({ query: { ...route.query, step: steps[next].id } });
    if (modelReady.value) applyOps(steps[next].onEnter ?? []);
  }
  const next = () => goTo(stepIndex.value + 1);
  const prev = () => goTo(stepIndex.value - 1);

  // where a step's markdown + images live (shared intro steps name "_shared")
  const ownFolder = lessonFolder(lesson.id);
  const stepFolder = (s: LessonStep) => s.source ?? ownFolder;

  // rendered markdown for the current step + language
  const stepHtml = ref("");
  let mdToken = 0;
  watch(
    [step, lang],
    async ([s, l]) => {
      const token = ++mdToken;
      const folder = stepFolder(s);
      const raw = await loadStepMarkdown(folder, s.id, l);
      if (token !== mdToken) return; // a newer step/lang won the race
      stepHtml.value = renderMarkdown(raw, { resolveImage: (src) => imageUrl(folder, src) });
    },
    { immediate: true },
  );
  const stepImageUrl = computed(() =>
    step.value.image ? imageUrl(stepFolder(step.value), step.value.image.file) : undefined,
  );

  // what the current step points at in the diagram and on the monitor. Captions
  // come from the shared name table, overridden per step ("" = no caption).
  const diagramHighlight = computed(() => {
    const s = step.value;
    const names = s.diagramHighlight ?? [];
    const labels: Record<string, string> = {};
    for (const name of names) {
      const l = s.diagramLabels?.[name] ?? DIAGRAM_LABELS[name];
      const text = t(l, lang.value);
      if (text) labels[name] = text;
    }
    return { names, labels };
  });
  const monitorHighlight = computed(() => step.value.monitorHighlight ?? []);

  // ----- engine values ----------------------------------------------------------
  // Slow rows from before the latest rebuild describe the old model; ignore them.
  let staleRows: unknown = null;
  function latestRow(): Record<string, unknown> | null {
    const arr = slowValues.value as any[];
    if (arr === staleRows || !Array.isArray(arr) || !arr.length) return null;
    return arr[arr.length - 1];
  }
  function stateValue(path: string): number | undefined {
    const segs = path.split(".");
    let cur: any = (modelState.value as any)?.models?.[segs[0]];
    for (let i = 1; i < segs.length && cur != null; i++) cur = cur[segs[i]];
    return typeof cur === "number" ? cur : undefined;
  }
  function valueOf(path: string): number | undefined {
    if (isRunning.value) {
      const v = latestRow()?.[path];
      if (typeof v === "number") return v;
    }
    return stateValue(path);
  }
  // modelState is only a snapshot; refresh it whenever the loop stops
  watch(isRunning, (running) => {
    if (!running && modelReady.value) explain.refreshState();
  });

  // Baselines for "baseline" control values: the first model-state snapshot
  // after each build (covers bundled scenarios and cloud states alike), with
  // the loaded file as a fallback.
  const baselines = shallowRef<Record<string, number>>({});
  let needBaselines = true;
  watch(modelState, () => {
    if (!needBaselines || !modelReady.value) return;
    const b: Record<string, number> = {};
    for (const path of readPaths) {
      const v = stateValue(path);
      if (v !== undefined) b[path] = v;
    }
    baselines.value = b;
    needBaselines = false;
  });
  function fileValue(path: string): number | undefined {
    const [m, ...rest] = path.split(".");
    let cur: any = (model as any).loadedFileData?.model_definition?.models?.[m];
    for (const s of rest) cur = cur?.[s];
    return typeof cur === "number" ? cur : undefined;
  }
  function resolveValue(v: ControlValue, path: string): number | undefined {
    if (v !== "baseline") return v;
    return baselines.value[path] ?? fileValue(path);
  }

  // ----- controls ---------------------------------------------------------------
  const readPaths = lesson.controls
    .map((id) => getIntervention(id))
    .flatMap((c) => (c && c.kind !== "button" ? [c.read] : []));

  const controls = computed<Intervention[]>(() => {
    const models = (modelState.value as any)?.models ?? {};
    return lesson.controls
      .map((id) => {
        const c = getIntervention(id);
        if (!c) console.warn(`lesson "${lesson.id}": unknown intervention "${id}"`);
        return c;
      })
      .filter((c): c is Intervention => !!c && (c.requires ?? []).every((m) => m in models));
  });

  const pending = ref<Record<string, Pending>>({});
  function setPending(id: string, p: Pending) {
    pending.value = { ...pending.value, [id]: p };
  }
  function clearPending(id: string) {
    const nextPending = { ...pending.value };
    delete nextPending[id];
    pending.value = nextPending;
  }
  // settle pending controls once the value arrives (or the wait times out).
  // The timeout is wall-clock, so it is pushed back while the model is paused
  // — a paused tween isn't stuck, it just isn't advancing.
  let lastSettle = Date.now();
  function settle() {
    const now = Date.now();
    if (!isRunning.value) for (const p of Object.values(pending.value)) p.until += now - lastSettle;
    lastSettle = now;
    for (const [id, p] of Object.entries(pending.value)) {
      const c = getIntervention(id);
      const v = c && c.kind !== "button" ? valueOf(c.read) : undefined;
      const tol = 1e-3 * Math.max(1, Math.abs(p.target));
      if ((v !== undefined && Math.abs(v - p.target) <= tol) || Date.now() > p.until) clearPending(id);
    }
  }
  watch(slowValues, settle);
  const settleTimer = window.setInterval(settle, 1000);

  function isPending(id: string): boolean {
    return id in pending.value;
  }

  // 0–100 progress of a pending tween, from how far the value has moved between
  // its start and target (tweens are linear in model time). Undefined when idle.
  function progress(id: string): number | undefined {
    const p = pending.value[id];
    const c = getIntervention(id);
    if (!p || !c || c.kind === "button" || p.from === undefined) return undefined;
    const span = p.target - p.from;
    if (Math.abs(span) < 1e-9) return 100;
    const v = valueOf(c.read);
    if (v === undefined) return 0;
    return Math.round(Math.max(0, Math.min(1, (v - p.from) / span)) * 100);
  }

  // on/off of a toggle: whichever of its two values the current value is nearer
  function toggleState(c: ToggleIntervention): ToggleState | undefined {
    const p = pending.value[c.id];
    if (p?.state) return p.state;
    const v = valueOf(c.read);
    const on = resolveValue(c.on.value, c.read);
    const off = resolveValue(c.off.value, c.read);
    if (v === undefined || on === undefined || off === undefined) return undefined;
    return Math.abs(v - on) <= Math.abs(v - off) ? "on" : "off";
  }

  // raw → display multiplier: a percentage of a model max, or a fixed factor
  function sliderFactor(c: SliderIntervention): number {
    if (c.percentOf) {
      const max = stateValue(c.percentOf) ?? fileValue(c.percentOf);
      if (max && max > 0) return 100 / max;
    }
    return c.factor ?? 1;
  }

  // slider position in display units: the target while tweening, else current
  function sliderValue(c: SliderIntervention): number | undefined {
    const raw = pending.value[c.id]?.target ?? valueOf(c.read);
    return raw === undefined ? undefined : raw * sliderFactor(c);
  }

  // the value right now in display units (differs from sliderValue mid-tween)
  function sliderActual(c: SliderIntervention): number | undefined {
    const raw = valueOf(c.read);
    return raw === undefined ? undefined : raw * sliderFactor(c);
  }

  // is the pending change of this control a closing (value going down)?
  function isClosing(id: string): boolean {
    const p = pending.value[id];
    if (!p) return false;
    if (p.state) return p.state === "off";
    return p.from !== undefined && p.target < p.from;
  }

  // ----- ops --------------------------------------------------------------------
  function applyControl(id: string, state: ToggleState | number) {
    const c = getIntervention(id);
    if (!c) {
      console.warn(`lesson "${lesson.id}": unknown intervention "${id}"`);
      return;
    }
    if (c.kind === "toggle") {
      if (typeof state === "number") return;
      const side = state === "on" ? c.on : c.off;
      const target = resolveValue(side.value, c.read);
      if (target === undefined) {
        console.warn(`lesson "${lesson.id}": no baseline for ${c.read}`);
        return;
      }
      const it = side.it ?? 1;
      explain.setProp(c.read, target, it, 0);
      setPending(id, { state, from: valueOf(c.read), target, until: Date.now() + (it + 3) * 1000 });
    } else if (c.kind === "slider") {
      // "off" = the slider minimum, "on" = the scenario's baseline, number = raw
      const factor = sliderFactor(c);
      const target =
        state === "off" ? c.min / factor : state === "on" ? resolveValue("baseline", c.read) : state;
      if (target === undefined) {
        console.warn(`lesson "${lesson.id}": no baseline for ${c.read}`);
        return;
      }
      const from = valueOf(c.read);
      // `it` is for a full-range move; smaller moves tween proportionally faster
      const fullRange = (c.max - c.min) / factor;
      const frac = from === undefined || fullRange <= 0 ? 1 : Math.abs(target - from) / fullRange;
      const it = Math.max(1, (c.it ?? 1) * Math.min(1, frac));
      for (const op of c.toOps ? c.toOps(target) : [{ kind: "set", path: c.read, value: target, it } as Op])
        applyOp(op);
      setPending(id, { from, target, until: Date.now() + (it + 3) * 1000 });
    } else {
      for (const op of c.ops) applyOp(op);
    }
  }

  function applyOp(op: Op) {
    switch (op.kind) {
      case "set":
        explain.setProp(op.path, op.value, op.it ?? 1, op.at ?? 0);
        break;
      case "call":
        explain.call(op.fn, (op.args ?? []) as any[], op.at ?? 0);
        break;
      case "control":
        applyControl(op.id, op.state);
        break;
      case "calculate":
        explain.calculate(op.seconds);
        explain.refreshState();
        break;
      case "run":
        explain.start();
        break;
      case "pause":
        explain.stop();
        break;
      case "restart":
        restart();
        break;
    }
  }

  const ENGINE_OPS = new Set<Op["kind"]>(["set", "call", "control"]);
  function applyOps(ops: Op[]) {
    if (!ops.length) return;
    // queued changes only take effect while the model steps
    const touchesEngine = ops.some((o) => ENGINE_OPS.has(o.kind));
    if (touchesEngine && lesson.runOnAction !== false && modelReady.value && !isRunning.value)
      explain.start();
    for (const op of ops) applyOp(op);
  }

  // ----- loading ----------------------------------------------------------------
  // A nicupicu lesson account may start from a curated cloud state; everyone
  // else (and a failed state fetch) gets the lesson's bundled scenario.
  let enterOnReady = true;
  async function loadStart() {
    const acct = auth.lesson;
    if (acct?.id === lesson.id && acct.stateId) {
      const file = await statesStore.loadState(acct.stateId);
      if (file) {
        explain.loadFromObject(file);
        return;
      }
    }
    statesStore.setCurrent(null);
    explain.load(lesson.scenario);
  }

  function restart() {
    enterOnReady = true;
    if (stepIndex.value !== 0) {
      stepIndex.value = 0;
      router.replace({ query: { ...route.query, step: steps[0].id } });
    }
    loadStart();
  }

  watch(modelReady, (ready) => {
    if (!ready) {
      staleRows = slowValues.value;
      pending.value = {};
      needBaselines = true;
      return;
    }
    // build() resets the DataCollector, so re-register every (re)build
    if (readPaths.length) explain.watchSlow(readPaths);
    if (enterOnReady) {
      enterOnReady = false;
      applyOps(step.value.onEnter ?? []);
    }
    if (lesson.autoRun !== false && !isRunning.value) explain.start();
  });

  function toggleRun() {
    if (!modelReady.value) return;
    if (isRunning.value) explain.stop();
    else explain.start();
  }

  loadStart();

  onBeforeUnmount(() => {
    window.clearInterval(settleTimer);
    if (isRunning.value) explain.stop();
  });

  return {
    lesson,
    lang,
    steps,
    stepIndex,
    step,
    stepHtml,
    stepImageUrl,
    diagramHighlight,
    monitorHighlight,
    isFirst,
    isLast,
    goTo,
    next,
    prev,
    modelReady,
    isRunning,
    error,
    controls,
    toggleState,
    sliderValue,
    sliderActual,
    sliderFactor,
    isClosing,
    isPending,
    anyPending: computed(() => Object.keys(pending.value).length > 0),
    progress,
    applyControl: (id: string, state: ToggleState | number) => applyOps([{ kind: "control", id, state }]),
    applyOps,
    restart,
    toggleRun,
  };
}

export type LessonRuntime = ReturnType<typeof useLesson>;
export const LessonKey: InjectionKey<LessonRuntime> = Symbol("lesson");
