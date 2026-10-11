import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePress } from "./press";

// a 100 x 100 control at the origin, and pointer events on it
const el = { getBoundingClientRect: () => ({ left: 0, right: 100, top: 0, bottom: 100 }) };
const ev = (x = 50, y = 50) => ({ currentTarget: el, pointerId: 1, clientX: x, clientY: y }) as unknown as PointerEvent;

describe("usePress", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(ms = 3000) {
    const onHold = vi.fn();
    const onTap = vi.fn();
    return { p: usePress({ holdMs: () => ms, onHold, onTap }), onHold, onTap };
  }

  it("holds after the hold time, and the release is not a tap", () => {
    const { p, onHold, onTap } = setup();
    p.down(ev());
    vi.advanceTimersByTime(2999);
    expect(onHold).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    p.up();
    expect(onHold).toHaveBeenCalledOnce();
    expect(onTap).not.toHaveBeenCalled();
  });

  it("taps on a short press", () => {
    const { p, onHold, onTap } = setup();
    p.down(ev());
    vi.advanceTimersByTime(500);
    p.up();
    expect(onTap).toHaveBeenCalledOnce();
    expect(onHold).not.toHaveBeenCalled();
  });

  it("keeps holding while the pointer moves inside the control", () => {
    const { p, onHold } = setup();
    p.down(ev());
    p.move(ev(90, 10));
    p.move(ev(102, 50)); // within the 4 px slop
    vi.advanceTimersByTime(3000);
    expect(onHold).toHaveBeenCalledOnce();
  });

  it("cancels when the pointer moves off the control; the release is neither a tap nor a hold", () => {
    const { p, onHold, onTap } = setup();
    p.down(ev());
    p.move(ev(150, 50));
    vi.advanceTimersByTime(3000);
    p.up();
    expect(onHold).not.toHaveBeenCalled();
    expect(onTap).not.toHaveBeenCalled();
  });

  it("a control without a hold taps at once on release", () => {
    const { p, onHold, onTap } = setup(0);
    p.down(ev());
    vi.advanceTimersByTime(5000);
    p.up();
    expect(onTap).toHaveBeenCalledOnce();
    expect(onHold).not.toHaveBeenCalled();
  });
});
