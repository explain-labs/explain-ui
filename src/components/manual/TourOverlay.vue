<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Button from "primevue/button";
import { computePosition, flip, shift, offset, type VirtualElement } from "@floating-ui/dom";
import { useTour } from "@/composables/useTour";

// Interactive-manual overlay: dims the page around the spotlit element, frames
// it in the lessons' amber ring, and floats the step card beside it. The hole
// in the dimming is made of four blockers around the target, so the target
// itself stays clickable (gated steps need that) while the rest of the page is
// inert. The blockers sit below PrimeVue overlays (z 1000+), so a Select or
// Popover opened from the spotlit element still shows on top; the ring and card
// sit above PrimeVue's modal mask (z 1100), so a step can point into a Dialog.

const rt = useTour();
const PAD = 6; // px around the target
const card = ref<HTMLElement | null>(null);
const rect = ref<{ x: number; y: number; w: number; h: number } | null>(null);
const cardPos = ref<{ left: string; top: string; transform?: string }>({
  left: "50%",
  top: "50%",
  transform: "translate(-50%, -50%)",
});

// Track the target every frame while a tour runs: tabs animate, panels grow,
// the page scrolls — a rAF read is simpler and sturdier than a pile of observers.
let raf = 0;
function track() {
  raf = requestAnimationFrame(track);
  const el = rt.target.value;
  if (!el || !el.isConnected) {
    if (rect.value) rect.value = null;
    centreCard();
    return;
  }
  const r = el.getBoundingClientRect();
  // hidden (display:none, collapsed) targets have no box: fall back to a centred card
  if (r.width === 0 && r.height === 0) {
    if (rect.value) rect.value = null;
    centreCard();
    return;
  }
  const next = { x: r.left - PAD, y: r.top - PAD, w: r.width + 2 * PAD, h: r.height + 2 * PAD };
  const cur = rect.value;
  if (!cur || cur.x !== next.x || cur.y !== next.y || cur.w !== next.w || cur.h !== next.h) {
    rect.value = next;
    placeCard();
  }
}

function centreCard() {
  if (cardPos.value.transform) return;
  cardPos.value = { left: "50%", top: "50%", transform: "translate(-50%, -50%)" };
}

async function placeCard() {
  const r = rect.value;
  if (!r || !card.value) return centreCard();
  const reference: VirtualElement = {
    getBoundingClientRect: () =>
      ({ x: r.x, y: r.y, left: r.x, top: r.y, width: r.w, height: r.h, right: r.x + r.w, bottom: r.y + r.h }) as DOMRect,
  };
  const { x, y } = await computePosition(reference, card.value, {
    strategy: "fixed",
    placement: rt.step.value?.placement ?? "bottom",
    middleware: [offset(12), flip({ padding: 8 }), shift({ padding: 8 })],
  });
  cardPos.value = { left: `${x}px`, top: `${y}px` };
}

// re-place when the step (and so the card's size) changes
watch([() => rt.html.value, () => rt.step.value], () => requestAnimationFrame(placeCard));

watch(
  rt.active,
  (on) => {
    cancelAnimationFrame(raf);
    rect.value = null;
    if (on) raf = requestAnimationFrame(track);
  },
  { immediate: true },
);
onBeforeUnmount(() => cancelAnimationFrame(raf));

// four blockers around the hole (or one full-screen blocker without a target)
const blockers = computed(() => {
  const r = rect.value;
  if (!r) return [{ left: "0", top: "0", width: "100vw", height: "100vh" }];
  const px = (n: number) => `${Math.max(0, n)}px`;
  return [
    { left: "0", top: "0", width: "100vw", height: px(r.y) }, // above
    { left: "0", top: px(r.y + r.h), width: "100vw", height: `calc(100vh - ${px(r.y + r.h)})` }, // below
    { left: "0", top: px(r.y), width: px(r.x), height: px(r.h) }, // left
    { left: px(r.x + r.w), top: px(r.y), width: `calc(100vw - ${px(r.x + r.w)})`, height: px(r.h) }, // right
  ];
});

const total = computed(() => rt.tour.value?.steps.length ?? 0);
const isLast = computed(() => rt.stepIndex.value >= total.value - 1);

// ← / → step, Esc closes. Ignored while typing so form fields keep their keys.
function onKeydown(e: KeyboardEvent) {
  if (!rt.active.value) return;
  const t = e.target as HTMLElement | null;
  if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
  if (e.key === "Escape") rt.stop();
  else if (e.key === "ArrowRight" && !rt.gated.value) rt.next();
  else if (e.key === "ArrowLeft") rt.prev();
  else return;
  e.preventDefault();
}
onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <Teleport to="body">
    <template v-if="rt.active.value">
      <div
        v-for="(b, i) in blockers"
        :key="i"
        class="tour-blocker"
        :style="b"
        @click.stop
      ></div>
      <div
        v-if="rect"
        class="tour-ring"
        :style="{ left: rect.x + 'px', top: rect.y + 'px', width: rect.w + 'px', height: rect.h + 'px' }"
      ></div>

      <div
        ref="card"
        class="tour-card flex flex-col gap-2 rounded-lg border border-surface-600 bg-surface-900 p-4 shadow-2xl"
        :style="cardPos"
        role="dialog"
        aria-modal="false"
        :aria-label="rt.step.value?.title"
      >
        <div class="flex items-start gap-2">
          <div class="min-w-0 flex-1">
            <div class="text-xs uppercase tracking-wide opacity-50">{{ rt.tour.value?.title }}</div>
            <div class="text-base font-semibold text-surface-0">{{ rt.step.value?.title }}</div>
          </div>
          <Button
            icon="pi pi-times"
            severity="secondary"
            size="small"
            text
            rounded
            aria-label="Close manual"
            v-tooltip.left="'Close (Esc)'"
            @click="rt.stop()"
          />
        </div>

        <div class="md-body max-h-[50vh] overflow-y-auto text-sm leading-relaxed" v-html="rt.html.value"></div>

        <div
          v-if="rt.gated.value"
          class="flex items-center gap-2 rounded border border-amber-400/40 bg-amber-400/10 px-2 py-1 text-xs text-amber-200"
        >
          <i class="pi pi-hand-pointer"></i>
          <span>Try it yourself: the tour continues when you do.</span>
        </div>

        <div class="mt-1 flex items-center gap-2">
          <span class="text-xs opacity-50">{{ rt.stepIndex.value + 1 }} / {{ total }}</span>
          <div class="ml-auto flex items-center gap-1">
            <Button
              v-if="rt.stepIndex.value > 0"
              label="Back"
              icon="pi pi-arrow-left"
              severity="secondary"
              size="small"
              text
              @click="rt.prev()"
            />
            <Button
              v-if="rt.gated.value"
              label="Skip"
              severity="secondary"
              size="small"
              text
              @click="rt.next()"
            />
            <Button
              v-else
              :label="isLast ? 'Done' : 'Next'"
              :icon="isLast ? 'pi pi-check' : 'pi pi-arrow-right'"
              icon-pos="right"
              size="small"
              @click="rt.next()"
            />
          </div>
        </div>
      </div>
    </template>
  </Teleport>
</template>

<style scoped>
.tour-blocker {
  position: fixed;
  z-index: 900;
  background: rgb(0 0 0 / 0.55);
}
.tour-ring {
  position: fixed;
  z-index: 1199;
  pointer-events: none;
  border: 2px solid rgb(251 191 36);
  border-radius: 0.5rem;
  animation: tour-pulse 1.6s ease-out infinite;
  transition: left 0.2s ease, top 0.2s ease, width 0.2s ease, height 0.2s ease;
}
@keyframes tour-pulse {
  0% {
    box-shadow: 0 0 0 0 rgb(251 191 36 / 0.6);
  }
  100% {
    box-shadow: 0 0 0 10px rgb(251 191 36 / 0);
  }
}
.tour-card {
  position: fixed;
  z-index: 1200;
  width: min(360px, calc(100vw - 16px));
}

/* markdown (Tailwind preflight strips list markers) — same rules as the lesson panel */
.md-body :deep(> *:first-child) {
  margin-top: 0;
}
.md-body :deep(p) {
  margin: 0.4rem 0;
}
.md-body :deep(ul),
.md-body :deep(ol) {
  margin: 0.4rem 0;
  padding-left: 1.25rem;
}
.md-body :deep(ul) {
  list-style: disc;
}
.md-body :deep(ol) {
  list-style: decimal;
}
.md-body :deep(li) {
  margin: 0.15rem 0;
}
.md-body :deep(strong) {
  font-weight: 600;
}
.md-body :deep(a) {
  text-decoration: underline;
  text-underline-offset: 2px;
}
.md-body :deep(blockquote) {
  margin: 0.4rem 0;
  padding: 0.3rem 0.6rem;
  border-left: 3px solid rgb(251 191 36 / 0.6);
  background: rgb(255 255 255 / 0.04);
}
</style>
