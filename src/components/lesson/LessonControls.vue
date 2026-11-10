<script setup lang="ts">
import { inject, ref } from "vue";
import SelectButton from "primevue/selectbutton";
import Slider from "primevue/slider";
import InputNumber from "primevue/inputnumber";
import Button from "primevue/button";
import { LessonKey } from "@/composables/useLesson";
import { t, UI } from "@/lessons/i18n";
import type { Intervention, SliderIntervention } from "@/lessons/interventions";

// The lesson's intervention controls (from the interventions registry). Always
// usable; controls the current step names in `controls` get a spotlight ring.
const rt = inject(LessonKey)!;

function spotlit(c: Intervention): boolean {
  return !!rt.step.value.controls?.includes(c.id);
}

function toggleOptions(c: Intervention) {
  if (c.kind !== "toggle") return [];
  return [
    { label: t(c.on.label, rt.lang.value), value: "on" },
    { label: t(c.off.label, rt.lang.value), value: "off" },
  ];
}

function onToggle(c: Intervention, v: "on" | "off" | null) {
  if (v) rt.applyControl(c.id, v); // SelectButton emits null when re-clicking the active option
}

// ----- sliders ------------------------------------------------------------------
const fmt = (c: SliderIntervention, v: number | undefined) =>
  v === undefined ? "—" : `${v.toFixed(c.rounding ?? 0)}${c.unit ?? ""}`;

// apply a display-unit value (slider release or typed number)
function applyDisplay(c: SliderIntervention, display: number | null | undefined) {
  if (display == null || !Number.isFinite(display)) return;
  const clamped = Math.max(c.min, Math.min(c.max, display));
  const current = rt.sliderValue(c);
  if (current !== undefined && Math.abs(current - clamped) < 1e-9) return;
  rt.applyControl(c.id, rt.sliderRaw(c, clamped));
}

// PrimeVue's Slider emits `slideend` only at the end of a drag; a click on the track or the arrow
// keys only emit `change`. So `change` is applied too, debounced (a drag emits it per move), and the
// position the learner is moving to is kept as a draft so the handle doesn't jump back meanwhile.
const sliderDraft = ref<Record<string, number>>({});
const sliderTimers: Record<string, number> = {};
function onSliderMove(id: string, v: number, apply: (v: number) => void) {
  sliderDraft.value = { ...sliderDraft.value, [id]: v };
  window.clearTimeout(sliderTimers[id]);
  sliderTimers[id] = window.setTimeout(() => commitSlider(id, v, apply), 250);
}
function commitSlider(id: string, v: number, apply: (v: number) => void) {
  window.clearTimeout(sliderTimers[id]);
  apply(v);
  const next = { ...sliderDraft.value };
  delete next[id];
  sliderDraft.value = next;
}
const first = (e: any) => (Array.isArray(e?.value ?? e) ? (e.value ?? e)[0] : (e?.value ?? e));

// typed values are applied on Enter or blur, not per keystroke
const drafts = ref<Record<string, number | null>>({});
function commitDraft(c: SliderIntervention) {
  if (!(c.id in drafts.value)) return;
  applyDisplay(c, drafts.value[c.id]);
  const next = { ...drafts.value };
  delete next[c.id];
  drafts.value = next;
}
function inputValue(c: SliderIntervention): number | null {
  if (c.id in drafts.value) return drafts.value[c.id];
  const v = rt.sliderValue(c);
  return v === undefined ? null : Number(v.toFixed(c.rounding ?? 0));
}
</script>

<template>
  <section class="flex flex-col gap-2">
    <div
      v-for="c in rt.controls.value"
      :key="c.id"
      class="flex flex-col gap-1.5 rounded border p-2 transition-colors"
      :class="spotlit(c) ? 'border-amber-400 ring-1 ring-amber-400/60' : 'border-surface-700'"
    >
      <div class="flex items-center justify-between gap-2">
        <span class="font-medium">{{ t(c.label, rt.lang.value) }}</span>
        <!-- slider: current value, and "current → target" while it tweens -->
        <span v-if="c.kind === 'slider'" class="flex items-center gap-1.5 text-sm tabular-nums">
          <template v-if="rt.isPending(c.id)">
            <i class="pi pi-spin pi-spinner text-[0.7rem] opacity-70"></i>
            <span class="text-xs opacity-70">
              {{ t(rt.isClosing(c.id) ? UI.closing : UI.opening, rt.lang.value) }}
            </span>
            <span>{{ fmt(c, rt.sliderActual(c)) }}</span>
            <i class="pi pi-arrow-right text-[0.6rem] opacity-60"></i>
            <span class="font-semibold">{{ fmt(c, rt.sliderValue(c)) }}</span>
          </template>
          <span v-else class="font-semibold">{{ fmt(c, rt.sliderActual(c)) }}</span>
        </span>
        <span v-else-if="rt.isPending(c.id)" class="flex items-center gap-1 text-xs opacity-70">
          <i class="pi pi-spin pi-spinner text-[0.7rem]"></i>
          {{ t(rt.isClosing(c.id) ? UI.closing : UI.opening, rt.lang.value) }}
        </span>
      </div>

      <SelectButton
        v-if="c.kind === 'toggle'"
        :model-value="rt.toggleState(c)"
        :options="toggleOptions(c)"
        option-label="label"
        option-value="value"
        size="small"
        :disabled="!rt.modelReady.value"
        @update:model-value="(v: 'on' | 'off' | null) => onToggle(c, v)"
      />

      <div v-else-if="c.kind === 'slider'" class="flex items-center gap-3">
        <Slider
          :model-value="sliderDraft[c.id] ?? rt.sliderValue(c) ?? c.min"
          :min="c.min"
          :max="c.max"
          :step="c.step"
          class="flex-1"
          :disabled="!rt.modelReady.value"
          @change="(v: any) => onSliderMove(c.id, first(v), (x) => applyDisplay(c, x))"
          @slideend="(e: any) => commitSlider(c.id, first(e), (x) => applyDisplay(c, x))"
        />
        <InputNumber
          :model-value="inputValue(c)"
          :min="c.min"
          :max="c.max"
          :suffix="c.unit ? ` ${c.unit}` : undefined"
          :max-fraction-digits="c.rounding ?? 0"
          size="small"
          input-class="w-16 text-right"
          :disabled="!rt.modelReady.value"
          @update:model-value="(v: number | null) => (drafts = { ...drafts, [c.id]: v })"
          @keydown.enter="commitDraft(c)"
          @blur="commitDraft(c)"
        />
      </div>

      <!-- relative slider: centred on "now", shows only the change, never the absolute value -->
      <div v-else-if="c.kind === 'relslider'" class="flex flex-col gap-0.5">
        <div class="flex items-center gap-3">
          <Slider
            :model-value="sliderDraft[c.id] ?? rt.relPosition(c)"
            :min="-1"
            :max="1"
            :step="0.05"
            class="flex-1 relslider"
            :disabled="!rt.modelReady.value"
            @change="(v: any) => onSliderMove(c.id, first(v), (x) => rt.applyRel(c, x))"
            @slideend="(e: any) => commitSlider(c.id, first(e), (x) => rt.applyRel(c, x))"
          />
          <span class="w-12 text-right text-sm tabular-nums font-semibold">{{ rt.relLabel(c) }}</span>
        </div>
        <div class="flex justify-between text-[10px] opacity-50 pr-14">
          <span>less</span><span>now</span><span>more</span>
        </div>
      </div>

      <!-- up/down: no value shown, each press changes the target relative to now -->
      <div v-else-if="c.kind === 'updown'" class="flex items-center gap-2 updown">
        <Button
          label="−"
          size="small"
          severity="secondary"
          :aria-label="`${t(c.label, rt.lang.value)} down`"
          :disabled="!rt.modelReady.value"
          @click="rt.applyControl(c.id, 'off')"
        />
        <Button
          label="+"
          size="small"
          severity="secondary"
          :aria-label="`${t(c.label, rt.lang.value)} up`"
          :disabled="!rt.modelReady.value"
          @click="rt.applyControl(c.id, 'on')"
        />
      </div>

      <Button
        v-else
        :label="t(c.label, rt.lang.value)"
        :icon="c.icon"
        size="small"
        severity="secondary"
        :disabled="!rt.modelReady.value"
        @click="rt.applyControl(c.id, 'on')"
      />

      <p v-if="c.help" class="text-xs opacity-60 leading-snug">{{ t(c.help, rt.lang.value) }}</p>
    </div>
  </section>
</template>

<style scoped>
.updown :deep(.p-button) {
  min-width: 2.75rem;
  font-size: 1.1rem;
  font-weight: 700;
}
</style>
