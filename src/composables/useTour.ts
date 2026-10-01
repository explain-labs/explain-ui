import { computed, nextTick, ref, shallowRef, watch, type WatchStopHandle } from "vue";
import { useExplain } from "@/composables/useExplain";
import { useLayoutStore } from "@/stores/layout";
import { getTour, loadStepMarkdown } from "@/manual/index";
import { findTarget } from "@/manual/targets";
import type { Tour, TourOp, TourStep, UiOp } from "@/manual/types";
import type { DiagramHighlight } from "@/components/host/Diagram.vue";
import { DIAGRAM_LABELS } from "@/lessons/diagramLabels";
import { t as tl } from "@/lessons/i18n";
import { renderMarkdown } from "@/utils/markdown";

// Runtime of the interactive manual: one tour at a time, shared by the overlay
// (TourOverlay.vue), the Help menu and MainPage (which forwards the canvas
// highlights to Diagram / Monitor / numerics). Module-level state = singleton.

const PROGRESS_KEY = "explain.manual.progress";
const TARGET_TIMEOUT_MS = 3000;

interface Progress {
  completed: string[];
  last?: { tour: string; step: string };
}

function readProgress(): Progress | null {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    return raw ? (JSON.parse(raw) as Progress) : null;
  } catch {
    return null;
  }
}
function writeProgress(p: Progress) {
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable: progress just isn't remembered */
  }
}

const tour = shallowRef<Tour | null>(null);
const stepIndex = ref(0);
const html = ref(""); // rendered markdown of the current step
const target = shallowRef<HTMLElement | null>(null); // spotlit element (null = centred card)
const resolving = ref(false); // ui ops / target lookup in flight
const progress = ref<Progress>(readProgress() ?? { completed: [] });
let stepToken = 0; // guards async step entry against fast next/prev clicks
let stopAdvance: (() => void) | null = null;

const step = computed<TourStep | null>(() => tour.value?.steps[stepIndex.value] ?? null);
const active = computed(() => !!tour.value);

function saveProgress(patch: Partial<Progress>) {
  progress.value = { ...progress.value, ...patch };
  writeProgress(progress.value);
}

// Wait for a data-tour element to be mounted (a tab panel or v-if may render it
// a frame or two after the ui ops ran). Resolves null after the timeout.
function waitForTarget(key: string): Promise<HTMLElement | null> {
  const now = findTarget(key);
  if (now) return Promise.resolve(now);
  return new Promise((resolve) => {
    const obs = new MutationObserver(() => {
      const el = findTarget(key);
      if (el) done(el);
    });
    const timer = window.setTimeout(() => done(null), TARGET_TIMEOUT_MS);
    function done(el: HTMLElement | null) {
      obs.disconnect();
      window.clearTimeout(timer);
      resolve(el);
    }
    obs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-tour"] });
  });
}

export function useTour() {
  const explain = useExplain();
  const layout = useLayoutStore();

  function applyUi(op: UiOp) {
    if ("tab" in op) layout.setTab(op.tab, op.value);
    else findTarget(op.click)?.click();
  }

  function applyOp(op: TourOp) {
    switch (op.kind) {
      case "set":
        explain.setProp(op.path, op.value, op.it ?? 1, op.at ?? 0);
        break;
      case "call":
        explain.call(op.fn, (op.args ?? []) as any[], op.at ?? 0);
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
    }
  }

  // The learner can satisfy a step's `advanceOn` gate; when they do, move on.
  function armAdvance(s: TourStep, el: HTMLElement | null) {
    stopAdvance?.();
    stopAdvance = null;
    const cond = s.advanceOn;
    if (!cond) return;
    if ("tab" in cond) {
      const stop: WatchStopHandle = watch(
        () => layout.getTab(cond.tab),
        (v) => v === cond.value && next(),
      );
      stopAdvance = stop;
    } else if ("running" in cond) {
      stopAdvance = watch(explain.isRunning, (v) => v === cond.running && next());
    } else if (el) {
      // after the target's own handler, so the click still does its thing
      const onClick = () => window.setTimeout(next, 0);
      el.addEventListener("click", onClick, { once: true });
      stopAdvance = () => el.removeEventListener("click", onClick);
    }
  }

  // Already satisfied on arrival (e.g. the tab is already open)? Then the gate
  // must not block — the learner can just press Next.
  const gated = computed(() => {
    const cond = step.value?.advanceOn;
    if (!cond) return false;
    if ("tab" in cond) return layout.getTab(cond.tab) !== cond.value;
    if ("running" in cond) return explain.isRunning.value !== cond.running;
    return true;
  });

  async function enter(i: number) {
    const t = tour.value;
    if (!t) return;
    const token = ++stepToken;
    stepIndex.value = i;
    const s = t.steps[i];
    resolving.value = true;
    target.value = null;
    stopAdvance?.();
    stopAdvance = null;

    for (const op of s.ui ?? []) {
      applyUi(op);
      await nextTick();
    }
    const [md, el] = await Promise.all([
      loadStepMarkdown(t.id, s.id),
      s.target ? waitForTarget(s.target) : Promise.resolve(null),
    ]);
    if (token !== stepToken) return; // superseded by a later next/prev
    if (s.target && !el && import.meta.env.DEV)
      console.warn(`manual: tour "${t.id}" step "${s.id}": target "${s.target}" not found`);

    html.value = renderMarkdown(md);
    el?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
    target.value = el;
    resolving.value = false;
    if (s.onEnter?.length && explain.modelReady.value) for (const op of s.onEnter) applyOp(op);
    armAdvance(s, el);
    saveProgress({ last: { tour: t.id, step: s.id } });
  }

  function start(id: string, stepId?: string) {
    const t = getTour(id);
    if (!t || !t.steps.length) return;
    tour.value = t;
    const i = stepId ? t.steps.findIndex((s) => s.id === stepId) : 0;
    enter(Math.max(0, i));
  }

  function stop() {
    stepToken++;
    stopAdvance?.();
    stopAdvance = null;
    tour.value = null;
    target.value = null;
    html.value = "";
  }

  function finish() {
    const t = tour.value;
    if (t && !progress.value.completed.includes(t.id))
      saveProgress({ completed: [...progress.value.completed, t.id] });
    stop();
  }

  function next() {
    const t = tour.value;
    if (!t) return;
    if (stepIndex.value >= t.steps.length - 1) finish();
    else enter(stepIndex.value + 1);
  }

  function prev() {
    if (tour.value && stepIndex.value > 0) enter(stepIndex.value - 1);
  }

  function isCompleted(id: string) {
    return progress.value.completed.includes(id);
  }

  function resetProgress() {
    saveProgress({ completed: [], last: undefined });
  }

  // Highlights inside the canvases / numeric cards, forwarded by MainPage to
  // the same props the lesson page uses.
  const diagramHighlight = computed<DiagramHighlight | null>(() => {
    const s = step.value;
    if (!s?.diagramHighlight?.length || resolving.value) return null;
    const labels: Record<string, string> = {};
    for (const name of s.diagramHighlight) {
      const def = DIAGRAM_LABELS[name];
      const l = s.diagramLabels?.[name] ?? (def ? tl(def, "en") : "");
      if (l) labels[name] = l;
    }
    return { names: s.diagramHighlight, labels };
  });
  const monitorHighlight = computed(() => (resolving.value ? [] : (step.value?.monitorHighlight ?? [])));
  const numericHighlight = computed(() => (resolving.value ? [] : (step.value?.numericHighlight ?? [])));

  return {
    tour,
    step,
    stepIndex,
    html,
    target,
    resolving,
    active,
    gated,
    progress,
    diagramHighlight,
    monitorHighlight,
    numericHighlight,
    // first visit: no progress stored yet (used to offer the getting-started tour)
    isFirstVisit: () => readProgress() === null,
    markSeen: () => saveProgress({}),
    start,
    stop,
    next,
    prev,
    finish,
    isCompleted,
    resetProgress,
  };
}
