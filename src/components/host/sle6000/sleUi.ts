// Shared definitions for the SLE6000 screen replica: the settings table comes from the engine
// (device_models/sle6000_params.js, one source for ranges and resolutions), the rest is display.
import {
  SLE_PARAMS,
  SLE_MODES,
  SLE_HFO_MODES,
  sle_step,
  sle_interlocks,
  sle_clamp,
  sle_format,
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
  choices?: number[]; // a list setting: one of these, shown by `names`
  names?: string[];
}
export interface SleMode {
  main: (string | null)[];
  extra: (string | null)[];
  labels?: Record<string, string>;
}

export const PARAMS = SLE_PARAMS as unknown as Record<string, SleParam>;
export const MODES = SLE_MODES as unknown as Record<string, SleMode>;
export const stepParam = sle_step as (name: string, value: number, dir: number) => number;
export const interlocks = sle_interlocks as (
  s: Record<string, number>,
  mode: string,
  changed?: string[],
) => Record<string, number>;
export const clampParam = sle_clamp as (name: string, value: number) => number;
export const HFO_MODES = SLE_HFO_MODES as string[];
export const isHfo = (mode: string | null | undefined) => !!mode && HFO_MODES.includes(mode);

// the text on a tile: a list setting by its name, an Off function as "Off"
export function formatParam(name: string, value: number, decimals: number): string {
  return (sle_format as (n: string, v: number, d: number) => string)(name, value, decimals);
}

// decimals shown on a tile, from the finest resolution of the parameter
export function decimalsOf(name: string): number {
  const res = Math.min(...PARAMS[name].steps.map((s) => s[1]));
  return res >= 1 ? 0 : res >= 0.1 ? 1 : 2;
}

// the tile label in a mode (CPAP for PEEP in CPAP, Ti Max in PSV; PIP MAX / VTV Target with VTV
// on; in HFOV ΔP Max / Vte Target with its VTV on, as on the device's HFOV screen)
export function labelOf(name: string, mode: string, s: Record<string, number>): string {
  const base = MODES[mode]?.labels?.[name] ?? PARAMS[name].label;
  if (mode === "HFOV" && s.hfo_vtv > 0) {
    if (name === "dp") return "ΔP Max";
    if (name === "hfo_vtv") return "Vte Target";
  }
  if (isHfo(mode)) return base;
  if (s.vtv > 0 && mode !== "CPAP" && name === "pip") return "PIP MAX"; // no VTV in CPAP
  if (s.vtv > 0 && name === "vtv") return "VTV Target";
  return base;
}

// settings on the slow stream (Ventilator.sle_<name>)
export const SETTING_NAMES = Object.keys(PARAMS);

// monitored values (IFU p175): key on the slow stream, label, unit, decimals
export type MonCell = MonValue | null; // null: an empty cell (keeps the device's layout)
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

// HFO (IFU p175; the layout of the vendor HFOV screenshot): per oscillation
const ie = mv("mon_ie", "I:E", "", 1, (v) => `1:${v.toFixed(1)}`);
export const MON_HFO_SINGLE: MonCell[][] = [
  [mv("mon_map", "MAP", "mbar", 0), mv("mon_dp", "ΔP", "mbar", 0), mv("mon_vte", "Vte", "ml", 1), mv("mon_dco2", "DCO2", "", 0)],
  [mv("mon_vmin", "Vmin", "l", 2), mv("mon_freq", "Freq", "Hz", 1)],
  [mv("mon_leak", "Leak", "%", 0), mv("mon_o2", "O2", "%", 0)],
];
export const MON_HFO_DOUBLE: MonCell[][] = [
  [null, mv("mon_o2", "O2", "%", 0)],
  [null, mv("mon_dp", "ΔP", "mbar", 0), ie, mv("mon_map", "MAP", "mbar", 0)],
  [mv("mon_vmin", "Vmin", "l", 2), mv("mon_vte", "Vte", "ml", 1), mv("mon_dco2", "DCO2", "", 0), mv("mon_leak", "Leak", "%", 0)],
  [mv("mon_r", "R", "mbar/l/s", 0), null, mv("mon_c", "C", "ml/mbar", 1), null],
];
// HFOV+CMV: the breath values above the oscillation ones
export const MON_HFOCMV_DOUBLE: MonCell[][] = [
  [mv("mon_rr", "RR", "BPM", 0), mv("mon_o2", "O2", "%", 0), mv("mon_ti", "Ti", "s", 2), mv("mon_pip", "PIP", "mbar", 1)],
  [mv("mon_dp", "ΔP", "mbar", 0), mv("mon_map", "MAP", "mbar", 0), ie, mv("mon_freq", "Freq", "Hz", 1)],
  [mv("mon_vmin", "Vmin", "l", 2), mv("mon_vte", "Vte", "ml", 1), mv("mon_dco2", "DCO2", "", 0), mv("mon_leak", "Leak", "%", 0)],
  [mv("mon_r", "R", "mbar/l/s", 0), null, mv("mon_c", "C", "ml/mbar", 1), null],
];

// the monitored-value groups for a mode
export function monGroups(mode: string | null, double: boolean): MonCell[][] {
  if (mode === "HFOV+CMV") return double ? MON_HFOCMV_DOUBLE : MON_HFO_SINGLE;
  if (mode === "HFOV") return double ? MON_HFO_DOUBLE : MON_HFO_SINGLE;
  return double ? MON_DOUBLE : MON_SINGLE;
}

const ALL_MON = [MON_SINGLE, MON_DOUBLE, MON_HFO_SINGLE, MON_HFO_DOUBLE, MON_HFOCMV_DOUBLE]
  .flat(2)
  .filter((m): m is MonValue => m !== null);

export const SLOW_PATHS = [
  "Ventilator.sle_mode",
  "Ventilator.is_enabled",
  "Ventilator.o2_boost_remaining",
  "Ventilator.sle_circuit",
  "Ventilator.hfo_pause_remaining",
  "Ventilator.hfo_sigh_remaining",
  ...SETTING_NAMES.map((k) => `Ventilator.sle_${k}`),
  ...new Set(ALL_MON.map((m) => m.path)),
];

// ---- Layout (IFU §21.1.8, pp 145-146) ----------------------------------------------------------
// Waveforms: up to two of the three waveforms off, filled or lines. Loops: one waveform, a primary
// loop (V/P default) and a secondary loop (F/V default). Trends come in a later phase.
export type WaveName = "pressure" | "flow" | "volume";
export type LoopKind = "VP" | "FV" | "FP";
export interface SleLayout {
  kind: "waveforms" | "loops";
  waves: WaveName[]; // Waveforms layout: the channels shown
  filled: boolean;
  loopWave: WaveName; // Loops layout: the waveform on top
  primary: LoopKind;
  secondary: LoopKind;
}
export const WAVES: WaveName[] = ["pressure", "flow", "volume"];
export const WAVE_LABEL: Record<WaveName, string> = { pressure: "Pressure", flow: "Flow", volume: "Volume" };
export const LOOP_LABEL: Record<LoopKind, string> = { VP: "V/P", FV: "F/V", FP: "F/P" };
export const DEFAULT_LAYOUT: SleLayout = {
  kind: "waveforms",
  waves: ["pressure", "flow", "volume"],
  filled: true,
  loopWave: "pressure",
  primary: "VP",
  secondary: "FV",
};

// the axes of each loop (cmH2O -> mbar for pressure; flow l/min; volume ml)
const AX = {
  pressure: {
    signal: "Ventilator.pres",
    label: "Pressure (mbar)",
    scale: 1 / 1.01972,
    ranges: [[0, 10], [0, 20], [0, 30], [0, 40], [0, 60], [-5, 15], [-10, 20], [-10, 40], [-20, 60]] as [number, number][],
  },
  flow: {
    signal: "Ventilator.flow",
    label: "Flow (l/min)",
    ranges: [[-5, 5], [-10, 10], [-20, 20], [-40, 40], [-80, 80], [-150, 150]] as [number, number][],
  },
  volume: {
    signal: "Ventilator.vol",
    label: "Volume (ml)",
    ranges: [[0, 5], [0, 10], [0, 20], [0, 40], [0, 80], [0, 150], [-5, 5], [-5, 10], [-10, 20], [-20, 40], [-40, 80], [-100, 300]] as [number, number][],
  },
};
// x against y as on the device: V/P is volume against pressure (pressure on x), F/V flow against
// volume, F/P flow against pressure
export const LOOPS = {
  VP: { title: "Volume - Pressure", x: AX.pressure, y: AX.volume },
  FV: { title: "Flow - Volume", x: AX.volume, y: AX.flow },
  FP: { title: "Flow - Pressure", x: AX.pressure, y: AX.flow },
};

// the device "records the last layout selection" (p145): kept per viewer
const LAYOUT_KEY = "sle6000.layout";
export function loadLayout(): SleLayout {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return { ...DEFAULT_LAYOUT };
    const l = { ...DEFAULT_LAYOUT, ...JSON.parse(raw) } as SleLayout;
    l.waves = l.waves.filter((w) => WAVES.includes(w));
    if (!l.waves.length) l.waves = [...DEFAULT_LAYOUT.waves];
    return l;
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}
export function saveLayout(l: SleLayout) {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(l));
  } catch {
    // private window or blocked storage: the layout only lasts the session
  }
}
