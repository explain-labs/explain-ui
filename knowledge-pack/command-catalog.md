# Explain — command catalog (bot-facing)

What you may propose as `explain-command` actions. See `command-protocol.md` for HOW to
emit them and the rules. Resolve a target like this: read the **`Models in scenario:`**
map in the live context to pick the right *instance name*, find that instance's
*model_type* in the map, then use the fields listed under that model_type here.

**Envelope** (one JSON object per fenced block):

```json
{"op":"setProp","model":"<instance name>","target":"<field>","value":<value>,"it":<ramp s?>,"at":<delay s?>,"reason":"<short label>"}
{"op":"call","model":"<instance name>","target":"<function>","args":[...],"reason":"<short label>"}
{"op":"event","name":"<event name>","changes":[{"model":"..","target":"..","value":..,"it":<s?>,"at":<s?>}],"reason":"<short label>"}
{"op":"start"}   {"op":"stop"}
```

Rules of thumb:
- **Values are in the displayed unit** shown per field; stay within the stated range.
- **Timing (optional):** `it` ramps a numeric value to the target over N simulated seconds;
  `at` delays the change N seconds. `op:"event"` bundles several timed `changes[]` into a
  named event saved to the Event Scheduler panel — see `command-protocol.md` (Scheduling).
- **To tune a physiological property, prefer its `*_factor_ps` knob** (a `factor` field,
  1.0 = baseline, >1 increases, <1 decreases) over editing the raw base value — factors
  compose with interventions and weight-scaling. E.g. stiffer LV → `LV.el_max_factor_ps` 1.3.
- Only fields listed here are accepted; readonly measured-outputs and structural wiring are omitted.

Snapshot: **44 model_types**, **421 settable params**, **28 functions**
(+ 58 Guided commands, 7 diagram actions). Regenerate with `node scripts/build_command_catalog.mjs`.

---
## Guided mode — curated safe set

Active when the user selects **Guided** scope in the chat panel. Only these commands apply;
anything else is rejected (the app suggests switching to Full). Full mode (below) is the default.

- `call` `Ventilator.switch_ventilator` — turn mechanical ventilation on/off (arg: boolean)
- `call` `Ventilator.set_fio2` — set inspired O2 fraction (0.21–1.0)
- `call` `Ventilator.set_ettube_diameter` — set endotracheal tube diameter (mm)
- `call` `Ventilator.set_ettube_length` — set endotracheal tube length (mm)
- `setProp` `Ventilator.vent_mode` — ventilation mode (PC/PRVC/PS/CPAP)
- `setProp` `Ventilator.vent_rate` — ventilator rate (/min)
- `setProp` `Ventilator.insp_time` — inspiration time (s)
- `setProp` `Ventilator.tidal_volume` — target tidal volume (mL)
- `setProp` `Ventilator.pip_cmh2o` — peak inspiratory pressure (cmH2O)
- `setProp` `Ventilator.pip_cmh2o_max` — max peak inspiratory pressure, PRVC (cmH2O)
- `setProp` `Ventilator.peep_cmh2o` — positive end-expiratory pressure (cmH2O); doubles as the CPAP level in CPAP mode
- `setProp` `Ventilator.insp_flow` — inspiratory/bias flow (L/min)
- `setProp` `Ventilator.synchronized` — synchronized (patient-triggered) ventilation on/off
- `setProp` `Ventilator.trigger_volume_perc` — breath trigger volume (% of tidal volume)
- `call` `Ventilator.trigger_breath` — trigger a single manual breath (no args)
- `setProp` `Heart.heart_rate_ref` — reference heart rate (bpm)
- `setProp` `Heart.ans_sens` — autonomic sensitivity of the heart (0–1)
- `setProp` `Ans.ans_active` — autonomic nervous system on/off
- `setProp` `Breathing.breathing_enabled` — spontaneous breathing on/off
- `setProp` `Breathing.minute_volume_ref` — reference minute volume (L/kg/min)
- `setProp` `Metabolism.met_active` — metabolism on/off
- `setProp` `Metabolism.vo2` — oxygen consumption VO2 (mL/kg/min)
- `call` `Drugs.administer_bolus` — IV bolus (args: drug name, dose in mcg 0–1000)
- `call` `Drugs.set_infusion` — continuous infusion (args: drug name, rate mcg/kg/min)
- `setProp` `Drugs.drugs_running` — drug engine on/off
- `call` `Resuscitation.switch_cpr` — start/stop CPR (arg: boolean)
- `call` `Resuscitation.set_fio2` — set CPR ventilation FiO2 (0–1)
- `setProp` `Resuscitation.chest_comp_freq` — chest compression frequency (/min)
- `setProp` `Resuscitation.chest_comp_max_pres` — peak chest compression pressure (mmHg)
- `setProp` `Resuscitation.chest_comp_no` — chest compressions per cycle (e.g. 3 for 3:1, 15 for 15:2)
- `setProp` `Resuscitation.chest_comp_cont` — continuous compressions without ventilation pauses (boolean)
- `setProp` `Resuscitation.vent_freq` — CPR ventilation rate (/min)
- `setProp` `Resuscitation.vent_no` — ventilations per pause (e.g. 2 for 15:2)
- `setProp` `Resuscitation.vent_pres_pip` — CPR ventilation peak pressure (cmH2O); pushed to the ventilator when CPR is switched on
- `setProp` `Resuscitation.vent_pres_peep` — CPR ventilation PEEP (cmH2O); pushed to the ventilator when CPR is switched on
- `setProp` `Resuscitation.vent_insp_time` — CPR ventilation inspiration time (s); pushed to the ventilator when CPR is switched on
- `setProp` `Ecls.ecls_running` — ECLS circuit on/off (boolean)
- `setProp` `Ecls.ecls_clamped` — clamp/unclamp the ECLS blood path (boolean)
- `setProp` `Ecls.pump_type` — pump device (list: Abbott PediMag, Abbott CentriMag, Getinge Rotaflow RF-32, Medtronic Bio-Pump BP-50, Generic roller pump); sets centrifugal/roller mode and the pump's H-Q curve. Keep pump_rpm within the pump's max (roller ~250)
- `setProp` `Ecls.pump_rpm` — pump speed (rpm; max depends on the pump: 3000-5500 centrifugal, 250 roller)
- `setProp` `Ecls.gas_flow` — sweep gas flow (L/min, 0-10)
- `setProp` `Ecls.gas_fio2` — sweep gas O2 fraction (0.21-1.0)
- `setProp` `Ecls.gas_fico2` — sweep gas CO2 fraction (0-0.1)
- `setProp` `Ecls.drainage_res_factor` — drainage cannula resistance multiplier (1.0 = baseline)
- `setProp` `Ecls.return_res_factor` — return cannula resistance multiplier (1.0 = baseline)
- `setProp` `Ecls.tubing_res_factor` — circuit tubing resistance multiplier (1.0 = baseline)
- `setProp` `Ecls.pump_res_factor` — pump resistance multiplier (1.0 = baseline)
- `setProp` `Ecls.oxy_res_factor` — oxygenator resistance multiplier (1.0 = baseline)
- `setProp` `Ecls.drainage_cannula_type` — drainage cannula key from the scenario's cannula library (string)
- `setProp` `Ecls.return_cannula_type` — return cannula key from the scenario's cannula library (string)
- `start`  — start the realtime simulation loop
- `stop`  — stop the realtime simulation loop
- `revert`  — undo all live changes — reload the patient as it was loaded
- `tune`  — tune the live model to target value(s): map/co/hr/po2/spo2/pco2/be/ph/blood_volume (Full scope)
- `loadDefinition`  — load+run a bot-built calibrated patient (Full scope; definition rides in response.artifact)
- `setProp` `Pda.diameter_relative` — Ductus arteriosus (PDA) size — directional nudge lever
- `setProp` `Shunts.diameter_fo` — Foramen ovale size — directional nudge lever
- `setProp` `Shunts.diameter_vsd` — Ventricular septal defect (VSD) size — directional nudge lever

---

## Full mode — all settable fields by model_type

### Ans

_setProp_:
- `ans_active` — ANS active (boolean)
- `is_enabled` — enabled (boolean) _(all)_

### AnsAfferent

_setProp_:
- `min_value` — minimum of the input (firing rate is 0.0) (number, firing rate is 0.0)
- `max_value` — maximum of the input (firing rate is 1.0) (number, firing rate is 1.0)
- `set_value` — setpoint of the input (firing rate is 0.5) (number, firing rate is 0.5)
- `tc` — timeconstant (s) (number, s)
- `effect_weight` — effect weight (number) _(extra)_
- `is_enabled` — enabled (boolean) _(all)_

### AnsEfferent

_setProp_:
- `effect_at_max_firing_rate` — effect size at max firing_rate of 1 (number)
- `effect_at_min_firing_rate` — effect size at min firing_rate of 0 (number)
- `tc` — timeconstant (s) (number, s)
- `is_enabled` — enabled (boolean) _(all)_

### Blood

_setProp_:
- `is_enabled` — enabled (boolean) _(all)_

_call_:
- `set_temperature(temp (number, range 25–45); site (list, one of BloodCapacitance/BloodTimeVaryingElastance/BloodVessel/HeartChamber/MicroVascularUnit/BloodPump))` — set temperature (C)
- `set_viscosity(viscosity (number, range 0.1–12))` — set viscosity (cP)
- `set_haldane_coeff(new_coeff (number, 0 = off, range 0–5))` — set Haldane coefficient
- `set_P50(new_p50 (number, fetal HbF 18.8, neonatal 20.0, adult 26.7, range 15–30))` — set P50 (Hb-O2 affinity)
- `set_to2(to2 (number, range 0–20); site (list, one of BloodCapacitance/BloodTimeVaryingElastance/BloodVessel/HeartChamber/MicroVascularUnit/BloodPump))` — set total oxygen concentration (mmol/l)
- `set_tco2(tco2 (number, range 0–20); site (list, one of BloodCapacitance/BloodTimeVaryingElastance/BloodVessel/HeartChamber/MicroVascularUnit/BloodPump))` — set total carbon dioxide concentration (mmol/l)
- `set_solute(solute_name (list, one of na/k/ca/cl/lact/mg/albumin/phosphates/uma/hemoglobin); solute_value (number, range 0–1000); site (list, one of BloodCapacitance/BloodTimeVaryingElastance/BloodVessel/HeartChamber/MicroVascularUnit/BloodPump))` — set solute concentration

### BloodCapacitance

_setProp_:
- `is_enabled` — enabled (boolean)
- `fixed_composition` — fixed composition (boolean)
- `vol` — volume (L) (number, L)
- `u_vol` — unstressed volume (L) (number, L)
- `el_base` — elastance baseline (mmHg/L) (number, mmHg/L)
- `el_k` — elastance non linear k (number)
- `temp` — blood temperature (°C) (number, °C) _(extra)_
- `viscosity` — blood viscosity (cP) (number, cP) _(extra)_
- `u_vol_factor_ps` — unstressed volume factor (factor) _(factors)_
- `el_base_factor_ps` — elastance baseline factor (factor) _(factors)_
- `el_k_factor_ps` — elastance non linear factor (factor) _(factors)_

### BloodDiffusor

_setProp_:
- `is_enabled` — enabled (boolean)
- `dif_o2` — oxygen diffusion constant (number)
- `dif_co2` — carbon dioxide diffusion constant (number)
- `dif_solutes` — solute diffusion constant (number)
- `comp_blood1` — blood component 1 (list, one of BloodCapacitance/BloodTimeVaryingElastance/BloodPump/BloodVessel/MicroVascularUnit/HeartChamber)
- `comp_blood2` — blood component 2 (list, one of BloodCapacitance/BloodTimeVaryingElastance/BloodPump/BloodVessel/MicroVascularUnit/HeartChamber)
- `dif_o2_factor_ps` — oxygen diffusion factor (factor)
- `dif_co2_factor_ps` — carbon dioxide diffusion factor (factor)
- `dif_solutes_factor_ps` — solute diffusion factor (factor)

### BloodPump

_setProp_:
- `is_enabled` — enabled (boolean)
- `u_vol` — unstressed volume (L) (number, L)
- `el_base` — elastance pump (mmHg/L) (number, mmHg/L)
- `pump_rpm` — pump rpm (number)
- `el_k` — non linear elastance factor (number)
- `inlet` — inlet blood resistor (list, one of BloodResistor/BloodVesselResistor/HeartValve)
- `outlet` — outlet blood resistor (list, one of BloodResistor/BloodVesselResistor/HeartValve)

### BloodTimeVaryingElastance

_setProp_:
- `is_enabled` — enabled (boolean)
- `vol` — volume (L) (number, L)
- `u_vol` — unstressed volume (L) (number, L)
- `el_min` — elastance minimum (mmHg/L) (number, mmHg/L)
- `el_max` — elastance maximum (mmHg/L) (number, mmHg/L)
- `el_k` — elastance non linear k (number)
- `u_vol_factor_ps` — unstressed volume factor (factor)
- `el_min_factor_ps` — elastance minimum baseline factor (factor)
- `el_max_factor_ps` — elastance maximum baseline factor (factor)
- `el_k_factor_ps` — elastance non linear factor (factor)

### BloodVessel

_setProp_:
- `is_enabled` — enabled (boolean)
- `no_flow` — no flow allowed (boolean)
- `no_back_flow` — no back flow allowed (boolean)
- `vol` — volume (L) (number, L)
- `u_vol` — unstressed volume (L) (number, L)
- `el_base` — elastance baseline (mmHg/L) (number, mmHg/L)
- `el_k` — elastance non linear k (number)
- `r_for` — r_for (mmHg/L/s) (number, mmHg/L/s)
- `r_back` — r_back (mmHg/L/s) (number, mmHg/L/s)
- `r_factor_ps` — resistance factor (number) _(factors)_
- `u_vol_factor_ps` — unstressed volume factor (factor) _(factors)_
- `el_base_factor_ps` — elastance baseline factor (factor) _(factors)_
- `el_k_factor_ps` — elastance non linear factor (factor) _(factors)_
- `alpha` — resistance-elastance coupling (0-1) (number, 0-1) _(advanced)_
- `ans_sens` — ans sensitivity (0-1) (number, 0-1) _(advanced)_

### Brain

_setProp_:
- `brain_running` — brain controller running (boolean)
- `autoregulation_enabled` — autoregulation enabled (boolean)
- `autoregulation_gain` — autoregulation gain (1=intact, 0=pressure-passive) (number, 1=intact, 0=pressure-passive, range 0–1)
- `icp_enabled` — ICP coupling enabled (boolean)
- `is_enabled` — enabled (boolean) _(all)_

_call_:
- `set_edema(volume_ml (number, mL, range 0–40))` — set intracranial oedema (mL)

### Breathing

_setProp_:
- `breathing_enabled` — spont breathing enabled (boolean)
- `minute_volume_ref` — reference minute volume (L/kg/min) (number, L/kg/min)
- `vt_rr_ratio` — tidal volume - resp rate ratio (number)
- `ie_ratio` — insp/exp ratio (number)
- `rmp_gain_max` — rmp gain max (number) _(extra)_
- `is_enabled` — enabled (boolean) _(all)_

### Capacitance

_setProp_:
- `is_enabled` — enabled (boolean)
- `fixed_composition` — fixed composition (boolean)
- `u_vol` — unstressed volume (L) (number, L)
- `el_base` — elastance baseline (mmHg/L) (number, mmHg/L)
- `el_k` — elastance non linear k (number)
- `u_vol_factor_ps` — unstressed volume factor (factor) _(factors)_
- `el_base_factor_ps` — elastance baseline factor (factor) _(factors)_
- `el_k_factor_ps` — elastance non linear  factor (factor) _(factors)_

### Circulation

_setProp_:
- `is_enabled` — enabled (boolean) _(all)_
- `svr_factor_art` — svr factor (arterioles) (factor, arterioles, range -10–10)
- `svr_factor_ven` — svr factor (venules) (factor, venules, range -10–10)
- `pvr_factor_art` — pvr factor (arterioles) (factor, arterioles, range -10–10)
- `pvr_factor_ven` — pvr factor (venules) (factor, venules, range -10–10)

### Container

_setProp_:
- `is_enabled` — enabled (boolean)
- `u_vol` — unstressed volume (L) (number, L)
- `el_base` — elastance baseline (mmHg/L) (number, mmHg/L)
- `el_k` — elastance non linear k (number)
- `u_vol_factor_ps` — unstressed volume factor (factor)
- `el_base_factor_ps` — elastance baseline factor (factor)
- `el_k_factor_ps` — elastance non linear  factor (factor)

### Drugs

_setProp_:
- `drugs_running` — drugs running (boolean)
- `is_enabled` — enabled (boolean) _(all)_

_call_:
- `administer_bolus(drug (list, one of adrenaline/noradrenaline/pge1); dose (number, mcg, range 0–1000))` — administer IV bolus
- `set_infusion(drug (list, one of adrenaline/noradrenaline/pge1); rate (number, mcg/kg/min, range 0–100))` — set infusion
- `set_drug_param(drug (list, one of adrenaline/noradrenaline/pge1); param (list, one of ke0/clearance.global/hr_ec50/hr_emax/hr_hill/cont_ec50/cont_emax/cont_hill/svr_ec50/svr_emax/svr_hill/pda_ec50/pda_emax/pda_hill); value (number, range 0–1000))` — set PK/PD parameter

### Ecls

_setProp_:
- `is_enabled` — enabled (boolean)
- `ecls_running` — ECLS running (boolean)
- `ecls_clamped` — ECLS clamped (boolean)
- `pump_type` — pump (list, one of Abbott PediMag/Abbott CentriMag/Getinge Rotaflow RF-32/Medtronic Bio-Pump BP-50/Generic roller pump)
- `pump_rpm` — pump speed (rpm) (number, rpm, range 0–5500)
- `gas_flow` — sweep gas flow (L/min) (number, L/min, range 0–10)
- `gas_fio2` — sweep gas fio2 (fraction) (number, fraction, range 0.21–1)
- `gas_fico2` — sweep gas fico2 (fraction) (number, fraction, range 0–0.1)
- `drainage_site` — drainage site (list, one of BloodCapacitance/BloodTimeVaryingElastance/BloodVessel/HeartChamber)
- `return_site` — return site (list, one of BloodCapacitance/BloodTimeVaryingElastance/BloodVessel/HeartChamber)
- `gas_humidity` — sweep gas humidity (fraction) (number, fraction, range 0–1) _(extra)_
- `gas_temp` — sweep gas temperature (°C) (number, °C, range 0–42) _(extra)_
- `dif_o2` — o2 diffusion constant (number, range 0–0.1) _(extra)_
- `dif_co2` — co2 diffusion constant (number, range 0–0.1) _(extra)_
- `tubing_in_diameter` — tubing in diameter (m) (number, m, range 0–0.05) _(extra)_
- `tubing_in_length` — tubing in length (m) (number, m, range 0–5) _(extra)_
- `tubing_out_diameter` — tubing out diameter (m) (number, m, range 0–0.05) _(extra)_
- `tubing_out_length` — tubing out length (m) (number, m, range 0–5) _(extra)_
- `oxy_vol` — oxygenator volume (L) (number, L, range 0–1) _(extra)_
- `pump_vol` — pump volume (L) (number, L, range 0–1) _(extra)_
- `tubing_in_res` — tubing in resistance (mmHg/(L/s)) (number, mmHg/(L/s, range 100–100000) _(advanced)_
- `tubing_out_res` — tubing out resistance (mmHg/(L/s)) (number, mmHg/(L/s, range 100–100000) _(advanced)_
- `pump_res_for` — pump forward resistance (mmHg/(L/s)) (number, mmHg/(L/s, range 100–100000) _(advanced)_
- `pump_res_back` — pump backward resistance (mmHg/(L/s)) (number, mmHg/(L/s, range 100–100000) _(advanced)_
- `oxy_res_for` — oxygenator forward resistance (mmHg/(L/s)) (number, mmHg/(L/s, range 100–100000) _(advanced)_
- `oxy_res_back` — oxygenator backward resistance (mmHg/(L/s)) (number, mmHg/(L/s, range 100–100000) _(advanced)_
- `drainage_res_factor` — drainage cannula resistance factor (factor, range 0–100)
- `return_res_factor` — return cannula resistance factor (factor, range 0–100)
- `tubing_res_factor` — tubing resistance factor (factor, range 0–100)
- `pump_res_factor` — pump resistance factor (factor, range 0–100)
- `oxy_res_factor` — oxygenator resistance factor (factor, range 0–100)

### Fluids

_setProp_:
- `is_enabled` — enabled (boolean) _(all)_

_call_:
- `add_volume( (number, ml); _default_time (number, s); fluid type (list, one of normal_saline/ringers_lactate/packed_cells/albumin_20%))` — Adminster fluid

### Gas

_setProp_:
- `is_enabled` — enabled (boolean) _(extra)_

_call_:
- `set_atmospheric_pressure(pres_atm (number, range 100–5000))` — atmospheric pressure (mmHg)
- `set_temperature(temp (number, range -100–100); site (list, one of GasCapacitance))` — temperature (C)
- `set_humidity(humidity (number, range 0–1); site (list, one of GasCapacitance))` — humidity factor
- `set_fio2(fio2 (number, range 0–1); site (list, one of GasCapacitance))` — fio2

### GasCapacitance

_setProp_:
- `is_enabled` — enabled (boolean)
- `fixed_composition` — fixed gas composition (boolean)
- `u_vol` — unstressed volume (L) (number, L)
- `el_base` — elastance baseline (mmHg/L) (number, mmHg/L)
- `el_k` — elastance non linear k (number)
- `target_temp` — target temperature (dgs C) (number, dgs C)
- `pres_atm` — atmospheric pressure (mmHg) (number, mmHg)
- `u_vol_factor_ps` — unstressed volume factor (factor)
- `el_base_factor_ps` — elastance baseline factor (factor)
- `el_k_factor_ps` — elastance non linear factor (factor)

### GasDiffusor

_setProp_:
- `is_enabled` — enabled (boolean)
- `dif_o2` — oxygen diffusion constant (number)
- `dif_co2` — carbon dioxide diffusion constant (number)
- `dif_n2` — nitric oxide diffusion constant (number)
- `dif_other` — other gasses diffusion constant (number)
- `comp_gas1` — gas component 1 (list, one of GasCapacitance)
- `comp_gas2` — gas component 2 (list, one of GasCapacitance)
- `dif_o2_factor_ps` — oxygen diffusion factor (factor)
- `dif_co2_factor_ps` — carbon dioxide diffusion factor (factor)
- `dif_n2_factor_ps` — nitric oxide diffusion factor (factor)
- `dif_other_factor_ps` — other gasses diffusion factor (factor)

### GasExchanger

_setProp_:
- `is_enabled` — enabled (boolean)
- `dif_o2` — oxygen diffusion constant (number)
- `dif_co2` — carbon dioxide diffusion constant (number)
- `comp_gas` — gas component (list, one of GasCapacitance)
- `comp_blood` — blood component (list, one of BloodCapacitance/BloodTimeVaryingElastance/BloodPump/BloodVessel/MicroVascularUnit/HeartChamber)
- `dif_o2_factor_ps` — oxygen diffusion factor (factor)
- `dif_co2_factor_ps` — carbon dioxide diffusion factor (factor)

### Glucose

_setProp_:
- `glucose_running` — glucose controller running (boolean)
- `glucose_setpoint` — glucose set-point (mmol/L) (number, mmol/L)
- `hgp_rate` — hepatic glucose production (mmol/kg/min) (number, mmol/kg/min)
- `glu_use_rate` — glucose utilization (mmol/kg/min) (number, mmol/kg/min) _(advanced)_
- `is_enabled` — enabled (boolean) _(all)_

### Heart

_setProp_:
- `av_block_mode` — AV block (list, one of none/first_degree/second_degree/complete)
- `sa_node_enabled` — SA node active (off = sinus arrest) (boolean, off = sinus arrest)
- `vent_pacemaker_mode` — ventricular pacemaker mode (list, one of escape/vt)
- `heart_rate_ref` — reference heart rate (bpm) (number, bpm, range 10–300)
- `pq_time` — pq time (ms) (number, ms, range 50–1000)
- `qrs_time` — qrs time (ms) (number, ms, range 50–500)
- `qt_time` — qt time (ms) (number, ms, range 50–1000)
- `ans_sens` — ans sensitivity (number, range 0–1)
- `pc_extra_volume` — pericardial fluid volume (mL) (number, mL, range 0–1000)
- `av_block_ratio` — AV block ratio (2nd degree, e.g. 2 = 2:1) (number, 2nd degree, e.g. 2 = 2:1, range 2–6) _(extra)_
- `vent_escape_rate` — ventricular escape rate (bpm) (number, bpm, range 20–120) _(extra)_
- `vt_rate` — ventricular tachycardia rate (bpm) (number, bpm, range 120–300) _(extra)_
- `av_delay` — av delay time (ms) (number, ms, range 0.5–10) _(extra)_
- `p_amp` — ECG P amplitude (mV) (number, mV, range -5–5) _(extra)_
- `q_amp` — ECG Q amplitude (mV) (number, mV, range -5–5) _(extra)_
- `r_amp` — ECG R amplitude (mV) (number, mV, range -5–5) _(extra)_
- `s_amp` — ECG S amplitude (mV) (number, mV, range -5–5) _(extra)_
- `t_amp` — ECG T amplitude (mV) (number, mV, range -5–5) _(extra)_
- `cont_factor_left` — systolic function factor left (factor, range -20–20) _(factors)_
- `cont_factor_right` — systolic function factor right (factor, range -20–20) _(factors)_
- `relax_factor_left` — diastolic function factor left (factor, range -20–20) _(factors)_
- `relax_factor_right` — diastolic function factor right (factor, range -20–20) _(factors)_
- `pc_el_factor` — pericardial stiffness factor (factor, range 0–200) _(factors)_
- `is_enabled` — enabled (boolean) _(all)_
- `hr_factor` — heartrate factor (number, range 0–1000000)

_call_:
- `trigger_pvc()` — trigger premature ventricular contraction (PVC)

### HeartChamber

_setProp_:
- `is_enabled` — enabled (boolean)
- `vol` — volume (L) (number, L)
- `u_vol` — unstressed volume (L) (number, L)
- `el_min` — elastance minimum (mmHg/L) (number, mmHg/L)
- `el_max` — elastance maximum (mmHg/L) (number, mmHg/L)
- `el_k` — elastance non linear k (number)
- `u_vol_factor_ps` — unstressed volume factor (factor)
- `el_min_factor_ps` — elastance minimum baseline factor (factor)
- `el_max_factor_ps` — elastance maximum baseline factor (factor)
- `el_k_factor_ps` — elastance non linear factor (factor)

### HeartFunction

_setProp_:
- `is_enabled` — enabled (boolean)
- `g_es_lv` — afterload gain LV (number) _(advanced)_
- `g_ed_lv` — over-dilation gain LV (number) _(advanced)_
- `g_es_rv` — afterload gain RV (number) _(advanced)_
- `g_ed_rv` — over-dilation gain RV (number) _(advanced)_
- `remodel_tc` — remodeling time constant (s) (number, s) _(advanced)_
- `stress_avg_tc` — wall-stress averaging time constant (s) (number, s) _(advanced)_
- `k_conc` — concentric remodeling drive (number) _(advanced)_
- `k_ecc` — eccentric remodeling drive (number) _(advanced)_
- `setpoint_warmup` — setpoint warm-up window (s) (number, s) _(advanced)_
- `hf_active` — load-induced compromise active (boolean)
- `remodel_active` — remodeling active (boolean)
- `cont_tc` — acute contractility time constant (s) (number, s)
- `cont_floor` — acute contractility floor (number)

### HeartValve

_setProp_:
- `is_enabled` — enabled (boolean)
- `no_flow` — no flow allowed (boolean)
- `no_back_flow` — no back flow allowed (boolean)
- `r_for` — forward resistance (number)
- `r_back` — backward resistance (number)
- `r_k` — non linear resistance coefficient (number)
- `comp_from` — comp from (list, one of BloodCapacitance/BloodTimeVaryingElastance/BloodPump/BloodVessel/MicroVascularUnit/HeartChamber/GasCapacitance)
- `comp_to` — comp to (list, one of BloodCapacitance/BloodTimeVaryingElastance/BloodPump/BloodVessel/MicroVascularUnit/HeartChamber/GasCapacitance)
- `r_factor_ps` — resistance factor (factor)
- `r_k_factor_ps` — non linear resistance coefficient factor (factor)

### Hormones

_setProp_:
- `hormones_running` — hormones running (boolean)
- `raas_enabled` — RAAS enabled (boolean)
- `adh_enabled` — ADH enabled (boolean)
- `perfusion_setpoint` — perfusion setpoint (mmHg) (number, mmHg, range 0–200) _(extra)_
- `volume_setpoint` — volume setpoint (L) (number, L, range 0–20) _(extra)_
- `osmo_na_setpoint` — Na/osmolality setpoint (mmol/L) (number, mmol/L, range 100–170) _(extra)_
- `k_setpoint` — K setpoint (mmol/L) (number, mmol/L, range 1–8) _(extra)_
- `angiotensin_tc` — angiotensin time constant (s) (number, s, range 0–36000) _(advanced)_
- `aldosterone_tc` — aldosterone time constant (s) (number, s, range 0–36000) _(advanced)_
- `adh_tc` — ADH time constant (s) (number, s, range 0–36000) _(advanced)_
- `renin_gain` — renin gain (perfusion) (number, perfusion, range 0–50) _(advanced)_
- `renin_vol_gain` — renin gain (volume) (number, volume, range 0–50) _(advanced)_
- `aldo_gain` — aldosterone gain (AngII) (number, AngII, range 0–50) _(advanced)_
- `aldo_k_in_gain` — aldosterone gain (K) (number, K, range 0–50) _(advanced)_
- `adh_gain_osmo` — ADH gain (osmotic) (number, osmotic, range 0–50) _(advanced)_
- `adh_gain_baro` — ADH gain (baroreg) (number, baroreg, range 0–50) _(advanced)_
- `ang_svr_gain` — AngII → arteriolar SVR gain (number, range 0–5) _(advanced)_
- `ang_svr_ven_gain` — AngII → venular SVR gain (number, range 0–5) _(advanced)_
- `ang_efferent_gain` — AngII → renal efferent gain (number, range 0–5) _(advanced)_
- `aldo_na_gain` — aldosterone → Na reabs gain (number, range 0–1) _(advanced)_
- `aldo_k_gain` — aldosterone → K waste gain (number, range 0–1) _(advanced)_
- `adh_water_gain` — ADH → water reabs gain (number, range 0–1) _(advanced)_
- `adh_svr_gain` — ADH → SVR gain (number, range 0–5) _(advanced)_
- `is_enabled` — enabled (boolean) _(all)_

### Kidneys

_setProp_:
- `kidneys_running` — kidneys running (boolean)
- `kf` — filtration coeff (L/s/mmHg) (number, L/s/mmHg, range 0–0.001)
- `p_bowman` — bowman pressure (mmHg) (number, mmHg, range 0–40)
- `oncotic_base` — oncotic pressure (mmHg) (number, mmHg, range 0–40)
- `reabsorption_fraction` — water reabsorption fraction (number, range 0–0.9999)
- `autoregulation_enabled` — GFR autoregulation (boolean)
- `kf_factor_ps` — filtration coeff factor (factor) _(factors)_
- `reabs_factor_ps` — reabsorption fraction factor (factor) _(factors)_
- `reabs_factor_adh` — ADH water reabsorption factor (factor) _(factors)_
- `albumin_ref` — reference albumin (g/L) (number, g/L, range 1–60) _(advanced)_
- `myogenic_p_set` — myogenic setpoint (mmHg) (number, mmHg, range 0–250) _(advanced)_
- `myogenic_p_min` — myogenic window min (mmHg) (number, mmHg, range 0–250) _(advanced)_
- `myogenic_p_max` — myogenic window max (mmHg) (number, mmHg, range 0–250) _(advanced)_
- `myogenic_gain_up` — myogenic gain up (/mmHg) (number, /mmHg, range 0–1) _(advanced)_
- `myogenic_gain_down` — myogenic gain down (/mmHg) (number, /mmHg, range 0–1) _(advanced)_
- `myogenic_tc` — myogenic time constant (s) (number, s, range 0–120) _(advanced)_
- `tgf_use_nacl` — TGF use NaCl signal (boolean) _(advanced)_
- `tgf_setpoint` — TGF setpoint (0=auto) (number, 0=auto, range 0–100000) _(advanced)_
- `tgf_seed_delay` — TGF auto-seed delay (s) (number, s, range 0–600) _(advanced)_
- `tgf_gain` — TGF gain (number, range 0–10) _(advanced)_
- `tgf_tc` — TGF time constant (s) (number, s, range 0–600) _(advanced)_
- `afferent_apply_tc` — afferent apply time constant (s) (number, s, range 0–120) _(advanced)_
- `afferent_factor_min` — afferent factor min (number, range 0.01–1) _(advanced)_
- `afferent_factor_max` — afferent factor max (number, range 1–20) _(advanced)_
- `is_enabled` — enabled (boolean) _(all)_

### Lactate

_setProp_:
- `lactate_running` — lactate production running (boolean)
- `lact_baseline` — baseline lactate (mmol/L) (number, mmol/L)
- `threshold_frac` — anaerobic threshold (fraction of resting to2) (number, fraction of resting to2, range 0–1) _(advanced)_
- `lact_per_o2_deficit` — lactate per O2 deficit (mmol/mmol) (number, mmol/mmol) _(advanced)_
- `lact_clearance` — lactate clearance rate (1/s) (number, 1/s) _(advanced)_
- `is_enabled` — enabled (boolean) _(all)_

### MaternalPlacenta

_setProp_:
- `mp_running` — placenta running (boolean)
- `met_active` — metabolism active (boolean)
- `mp_vo2` — placental VO2 (mL O2/kg/min) (number, mL O2/kg/min, range 0–5)
- `vo2_factor_ps` — placental VO2 factor (factor) _(factors)_
- `spiral_res_term_factor` — term spiral-artery resistance factor (number, range 0.001–1) _(advanced)_
- `contraction_pres_gain` — contraction pressure gain (0-1) (number, 0-1, range 0–1) _(advanced)_
- `preg_ga_threshold` — GA threshold (weeks) (number, weeks, range 0–20) _(advanced)_
- `preg_ga_term` — GA term anchor (weeks) (number, weeks, range 30–42) _(advanced)_
- `is_enabled` — enabled (boolean) _(all)_

### Metabolism

_setProp_:
- `met_active` — metabolism enabled (boolean)
- `vo2` — vo2 (ml/kg/min) (number, ml/kg/min)
- `resp_q` — respiratory quotient (number)
- `is_enabled` — enabled (boolean) _(all)_

_call_:
- `set_metabolic_active_model(site (list, one of BloodCapacitance/BloodTimeVaryingElastance); fvo2 (number, range 0–1))` — set local fractional vo2

### Mob

_setProp_:
- `is_enabled` — enabled (boolean)
- `mob_active` — myocardial oxygen balance (boolean)
- `to2_min` — minimal to2 (mmol/l) (number, mmol/l)
- `to2_ref` — reference to2 (mmol/l) (number, mmol/l)
- `resp_q` — respiratory quotient (number)
- `bm_vo2_per_g` — basal mvo2 (mmol O2/g/s) (number, mmol O2/g/s)
- `sw_vo2_per_g` — stroke-work mvo2 (mmol O2/g/(mmHg·mL)) (number, mmol O2/g/(mmHg·mL)
- `hw_intercept` — heart weight intercept (g) (number, g)
- `hw_slope` — heart weight slope (g per g body weight) (number, g per g body weight)
- `hr_factor_min` — heartrate factor min (number)
- `hr_factor_max` — heartrate factor max (number)
- `hr_tc` — heartrate time constant (number)
- `cont_factor_min` — contractility factor min (number)
- `cont_factor_max` — contractility factor max (number)
- `cont_tc` — contractility time constant (number)
- `ans_factor_min` — ans factor min (number)
- `ans_factor_max` — ans factor max (number)
- `ans_tc` — ans time constant (number)

### Monitor

_setProp_:
- `is_enabled` — enabled (boolean)

### Pda

_setProp_:
- `diameter_relative` — ductus diameter (%) (number, %, range 0–100)
- `diameter_ao_max` — max diameter aortic ampulla (mm) (number, mm) _(extra)_
- `diameter_pa_max` — max diameter pulmonary end (mm) (number, mm) _(extra)_
- `length` — ductus arteriosus length (mm) (number, mm) _(extra)_
- `discharge_coeff` — orifice discharge coefficient (number, range 0.3–1) _(extra)_
- `is_enabled` — enabled (boolean) _(all)_

### Placenta

_setProp_:
- `umb_art_res` — umb artery resistance (mmHg*s/L) (number, mmHg*s/L, range 100–100000)
- `umb_ven_res` — umb vein resistance (mmHg*s/L) (number, mmHg*s/L, range 100–100000)
- `plf_res` — fetal plac resistance (mmHg*s/L) (number, mmHg*s/L, range 100–100000)
- `dif_o2` — o2 diffusion constant (number, range 0–0.1)
- `dif_co2` — co2 dioxide diffusion constant (number, range 0–0.1)
- `mat_to2` — mat plac o2 content (mmol/L) (number, mmol/L, range 0–10)
- `mat_tco2` — mat plac co2 content (mmol/L) (number, mmol/L, range 20–30)
- `skip_mat_gas_write` — maternal pool driven externally (uterine coupling) (boolean, uterine coupling) _(advanced)_
- `is_enabled` — enabled (boolean) _(all)_
- `placenta_running` — placenta model running (boolean) _(caption)_
- `umb_clamped` — umbilical vessels clamped (boolean) _(caption)_
- `umb_art_res_factor` — umb artery resistance factor (factor, range 0–100)
- `umb_ven_res_factor` — umb vein resistance factor (factor, range 0–100)
- `plf_res_factor` — fetal placenta resistance factor (factor, range 0–10)

### Resistor

_setProp_:
- `is_enabled` — enabled (boolean)
- `no_flow` — no flow allowed (boolean)
- `no_back_flow` — no back flow allowed (boolean)
- `r_for` — forward resistance (number)
- `r_back` — backward resistance (number)
- `r_k` — non linear resistance coefficient (number)
- `comp_from` — comp from (list, one of BloodCapacitance/BloodTimeVaryingElastance/BloodPump/BloodVessel/MicroVascularUnit/HeartChamber/GasCapacitance)
- `comp_to` — comp to (list, one of BloodCapacitance/BloodTimeVaryingElastance/BloodPump/BloodVessel/MicroVascularUnit/HeartChamber/GasCapacitance)
- `r_factor_ps` — resistance factor (factor)
- `r_k_factor_ps` — non linear resistance coefficient factor (factor)

### Respiration

_setProp_:
- `el_lungs_factor` — lung elastance factor (factor, range -10–10) _(factors)_
- `el_thorax_factor` — thorax elastance factor (factor, range -10–10) _(factors)_
- `res_upper_airways_factor` — upper airway resistance factor (factor, range -100–100) _(factors)_
- `res_lower_airways_factor` — lower airway resistance factor (factor, range -100–100) _(factors)_
- `gex_factor` — gasexchange factor (factor, range -100–100) _(factors)_
- `is_enabled` — enabled (boolean) _(all)_

### Resuscitation

_setProp_:
- `chest_comp_freq` — chest compressions frequency (/min) (number, /min, range 10–150)
- `chest_comp_no` — no of chest compressions (/cycle) (number, /cycle, range 0–30)
- `chest_comp_cont` — continuous compressions (boolean)
- `vent_freq` — ventilation frequency (/min) (number, /min, range 0–100)
- `vent_no` — no of ventilation (/cycle) (number, /cycle, range 0–100)
- `chest_comp_max_pres` — chest compressions pressure (mmHg) (number, mmHg, range 0–500) _(extra)_
- `vent_pres_pip` — ventilation peak pressure (cmH2O) (number, cmH2O, range 0–50) _(extra)_
- `vent_pres_peep` — ventilation peep (cmH2O) (number, cmH2O, range 0–10) _(extra)_
- `vent_insp_time` — ventilation inspiration time (s) (number, s, range 0.1–5) _(extra)_
- `is_enabled` — enabled (boolean) _(all)_

_call_:
- `switch_cpr(cpr_enabled (boolean))` — switch cpr on/off
- `set_fio2(vent_fio2 (number, range 0–1))` — set cpr fio2

### Shunts

_setProp_:
- `diameter_fo` — foramen ovale diameter (mm) (number, mm, range 0–20)
- `diameter_vsd` — ventricular septal defect diameter (mm) (number, mm, range 0–20)
- `ips_res` — intrapulmonary shunt resistance (number, range 10–50000)
- `atrial_septal_width` — atrial septum width (mm) (number, mm, range 0–10) _(extra)_
- `ventricular_septal_width` — ventricular septum width (mm) (number, mm, range 0–10) _(extra)_
- `fo_lr_factor` — foramen ovale L-R resistance factor (number, range 0–100) _(extra)_
- `ips_res` — intrapulmonary shunt resistance (mmHg*s/L) (number, mmHg*s/L, range 0–100000000) _(extra)_
- `is_enabled` — enabled (boolean) _(all)_

### Surfactant

_setProp_:
- `surfactant_running` — recruitment running (boolean)
- `surfactant` — surfactant maturity (0-1) (number, 0-1, range 0–1)
- `is_enabled` — enabled (boolean) _(all)_

_call_:
- `administer_surfactant(target (number, 0-1, range 0–1))` — instill surfactant (therapy)

### Thermoregulation

_setProp_:
- `thermoregulation_running` — thermoregulation running (boolean)
- `setpoint_temp` — set-point temperature (degC) (number, degC)
- `env_temp` — environment temperature (degC) (number, degC)
- `radiant_temp` — radiant-warmer temperature (degC) (number, degC) _(extra)_
- `rel_humidity` — relative humidity (fraction) (number, fraction, range 0–1) _(extra)_
- `q10` — Q10 of metabolic rate (number) _(advanced)_
- `bat_gain` — brown-fat heat gain (W/degC) (number, W/degC) _(advanced)_
- `hr_temp_gain` — heart-rate temperature gain (number) _(advanced)_
- `is_enabled` — enabled (boolean) _(all)_

### TimeVaryingElastance

_setProp_:
- `is_enabled` — enabled (boolean)
- `vol` — volume (L) (number, L)
- `u_vol` — unstressed volume (L) (number, L)
- `el_min` — elastance minimum (mmHg/L) (number, mmHg/L)
- `el_max` — elastance maximum (mmHg/L) (number, mmHg/L)
- `el_k` — elastance non linear k (number)
- `u_vol_factor_ps` — unstressed volume factor (factor)
- `el_min_factor_ps` — elastance minimum baseline factor (factor)
- `el_max_factor_ps` — elastance maximum baseline factor (factor)
- `el_k_factor_ps` — elastance non linear factor (factor)

### Uterus

_setProp_:
- `uterus_running` — uterus running (boolean)
- `met_active` — metabolism active (boolean)
- `ut_vo2` — uterine VO2 (mL O2/kg/min) (number, mL O2/kg/min, range 0–5)
- `perfusion_factor` — perfusion factor (number, range 0–10)
- `pregnant` — pregnant (boolean)
- `preg_ga` — pregnancy GA (weeks) (number, weeks, range 0–42)
- `contractions_running` — contractions running (labor) (boolean, labor)
- `couple_placenta` — couple placenta to uterine blood (boolean) _(extra)_
- `contraction_period` — contraction period (s) (number, s, range 30–600) _(extra)_
- `contraction_duration` — contraction duration (s) (number, s, range 20–180) _(extra)_
- `contraction_amplitude` — contraction amplitude (mmHg) (number, mmHg, range 0–120) _(extra)_
- `vo2_factor_ps` — uterine VO2 factor (factor) _(factors)_
- `resting_tone` — resting tone (mmHg) (number, mmHg, range 0–30) _(advanced)_
- `contraction_pres_gain` — contraction pressure gain (0-1) (number, 0-1, range 0–1) _(advanced)_
- `contraction_r_peak` — contraction resistance peak (x) (number, x, range 1–20) _(advanced)_
- `resp_q` — respiratory quotient (number, range 0–1.5) _(advanced)_
- `preg_ga_threshold` — pregnancy GA threshold (weeks) (number, weeks, range 0–20) _(advanced)_
- `preg_ga_term` — pregnancy GA term anchor (weeks) (number, weeks, range 30–42) _(advanced)_
- `preg_res_term_factor` — term bed-resistance factor (conduits) (number, conduits, range 0.05–1) _(advanced)_
- `preg_cap_res_term_factor` — term capillary-resistance factor (myometrium) (number, myometrium, range 0.05–1) _(advanced)_
- `preg_vol_term_factor` — term bed-volume factor (number, range 1–6) _(advanced)_
- `preg_vo2_term_factor` — term VO2 factor (number, range 1–15) _(advanced)_
- `is_enabled` — enabled (boolean) _(all)_

### Ventilator

_setProp_:
- `vent_mode` — ventilator mode (list, one of PC/PRVC/PS/CPAP)
- `vent_rate` — ventilator rate (/min) (number, /min, range 0–100)
- `insp_time` — inspiration time (s) (number, s, range 0.1–5)
- `insp_flow` — inspiratory flow (l/min) (number, l/min, range 0–20)
- `tidal_volume` — tidal volume (mL) (number, mL, range 1–500)
- `pip_cmh2o` — peak inspiratory pressure (cmH2O) (number, cmH2O, range 5–50)
- `pip_cmh2o_max` — max peak inspiratory pressure (cmH2O) (number, cmH2O, range 5–50)
- `peep_cmh2o` — positive end expiratory pressure (cmH2O) (number, cmH2O, range 0–20)
- `exp_flow` — expiratory flow (l/min) (number, l/min, range 0–20) _(extra)_
- `trigger_volume_perc` — trigger volume percentage (%) (number, %, range 5–20) _(extra)_
- `synchronized` — synchronized ventilation (boolean) _(extra)_
- `is_enabled` — enabled (boolean) _(all)_

_call_:
- `switch_ventilator(is_enabled (boolean))` — switch ventilator on/off
- `set_ettube_diameter(ettube_diameter (number, mm))` — endotracheal tube diameter (mm)
- `set_ettube_length(ettube_length (number, mm))` — endotracheal tube length (mm)
- `set_fio2(fio2 (number, range 0.21–1))` — fio2
- `set_humidity(humidity (number, range 0–1))` — humidity
- `set_temp(temp (number, C, range 0–42))` — temperature (C)
- `trigger_breath()` — trigger a manual breath

---

## Common tasks — directional nudges

Curated relative adjustments ("raise PVR 30%", "halve contractility"). Each maps onto an EXISTING
`setProp` or `scale` op — there is no special nudge op. Two resolution rules:

- **setProp levers** (a `*_factor_ps` factor or a plain number): if the field's value is shown in the
  live monitor context, multiply by (1+step) to raise / 1/(1+step) to lower; otherwise set an ABSOLUTE
  target in DISPLAY units within the field's range. Values are display units (divided by the field
  factor on apply), like any setProp.
- **scale levers** (a ModelScaler group): `factor` is ABSOLUTE from baseline 1.0 (the current factor
  is NOT visible in state) — reason about prior nudges this conversation. Apply the SAME factor to
  every listed group; >1 raises, <1 lowers.
- **absolute setProp levers** (shunt sizes — PDA/foramen ovale/VSD): set an ABSOLUTE value in DISPLAY
  units within the stated range; 0 = closed/none. The engine treats diameter 0 as a hard-closed fast
  path, so open a closed shunt by setting a positive diameter (e.g. PDA 50 = ~half-open).

For inverse quantities (lung compliance ↔ elastance; preload ↔ unstressed volume) raising the
physiological quantity LOWERS the lever — noted per task.

### Vascular tone

- **Systemic vascular resistance (afterload)** — scale `systemic_resistances`, default ±30%. LV afterload. Up = vasoconstriction/pressor; down = vasodilation. (MAP is partly defended by the baroreflex — CO/HR shift too.)
  - e.g. `{"op":"scale","group":"systemic_resistances","factor":<absolute, 1.0=baseline>,"reason":"SVR nudge"}`
- **Pulmonary vascular resistance (RV afterload)** — scale `pulmonary_resistances`, default ±30%. Pulmonary hypertension (up) vs vasodilator / iNO (down).
  - e.g. `{"op":"scale","group":"pulmonary_resistances","factor":<absolute, 1.0=baseline>,"reason":"PVR nudge"}`
- **Venous tone / preload** — scale `systemic_u_vol`, default ±20%. _(inverse: raising the quantity lowers the lever)_ Up = more venous return/preload (lowers unstressed volume).
  - e.g. `{"op":"scale","group":"systemic_u_vol","factor":<absolute, 1.0=baseline>,"reason":"Preload nudge"}`

### Cardiac performance

- **Contractility (both ventricles)** — scale `heart_el_max`, default ±30%. Inotropy. Down 0.5 = halve contractility.
  - e.g. `{"op":"scale","group":"heart_el_max","factor":<absolute, 1.0=baseline>,"reason":"Contractility nudge"}`
- **Diastolic stiffness** — scale `heart_el_min`, default ±30%. Up = stiffer ventricle / diastolic dysfunction.
  - e.g. `{"op":"scale","group":"heart_el_min","factor":<absolute, 1.0=baseline>,"reason":"Diastolic stiffness nudge"}`

### Rate & rhythm

- **Heart rate (reference)** — setProp `Heart.heart_rate_ref`, default ±20%. Tachycardia (up) / bradycardia (down).
  - e.g. `{"op":"setProp","model":"Heart","target":"heart_rate_ref","value":<target in display units, or current×(1±20%) if shown>,"reason":"adjust Heart rate"}`

### Lung mechanics

- **Lung compliance** — scale `left_lung_elastances` + `right_lung_elastances`, default ±20%. _(inverse: raising the quantity lowers the lever)_ Down = stiffer lungs (RDS / hypoplasia); up = more compliant.
  - e.g. `{"op":"scale","group":"left_lung_elastances","factor":<absolute, 1.0=baseline>,"reason":"Lung compliance nudge"}`
- **Airway resistance** — scale `airway_lower_resistances`, default ±30%. Up = bronchospasm / obstruction.
  - e.g. `{"op":"scale","group":"airway_lower_resistances","factor":<absolute, 1.0=baseline>,"reason":"Airway resistance nudge"}`

### Gas exchange

- **O2 diffusion capacity** — setProp `dif_o2_factor_ps` on each `GasExchanger` instance, default ±30%. Down = impaired alveolar O2 transfer.
  - e.g. `{"op":"setProp","model":"<instance>","target":"dif_o2_factor_ps","value":<target in display units, or current×(1±30%) if shown>,"reason":"adjust O2 diffusion"}`

### Shunts & fetal channels

- **Ductus arteriosus (PDA) size** — setProp `Pda.diameter_relative`, step ±10 %, range 0–100. Relative patency 0 (closed) → 1 (fully open).
  - e.g. `{"op":"setProp","model":"Pda","target":"diameter_relative","value":<0–100 %; 0=closed/none>,"reason":"set PDA"}`
- **Foramen ovale size** — setProp `Shunts.diameter_fo`, step ±1 mm, range 0–10. Atrial-level shunt. 0 = closed.
  - e.g. `{"op":"setProp","model":"Shunts","target":"diameter_fo","value":<0–10 mm; 0=closed/none>,"reason":"set Foramen ovale"}`
- **Ventricular septal defect (VSD) size** — setProp `Shunts.diameter_vsd`, step ±1 mm, range 0–10. Ventricular-level shunt. 0 = none.
  - e.g. `{"op":"setProp","model":"Shunts","target":"diameter_vsd","value":<0–10 mm; 0=closed/none>,"reason":"set VSD"}`

### Ventilation drive

- **Ventilation drive (reference minute volume)** — setProp `Breathing.minute_volume_ref`, default ±20%. Up = hyperventilation (↓pCO2); down = hypoventilation (↑pCO2).
  - e.g. `{"op":"setProp","model":"Breathing","target":"minute_volume_ref","value":<target in display units, or current×(1±20%) if shown>,"reason":"adjust Ventilation drive"}`

### Metabolic & thermal

- **Metabolic demand (VO2)** — setProp `Metabolism.vo2`, default ±20%. Up = sepsis/hypermetabolism; down = hypothermia/sedation.
  - e.g. `{"op":"setProp","model":"Metabolism","target":"vo2","value":<target in display units, or current×(1±20%) if shown>,"reason":"adjust VO2"}`

### Blood & acid-base

- **Blood volume** — scale `blood_volume`, default ±10%. Down = hemorrhage; up = fluid overload.
  - e.g. `{"op":"scale","group":"blood_volume","factor":<absolute, 1.0=baseline>,"reason":"Blood volume nudge"}`

---

## Events & scheduling — `op:"event"`

Bundle several property changes into one **named event** the user can replay. Each entry
in `changes[]` is a `setProp`-style `{model, target, value}` with two optional timing
fields (simulated seconds, only advancing while the sim runs):

- `it` — ramp the numeric value to the target over N seconds (numbers only; booleans/lists swap instantly).
- `at` — delay the change N seconds before it starts.

Each change is validated against the same fields/bounds/units as a `setProp` (Full vs Guided
scope applies per change). Applying the card **saves the event into the Event Scheduler
panel** — it does not fire it; the user applies or arms it there. Optional `fire_at` (absolute
sim-clock auto-fire) is a panel feature; omit unless asked.

Envelope: `{"op":"event","name":"<name>","changes":[{"model","target","value","it"?,"at"?}, …],"fire_at":<s?>,"reason":"<label>"}`

Example — drive a tachycardia then drop spontaneous breathing 30 s later:
```json
{"op":"event","name":"induce tachy","changes":[{"model":"Heart","target":"heart_rate_ref","value":200,"it":15},{"model":"Breathing","target":"breathing_enabled","value":false,"at":30}],"reason":"ramp HR to 200 over 15s, apnea at +30s"}
```

---

## Diagram editing — `op:"diagram"`

Edit the diagram the user sees (compartments = sprites bound to engine models,
connectors = paths between them). Requires the **Diagram tab** to be open; each
turn's context lists the **Current diagram** (component ids + their model bindings),
and the **`Models in scenario:`** map gives the engine instance names you bind to.
Use existing component ids verbatim; give every new component a unique `name`.

Envelope: `{"op":"diagram","action":"<action>", ...fields, "reason":"<label>"}`

Actions:
- `addComponent` — fields: name (unique), models[] (engine instance names), picto, label?, pos?. add a compartment bound to engine model(s); pos is {type:'arc',dgs} or {type:'rel',x,y}
- `connect` — fields: from, to (existing component names), models?[], path?{type,width}. draw a connector between two existing components, optionally bound to a Resistor model
- `setLayout` — fields: name, patch (cosmetic layout keys only). restyle a component/connector: alpha, z_index, tinting, sprite color/scale/rotation/pos, label, path
- `setLabel` — fields: name, text. set a component's caption text
- `setModels` — fields: name, models[]. rebind which engine model(s) a component/connector represents
- `setPicto` — fields: name, picto. swap a compartment's sprite image
- `delete` — fields: name. remove a component (and its attached connectors) or a connector

- **picto** must be one of: container.png, vessel.png, lung.png, pump.png, blood.png, exchanger.png, oxygenator.png, gas_container.png, general.png, placenta.png, trachea.png
- **path.type** must be one of: straight, arc, arc_r, arc_flip, outer
- **setLayout patch** keys (cosmetic only): general.alpha, general.z_index, general.tinting, sprite.color, sprite.scale.x, sprite.scale.y, sprite.rotation, sprite.pos, label.size, label.color, label.pos_x, label.pos_y, path.type, path.width
- **pos**: `{"type":"arc","dgs":<0-360>}` to sit on the layout ring, or
  `{"type":"rel","x":<-1..1>,"y":<-1..1>}` relative to centre.

Example — add a kidney compartment and connect it to the aorta:
```json
{"op":"diagram","action":"addComponent","name":"Kidney","models":["Kidneys"],"picto":"general.png","label":"Kidney","pos":{"type":"arc","dgs":210},"reason":"add kidney"}
{"op":"diagram","action":"connect","from":"AA","to":"Kidney","models":["AA_Kidney"],"path":{"type":"arc"},"reason":"renal artery"}
```
