import { ref, watch } from "vue";

// Minimal bilingual support for lessons. The rest of the app is English-only;
// lessons carry their own NL/EN strings, so a full i18n library isn't needed.
export type Lang = "nl" | "en";
export const LANGS: Lang[] = ["nl", "en"];

// A localized string: either one string for both languages, or one per language.
export type L10n = string | Partial<Record<Lang, string>>;

// resolve an L10n for `lang`, falling back to the other language
export function t(s: L10n | undefined, lang: Lang): string {
  if (s == null) return "";
  if (typeof s === "string") return s;
  return s[lang] ?? s[lang === "nl" ? "en" : "nl"] ?? "";
}

const STORAGE_KEY = "explain.lesson.lang";
export const DEFAULT_LANG: Lang = "nl";

function initialLang(): Lang {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "nl" || stored === "en") return stored;
  } catch {
    /* storage unavailable (private mode) — fall through */
  }
  return DEFAULT_LANG; // nicupicu.nl is Dutch; EN is one click away
}

// shared across the lesson page and its children; persisted per browser
const lang = ref<Lang>(initialLang());
watch(lang, (v) => {
  try {
    localStorage.setItem(STORAGE_KEY, v);
  } catch {
    /* ignore */
  }
});

export function useLessonLang() {
  return lang;
}

// A page may prefer a language (paper companions open in English) without
// overriding a choice the reader already made in this browser.
export function preferLang(l: Lang) {
  try {
    if (localStorage.getItem(STORAGE_KEY)) return;
  } catch {
    /* ignore */
  }
  lang.value = l;
}

// UI chrome strings for the lesson page
export const UI = {
  previous: { nl: "Vorige", en: "Previous" },
  next: { nl: "Volgende", en: "Next" },
  step: { nl: "Stap", en: "Step" },
  restart: { nl: "Opnieuw beginnen", en: "Restart" },
  play: { nl: "Start (spatie)", en: "Start (Space)" },
  pause: { nl: "Pauze (spatie)", en: "Pause (Space)" },
  simulator: { nl: "Volledige simulator", en: "Full simulator" },
  signOut: { nl: "Afmelden", en: "Sign out" },
  interventions: { nl: "Interventies", en: "Interventions" },
  lesson: { nl: "Les", en: "Lesson" },
  patient: { nl: "Patiënt", en: "Patient" },
  diagram: { nl: "Diagram", en: "Diagram" },
  ventilator: { nl: "Beademing", en: "Ventilator" },
  vitals: { nl: "Monitor", en: "Monitor" },
  paper: { nl: "Artikel", en: "Paper" },
  paperCompanion: { nl: "Begeleidende pagina bij het artikel", en: "Paper companion" },
  run: { nl: "Experiment uitvoeren", en: "Run experiment" },
  rerun: { nl: "Opnieuw uitvoeren", en: "Run again" },
  loadingScenario: { nl: "Patiënt laden…", en: "Loading patient…" },
  settling: { nl: "Instellen…", en: "Settling…" },
  sampling: { nl: "Meten…", en: "Measuring…" },
  notRun: { nl: "Nog niet uitgevoerd", en: "Not run yet" },
  measure: { nl: "Grootheid", en: "Measure" },
  literature: { nl: "Literatuur", en: "Literature" },
  thisRun: { nl: "Deze run", en: "This run" },
  references: { nl: "Referenties", en: "References" },
  within: { nl: "binnen de tolerantie", en: "within tolerance" },
  outside: { nl: "buiten de tolerantie", en: "outside tolerance" },
  loading: { nl: "Model laden…", en: "Loading model…" },
  pending: { nl: "bezig…", en: "in progress…" },
  closing: { nl: "sluit…", en: "closing…" },
  opening: { nl: "opent…", en: "opening…" },
  paused: {
    nl: "De simulatie staat op pauze. Interventies starten de simulatie automatisch.",
    en: "The simulation is paused. Interventions start it automatically.",
  },
  draft: { nl: "concept", en: "draft" },
} satisfies Record<string, L10n>;
