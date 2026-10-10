/** Pass Factory model IDs through; the CLI owns model availability. */
export function normalizeRequestedModel(model) {
  return model == null ? null : String(model).trim() || null;
}
