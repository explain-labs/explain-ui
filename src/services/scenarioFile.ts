// Wrap a raw engine state as a complete, reloadable scenario file: the state goes under
// model_definition, and every other top-level key of the currently loaded file (user,
// description, provenance, diagram/animation/configuration, and any key added later) is kept,
// in its original order. Those don't live in the engine state, so a save that listed them by
// hand silently dropped the ones it didn't know (e.g. provenance).
export function scenarioFile(
  base: Record<string, unknown> | null | undefined,
  name: string,
  state: unknown,
): Record<string, unknown> {
  const { model_definition: _old, ...meta } = base ?? {};
  return { ...meta, name, model_definition: state };
}
