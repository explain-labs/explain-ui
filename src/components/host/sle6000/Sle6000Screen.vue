<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useExplain } from "@/composables/useExplain";
import { useRealtimeBus } from "@/composables/useRealtimeBus";
import { Sle6000Renderer, type SleChannel } from "@/render/Sle6000Renderer";
import ParamTile from "./ParamTile.vue";
import MonitoredValues from "./MonitoredValues.vue";
import ModePanel from "./ModePanel.vue";
import {
  PARAMS,
  MODES,
  SLOW_PATHS,
  SETTING_NAMES,
  decimalsOf,
  labelOf,
  stepParam,
  interlocks,
  clampParam,
  formatParam,
} from "./sleUi";
import { SLE_THEME as T, SLE_CSS_VARS } from "./sleTheme";

// On-screen replica of the SLE6000 touchscreen (IFU V2.0 §21, pp 138-155), drawn as a 1024 x 768
// frame scaled to the pane: information bar, button column, three waveforms, monitored values and
// the parameter row with +/- and Confirm. It drives the engine's Sle6000 model (instance
// "Ventilator") only through sle_apply / sle_manual_breath / sle_sigh / sle_osc_pause / sle_o2_boost,
// so every change is
// validated by the device's own ranges and interlocks. Settings and monitored values come off the
// 1 Hz slow stream, waveforms off the fast stream (never Vue-reactive).

const { watch: watchProps, watchSlow, slowValues, modelState, modelReady, isRunning, call } = useExplain();
const { addRenderer, removeRenderer } = useRealtimeBus();

const W = 1024;
const H = 768;
const host = ref<HTMLDivElement | null>(null);
const wave = ref<HTMLDivElement | null>(null);
const scale = ref(0.6);
let renderer: Sle6000Renderer | null = null;
let ro: ResizeObserver | null = null;

// ---- engine state ---------------------------------------------------------------------------
const latest = computed<Record<string, unknown>>(() => {
  const arr = slowValues.value as any[];
  return Array.isArray(arr) && arr.length ? arr[arr.length - 1] : {};
});
const vent = computed<any>(() => (modelState.value as any)?.models?.Ventilator ?? null);
const isSle = computed(() => vent.value?.model_type === "Sle6000");
const weight = computed(() => {
  const w = Number((modelState.value as any)?.weight);
  return Number.isFinite(w) && w > 0 ? Math.round(w * 10) / 10 : null;
});
const read = (k: string) => latest.value[`Ventilator.${k}`] ?? vent.value?.[k];
const liveMode = computed(() => String(read("sle_mode") ?? "Standby"));
const live = computed(() => {
  const s: Record<string, number> = {};
  for (const k of SETTING_NAMES) {
    const v = Number(read(`sle_${k}`));
    s[k] = Number.isFinite(v) ? v : PARAMS[k].def;
  }
  return s;
});
const liveCircuit = computed(() => Number(read("sle_circuit") ?? 10));
const boostLeft = computed(() => Number(read("o2_boost_remaining") ?? 0));
const oscPauseLeft = computed(() => Number(read("hfo_pause_remaining") ?? 0));
const sighing = computed(() => Number(read("hfo_sigh_remaining") ?? 0) > 0);
const ventilating = computed(() => liveMode.value !== "Standby");

// ---- local edit state -----------------------------------------------------------------------
const pending = reactive<Record<string, number>>({});
const sent = ref<Record<string, number> | null>(null); // shown until the slow stream catches up
let sentAge = 0;
const previewMode = ref<string | null>(null);
const pendingCircuit = ref<number | null>(null);
const selected = ref<string | null>(null);
const panel = ref<"mode" | null>(null);
const showExtra = ref(false);
const doubleColumn = ref(true); // as on the device photos; a 1 s hold switches to single
const locked = ref(false);
const lockHint = ref(false);
const pausedLeft = ref(0);
const now = ref(new Date());

const rowMode = computed(() => {
  if (previewMode.value && previewMode.value !== "Standby") return previewMode.value;
  return ventilating.value ? liveMode.value : null;
});
const shown = computed(() => {
  const s = { ...live.value, ...(sent.value ?? {}), ...pending };
  return rowMode.value ? interlocks(s, rowMode.value, Object.keys(pending)) : s;
});
const dirty = computed(
  () => Object.keys(pending).length > 0 || previewMode.value !== null || pendingCircuit.value !== null,
);
const row = (which: "main" | "extra") => (rowMode.value ? MODES[rowMode.value][which] : []);

watch(latest, () => {
  if (sent.value && ++sentAge >= 2) sent.value = null;
});

function tileState(name: string): "available" | "selected" | "preview" {
  if (selected.value === name) return "selected";
  if (previewMode.value || name in pending) return "preview";
  return "available";
}

// ---- timeouts (p138): a selected parameter 15 s, a panel or the additional row 120 s ----------
let idle: ReturnType<typeof setTimeout> | null = null;
let extraTimer: ReturnType<typeof setTimeout> | null = null;
function touch() {
  if (idle) clearTimeout(idle);
  idle = null;
  if (panel.value || previewMode.value) idle = setTimeout(discard, 120_000);
  else if (selected.value || dirty.value) idle = setTimeout(discard, 15_000);
}
function discard() {
  for (const k of Object.keys(pending)) delete pending[k];
  previewMode.value = null;
  pendingCircuit.value = null;
  selected.value = null;
  panel.value = null;
}

// ---- interactions ---------------------------------------------------------------------------
function tap(name: string) {
  selected.value = selected.value === name ? null : name;
  touch();
}
function nudge(dir: number) {
  const n = selected.value;
  if (!n) return;
  pending[n] = stepParam(n, shown.value[n], dir);
  touch();
}
function hold(name: string) {
  if (name === "o2") {
    // O2 Boost (p128): hold the O2 tile, toggles on/off
    if (ventilating.value) call("Ventilator.sle_o2_boost", [!(boostLeft.value > 0)]);
    return;
  }
  // Off functions switch on with their start value (p150)
  if (PARAMS[name].off && shown.value[name] === 0) {
    // HFO VTV switches on at the last measured Vte (p166)
    const vte = Number(read("mon_vte"));
    pending[name] =
      name === "hfo_vtv" && vte > 0 ? clampParam(name, vte) : (PARAMS[name].on ?? PARAMS[name].min);
    selected.value = name;
    touch();
  }
}
function confirm() {
  if (!dirty.value) return;
  const settings: Record<string, unknown> = { ...pending };
  if (previewMode.value) settings.mode = previewMode.value;
  else if (!ventilating.value) return; // nothing to apply in Standby without a mode
  if (pendingCircuit.value !== null) settings.circuit = pendingCircuit.value;
  call("Ventilator.sle_apply", [settings]);
  sent.value = { ...(sent.value ?? {}), ...pending };
  sentAge = 0;
  discard();
  showExtra.value = false;
}
function openMode() {
  if (panel.value === "mode") {
    discard();
    return;
  }
  panel.value = "mode";
  selected.value = null;
  touch();
}
function pickMode(m: string) {
  previewMode.value = m;
  touch();
}
function pickCircuit(d: number) {
  pendingCircuit.value = d === liveCircuit.value ? null : d;
  if (!previewMode.value) previewMode.value = ventilating.value ? liveMode.value : null;
  touch();
}
function toggleExtra() {
  showExtra.value = !showExtra.value;
  if (extraTimer) clearTimeout(extraTimer);
  if (showExtra.value) extraTimer = setTimeout(() => (showExtra.value = false), 120_000);
}
// the bottom-left button: Manual Breath, or Sigh in HFOV (p155)
const hfov = computed(() => ventilating.value && liveMode.value === "HFOV");
function manualBreath() {
  if (!ventilating.value) return;
  call(hfov.value ? "Ventilator.sle_sigh" : "Ventilator.sle_manual_breath", []);
}
function oscPause() {
  if (hfov.value) call("Ventilator.sle_osc_pause", []);
}
// a list setting shows its name, e.g. I:E "1:2"; HFO Activity labels its two ends
const displayOf = (n: string) => (PARAMS[n].choices ? formatParam(n, shown.value[n], 0) : null);
const endsOf = (n: string): [string, string] | null => (n === "hfo_activity" ? ["I+E", "E"] : null);
// the sub-labels under the mode name (lit when on), as on the device screens
const subLabels = computed(() => {
  const m = previewMode.value ?? liveMode.value;
  const s = shown.value;
  if (m === "HFOV") return [{ t: "VTV", on: s.hfo_vtv > 0 }, { t: "Sigh", on: s.sigh_rr > 0 }];
  if (m === "CPAP" || m === "HFOV+CMV" || m === "Standby") return [];
  return ventilating.value || previewMode.value ? [{ t: "VTV", on: s.vtv > 0 }] : [];
});

// pause/play (p154): freeze the graphics for 120 s
let pauseTimer: ReturnType<typeof setInterval> | null = null;
function togglePause() {
  if (pausedLeft.value > 0) {
    pausedLeft.value = 0;
  } else {
    pausedLeft.value = 120;
    if (pauseTimer) clearInterval(pauseTimer);
    pauseTimer = setInterval(() => {
      pausedLeft.value = Math.max(0, pausedLeft.value - 1);
      if (!pausedLeft.value && pauseTimer) clearInterval(pauseTimer);
    }, 1000);
  }
}
watch(pausedLeft, (v) => renderer?.setPaused(v > 0));

// lock (p154): lock with a press, unlock with a 1 s hold
let lockTimer: ReturnType<typeof setTimeout> | null = null;
function lockDown() {
  if (!locked.value) {
    locked.value = true;
    discard();
    return;
  }
  lockTimer = setTimeout(() => {
    locked.value = false;
    lockHint.value = false;
  }, 1000);
}
function lockUp() {
  if (lockTimer) clearTimeout(lockTimer);
  lockTimer = null;
}

const mmss = (s: number) => `${Math.floor(s / 60)}min ${String(Math.floor(s % 60)).padStart(2, "0")}s`;
const message = computed(() => {
  if (locked.value && lockHint.value) return "Screen is locked. To unlock, press and hold for 1 second";
  if (pausedLeft.value > 0) return `Graphics Section paused ${pausedLeft.value} secs`;
  if (!isRunning.value) return "Simulation stopped: settings apply when it runs";
  if (oscPauseLeft.value > 0) return `Oscillation Paused ${Math.ceil(oscPauseLeft.value)} secs`;
  if (boostLeft.value > 0) return `O2 Boost in Progress ${mmss(boostLeft.value)}`;
  if (!ventilating.value) return "Standby: Patient not ventilated";
  return "";
});
const clock = computed(() => now.value.toLocaleTimeString("en-GB"));
const date = computed(() => now.value.toLocaleDateString("en-GB").replace(/\//g, "-"));

// ---- waveforms ------------------------------------------------------------------------------
const CHANNELS: SleChannel[] = [
  {
    signal: "Ventilator.pres",
    title: "Pressure (mbar)",
    scale: 1 / 1.01972,
    ranges: [[-5, 20], [-5, 30], [-10, 40], [-10, 60], [-20, 80]],
    color: T.pressure.line,
    fill: T.pressure.fill,
  },
  {
    signal: "Ventilator.flow",
    title: "Flow (l/min)",
    ranges: [[-5, 5], [-10, 10], [-20, 20], [-40, 40], [-80, 80]],
    color: T.flow.line,
    fill: T.flow.fill,
  },
  {
    // the volume trace restarts at each breath and spontaneous breaths between ventilator breaths
    // take it below zero, so every range keeps some room under the baseline
    signal: "Ventilator.vol",
    title: "Volume (ml)",
    ranges: [[-5, 15], [-10, 30], [-20, 60], [-40, 120], [-100, 250], [-200, 500]],
    color: T.volume.line,
    fill: T.volume.fill,
  },
];
const PALETTE = {
  background: T.screen,
  header: T.header,
  title: T.text,
  axis: T.axis,
  tick: T.label,
  zero: T.zero,
  sweep: T.sweep,
};
const FAST_PATHS = CHANNELS.map((c) => c.signal);

function rewatch() {
  watchProps(FAST_PATHS);
  watchSlow(SLOW_PATHS);
}
watch(modelReady, (ready) => {
  if (ready) {
    rewatch();
    discard();
    sent.value = null;
    renderer?.clear();
  }
});

let clockTimer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  renderer = new Sle6000Renderer(wave.value!, CHANNELS, PALETTE, 6);
  addRenderer(renderer);
  rewatch();
  ro = new ResizeObserver(() => {
    const w = host.value?.clientWidth ?? W;
    scale.value = Math.max(0.3, Math.min(1.25, w / W));
    renderer?.setCssScale(scale.value);
  });
  ro.observe(host.value!);
  clockTimer = setInterval(() => (now.value = new Date()), 1000);
});
onBeforeUnmount(() => {
  ro?.disconnect();
  if (renderer) {
    removeRenderer(renderer);
    renderer.dispose();
  }
  for (const t of [idle, extraTimer, lockTimer]) if (t) clearTimeout(t);
  for (const t of [pauseTimer, clockTimer]) if (t) clearInterval(t);
});
</script>

<template>
  <div ref="host" class="w-full" :style="{ height: `${H * scale}px` }">
    <div class="sle" :style="{ transform: `scale(${scale})`, ...SLE_CSS_VARS }">
      <!-- alarm mute (top left), the mode name under it -->
      <button class="sle-bell" disabled title="Alarms come in a later phase">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 3a6 6 0 0 0-6 6v4l-2 3h16l-2-3V9a6 6 0 0 0-6-6zm-2 15a2 2 0 0 0 4 0" />
        </svg>
      </button>
      <div class="sle-modename">
        <div :class="{ long: (previewMode ?? liveMode).length > 6 }">{{ previewMode ?? liveMode }}</div>
        <div class="sub">
          <span v-for="l in subLabels" :key="l.t" :class="{ lit: l.on }">{{ l.t }}</span>
        </div>
      </div>
      <!-- information bar -->
      <div class="sle-info">
        <div class="sle-msg">{{ message }}</div>
        <button
          class="sle-lock"
          :class="{ on: locked }"
          @pointerdown="lockDown"
          @pointerup="lockUp"
          @pointerleave="lockUp"
        >
          {{ locked ? "🔒" : "Lock Screen" }}
        </button>
        <button class="sle-pause" :aria-label="pausedLeft ? 'Play' : 'Pause'" @click="togglePause">
          {{ pausedLeft ? "▶" : "❚❚" }}
        </button>
        <div class="sle-batt">▮ 100%</div>
        <div class="sle-clock">
          <div>{{ clock }}</div>
          <div class="d">{{ date }}</div>
        </div>
      </div>

      <!-- left button column -->
      <button class="sle-side" :class="{ on: panel === 'mode' }" style="top: 104px" @click="openMode">Mode</button>
      <button class="sle-side" style="top: 150px" disabled title="Alarms come in a later phase">Alarms</button>
      <button class="sle-side" style="top: 196px" disabled title="Not modelled">Utilities</button>
      <button class="sle-side" style="top: 242px" disabled title="Loops and trends come in a later phase">Layout</button>
      <button
        v-if="rowMode && MODES[rowMode].extra.length"
        class="sle-extra-btn"
        :class="{ on: showExtra }"
        @click="toggleExtra"
      >
        Additional Parameters
      </button>
      <button v-if="hfov" class="sle-oscpause" :class="{ on: oscPauseLeft > 0 }" @click="oscPause">
        Oscillation Pause<span v-if="oscPauseLeft > 0"> {{ Math.ceil(oscPauseLeft) }}s</span>
      </button>
      <button class="sle-manual" :class="{ on: hfov && sighing }" :disabled="!ventilating" @click="manualBreath">
        {{ hfov ? "Sigh" : "Manual Breath" }}
      </button>

      <!-- waveforms -->
      <div class="sle-wave">
        <div ref="wave" class="sle-wave-canvas"></div>
        <div v-if="!ventilating && isSle && !panel" class="sle-standby">
          <div>Standby: Patient not ventilated</div>
          <button @click="openMode">Start / Resume Ventilation</button>
        </div>
        <ModePanel
          v-if="panel === 'mode'"
          :current="liveMode"
          :preview="previewMode"
          :circuit="pendingCircuit ?? liveCircuit"
          @select="pickMode"
          @circuit="pickCircuit"
          @close="discard"
        />
        <!-- additional parameters row, above the main row -->
        <div v-if="showExtra && rowMode" class="sle-row extra">
          <template v-for="(n, i) in row('extra')" :key="'x' + i">
            <ParamTile
              v-if="n"
              :label="labelOf(n, rowMode, shown)"
              :unit="PARAMS[n].unit"
              :min="PARAMS[n].min"
              :max="PARAMS[n].max"
              :value="shown[n]"
              :decimals="decimalsOf(n)"
              :kind="PARAMS[n].kind"
              :state="tileState(n)"
              :can-be-off="!!PARAMS[n].off"
              :hold-ms="PARAMS[n].off ? 2000 : 0"
              :display="displayOf(n)"
              :ends="endsOf(n)"
              @tap="tap(n)"
              @hold="hold(n)"
            />
            <div v-else class="sle-gap"></div>
          </template>
        </div>
      </div>

      <!-- monitored values -->
      <div class="sle-mon-col">
        <MonitoredValues
          :values="latest"
          :double="doubleColumn"
          :active="ventilating"
          :mode="ventilating ? liveMode : null"
          @toggle="doubleColumn = !doubleColumn"
        />
      </div>

      <!-- main parameter row -->
      <div class="sle-row main">
        <template v-for="(n, i) in row('main')" :key="'m' + i">
          <ParamTile
            v-if="n"
            :label="labelOf(n, rowMode!, shown)"
            :unit="PARAMS[n].unit"
            :min="PARAMS[n].min"
            :max="PARAMS[n].max"
            :value="shown[n]"
            :decimals="decimalsOf(n)"
            :kind="PARAMS[n].kind"
            :state="tileState(n)"
            :can-be-off="!!PARAMS[n].off"
            :hold-ms="n === 'o2' ? 3000 : PARAMS[n].off ? 2000 : 0"
            :boost="n === 'o2' && boostLeft > 0 ? Math.min(100, shown.o2 + 10) : null"
            :display="displayOf(n)"
            :ends="endsOf(n)"
            @tap="tap(n)"
            @hold="hold(n)"
          />
          <div v-else class="sle-gap"></div>
        </template>
      </div>

      <!-- +/- for the selected parameter, and Confirm -->
      <div v-if="selected" class="sle-plusminus">
        <button aria-label="Increase" @click="nudge(1)">+</button>
        <button aria-label="Decrease" @click="nudge(-1)">−</button>
      </div>
      <button v-if="dirty" class="sle-confirm" aria-label="Confirm" @click="confirm">✓</button>

      <!-- the adult scenarios keep the generic ventilator: outside the device's patient range -->
      <div v-if="!isSle" class="sle-notice">
        <div v-if="vent">Patient outside the SLE6000 range (0.3–30 kg)</div>
        <div v-else>This scenario has no ventilator.</div>
        <div v-if="vent && weight" class="sle-notice-sub">Patient weight {{ weight }} kg</div>
      </div>
      <!-- lock overlay -->
      <div v-if="locked" class="sle-lock-overlay" @click="lockHint = true"></div>
    </div>
  </div>
</template>

<style scoped>
/* the SLE6000 "Lunar" dark interface; colours in sleTheme.ts (from vendor product photos) */
.sle {
  position: relative;
  width: 1024px;
  height: 768px;
  transform-origin: 0 0;
  background: var(--sle-screen);
  border: 2px solid #2b2d31;
  border-radius: 10px;
  overflow: hidden;
  font-family: Arial, Helvetica, sans-serif;
  color: var(--sle-text);
  user-select: none;
}
button {
  font-family: inherit;
  cursor: pointer;
}
button:disabled {
  cursor: default;
}
.sle-bell {
  position: absolute;
  left: 8px;
  top: 6px;
  width: 96px;
  height: 36px;
  background: transparent;
  border: 2px solid var(--sle-mute);
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.sle-bell svg {
  width: 22px;
  height: 22px;
  fill: none;
  stroke: var(--sle-mute);
  stroke-width: 1.8;
}
.sle-modename {
  position: absolute;
  left: 10px;
  top: 50px;
  width: 96px;
  font-size: 20px;
  line-height: 1.1;
}
.sle-modename .long {
  font-size: 15px;
  line-height: 24px;
}
.sle-modename .sub {
  font-size: 11px;
  color: var(--sle-label);
  height: 13px;
  display: flex;
  gap: 12px;
}
.sle-modename .sub span {
  opacity: 0.45;
}
.sle-modename .sub span.lit {
  opacity: 1;
  color: var(--sle-text);
}
.sle-info {
  position: absolute;
  left: 112px;
  right: 0;
  top: 0;
  height: 46px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
  background: var(--sle-screen);
}
.sle-msg {
  flex: 1;
  font-size: 15px;
  padding-left: 8px;
}
.sle-lock,
.sle-pause {
  height: 34px;
  min-width: 96px;
  background: var(--sle-button);
  color: var(--sle-text);
  border: 1px solid #000;
  border-radius: 5px;
  font-size: 13px;
}
.sle-lock {
  position: relative;
  z-index: 16; /* above the lock overlay: the only control that works while locked */
}
.sle-lock.on {
  background: var(--sle-text);
  color: #000;
}
.sle-pause {
  min-width: 40px;
}
.sle-batt {
  font-size: 11px;
  width: 48px;
  text-align: center;
  color: var(--sle-label);
}
.sle-clock {
  font-size: 15px;
  text-align: right;
  width: 74px;
}
.sle-clock .d {
  font-size: 9px;
  color: var(--sle-label);
}
.sle-side {
  position: absolute;
  left: 8px;
  width: 96px;
  height: 40px;
  background: var(--sle-button);
  color: var(--sle-text);
  border: 1px solid #000;
  border-radius: 6px;
  font-size: 13px;
  font-style: italic;
}
.sle-side.on {
  background: var(--sle-text);
  color: #000;
}
.sle-side:disabled {
  opacity: 0.5;
}
.sle-extra-btn,
.sle-oscpause,
.sle-manual {
  position: absolute;
  left: 8px;
  width: 96px;
  background: var(--sle-button);
  color: var(--sle-text);
  border: 1px solid #000;
  border-radius: 8px;
  font-size: 13px;
  font-style: italic;
}
.sle-extra-btn {
  top: 540px;
  height: 104px;
}
.sle-extra-btn.on {
  background: var(--sle-text);
  color: #000;
}
.sle-manual {
  top: 654px;
  height: 108px;
}
.sle-oscpause {
  top: 482px;
  height: 52px;
}
.sle-oscpause.on,
.sle-manual.on {
  background: var(--sle-text);
  color: #000;
}
.sle-manual:disabled {
  opacity: 0.5;
}
.sle-wave {
  position: absolute;
  left: 112px;
  top: 50px;
  width: 652px;
  height: 596px;
}
.sle-wave-canvas {
  position: absolute;
  inset: 0;
  background: var(--sle-screen);
}
.sle-standby {
  position: absolute;
  inset: 120px 60px;
  background: var(--sle-panel);
  border: 1px solid #000;
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 18px;
  font-size: 18px;
  z-index: 3;
}
.sle-standby button,
.sle-notice button {
  background: var(--sle-button);
  color: var(--sle-text);
  border: 1px solid #000;
  border-radius: 6px;
  padding: 14px 28px;
  font-size: 16px;
}
.sle-row {
  position: absolute;
  display: flex;
  gap: 2px;
}
.sle-row.main {
  left: 112px;
  top: 654px;
}
.sle-row.extra {
  left: 0;
  bottom: 0;
  padding: 2px 0;
  z-index: 4;
}
.sle-gap {
  width: 108px;
  height: 108px;
}
.sle-mon-col {
  position: absolute;
  left: 770px;
  right: 6px;
  top: 50px;
  height: 540px;
}
.sle-plusminus {
  position: absolute;
  left: 770px;
  top: 600px;
  display: flex;
  gap: 6px;
  z-index: 6;
}
.sle-plusminus button {
  width: 56px;
  height: 46px;
  background: var(--sle-button);
  color: var(--sle-text);
  border: 1px solid #000;
  border-radius: 6px;
  font-size: 26px;
  line-height: 1;
}
.sle-confirm {
  position: absolute;
  left: 900px;
  top: 654px;
  width: 116px;
  height: 108px;
  background: var(--sle-button);
  color: var(--sle-o2);
  border: 1px solid #000;
  border-radius: 8px;
  font-size: 54px;
  line-height: 1;
}
.sle-notice {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.88);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 20px;
  font-size: 20px;
  z-index: 20;
}
.sle-notice-sub {
  font-size: 15px;
  color: var(--sle-label);
}
.sle-lock-overlay {
  position: absolute;
  inset: 0;
  z-index: 15;
}
</style>
