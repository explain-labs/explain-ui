<script setup lang="ts">
import { ref } from "vue";

// The Mode panel (IFU p139, p151; dark like the rest of the device screen, an assumption as no
// photo shows it open): an overlay with dark tabs (Invasive | Non-invasive |
// Standby), the mode buttons and the patient-circuit selector. Picking a mode previews its
// parameters along the bottom; nothing changes until Confirm. HFO and the non-invasive modes come
// in later phases and are shown disabled.
defineProps<{ current: string; preview: string | null; circuit: number }>();
const emit = defineEmits<{
  (e: "select", mode: string): void;
  (e: "circuit", d: number): void;
  (e: "close"): void;
}>();

const tab = ref<"invasive" | "standby">("invasive");
const INVASIVE = ["CPAP", "CMV", "PTV", "PSV", "SIMV"];
const LATER = ["HFOV", "HFOV+CMV"];
</script>

<template>
  <div class="sle-panel">
    <div class="sle-panel-tabs">
      <button :class="{ on: tab === 'invasive' }" @click="tab = 'invasive'">Invasive</button>
      <button disabled title="Non-invasive modes: a later phase">Non-invasive</button>
      <button :class="{ on: tab === 'standby' }" @click="tab = 'standby'">Standby</button>
      <button class="close" aria-label="Close" @click="emit('close')">✕</button>
    </div>
    <div v-if="tab === 'invasive'" class="sle-panel-body">
      <div class="modes">
        <button
          v-for="m in INVASIVE"
          :key="m"
          class="mode"
          :class="{ sel: (preview ?? current) === m, cur: current === m }"
          @click="emit('select', m)"
        >
          {{ m }}
        </button>
        <button v-for="m in LATER" :key="m" class="mode" disabled title="HFO modes: a later phase">{{ m }}</button>
      </div>
      <div class="circuits">
        <div class="cap">Patient Circuit</div>
        <button
          v-for="d in [10, 15]"
          :key="d"
          class="circuit"
          :class="{ sel: circuit === d }"
          @click="emit('circuit', d)"
        >
          <svg viewBox="0 0 60 30" class="tube">
            <path d="M4 22 C 16 4, 44 4, 56 22" :stroke-width="d === 10 ? 3 : 5" />
          </svg>
          {{ d }}mm
        </button>
        <div class="hint">10 mm for Vt &lt; 50 ml, 15 mm above</div>
      </div>
    </div>
    <div v-else class="sle-panel-body standby">
      <p>Standby stops ventilation: the patient is not ventilated.</p>
      <button class="mode" :class="{ sel: preview === 'Standby' }" @click="emit('select', 'Standby')">Standby</button>
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
.sle-panel-body {
  display: flex;
  gap: 24px;
  padding: 14px;
}
.modes {
  display: grid;
  grid-template-columns: repeat(3, 120px);
  gap: 10px;
  align-content: start;
}
.mode {
  height: 64px;
  background: #4a4d52;
  color: #f2f2f2;
  border: 2px solid #1d1e21;
  border-radius: 6px;
  font-size: 18px;
}
.mode.cur {
  box-shadow: inset 0 0 0 2px #7ed321;
}
.mode.sel {
  background: #f2f2f2;
  color: #1d1e21;
}
.mode:disabled {
  opacity: 0.35;
}
.circuits {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-left: auto;
  width: 170px;
}
.cap {
  font-size: 13px;
  color: #f2f2f2;
}
.circuit {
  display: flex;
  align-items: center;
  gap: 10px;
  background: #4a4d52;
  color: #f2f2f2;
  border: 2px solid #1d1e21;
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 15px;
}
.circuit.sel {
  border-color: #7ed321;
  box-shadow: 0 0 0 2px #7ed321;
}
.tube {
  width: 52px;
  height: 26px;
}
.tube path {
  fill: none;
  stroke: #d9dadc;
}
.hint {
  font-size: 11px;
  color: #a9acb1;
}
.standby {
  flex-direction: column;
  align-items: flex-start;
  color: #f2f2f2;
  font-size: 15px;
}
.standby .mode {
  width: 160px;
}
</style>
