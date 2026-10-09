// SLE6000 "Lunar" interface colours. The IFU draws the screen as grey line art, but the device has
// a dark, low-glare screen. SLE publishes no palette. The greys, traces and arcs are sampled
// (pixel modes) from the screen captures in the SLE6000 brochure (SLE6000_screens.pdf: SIMV,
// HFOV, NIPPV Tr., loops and trends screens); the rest by eye from the GE HealthCare product page
// and the Inspiration Healthcare N/C/H brochure. The arc colours by parameter type also follow the
// IFU text (p150), and the alarm colours IFU p206.

export const SLE_THEME = {
  screen: "#000000", // screen background
  panel: "#4b4a4a", // monitored-value group boxes (one neutral grey on the captures)
  button: "#4b4a4a", // side buttons, tiles
  buttonDark: "#3a3939", // pressed / secondary greys
  disc: "#4b4a4a", // inside a tile's arc ring: the tile grey (the ring itself is black)
  text: "#f2f2f2",
  label: "#a9acb1", // small labels (monitored-value captions, axis ticks)
  // waveforms: light teal-grey lines over a dark teal fill on all three channels (the green line on
  // the captures' flow channel is the trigger-level marker, not the trace); unfilled in HFO
  pressure: { line: "#a8c0c4", fill: "#3b5555" },
  flow: { line: "#b0d0d0", fill: "#3b5555" },
  volume: { line: "#a8c8cc", fill: "#3b5555" },
  triggered: "#e8d040", // the inspiration of a patient-triggered breath, drawn yellow
  co2: { line: "#e6d84a", fill: "#6f6a24" }, // etCO2 is shown in yellow (brochure); later phase
  header: "#4a4a4a", // channel header strip
  axis: "#6b6e73",
  zero: "#3a3c41",
  sweep: "#e53935", // red sweep head
  // loops (IFU p146): the active loops blue-teal, a saved loop white
  loopActive: "#a8c8cc",
  loopSaved: "#f2f2f2",
  // trends (sampled from the brochure's Trends capture): first trend light blue, second pale yellow
  trend1: "#80c8e8",
  trend2: "#e0e090",
  alarmLimit: "#ef5a2a", // alarm-limit lines on the pressure channel (alarms, a later phase)
  // tile arcs by parameter type
  arc: { time: "#90d0f0", pressure: "#e88028", o2: "#84c428", sens: "#f2f2f2" } as Record<string, string>,
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
