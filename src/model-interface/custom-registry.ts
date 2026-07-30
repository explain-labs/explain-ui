// STUDENT EXTENSION POINT — parameter-edit schema for your own model classes.
//
// The built-in schema lives in registry.ts, a single large generated file. Rather than
// editing that (and colliding with everyone else), add an entry here keyed by your
// model_type. Entries here take precedence over registry.ts, so you can also override
// the schema of a built-in model without touching it.
//
// Example:
//
//   export const CUSTOM_MODEL_INTERFACES: Record<string, InterfaceField[]> = {
//     "TimBaroreflexV2": [
//       { target: "description", type: "string", caption: "description",
//         build_prop: true, edit_mode: "all", readonly: true },
//       { target: "is_enabled", type: "boolean", caption: "is enabled",
//         build_prop: true, edit_mode: "all", readonly: false },
//       { target: "gain", type: "number", caption: "response gain",
//         edit_mode: "basic", factor: 1, delta: 0.1, rounding: 2, ll: 0, ul: 5 },
//     ],
//   };
//
// A model_type with no entry still runs — it just shows no editable fields in the app.
// See InterfaceField in ./types.ts for every supported field option.
//
// This file is intentionally EMPTY on main — add entries only on your own branch.
// Keeping main empty is what makes rebasing your branch onto main conflict-free.

import type { InterfaceField } from "./types";

export const CUSTOM_MODEL_INTERFACES: Record<string, InterfaceField[]> = {};
