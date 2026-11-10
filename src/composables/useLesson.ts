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
  type RelSliderIntervention,
  type SliderIntervention,
  type ToggleIntervention,
} from "@/lessons/interventions";
import type { CentreTab, Lesson, LessonAction, LessonStep, Op } from "@/lessons/types";
import { renderMarkdown } from "@/utils/markdown";
import { splitActionMarkers, type StepBlock } from "@/lessons/actionMarkers";
import { currentScaleFactor } from "@/services/commonTasks";
import { evaluate, samplePaths } from "@explain/papers/evaluate.js";

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

export type ExperimentStatus = "idle" | "loading" | "settling" | "sampling" | "done" | "error";
export interface ExperimentRun {
  status: ExperimentStatus;
  progress: number; // 0–100 of the sampling window
  values: Record<string, number | undefined>; // measure key → value (after "done")
  weight?: number; // kg the per-kg measures used
  error?: string;
}

interface Pending {
  state?: ToggleState; // toggles: the state being moved to
  from?: number; // raw value when the tween was requested (for progress)
  target: number; // raw value being tweened to
  until: number; // wall-clock ms after which we stop waiting
}

export function useLesson(lesson: Lesson) {
  const explain = useExplain();
  const { model, modelReady, isRunning, slowValues, modelState, error, status } = explain;
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

  // centre column tab: the lesson's first, then whatever a step asks for
  const centreTabs: CentreTab[] = lesson.layout?.centre?.length ? lesson.layout.centre : ["diagram"];
  const centreTab = ref<CentreTab>(step.value.centreTab ?? centreTabs[0]);
  watch(step, (s) => {
    if (s.centreTab && centreTabs.includes(s.centreTab)) centreTab.value = s.centreTab;
  });
  const prev = () => goTo(stepIndex.value - 1);

  // where a step's markdown + images live (shared intro steps name "_shared")
  const ownFolder = lessonFolder(lesson.id);
  const stepFolder = (s: LessonStep) => s.source ?? ownFolder;

  // rendered markdown for the current step + language, cut into blocks at
  // action markers: a line `[[action:bleed]]` (or `[[action:bolus,transfuse]]`)
  // puts those action buttons right there in the text, so a learner presses a
  // button where the text names it. Actions without a marker stay at the bottom.
  const stepBlocks = ref<StepBlock[]>([]);
  const stepHtml = computed(() =>
    stepBlocks.value.map((b) => (b.kind === "html" ? b.html : "")).join(""),
  );
  // `[[reveal]]` points opened so far, per step id (kept when the learner goes
  // back and forth; a page reload starts over)
  const revealed = ref<Record<string, number>>({});
  const revealedCount = computed(() => revealed.value[step.value.id] ?? 0);
  function revealNext() {
    const id = step.value.id;
    revealed.value = { ...revealed.value, [id]: (revealed.value[id] ?? 0) + 1 };
  }
  // the blocks shown now: everything up to the first unopened reveal point
  // (included, so the panel can draw its Continue button there)
  const visibleBlocks = computed(() => {
    const out: StepBlock[] = [];
    let opened = 0;
    for (const b of stepBlocks.value) {
      if (b.kind !== "reveal") {
        out.push(b);
        continue;
      }
      const pending = opened++ >= revealedCount.value;
      out.push({ kind: "reveal", pending });
      if (pending) break;
    }
    return out;
  });
  const inlineActionIds = computed(
    () => new Set(stepBlocks.value.flatMap((b) => (b.kind === "actions" ? b.ids : []))),
  );
  let mdToken = 0;
  watch(
    [step, lang],
    async ([s, l]) => {
      const token = ++mdToken;
      const folder = stepFolder(s);
      const raw = await loadStepMarkdown(folder, s.id, l);
      if (token !== mdToken) return; // a newer step/lang won the race
      const render = (md: string) => renderMarkdown(md, { resolveImage: (src) => imageUrl(folder, src) });
      stepBlocks.value = splitActionMarkers(raw).map((b): StepBlock =>
        b.kind === "md" ? { kind: "html", html: render(b.md) } : b,
      );
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
  // any value (booleans, strings too), from the slow rows while running, else the snapshot
  function rawOf(path: string): unknown {
    if (isRunning.value) {
      const row = latestRow();
      if (row && path in row) return row[path];
    }
    const segs = path.split(".");
    let cur: any = (modelState.value as any)?.models?.[segs[0]];
    for (let i = 1; i < segs.length && cur != null; i++) cur = cur[segs[i]];
    return cur;
  }

  // ventilatorStopsBreathing: intubated and ventilated → no own breathing (sedated);
  // reacts to the change itself, however the ventilator was switched
  const ventilatedViaTube = computed<boolean | undefined>(() => {
    if (!lesson.ventilatorStopsBreathing || !modelReady.value) return undefined;
    const on = rawOf("Ventilator.is_enabled");
    if (typeof on !== "boolean") return undefined;
    return on && rawOf("Ventilator.interface") === "ett";
  });
  watch(ventilatedViaTube, (v, was) => {
    if (v === undefined || v === was) return;
    explain.call("Breathing.switch_breathing", [!v], 0);
  });

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
  // the lesson's own interventions first, then the shared registry
  const lookup = (id: string): Intervention | undefined => lesson.interventions?.[id] ?? getIntervention(id);
  const VENT_PATHS = ["Ventilator.is_enabled", "Ventilator.interface"];
  const readPaths = [
    ...lesson.controls.map((id) => lookup(id)).flatMap((c) => (c && (c.kind === "toggle" || c.kind === "slider" || c.kind === "relslider") ? [c.read] : [])),
    ...(lesson.ventilatorStopsBreathing ? VENT_PATHS : []),
  ];

  const controls = computed<Intervention[]>(() => {
    const models = (modelState.value as any)?.models ?? {};
    return lesson.controls
      .map((id) => {
        const c = lookup(id);
        if (!c) console.warn(`lesson "${lesson.id}": unknown intervention "${id}"`);
        return c;
      })
      .filter((c): c is Intervention => !!c && (c.requires ?? []).every((m) => m in models));
  });

  // rebuilds and fast-forwards in progress (ops that take seconds of wall clock)
  const computing = ref(0);
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
      const c = lookup(id);
      const v = c && (c.kind === "toggle" || c.kind === "slider") ? valueOf(c.read) : undefined;
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
    const c = lookup(id);
    if (!p || !c || c.kind === "button" || c.kind === "updown" || p.from === undefined) return undefined;
    const span = p.target - p.from;
    if (Math.abs(span) < 1e-9) return 100;
    const v = valueOf(c.read);
    if (v === undefined) return 0;
    return Math.round(Math.max(0, Math.min(1, (v - p.from) / span)) * 100);
  }

  // ----- timed actions ------------------------------------------------------------
  // An action with a `duration` (model seconds) fills its button from the click
  // until that much model time has passed. Model time comes from the slow rows
  // while running and from the state snapshot when paused, so fast-forward
  // (`calculate`) jumps the fill and a pause freezes it.
  function modelTime(): number | undefined {
    if (isRunning.value) {
      const t = latestRow()?.time;
      if (typeof t === "number") return t;
    }
    const t = (modelState.value as any)?.model_time_total;
    return typeof t === "number" ? t : undefined;
  }
  const timed = ref<Record<string, { start: number; seconds: number }>>({});
  const actionKey = (actionId: string) => `${step.value.id}/${actionId}`;
  // The action whose ops are still being applied (a rebuild or a fast-forward
  // takes seconds); its button shows a spinner and all buttons wait for it.
  const busyKey = ref<string | null>(null);
  async function runAction(a: LessonAction) {
    if (busyKey.value || computing.value > 0) return;
    const t0 = modelTime();
    if (a.duration && a.duration > 0 && t0 !== undefined)
      timed.value = { ...timed.value, [actionKey(a.id)]: { start: t0, seconds: a.duration } };
    busyKey.value = actionKey(a.id);
    recentre(); // any lesson action (a shock, a target button) moves the state: "now" is the new state
    try {
      await applyOps(a.ops);
    } finally {
      busyKey.value = null;
    }
  }
  const isBusy = (actionId: string) => busyKey.value === actionKey(actionId);
  // 0–100 while a timed action plays out, undefined otherwise (and once done)
  function actionTimeProgress(actionId: string): number | undefined {
    const tm = timed.value[actionKey(actionId)];
    if (!tm) return undefined;
    const now = modelTime();
    if (now === undefined) return 0;
    const f = (now - tm.start) / tm.seconds;
    if (f >= 1) return undefined;
    return Math.round(Math.max(0, f) * 100);
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

  // raw model value ↔ display units (raw × factor, or factor / raw when inverted)
  function toDisplay(c: SliderIntervention, raw: number): number {
    return c.invert ? sliderFactor(c) / raw : raw * sliderFactor(c);
  }
  function sliderRaw(c: SliderIntervention, display: number): number {
    return c.invert ? sliderFactor(c) / display : display / sliderFactor(c);
  }

  // ----- relative sliders (centred on "now") -------------------------------------------------------
  // base = the lever when the slider was last re-centred; null = not taken yet (taken on the first
  // move). Re-centred on every rebuild and by every lesson action (a shock button, a target button
  // that changes the same lever: keeping the old base would undo it on the next move).
  const relBase = ref<Record<string, number>>({});
  const relSet = ref<Record<string, number>>({}); // the slider position (-1..1) the learner chose
  function recentre() {
    relBase.value = {};
    relSet.value = {};
  }
  // position -1..1 (log of the change over log span): the chosen one, else 0 ("now")
  function relPosition(c: RelSliderIntervention): number {
    return relSet.value[c.id] ?? 0;
  }
  function relLabel(c: RelSliderIntervention): string {
    const v = relPosition(c);
    if (Math.abs(v) < 0.02) return "now";
    const m = Math.pow(c.span ?? 3, Math.abs(v));
    return `${v > 0 ? "×" : "÷"}${m.toFixed(m < 1.95 ? 2 : 1)}`;
  }
  function applyRel(c: RelSliderIntervention, v: number) {
    const now = valueOf(c.read);
    if (relBase.value[c.id] === undefined) {
      if (now === undefined) return;
      relBase.value = { ...relBase.value, [c.id]: now };
    }
    const base = relBase.value[c.id];
    const m = Math.pow(c.span ?? 3, v); // the shown quantity's change
    const factor = c.invert ? base / m : base * m;
    relSet.value = { ...relSet.value, [c.id]: v };
    applyOp({ kind: "scale", group: c.group, factor });
  }

  // slider position in display units: the target while tweening, else current
  function sliderValue(c: SliderIntervention): number | undefined {
    const raw = pending.value[c.id]?.target ?? valueOf(c.read);
    return raw === undefined ? undefined : toDisplay(c, raw);
  }

  // the value right now in display units (differs from sliderValue mid-tween)
  function sliderActual(c: SliderIntervention): number | undefined {
    const raw = valueOf(c.read);
    return raw === undefined ? undefined : toDisplay(c, raw);
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
    const c = lookup(id);
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
    } else if (c.kind === "relslider") {
      if (typeof state === "number") applyRel(c, state);
    } else if (c.kind === "updown") {
      // "off" = down, anything else = up
      for (const op of state === "off" ? c.down : c.up) applyOp(op);
    } else {
      for (const op of c.ops) applyOp(op);
    }
  }

  async function applyOp(op: Op) {
    switch (op.kind) {
      case "loadScenario":
        computing.value++;
        try {
          await loadScenario(op.scenario, op.fresh);
        } finally {
          computing.value--;
        }
        break;
      case "experiment":
        await runExperiment(op.id);
        break;
      case "set":
        explain.setProp(op.path, op.value, op.it ?? 1, op.at ?? 0);
        break;
      case "call":
        explain.call(op.fn, (op.args ?? []) as any[], op.at ?? 0);
        break;
      case "scale":
        for (const g of Array.isArray(op.group) ? op.group : [op.group]) {
          const now = op.relative ? currentScaleFactor({ kind: "scale", group: g }, modelState.value) ?? 1 : 1;
          explain.scale(g, op.relative ? now * op.factor : op.factor);
        }
        break;
      case "control":
        applyControl(op.id, op.state);
        break;
      case "calculate":
        // wait for the worker to finish (seconds of wall clock for minutes of
        // model time) so the page can show it is computing; the timeout keeps a
        // lost status message from locking the buttons
        computing.value++;
        try {
          await Promise.race([settleModel(op.seconds), new Promise((r) => setTimeout(r, 180_000))]);
        } finally {
          computing.value--;
        }
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
      case "reenter": {
        const s = step.value;
        for (const o of s.onEnter ?? []) await applyOp(o);
        const start = op.withStart && s.restartWith ? s.actions?.find((a) => a.id === s.restartWith) : undefined;
        if (start) for (const o of start.ops) await applyOp(o);
        break;
      }
    }
  }

  const ENGINE_OPS = new Set<Op["kind"]>(["set", "call", "scale", "control"]);
  // Ops apply in order; the asynchronous ones (loadScenario, experiment) hold
  // the rest of the list until they finish. Callers need not await.
  async function applyOps(ops: Op[]) {
    if (!ops.length) return;
    // queued changes only take effect while the model steps
    const touchesEngine = ops.some((o) => ENGINE_OPS.has(o.kind));
    if (touchesEngine && lesson.runOnAction !== false && modelReady.value && !isRunning.value)
      explain.start();
    for (const op of ops) await applyOp(op);
  }

  // ----- experiments (paper companions) --------------------------------------
  // An experiment reloads its scenario (a clean baseline), applies its ops,
  // settles offline (`calculate`), then samples the slow stream for `window_s`
  // seconds while the model runs live, and evaluates the measures with the
  // engine's own evaluator — the numbers are the ones scripts/probe_<id>.mjs prints.
  let scenarioName = lesson.scenario;
  let runToken = 0;
  const runs = ref<Record<string, ExperimentRun>>({});

  function waitFor<T>(source: { value: T }, pred: (v: T) => boolean): Promise<void> {
    return new Promise((resolve) => {
      if (pred(source.value)) return resolve();
      const stop = watch(source as any, (v: T) => {
        if (pred(v)) {
          stop();
          resolve();
        }
      });
    });
  }

  // like waitFor, but only on a change from now on: the current value never
  // counts (a status left over from an earlier calculation must not end the wait)
  function waitForChange<T>(source: { value: T }, pred: (v: T) => boolean): Promise<void> {
    return new Promise((resolve) => {
      const stop = watch(
        source as any,
        (v: T) => {
          if (pred(v)) {
            stop();
            resolve();
          }
        },
        { flush: "sync" },
      );
    });
  }

  async function loadScenario(name: string, force = false) {
    if (!force && name === scenarioName && modelReady.value) return;
    scenarioName = name;
    statesStore.setCurrent(null);
    explain.load(name);
    await waitFor(modelReady, (r) => r === true);
  }

  // The worker handles messages in order and reports "calculated in … ms" when an
  // offline calculation ends. Wait for that status as a change (an earlier
  // calculation's message may still be the current status: two calculations in a
  // row used to end the second wait at once), then for the state snapshot
  // requested behind it: that snapshot is the settled model, whatever
  // other snapshots arrived meanwhile (stopping the loop requests one too).
  async function settleModel(seconds: number) {
    // listen before asking; the worker posts "calculating …" then "calculated in …",
    // so this calculation's own message is always a change
    const calculated = waitForChange(status, (m) => /^calculated in/.test(String(m ?? "")));
    explain.calculate(seconds);
    explain.refreshState();
    await calculated;
    const before = modelState.value;
    explain.refreshState();
    await waitFor(modelState, (s) => s !== before);
  }

  function patchRun(id: string, patch: Partial<ExperimentRun>) {
    const cur = runs.value[id] ?? { status: "idle", progress: 0, values: {} };
    runs.value = { ...runs.value, [id]: { ...cur, ...patch } };
  }

  async function runExperiment(id: string) {
    const ex = lesson.experiments?.experiments.find((e) => e.id === id);
    if (!ex) {
      console.warn(`lesson "${lesson.id}": unknown experiment "${id}"`);
      return;
    }
    const token = ++runToken;
    const live = () => token === runToken;
    try {
      patchRun(id, { status: "loading", progress: 0, values: {}, error: undefined });
      await loadScenario(ex.scenario, true);
      if (!live()) return;
      explain.stop(); // the rebuild auto-started the loop; settle offline instead
      patchRun(id, { status: "settling" });
      for (const op of ex.ops) {
        if (op.kind === "set" || op.kind === "call" || op.kind === "scale") await applyOp(op);
      }
      await settleModel(ex.settle_s);
      if (!live()) return;
      const weight = Number((modelState.value as any)?.weight) || 1;

      // sample the slow stream (1 Hz rows keyed by path) for window_s seconds
      const paths = samplePaths(ex);
      explain.watchSlow(paths);
      const sums: Record<string, number> = Object.fromEntries(paths.map((p) => [p, 0]));
      let n = 0;
      const need = Math.max(1, Math.round(ex.window_s));
      patchRun(id, { status: "sampling", progress: 0, weight });
      explain.start();
      await new Promise<void>((resolve) => {
        const stop = watch(slowValues, (rows: any) => {
          if (!live()) {
            stop();
            resolve();
            return;
          }
          if (!Array.isArray(rows)) return;
          for (const row of rows) {
            if (!paths.every((p) => typeof row?.[p] === "number")) continue;
            for (const p of paths) sums[p] += row[p];
            n++;
            if (n >= need) break;
          }
          patchRun(id, { progress: Math.min(100, Math.round((100 * n) / need)) });
          if (n >= need) {
            stop();
            resolve();
          }
        });
      });
      if (!live()) return;
      const averages = Object.fromEntries(paths.map((p) => [p, sums[p] / n]));
      patchRun(id, { status: "done", progress: 100, values: evaluate(ex, averages, weight), weight });
    } catch (e) {
      if (live()) patchRun(id, { status: "error", error: String(e) });
    }
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
    runToken++; // abandon a running experiment
    scenarioName = lesson.scenario;
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
      timed.value = {}; // a rebuild ends whatever was playing out
      recentre();
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
    stepBlocks,
    visibleBlocks,
    revealNext,
    inlineActionIds,
    stepImageUrl,
    diagramHighlight,
    monitorHighlight,
    centreTabs,
    centreTab,
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
    sliderRaw,
    relPosition,
    relLabel,
    applyRel,
    isClosing,
    isPending,
    anyPending: computed(() => Object.keys(pending.value).length > 0),
    progress,
    applyControl: (id: string, state: ToggleState | number) => applyOps([{ kind: "control", id, state }]),
    applyOps,
    runAction,
    isBusy,
    computing: computed(() => computing.value > 0),
    actionTimeProgress,
    restart,
    toggleRun,
    runs,
    runExperiment,
    loadScenario,
  };
}

export type LessonRuntime = ReturnType<typeof useLesson>;
export const LessonKey: InjectionKey<LessonRuntime> = Symbol("lesson");
