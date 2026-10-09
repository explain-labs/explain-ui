import { defineStore } from "pinia";
import { ref } from "vue";

// Active tab of each MainPage column. Lives in a store (not local refs) so the
// interactive manual (useTour) can switch tabs before spotlighting something
// inside them, and can wait for the learner to switch one themselves.
export type LayoutColumn = "control" | "viz" | "monitor";

export const useLayoutStore = defineStore("layout", () => {
  const controlTab = ref("editor"); // editor | tasks | ecls | resuscitation | pregnancy | scaler | events
  const vizTab = ref("diagram"); // diagram | chart | loop | chat | builder | sle6000 | docs
  const monitorTab = ref("monitoring"); // monitoring | monitor

  const tabs = { control: controlTab, viz: vizTab, monitor: monitorTab };
  function setTab(column: LayoutColumn, value: string) {
    tabs[column].value = value;
  }
  function getTab(column: LayoutColumn): string {
    return tabs[column].value;
  }

  return { controlTab, vizTab, monitorTab, setTab, getTab };
});
