<script setup lang="ts">
import { computed, reactive } from "vue";
import { WAVES, WAVE_LABEL, LOOP_LABEL, type SleLayout, type WaveName, type LoopKind } from "./sleUi";

// The Layout panel (IFU §21.1.8, pp 145-146), dark like the Mode panel: the Waveforms / Loops /
// Trends layouts as tabs, each with its options. The tab picked is the layout that Confirm
// applies; nothing changes before. Waveforms: up to two of the three waveforms off, filled or
// lines. Loops: the waveform on top, the primary loop (V/P default) and the secondary loop (F/V
// default). Trends come in a later phase.
const props = defineProps<{ layout: SleLayout }>();
const emit = defineEmits<{ (e: "confirm", layout: SleLayout): void; (e: "close"): void }>();

const draft = reactive<SleLayout>({ ...props.layout, waves: [...props.layout.waves] });
const LOOP_KINDS: LoopKind[] = ["VP", "FV", "FP"];

function toggleWave(w: WaveName) {
  const on = draft.waves.includes(w);
  if (on && draft.waves.length === 1) return; // at least one waveform stays on
  draft.waves = on ? draft.waves.filter((x) => x !== w) : WAVES.filter((x) => x === w || draft.waves.includes(x));
}
const changed = computed(() => JSON.stringify(draft) !== JSON.stringify(props.layout));
</script>

<template>
  <div class="sle-panel">
    <div class="sle-panel-tabs">
      <button :class="{ on: draft.kind === 'waveforms' }" @click="draft.kind = 'waveforms'">Waveforms</button>
      <button :class="{ on: draft.kind === 'loops' }" @click="draft.kind = 'loops'">Loops</button>
      <button disabled title="Trends: a later phase">Trends</button>
      <button class="close" aria-label="Close" @click="emit('close')">✕</button>
    </div>

    <div v-if="draft.kind === 'waveforms'" class="body">
      <div class="row">
        <div class="cap">Waveforms</div>
        <button v-for="w in WAVES" :key="w" class="opt" :class="{ sel: draft.waves.includes(w) }" @click="toggleWave(w)">
          {{ WAVE_LABEL[w] }}
        </button>
      </div>
      <div class="row">
        <div class="cap">Filled</div>
        <button class="opt" :class="{ sel: draft.filled }" @click="draft.filled = !draft.filled">
          {{ draft.filled ? "On" : "Off" }}
        </button>
      </div>
      <div class="hint">Two of the three waveforms can be turned off.</div>
    </div>

    <div v-else class="body">
      <div class="row">
        <div class="cap">Waveform</div>
        <button v-for="w in WAVES" :key="w" class="opt" :class="{ sel: draft.loopWave === w }" @click="draft.loopWave = w">
          {{ WAVE_LABEL[w] }}
        </button>
      </div>
      <div class="row">
        <div class="cap">Primary loop</div>
        <button v-for="k in LOOP_KINDS" :key="k" class="opt" :class="{ sel: draft.primary === k }" @click="draft.primary = k">
          {{ LOOP_LABEL[k] }}
        </button>
      </div>
      <div class="row">
        <div class="cap">Secondary loop</div>
        <button v-for="k in LOOP_KINDS" :key="k" class="opt" :class="{ sel: draft.secondary === k }" @click="draft.secondary = k">
          {{ LOOP_LABEL[k] }}
        </button>
      </div>
      <div class="hint">V/P volume against pressure, F/V flow against volume, F/P flow against pressure.</div>
    </div>

    <div class="foot">
      <button class="confirm" :disabled="!changed" aria-label="Confirm layout" @click="emit('confirm', { ...draft, waves: [...draft.waves] })">
        ✓
      </button>
    </div>
  </div>
</template>

<style scoped>
.sle-panel {
  position: absolute;
  inset: 0;
  background: #2b2d31;
  border: 1px solid #000;
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  color: #f2f2f2;
  font-family: Arial, Helvetica, sans-serif;
  z-index: 5;
}
.sle-panel-tabs {
  display: flex;
  gap: 4px;
  padding: 6px;
}
.sle-panel-tabs button {
  background: #4a4d52;
  color: #f2f2f2;
  border: 1px solid #1d1e21;
  border-radius: 5px;
  padding: 8px 18px;
  font-size: 14px;
}
.sle-panel-tabs button.on {
  background: #f2f2f2;
  color: #1d1e21;
}
.sle-panel-tabs button:disabled {
  opacity: 0.4;
}
.sle-panel-tabs .close {
  margin-left: auto;
  padding: 8px 14px;
}
.body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px 14px;
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.cap {
  width: 130px;
  font-size: 14px;
}
.opt {
  min-width: 96px;
  height: 52px;
  background: #4a4d52;
  color: #f2f2f2;
  border: 2px solid #1d1e21;
  border-radius: 6px;
  font-size: 16px;
}
.opt.sel {
  background: #f2f2f2;
  color: #1d1e21;
}
.hint {
  font-size: 11px;
  color: #a9acb1;
}
.foot {
  margin-top: auto;
  display: flex;
  justify-content: flex-end;
  padding: 10px;
}
.confirm {
  width: 96px;
  height: 64px;
  background: #4a4d52;
  color: #7ed321;
  border: 1px solid #000;
  border-radius: 8px;
  font-size: 40px;
  line-height: 1;
}
.confirm:disabled {
  opacity: 0.35;
}
</style>
