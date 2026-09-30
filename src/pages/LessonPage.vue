<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, provide, ref } from "vue";
import Tabs from "primevue/tabs";
import TabList from "primevue/tablist";
import Tab from "primevue/tab";
import TabPanels from "primevue/tabpanels";
import TabPanel from "primevue/tabpanel";
import { useRoute, useRouter } from "vue-router";
import Button from "primevue/button";
import SelectButton from "primevue/selectbutton";
import Diagram from "@/components/host/Diagram.vue";
import Monitor from "@/components/host/Monitor.vue";
import NumericReadoutPanel from "@/components/numerics/NumericReadoutPanel.vue";
import LessonStepPanel from "@/components/lesson/LessonStepPanel.vue";
import LessonControls from "@/components/lesson/LessonControls.vue";
import DiagramLegend from "@/components/lesson/DiagramLegend.vue";
import { useAuthStore } from "@/stores/auth";
import type { MonitorGroup } from "@/stores/monitors";
import { LessonKey, useLesson } from "@/composables/useLesson";
import { getLesson } from "@/lessons/index";
import { LANGS, t, UI } from "@/lessons/i18n";

// Guided lesson page (/lesson/:id) for nicupicu.nl. Step text with the
// interventions below it on the left, the diagram full-height in the centre,
// and the bedside monitor and numerics stacked on the right. The router guard only lets known lesson ids
// through, and App.vue keys the view on the id, so the lesson is fixed for
// this component's lifetime.
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const lesson = getLesson(String(route.params.id))!;

const rt = useLesson(lesson);
provide(LessonKey, rt);
const { lang, modelReady, isRunning, error, step } = rt;

const leftTab = ref<"lesson" | "interventions">("lesson");

const langOptions =LANGS.map((l) => ({ label: l.toUpperCase(), value: l }));

// lesson numerics → MonitorGroups for the shared readout panel (labels localized)
const groups = computed<MonitorGroup[]>(() =>
  lesson.numerics.map((g) => ({
    key: g.key,
    title: t(g.title, lang.value),
    enabled: true,
    collapsed: g.collapsed ?? false,
    parameters: g.parameters.map((p) => ({ ...p, label: t(p.label, lang.value) })),
  })),
);

async function logout() {
  await auth.logout();
  router.push({ name: "login" });
}

// Spacebar toggles play/pause unless the user is typing or on a button
function onKeydown(e: KeyboardEvent) {
  if (e.code !== "Space" && e.key !== " ") return;
  if (e.repeat || !modelReady.value) return;
  const el = e.target as HTMLElement | null;
  if (el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(el.tagName)))
    return;
  e.preventDefault();
  rt.toggleRun();
}
onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <div class="flex flex-col min-h-screen lg:h-screen">
    <!-- header: title · step dots · language · run controls -->
    <header
      class="sticky top-0 z-20 flex items-center gap-3 flex-wrap border-b border-surface-700 bg-surface-900 px-4 py-2"
    >
      <img src="/logo/explain-labs-logo.svg" alt="Explain Labs" class="h-10 w-auto shrink-0" />
      <div class="min-w-0 flex flex-col leading-tight">
        <span class="font-semibold text-surface-100 truncate">{{ t(lesson.title, lang) }}</span>
        <span v-if="lesson.subtitle" class="text-xs opacity-60 truncate">{{ t(lesson.subtitle, lang) }}</span>
      </div>

      <nav class="flex items-center gap-1.5 mx-auto" :aria-label="t(UI.step, lang)">
        <button
          v-for="(s, i) in rt.steps"
          :key="s.id"
          type="button"
          class="h-2.5 rounded-full transition-all"
          :class="
            i === rt.stepIndex.value
              ? 'w-6 bg-primary'
              : 'w-2.5 bg-surface-600 hover:bg-surface-400'
          "
          v-tooltip.bottom="`${i + 1}. ${t(s.title, lang)}`"
          :aria-label="`${i + 1}. ${t(s.title, lang)}`"
          :aria-current="i === rt.stepIndex.value ? 'step' : undefined"
          @click="rt.goTo(i)"
        ></button>
      </nav>

      <div class="flex items-center gap-2">
        <SelectButton
          v-model="lang"
          :options="langOptions"
          option-label="label"
          option-value="value"
          :allow-empty="false"
          size="small"
        />
        <Button
          v-tooltip.bottom="t(isRunning ? UI.pause : UI.play, lang)"
          :icon="isRunning ? 'pi pi-pause' : 'pi pi-play'"
          :aria-label="t(isRunning ? UI.pause : UI.play, lang)"
          size="small"
          severity="secondary"
          :disabled="!modelReady"
          @click="rt.toggleRun"
        />
        <Button
          v-tooltip.bottom="t(UI.restart, lang)"
          icon="pi pi-refresh"
          :aria-label="t(UI.restart, lang)"
          size="small"
          severity="secondary"
          :disabled="!modelReady"
          @click="rt.restart"
        />
        <Button
          v-if="!auth.lesson"
          :label="t(UI.simulator, lang)"
          icon="pi pi-sliders-h"
          size="small"
          severity="secondary"
          text
          @click="router.push({ name: 'main' })"
        />
        <Button
          v-else
          icon="pi pi-sign-out"
          :aria-label="t(UI.signOut, lang)"
          v-tooltip.bottom="t(UI.signOut, lang)"
          size="small"
          severity="secondary"
          text
          @click="logout"
        />
      </div>
    </header>

    <!-- body: step text · live model · numerics + interventions -->
    <main
      class="flex-1 min-h-0 grid gap-4 p-4 grid-cols-1 lg:grid-cols-[minmax(280px,0.9fr)_minmax(0,1.7fr)_minmax(340px,1.1fr)]"
    >
      <!-- left: lesson text and interventions as two tabs -->
      <aside class="min-h-0 lg:overflow-hidden">
        <Tabs v-model:value="leftTab" class="lesson-tabs h-full flex flex-col">
          <TabList>
            <Tab value="lesson">
              <i class="pi pi-book mr-2"></i>{{ t(UI.lesson, lang) }}
            </Tab>
            <Tab value="interventions">
              <i class="pi pi-sliders-h mr-2"></i>{{ t(UI.interventions, lang) }}
              <!-- a tween is running (e.g. the duct closing): visible from the lesson tab too -->
              <i v-if="rt.anyPending.value" class="pi pi-spin pi-spinner ml-2 text-amber-400"></i>
            </Tab>
          </TabList>
          <TabPanels class="flex-1 min-h-0">
            <TabPanel value="lesson" class="h-full">
              <LessonStepPanel />
            </TabPanel>
            <TabPanel value="interventions" class="h-full overflow-y-auto">
              <div v-if="modelReady" class="flex flex-col gap-2">
                <p v-if="!isRunning" class="text-xs rounded border border-surface-700 bg-surface-800/60 p-2 opacity-80">
                  <i class="pi pi-pause mr-1"></i>{{ t(UI.paused, lang) }}
                </p>
                <LessonControls />
              </div>
              <span v-else class="opacity-60"><i class="pi pi-spin pi-spinner mr-2"></i>{{ t(UI.loading, lang) }}</span>
            </TabPanel>
          </TabPanels>
        </Tabs>
      </aside>

      <template v-if="modelReady">
        <section class="relative min-w-0 min-h-0">
          <Diagram
            :toolbar="false"
            height="calc(100vh - 7rem)"
            min-height="420px"
            :highlight="rt.diagramHighlight.value"
          />
          <DiagramLegend />
        </section>

        <section class="min-w-0 min-h-0 flex flex-col gap-3 lg:overflow-y-auto">
          <Monitor
            :lanes="lesson.monitorLanes ?? ['ecg', 'spo2_pre', 'spo2_post', 'abp']"
            height="30vh"
            min-height="220px"
            :show-window-select="false"
            :highlight="rt.monitorHighlight.value"
          />
          <NumericReadoutPanel
            v-for="g in groups"
            :key="g.key"
            :group="g"
            compact
            :highlight="step.highlight"
          />
        </section>
      </template>

      <div v-else class="lg:col-span-2 flex items-center justify-center opacity-60">
        <span v-if="error" class="text-red-400">{{ error }}</span>
        <span v-else><i class="pi pi-spin pi-spinner mr-2"></i>{{ t(UI.loading, lang) }}</span>
      </div>
    </main>
  </div>
</template>
