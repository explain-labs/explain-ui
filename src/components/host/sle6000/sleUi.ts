// Shared definitions for the SLE6000 screen replica: the settings table comes from the engine
// (device_models/sle6000_params.js, one source for ranges and resolutions), the rest is display.
import {
  SLE_PARAMS,
  SLE_MODES,
  sle_step,
  sle_interlocks,
} from "@explain/device_models/sle6000_params";

export interface SleParam {
  label: string;
  unit: string;
  min: number;
  max: number;
  steps: [number, number][];
  def: number;
  kind: string;
  off?: boolean;
  on?: number;
}
export interface SleMode {
  main: (string | null)[];
  extra: (string | null)[];
  labels?: Record<string, string>;
}

export const PARAMS = SLE_PARAMS as unknown as Record<string, SleParam>;
export const MODES = SLE_MODES as unknown as Record<string, SleMode>;
export const stepParam = sle_step as (name: string, value: number, dir: number) => number;
export const interlocks = sle_interlocks as (s: Record<string, number>, mode: string) => Record<string, number>;

// decimals shown on a tile, from the finest resolution of the parameter
export function decimalsOf(name: string): number {
  const res = Math.min(...PARAMS[name].steps.map((s) => s[1]));
  return res >= 1 ? 0 : res >= 0.1 ? 1 : 2;
}

// the tile label in a mode (CPAP for PEEP in CPAP, Ti Max in PSV; PIP MAX / VTV Target with VTV on)
export function labelOf(name: string, mode: string, s: Record<string, number>): string {
  const base = MODES[mode]?.labels?.[name] ?? PARAMS[name].label;
  if (s.vtv > 0 && mode !== "CPAP" && name === "pip") return "PIP MAX"; // no VTV in CPAP
  if (s.vtv > 0 && name === "vtv") return "VTV Target";
  return base;
}

// settings on the slow stream (Ventilator.sle_<name>)
export const SETTING_NAMES = Object.keys(PARAMS);

// monitored values (IFU p175): key on the slow stream, label, unit, decimals
export interface MonValue {
  path: string;
  label: string;
  unit: string;
  d: number;
  fmt?: (v: number) => string;
}
const mv = (p: string, label: string, unit: string, d: number, fmt?: (v: number) => string): MonValue => ({
  path: `Ventilator.${p}`,
  label,
  unit,
  d,
  fmt,
});
// single column (factory default, up to 8), grouped 4 / 2 / 2
export const MON_SINGLE: MonValue[][] = [
  [mv("mon_pip", "PIP", "mbar", 1), mv("mon_peep", "PEEP", "mbar", 1), mv("mon_map", "MAP", "mbar", 0), mv("mon_vte", "Vte", "ml", 1)],
  [mv("mon_vmin", "Vmin", "l", 2), mv("mon_rr", "RR", "BPM", 0)],
  [mv("mon_leak", "Leak", "%", 0), mv("mon_o2", "O2", "%", 0)],
];
// double column (up to 16)
export const MON_DOUBLE: MonValue[][] = [
  [
    mv("mon_rr", "RR", "BPM", 0), mv("mon_o2", "O2", "%", 0),
    mv("mon_ti", "Ti", "s", 2), mv("mon_pip", "PIP", "mbar", 1),
    mv("mon_te", "Te", "s", 2), mv("mon_peep", "PEEP", "mbar", 1),
    mv("mon_ie", "I:E", "", 1, (v) => `1:${v.toFixed(1)}`), mv("mon_map", "MAP", "mbar", 0),
  ],
  [
    mv("mon_vmin", "Vmin", "l", 2), mv("mon_vte", "Vte", "ml", 1),
    mv("mon_vti", "Vti", "ml", 1), mv("mon_leak", "Leak", "%", 0),
  ],
  [
    mv("mon_c", "C", "ml/mbar", 1), mv("mon_r", "R", "mbar/l/s", 0),
    mv("mon_c20c", "C20/C", "", 1), mv("mon_trig", "Trig", "/min", 0),
  ],
];

export const SLOW_PATHS = [
  "Ventilator.sle_mode",
  "Ventilator.is_enabled",
  "Ventilator.o2_boost_remaining",
  "Ventilator.sle_circuit",
  ...SETTING_NAMES.map((k) => `Ventilator.sle_${k}`),
  ...new Set([...MON_SINGLE.flat(), ...MON_DOUBLE.flat()].map((m) => m.path)),
];
