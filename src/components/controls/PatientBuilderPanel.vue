<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import Panel from "primevue/panel";
import Button from "primevue/button";
import InputNumber from "primevue/inputnumber";
import InputText from "primevue/inputtext";
import Select from "primevue/select";
import Checkbox from "primevue/checkbox";
import Tag from "primevue/tag";
import { usePatientBuilderStore } from "@/stores/patientBuilder";
import { CATEGORY_LABELS, PATIENT_FIELDS, fromSpecValue, numberField, type FieldCategory, type PatientField } from "@/services/patientSchema";
import { atrialFlowNote, ductalFlowNote, targetCaption, type ResultRow, type ValueRow } from "@/services/patientBuilder";

// Patient builder: enter what was measured on a real neonate, let the AI bot
// fill the structural unknowns and the server calibrate a patient to it, then
// review what the patient was built from before loading it.
//
// The form is generated from PATIENT_FIELDS (src/services/patientSchema.ts);
// there is no free-text input on purpose — the form is sent to the AI bot.
const store = usePatientBuilderStore();

const categories = (Object.keys(CATEGORY_LABELS) as FieldCategory[]).map((category) => ({
  category,
  label: CATEGORY_LABELS[category],
  fields: PATIENT_FIELDS.filter((f) => f.category === category),
}));

const confirmedAnonymous = ref(false);
// an untouched form is not "wrong": issues only show once something is entered
const issueFor = (key: string) =>
  store.isEmpty ? null : (store.validated.issues.find((i) => i.key === key)?.message ?? null);
const canSubmit = computed(
  () => confirmedAnonymous.value && !store.isEmpty && store.validated.issues.length === 0 && store.phase !== "building",
);

// what the builder will do with a filled-in value (shown beside the input)
function useOf(field: PatientField): { text: string; muted: boolean } | null {
  if (field.kind !== "number" || store.validated.values[field.key] == null) return null;
  const p = store.preview;
  if (field.specTarget && p.targets[field.specTarget] != null && !p.checks[field.key]) {
    return { text: field.role === "structural" ? "used" : "target", muted: false };
  }
  if (p.checks[field.key]) return { text: p.unsupported.includes(field.key) ? "not used yet" : "compared only", muted: true };
  return { text: "context", muted: true };
}

// ---- elapsed time while building ----
const now = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | null = null;
watch(
  () => store.phase,
  (phase) => {
    if (ticker) clearInterval(ticker);
    ticker = null;
    if (phase === "building") {
      now.value = Date.now();
      ticker = setInterval(() => (now.value = Date.now()), 1000);
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  if (ticker) clearInterval(ticker);
});
const elapsed = computed(() => {
  const s = Math.max(0, Math.round((now.value - (store.startedAt ?? now.value)) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
});

// ---- result display ----
// values are shown in the unit the user chose for that field
function shown(key: string, specValue: number | null): string {
  if (specValue == null) return "—";
  const field = numberField(key);
  if (!field) return String(specValue);
  const unit = store.form.numbers[key]?.unit ?? field.units[0].label;
  return String(fromSpecValue(field, specValue, unit));
}
function unitOf(key: string, fallback: string): string {
  const field = numberField(key);
  return field ? (store.form.numbers[key]?.unit ?? field.units[0].label) : fallback;
}
// Model output is shown with one more decimal than the unit's input precision
// (a measured 158 /min next to a modelled 154.3), and the difference is taken
// before rounding so the two columns cannot disagree with it.
function converted(key: string, specValue: number): { value: number; digits: number } {
  const field = numberField(key);
  const unit = field?.units.find((u) => u.label === (store.form.numbers[key]?.unit ?? field.units[0].label));
  return unit ? { value: unit.fromSpec(specValue), digits: unit.digits + 1 } : { value: specValue, digits: 2 };
}
function shownModel(row: ResultRow): string {
  const { value, digits } = converted(row.key, row.model);
  return String(Number(value.toFixed(digits)));
}
function shownDelta(row: ResultRow): string {
  if (row.measured == null) return "—";
  const model = converted(row.key, row.model);
  const d = Number((model.value - converted(row.key, row.measured).value).toFixed(model.digits));
  return `${d > 0 ? "+" : ""}${d}`;
}

const STATUS_LABEL: Record<ValueRow["status"], string> = {
  measured: "Measured",
  derived: "Derived",
  reference: "Reference",
  assumed: "Assumed",
  emergent: "Left to the model",
};
const STATUS_SEVERITY: Record<ValueRow["status"], string> = {
  measured: "success",
  derived: "info",
  reference: "info",
  assumed: "warn",
  emergent: "secondary",
};
const USE_LABEL: Record<ValueRow["use"], string> = {
  target: "used to build",
  check: "compared only",
  context: "context",
  none: "",
};

const verdict = computed(() => {
  const report = store.result?.report;
  if (!report) return null;
  if (report.converged) return { ok: true, text: `All measured targets were reached (${report.iters ?? "?"} calibration rounds).` };
  const missed = store.result!.resultRows.filter((r) => r.met === false).map((r) => r.caption);
  return {
    ok: false,
    text: missed.length
      ? `Not every target was reached: ${missed.join(", ")}.`
      : "The calibration did not converge.",
  };
});
// The builder's lever names are model internals; say what each lever is in
// clinical terms, keyed by the target it calibrates.
const LEVER_WORDS: Record<string, string> = {
  spo2: "lung oxygen uptake and intrapulmonary shunt",
  po2: "lung oxygen uptake and intrapulmonary shunt",
  pco2: "breathing drive",
  map: "systemic vascular resistance",
  pp: "large-artery stiffness",
  rr: "split between breath size and rate",
  pap_m: "pulmonary vascular resistance",
  pap_s: "pulmonary vascular resistance",
  cvp: "venous filling",
  co: "heart contractility",
  ef: "left heart contractility",
  hr: "heart-rate setting",
  be: "unmeasured acid load",
  ph: "unmeasured acid load",
};
// Targets whose calibration lever ended on its bound. A missed one is out of that
// lever's reach; a reached one needed the extreme of it, so treat it with caution.
const leverLimits = computed(() => {
  const r = store.result;
  if (!r?.report) return [];
  const missed = new Set(r.report.unmet);
  return r.report.leverLimits.map((l) => {
    const lever = LEVER_WORDS[l.key] ?? l.lever;
    return {
      key: l.key,
      text: missed.has(l.key)
        ? `${targetCaption(l.key)}: not reached — the model's ${lever} is at its limit, so this patient is beyond what the model can represent that way.`
        : `${targetCaption(l.key)}: reached only with the model's ${lever} at its limit. Treat this part of the fit with caution.`,
    };
  });
});
const shuntNotes = computed(() => {
  const r = store.result;
  if (!r?.report) return [];
  return [ductalFlowNote(r.request, r.report), atrialFlowNote(r.request, r.report)].filter((n): n is string => n != null);
});
const outOfRange = computed(() => (store.result?.resultRows ?? []).filter((r) => r.flag && r.flag !== "ok"));
const showLog = ref(false);

// ---- save ----
const saveName = ref("");
const askOverwrite = ref(false);
const saving = ref(false);
async function save(overwrite = false) {
  const name = saveName.value.trim();
  if (!name) return;
  saving.value = true;
  const outcome = await store.save(name, overwrite);
  saving.value = false;
  askOverwrite.value = outcome === "exists";
}
watch(saveName, () => (askOverwrite.value = false));
</script>

<template>
  <Panel data-tour="builder.panel">
    <template #header>
      <span class="font-semibold">Patient builder</span>
    </template>

    <div class="flex flex-col gap-4">
      <p class="text-xs opacity-60 -mt-1">
        Enter what was measured on a newborn. Leave unknown values empty: the AI bot looks up size and
        haemoglobin, and unmeasured vital signs are left to the model. The result is a new patient you can
        load and test.
      </p>

      <!-- ---------------- form ---------------- -->
      <div v-for="cat in categories" :key="cat.category" class="rounded border border-surface-700 p-2">
        <div class="mb-2 text-sm font-semibold">{{ cat.label }}</div>
        <div class="grid grid-cols-1 gap-x-4 gap-y-2 xl:grid-cols-2">
          <div v-for="field in cat.fields" :key="field.key" class="min-w-0">
            <label :for="`pb-${field.key}`" class="mb-0.5 flex items-baseline gap-2 text-xs">
              <span class="truncate opacity-80">{{ field.caption }}</span>
              <span
                v-if="useOf(field)"
                class="ml-auto shrink-0 text-[10px] uppercase tracking-wide"
                :class="useOf(field)!.muted ? 'opacity-50' : 'text-primary-400'"
              >
                {{ useOf(field)!.text }}
              </span>
            </label>

            <Select
              v-if="field.kind === 'choice'"
              v-model="store.form.choices[field.key]"
              :input-id="`pb-${field.key}`"
              :options="field.options"
              option-label="label"
              option-value="value"
              show-clear
              placeholder="Not specified"
              size="small"
              class="w-full"
              :disabled="store.phase === 'building'"
            />
            <div v-else class="flex items-center gap-1">
              <InputNumber
                v-model="store.form.numbers[field.key]!.value"
                :input-id="`pb-${field.key}`"
                :step="field.units.find((u) => u.label === store.form.numbers[field.key]!.unit)?.step ?? 1"
                :max-fraction-digits="3"
                :invalid="!!issueFor(field.key)"
                size="small"
                fluid
                class="min-w-0 flex-1"
                placeholder="—"
                :disabled="store.phase === 'building'"
              />
              <Select
                v-if="field.units.length > 1"
                v-model="store.form.numbers[field.key]!.unit"
                :options="field.units.map((u) => u.label)"
                size="small"
                class="w-28 shrink-0"
                :aria-label="`${field.caption} unit`"
                :disabled="store.phase === 'building'"
              />
              <span v-else class="w-28 shrink-0 pl-1 text-xs opacity-60">{{ field.units[0].label }}</span>
            </div>
            <div v-if="issueFor(field.key)" class="mt-0.5 text-xs text-red-400">{{ issueFor(field.key) }}</div>
            <div v-else-if="field.hint" class="mt-0.5 text-[11px] opacity-40">{{ field.hint }}</div>
          </div>
        </div>
      </div>

      <ul v-if="!store.isEmpty && store.preview.warnings.length" class="flex flex-col gap-1 text-xs text-amber-300">
        <li v-for="w in store.preview.warnings" :key="w" class="flex gap-2">
          <i class="pi pi-exclamation-triangle mt-0.5 shrink-0"></i><span>{{ w }}</span>
        </li>
      </ul>

      <div class="flex flex-col gap-2">
        <label class="flex items-start gap-2 text-xs">
          <Checkbox v-model="confirmedAnonymous" binary input-id="pb-anonymous" class="mt-0.5" />
          <span>
            These values are sent to the AI bot. The form holds numbers and fixed choices only — no name,
            birth date or record number. I confirm it cannot be traced to a person.
          </span>
        </label>
        <div class="flex items-center gap-2">
          <Button
            :label="store.phase === 'building' ? `Building… ${elapsed}` : 'Build patient'"
            :icon="store.phase === 'building' ? 'pi pi-spin pi-spinner' : 'pi pi-user-plus'"
            size="small"
            :disabled="!canSubmit"
            @click="store.submit()"
          />
          <Button v-if="store.phase === 'building'" label="Cancel" size="small" severity="secondary" @click="store.cancel()" />
          <Button
            v-else
            label="Clear form"
            size="small"
            severity="secondary"
            text
            :disabled="store.isEmpty"
            @click="store.resetForm()"
          />
        </div>
        <p v-if="store.phase === 'building'" class="text-xs opacity-60">
          The bot looks up the missing values, then the patient is calibrated. This usually takes one to three
          minutes.
        </p>
        <p v-if="store.phase === 'error'" class="text-sm text-red-400">{{ store.error }}</p>
      </div>

      <!-- ---------------- result ---------------- -->
      <div v-if="store.phase === 'done' && store.result" class="flex flex-col gap-4 border-t border-surface-700 pt-4">
        <div v-if="verdict" class="flex items-start gap-2 text-sm" :class="verdict.ok ? 'text-emerald-400' : 'text-amber-300'">
          <i :class="verdict.ok ? 'pi pi-check-circle' : 'pi pi-exclamation-triangle'" class="mt-0.5"></i>
          <span>{{ verdict.text }}</span>
        </div>
        <p v-else class="text-sm text-amber-300">
          The bot host did not send a calibration report, so this patient cannot be checked against the form
          here. Load it and compare the monitor values yourself.
        </p>
        <p v-for="(note, i) in shuntNotes" :key="i" class="flex gap-2 text-xs text-amber-300">
          <i class="pi pi-exclamation-triangle mt-0.5 shrink-0"></i><span>{{ note }}</span>
        </p>
        <ul v-if="leverLimits.length" class="flex flex-col gap-1 text-xs text-amber-300">
          <li v-for="l in leverLimits" :key="l.key" class="flex gap-2">
            <i class="pi pi-exclamation-triangle mt-0.5 shrink-0"></i><span>{{ l.text }}</span>
          </li>
        </ul>
        <ul
          v-if="store.result.report?.ignoredTargets.length || store.result.report?.notes.length"
          class="flex flex-col gap-1 text-xs opacity-70"
        >
          <li v-if="store.result.report.ignoredTargets.length">
            Not used by the builder: {{ store.result.report.ignoredTargets.join(", ") }}
          </li>
          <li v-for="n in store.result.report.notes" :key="n">{{ n }}</li>
        </ul>
        <p v-if="store.result.prose" class="text-xs opacity-70 whitespace-pre-line">{{ store.result.prose }}</p>

        <div v-if="store.result.specProblems.length" class="rounded border border-red-500/60 p-2 text-sm text-red-300">
          <div class="mb-1 font-semibold">The patient was not built from exactly what you entered</div>
          <ul class="list-disc pl-5 text-xs">
            <li v-for="p in store.result.specProblems" :key="p.key + p.message">{{ p.message }}</li>
          </ul>
        </div>

        <div v-if="store.result.resultRows.length">
          <div class="mb-1 text-sm font-semibold">Built patient at steady state</div>
          <table class="w-full text-xs">
            <thead class="text-left opacity-60">
              <tr>
                <th class="py-1 pr-2 font-normal"></th>
                <th class="py-1 pr-2 text-right font-normal">Model</th>
                <th class="py-1 pr-2 text-right font-normal">Measured</th>
                <th class="py-1 pr-2 text-right font-normal">Difference</th>
                <th class="py-1 font-normal"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in store.result.resultRows" :key="row.key" class="border-t border-surface-800">
                <td class="py-1 pr-2">
                  {{ row.caption }} <span class="opacity-50">{{ unitOf(row.key, row.unit) }}</span>
                </td>
                <td class="py-1 pr-2 text-right tabular-nums">{{ shownModel(row) }}</td>
                <td class="py-1 pr-2 text-right tabular-nums">{{ shown(row.key, row.measured) }}</td>
                <td
                  class="py-1 pr-2 text-right tabular-nums"
                  :class="row.met === false ? 'text-amber-300' : ''"
                >
                  {{ shownDelta(row) }}
                </td>
                <td class="py-1 opacity-60">
                  <template v-if="row.set">set in the model</template>
                  <template v-else-if="row.measured == null">not measured</template>
                  <template v-else-if="row.calibrated">{{ row.met === false ? "target missed" : "target" }}</template>
                  <template v-else>compared only</template>
                  <span v-if="row.flag && row.flag !== 'ok'" class="ml-1 text-amber-300">· {{ row.flag.toLowerCase() }} for age</span>
                </td>
              </tr>
            </tbody>
          </table>
          <p v-if="outOfRange.length" class="mt-1 text-[11px] opacity-50">
            "Low/high for age" compares the model with the engine's own wide normal range for this gestation.
          </p>
        </div>

        <div>
          <div class="mb-1 text-sm font-semibold">What the patient was built from</div>
          <table class="w-full text-xs">
            <tbody>
              <tr v-for="row in store.result.valueRows" :key="row.key" class="border-t border-surface-800 align-top">
                <td class="py-1 pr-2">{{ row.caption }}</td>
                <td class="py-1 pr-2 text-right tabular-nums whitespace-nowrap">
                  {{ shown(row.key, row.value) }}
                  <span v-if="row.value != null" class="opacity-50">{{ unitOf(row.key, row.unit) }}</span>
                </td>
                <td class="py-1 pr-2 whitespace-nowrap">
                  <Tag :value="STATUS_LABEL[row.status]" :severity="STATUS_SEVERITY[row.status]" class="!text-[10px]" />
                </td>
                <td class="py-1 opacity-70">
                  <span v-if="USE_LABEL[row.use]" class="opacity-70">{{ USE_LABEL[row.use] }}</span>
                  <span v-if="USE_LABEL[row.use] && row.note"> · </span>{{ row.note }}
                  <template v-if="row.source">
                    <span class="opacity-60"> — </span>
                    <a
                      v-if="row.source.url"
                      :href="row.source.url"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="underline"
                    >{{ row.source.title }}</a>
                    <span v-else>{{ row.source.title }}</span>
                  </template>
                </td>
              </tr>
            </tbody>
          </table>
          <p v-if="!store.result.provenance" class="mt-1 text-xs text-amber-300">
            The bot did not say where the values it filled in came from.
          </p>
          <ul v-if="store.result.provenance?.warnings.length" class="mt-2 flex flex-col gap-1 text-xs text-amber-300">
            <li v-for="w in store.result.provenance.warnings" :key="w">{{ w }}</li>
          </ul>
          <ul v-if="store.result.provenanceErrors.length" class="mt-2 list-disc pl-5 text-[11px] opacity-50">
            <li v-for="e in store.result.provenanceErrors" :key="e">Ignored from the bot's answer: {{ e }}</li>
          </ul>
        </div>

        <div v-if="store.result.report?.log">
          <button type="button" class="text-xs underline opacity-60" @click="showLog = !showLog">
            {{ showLog ? "Hide" : "Show" }} calibration log
          </button>
          <pre v-if="showLog" class="mt-1 max-h-64 overflow-auto rounded bg-surface-900 p-2 text-[11px] leading-snug">{{ store.result.report.log }}</pre>
        </div>

        <div class="flex flex-col gap-2">
          <div class="flex flex-wrap items-center gap-2">
            <Button
              :label="store.applied ? 'Loaded' : 'Load this patient'"
              :icon="store.applied ? 'pi pi-check' : 'pi pi-play'"
              size="small"
              :disabled="store.applied"
              @click="store.apply()"
            />
            <span class="text-xs opacity-60">Replaces the patient that is running now.</span>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <InputText
              v-model="saveName"
              size="small"
              class="w-56"
              placeholder="Name to save under"
              aria-label="Name to save under"
              maxlength="60"
            />
            <Button
              :label="store.canSaveToCloud ? 'Save' : 'Download'"
              icon="pi pi-save"
              size="small"
              severity="secondary"
              :disabled="!saveName.trim() || saving"
              @click="save(false)"
            />
            <Button v-if="askOverwrite" label="Overwrite" size="small" severity="warn" @click="save(true)" />
          </div>
          <p v-if="askOverwrite" class="text-xs text-amber-300">A saved state with this name already exists.</p>
          <p v-else-if="store.saveMessage" class="text-xs opacity-70">{{ store.saveMessage }}</p>
          <p class="text-[11px] opacity-40">
            The name is stored with the saved patient only; it is not sent to the AI bot. Do not use the
            patient's name.
          </p>
        </div>
      </div>
    </div>
  </Panel>
</template>
