<script setup lang="ts">
import { computed, reactive } from "vue";
import { SPO2_TARGETS, SPO2_AVG, spo2AvgLabel } from "./sleUi";

// The Utilities panel (IFU §18.3, p104), dark like the Layout panel: only the Sensors tab, and in it
// only SpO2, is modelled. SpO2 monitoring on/off, the OxyGenie target range ("Auto O2: SpO2 Target
// range limits") and the averaging time, fixed at 2-4 s while OxyGenie is on. Nothing changes
// before Confirm.
export interface Spo2Settings {
  on: boolean;
  target: string;
  avg: number;
}
const props = defineProps<{ spo2: Spo2Settings; oxygenie: boolean }>();
const emit = defineEmits<{ (e: "confirm", settings: Partial<Spo2Settings>): void; (e: "close"): void }>();

const draft = reactive<Spo2Settings>({ ...props.spo2 });
const changes = computed(() => {
  const c: Partial<Spo2Settings> = {};
  if (draft.on !== props.spo2.on) c.on = draft.on;
  if (draft.target !== props.spo2.target) c.target = draft.target;
  if (draft.avg !== props.spo2.avg) c.avg = draft.avg;
  return c;
});
const changed = computed(() => Object.keys(changes.value).length > 0);
</script>

<template>
  <div class="sle-panel">
    <div class="sle-panel-tabs">
      <button class="on">Sensors</button>
      <button class="close" aria-label="Close" @click="emit('close')">✕</button>
    </div>
    <div class="sensors">
      <button class="on">SpO2</button>
      <button disabled title="Not modelled">etCO2</button>
    </div>

    <div class="body">
      <div class="row">
        <div class="cap">SpO2 monitoring</div>
        <button class="opt" :class="{ sel: draft.on }" @click="draft.on = true">On</button>
        <button class="opt" :class="{ sel: !draft.on }" @click="draft.on = false">Off</button>
      </div>
      <div class="row">
        <div class="cap">Auto O2: SpO2 target range</div>
        <button v-for="t in SPO2_TARGETS" :key="t" class="opt" :class="{ sel: draft.target === t }" @click="draft.target = t">
          {{ t }}%
        </button>
      </div>
      <div class="row">
        <div class="cap">Averaging time (s)</div>
        <button
          v-for="a in SPO2_AVG"
          :key="a"
          class="opt small"
          :class="{ sel: (oxygenie ? 3 : draft.avg) === a }"
          :disabled="oxygenie"
          @click="draft.avg = a"
        >
          {{ spo2AvgLabel(a) }}
        </button>
      </div>
      <div class="hint">
        Turning SpO2 monitoring off also switches OxyGenie off. The averaging time is fixed at 2-4 seconds while
        OxyGenie is on.
      </div>
    </div>

    <div class="foot">
      <button class="confirm" :disabled="!changed" aria-label="Confirm SpO2 settings" @click="emit('confirm', changes)">
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
.sle-panel-tabs,
.sensors {
  display: flex;
  gap: 4px;
  padding: 6px;
}
.sensors {
  padding-top: 0;
}
.sle-panel-tabs button,
.sensors button {
  background: #4a4d52;
  color: #f2f2f2;
  border: 1px solid #1d1e21;
  border-radius: 5px;
  padding: 8px 18px;
  font-size: 14px;
}
.sle-panel-tabs button.on,
.sensors button.on {
  background: #f2f2f2;
  color: #1d1e21;
}
.sensors button:disabled {
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
  gap: 8px;
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
.opt.small {
  min-width: 56px;
  font-size: 14px;
}
.opt.sel {
  background: #f2f2f2;
  color: #1d1e21;
}
.opt:disabled {
  opacity: 0.45;
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
