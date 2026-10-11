import { getCurrentInstance, onBeforeUnmount } from "vue";

// Tap vs press-and-hold for the SLE6000 screen's controls (parameter tiles 2 s, the
// monitored values 1 s, the lock 1 s). The pointer is captured on press, and the hold is
// cancelled only when the pointer really moves off the control (a bounds check on pointermove).
// Not on pointerleave: in Safari every hold was cancelled and the release counted as a tap
// (Chrome was fine). The likely cause is WebKit firing pointerleave at the capturing element when
// the content under a held pointer re-renders, which this screen does every second.
// A release off the control is neither a tap nor a hold.
export function usePress(opts: { holdMs: () => number; onHold: () => void; onTap?: () => void }) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let held = false;
  let off = false;

  function clear() {
    if (timer) clearTimeout(timer);
    timer = null;
  }
  function outside(e: PointerEvent, el: Element, slop = 4): boolean {
    const r = el.getBoundingClientRect();
    return e.clientX < r.left - slop || e.clientX > r.right + slop || e.clientY < r.top - slop || e.clientY > r.bottom + slop;
  }

  function down(e: PointerEvent) {
    try {
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    } catch {
      // no active pointer with that id (synthetic events): the hold still works without capture
    }
    held = false;
    off = false;
    clear();
    const ms = opts.holdMs();
    if (ms > 0) {
      timer = setTimeout(() => {
        timer = null;
        held = true;
        opts.onHold();
      }, ms);
    }
  }
  function move(e: PointerEvent) {
    const el = e.currentTarget as Element | null;
    if (off || !el?.getBoundingClientRect) return;
    if (outside(e, el)) {
      off = true;
      clear();
    }
  }
  function up() {
    clear();
    if (!held && !off) opts.onTap?.();
    held = false;
    off = false;
  }
  function cancel() {
    clear();
    off = true;
  }
  if (getCurrentInstance()) onBeforeUnmount(clear);

  return { down, move, up, cancel };
}
