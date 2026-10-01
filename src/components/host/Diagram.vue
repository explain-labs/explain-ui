<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, computed, watch } from "vue";
import ToggleButton from "primevue/togglebutton";
import ColorPicker from "primevue/colorpicker";
import InputNumber from "primevue/inputnumber";
import InputText from "primevue/inputtext";
import Checkbox from "primevue/checkbox";
import Button from "primevue/button";
import Select from "primevue/select";
import MultiSelect from "primevue/multiselect";
import { useRealtimeBus } from "@/composables/useRealtimeBus";
import { useExplain } from "@/composables/useExplain";
import { useDiagramStore } from "@/stores/diagram";
import { PICTOS as PICTO_OPTIONS, PATH_TYPES as PATH_TYPE_OPTIONS, ECLS_DIAGRAM, pumpSpinRate } from "@/render/diagramConstants";
// type-only import is erased at build; the renderer (and PixiJS) is loaded
// lazily below so Pixi lands in its own async chunk, not the main bundle.
import type { DiagramRenderer as DiagramRendererT } from "@/render/DiagramRenderer";

// `toolbar: false` hides the edit toggle, and with it every edit affordance (the
// inspector and edit bar only render in edit mode) — used by the lesson page.
// `highlight` points at components/connectors by diagram name (pulsing amber
// outline + optional caption per name) — used by lesson steps.
export interface DiagramHighlight {
  names: string[];
  labels?: Record<string, string>;
}
const props = withDefaults(
  defineProps<{ toolbar?: boolean; height?: string; minHeight?: string; highlight?: DiagramHighlight | null }>(),
  { toolbar: true, height: "65vh", minHeight: "480px", highlight: null },
);

function applyHighlight() {
  adapter?.setHighlight(props.highlight?.names ?? [], props.highlight?.labels ?? {});
}
watch(() => props.highlight, applyHighlight, { deep: true });

const el = ref<HTMLDivElement | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const { addRenderer, removeRenderer } = useRealtimeBus();
const { model, modelState, isRunning, slowValues, modelReady, watchSlow } = useExplain();
// Publishes the live renderer so the chat/bot pipeline can drive diagram edits.
const diagramStore = useDiagramStore();
let adapter: DiagramRendererT | null = null;

const editMode = ref(false);
const connectMode = ref(false);
const gridOn = ref(false);
const gridSize = ref(20);
const globalScale = ref(1);
const to2Lo = ref(3.0);
const to2Hi = ref(8.8);
const addModel = ref<string | null>(null);
const addPicto = ref("container.png");
const selectedName = ref<string | null>(null);
const selectedKind = ref<"comp" | "conn" | null>(null);
const selColor = ref("ffffff");
const selAlpha = ref(1);
const selZ = ref(0);
const selScaleX = ref(1);
const selScaleY = ref(1);
const selRotation = ref(0);
const selTinting = ref(true);
const selPicto = ref("container.png");
const selLabel = ref("");
const selLabelSize = ref(10);
const selLabelColor = ref("ffffff");
const selLabelPosX = ref(0);
const selLabelPosY = ref(0);
const selPathType = ref("straight");
const selPathWidth = ref(5);
const selModels = ref<string[]>([]);

// sprite + path options come from the shared diagram constants (also used by the
// bot-command validator); copied to mutable arrays for the PrimeVue Select props.
const PICTOS = [...PICTO_OPTIONS];
const PATH_TYPES = [...PATH_TYPE_OPTIONS];

const modelNames = computed(() => {
  const m = (modelState.value as any)?.models;
  return m ? Object.keys(m).sort() : [];
});

// Realtime anim frames only flow while the sim runs, so size the compartments
// from each state snapshot (sent after every build and fast-forward) instead of
// leaving placeholder-sized discs until Play.
watch(modelState, (s) => {
  if (!isRunning.value) adapter?.seedFromModels((s as any)?.models);
});

// ECLS circuit: shown while ECLS is on (ecls_running; scenarios ship it off),
// clamped or not — a clamped circuit just shows no flow dots — with
// the drainage/return lines routed to the live cannulation sites and the pump
// sprite spinning with the pump speed (pumpSpinRate). State comes
// off the ~1 Hz slow stream while running, and off each state snapshot while
// paused (after a build, fast-forward or load). A rebuild resets the slow
// watchlist, so re-subscribe on every model_ready.
interface EclsView {
  shown: boolean;
  drainage: string;
  ret: string;
  spin: number; // pump sprite rev/s
}
let eclsView: EclsView | null = null;

watch(modelReady, (ready) => {
  if (ready) watchSlow([...ECLS_DIAGRAM.watch]);
}, { immediate: true });
watch(slowValues, (arr) => {
  const l = Array.isArray(arr) && arr.length ? arr[arr.length - 1] : null;
  if (!l || !("Ecls.ecls_running" in l)) return;
  setEclsView({
    shown: !!l["Ecls.ecls_running"],
    drainage: String(l["Ecls.drainage_site"] ?? ""),
    ret: String(l["Ecls.return_site"] ?? ""),
    spin: pumpSpinRate(Number(l["Ecls.pump_rpm"]), Number(l["Ecls.pump_mode"])),
  });
});
watch(modelState, (s) => {
  const e = (s as any)?.models?.Ecls;
  setEclsView(
    e
      ? {
          shown: !!e.ecls_running,
          drainage: e.drainage_site ?? "",
          ret: e.return_site ?? "",
          spin: pumpSpinRate(Number(e.pump_rpm), Number(e.pump_mode)),
        }
      : { shown: false, drainage: "", ret: "", spin: 0 },
  );
});

function setEclsView(v: EclsView) {
  eclsView = v;
  applyEclsView();
}
function applyEclsView() {
  if (!adapter || !eclsView) return;
  const d = ECLS_DIAGRAM;
  adapter.setConnectorEnds(d.drainageConnector, adapter.componentForModel(eclsView.drainage), null);
  adapter.setConnectorEnds(d.returnConnector, null, adapter.componentForModel(eclsView.ret));
  adapter.setSpin(d.pumpNode, eclsView.spin);
  adapter.setGroupVisible(d.group, eclsView.shown);
}

async function mountRenderer(diagram: any) {
  if (!diagram || !el.value) return;
  const { DiagramRenderer } = await import("@/render/DiagramRenderer");
  adapter = new DiagramRenderer(el.value, diagram);
  await adapter.init();
  adapter.setSelectCallback((name, comp, kind) => {
    selectedName.value = name;
    selectedKind.value = kind;
    if (!comp) return;
    const g = comp.layout.general;
    selAlpha.value = g.alpha ?? 1;
    selZ.value = g.z_index ?? 0;
    selTinting.value = g.tinting ?? false;
    selModels.value = Array.isArray(comp.models) ? [...comp.models] : [];
    if (kind === "conn") {
      selPathType.value = comp.layout.path?.type ?? "straight";
      selPathWidth.value = Number(comp.layout.path?.width) || 5;
    } else {
      const s = comp.layout.sprite;
      selColor.value = String(s.color || "#ffffff").replace("#", "");
      selScaleX.value = s.scale.x ?? 1;
      selScaleY.value = s.scale.y ?? 1;
      selRotation.value = s.rotation ?? 0;
      selPicto.value = comp.picto || "container.png";
      const l = comp.layout.label || {};
      selLabel.value = comp.label ?? "";
      selLabelSize.value = l.size ?? 10;
      selLabelColor.value = String(l.color || "#ffffff").replace("#", "");
      selLabelPosX.value = l.pos_x ?? 0;
      selLabelPosY.value = l.pos_y ?? 0;
    }
  });
  // structural edits (add/connect/delete/models/tinting) re-bind the live
  // animation by pushing the edited diagram to the engine — no model rebuild.
  adapter.setChangeCallback(() => pushDiagram());
  if (editMode.value) adapter.setEditMode(true);
  // reflect the diagram's own grid + scale settings in the toolbar
  gridOn.value = diagram?.settings?.grid === true;
  if (diagram?.settings?.gridSize > 0) gridSize.value = diagram.settings.gridSize;
  if (diagram?.settings?.scaling > 0) globalScale.value = diagram.settings.scaling;
  if (diagram?.settings?.to2_lo > 0) to2Lo.value = diagram.settings.to2_lo;
  if (diagram?.settings?.to2_hi > 0) to2Hi.value = diagram.settings.to2_hi;
  if (props.highlight) applyHighlight();
  adapter.seedFromModels((modelState.value as any)?.models);
  applyEclsView();
  addRenderer(adapter);
  // publish to the chat/bot pipeline so it can drive diagram edits while mounted
  diagramStore.register(adapter);
}

function teardown() {
  if (adapter) {
    diagramStore.unregister(adapter);
    removeRenderer(adapter);
    adapter.dispose();
    adapter = null;
  }
}

// Keyboard shortcuts (edit mode only): Delete/Backspace removes the selection,
// Escape clears it. Ignored while typing in a form field.
function onKeydown(e: KeyboardEvent) {
  if (!editMode.value || !adapter) return;
  const t = e.target as HTMLElement | null;
  const tag = t?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t?.isContentEditable) return;
  if ((e.key === "Delete" || e.key === "Backspace") && selectedName.value) {
    e.preventDefault();
    deleteSelected();
  } else if (e.key === "Escape") {
    adapter.clearSelection();
    selectedName.value = null;
    selectedKind.value = null;
  }
}

onMounted(() => {
  mountRenderer((model as any).loadedFileData?.diagram_definition);
  window.addEventListener("keydown", onKeydown);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  teardown();
});

function toggleEdit(on: boolean) {
  adapter?.setEditMode(on);
}
function patch(p: any) {
  if (adapter && selectedName.value) adapter.applyLayoutPatch(selectedName.value, p);
}
function deleteSelected() {
  adapter?.deleteSelected();
  selectedName.value = null;
  selectedKind.value = null;
}
async function addCompartment() {
  if (adapter && addModel.value) await adapter.addCompartment(addModel.value, addPicto.value);
}
function setLabelText() {
  if (adapter && selectedName.value) adapter.setLabel(selectedName.value, selLabel.value);
}
async function setPicto() {
  if (adapter && selectedName.value) await adapter.setPicto(selectedName.value, selPicto.value);
}
function setModels() {
  if (adapter && selectedName.value) adapter.setModels(selectedName.value, selModels.value);
}
function setTinting() {
  if (adapter && selectedName.value) adapter.setTinting(selectedName.value, selTinting.value);
}
// Push the edited diagram to the engine so the sprite animation re-binds live
// (new/changed components animate without rebuilding the running model).
function pushDiagram() {
  if (adapter) (model as any).updateDiagram?.(adapter.getDiagram());
}
function toggleConnect(on: boolean) {
  adapter?.setConnectMode(on);
}
function toggleGrid(on: boolean) {
  adapter?.setGrid(on);
}
function changeGridSize(size: number | null) {
  if (size && size > 0) adapter?.setGridSize(size);
}
// Single global scaler: drives the renderer's scaling (discs, labels, path
// widths, dots) and persists into settings.scaling (picked up on export).
function changeScaling(v: number | null) {
  if (v && v > 0) adapter?.setScaling(v);
}
// to2 (O2 content) tint window. Lower-Hb circuits (adult) need a lower upper
// bound so arterial blood swings red instead of pegging the circuit blue.
// Persists into settings.to2_lo / to2_hi (picked up on export).
function changeTo2Range() {
  if (to2Hi.value > to2Lo.value) adapter?.setTo2Range(to2Lo.value, to2Hi.value);
}
function exportJson() {
  if (!adapter) return;
  download(JSON.stringify(adapter.getDiagram(), null, 2), "diagram_definition.json");
}
async function onImport(e: Event) {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  if (!f) return;
  try {
    const parsed = JSON.parse(await f.text());
    const dd = parsed.diagram_definition || parsed; // accept diagram or scenario JSON
    // the renderer edits this object in place; store it on the loaded file so
    // saving a state keeps the imported layout
    if ((model as any).loadedFileData) (model as any).loadedFileData.diagram_definition = dd;
    teardown();
    await mountRenderer(dd);
  } catch (err) {
    console.error("diagram import failed", err);
  }
  input.value = "";
}
function download(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <div v-if="toolbar" class="flex items-center gap-2 flex-wrap">
      <ToggleButton
        v-model="editMode"
        data-tour="diagram.edit"
        on-label="Editing"
        off-label="Edit"
        size="small"
        @update:model-value="toggleEdit"
      />
      <template v-if="editMode">
        <span v-if="selectedName" class="text-sm opacity-80">
          selected: <b>{{ selectedName }}</b>
        </span>
        <Button
          v-if="selectedName"
          label="Delete"
          size="small"
          severity="danger"
          @click="deleteSelected"
        />
        <span v-if="!selectedName" class="flex items-center gap-2" data-tour="diagram.add">
          <Button label="Add" size="small" :disabled="!addModel" @click="addCompartment" />
          <Select v-model="addPicto" :options="PICTOS" class="addsel w-32" />
          <Select
            v-model="addModel"
            :options="modelNames"
            filter
            placeholder="model"
            class="addsel w-40"
          />
        </span>
      </template>
    </div>

    <div
      v-if="editMode && selectedName"
      data-tour="diagram.inspector"
      class="inspector flex items-center gap-x-2 gap-y-1 flex-wrap border border-surface-700 rounded px-2 py-1"
    >
      <!-- common to compartments and connectors -->
      <label v-tooltip.top="'Engine model(s) this component represents (drives its volume/flow animation after the next build)'">
        models
        <MultiSelect
          v-model="selModels"
          :options="modelNames"
          filter
          display="chip"
          placeholder="none"
          :max-selected-labels="3"
          class="w-56"
          @update:model-value="setModels"
        />
      </label>
      <span class="opacity-30">|</span>
      <label v-tooltip.top="'Opacity — 0 is fully transparent, 1 is fully opaque'">
        alpha
        <InputNumber
          v-model="selAlpha"
          :step="0.1"
          :min="0"
          :max="1"
          :max-fraction-digits="2"
          size="small"
          class="w-12"
          @update:model-value="patch({ general: { alpha: selAlpha } })"
        />
      </label>
      <label v-tooltip.top="'Z-index — stacking order; higher values are drawn on top'">
        z
        <InputNumber
          v-model="selZ"
          :step="1"
          size="small"
          class="w-10"
          @update:model-value="patch({ general: { z_index: selZ } })"
        />
      </label>
      <label v-tooltip.top="'Tint by oxygenation (to2). When off, the fixed sprite colour is used.'">
        <Checkbox v-model="selTinting" binary @update:model-value="setTinting" />
        O₂
      </label>

      <!-- compartment-only controls -->
      <template v-if="selectedKind === 'comp'">
        <span class="opacity-30">|</span>
        <label v-tooltip.top="'Sprite colour — the fixed tint used when oxygenation tinting is off'">
          col
          <ColorPicker
            v-model="selColor"
            @update:model-value="patch({ sprite: { color: '#' + selColor } })"
          />
        </label>
        <label v-tooltip.top="'Sprite image'">
          picto
          <Select v-model="selPicto" :options="PICTOS" class="w-24" @update:model-value="setPicto" />
        </label>
        <label v-tooltip.top="'Horizontal size multiplier of the sprite (1 = native width)'">
          sx
          <InputNumber
            v-model="selScaleX"
            :step="0.1"
            :max-fraction-digits="2"
            size="small"
            class="w-12"
            @update:model-value="patch({ sprite: { scale: { x: selScaleX, y: selScaleY } } })"
          />
        </label>
        <label v-tooltip.top="'Vertical size multiplier of the sprite (1 = native height)'">
          sy
          <InputNumber
            v-model="selScaleY"
            :step="0.1"
            :max-fraction-digits="2"
            size="small"
            class="w-12"
            @update:model-value="patch({ sprite: { scale: { x: selScaleX, y: selScaleY } } })"
          />
        </label>
        <label v-tooltip.top="'Rotation of the sprite, in radians'">
          rot
          <InputNumber
            v-model="selRotation"
            :step="0.1"
            :max-fraction-digits="2"
            size="small"
            class="w-12"
            @update:model-value="patch({ sprite: { rotation: selRotation } })"
          />
        </label>
        <span class="opacity-30">|</span>
        <label v-tooltip.top="'Caption text shown on the compartment'">
          lbl
          <InputText v-model="selLabel" size="small" class="w-24" @update:model-value="setLabelText" />
        </label>
        <label v-tooltip.top="'Caption font size, in px'">
          sz
          <InputNumber
            v-model="selLabelSize"
            :step="1"
            :min="1"
            size="small"
            class="w-10"
            @update:model-value="patch({ label: { size: selLabelSize } })"
          />
        </label>
        <label v-tooltip.top="'Caption colour'">
          <ColorPicker
            v-model="selLabelColor"
            @update:model-value="patch({ label: { color: '#' + selLabelColor } })"
          />
        </label>
        <label v-tooltip.top="'Caption horizontal offset from the sprite centre, in px'">
          lx
          <InputNumber
            v-model="selLabelPosX"
            :step="1"
            size="small"
            class="w-10"
            @update:model-value="patch({ label: { pos_x: selLabelPosX } })"
          />
        </label>
        <label v-tooltip.top="'Caption vertical offset from the sprite centre, in px'">
          ly
          <InputNumber
            v-model="selLabelPosY"
            :step="1"
            size="small"
            class="w-10"
            @update:model-value="patch({ label: { pos_y: selLabelPosY } })"
          />
        </label>
      </template>

      <!-- connector-only controls -->
      <template v-if="selectedKind === 'conn'">
        <span class="opacity-30">|</span>
        <label v-tooltip.top="'Path shape between the two endpoints'">
          path
          <Select
            v-model="selPathType"
            :options="PATH_TYPES"
            class="w-24"
            @update:model-value="patch({ path: { type: selPathType } })"
          />
        </label>
        <label v-tooltip.top="'Stroke width of the path, in px'">
          width
          <InputNumber
            v-model="selPathWidth"
            :step="1"
            :min="1"
            size="small"
            class="w-12"
            @update:model-value="patch({ path: { width: selPathWidth } })"
          />
        </label>
      </template>
    </div>

    <div
      ref="el"
      data-tour="diagram.stage"
      class="diagram"
      :style="{ width: '100%', height: props.height, minHeight: props.minHeight, position: 'relative' }"
    ></div>

    <div v-if="editMode" class="flex items-center gap-2 flex-wrap">
      <span class="flex items-center gap-2" data-tour="diagram.file">
        <Button label="Export JSON" size="small" severity="secondary" @click="exportJson" />
        <Button label="Import JSON" size="small" severity="secondary" @click="fileInput?.click()" />
        <input
          ref="fileInput"
          type="file"
          accept="application/json"
          class="hidden"
          @change="onImport"
        />
      </span>
      <span class="mx-1 opacity-40">|</span>
      <ToggleButton
        v-model="connectMode"
        data-tour="diagram.connect"
        on-label="Connecting"
        off-label="Connect"
        size="small"
        @update:model-value="toggleConnect"
      />
      <span class="mx-1 opacity-40">|</span>
      <span class="flex items-center gap-2 flex-wrap" data-tour="diagram.view">
      <ToggleButton
        v-model="gridOn"
        on-label="Grid on"
        off-label="Grid"
        size="small"
        @update:model-value="toggleGrid"
      />
      <InputNumber
        v-if="gridOn"
        v-model="gridSize"
        :step="5"
        :min="2"
        suffix=" px"
        size="small"
        class="gridsize w-16"
        @update:model-value="changeGridSize"
      />
      <span class="mx-1 opacity-40">|</span>
      <label
        v-tooltip.top="'Global diagram scale — resizes all sprites, labels, path widths and flow dots together (saved as settings.scaling)'"
        class="flex items-center gap-1 text-sm opacity-85"
      >
        scale
        <InputNumber
          v-model="globalScale"
          :step="0.05"
          :min="0.1"
          :max-fraction-digits="2"
          size="small"
          class="gridsize w-16"
          @update:model-value="changeScaling"
        />
      </label>
      <span class="mx-1 opacity-40">|</span>
      <label
        v-tooltip.top="'O₂ tint window (to2 content units): the venous→arterial gradient maps across [lo, hi]. Lower the upper bound for low-Hb circuits (e.g. adult) so arterial blood reads red. Saved as settings.to2_lo / to2_hi.'"
        class="flex items-center gap-1 text-sm opacity-85"
      >
        O₂ lo
        <InputNumber
          v-model="to2Lo"
          :step="0.1"
          :min="0"
          :max-fraction-digits="2"
          size="small"
          class="gridsize w-16"
          @update:model-value="changeTo2Range"
        />
      </label>
      <label
        v-tooltip.top="'Upper bound of the O₂ tint window (to2 at which blood reads fully oxygenated / red)'"
        class="flex items-center gap-1 text-sm opacity-85"
      >
        hi
        <InputNumber
          v-model="to2Hi"
          :step="0.1"
          :min="0"
          :max-fraction-digits="2"
          size="small"
          class="gridsize w-16"
          @update:model-value="changeTo2Range"
        />
      </label>
      </span>
    </div>
  </div>
</template>

<style scoped>
/* Compact inspector: force PrimeVue controls to fill their (narrow) wrappers
   instead of their default intrinsic width, and shrink padding/font. */
.inspector {
  font-size: 11px;
}
.inspector label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
  opacity: 0.85;
}
/* Let the Tailwind w-* class on each control's root govern its width; only the
   INNER input fills that width. (Setting width on the root here would override
   the utility class via specificity and blow the fields back out to full size.) */
.inspector :deep(.p-inputtext),
.inspector :deep(.p-inputnumber-input),
.inspector :deep(.p-select-label),
.inspector :deep(.p-multiselect-label) {
  width: 100%;
  min-width: 0;
  font-size: 11px;
  padding: 2px 6px;
  min-height: 0;
}
.inspector :deep(.p-select-dropdown) {
  width: 1.5rem;
}
.inspector :deep(.p-colorpicker-preview) {
  width: 20px;
  height: 20px;
}
.inspector :deep(.p-checkbox) {
  width: 18px;
  height: 18px;
}
/* grid-size field (outside the inspector): make the inner input fill the
   narrow wrapper instead of its default intrinsic width. */
.gridsize :deep(.p-inputtext) {
  width: 100%;
}
/* add-component type/model selectors: smaller font in the visible box. */
.addsel :deep(.p-select-label) {
  font-size: 11px;
  padding: 3px 8px;
}
</style>
