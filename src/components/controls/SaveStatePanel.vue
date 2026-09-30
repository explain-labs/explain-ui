<script setup lang="ts">
import { ref, watch } from "vue";
import Button from "primevue/button";
import Dialog from "primevue/dialog";
import InputText from "primevue/inputtext";
import ConfirmDialog from "primevue/confirmdialog";
import { useConfirm } from "primevue/useconfirm";
import { useExplain } from "@/composables/useExplain";
import { useModelStore } from "@/stores/model";
import { useStatesStore } from "@/stores/states";
import { useAuthStore } from "@/stores/auth";

// Snapshot the engine state. Two destinations share the same capture flow:
//  • "file"  — a named scenario file in public/model_definitions/ (dev /api/save-snapshot)
//              with a local-download fallback in production.
//  • "cloud" — the per-user `states` collection in MongoDB (/api/states/*), so it
//              survives across machines and can be reloaded from "My saved states".
const { model, savedState, saveState, loadFromObject } = useExplain();
const store = useModelStore();
const statesStore = useStatesStore();
const auth = useAuthStore();
const confirm = useConfirm();

const showDialog = ref(false);
const snapName = ref("");
const saveTarget = ref<"file" | "cloud">("file");
const pendingName = ref<string | null>(null); // set while a save is in flight
const pendingTarget = ref<"file" | "cloud">("file");
const fileInput = ref<HTMLInputElement | null>(null);

const showStatesDialog = ref(false);

function openSaveDialog(target: "file" | "cloud") {
  saveTarget.value = target;
  snapName.value = (model as any).loadedFileData?.name || store.current || "snapshot";
  showDialog.value = true;
}

function startSave(name: string, target: "file" | "cloud") {
  pendingName.value = name;
  pendingTarget.value = target;
  showDialog.value = false;
  saveState(); // result arrives via the state_saved event → savedState
}

function confirmSave() {
  const name = snapName.value.trim();
  if (!name) return;
  const target = saveTarget.value;
  // Overwrite guard for cloud saves that reuse an existing name.
  if (target === "cloud" && statesStore.has(name)) {
    confirm.require({
      message: `A saved state named "${name}" already exists. Overwrite it?`,
      header: "Overwrite state",
      icon: "pi pi-exclamation-triangle",
      acceptLabel: "Overwrite",
      rejectLabel: "Cancel",
      accept: () => startSave(name, target),
    });
    return;
  }
  startSave(name, target);
}

function downloadFallback(name: string, file: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(file, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

watch(savedState, async (s) => {
  const name = pendingName.value;
  if (!name || !s) return;
  const target = pendingTarget.value;
  pendingName.value = null;

  // Wrap the raw engine state as a complete, reloadable scenario file: state
  // under model_definition, plus the diagram/animation/configuration from the
  // currently-loaded file (those don't live in the engine state).
  const base = (model as any).loadedFileData || {};
  const file = {
    name,
    user: base.user,
    description: base.description,
    diagram_definition: base.diagram_definition,
    animation_definition: base.animation_definition,
    configuration: base.configuration,
    model_definition: s,
  };

  if (target === "cloud") {
    const ok = await statesStore.saveCurrent({
      name,
      description: base.description ?? "",
      file,
    });
    if (!ok) {
      console.error("cloud save failed", statesStore.error);
      // don't lose the snapshot if the server rejected it
      downloadFallback(name, file);
    }
    return;
  }

  try {
    const res = await fetch("/api/save-snapshot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, data: file }),
    });
    if (!res.ok) throw new Error(`save endpoint returned ${res.status}`);
    await store.fetchScenarios(); // refresh the dropdown so the snapshot appears
  } catch (err) {
    // no dev endpoint (e.g. production build) — don't lose the snapshot
    console.error("snapshot save failed; falling back to download", err);
    downloadFallback(name, file);
  }
});

async function onLoad(e: Event) {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  if (!f) return;
  try {
    loadFromObject(JSON.parse(await f.text()));
    statesStore.setCurrent(null); // a local file isn't a cloud state
  } catch (err) {
    console.error("state load failed", err);
  }
  input.value = "";
}

function openStatesDialog() {
  statesStore.fetchList();
  showStatesDialog.value = true;
}

async function loadFromCloud(id: string) {
  const file = await statesStore.loadState(id);
  if (!file) {
    console.error("cloud load failed", statesStore.error);
    return;
  }
  loadFromObject(file);
  showStatesDialog.value = false;
}

function deleteFromCloud(id: string, name: string) {
  confirm.require({
    message: `Delete saved state "${name}"? This cannot be undone.`,
    header: "Delete state",
    icon: "pi pi-trash",
    acceptLabel: "Delete",
    rejectLabel: "Cancel",
    acceptProps: { severity: "danger" },
    accept: () => statesStore.deleteState(id),
  });
}

// Flag the currently-loaded cloud state as this user's default (loaded on login).
function setCurrentAsDefault() {
  if (statesStore.currentId) statesStore.setDefault(statesStore.currentId);
}

// Toggle default directly from the list: clicking the star sets it (or unsets if
// it's already the default).
function toggleDefault(id: string) {
  statesStore.setDefault(auth.user?.defaultState === id ? null : id);
}

function fmtDate(v: string | null): string {
  if (!v) return "";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}
</script>

<template>
  <span class="inline-flex items-center gap-2">
    <Button
      v-if="auth.user?.modelDeveloper"
      v-tooltip.top="'Save snapshot (file)'"
      icon="pi pi-save"
      aria-label="Save snapshot"
      severity="secondary"
      size="small"
      @click="openSaveDialog('file')"
    />
    <!-- Cloud controls need MongoDB: hidden in dev local mode (no MONGODB_URI). -->
    <template v-if="auth.hasDb">
    <!-- separate the local (developer) save from the cloud controls -->
    <span
      v-if="auth.user?.modelDeveloper"
      class="mx-1 h-6 w-px bg-surface-700"
      aria-hidden="true"
    ></span>
    <Button
      v-tooltip.top="'Save to cloud'"
      icon="pi pi-cloud-upload"
      aria-label="Save to cloud"
      severity="secondary"
      size="small"
      @click="openSaveDialog('cloud')"
    />
    <Button
      v-tooltip.top="
        statesStore.currentId && statesStore.currentId === auth.user?.defaultState
          ? 'This is your default state'
          : 'Flag current state as default'
      "
      :icon="
        statesStore.currentId && statesStore.currentId === auth.user?.defaultState
          ? 'pi pi-star-fill'
          : 'pi pi-star'
      "
      aria-label="Flag current state as default"
      severity="secondary"
      size="small"
      :disabled="!statesStore.currentId"
      @click="setCurrentAsDefault"
    />
    <Button
      v-tooltip.top="'My saved states'"
      icon="pi pi-folder-open"
      aria-label="My saved states"
      severity="secondary"
      size="small"
      @click="openStatesDialog"
    />
    </template>
    <!-- Load JSON button hidden for now; the file input below stays wired up. -->
    <Button
      v-if="false"
      v-tooltip.top="'Load JSON'"
      icon="pi pi-file-import"
      aria-label="Load JSON"
      severity="secondary"
      size="small"
      @click="fileInput?.click()"
    />
    <input ref="fileInput" type="file" accept="application/json" class="hidden" @change="onLoad" />

    <Dialog
      v-model:visible="showDialog"
      modal
      :header="saveTarget === 'cloud' ? 'Save to cloud' : 'Save snapshot'"
      :style="{ width: '22rem' }"
    >
      <div class="flex flex-col gap-3">
        <label class="text-sm flex flex-col gap-1">
          name
          <InputText v-model="snapName" autofocus @keyup.enter="confirmSave" />
        </label>
        <div class="flex justify-end gap-2">
          <Button label="Cancel" severity="secondary" size="small" @click="showDialog = false" />
          <Button label="Save" size="small" :disabled="!snapName.trim()" @click="confirmSave" />
        </div>
      </div>
    </Dialog>

    <Dialog
      v-model:visible="showStatesDialog"
      modal
      header="My saved states"
      :style="{ width: '32rem' }"
    >
      <div class="flex flex-col gap-2">
        <div v-if="statesStore.loading" class="text-sm opacity-70 py-4 text-center">
          loading…
        </div>
        <div
          v-else-if="!statesStore.savedStates.length"
          class="text-sm opacity-70 py-4 text-center"
        >
          No saved states yet. Use "Save to cloud" to store the current model.
        </div>
        <div
          v-for="st in statesStore.savedStates"
          :key="st.id"
          class="flex items-center gap-3 rounded border border-surface-700 px-3 py-2"
        >
          <div class="min-w-0 flex-1">
            <div class="font-medium truncate">
              {{ st.name }}
              <span
                v-if="st.id === auth.user?.defaultState"
                class="ml-1 text-xs text-primary-400"
                >(default)</span
              >
            </div>
            <div v-if="st.description" class="text-xs opacity-70 truncate">
              {{ st.description }}
            </div>
            <div class="text-xs opacity-50">{{ fmtDate(st.updated_at) }}</div>
          </div>
          <Button
            v-tooltip.top="
              st.id === auth.user?.defaultState ? 'Default (click to unset)' : 'Set as default'
            "
            :icon="st.id === auth.user?.defaultState ? 'pi pi-star-fill' : 'pi pi-star'"
            size="small"
            severity="secondary"
            text
            @click="toggleDefault(st.id)"
          />
          <Button
            v-tooltip.top="'Load'"
            icon="pi pi-download"
            size="small"
            @click="loadFromCloud(st.id)"
          />
          <Button
            v-tooltip.top="'Delete'"
            icon="pi pi-trash"
            size="small"
            severity="danger"
            text
            @click="deleteFromCloud(st.id, st.name)"
          />
        </div>
        <p v-if="statesStore.error" class="text-sm text-red-400">{{ statesStore.error }}</p>
      </div>
    </Dialog>

    <ConfirmDialog />
  </span>
</template>
