import { defineStore } from "pinia";
import { computed, reactive, ref } from "vue";
import { useExplain } from "@/composables/useExplain";
import { useAuthStore } from "@/stores/auth";
import { useStatesStore } from "@/stores/states";
import { parseCommands } from "@/services/botCommands";
import {
  FORM_SCHEMA_VERSION,
  buildRequest,
  buildResultRows,
  buildValueRows,
  checkSpec,
  parseBuildReport,
  parseProvenance,
  type BuildReport,
  type PatientBuildRequest,
  type Provenance,
  type ResultRow,
  type SpecProblem,
  type ValueRow,
} from "@/services/patientBuilder";
import { PATIENT_FIELDS, resolveTargets, validateForm, type PatientForm } from "@/services/patientSchema";

// Patient builder: send a filled-in form to the bot, get a calibrated patient back.
//
// Deliberately NOT the chat store. A chat turn attaches the running model's state
// as context (irrelevant here, and it would push the form marker off the first
// line), posts a chat bubble, and refuses loadDefinition in Guided scope. Each
// build is its own fresh bot conversation: the request is self-contained, and no
// earlier patient's numbers can leak into the next one.
//
// Form state lives in memory only — it is never written to localStorage.

export type BuildPhase = "idle" | "building" | "done" | "error";

export interface BuildResult {
  request: PatientBuildRequest;
  prose: string; // the bot's sentences, blocks removed
  provenance: Provenance | null;
  provenanceErrors: string[];
  report: BuildReport | null; // null when the bot host did not send one
  specProblems: SpecProblem[];
  valueRows: ValueRow[];
  resultRows: ResultRow[];
  artifact: any; // the built scenario (not yet loaded)
}

// The bot researches, then the server calibrates (capped at 300 s there); both
// proxies give up at 300 s too. Abort a little earlier so the user gets our message.
const TIMEOUT_MS = 280_000;

const emptyForm = (): PatientForm => ({
  numbers: Object.fromEntries(
    PATIENT_FIELDS.filter((f) => f.kind === "number").map((f) => [f.key, { value: null, unit: f.kind === "number" ? f.units[0].label : "" }]),
  ),
  choices: {},
});

export const usePatientBuilderStore = defineStore("patientBuilder", () => {
  const form = reactive<PatientForm>(emptyForm());
  const phase = ref<BuildPhase>("idle");
  const error = ref<string | null>(null);
  const result = ref<BuildResult | null>(null);
  const startedAt = ref<number | null>(null);
  const applied = ref(false);
  const saveMessage = ref<string | null>(null);
  let controller: AbortController | null = null;

  // live validation + the rules' outcome, so the form can show issues and
  // warnings before anything is sent
  const validated = computed(() => validateForm(form));
  const preview = computed(() => resolveTargets(validated.value));
  const isEmpty = computed(() => Object.keys(validated.value.values).length === 0);

  function resetForm() {
    Object.assign(form, emptyForm());
  }

  function cancel() {
    controller?.abort();
  }

  async function submit() {
    if (phase.value === "building") return;
    const request = buildRequest(form);
    if (!request) return; // the form shows validated.issues
    error.value = null;
    result.value = null;
    applied.value = false;
    saveMessage.value = null;
    phase.value = "building";
    startedAt.value = Date.now();
    controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller?.abort();
    }, TIMEOUT_MS);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // no `context` and no `conversation_id`: see the note at the top
        body: JSON.stringify({ prompt: request.prompt }),
        signal: controller.signal,
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body || typeof body.answer !== "string") {
        throw new Error(body?.error || body?.detail || `the AI bot could not be reached (status ${res.status})`);
      }

      const prov = parseProvenance(body.answer);
      // the server appends its verdict line and a loadDefinition card to the
      // answer; this panel has its own Apply, so only the prose is kept
      const prose = parseCommands(prov.clean)
        .clean.split("\n")
        .filter((line) => !/^\s*calibration (CONVERGED|INCOMPLETE)\b/.test(line))
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      if (!body.artifact || typeof body.artifact !== "object") {
        throw new Error(prose || "the bot did not return a built patient");
      }
      const report = parseBuildReport(body.build);
      result.value = {
        request,
        prose,
        provenance: prov.provenance,
        provenanceErrors: prov.errors,
        report,
        specProblems: report ? checkSpec(report.spec, request, prov.provenance) : [],
        valueRows: buildValueRows(request, prov.provenance),
        resultRows: report ? buildResultRows(request, report) : [],
        artifact: body.artifact,
      };
      phase.value = "done";
    } catch (e) {
      const aborted = (e as Error)?.name === "AbortError";
      error.value = timedOut
        ? "The build took longer than 4½ minutes and was stopped. Try again; if it keeps happening, leave out a target."
        : aborted
          ? "Build cancelled."
          : (e as Error).message;
      phase.value = "error";
    } finally {
      clearTimeout(timer);
      controller = null;
    }
  }

  // The scenario as it will be loaded and saved: the built patient plus a record
  // of what it was built from. `configuration` is the one top-level part that
  // survives a cloud save untouched (see server/states.mjs pickFileParts).
  function stamped(name?: string): any {
    const r = result.value;
    if (!r) return null;
    const artifact = r.artifact;
    return {
      ...artifact,
      ...(name ? { name } : {}),
      configuration: {
        ...(artifact.configuration ?? {}),
        // a plain JSON copy: the result lives in reactive state, and this record
        // is stored with the scenario
        patient_builder: JSON.parse(
          JSON.stringify({
            schema: FORM_SCHEMA_VERSION,
            built_at: new Date(startedAt.value ?? Date.now()).toISOString(),
            form: r.request.payload,
            provenance: r.provenance,
            spec: r.report?.spec ?? null,
            report: r.report ? { converged: r.report.converged, iters: r.report.iters, unmet: r.report.unmet, residuals: r.report.residuals } : null,
          }),
        ),
      },
    };
  }

  function apply() {
    const file = stamped();
    if (!file) return;
    useExplain().loadFromObject(file);
    useStatesStore().setCurrent(null); // a freshly built patient is not a saved state
    applied.value = true;
  }

  const canSaveToCloud = computed(() => {
    const auth = useAuthStore();
    return auth.hasDb && !auth.lesson;
  });

  function download(name: string, file: unknown) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Saves the built patient under a name the user chooses. The name stays on
  // this side: the bot only ever saw the random request id.
  // Returns "exists" when a saved state has that name and `overwrite` is false.
  async function save(name: string, overwrite = false): Promise<"saved" | "downloaded" | "exists" | "failed"> {
    const file = stamped(name);
    if (!file) return "failed";
    saveMessage.value = null;
    if (!canSaveToCloud.value) {
      download(name, file);
      saveMessage.value = `Downloaded ${name}.json — load it with the Load JSON button.`;
      return "downloaded";
    }
    const states = useStatesStore();
    await states.fetchList();
    if (states.has(name) && !overwrite) return "exists";
    const ok = await states.saveCurrent({ name, description: file.description ?? "", file });
    if (!ok) {
      download(name, file); // don't lose the patient if the server rejected it
      saveMessage.value = `Saving failed (${states.error ?? "unknown error"}); downloaded ${name}.json instead.`;
      return "failed";
    }
    // saveCurrent marks the saved state as the loaded one; that is only true once
    // the patient has actually been applied
    if (!applied.value) states.setCurrent(null);
    saveMessage.value = `Saved as "${name}" in My saved states.`;
    return "saved";
  }

  return {
    form,
    phase,
    error,
    result,
    startedAt,
    applied,
    saveMessage,
    validated,
    preview,
    isEmpty,
    canSaveToCloud,
    resetForm,
    submit,
    cancel,
    apply,
    save,
  };
});
