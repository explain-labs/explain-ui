// SLE6000 "Lunar" interface colours. The IFU draws the screen as grey line art, but the device has
// a dark, low-glare screen. These values are sampled by eye from vendor product photos, as SLE
// publishes no palette: the GE HealthCare SLE6000 product page (a SIMV screen) and the Inspiration
// Healthcare SLE6000 N/C/H brochure (SIMV + VTV and HFOV screens). The arc colours by parameter type
// also follow the IFU text (p150), and the alarm colours IFU p206.

export const SLE_THEME = {
  screen: "#000000", // screen background
  panel: "#2b2d31", // overlays (mode panel), group boxes
  button: "#4a4d52", // side buttons, tiles
  buttonDark: "#3a3c41", // tile gradient bottom, channel header strips
  disc: "#1c1d20", // inner disc behind a tile value
  text: "#f2f2f2",
  label: "#a9acb1", // small labels (monitored-value captions, axis ticks)
  // waveforms: pressure slate-teal filled, flow bright green line, volume teal filled
  pressure: { line: "#9fbfba", fill: "#4d6f6b" },
  flow: { line: "#3ddc4a", fill: null },
  volume: { line: "#8fd0c6", fill: "#3f7d76" },
  co2: { line: "#e6d84a", fill: "#6f6a24" }, // etCO2 is shown in yellow (brochure); later phase
  header: "#3a3c41", // channel header strip
  axis: "#6b6e73",
  zero: "#3a3c41",
  sweep: "#e53935", // red sweep head
  // loops (IFU p146): the active loops blue-teal, a saved loop white
  loopActive: "#8fd0c6",
  loopSaved: "#f2f2f2",
  alarmLimit: "#ef5a2a", // alarm-limit lines on the pressure channel (alarms, a later phase)
  // tile arcs by parameter type
  arc: { time: "#4fc3f7", pressure: "#f6a531", o2: "#7ed321", sens: "#f2f2f2" } as Record<string, string>,
  boost: "#e53935", // O2 Boost portion of the O2 arc (IFU p129)
  mute: "#f2c200", // alarm-mute button outline and bell
};

// the palette as CSS custom properties for the frame root
export const SLE_CSS_VARS: Record<string, string> = {
  "--sle-screen": SLE_THEME.screen,
  "--sle-panel": SLE_THEME.panel,
  "--sle-button": SLE_THEME.button,
  "--sle-button-dark": SLE_THEME.buttonDark,
  "--sle-disc": SLE_THEME.disc,
  "--sle-text": SLE_THEME.text,
  "--sle-label": SLE_THEME.label,
  "--sle-mute": SLE_THEME.mute,
  "--sle-o2": SLE_THEME.arc.o2,
};
