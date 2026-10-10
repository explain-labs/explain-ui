import type { MonitorLane } from "@/render/MonitorRenderer";

// Bedside-monitor lane catalogue, keyed by a stable id so hosts can show a
// subset (the lesson page shows four). Each lane carries the slow-stream paths
// its numerics read, so a host can derive its watchlists from the lanes it
// actually renders. ABP uses the post-ductal (AD) numerics to match the AD
// pressure waveform.
export type LaneId = "ecg" | "spo2_pre" | "spo2_post" | "abp" | "resp" | "co2";

export type LaneDef = MonitorLane & { slow: string[] };

// format a slow-stream value (times `scale`), "—" when absent
const f = (n: Record<string, number>, p: string, d: number, scale = 1) => {
  const v = n[p];
  return typeof v === "number" ? (v * scale).toFixed(d) : "—";
};
// the engine reports pressures in mmHg; the CO2 lane shows kPa, as on a European NICU monitor
const KPA_PER_MMHG = 0.133322;

export const LANE_DEFS: Record<LaneId, LaneDef> = {
  ecg: {
    signal: "Monitor.signals.ecg",
    label: "ECG",
    color: "#4ade80",
    unit: "bpm",
    readNumeric: (n) => f(n, "Monitor.heart_rate", 0),
    slow: ["Monitor.heart_rate"],
  },
  spo2_pre: {
    signal: "Monitor.signals.sat_pre",
    label: "SpO₂ pre",
    color: "#22d3ee",
    unit: "%",
    fill: true,
    readNumeric: (n) => f(n, "Monitor.sao2_pre", 0),
    slow: ["Monitor.sao2_pre"],
  },
  spo2_post: {
    signal: "Monitor.signals.sat_post",
    label: "SpO₂ post",
    color: "#38bdf8",
    unit: "%",
    fill: true,
    readNumeric: (n) => f(n, "Monitor.sao2_post", 0),
    slow: ["Monitor.sao2_post"],
  },
  abp: {
    signal: "Monitor.signals.abp",
    label: "ABP",
    color: "#f87171",
    unit: "mmHg",
    readNumeric: (n) =>
      `${f(n, "Monitor.minmax.abp_pres_max", 0)}/${f(n, "Monitor.minmax.abp_pres_min", 0)}`,
    readSub: (n) => `(${f(n, "Monitor.minmax.abp_pres_mean", 0)})`,
    slow: [
      "Monitor.minmax.abp_pres_max",
      "Monitor.minmax.abp_pres_min",
      "Monitor.minmax.abp_pres_mean",
    ],
  },
  resp: {
    signal: "Monitor.signals.resp",
    label: "Resp",
    color: "#e5e7eb",
    unit: "/min",
    readNumeric: (n) => f(n, "Monitor.resp_rate", 0),
    slow: ["Monitor.resp_rate"],
  },
  co2: {
    signal: "Monitor.signals.co2",
    label: "CO₂",
    color: "#facc15",
    unit: "kPa",
    fill: true,
    readNumeric: (n) => f(n, "Monitor.etco2", 1, KPA_PER_MMHG), // Monitor.etco2 is in mmHg
    slow: ["Monitor.etco2"],
  },
};

export const ALL_LANES: LaneId[] = ["ecg", "spo2_pre", "spo2_post", "abp", "resp", "co2"];
