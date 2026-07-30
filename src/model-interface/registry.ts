// AUTO-RELOCATED from the engine model classes' former `static model_interface`
// arrays (verbatim, inheritance resolved). Keyed by model_type. UI presentation
// metadata lives here, not in the physics engine. To regenerate after a model
// gains/changes a tunable parameter, dump each class's effective interface from
// explain-engine/ModelIndex.js and replace MODEL_INTERFACES below. A regeneration
// must keep the custom-registry import and the merge in getInterfaceForType at the
// bottom of this file — that is the extension point custom models rely on.

import type { InterfaceField } from "./types";
import { CUSTOM_MODEL_INTERFACES } from "./custom-registry";

export const MODEL_INTERFACES: Record<string, InterfaceField[]> = {
  "Drugs": [
    {
      "target": "description",
      "type": "string",
      "caption": "description",
      "build_prop": true,
      "edit_mode": "all",
      "readonly": true
    },
    {
      "target": "is_enabled",
      "type": "boolean",
      "caption": "enabled",
      "build_prop": true,
      "edit_mode": "all",
      "readonly": false
    },
    {
      "target": "drugs_running",
      "type": "boolean",
      "caption": "drugs running",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false
    },
    {
      "target": "administer_bolus",
      "type": "function",
      "caption": "administer IV bolus",
      "build_prop": false,
      "edit_mode": "basic",
      "readonly": false,
      "args": [
        {
          "target": "drug",
          "caption": "drug",
          "type": "list",
          "custom_options": true,
          "choices": ["adrenaline", "noradrenaline", "pge1"]
        },
        {
          "target": "dose",
          "caption": "dose (mcg)",
          "type": "number",
          "factor": 1,
          "default": 1,
          "delta": 0.5,
          "rounding": 2,
          "ll": 0,
          "ul": 1000
        }
      ]
    },
    {
      "target": "set_infusion",
      "type": "function",
      "caption": "set infusion",
      "build_prop": false,
      "edit_mode": "basic",
      "readonly": false,
      "args": [
        {
          "target": "drug",
          "caption": "drug",
          "type": "list",
          "custom_options": true,
          "choices": ["adrenaline", "noradrenaline", "pge1"]
        },
        {
          "target": "rate",
          "caption": "rate (mcg/kg/min)",
          "type": "number",
          "factor": 1,
          "default": 0,
          "delta": 0.05,
          "rounding": 3,
          "ll": 0,
          "ul": 100
        }
      ]
    },
    {
      "target": "injection_site",
      "type": "string",
      "caption": "injection site (IV)",
      "build_prop": true,
      "edit_mode": "extra",
      "readonly": true
    },
    {
      "target": "effect_site",
      "type": "string",
      "caption": "effect site",
      "build_prop": true,
      "edit_mode": "extra",
      "readonly": true
    },
    {
      "target": "conc_eff",
      "type": "number",
      "caption": "adrenaline effect-site conc (ng/mL)",
      "factor": 1,
      "rounding": 3,
      "edit_mode": "extra",
      "readonly": true
    },
    {
      "target": "hr_drug_factor",
      "type": "number",
      "caption": "applied HR factor",
      "factor": 1,
      "rounding": 3,
      "edit_mode": "extra",
      "readonly": true
    },
    {
      "target": "cont_drug_factor",
      "type": "number",
      "caption": "applied contractility factor",
      "factor": 1,
      "rounding": 3,
      "edit_mode": "extra",
      "readonly": true
    },
    {
      "target": "lus_drug_factor",
      "type": "number",
      "caption": "applied lusitropy factor (<1 = better relaxation)",
      "factor": 1,
      "rounding": 3,
      "edit_mode": "extra",
      "readonly": true
    },
    {
      "target": "svr_drug_factor",
      "type": "number",
      "caption": "applied SVR factor",
      "factor": 1,
      "rounding": 3,
      "edit_mode": "extra",
      "readonly": true
    },
    {
      "target": "pda_drug_factor",
      "type": "number",
      "caption": "applied ductal patency factor (PGE1)",
      "factor": 1,
      "rounding": 3,
      "edit_mode": "extra",
      "readonly": true
    },
    {
      "target": "set_drug_param",
      "type": "function",
      "caption": "set PK/PD parameter",
      "build_prop": false,
      "edit_mode": "advanced",
      "readonly": false,
      "args": [
        {
          "target": "drug",
          "caption": "drug",
          "type": "list",
          "custom_options": true,
          "choices": ["adrenaline", "noradrenaline", "pge1"]
        },
        {
          "target": "param",
          "caption": "parameter",
          "type": "list",
          "custom_options": true,
          "choices": [
            "ke0",
            "clearance.global",
            "hr_ec50", "hr_emax", "hr_hill",
            "cont_ec50", "cont_emax", "cont_hill",
            "svr_ec50", "svr_emax", "svr_hill",
            "pda_ec50", "pda_emax", "pda_hill"
          ]
        },
        {
          "target": "value",
          "caption": "value",
          "type": "number",
          "factor": 1,
          "default": 0,
          "delta": 0.01,
          "rounding": 4,
          "ll": 0,
          "ul": 1000
        }
      ]
    }
  ],
  "Ans": [
    {
      "target": "description",
      "type": "string",
      "caption": "description",
      "build_prop": true,
      "edit_mode": "caption",
      "readonly": true
    },
    {
      "target": "is_enabled",
      "type": "boolean",
      "caption": "enabled",
      "build_prop": true,
      "edit_mode": "all",
      "readonly": false
    },
    {
      "target": "ans_active",
      "type": "boolean",
      "caption": "ANS active",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false
    },
    {
      "target": "BR_MAP",
      "type": "reference",
      "caption": "Baroreceptor",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false
    },
    {
      "target": "CR_PCO2",
      "type": "reference",
      "caption": "Chemoreceptor pCO2",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false
    }
  ],
  "AnsAfferent": [
    {
      "target": "description",
      "type": "string",
      "build_prop": true,
      "edit_mode": "caption",
      "readonly": true,
      "caption": "description"
    },
    {
      "target": "is_enabled",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "all",
      "readonly": false,
      "caption": "enabled"
    },
    {
      "target": "input_prop",
      "target_prop": "input_prop",
      "target_model": "input_model",
      "type": "prop-list",
      "build_prop": true,
      "readonly": false,
      "edit_mode": "extra",
      "caption": "input model property",
      "caption_model": "input model",
      "caption_prop": "input property",
      "options": []
    },
    {
      "target": "min_value",
      "type": "number",
      "build_prop": true,
      "readonly": false,
      "edit_mode": "basic",
      "caption": "minimum of the input (firing rate is 0.0)",
      "delta": 0.1,
      "factor": 1,
      "rounding": 3
    },
    {
      "caption": "maximum of the input (firing rate is 1.0)",
      "target": "max_value",
      "type": "number",
      "edit_mode": "basic",
      "build_prop": true,
      "readonly": false,
      "delta": 0.1,
      "factor": 1,
      "rounding": 3
    },
    {
      "caption": "setpoint of the input (firing rate is 0.5)",
      "target": "set_value",
      "type": "number",
      "edit_mode": "basic",
      "build_prop": true,
      "readonly": false,
      "delta": 0.1,
      "factor": 1,
      "rounding": 3
    },
    {
      "caption": "timeconstant (s)",
      "target": "tc",
      "type": "number",
      "edit_mode": "basic",
      "build_prop": true,
      "readonly": false,
      "delta": 0.1,
      "factor": 1,
      "rounding": 1
    },
    {
      "caption": "efferents",
      "target": "efferents",
      "type": "multiple-list",
      "edit_mode": "extra",
      "build_prop": true,
      "readonly": false,
      "options": [
        "AnsEfferent"
      ]
    },
    {
      "caption": "effect weight",
      "target": "effect_weight",
      "type": "number",
      "edit_mode": "extra",
      "build_prop": true,
      "readonly": false,
      "delta": 0.1,
      "factor": 1,
      "rounding": 3
    }
  ],
  "AnsEfferent": [
    {
      "target": "description",
      "type": "string",
      "build_prop": true,
      "edit_mode": "caption",
      "readonly": true,
      "caption": "description"
    },
    {
      "target": "is_enabled",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "all",
      "readonly": false,
      "caption": "enabled"
    },
    {
      "target": "target_prop",
      "target_model": "target_model",
      "target_prop": "target_prop",
      "type": "prop-list",
      "edit_mode": "extra",
      "build_prop": true,
      "readonly": false,
      "caption": "target model property",
      "caption_model": "target model",
      "caption_prop": "target property",
      "options": []
    },
    {
      "caption": "effect size at max firing_rate of 1",
      "target": "effect_at_max_firing_rate",
      "type": "number",
      "edit_mode": "basic",
      "build_prop": true,
      "readonly": false,
      "factor": 1,
      "delta": 0.1,
      "rounding": 1
    },
    {
      "caption": "effect size at min firing_rate of 0",
      "target": "effect_at_min_firing_rate",
      "type": "number",
      "edit_mode": "basic",
      "build_prop": true,
      "readonly": false,
      "factor": 1,
      "delta": 0.1,
      "rounding": 1
    },
    {
      "caption": "timeconstant (s)",
      "target": "tc",
      "type": "number",
      "edit_mode": "basic",
      "build_prop": true,
      "readonly": false,
      "factor": 1,
      "delta": 0.1,
      "rounding": 1
    }
  ],
  "Blood": [
    {
      "target": "description",
      "type": "string",
      "build_prop": true,
      "edit_mode": "caption",
      "readonly": true,
      "caption": "description"
    },
    {
      "target": "is_enabled",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "all",
      "readonly": false,
      "caption": "enabled"
    },
    {
      "caption": "set temperature (C)",
      "edit_mode": "basic",
      "target": "set_temperature",
      "type": "function",
      "args": [
        {
          "caption": "new temperature",
          "target": "temp",
          "type": "number",
          "factor": 1,
          "delta": 0.1,
          "rounding": 1,
          "ul": 45,
          "ll": 25
        },
        {
          "target": "site",
          "caption": "change in site",
          "type": "list",
          "options": [
            "BloodCapacitance",
            "BloodTimeVaryingElastance",
            "BloodVessel",
            "HeartChamber",
            "MicroVascularUnit",
            "BloodPump"
          ]
        }
      ]
    },
    {
      "caption": "set viscosity (cP)",
      "edit_mode": "basic",
      "target": "set_viscosity",
      "type": "function",
      "args": [
        {
          "caption": "new new viscosity",
          "target": "viscosity",
          "type": "number",
          "factor": 1,
          "delta": 0.1,
          "rounding": 1,
          "ul": 12,
          "ll": 0.1
        }
      ]
    },
    {
      "caption": "set Haldane coefficient",
      "edit_mode": "advanced",
      "target": "set_haldane_coeff",
      "type": "function",
      "args": [
        {
          "caption": "Haldane coefficient (0 = off)",
          "target": "new_coeff",
          "type": "number",
          "factor": 1,
          "delta": 0.05,
          "rounding": 2,
          "ul": 5,
          "ll": 0
        }
      ]
    },
    {
      "caption": "set P50 (Hb-O2 affinity)",
      "edit_mode": "advanced",
      "target": "set_P50",
      "type": "function",
      "args": [
        {
          "caption": "P50 mmHg (fetal HbF 18.8, neonatal 20.0, adult 26.7)",
          "target": "new_p50",
          "type": "number",
          "factor": 1,
          "delta": 0.1,
          "rounding": 1,
          "ul": 30,
          "ll": 15
        }
      ]
    },
    {
      "caption": "set total oxygen concentration (mmol/l)",
      "target": "set_to2",
      "edit_mode": "basic",
      "type": "function",
      "args": [
        {
          "caption": "new total oxygen concentration",
          "target": "to2",
          "type": "number",
          "factor": 1,
          "delta": 0.1,
          "rounding": 1,
          "ul": 20,
          "ll": 0
        },
        {
          "target": "site",
          "caption": "change in site",
          "type": "list",
          "options": [
            "BloodCapacitance",
            "BloodTimeVaryingElastance",
            "BloodVessel",
            "HeartChamber",
            "MicroVascularUnit",
            "BloodPump"
          ]
        }
      ]
    },
    {
      "caption": "set total carbon dioxide concentration (mmol/l)",
      "target": "set_tco2",
      "edit_mode": "basic",
      "type": "function",
      "args": [
        {
          "caption": "new total carbon dioxide concentration",
          "target": "tco2",
          "type": "number",
          "factor": 1,
          "delta": 0.1,
          "rounding": 1,
          "ul": 20,
          "ll": 0
        },
        {
          "target": "site",
          "caption": "change in site",
          "type": "list",
          "options": [
            "BloodCapacitance",
            "BloodTimeVaryingElastance",
            "BloodVessel",
            "HeartChamber",
            "MicroVascularUnit",
            "BloodPump"
          ]
        }
      ]
    },
    {
      "caption": "set solute concentration",
      "target": "set_solute",
      "edit_mode": "basic",
      "type": "function",
      "args": [
        {
          "target": "solute_name",
          "caption": "solute name",
          "type": "list",
          "custom_options": true,
          "choices": [
            "na",
            "k",
            "ca",
            "cl",
            "lact",
            "mg",
            "albumin",
            "phosphates",
            "uma",
            "hemoglobin"
          ]
        },
        {
          "target": "solute_value",
          "caption": "solute value",
          "type": "number",
          "default": 0,
          "factor": 1,
          "delta": 1,
          "rounding": 0,
          "ul": 1000,
          "ll": 0
        },
        {
          "target": "site",
          "caption": "change in site",
          "type": "list",
          "options": [
            "BloodCapacitance",
            "BloodTimeVaryingElastance",
            "BloodVessel",
            "HeartChamber",
            "MicroVascularUnit",
            "BloodPump"
          ]
        }
      ]
    }
  ],
  "BloodCapacitance": [
    {
      "target": "model_type",
      "type": "string",
      "build_prop": false,
      "edit_mode": "basic",
      "readonly": true,
      "caption": "model type"
    },
    {
      "target": "description",
      "type": "string",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": true,
      "caption": "description"
    },
    {
      "target": "is_enabled",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "caption": "enabled"
    },
    {
      "edit_mode": "basic",
      "caption": "fixed composition",
      "target": "fixed_composition",
      "type": "boolean",
      "build_prop": true
    },
    {
      "edit_mode": "basic",
      "caption": "volume (L)",
      "target": "vol",
      "type": "number",
      "factor": 1,
      "delta": 0.001,
      "rounding": 3,
      "build_prop": true
    },
    {
      "edit_mode": "basic",
      "caption": "unstressed volume (L)",
      "target": "u_vol",
      "type": "number",
      "factor": 1,
      "delta": 0.0001,
      "rounding": 4,
      "build_prop": true
    },
    {
      "edit_mode": "basic",
      "caption": "elastance baseline (mmHg/L)",
      "target": "el_base",
      "type": "number",
      "factor": 1,
      "delta": 1,
      "rounding": 0,
      "build_prop": true
    },
    {
      "edit_mode": "basic",
      "caption": "elastance non linear k",
      "target": "el_k",
      "type": "number",
      "factor": 1,
      "delta": 1,
      "rounding": 0,
      "build_prop": true
    },
    {
      "edit_mode": "extra",
      "caption": "blood temperature (°C)",
      "target": "temp",
      "type": "number",
      "factor": 1,
      "delta": 0.1,
      "rounding": 1,
      "build_prop": true
    },
    {
      "edit_mode": "extra",
      "caption": "blood viscosity (cP)",
      "target": "viscosity",
      "type": "number",
      "factor": 1,
      "delta": 0.1,
      "rounding": 2,
      "build_prop": true
    },
    {
      "edit_mode": "factors",
      "caption": "unstressed volume factor",
      "target": "u_vol_factor_ps",
      "type": "factor",
      "build_prop": false
    },
    {
      "edit_mode": "factors",
      "caption": "elastance baseline factor",
      "target": "el_base_factor_ps",
      "type": "factor",
      "build_prop": false
    },
    {
      "edit_mode": "factors",
      "caption": "elastance non linear factor",
      "target": "el_k_factor_ps",
      "type": "factor",
      "build_prop": false
    }
  ],
  "BloodDiffusor": [
    {
      "target": "model_type",
      "type": "string",
      "build_prop": false,
      "edit_mode": "basic",
      "readonly": true,
      "caption": "model type"
    },
    {
      "target": "description",
      "type": "string",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": true,
      "caption": "description"
    },
    {
      "target": "is_enabled",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "caption": "enabled"
    },
    {
      "target": "dif_o2",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "caption": "oxygen diffusion constant",
      "factor": 1,
      "delta": 0.0001,
      "rounding": 4
    },
    {
      "target": "dif_co2",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "caption": "carbon dioxide diffusion constant",
      "factor": 1,
      "delta": 0.0001,
      "rounding": 4
    },
    {
      "target": "dif_solutes",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "caption": "solute diffusion constant",
      "factor": 1,
      "delta": 0.0001,
      "rounding": 4
    },
    {
      "target": "comp_blood1",
      "type": "list",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "caption": "blood component 1",
      "options": [
        "BloodCapacitance",
        "BloodTimeVaryingElastance",
        "BloodPump",
        "BloodVessel",
        "MicroVascularUnit",
        "HeartChamber"
      ]
    },
    {
      "target": "comp_blood2",
      "type": "list",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "caption": "blood component 2",
      "options": [
        "BloodCapacitance",
        "BloodTimeVaryingElastance",
        "BloodPump",
        "BloodVessel",
        "MicroVascularUnit",
        "HeartChamber"
      ]
    },
    {
      "target": "dif_o2_factor_ps",
      "type": "factor",
      "build_prop": false,
      "edit_mode": "basic",
      "readonly": false,
      "caption": "oxygen diffusion factor"
    },
    {
      "caption": "carbon dioxide diffusion factor",
      "target": "dif_co2_factor_ps",
      "type": "factor",
      "build_prop": false,
      "edit_mode": "basic",
      "readonly": false
    },
    {
      "caption": "solute diffusion factor",
      "target": "dif_solutes_factor_ps",
      "type": "factor",
      "build_prop": false,
      "edit_mode": "basic",
      "readonly": false
    }
  ],
  "BloodPump": [
    {
      "target": "model_type",
      "type": "string",
      "build_prop": false,
      "edit_mode": "basic",
      "readonly": true,
      "caption": "model type"
    },
    {
      "target": "description",
      "type": "string",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": true,
      "caption": "description"
    },
    {
      "target": "is_enabled",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "caption": "enabled"
    },
    {
      "caption": "unstressed volume (L)",
      "target": "u_vol",
      "type": "number",
      "factor": 1,
      "delta": 0.001,
      "rounding": 3
    },
    {
      "caption": "elastance pump (mmHg/L)",
      "target": "el_base",
      "factor": 1,
      "delta": 1,
      "rounding": 0,
      "type": "number"
    },
    {
      "caption": "pump rpm",
      "target": "pump_rpm",
      "delta": 10,
      "factor": 1,
      "rounding": 1,
      "type": "number"
    },
    {
      "caption": "non linear elastance factor",
      "target": "el_k",
      "delta": 0.1,
      "factor": 0.001,
      "rounding": 3,
      "type": "number"
    },
    {
      "caption": "inlet blood resistor",
      "target": "inlet",
      "type": "list",
      "options": [
        "BloodResistor",
        "BloodVesselResistor",
        "HeartValve"
      ]
    },
    {
      "caption": "outlet blood resistor",
      "target": "outlet",
      "type": "list",
      "options": [
        "BloodResistor",
        "BloodVesselResistor",
        "HeartValve"
      ]
    }
  ],
  "BloodTimeVaryingElastance": [
    {
      "target": "model_type",
      "type": "string",
      "build_prop": false,
      "edit_mode": "basic",
      "readonly": true,
      "caption": "model type"
    },
    {
      "target": "description",
      "type": "string",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": true,
      "caption": "description"
    },
    {
      "target": "is_enabled",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "caption": "enabled"
    },
    {
      "caption": "volume (L)",
      "target": "vol",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "factor": 1,
      "delta": 0.001,
      "rounding": 3
    },
    {
      "caption": "unstressed volume (L)",
      "target": "u_vol",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "factor": 1,
      "delta": 0.001,
      "rounding": 3
    },
    {
      "caption": "elastance minimum (mmHg/L)",
      "target": "el_min",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "factor": 1,
      "delta": 1,
      "rounding": 0
    },
    {
      "caption": "elastance maximum (mmHg/L)",
      "target": "el_max",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "factor": 1,
      "delta": 1,
      "rounding": 0
    },
    {
      "caption": "elastance non linear k",
      "target": "el_k",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "factor": 1,
      "delta": 1,
      "rounding": 0
    },
    {
      "caption": "unstressed volume factor",
      "target": "u_vol_factor_ps",
      "type": "factor"
    },
    {
      "caption": "elastance minimum baseline factor",
      "target": "el_min_factor_ps",
      "type": "factor"
    },
    {
      "caption": "elastance maximum baseline factor",
      "target": "el_max_factor_ps",
      "type": "factor"
    },
    {
      "caption": "elastance non linear factor",
      "target": "el_k_factor_ps",
      "type": "factor"
    }
  ],
  "BloodVessel": [
    {
      "target": "model_type",
      "type": "string",
      "build_prop": false,
      "edit_mode": "basic",
      "readonly": true,
      "caption": "model type"
    },
    {
      "target": "description",
      "type": "string",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": true,
      "caption": "description"
    },
    {
      "target": "is_enabled",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "caption": "enabled"
    },
    {
      "edit_mode": "basic",
      "caption": "no flow allowed",
      "target": "no_flow",
      "type": "boolean",
      "build_prop": true
    },
    {
      "edit_mode": "basic",
      "caption": "no back flow allowed",
      "target": "no_back_flow",
      "type": "boolean",
      "build_prop": true
    },
    {
      "edit_mode": "basic",
      "caption": "volume (L)",
      "target": "vol",
      "type": "number",
      "factor": 1,
      "delta": 0.001,
      "rounding": 3,
      "build_prop": true
    },
    {
      "edit_mode": "basic",
      "caption": "unstressed volume (L)",
      "target": "u_vol",
      "type": "number",
      "factor": 1,
      "delta": 0.0001,
      "rounding": 4,
      "build_prop": true
    },
    {
      "edit_mode": "basic",
      "caption": "elastance baseline (mmHg/L)",
      "target": "el_base",
      "type": "number",
      "factor": 1,
      "delta": 1,
      "rounding": 0,
      "build_prop": true
    },
    {
      "edit_mode": "basic",
      "caption": "elastance non linear k",
      "target": "el_k",
      "type": "number",
      "factor": 1,
      "delta": 1,
      "rounding": 0,
      "build_prop": true
    },
    {
      "edit_mode": "advanced",
      "build_prop": true,
      "caption": "inputs",
      "target": "inputs",
      "type": "multiple-list",
      "options": [
        "BloodVessel",
        "BloodTimeVaryingElastance",
        "BloodCapacitance",
        "BloodPump"
      ]
    },
    {
      "edit_mode": "basic",
      "caption": "r_for (mmHg/L/s)",
      "target": "r_for",
      "type": "number",
      "factor": 1,
      "delta": 0.001,
      "rounding": 3,
      "build_prop": true
    },
    {
      "edit_mode": "basic",
      "caption": "r_back (mmHg/L/s)",
      "target": "r_back",
      "type": "number",
      "factor": 1,
      "delta": 0.001,
      "rounding": 3,
      "build_prop": true
    },
    {
      "edit_mode": "advanced",
      "caption": "resistance-elastance coupling (0-1)",
      "target": "alpha",
      "type": "number",
      "factor": 1,
      "delta": 0.01,
      "rounding": 2,
      "build_prop": true
    },
    {
      "edit_mode": "advanced",
      "caption": "ans sensitivity (0-1)",
      "target": "ans_sens",
      "type": "number",
      "factor": 1,
      "delta": 0.01,
      "rounding": 2,
      "build_prop": true
    },
    {
      "edit_mode": "factors",
      "caption": "resistance factor",
      "target": "r_factor_ps",
      "type": "number",
      "factor": 1,
      "delta": 0.01,
      "rounding": 2,
      "build_prop": false
    },
    {
      "edit_mode": "factors",
      "caption": "unstressed volume factor",
      "target": "u_vol_factor_ps",
      "type": "factor",
      "build_prop": false
    },
    {
      "edit_mode": "factors",
      "caption": "elastance baseline factor",
      "target": "el_base_factor_ps",
      "type": "factor",
      "build_prop": false
    },
    {
      "edit_mode": "factors",
      "caption": "elastance non linear factor",
      "target": "el_k_factor_ps",
      "type": "factor",
      "build_prop": false
    }
  ],
  "Breathing": [
    {
      "target": "description",
      "type": "string",
      "edit_mode": "caption",
      "build_prop": true,
      "readonly": true,
      "caption": "description"
    },
    {
      "target": "is_enabled",
      "type": "boolean",
      "edit_mode": "all",
      "build_prop": true,
      "readonly": false,
      "caption": "enabled"
    },
    {
      "caption": "spont breathing enabled",
      "target": "breathing_enabled",
      "type": "boolean",
      "edit_mode": "basic",
      "build_prop": true,
      "readonly": false
    },
    {
      "caption": "reference minute volume (L/kg/min)",
      "target": "minute_volume_ref",
      "type": "number",
      "delta": 0.01,
      "factor": 1,
      "rounding": 2,
      "edit_mode": "basic",
      "build_prop": true,
      "readonly": false
    },
    {
      "caption": "tidal volume - resp rate ratio",
      "target": "vt_rr_ratio",
      "type": "number",
      "delta": 0.001,
      "factor": 1000,
      "rounding": 4,
      "edit_mode": "basic",
      "build_prop": true,
      "readonly": false
    },
    {
      "caption": "insp/exp ratio",
      "target": "ie_ratio",
      "type": "number",
      "delta": 0.01,
      "factor": 1,
      "rounding": 2,
      "edit_mode": "basic",
      "build_prop": true,
      "readonly": false
    },
    {
      "caption": "rmp gain max",
      "target": "rmp_gain_max",
      "type": "number",
      "delta": 1,
      "factor": 1,
      "rounding": 0,
      "edit_mode": "extra",
      "build_prop": true,
      "readonly": false
    }
  ],
  "Capacitance": [
    {
      "target": "model_type",
      "type": "string",
      "build_prop": false,
      "edit_mode": "basic",
      "readonly": true,
      "caption": "model type"
    },
    {
      "target": "description",
      "type": "string",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": true,
      "caption": "description"
    },
    {
      "target": "is_enabled",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "caption": "enabled"
    },
    {
      "target": "fixed_composition",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "caption": "fixed composition"
    },
    {
      "target": "u_vol",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "caption": "unstressed volume (L)",
      "factor": 1,
      "delta": 0.001,
      "rounding": 3
    },
    {
      "target": "el_base",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "caption": "elastance baseline (mmHg/L)",
      "factor": 1,
      "delta": 1,
      "rounding": 0
    },
    {
      "target": "el_k",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "caption": "elastance non linear k",
      "factor": 1,
      "delta": 1,
      "rounding": 0
    },
    {
      "target": "u_vol_factor_ps",
      "type": "factor",
      "edit_mode": "factors",
      "caption": "unstressed volume factor"
    },
    {
      "target": "el_base_factor_ps",
      "type": "factor",
      "edit_mode": "factors",
      "caption": "elastance baseline factor"
    },
    {
      "target": "el_k_factor_ps",
      "type": "factor",
      "edit_mode": "factors",
      "caption": "elastance non linear  factor"
    }
  ],
  "Circulation": [
    {
      "target": "description",
      "type": "string",
      "build_prop": true,
      "edit_mode": "caption",
      "readonly": true,
      "caption": "description"
    },
    {
      "target": "is_enabled",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "all",
      "readonly": false,
      "caption": "enabled"
    },
    {
      "caption": "heart chambers",
      "target": "heart_chambers",
      "type": "multiple-list",
      "edit_mode": "extra",
      "build_prop": true,
      "readonly": false,
      "options": [
        "HeartChamber",
        "BloodTimeVaryingElastance"
      ]
    },
    {
      "caption": "systemic arteries",
      "target": "systemic_arteries",
      "type": "multiple-list",
      "edit_mode": "extra",
      "build_prop": true,
      "readonly": false,
      "options": [
        "BloodVessel"
      ]
    },
    {
      "caption": "systemic arterioles",
      "target": "systemic_arterioles",
      "type": "multiple-list",
      "edit_mode": "extra",
      "build_prop": true,
      "readonly": false,
      "options": [
        "BloodVessel"
      ]
    },
    {
      "caption": "systemic capillaries",
      "target": "systemic_capillaries",
      "type": "multiple-list",
      "edit_mode": "extra",
      "build_prop": true,
      "readonly": false,
      "options": [
        "BloodVessel"
      ]
    },
    {
      "caption": "systemic venules",
      "target": "systemic_venules",
      "type": "multiple-list",
      "edit_mode": "extra",
      "build_prop": true,
      "readonly": false,
      "options": [
        "BloodVessel"
      ]
    },
    {
      "caption": "systemic veins",
      "target": "systemic_veins",
      "type": "multiple-list",
      "edit_mode": "extra",
      "build_prop": true,
      "readonly": false,
      "options": [
        "BloodVessel"
      ]
    },
    {
      "caption": "pulmonary arteries",
      "target": "pulmonary_arteries",
      "type": "multiple-list",
      "edit_mode": "extra",
      "build_prop": true,
      "readonly": false,
      "options": [
        "BloodVessel"
      ]
    },
    {
      "caption": "pulmonary arterioles",
      "target": "pulmonary_arterioles",
      "type": "multiple-list",
      "edit_mode": "extra",
      "build_prop": true,
      "readonly": false,
      "options": [
        "BloodVessel"
      ]
    },
    {
      "caption": "pulmonary capillaries",
      "target": "pulmonary_capillaries",
      "type": "multiple-list",
      "edit_mode": "extra",
      "build_prop": true,
      "readonly": false,
      "options": [
        "BloodVessel"
      ]
    },
    {
      "caption": "pulmonary venules",
      "target": "pulmonary_venules",
      "type": "multiple-list",
      "edit_mode": "extra",
      "build_prop": true,
      "readonly": false,
      "options": [
        "BloodVessel"
      ]
    },
    {
      "caption": "pulmonary veins",
      "target": "pulmonary_veins",
      "type": "multiple-list",
      "edit_mode": "extra",
      "build_prop": true,
      "readonly": false,
      "options": [
        "BloodVessel"
      ]
    },
    {
      "caption": "svr factor (arterioles)",
      "target": "svr_factor_art",
      "type": "factor",
      "delta": 0.1,
      "rounding": 1,
      "ll": -10,
      "ul": 10
    },
    {
      "caption": "svr factor (venules)",
      "target": "svr_factor_ven",
      "type": "factor",
      "delta": 0.1,
      "rounding": 1,
      "ll": -10,
      "ul": 10
    },
    {
      "caption": "pvr factor (arterioles)",
      "target": "pvr_factor_art",
      "type": "factor",
      "delta": 0.1,
      "rounding": 1,
      "ll": -10,
      "ul": 10
    },
    {
      "caption": "pvr factor (venules)",
      "target": "pvr_factor_ven",
      "type": "factor",
      "delta": 0.1,
      "rounding": 1,
      "ll": -10,
      "ul": 10
    }
  ],
  "Container": [
    {
      "target": "model_type",
      "type": "string",
      "build_prop": false,
      "edit_mode": "basic",
      "readonly": true,
      "caption": "model type"
    },
    {
      "target": "description",
      "type": "string",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": true,
      "caption": "description"
    },
    {
      "target": "is_enabled",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "caption": "enabled"
    },
    {
      "caption": "unstressed volume (L)",
      "target": "u_vol",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "factor": 1,
      "delta": 0.001,
      "rounding": 3
    },
    {
      "caption": "elastance baseline (mmHg/L)",
      "target": "el_base",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "factor": 1,
      "delta": 1,
      "rounding": 0
    },
    {
      "caption": "elastance non linear k",
      "target": "el_k",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "factor": 1,
      "delta": 1,
      "rounding": 0
    },
    {
      "caption": "unstressed volume factor",
      "target": "u_vol_factor_ps",
      "type": "factor"
    },
    {
      "caption": "elastance baseline factor",
      "target": "el_base_factor_ps",
      "type": "factor"
    },
    {
      "caption": "elastance non linear  factor",
      "target": "el_k_factor_ps",
      "type": "factor"
    },
    {
      "caption": "contained compartments",
      "target": "contained_components",
      "build_prop": true,
      "edit_mode": "basic",
      "type": "multiple-list",
      "options": [
        "BloodCapacitance",
        "BloodTimeVaryingElastance",
        "BloodPump",
        "BloodVessel",
        "HeartChamber",
        "GasCapacitance"
      ]
    }
  ],
  "Ecls": [
    {
      "target": "description",
      "type": "string",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": true,
      "caption": "description"
    },
    {
      "target": "is_enabled",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "caption": "enabled"
    },
    {
      "target": "ecls_running",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "basic",
      "caption": "ECLS running"
    },
    {
      "target": "ecls_clamped",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "basic",
      "caption": "ECLS clamped"
    },
    {
      "caption": "pump mode (0 = centrifugal, 1 = roller)",
      "target": "pump_mode",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "factor": 1,
      "delta": 1,
      "rounding": 0,
      "ll": 0,
      "ul": 1
    },
    {
      "caption": "pump speed (rpm)",
      "target": "pump_rpm",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "factor": 1,
      "delta": 50,
      "rounding": 0,
      "ll": 0,
      "ul": 5000
    },
    {
      "caption": "sweep gas flow (L/min)",
      "target": "gas_flow",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "factor": 1,
      "delta": 0.1,
      "rounding": 1,
      "ll": 0,
      "ul": 10
    },
    {
      "caption": "sweep gas fio2 (fraction)",
      "target": "gas_fio2",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "factor": 1,
      "delta": 0.01,
      "rounding": 2,
      "ll": 0.21,
      "ul": 1
    },
    {
      "caption": "sweep gas fico2 (fraction)",
      "target": "gas_fico2",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "factor": 1,
      "delta": 0.001,
      "rounding": 4,
      "ll": 0,
      "ul": 0.1
    },
    {
      "type": "list",
      "caption": "drainage site",
      "target": "drainage_site",
      "build_prop": true,
      "edit_mode": "basic",
      "options": [
        "BloodCapacitance",
        "BloodTimeVaryingElastance",
        "BloodVessel",
        "HeartChamber"
      ]
    },
    {
      "type": "list",
      "caption": "return site",
      "target": "return_site",
      "build_prop": true,
      "edit_mode": "basic",
      "options": [
        "BloodCapacitance",
        "BloodTimeVaryingElastance",
        "BloodVessel",
        "HeartChamber"
      ]
    },
    {
      "caption": "sweep gas humidity (fraction)",
      "target": "gas_humidity",
      "type": "number",
      "build_prop": true,
      "edit_mode": "extra",
      "factor": 1,
      "delta": 0.05,
      "rounding": 2,
      "ll": 0,
      "ul": 1
    },
    {
      "caption": "sweep gas temperature (°C)",
      "target": "gas_temp",
      "type": "number",
      "build_prop": true,
      "edit_mode": "extra",
      "factor": 1,
      "delta": 0.5,
      "rounding": 1,
      "ll": 0,
      "ul": 42
    },
    {
      "caption": "o2 diffusion constant",
      "target": "dif_o2",
      "type": "number",
      "build_prop": true,
      "edit_mode": "extra",
      "factor": 1,
      "delta": 0.0001,
      "rounding": 4,
      "ll": 0,
      "ul": 0.1
    },
    {
      "caption": "co2 diffusion constant",
      "target": "dif_co2",
      "type": "number",
      "build_prop": true,
      "edit_mode": "extra",
      "factor": 1,
      "delta": 0.0001,
      "rounding": 4,
      "ll": 0,
      "ul": 0.1
    },
    {
      "caption": "tubing in diameter (m)",
      "target": "tubing_in_diameter",
      "type": "number",
      "build_prop": true,
      "edit_mode": "extra",
      "factor": 1,
      "delta": 0.0005,
      "rounding": 5,
      "ll": 0,
      "ul": 0.05
    },
    {
      "caption": "tubing in length (m)",
      "target": "tubing_in_length",
      "type": "number",
      "build_prop": true,
      "edit_mode": "extra",
      "factor": 1,
      "delta": 0.05,
      "rounding": 3,
      "ll": 0,
      "ul": 5
    },
    {
      "caption": "tubing out diameter (m)",
      "target": "tubing_out_diameter",
      "type": "number",
      "build_prop": true,
      "edit_mode": "extra",
      "factor": 1,
      "delta": 0.0005,
      "rounding": 5,
      "ll": 0,
      "ul": 0.05
    },
    {
      "caption": "tubing out length (m)",
      "target": "tubing_out_length",
      "type": "number",
      "build_prop": true,
      "edit_mode": "extra",
      "factor": 1,
      "delta": 0.05,
      "rounding": 3,
      "ll": 0,
      "ul": 5
    },
    {
      "caption": "oxygenator volume (L)",
      "target": "oxy_vol",
      "type": "number",
      "build_prop": true,
      "edit_mode": "extra",
      "factor": 1,
      "delta": 0.001,
      "rounding": 3,
      "ll": 0,
      "ul": 1
    },
    {
      "caption": "pump volume (L)",
      "target": "pump_vol",
      "type": "number",
      "build_prop": true,
      "edit_mode": "extra",
      "factor": 1,
      "delta": 0.001,
      "rounding": 3,
      "ll": 0,
      "ul": 1
    },
    {
      "caption": "drainage cannula resistance factor",
      "target": "drainage_res_factor",
      "type": "factor",
      "delta": 0.01,
      "rounding": 2,
      "ll": 0,
      "ul": 100
    },
    {
      "caption": "return cannula resistance factor",
      "target": "return_res_factor",
      "type": "factor",
      "delta": 0.01,
      "rounding": 2,
      "ll": 0,
      "ul": 100
    },
    {
      "caption": "tubing resistance factor",
      "target": "tubing_res_factor",
      "type": "factor",
      "delta": 0.01,
      "rounding": 2,
      "ll": 0,
      "ul": 100
    },
    {
      "caption": "pump resistance factor",
      "target": "pump_res_factor",
      "type": "factor",
      "delta": 0.01,
      "rounding": 2,
      "ll": 0,
      "ul": 100
    },
    {
      "caption": "oxygenator resistance factor",
      "target": "oxy_res_factor",
      "type": "factor",
      "delta": 0.01,
      "rounding": 2,
      "ll": 0,
      "ul": 100
    },
    {
      "target": "tubing_in_res",
      "type": "number",
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false,
      "caption": "tubing in resistance (mmHg/(L/s))",
      "factor": 1,
      "delta": 1,
      "rounding": 0,
      "ll": 100,
      "ul": 100000
    },
    {
      "target": "tubing_out_res",
      "type": "number",
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false,
      "caption": "tubing out resistance (mmHg/(L/s))",
      "factor": 1,
      "delta": 1,
      "rounding": 0,
      "ll": 100,
      "ul": 100000
    },
    {
      "target": "pump_res_for",
      "type": "number",
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false,
      "caption": "pump forward resistance (mmHg/(L/s))",
      "factor": 1,
      "delta": 1,
      "rounding": 0,
      "ll": 100,
      "ul": 100000
    },
    {
      "target": "pump_res_back",
      "type": "number",
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false,
      "caption": "pump backward resistance (mmHg/(L/s))",
      "factor": 1,
      "delta": 1,
      "rounding": 0,
      "ll": 100,
      "ul": 100000
    },
    {
      "target": "oxy_res_for",
      "type": "number",
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false,
      "caption": "oxygenator forward resistance (mmHg/(L/s))",
      "factor": 1,
      "delta": 1,
      "rounding": 0,
      "ll": 100,
      "ul": 100000
    },
    {
      "target": "oxy_res_back",
      "type": "number",
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false,
      "caption": "oxygenator backward resistance (mmHg/(L/s))",
      "factor": 1,
      "delta": 1,
      "rounding": 0,
      "ll": 100,
      "ul": 100000
    },
    {
      "target": "drainage_res",
      "type": "number",
      "edit_mode": "advanced",
      "readonly": true,
      "caption": "drainage cannula resistance (computed, mmHg/(L/s))",
      "factor": 1,
      "rounding": 0
    },
    {
      "target": "return_res",
      "type": "number",
      "edit_mode": "advanced",
      "readonly": true,
      "caption": "return cannula resistance (computed, mmHg/(L/s))",
      "factor": 1,
      "rounding": 0
    },
    {
      "target": "pump_pressure",
      "type": "number",
      "edit_mode": "advanced",
      "readonly": true,
      "caption": "pump pressure (mmHg)",
      "factor": 1,
      "rounding": 1
    },
    {
      "target": "flow",
      "type": "number",
      "edit_mode": "advanced",
      "readonly": true,
      "caption": "circuit flow (L/min)",
      "factor": 1,
      "rounding": 2
    },
    {
      "target": "flow_avg",
      "type": "number",
      "edit_mode": "advanced",
      "readonly": true,
      "caption": "circuit flow, averaged (L/min)",
      "factor": 1,
      "rounding": 2
    },
    {
      "target": "p_ven",
      "type": "number",
      "edit_mode": "advanced",
      "readonly": true,
      "caption": "venous (drainage) pressure (mmHg)",
      "factor": 1,
      "rounding": 0
    },
    {
      "target": "p_int",
      "type": "number",
      "edit_mode": "advanced",
      "readonly": true,
      "caption": "internal (pump) pressure (mmHg)",
      "factor": 1,
      "rounding": 0
    },
    {
      "target": "p_art",
      "type": "number",
      "edit_mode": "advanced",
      "readonly": true,
      "caption": "arterial (return) pressure (mmHg)",
      "factor": 1,
      "rounding": 0
    },
    {
      "target": "sat_ven_o2",
      "type": "number",
      "edit_mode": "advanced",
      "readonly": true,
      "caption": "venous o2 saturation (%)",
      "factor": 1,
      "rounding": 0
    },
    {
      "target": "sat_postoxy_o2",
      "type": "number",
      "edit_mode": "advanced",
      "readonly": true,
      "caption": "post-oxygenator o2 saturation (%)",
      "factor": 1,
      "rounding": 0
    },
    {
      "target": "pco2_postoxy",
      "type": "number",
      "edit_mode": "advanced",
      "readonly": true,
      "caption": "post-oxygenator pco2 (mmHg)",
      "factor": 1,
      "rounding": 0
    }
  ],
  "Fluids": [
    {
      "target": "description",
      "type": "string",
      "build_prop": true,
      "edit_mode": "caption",
      "readonly": true,
      "caption": "description"
    },
    {
      "target": "is_enabled",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "all",
      "readonly": false,
      "caption": "enabled"
    },
    {
      "target": "add_volume",
      "caption": "Adminster fluid",
      "type": "function",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "args": [
        {
          "caption": "volume (ml)",
          "target": "",
          "type": "number",
          "factor": 1,
          "delta": 0.1,
          "rounding": 1
        },
        {
          "caption": "in time (s)",
          "target": "_default_time",
          "type": "number",
          "factor": 1,
          "delta": 0.1,
          "rounding": 1
        },
        {
          "caption": "fluid type",
          "target": "fluid type",
          "type": "list",
          "default": "normal_saline",
          "choices": [
            "normal_saline",
            "ringers_lactate",
            "packed_cells",
            "albumin_20%"
          ]
        }
      ]
    }
  ],
  "Gas": [
    {
      "target": "description",
      "type": "string",
      "build_prop": true,
      "edit_mode": "caption",
      "readonly": true,
      "caption": "description"
    },
    {
      "target": "is_enabled",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "extra",
      "readonly": false,
      "caption": "enabled"
    },
    {
      "caption": "atmospheric pressure (mmHg)",
      "target": "set_atmospheric_pressure",
      "build_prop": true,
      "edit_mode": "basic",
      "type": "function",
      "args": [
        {
          "caption": "new atmospheric pressure",
          "target": "pres_atm",
          "type": "number",
          "factor": 1,
          "delta": 0.1,
          "rounding": 1,
          "ul": 5000,
          "ll": 100
        }
      ]
    },
    {
      "caption": "temperature (C)",
      "target": "set_temperature",
      "build_prop": true,
      "edit_mode": "basic",
      "type": "function",
      "args": [
        {
          "caption": "new temperature",
          "target": "temp",
          "type": "number",
          "factor": 1,
          "delta": 0.1,
          "rounding": 1,
          "ul": 100,
          "ll": -100
        },
        {
          "target": "site",
          "caption": "change in site",
          "type": "list",
          "custom_options": false,
          "options": [
            "GasCapacitance"
          ]
        }
      ]
    },
    {
      "caption": "humidity factor",
      "target": "set_humidity",
      "build_prop": true,
      "edit_mode": "basic",
      "type": "function",
      "args": [
        {
          "caption": "new humidity",
          "target": "humidity",
          "type": "number",
          "factor": 1,
          "delta": 0.1,
          "rounding": 1,
          "ul": 1,
          "ll": 0
        },
        {
          "target": "site",
          "caption": "change in site",
          "type": "list",
          "custom_options": false,
          "options": [
            "GasCapacitance"
          ]
        }
      ]
    },
    {
      "caption": "fio2",
      "target": "set_fio2",
      "build_prop": true,
      "edit_mode": "basic",
      "type": "function",
      "args": [
        {
          "caption": "new fio2",
          "target": "fio2",
          "type": "number",
          "factor": 1,
          "delta": 0.01,
          "rounding": 2,
          "ul": 1,
          "ll": 0
        },
        {
          "target": "site",
          "caption": "change in site",
          "type": "list",
          "custom_options": false,
          "options": [
            "GasCapacitance"
          ]
        }
      ]
    }
  ],
  "GasCapacitance": [
    {
      "target": "model_type",
      "type": "string",
      "build_prop": false,
      "edit_mode": "basic",
      "readonly": true,
      "caption": "model type"
    },
    {
      "target": "description",
      "type": "string",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": true,
      "caption": "description"
    },
    {
      "target": "is_enabled",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "caption": "enabled"
    },
    {
      "caption": "fixed gas composition",
      "target": "fixed_composition",
      "type": "boolean"
    },
    {
      "caption": "unstressed volume (L)",
      "target": "u_vol",
      "type": "number",
      "factor": 1,
      "delta": 0.001,
      "rounding": 3
    },
    {
      "caption": "elastance baseline (mmHg/L)",
      "target": "el_base",
      "type": "number",
      "factor": 1,
      "delta": 1,
      "rounding": 0
    },
    {
      "caption": "elastance non linear k",
      "target": "el_k",
      "type": "number",
      "factor": 1,
      "delta": 1,
      "rounding": 0
    },
    {
      "caption": "target temperature (dgs C)",
      "target": "target_temp",
      "type": "number",
      "factor": 1,
      "delta": 0.1,
      "rounding": 1
    },
    {
      "caption": "atmospheric pressure (mmHg)",
      "target": "pres_atm",
      "type": "number",
      "factor": 1,
      "delta": 1,
      "rounding": 0
    },
    {
      "caption": "unstressed volume factor",
      "target": "u_vol_factor_ps",
      "type": "factor"
    },
    {
      "caption": "elastance baseline factor",
      "target": "el_base_factor_ps",
      "type": "factor"
    },
    {
      "caption": "elastance non linear factor",
      "target": "el_k_factor_ps",
      "type": "factor"
    }
  ],
  "GasDiffusor": [
    {
      "target": "model_type",
      "type": "string",
      "build_prop": false,
      "edit_mode": "basic",
      "readonly": true,
      "caption": "model type"
    },
    {
      "target": "description",
      "type": "string",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": true,
      "caption": "description"
    },
    {
      "target": "is_enabled",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "caption": "enabled"
    },
    {
      "caption": "oxygen diffusion constant",
      "target": "dif_o2",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "factor": 1,
      "delta": 0.001,
      "rounding": 3
    },
    {
      "caption": "carbon dioxide diffusion constant",
      "target": "dif_co2",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "factor": 1,
      "delta": 0.001,
      "rounding": 3
    },
    {
      "caption": "nitric oxide diffusion constant",
      "target": "dif_n2",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "factor": 1,
      "delta": 0.001,
      "rounding": 3
    },
    {
      "caption": "other gasses diffusion constant",
      "target": "dif_other",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "factor": 1,
      "delta": 0.001,
      "rounding": 3
    },
    {
      "caption": "gas component 1",
      "target": "comp_gas1",
      "build_prop": true,
      "edit_mode": "basic",
      "type": "list",
      "options": [
        "GasCapacitance"
      ]
    },
    {
      "caption": "gas component 2",
      "target": "comp_gas2",
      "type": "list",
      "build_prop": true,
      "edit_mode": "basic",
      "options": [
        "GasCapacitance"
      ]
    },
    {
      "caption": "oxygen diffusion factor",
      "target": "dif_o2_factor_ps",
      "type": "factor"
    },
    {
      "caption": "carbon dioxide diffusion factor",
      "target": "dif_co2_factor_ps",
      "type": "factor"
    },
    {
      "caption": "nitric oxide diffusion factor",
      "target": "dif_n2_factor_ps",
      "type": "factor"
    },
    {
      "caption": "other gasses diffusion factor",
      "target": "dif_other_factor_ps",
      "type": "factor"
    }
  ],
  "GasExchanger": [
    {
      "target": "model_type",
      "type": "string",
      "build_prop": false,
      "edit_mode": "basic",
      "readonly": true,
      "caption": "model type"
    },
    {
      "target": "description",
      "type": "string",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": true,
      "caption": "description"
    },
    {
      "target": "is_enabled",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "caption": "enabled"
    },
    {
      "caption": "oxygen diffusion constant",
      "target": "dif_o2",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "factor": 1,
      "delta": 0.0001,
      "rounding": 4
    },
    {
      "caption": "carbon dioxide diffusion constant",
      "target": "dif_co2",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "factor": 1,
      "delta": 0.0001,
      "rounding": 4
    },
    {
      "caption": "gas component",
      "target": "comp_gas",
      "type": "list",
      "build_prop": true,
      "edit_mode": "basic",
      "options": [
        "GasCapacitance"
      ]
    },
    {
      "caption": "blood component",
      "target": "comp_blood",
      "type": "list",
      "build_prop": true,
      "edit_mode": "basic",
      "options": [
        "BloodCapacitance",
        "BloodTimeVaryingElastance",
        "BloodPump",
        "BloodVessel",
        "MicroVascularUnit",
        "HeartChamber"
      ]
    },
    {
      "caption": "oxygen diffusion factor",
      "target": "dif_o2_factor_ps",
      "type": "factor"
    },
    {
      "caption": "carbon dioxide diffusion factor",
      "target": "dif_co2_factor_ps",
      "type": "factor"
    }
  ],
  "Heart": [
    {
      "target": "description",
      "type": "string",
      "build_prop": true,
      "edit_mode": "caption",
      "readonly": true,
      "caption": "description"
    },
    {
      "target": "is_enabled",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "all",
      "readonly": false,
      "caption": "enabled"
    },
    {
      "caption": "AV block",
      "target": "av_block_mode",
      "type": "list",
      "custom_options": false,
      "options": ["none", "first_degree", "second_degree", "complete"],
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false
    },
    {
      "caption": "AV block ratio (2nd degree, e.g. 2 = 2:1)",
      "target": "av_block_ratio",
      "type": "number",
      "delta": 1,
      "factor": 1,
      "rounding": 0,
      "ll": 2,
      "ul": 6,
      "build_prop": true,
      "edit_mode": "extra",
      "readonly": false
    },
    {
      "caption": "SA node active (off = sinus arrest)",
      "target": "sa_node_enabled",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false
    },
    {
      "caption": "ventricular pacemaker mode",
      "target": "vent_pacemaker_mode",
      "type": "list",
      "custom_options": false,
      "options": ["escape", "vt"],
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false
    },
    {
      "caption": "ventricular escape rate (bpm)",
      "target": "vent_escape_rate",
      "type": "number",
      "delta": 5,
      "factor": 1,
      "rounding": 0,
      "ll": 20,
      "ul": 120,
      "build_prop": true,
      "edit_mode": "extra",
      "readonly": false
    },
    {
      "caption": "ventricular tachycardia rate (bpm)",
      "target": "vt_rate",
      "type": "number",
      "delta": 10,
      "factor": 1,
      "rounding": 0,
      "ll": 120,
      "ul": 300,
      "build_prop": true,
      "edit_mode": "extra",
      "readonly": false
    },
    {
      "caption": "trigger premature ventricular contraction (PVC)",
      "target": "trigger_pvc",
      "type": "function",
      "build_prop": false,
      "edit_mode": "basic",
      "readonly": false,
      "args": []
    },
    {
      "caption": "reference heart rate (bpm)",
      "target": "heart_rate_ref",
      "type": "number",
      "delta": 1,
      "factor": 1,
      "rounding": 0,
      "ll": 10,
      "ul": 300,
      "readonly": false,
      "build_prop": true,
      "edit_mode": "basic"
    },
    {
      "caption": "pq time (ms)",
      "target": "pq_time",
      "type": "number",
      "delta": 1,
      "factor": 1000,
      "rounding": 0,
      "ll": 50,
      "ul": 1000,
      "readonly": false,
      "build_prop": true,
      "edit_mode": "basic"
    },
    {
      "caption": "qrs time (ms)",
      "target": "qrs_time",
      "type": "number",
      "delta": 1,
      "factor": 1000,
      "rounding": 0,
      "ll": 50,
      "ul": 500,
      "readonly": false,
      "build_prop": true,
      "edit_mode": "basic"
    },
    {
      "caption": "qt time (ms)",
      "target": "qt_time",
      "type": "number",
      "delta": 1,
      "factor": 1000,
      "rounding": 0,
      "ll": 50,
      "ul": 1000,
      "readonly": false,
      "build_prop": true,
      "edit_mode": "basic"
    },
    {
      "caption": "av delay time (ms)",
      "target": "av_delay",
      "type": "number",
      "delta": 0.1,
      "factor": 1000,
      "rounding": 1,
      "ll": 0.5,
      "ul": 10,
      "readonly": false,
      "build_prop": true,
      "edit_mode": "extra"
    },
    {
      "caption": "ECG P amplitude (mV)",
      "target": "p_amp",
      "type": "number",
      "factor": 1,
      "delta": 0.05,
      "rounding": 2,
      "ll": -5,
      "ul": 5,
      "readonly": false,
      "build_prop": true,
      "edit_mode": "extra"
    },
    {
      "caption": "ECG Q amplitude (mV)",
      "target": "q_amp",
      "type": "number",
      "factor": 1,
      "delta": 0.05,
      "rounding": 2,
      "ll": -5,
      "ul": 5,
      "readonly": false,
      "build_prop": true,
      "edit_mode": "extra"
    },
    {
      "caption": "ECG R amplitude (mV)",
      "target": "r_amp",
      "type": "number",
      "factor": 1,
      "delta": 0.05,
      "rounding": 2,
      "ll": -5,
      "ul": 5,
      "readonly": false,
      "build_prop": true,
      "edit_mode": "extra"
    },
    {
      "caption": "ECG S amplitude (mV)",
      "target": "s_amp",
      "type": "number",
      "factor": 1,
      "delta": 0.05,
      "rounding": 2,
      "ll": -5,
      "ul": 5,
      "readonly": false,
      "build_prop": true,
      "edit_mode": "extra"
    },
    {
      "caption": "ECG T amplitude (mV)",
      "target": "t_amp",
      "type": "number",
      "factor": 1,
      "delta": 0.05,
      "rounding": 2,
      "ll": -5,
      "ul": 5,
      "readonly": false,
      "build_prop": true,
      "edit_mode": "extra"
    },
    {
      "caption": "heartrate factor",
      "target": "hr_factor",
      "type": "number",
      "factor": 1,
      "delta": 0.01,
      "rounding": 2,
      "ll": 0,
      "ul": 1000000
    },
    {
      "caption": "ans sensitivity",
      "target": "ans_sens",
      "type": "number",
      "edit_mode": "basic",
      "build_prop": true,
      "factor": 1,
      "delta": 0.01,
      "rounding": 2,
      "ll": 0,
      "ul": 1
    },
    {
      "caption": "systolic function factor left",
      "target": "cont_factor_left",
      "type": "factor",
      "edit_mode": "factors",
      "factor": 1,
      "delta": 0.01,
      "rounding": 2,
      "ll": -20,
      "ul": 20
    },
    {
      "caption": "systolic function factor right",
      "target": "cont_factor_right",
      "type": "factor",
      "edit_mode": "factors",
      "factor": 1,
      "delta": 0.01,
      "rounding": 2,
      "ll": -20,
      "ul": 20
    },
    {
      "caption": "diastolic function factor left",
      "target": "relax_factor_left",
      "type": "factor",
      "edit_mode": "factors",
      "factor": 1,
      "delta": 0.01,
      "rounding": 2,
      "ll": -20,
      "ul": 20
    },
    {
      "caption": "diastolic function factor right",
      "target": "relax_factor_right",
      "type": "factor",
      "edit_mode": "factors",
      "factor": 1,
      "delta": 0.01,
      "rounding": 2,
      "ll": -20,
      "ul": 20
    },
    {
      "caption": "pericardial stiffness factor",
      "target": "pc_el_factor",
      "type": "factor",
      "edit_mode": "factors",
      "factor": 1,
      "delta": 0.1,
      "rounding": 2,
      "ll": 0,
      "ul": 200
    },
    {
      "caption": "pericardial fluid volume (mL)",
      "target": "pc_extra_volume",
      "type": "number",
      "edit_mode": "basic",
      "factor": 1000,
      "delta": 1,
      "rounding": 0,
      "ll": 0,
      "ul": 1000
    }
  ],
  "HeartChamber": [
    {
      "target": "model_type",
      "type": "string",
      "build_prop": false,
      "edit_mode": "basic",
      "readonly": true,
      "caption": "model type"
    },
    {
      "target": "description",
      "type": "string",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": true,
      "caption": "description"
    },
    {
      "target": "is_enabled",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "caption": "enabled"
    },
    {
      "caption": "volume (L)",
      "target": "vol",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "factor": 1,
      "delta": 0.001,
      "rounding": 3
    },
    {
      "caption": "unstressed volume (L)",
      "target": "u_vol",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "factor": 1,
      "delta": 0.001,
      "rounding": 3
    },
    {
      "caption": "elastance minimum (mmHg/L)",
      "target": "el_min",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "factor": 1,
      "delta": 1,
      "rounding": 0
    },
    {
      "caption": "elastance maximum (mmHg/L)",
      "target": "el_max",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "factor": 1,
      "delta": 1,
      "rounding": 0
    },
    {
      "caption": "elastance non linear k",
      "target": "el_k",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "factor": 1,
      "delta": 1,
      "rounding": 0
    },
    {
      "caption": "unstressed volume factor",
      "target": "u_vol_factor_ps",
      "type": "factor"
    },
    {
      "caption": "elastance minimum baseline factor",
      "target": "el_min_factor_ps",
      "type": "factor"
    },
    {
      "caption": "elastance maximum baseline factor",
      "target": "el_max_factor_ps",
      "type": "factor"
    },
    {
      "caption": "elastance non linear factor",
      "target": "el_k_factor_ps",
      "type": "factor"
    },
    {
      "caption": "drug lusitropy factor (Drugs; <1 = better relaxation)",
      "target": "el_min_drug_factor",
      "type": "factor",
      "edit_mode": "factors",
      "readonly": true
    },
    {
      "caption": "acute load contractility factor (HeartFunction)",
      "target": "el_max_load_factor",
      "type": "factor",
      "edit_mode": "factors",
      "readonly": true
    },
    {
      "caption": "remodeling contractility factor (HeartFunction)",
      "target": "el_max_remodel_factor",
      "type": "factor",
      "edit_mode": "factors",
      "readonly": true
    },
    {
      "caption": "remodeling stiffness factor (HeartFunction)",
      "target": "el_k_remodel_factor",
      "type": "factor",
      "edit_mode": "factors",
      "readonly": true
    },
    {
      "caption": "remodeling dilation factor (HeartFunction)",
      "target": "u_vol_remodel_factor",
      "type": "factor",
      "edit_mode": "factors",
      "readonly": true
    }
  ],
  "HeartValve": [
    {
      "target": "model_type",
      "type": "string",
      "build_prop": false,
      "edit_mode": "basic",
      "readonly": true,
      "caption": "model type"
    },
    {
      "target": "description",
      "type": "string",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": true,
      "caption": "description"
    },
    {
      "target": "is_enabled",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "caption": "enabled"
    },
    {
      "caption": "no flow allowed",
      "target": "no_flow",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "basic"
    },
    {
      "caption": "no back flow allowed",
      "target": "no_back_flow",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "basic"
    },
    {
      "caption": "forward resistance",
      "target": "r_for",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "delta": 1,
      "factor": 1,
      "rounding": 0
    },
    {
      "caption": "backward resistance",
      "target": "r_back",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "delta": 1,
      "factor": 1,
      "rounding": 0
    },
    {
      "caption": "non linear resistance coefficient",
      "target": "r_k",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "delta": 1,
      "factor": 1,
      "rounding": 0
    },
    {
      "type": "list",
      "caption": "comp from",
      "target": "comp_from",
      "build_prop": true,
      "edit_mode": "basic",
      "options": [
        "BloodCapacitance",
        "BloodTimeVaryingElastance",
        "BloodPump",
        "BloodVessel",
        "MicroVascularUnit",
        "HeartChamber",
        "GasCapacitance"
      ]
    },
    {
      "type": "list",
      "caption": "comp to",
      "target": "comp_to",
      "build_prop": true,
      "edit_mode": "basic",
      "options": [
        "BloodCapacitance",
        "BloodTimeVaryingElastance",
        "BloodPump",
        "BloodVessel",
        "MicroVascularUnit",
        "HeartChamber",
        "GasCapacitance"
      ]
    },
    {
      "caption": "resistance factor",
      "target": "r_factor_ps",
      "type": "factor"
    },
    {
      "caption": "non linear resistance coefficient factor",
      "target": "r_k_factor_ps",
      "type": "factor"
    },
    {
      "target": "is_externally_managed",
      "type": "boolean",
      "build_prop": false,
      "edit_mode": "basic",
      "readonly": true,
      "caption": "externally managed"
    }
  ],
  "Kidneys": [
    {
      "target": "description",
      "type": "string",
      "build_prop": true,
      "edit_mode": "all",
      "readonly": true,
      "caption": "description"
    },
    {
      "target": "is_enabled",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "all",
      "readonly": false,
      "caption": "enabled"
    },
    {
      "caption": "kidneys running",
      "target": "kidneys_running",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false
    },
    {
      "caption": "filtration coeff (L/s/mmHg)",
      "target": "kf",
      "type": "number",
      "delta": 0.0000001,
      "factor": 1,
      "rounding": 8,
      "ll": 0,
      "ul": 0.001,
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false
    },
    {
      "caption": "bowman pressure (mmHg)",
      "target": "p_bowman",
      "type": "number",
      "delta": 0.5,
      "factor": 1,
      "rounding": 1,
      "ll": 0,
      "ul": 40,
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false
    },
    {
      "caption": "oncotic pressure (mmHg)",
      "target": "oncotic_base",
      "type": "number",
      "delta": 0.5,
      "factor": 1,
      "rounding": 1,
      "ll": 0,
      "ul": 40,
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false
    },
    {
      "caption": "water reabsorption fraction",
      "target": "reabsorption_fraction",
      "type": "number",
      "delta": 0.001,
      "factor": 1,
      "rounding": 4,
      "ll": 0,
      "ul": 0.9999,
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false
    },
    {
      "caption": "reabsorption fractions (by solute)",
      "target": "reabsorption_fractions",
      "type": "dict",
      "dict_value_type": "number",
      "dict_keys": ["na", "k", "ca", "cl", "lact", "mg", "phosphates", "uma"],
      "delta": 0.001,
      "factor": 1,
      "rounding": 3,
      "ll": 0,
      "ul": 0.9999,
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "reference albumin (g/L)",
      "target": "albumin_ref",
      "type": "number",
      "delta": 1,
      "factor": 1,
      "rounding": 1,
      "ll": 1,
      "ul": 60,
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "edit_mode": "factors",
      "caption": "filtration coeff factor",
      "target": "kf_factor_ps",
      "type": "factor",
      "build_prop": false
    },
    {
      "edit_mode": "factors",
      "caption": "reabsorption fraction factor",
      "target": "reabs_factor_ps",
      "type": "factor",
      "build_prop": false
    },
    {
      "caption": "GFR (mL/min)",
      "target": "gfr",
      "type": "number",
      "factor": 1,
      "rounding": 1,
      "build_prop": false,
      "edit_mode": "extra",
      "readonly": true
    },
    {
      "caption": "urine output (mL/min)",
      "target": "urine_flow",
      "type": "number",
      "factor": 1,
      "rounding": 3,
      "build_prop": false,
      "edit_mode": "extra",
      "readonly": true
    },
    {
      "caption": "net filtration pressure (mmHg)",
      "target": "nfp",
      "type": "number",
      "factor": 1,
      "rounding": 1,
      "build_prop": false,
      "edit_mode": "extra",
      "readonly": true
    },
    {
      "caption": "diuresis (mL)",
      "target": "urine_volume",
      "type": "number",
      "factor": 1,
      "rounding": 1,
      "build_prop": false,
      "edit_mode": "extra",
      "readonly": true
    },
    {
      "caption": "fractional excretion Na (%)",
      "target": "fe_na",
      "type": "number",
      "factor": 1,
      "rounding": 2,
      "build_prop": false,
      "edit_mode": "extra",
      "readonly": true
    },
    {
      "caption": "GFR autoregulation",
      "target": "autoregulation_enabled",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false
    },
    {
      "caption": "afferent vessel name",
      "target": "aff_vessel_name",
      "type": "string",
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "myogenic input model",
      "target": "myogenic_input_model",
      "type": "string",
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "myogenic input prop",
      "target": "myogenic_input_prop",
      "type": "string",
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "myogenic setpoint (mmHg)",
      "target": "myogenic_p_set",
      "type": "number",
      "delta": 1,
      "factor": 1,
      "rounding": 1,
      "ll": 0,
      "ul": 250,
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "myogenic window min (mmHg)",
      "target": "myogenic_p_min",
      "type": "number",
      "delta": 1,
      "factor": 1,
      "rounding": 1,
      "ll": 0,
      "ul": 250,
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "myogenic window max (mmHg)",
      "target": "myogenic_p_max",
      "type": "number",
      "delta": 1,
      "factor": 1,
      "rounding": 1,
      "ll": 0,
      "ul": 250,
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "myogenic gain up (/mmHg)",
      "target": "myogenic_gain_up",
      "type": "number",
      "delta": 0.01,
      "factor": 1,
      "rounding": 3,
      "ll": 0,
      "ul": 1,
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "myogenic gain down (/mmHg)",
      "target": "myogenic_gain_down",
      "type": "number",
      "delta": 0.01,
      "factor": 1,
      "rounding": 3,
      "ll": 0,
      "ul": 1,
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "myogenic time constant (s)",
      "target": "myogenic_tc",
      "type": "number",
      "delta": 0.5,
      "factor": 1,
      "rounding": 1,
      "ll": 0,
      "ul": 120,
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "TGF use NaCl signal",
      "target": "tgf_use_nacl",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "TGF setpoint (0=auto)",
      "target": "tgf_setpoint",
      "type": "number",
      "delta": 1,
      "factor": 1,
      "rounding": 2,
      "ll": 0,
      "ul": 100000,
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "TGF auto-seed delay (s)",
      "target": "tgf_seed_delay",
      "type": "number",
      "delta": 1,
      "factor": 1,
      "rounding": 1,
      "ll": 0,
      "ul": 600,
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "TGF gain",
      "target": "tgf_gain",
      "type": "number",
      "delta": 0.1,
      "factor": 1,
      "rounding": 2,
      "ll": 0,
      "ul": 10,
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "TGF time constant (s)",
      "target": "tgf_tc",
      "type": "number",
      "delta": 1,
      "factor": 1,
      "rounding": 1,
      "ll": 0,
      "ul": 600,
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "afferent apply time constant (s)",
      "target": "afferent_apply_tc",
      "type": "number",
      "delta": 0.5,
      "factor": 1,
      "rounding": 1,
      "ll": 0,
      "ul": 120,
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "afferent factor min",
      "target": "afferent_factor_min",
      "type": "number",
      "delta": 0.1,
      "factor": 1,
      "rounding": 2,
      "ll": 0.01,
      "ul": 1,
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "afferent factor max",
      "target": "afferent_factor_max",
      "type": "number",
      "delta": 0.5,
      "factor": 1,
      "rounding": 2,
      "ll": 1,
      "ul": 20,
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "myogenic factor",
      "target": "myogenic_factor",
      "type": "number",
      "factor": 1,
      "rounding": 3,
      "build_prop": false,
      "edit_mode": "extra",
      "readonly": true
    },
    {
      "caption": "TGF factor",
      "target": "tgf_factor",
      "type": "number",
      "factor": 1,
      "rounding": 3,
      "build_prop": false,
      "edit_mode": "extra",
      "readonly": true
    },
    {
      "caption": "afferent factor (applied)",
      "target": "afferent_factor",
      "type": "number",
      "factor": 1,
      "rounding": 3,
      "build_prop": false,
      "edit_mode": "extra",
      "readonly": true
    },
    {
      "caption": "sensed pressure (mmHg)",
      "target": "sensed_pressure",
      "type": "number",
      "factor": 1,
      "rounding": 1,
      "build_prop": false,
      "edit_mode": "extra",
      "readonly": true
    },
    {
      "caption": "TGF signal",
      "target": "tgf_signal",
      "type": "number",
      "factor": 1,
      "rounding": 2,
      "build_prop": false,
      "edit_mode": "extra",
      "readonly": true
    },
    {
      "caption": "ADH water reabsorption factor",
      "target": "reabs_factor_adh",
      "type": "factor",
      "build_prop": false,
      "edit_mode": "factors"
    },
    {
      "caption": "hormonal reabsorption factors (by solute)",
      "target": "reabsorption_factors",
      "type": "dict",
      "dict_value_type": "number",
      "dict_keys": ["na", "k", "ca", "cl", "lact", "mg", "phosphates", "uma"],
      "delta": 0.001,
      "factor": 1,
      "rounding": 3,
      "ll": 0,
      "ul": 2,
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    }
  ],
  "Uterus": [
    {
      "target": "description",
      "type": "string",
      "build_prop": true,
      "edit_mode": "all",
      "readonly": true,
      "caption": "description"
    },
    {
      "target": "is_enabled",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "all",
      "readonly": false,
      "caption": "enabled"
    },
    {
      "caption": "uterus running",
      "target": "uterus_running",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false
    },
    {
      "caption": "metabolism active",
      "target": "met_active",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false
    },
    {
      "caption": "uterine VO2 (mL O2/kg/min)",
      "target": "ut_vo2",
      "type": "number",
      "delta": 0.005,
      "factor": 1,
      "rounding": 3,
      "ll": 0,
      "ul": 5,
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false
    },
    {
      "caption": "perfusion factor",
      "target": "perfusion_factor",
      "type": "number",
      "delta": 0.05,
      "factor": 1,
      "rounding": 2,
      "ll": 0,
      "ul": 10,
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false
    },
    {
      "caption": "pregnant",
      "target": "pregnant",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false
    },
    {
      "caption": "pregnancy GA (weeks)",
      "target": "preg_ga",
      "type": "number",
      "delta": 1,
      "factor": 1,
      "rounding": 0,
      "ll": 0,
      "ul": 42,
      "slider": true,
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false
    },
    {
      "caption": "couple placenta to uterine blood",
      "target": "couple_placenta",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "extra",
      "readonly": false
    },
    {
      "caption": "contractions running (labor)",
      "target": "contractions_running",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false
    },
    {
      "caption": "contraction period (s)",
      "target": "contraction_period",
      "type": "number",
      "delta": 5,
      "factor": 1,
      "rounding": 0,
      "ll": 30,
      "ul": 600,
      "build_prop": true,
      "edit_mode": "extra",
      "readonly": false
    },
    {
      "caption": "contraction duration (s)",
      "target": "contraction_duration",
      "type": "number",
      "delta": 5,
      "factor": 1,
      "rounding": 0,
      "ll": 20,
      "ul": 180,
      "build_prop": true,
      "edit_mode": "extra",
      "readonly": false
    },
    {
      "caption": "contraction amplitude (mmHg)",
      "target": "contraction_amplitude",
      "type": "number",
      "delta": 5,
      "factor": 1,
      "rounding": 0,
      "ll": 0,
      "ul": 120,
      "build_prop": true,
      "edit_mode": "extra",
      "readonly": false
    },
    {
      "caption": "resting tone (mmHg)",
      "target": "resting_tone",
      "type": "number",
      "delta": 1,
      "factor": 1,
      "rounding": 0,
      "ll": 0,
      "ul": 30,
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "contraction pressure gain (0-1)",
      "target": "contraction_pres_gain",
      "type": "number",
      "delta": 0.05,
      "factor": 1,
      "rounding": 2,
      "ll": 0,
      "ul": 1,
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "contraction resistance peak (x)",
      "target": "contraction_r_peak",
      "type": "number",
      "delta": 0.5,
      "factor": 1,
      "rounding": 1,
      "ll": 1,
      "ul": 20,
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "respiratory quotient",
      "target": "resp_q",
      "type": "number",
      "delta": 0.05,
      "factor": 1,
      "rounding": 2,
      "ll": 0,
      "ul": 1.5,
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "pregnancy GA threshold (weeks)",
      "target": "preg_ga_threshold",
      "type": "number",
      "delta": 1,
      "factor": 1,
      "rounding": 0,
      "ll": 0,
      "ul": 20,
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "pregnancy GA term anchor (weeks)",
      "target": "preg_ga_term",
      "type": "number",
      "delta": 1,
      "factor": 1,
      "rounding": 0,
      "ll": 30,
      "ul": 42,
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "term bed-resistance factor (conduits)",
      "target": "preg_res_term_factor",
      "type": "number",
      "delta": 0.005,
      "factor": 1,
      "rounding": 3,
      "ll": 0.05,
      "ul": 1,
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "term capillary-resistance factor (myometrium)",
      "target": "preg_cap_res_term_factor",
      "type": "number",
      "delta": 0.01,
      "factor": 1,
      "rounding": 3,
      "ll": 0.05,
      "ul": 1,
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "term bed-volume factor",
      "target": "preg_vol_term_factor",
      "type": "number",
      "delta": 0.1,
      "factor": 1,
      "rounding": 2,
      "ll": 1,
      "ul": 6,
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "term VO2 factor",
      "target": "preg_vo2_term_factor",
      "type": "number",
      "delta": 0.1,
      "factor": 1,
      "rounding": 2,
      "ll": 1,
      "ul": 15,
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "edit_mode": "factors",
      "caption": "uterine VO2 factor",
      "target": "vo2_factor_ps",
      "type": "factor",
      "build_prop": false
    },
    {
      "caption": "uterine artery model",
      "target": "ut_art_name",
      "type": "string",
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "uterine capillary model",
      "target": "ut_cap_name",
      "type": "string",
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "uterine vein model",
      "target": "ut_ven_name",
      "type": "string",
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "inflow resistor model",
      "target": "ut_in_res_name",
      "type": "string",
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "drainage resistor model",
      "target": "ut_out_res_name",
      "type": "string",
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "uterine blood flow (mL/min)",
      "target": "ut_blood_flow",
      "type": "number",
      "factor": 1,
      "rounding": 1,
      "build_prop": false,
      "edit_mode": "extra",
      "readonly": true
    },
    {
      "caption": "O2 delivery DO2 (mL O2/min)",
      "target": "ut_do2",
      "type": "number",
      "factor": 1,
      "rounding": 2,
      "build_prop": false,
      "edit_mode": "extra",
      "readonly": true
    },
    {
      "caption": "O2 uptake VO2 (mL O2/min)",
      "target": "ut_vo2_ml",
      "type": "number",
      "factor": 1,
      "rounding": 2,
      "build_prop": false,
      "edit_mode": "extra",
      "readonly": true
    },
    {
      "caption": "O2 extraction ratio (%)",
      "target": "ut_o2er",
      "type": "number",
      "factor": 1,
      "rounding": 1,
      "build_prop": false,
      "edit_mode": "extra",
      "readonly": true
    },
    {
      "caption": "a-v O2 difference (mmol/L)",
      "target": "ut_avo2",
      "type": "number",
      "factor": 1,
      "rounding": 3,
      "build_prop": false,
      "edit_mode": "extra",
      "readonly": true
    },
    {
      "caption": "intrauterine pressure (mmHg)",
      "target": "iup",
      "type": "number",
      "factor": 1,
      "rounding": 1,
      "build_prop": false,
      "edit_mode": "extra",
      "readonly": true
    },
    {
      "caption": "contraction active",
      "target": "contraction_active",
      "type": "boolean",
      "build_prop": false,
      "edit_mode": "extra",
      "readonly": true
    },
    {
      "caption": "Montevideo units",
      "target": "montevideo_units",
      "type": "number",
      "factor": 1,
      "rounding": 0,
      "build_prop": false,
      "edit_mode": "extra",
      "readonly": true
    }
  ],
  "MaternalPlacenta": [
    {
      "target": "description",
      "type": "string",
      "build_prop": true,
      "edit_mode": "all",
      "readonly": true,
      "caption": "description"
    },
    {
      "target": "is_enabled",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "all",
      "readonly": false,
      "caption": "enabled"
    },
    {
      "caption": "placenta running",
      "target": "mp_running",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false
    },
    {
      "caption": "metabolism active",
      "target": "met_active",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false
    },
    {
      "caption": "placental VO2 (mL O2/kg/min)",
      "target": "mp_vo2",
      "type": "number",
      "delta": 0.005,
      "factor": 1,
      "rounding": 3,
      "ll": 0,
      "ul": 5,
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false
    },
    {
      "caption": "term spiral-artery resistance factor",
      "target": "spiral_res_term_factor",
      "type": "number",
      "delta": 0.002,
      "factor": 1,
      "rounding": 3,
      "ll": 0.001,
      "ul": 1,
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "contraction pressure gain (0-1)",
      "target": "contraction_pres_gain",
      "type": "number",
      "delta": 0.05,
      "factor": 1,
      "rounding": 2,
      "ll": 0,
      "ul": 1,
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "GA threshold (weeks)",
      "target": "preg_ga_threshold",
      "type": "number",
      "delta": 1,
      "factor": 1,
      "rounding": 0,
      "ll": 0,
      "ul": 20,
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "GA term anchor (weeks)",
      "target": "preg_ga_term",
      "type": "number",
      "delta": 1,
      "factor": 1,
      "rounding": 0,
      "ll": 30,
      "ul": 42,
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "edit_mode": "factors",
      "caption": "placental VO2 factor",
      "target": "vo2_factor_ps",
      "type": "factor",
      "build_prop": false
    },
    {
      "caption": "placental blood flow (mL/min)",
      "target": "mp_blood_flow",
      "type": "number",
      "factor": 1,
      "rounding": 1,
      "build_prop": false,
      "edit_mode": "extra",
      "readonly": true
    },
    {
      "caption": "share of uterine flow (%)",
      "target": "mp_flow_fraction",
      "type": "number",
      "factor": 1,
      "rounding": 1,
      "build_prop": false,
      "edit_mode": "extra",
      "readonly": true
    },
    {
      "caption": "O2 delivery DO2 (mL O2/min)",
      "target": "mp_do2",
      "type": "number",
      "factor": 1,
      "rounding": 2,
      "build_prop": false,
      "edit_mode": "extra",
      "readonly": true
    },
    {
      "caption": "O2 uptake VO2 (mL O2/min)",
      "target": "mp_vo2_ml",
      "type": "number",
      "factor": 1,
      "rounding": 2,
      "build_prop": false,
      "edit_mode": "extra",
      "readonly": true
    },
    {
      "caption": "O2 extraction ratio (%)",
      "target": "mp_o2er",
      "type": "number",
      "factor": 1,
      "rounding": 1,
      "build_prop": false,
      "edit_mode": "extra",
      "readonly": true
    },
    {
      "caption": "placenta perfused (active)",
      "target": "mp_active",
      "type": "boolean",
      "build_prop": false,
      "edit_mode": "extra",
      "readonly": true
    }
  ],
  "Hormones": [
    {
      "target": "description",
      "type": "string",
      "build_prop": true,
      "edit_mode": "all",
      "readonly": true,
      "caption": "description"
    },
    {
      "target": "is_enabled",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "all",
      "readonly": false,
      "caption": "enabled"
    },
    {
      "caption": "hormones running",
      "target": "hormones_running",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false
    },
    {
      "caption": "RAAS enabled",
      "target": "raas_enabled",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false
    },
    {
      "caption": "ADH enabled",
      "target": "adh_enabled",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false
    },
    {
      "caption": "angiotensin II (activity)",
      "target": "angiotensin",
      "type": "number",
      "factor": 1,
      "rounding": 3,
      "build_prop": false,
      "edit_mode": "basic",
      "readonly": true
    },
    {
      "caption": "aldosterone (activity)",
      "target": "aldosterone",
      "type": "number",
      "factor": 1,
      "rounding": 3,
      "build_prop": false,
      "edit_mode": "basic",
      "readonly": true
    },
    {
      "caption": "ADH (activity)",
      "target": "adh",
      "type": "number",
      "factor": 1,
      "rounding": 3,
      "build_prop": false,
      "edit_mode": "basic",
      "readonly": true
    },
    {
      "caption": "renin drive",
      "target": "renin",
      "type": "number",
      "factor": 1,
      "rounding": 3,
      "build_prop": false,
      "edit_mode": "extra",
      "readonly": true
    },
    {
      "caption": "perfusion setpoint (mmHg)",
      "target": "perfusion_setpoint",
      "type": "number",
      "delta": 0.5,
      "factor": 1,
      "rounding": 1,
      "ll": 0,
      "ul": 200,
      "build_prop": true,
      "edit_mode": "extra",
      "readonly": false
    },
    {
      "caption": "volume setpoint (L)",
      "target": "volume_setpoint",
      "type": "number",
      "delta": 0.01,
      "factor": 1,
      "rounding": 4,
      "ll": 0,
      "ul": 20,
      "build_prop": true,
      "edit_mode": "extra",
      "readonly": false
    },
    {
      "caption": "Na/osmolality setpoint (mmol/L)",
      "target": "osmo_na_setpoint",
      "type": "number",
      "delta": 0.5,
      "factor": 1,
      "rounding": 1,
      "ll": 100,
      "ul": 170,
      "build_prop": true,
      "edit_mode": "extra",
      "readonly": false
    },
    {
      "caption": "K setpoint (mmol/L)",
      "target": "k_setpoint",
      "type": "number",
      "delta": 0.1,
      "factor": 1,
      "rounding": 2,
      "ll": 1,
      "ul": 8,
      "build_prop": true,
      "edit_mode": "extra",
      "readonly": false
    },
    {
      "caption": "angiotensin time constant (s)",
      "target": "angiotensin_tc",
      "type": "number",
      "delta": 1,
      "factor": 1,
      "rounding": 1,
      "ll": 0,
      "ul": 36000,
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "aldosterone time constant (s)",
      "target": "aldosterone_tc",
      "type": "number",
      "delta": 10,
      "factor": 1,
      "rounding": 1,
      "ll": 0,
      "ul": 36000,
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "ADH time constant (s)",
      "target": "adh_tc",
      "type": "number",
      "delta": 1,
      "factor": 1,
      "rounding": 1,
      "ll": 0,
      "ul": 36000,
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "renin gain (perfusion)",
      "target": "renin_gain",
      "type": "number",
      "delta": 0.1,
      "factor": 1,
      "rounding": 2,
      "ll": 0,
      "ul": 50,
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "renin gain (volume)",
      "target": "renin_vol_gain",
      "type": "number",
      "delta": 0.1,
      "factor": 1,
      "rounding": 2,
      "ll": 0,
      "ul": 50,
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "aldosterone gain (AngII)",
      "target": "aldo_gain",
      "type": "number",
      "delta": 0.1,
      "factor": 1,
      "rounding": 2,
      "ll": 0,
      "ul": 50,
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "aldosterone gain (K)",
      "target": "aldo_k_in_gain",
      "type": "number",
      "delta": 0.1,
      "factor": 1,
      "rounding": 2,
      "ll": 0,
      "ul": 50,
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "ADH gain (osmotic)",
      "target": "adh_gain_osmo",
      "type": "number",
      "delta": 0.1,
      "factor": 1,
      "rounding": 2,
      "ll": 0,
      "ul": 50,
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "ADH gain (baroreg)",
      "target": "adh_gain_baro",
      "type": "number",
      "delta": 0.1,
      "factor": 1,
      "rounding": 2,
      "ll": 0,
      "ul": 50,
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "AngII → arteriolar SVR gain",
      "target": "ang_svr_gain",
      "type": "number",
      "delta": 0.01,
      "factor": 1,
      "rounding": 3,
      "ll": 0,
      "ul": 5,
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "AngII → venular SVR gain",
      "target": "ang_svr_ven_gain",
      "type": "number",
      "delta": 0.01,
      "factor": 1,
      "rounding": 3,
      "ll": 0,
      "ul": 5,
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "AngII → renal efferent gain",
      "target": "ang_efferent_gain",
      "type": "number",
      "delta": 0.01,
      "factor": 1,
      "rounding": 3,
      "ll": 0,
      "ul": 5,
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "aldosterone → Na reabs gain",
      "target": "aldo_na_gain",
      "type": "number",
      "delta": 0.001,
      "factor": 1,
      "rounding": 4,
      "ll": 0,
      "ul": 1,
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "aldosterone → K waste gain",
      "target": "aldo_k_gain",
      "type": "number",
      "delta": 0.01,
      "factor": 1,
      "rounding": 3,
      "ll": 0,
      "ul": 1,
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "ADH → water reabs gain",
      "target": "adh_water_gain",
      "type": "number",
      "delta": 0.001,
      "factor": 1,
      "rounding": 4,
      "ll": 0,
      "ul": 1,
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "ADH → SVR gain",
      "target": "adh_svr_gain",
      "type": "number",
      "delta": 0.01,
      "factor": 1,
      "rounding": 3,
      "ll": 0,
      "ul": 5,
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "SVR factor (applied)",
      "target": "svr_factor",
      "type": "number",
      "factor": 1,
      "rounding": 3,
      "build_prop": false,
      "edit_mode": "extra",
      "readonly": true
    },
    {
      "caption": "renal efferent factor (applied)",
      "target": "efferent_factor",
      "type": "number",
      "factor": 1,
      "rounding": 3,
      "build_prop": false,
      "edit_mode": "extra",
      "readonly": true
    },
    {
      "caption": "Na reabs factor (applied)",
      "target": "na_reabs_factor",
      "type": "number",
      "factor": 1,
      "rounding": 4,
      "build_prop": false,
      "edit_mode": "extra",
      "readonly": true
    },
    {
      "caption": "water reabs factor (applied)",
      "target": "water_reabs_factor",
      "type": "number",
      "factor": 1,
      "rounding": 4,
      "build_prop": false,
      "edit_mode": "extra",
      "readonly": true
    },
    {
      "caption": "sensed perfusion (mmHg)",
      "target": "sensed_perfusion",
      "type": "number",
      "factor": 1,
      "rounding": 1,
      "build_prop": false,
      "edit_mode": "extra",
      "readonly": true
    },
    {
      "caption": "sensed volume (L)",
      "target": "sensed_volume",
      "type": "number",
      "factor": 1,
      "rounding": 4,
      "build_prop": false,
      "edit_mode": "extra",
      "readonly": true
    },
    {
      "caption": "sensed osmolality (mOsm/kg)",
      "target": "sensed_osmolality",
      "type": "number",
      "factor": 1,
      "rounding": 1,
      "build_prop": false,
      "edit_mode": "extra",
      "readonly": true
    }
  ],
  "Metabolism": [
    {
      "target": "description",
      "type": "string",
      "build_prop": true,
      "edit_mode": "all",
      "readonly": true,
      "caption": "description"
    },
    {
      "target": "is_enabled",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "all",
      "readonly": false,
      "caption": "enabled"
    },
    {
      "caption": "metabolism enabled",
      "target": "met_active",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false
    },
    {
      "caption": "vo2 (ml/kg/min)",
      "target": "vo2",
      "type": "number",
      "delta": 0.1,
      "factor": 1,
      "rounding": 1,
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false
    },
    {
      "caption": "respiratory quotient",
      "target": "resp_q",
      "type": "number",
      "delta": 0.1,
      "factor": 1,
      "rounding": 1,
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false
    },
    {
      "caption": "vo2 temperature (Q10) factor",
      "target": "vo2_temp_factor",
      "type": "number",
      "delta": 0.01,
      "factor": 1,
      "rounding": 3,
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": true
    },
    {
      "caption": "set local fractional vo2",
      "target": "set_metabolic_active_model",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "type": "function",
      "args": [
        {
          "target": "site",
          "caption": "change in site",
          "type": "list",
          "custom_options": false,
          "options": [
            "BloodCapacitance",
            "BloodTimeVaryingElastance"
          ]
        },
        {
          "caption": "new fvo2",
          "target": "fvo2",
          "type": "number",
          "factor": 1,
          "default": 0,
          "delta": 0.01,
          "rounding": 2,
          "ul": 1,
          "ll": 0
        }
      ]
    }
  ],
  "Thermoregulation": [
    {
      "target": "description",
      "type": "string",
      "build_prop": true,
      "edit_mode": "all",
      "readonly": true,
      "caption": "description"
    },
    {
      "target": "is_enabled",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "all",
      "readonly": false,
      "caption": "enabled"
    },
    {
      "caption": "thermoregulation running",
      "target": "thermoregulation_running",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false
    },
    {
      "caption": "core temperature (degC)",
      "target": "core_temp",
      "type": "number",
      "delta": 0.1,
      "factor": 1,
      "rounding": 2,
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": true
    },
    {
      "caption": "skin temperature (degC)",
      "target": "skin_temp",
      "type": "number",
      "delta": 0.1,
      "factor": 1,
      "rounding": 2,
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": true
    },
    {
      "caption": "set-point temperature (degC)",
      "target": "setpoint_temp",
      "type": "number",
      "delta": 0.1,
      "factor": 1,
      "rounding": 1,
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false
    },
    {
      "caption": "environment temperature (degC)",
      "target": "env_temp",
      "type": "number",
      "delta": 0.5,
      "factor": 1,
      "rounding": 1,
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false
    },
    {
      "caption": "radiant-warmer temperature (degC)",
      "target": "radiant_temp",
      "type": "number",
      "delta": 0.5,
      "factor": 1,
      "rounding": 1,
      "build_prop": true,
      "edit_mode": "extra",
      "readonly": false
    },
    {
      "caption": "relative humidity (fraction)",
      "target": "rel_humidity",
      "type": "number",
      "delta": 0.05,
      "factor": 1,
      "rounding": 2,
      "ll": 0,
      "ul": 1,
      "build_prop": true,
      "edit_mode": "extra",
      "readonly": false
    },
    {
      "caption": "Q10 of metabolic rate",
      "target": "q10",
      "type": "number",
      "delta": 0.1,
      "factor": 1,
      "rounding": 2,
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "brown-fat heat gain (W/degC)",
      "target": "bat_gain",
      "type": "number",
      "delta": 0.5,
      "factor": 1,
      "rounding": 2,
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "heart-rate temperature gain",
      "target": "hr_temp_gain",
      "type": "number",
      "delta": 0.01,
      "factor": 1,
      "rounding": 3,
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    }
  ],
  "Glucose": [
    {
      "target": "description",
      "type": "string",
      "build_prop": true,
      "edit_mode": "all",
      "readonly": true,
      "caption": "description"
    },
    {
      "target": "is_enabled",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "all",
      "readonly": false,
      "caption": "enabled"
    },
    {
      "caption": "glucose controller running",
      "target": "glucose_running",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false
    },
    {
      "caption": "arterial glucose (mmol/L)",
      "target": "glucose",
      "type": "number",
      "delta": 0.1,
      "factor": 1,
      "rounding": 2,
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": true
    },
    {
      "caption": "glucose set-point (mmol/L)",
      "target": "glucose_setpoint",
      "type": "number",
      "delta": 0.1,
      "factor": 1,
      "rounding": 2,
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false
    },
    {
      "caption": "hepatic glucose production (mmol/kg/min)",
      "target": "hgp_rate",
      "type": "number",
      "delta": 0.005,
      "factor": 1,
      "rounding": 4,
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false
    },
    {
      "caption": "glucose utilization (mmol/kg/min)",
      "target": "glu_use_rate",
      "type": "number",
      "delta": 0.005,
      "factor": 1,
      "rounding": 4,
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "insulin activity",
      "target": "insulin",
      "type": "number",
      "delta": 0.1,
      "factor": 1,
      "rounding": 3,
      "build_prop": true,
      "edit_mode": "extra",
      "readonly": true
    },
    {
      "caption": "counter-regulatory activity",
      "target": "counterreg",
      "type": "number",
      "delta": 0.1,
      "factor": 1,
      "rounding": 3,
      "build_prop": true,
      "edit_mode": "extra",
      "readonly": true
    }
  ],
  "Lactate": [
    {
      "target": "description",
      "type": "string",
      "build_prop": true,
      "edit_mode": "all",
      "readonly": true,
      "caption": "description"
    },
    {
      "target": "is_enabled",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "all",
      "readonly": false,
      "caption": "enabled"
    },
    {
      "caption": "lactate production running",
      "target": "lactate_running",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false
    },
    {
      "caption": "arterial lactate (mmol/L)",
      "target": "arterial_lactate",
      "type": "number",
      "delta": 0.1,
      "factor": 1,
      "rounding": 2,
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": true
    },
    {
      "caption": "baseline lactate (mmol/L)",
      "target": "lact_baseline",
      "type": "number",
      "delta": 0.1,
      "factor": 1,
      "rounding": 2,
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false
    },
    {
      "caption": "anaerobic threshold (fraction of resting to2)",
      "target": "threshold_frac",
      "type": "number",
      "delta": 0.05,
      "factor": 1,
      "rounding": 2,
      "ll": 0,
      "ul": 1,
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "lactate per O2 deficit (mmol/mmol)",
      "target": "lact_per_o2_deficit",
      "type": "number",
      "delta": 0.01,
      "factor": 1,
      "rounding": 3,
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    },
    {
      "caption": "lactate clearance rate (1/s)",
      "target": "lact_clearance",
      "type": "number",
      "delta": 0.0005,
      "factor": 1,
      "rounding": 4,
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false
    }
  ],
  "Surfactant": [
    {
      "target": "description",
      "type": "string",
      "build_prop": true,
      "edit_mode": "all",
      "readonly": true,
      "caption": "description"
    },
    {
      "target": "is_enabled",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "all",
      "readonly": false,
      "caption": "enabled"
    },
    {
      "caption": "recruitment running",
      "target": "surfactant_running",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false
    },
    {
      "caption": "surfactant maturity (0-1)",
      "target": "surfactant",
      "type": "number",
      "delta": 0.05,
      "factor": 1,
      "rounding": 2,
      "ll": 0,
      "ul": 1,
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false
    },
    {
      "caption": "instill surfactant (therapy)",
      "target": "administer_surfactant",
      "type": "function",
      "build_prop": false,
      "edit_mode": "basic",
      "readonly": false,
      "args": [
        {
          "target": "target",
          "caption": "target maturity (0-1)",
          "type": "number",
          "factor": 1,
          "default": 0.9,
          "delta": 0.05,
          "rounding": 2,
          "ll": 0,
          "ul": 1
        }
      ]
    },
    {
      "caption": "open alveolar fraction",
      "target": "open_fraction",
      "type": "number",
      "factor": 1,
      "rounding": 3,
      "edit_mode": "basic",
      "readonly": true
    },
    {
      "caption": "transpulmonary pressure (mmHg)",
      "target": "transpulmonary_pressure",
      "type": "number",
      "factor": 1,
      "rounding": 2,
      "edit_mode": "extra",
      "readonly": true
    },
    {
      "caption": "applied lung elastance factor",
      "target": "el_lung_factor",
      "type": "number",
      "factor": 1,
      "rounding": 3,
      "edit_mode": "extra",
      "readonly": true
    },
    {
      "caption": "applied diffusion factor",
      "target": "dif_factor",
      "type": "number",
      "factor": 1,
      "rounding": 3,
      "edit_mode": "extra",
      "readonly": true
    },
    {
      "caption": "applied shunt-resistance factor",
      "target": "ips_factor",
      "type": "number",
      "factor": 1,
      "rounding": 3,
      "edit_mode": "extra",
      "readonly": true
    }
  ],
  "Brain": [
    {
      "target": "description",
      "type": "string",
      "build_prop": true,
      "edit_mode": "all",
      "readonly": true,
      "caption": "description"
    },
    {
      "target": "is_enabled",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "all",
      "readonly": false,
      "caption": "enabled"
    },
    {
      "caption": "brain controller running",
      "target": "brain_running",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false
    },
    {
      "caption": "autoregulation enabled",
      "target": "autoregulation_enabled",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false
    },
    {
      "caption": "autoregulation gain (1=intact, 0=pressure-passive)",
      "target": "autoregulation_gain",
      "type": "number",
      "delta": 0.1,
      "factor": 1,
      "rounding": 2,
      "ll": 0,
      "ul": 1,
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false
    },
    {
      "caption": "ICP coupling enabled",
      "target": "icp_enabled",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false
    },
    {
      "caption": "set intracranial oedema (mL)",
      "target": "set_edema",
      "type": "function",
      "build_prop": false,
      "edit_mode": "basic",
      "readonly": false,
      "args": [
        {
          "target": "volume_ml",
          "caption": "oedema / mass volume (mL)",
          "type": "number",
          "factor": 1,
          "default": 10,
          "delta": 1,
          "rounding": 1,
          "ll": 0,
          "ul": 40
        }
      ]
    },
    {
      "caption": "cerebral blood flow (L/min)",
      "target": "cbf",
      "type": "number",
      "factor": 1,
      "rounding": 3,
      "edit_mode": "basic",
      "readonly": true
    },
    {
      "caption": "cerebral perfusion pressure (mmHg)",
      "target": "cpp",
      "type": "number",
      "factor": 1,
      "rounding": 1,
      "edit_mode": "basic",
      "readonly": true
    },
    {
      "caption": "intracranial pressure (mmHg)",
      "target": "icp",
      "type": "number",
      "factor": 1,
      "rounding": 1,
      "edit_mode": "basic",
      "readonly": true
    },
    {
      "caption": "brain tissue O2 (mmol/L)",
      "target": "brain_to2",
      "type": "number",
      "factor": 1,
      "rounding": 3,
      "edit_mode": "extra",
      "readonly": true
    },
    {
      "caption": "applied arteriole resistance factor",
      "target": "autoreg_factor",
      "type": "number",
      "factor": 1,
      "rounding": 3,
      "edit_mode": "extra",
      "readonly": true
    }
  ],
  "Mob": [
    {
      "target": "model_type",
      "type": "string",
      "build_prop": false,
      "edit_mode": "basic",
      "readonly": true,
      "caption": "model type"
    },
    {
      "target": "description",
      "type": "string",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": true,
      "caption": "description"
    },
    {
      "target": "is_enabled",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "caption": "enabled"
    },
    {
      "caption": "myocardial oxygen balance",
      "target": "mob_active",
      "type": "boolean"
    },
    {
      "caption": "minimal to2 (mmol/l)",
      "target": "to2_min",
      "type": "number",
      "delta": 0.0001,
      "factor": 1,
      "rounding": 4
    },
    {
      "caption": "reference to2 (mmol/l)",
      "target": "to2_ref",
      "type": "number",
      "delta": 0.0001,
      "factor": 1,
      "rounding": 4
    },
    {
      "caption": "respiratory quotient",
      "target": "resp_q",
      "type": "number",
      "delta": 0.01,
      "factor": 1,
      "rounding": 2
    },
    {
      "caption": "basal mvo2 (mmol O2/g/s)",
      "target": "bm_vo2_per_g",
      "type": "number",
      "delta": 0.000001,
      "factor": 1,
      "rounding": 8
    },
    {
      "caption": "stroke-work mvo2 (mmol O2/g/(mmHg·mL))",
      "target": "sw_vo2_per_g",
      "type": "number",
      "delta": 1e-8,
      "factor": 1,
      "rounding": 10
    },
    {
      "caption": "heart weight intercept (g)",
      "target": "hw_intercept",
      "type": "number",
      "delta": 0.001,
      "factor": 1,
      "rounding": 3
    },
    {
      "caption": "heart weight slope (g per g body weight)",
      "target": "hw_slope",
      "type": "number",
      "delta": 0.000001,
      "factor": 1,
      "rounding": 6
    },
    {
      "caption": "heartrate factor min",
      "target": "hr_factor_min",
      "type": "number",
      "delta": 0.01,
      "factor": 1,
      "rounding": 2
    },
    {
      "caption": "heartrate factor max",
      "target": "hr_factor_max",
      "type": "number",
      "delta": 0.01,
      "factor": 1,
      "rounding": 2
    },
    {
      "caption": "heartrate time constant",
      "target": "hr_tc",
      "type": "number",
      "delta": 0.1,
      "factor": 1,
      "rounding": 1
    },
    {
      "caption": "contractility factor min",
      "target": "cont_factor_min",
      "type": "number",
      "delta": 0.01,
      "factor": 1,
      "rounding": 2
    },
    {
      "caption": "contractility factor max",
      "target": "cont_factor_max",
      "type": "number",
      "delta": 0.01,
      "factor": 1,
      "rounding": 2
    },
    {
      "caption": "contractility time constant",
      "target": "cont_tc",
      "type": "number",
      "delta": 0.1,
      "factor": 1,
      "rounding": 1
    },
    {
      "caption": "ans factor min",
      "target": "ans_factor_min",
      "type": "number",
      "delta": 0.01,
      "factor": 1,
      "rounding": 2
    },
    {
      "caption": "ans factor max",
      "target": "ans_factor_max",
      "type": "number",
      "delta": 0.01,
      "factor": 1,
      "rounding": 2
    },
    {
      "caption": "ans time constant",
      "target": "ans_tc",
      "type": "number",
      "delta": 0.1,
      "factor": 1,
      "rounding": 1
    }
  ],
  "HeartFunction": [
    {
      "target": "model_type",
      "type": "string",
      "build_prop": false,
      "edit_mode": "basic",
      "readonly": true,
      "caption": "model type"
    },
    {
      "target": "description",
      "type": "string",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": true,
      "caption": "description"
    },
    {
      "target": "is_enabled",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "caption": "enabled"
    },
    {
      "caption": "load-induced compromise active",
      "target": "hf_active",
      "type": "boolean"
    },
    {
      "caption": "remodeling active",
      "target": "remodel_active",
      "type": "boolean"
    },
    {
      "caption": "acute contractility time constant (s)",
      "target": "cont_tc",
      "type": "number",
      "delta": 1,
      "factor": 1,
      "rounding": 1
    },
    {
      "caption": "acute contractility floor",
      "target": "cont_floor",
      "type": "number",
      "delta": 0.01,
      "factor": 1,
      "rounding": 2
    },
    {
      "caption": "afterload gain LV",
      "target": "g_es_lv",
      "type": "number",
      "delta": 0.001,
      "factor": 1,
      "rounding": 4,
      "edit_mode": "advanced"
    },
    {
      "caption": "over-dilation gain LV",
      "target": "g_ed_lv",
      "type": "number",
      "delta": 0.001,
      "factor": 1,
      "rounding": 4,
      "edit_mode": "advanced"
    },
    {
      "caption": "afterload gain RV",
      "target": "g_es_rv",
      "type": "number",
      "delta": 0.001,
      "factor": 1,
      "rounding": 4,
      "edit_mode": "advanced"
    },
    {
      "caption": "over-dilation gain RV",
      "target": "g_ed_rv",
      "type": "number",
      "delta": 0.001,
      "factor": 1,
      "rounding": 4,
      "edit_mode": "advanced"
    },
    {
      "caption": "remodeling time constant (s)",
      "target": "remodel_tc",
      "type": "number",
      "delta": 60,
      "factor": 1,
      "rounding": 0,
      "edit_mode": "advanced"
    },
    {
      "caption": "wall-stress averaging time constant (s)",
      "target": "stress_avg_tc",
      "type": "number",
      "delta": 1,
      "factor": 1,
      "rounding": 1,
      "edit_mode": "advanced"
    },
    {
      "caption": "concentric remodeling drive",
      "target": "k_conc",
      "type": "number",
      "delta": 0.001,
      "factor": 1,
      "rounding": 4,
      "edit_mode": "advanced"
    },
    {
      "caption": "eccentric remodeling drive",
      "target": "k_ecc",
      "type": "number",
      "delta": 0.001,
      "factor": 1,
      "rounding": 4,
      "edit_mode": "advanced"
    },
    {
      "caption": "setpoint warm-up window (s)",
      "target": "setpoint_warmup",
      "type": "number",
      "delta": 1,
      "factor": 1,
      "rounding": 0,
      "edit_mode": "advanced"
    },
    {
      "caption": "LV end-systolic wall stress",
      "target": "wall_stress_es_lv",
      "type": "number",
      "factor": 1,
      "rounding": 1,
      "readonly": true
    },
    {
      "caption": "LV end-diastolic wall stress",
      "target": "wall_stress_ed_lv",
      "type": "number",
      "factor": 1,
      "rounding": 1,
      "readonly": true
    },
    {
      "caption": "RV end-systolic wall stress",
      "target": "wall_stress_es_rv",
      "type": "number",
      "factor": 1,
      "rounding": 1,
      "readonly": true
    },
    {
      "caption": "RV end-diastolic wall stress",
      "target": "wall_stress_ed_rv",
      "type": "number",
      "factor": 1,
      "rounding": 1,
      "readonly": true
    },
    {
      "caption": "LV acute load factor",
      "target": "el_max_load_factor_lv",
      "type": "number",
      "factor": 1,
      "rounding": 3,
      "readonly": true
    },
    {
      "caption": "RV acute load factor",
      "target": "el_max_load_factor_rv",
      "type": "number",
      "factor": 1,
      "rounding": 3,
      "readonly": true
    }
  ],
  "Monitor": [
    {
      "target": "model_type",
      "type": "string",
      "build_prop": false,
      "edit_mode": "basic",
      "readonly": true,
      "caption": "model type"
    },
    {
      "target": "description",
      "type": "string",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": true,
      "caption": "description"
    },
    {
      "target": "is_enabled",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "caption": "enabled"
    }
  ],
  "Pda": [
    {
      "target": "description",
      "type": "string",
      "build_prop": true,
      "edit_mode": "caption",
      "readonly": true,
      "caption": "description"
    },
    {
      "target": "is_enabled",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "all",
      "readonly": false,
      "caption": "enabled"
    },
    {
      "caption": "ductus diameter (%)",
      "target": "diameter_relative",
      "type": "number",
      "delta": 1,
      "factor": 100,
      "rounding": 0,
      "ul": 100,
      "ll": 0,
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "slider": true
    },
    {
      "caption": "max diameter aortic ampulla (mm)",
      "target": "diameter_ao_max",
      "type": "number",
      "delta": 0.1,
      "factor": 1,
      "rounding": 1,
      "build_prop": true,
      "edit_mode": "extra",
      "readonly": false
    },
    {
      "caption": "max diameter pulmonary end (mm)",
      "target": "diameter_pa_max",
      "type": "number",
      "delta": 0.1,
      "factor": 1,
      "rounding": 1,
      "build_prop": true,
      "edit_mode": "extra",
      "readonly": false
    },
    {
      "caption": "ductus arteriosus length (mm)",
      "target": "length",
      "type": "number",
      "delta": 0.1,
      "factor": 1,
      "rounding": 1,
      "build_prop": true,
      "edit_mode": "extra",
      "readonly": false
    },
    {
      "caption": "orifice discharge coefficient",
      "target": "discharge_coeff",
      "type": "number",
      "delta": 0.05,
      "factor": 1,
      "rounding": 2,
      "ul": 1,
      "ll": 0.3,
      "build_prop": true,
      "edit_mode": "extra",
      "readonly": false
    }
  ],
  "Placenta": [
    {
      "target": "description",
      "type": "string",
      "build_prop": true,
      "edit_mode": "caption",
      "readonly": true,
      "caption": "description"
    },
    {
      "target": "is_enabled",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "all",
      "readonly": false,
      "caption": "enabled"
    },
    {
      "target": "placenta_running",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "caption",
      "readonly": false,
      "caption": "placenta model running"
    },
    {
      "target": "umb_clamped",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "caption",
      "readonly": false,
      "caption": "umbilical vessels clamped"
    },
    {
      "target": "skip_mat_gas_write",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "advanced",
      "readonly": false,
      "caption": "maternal pool driven externally (uterine coupling)"
    },
    {
      "caption": "umb artery resistance factor",
      "target": "umb_art_res_factor",
      "type": "factor",
      "delta": 0.01,
      "rounding": 2,
      "ll": 0,
      "ul": 100
    },
    {
      "caption": "umb vein resistance factor",
      "target": "umb_ven_res_factor",
      "type": "factor",
      "delta": 0.01,
      "rounding": 2,
      "ll": 0,
      "ul": 100
    },
    {
      "caption": "fetal placenta resistance factor",
      "target": "plf_res_factor",
      "type": "factor",
      "delta": 0.01,
      "rounding": 2,
      "ll": 0,
      "ul": 10
    },
    {
      "target": "umb_art_res",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "caption": "umb artery resistance (mmHg*s/L)",
      "factor": 1,
      "delta": 1,
      "rounding": 0,
      "ll": 100,
      "ul": 100000
    },
    {
      "target": "umb_ven_res",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "caption": "umb vein resistance (mmHg*s/L)",
      "factor": 1,
      "delta": 1,
      "rounding": 0,
      "ll": 100,
      "ul": 100000
    },
    {
      "target": "plf_res",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "caption": "fetal plac resistance (mmHg*s/L)",
      "factor": 1,
      "delta": 1,
      "rounding": 0,
      "ll": 100,
      "ul": 100000
    },
    {
      "caption": "o2 diffusion constant",
      "target": "dif_o2",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "factor": 1,
      "delta": 0.0001,
      "rounding": 4,
      "ll": 0,
      "ul": 0.1
    },
    {
      "caption": "co2 dioxide diffusion constant",
      "target": "dif_co2",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "factor": 1,
      "delta": 0.0001,
      "rounding": 4,
      "ll": 0,
      "ul": 0.1
    },
    {
      "target": "mat_to2",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "caption": "mat plac o2 content (mmol/L)",
      "factor": 1,
      "delta": 1,
      "rounding": 0,
      "ll": 0,
      "ul": 10
    },
    {
      "target": "mat_tco2",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "caption": "mat plac co2 content (mmol/L)",
      "factor": 1,
      "delta": 1,
      "rounding": 0,
      "ll": 20,
      "ul": 30
    }
  ],
  "Resistor": [
    {
      "target": "model_type",
      "type": "string",
      "build_prop": false,
      "edit_mode": "basic",
      "readonly": true,
      "caption": "model type"
    },
    {
      "target": "description",
      "type": "string",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": true,
      "caption": "description"
    },
    {
      "target": "is_enabled",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "caption": "enabled"
    },
    {
      "caption": "no flow allowed",
      "target": "no_flow",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "basic"
    },
    {
      "caption": "no back flow allowed",
      "target": "no_back_flow",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "basic"
    },
    {
      "caption": "forward resistance",
      "target": "r_for",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "delta": 1,
      "factor": 1,
      "rounding": 0
    },
    {
      "caption": "backward resistance",
      "target": "r_back",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "delta": 1,
      "factor": 1,
      "rounding": 0
    },
    {
      "caption": "non linear resistance coefficient",
      "target": "r_k",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "delta": 1,
      "factor": 1,
      "rounding": 0
    },
    {
      "type": "list",
      "caption": "comp from",
      "target": "comp_from",
      "build_prop": true,
      "edit_mode": "basic",
      "options": [
        "BloodCapacitance",
        "BloodTimeVaryingElastance",
        "BloodPump",
        "BloodVessel",
        "MicroVascularUnit",
        "HeartChamber",
        "GasCapacitance"
      ]
    },
    {
      "type": "list",
      "caption": "comp to",
      "target": "comp_to",
      "build_prop": true,
      "edit_mode": "basic",
      "options": [
        "BloodCapacitance",
        "BloodTimeVaryingElastance",
        "BloodPump",
        "BloodVessel",
        "MicroVascularUnit",
        "HeartChamber",
        "GasCapacitance"
      ]
    },
    {
      "caption": "resistance factor",
      "target": "r_factor_ps",
      "type": "factor"
    },
    {
      "caption": "non linear resistance coefficient factor",
      "target": "r_k_factor_ps",
      "type": "factor"
    },
    {
      "target": "is_externally_managed",
      "type": "boolean",
      "build_prop": false,
      "edit_mode": "basic",
      "readonly": true,
      "caption": "externally managed"
    }
  ],
  "Respiration": [
    {
      "target": "description",
      "type": "string",
      "build_prop": true,
      "edit_mode": "caption",
      "readonly": true,
      "caption": "description"
    },
    {
      "target": "is_enabled",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "all",
      "readonly": false,
      "caption": "enabled"
    },
    {
      "caption": "lungs",
      "build_prop": true,
      "edit_mode": "extra",
      "readonly": false,
      "target": "lungs",
      "type": "multiple-list",
      "options": [
        "GasCapacitance"
      ]
    },
    {
      "caption": "thorax",
      "build_prop": true,
      "edit_mode": "extra",
      "readonly": false,
      "target": "thorax",
      "type": "multiple-list",
      "options": [
        "Container"
      ]
    },
    {
      "caption": "lung elastance factor",
      "target": "el_lungs_factor",
      "type": "factor",
      "build_prop": true,
      "edit_mode": "factors",
      "readonly": false,
      "factor": 1,
      "delta": 0.01,
      "rounding": 2,
      "ll": -10,
      "ul": 10
    },
    {
      "caption": "thorax elastance factor",
      "target": "el_thorax_factor",
      "type": "factor",
      "build_prop": true,
      "edit_mode": "factors",
      "readonly": false,
      "factor": 1,
      "delta": 0.01,
      "rounding": 2,
      "ll": -10,
      "ul": 10
    },
    {
      "caption": "upper airway resistance factor",
      "target": "res_upper_airways_factor",
      "type": "factor",
      "build_prop": true,
      "edit_mode": "factors",
      "readonly": false,
      "factor": 1,
      "delta": 0.01,
      "rounding": 2,
      "ll": -100,
      "ul": 100
    },
    {
      "caption": "lower airway resistance factor",
      "target": "res_lower_airways_factor",
      "type": "factor",
      "build_prop": true,
      "edit_mode": "factors",
      "readonly": false,
      "factor": 1,
      "delta": 0.01,
      "rounding": 2,
      "ll": -100,
      "ul": 100
    },
    {
      "caption": "gasexchange factor",
      "target": "gex_factor",
      "type": "factor",
      "build_prop": true,
      "edit_mode": "factors",
      "readonly": false,
      "factor": 1,
      "delta": 0.01,
      "rounding": 2,
      "ll": -100,
      "ul": 100
    }
  ],
  "Resuscitation": [
    {
      "target": "description",
      "type": "string",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": true,
      "caption": "description"
    },
    {
      "target": "is_enabled",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "all",
      "readonly": false,
      "caption": "enabled"
    },
    {
      "caption": "switch cpr on/off",
      "target": "switch_cpr",
      "type": "function",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "args": [
        {
          "caption": "state",
          "target": "cpr_enabled",
          "type": "boolean"
        }
      ]
    },
    {
      "caption": "chest compressions frequency (/min)",
      "target": "chest_comp_freq",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "delta": 1,
      "factor": 1,
      "rounding": 0,
      "ll": 10,
      "ul": 150
    },
    {
      "caption": "chest compressions pressure (mmHg)",
      "target": "chest_comp_max_pres",
      "type": "number",
      "build_prop": true,
      "edit_mode": "extra",
      "readonly": false,
      "delta": 1,
      "factor": 1,
      "rounding": 0,
      "ll": 0,
      "ul": 500
    },
    {
      "caption": "no of chest compressions (/cycle)",
      "target": "chest_comp_no",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "delta": 1,
      "factor": 1,
      "rounding": 0,
      "ll": 0,
      "ul": 30
    },
    {
      "caption": "continuous compressions",
      "target": "chest_comp_cont",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false
    },
    {
      "caption": "ventilation frequency (/min)",
      "target": "vent_freq",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "delta": 1,
      "factor": 1,
      "rounding": 0,
      "ll": 0,
      "ul": 100
    },
    {
      "caption": "no of ventilation (/cycle)",
      "target": "vent_no",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "delta": 1,
      "factor": 1,
      "rounding": 0,
      "ll": 0,
      "ul": 100
    },
    {
      "caption": "ventilation peak pressure (cmH2O)",
      "target": "vent_pres_pip",
      "type": "number",
      "build_prop": true,
      "edit_mode": "extra",
      "readonly": false,
      "delta": 1,
      "factor": 1,
      "rounding": 0,
      "ll": 0,
      "ul": 50
    },
    {
      "caption": "ventilation peep (cmH2O)",
      "target": "vent_pres_peep",
      "type": "number",
      "build_prop": true,
      "edit_mode": "extra",
      "readonly": false,
      "delta": 1,
      "factor": 1,
      "rounding": 0,
      "ll": 0,
      "ul": 10
    },
    {
      "caption": "ventilation inspiration time (s)",
      "target": "vent_insp_time",
      "type": "number",
      "build_prop": true,
      "edit_mode": "extra",
      "readonly": false,
      "delta": 0.1,
      "factor": 1,
      "rounding": 1,
      "ll": 0.1,
      "ul": 5
    },
    {
      "caption": "set cpr fio2",
      "target": "set_fio2",
      "type": "function",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "args": [
        {
          "caption": "new fio2",
          "target": "vent_fio2",
          "type": "number",
          "delta": 0.01,
          "factor": 1,
          "ul": 1,
          "ll": 0,
          "rounding": 2
        }
      ]
    },
    {
      "caption": "chest compression targets (weight per compartment)",
      "target": "chest_comp_targets",
      "type": "dict",
      "build_prop": true,
      "edit_mode": "advanced",
      "dict_value_type": "number"
    },
    {
      "target": "chest_comp_pres",
      "type": "number",
      "edit_mode": "advanced",
      "readonly": true,
      "caption": "chest compression pressure (mmHg)",
      "factor": 1,
      "rounding": 1
    }
  ],
  "Shunts": [
    {
      "target": "description",
      "type": "string",
      "build_prop": true,
      "edit_mode": "caption",
      "readonly": true,
      "caption": "description"
    },
    {
      "target": "is_enabled",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "all",
      "readonly": false,
      "caption": "enabled"
    },
    {
      "caption": "foramen ovale diameter (mm)",
      "target": "diameter_fo",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "delta": 0.1,
      "factor": 1,
      "rounding": 1,
      "slider": true,
      "ll": 0,
      "ul": 20
    },
    {
      "caption": "ventricular septal defect diameter (mm)",
      "target": "diameter_vsd",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "delta": 0.1,
      "factor": 1,
      "rounding": 1,
      "slider": true,
      "ll": 0,
      "ul": 20
    },
    {
      "caption": "intrapulmonary shunt resistance",
      "target": "ips_res",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "delta": 1,
      "factor": 1,
      "rounding": 0,
      "slider": true,
      "ll": 10,
      "ul": 50000
    },
    {
      "caption": "atrial septum width (mm)",
      "target": "atrial_septal_width",
      "type": "number",
      "build_prop": true,
      "edit_mode": "extra",
      "readonly": false,
      "delta": 0.1,
      "factor": 1,
      "rounding": 1,
      "ll": 0,
      "ul": 10
    },
    {
      "caption": "ventricular septum width (mm)",
      "target": "ventricular_septal_width",
      "type": "number",
      "build_prop": true,
      "edit_mode": "extra",
      "readonly": false,
      "delta": 0.1,
      "factor": 1,
      "rounding": 1,
      "ll": 0,
      "ul": 10
    },
    {
      "caption": "foramen ovale L-R resistance factor",
      "target": "fo_lr_factor",
      "type": "number",
      "build_prop": true,
      "edit_mode": "extra",
      "readonly": false,
      "delta": 0.1,
      "factor": 1,
      "rounding": 1,
      "ll": 0,
      "ul": 100
    },
    {
      "caption": "intrapulmonary shunt resistance (mmHg*s/L)",
      "target": "ips_res",
      "type": "number",
      "build_prop": true,
      "edit_mode": "extra",
      "readonly": false,
      "delta": 100,
      "factor": 1,
      "rounding": 0,
      "ll": 0,
      "ul": 100000000
    }
  ],
  "TimeVaryingElastance": [
    {
      "target": "model_type",
      "type": "string",
      "build_prop": false,
      "edit_mode": "basic",
      "readonly": true,
      "caption": "model type"
    },
    {
      "target": "description",
      "type": "string",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": true,
      "caption": "description"
    },
    {
      "target": "is_enabled",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "caption": "enabled"
    },
    {
      "caption": "volume (L)",
      "target": "vol",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "factor": 1,
      "delta": 0.001,
      "rounding": 3
    },
    {
      "caption": "unstressed volume (L)",
      "target": "u_vol",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "factor": 1,
      "delta": 0.001,
      "rounding": 3
    },
    {
      "caption": "elastance minimum (mmHg/L)",
      "target": "el_min",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "factor": 1,
      "delta": 1,
      "rounding": 0
    },
    {
      "caption": "elastance maximum (mmHg/L)",
      "target": "el_max",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "factor": 1,
      "delta": 1,
      "rounding": 0
    },
    {
      "caption": "elastance non linear k",
      "target": "el_k",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "factor": 1,
      "delta": 1,
      "rounding": 0
    },
    {
      "caption": "unstressed volume factor",
      "target": "u_vol_factor_ps",
      "type": "factor"
    },
    {
      "caption": "elastance minimum baseline factor",
      "target": "el_min_factor_ps",
      "type": "factor"
    },
    {
      "caption": "elastance maximum baseline factor",
      "target": "el_max_factor_ps",
      "type": "factor"
    },
    {
      "caption": "elastance non linear factor",
      "target": "el_k_factor_ps",
      "type": "factor"
    }
  ],
  "Ventilator": [
    {
      "target": "description",
      "type": "string",
      "build_prop": true,
      "edit_mode": "caption",
      "readonly": true,
      "caption": "description"
    },
    {
      "target": "is_enabled",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "all",
      "readonly": false,
      "caption": "enabled"
    },
    {
      "caption": "switch ventilator on/off",
      "target": "switch_ventilator",
      "type": "function",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "args": [
        {
          "caption": "state",
          "target": "is_enabled",
          "type": "boolean"
        }
      ]
    },
    {
      "caption": "endotracheal tube diameter (mm)",
      "target": "set_ettube_diameter",
      "type": "function",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "args": [
        {
          "caption": "new diameter (mm)",
          "target": "ettube_diameter",
          "type": "number",
          "factor": 1,
          "delta": 0.5,
          "rounding": 1
        }
      ]
    },
    {
      "caption": "endotracheal tube length (mm)",
      "target": "set_ettube_length",
      "type": "function",
      "build_prop": true,
      "edit_mode": "extra",
      "readonly": false,
      "args": [
        {
          "caption": "new length (mm)",
          "target": "ettube_length",
          "type": "number",
          "factor": 1,
          "delta": 0.1,
          "rounding": 1
        }
      ]
    },
    {
      "caption": "fio2",
      "target": "set_fio2",
      "type": "function",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "args": [
        {
          "caption": "new fio2",
          "target": "fio2",
          "type": "number",
          "factor": 1,
          "delta": 0.01,
          "rounding": 2,
          "ll": 0.21,
          "ul": 1
        }
      ]
    },
    {
      "caption": "humidity",
      "target": "set_humidity",
      "type": "function",
      "build_prop": true,
      "edit_mode": "extra",
      "readonly": false,
      "args": [
        {
          "caption": "new humidity",
          "target": "humidity",
          "type": "number",
          "factor": 1,
          "delta": 0.01,
          "rounding": 2,
          "ll": 0,
          "ul": 1
        }
      ]
    },
    {
      "caption": "temperature (C)",
      "target": "set_temp",
      "type": "function",
      "build_prop": true,
      "edit_mode": "extra",
      "readonly": false,
      "args": [
        {
          "caption": "new temp (C)",
          "target": "temp",
          "type": "number",
          "factor": 1,
          "delta": 0.1,
          "rounding": 1,
          "ll": 0,
          "ul": 42
        }
      ]
    },
    {
      "caption": "ventilator mode",
      "target": "vent_mode",
      "type": "list",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "options": [],
      "choices": [
        "PC",
        "PRVC",
        "PS",
        "CPAP"
      ]
    },
    {
      "caption": "ventilator rate (/min)",
      "target": "vent_rate",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "delta": 1,
      "factor": 1,
      "rounding": 0,
      "ll": 0,
      "ul": 100
    },
    {
      "caption": "inspiration time (s)",
      "target": "insp_time",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "delta": 0.1,
      "factor": 1,
      "rounding": 1,
      "ll": 0.1,
      "ul": 5
    },
    {
      "caption": "inspiratory flow (l/min)",
      "target": "insp_flow",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "delta": 0.1,
      "factor": 1,
      "rounding": 1,
      "ll": 0,
      "ul": 20
    },
    {
      "caption": "expiratory flow (l/min)",
      "target": "exp_flow",
      "type": "number",
      "build_prop": true,
      "edit_mode": "extra",
      "readonly": false,
      "delta": 0.1,
      "factor": 1,
      "rounding": 1,
      "ll": 0,
      "ul": 20
    },
    {
      "caption": "tidal volume (mL)",
      "target": "tidal_volume",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "delta": 1,
      "factor": 1000,
      "rounding": 0,
      "ll": 1,
      "ul": 500
    },
    {
      "caption": "peak inspiratory pressure (cmH2O)",
      "target": "pip_cmh2o",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "delta": 1,
      "factor": 1,
      "rounding": 0,
      "ll": 5,
      "ul": 50
    },
    {
      "caption": "max peak inspiratory pressure (cmH2O)",
      "target": "pip_cmh2o_max",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "delta": 1,
      "factor": 1,
      "rounding": 0,
      "ll": 5,
      "ul": 50
    },
    {
      "caption": "positive end expiratory pressure (cmH2O)",
      "target": "peep_cmh2o",
      "type": "number",
      "build_prop": true,
      "edit_mode": "basic",
      "readonly": false,
      "delta": 1,
      "factor": 1,
      "rounding": 0,
      "ll": 0,
      "ul": 20
    },
    {
      "caption": "trigger volume percentage (%)",
      "target": "trigger_volume_perc",
      "type": "number",
      "build_prop": true,
      "edit_mode": "extra",
      "readonly": false,
      "delta": 0.1,
      "factor": 1,
      "rounding": 1,
      "ll": 5,
      "ul": 20
    },
    {
      "caption": "synchronized ventilation",
      "target": "synchronized",
      "type": "boolean",
      "build_prop": true,
      "edit_mode": "extra",
      "readonly": false
    },
    {
      "caption": "trigger a manual breath",
      "target": "trigger_breath",
      "type": "function",
      "edit_mode": "basic",
      "readonly": false,
      "args": []
    },
    {
      "target": "pres",
      "type": "number",
      "edit_mode": "advanced",
      "readonly": true,
      "caption": "airway pressure (cmH2O)",
      "factor": 1,
      "rounding": 1
    },
    {
      "target": "flow",
      "type": "number",
      "edit_mode": "advanced",
      "readonly": true,
      "caption": "flow (L/min)",
      "factor": 1,
      "rounding": 1
    },
    {
      "target": "vol",
      "type": "number",
      "edit_mode": "advanced",
      "readonly": true,
      "caption": "volume (mL)",
      "factor": 1,
      "rounding": 1
    },
    {
      "target": "exp_tidal_volume",
      "type": "number",
      "edit_mode": "advanced",
      "readonly": true,
      "caption": "expiratory tidal volume (mL)",
      "factor": 1000,
      "rounding": 1
    },
    {
      "target": "insp_tidal_volume",
      "type": "number",
      "edit_mode": "advanced",
      "readonly": true,
      "caption": "inspiratory tidal volume (mL)",
      "factor": 1000,
      "rounding": 1
    },
    {
      "target": "tv_kg",
      "type": "number",
      "edit_mode": "advanced",
      "readonly": true,
      "caption": "tidal volume per kg (mL/kg)",
      "factor": 1,
      "rounding": 1
    },
    {
      "target": "minute_volume",
      "type": "number",
      "edit_mode": "advanced",
      "readonly": true,
      "caption": "minute volume (L/min)",
      "factor": 1,
      "rounding": 2
    },
    {
      "target": "compliance",
      "type": "number",
      "edit_mode": "advanced",
      "readonly": true,
      "caption": "compliance (mL/cmH2O)",
      "factor": 1,
      "rounding": 1
    },
    {
      "target": "etco2",
      "type": "number",
      "edit_mode": "advanced",
      "readonly": true,
      "caption": "end-tidal co2 (mmHg)",
      "factor": 1,
      "rounding": 0
    }
  ]
};

// Resolve the editable interface for a given model_type (empty if unknown).
// Custom models win over built-ins, so a student entry can also override one.
export function getInterfaceForType(modelType: string): InterfaceField[] {
  return CUSTOM_MODEL_INTERFACES[modelType] ?? MODEL_INTERFACES[modelType] ?? [];
}
