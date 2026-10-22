// The host handles only opaque form contributions. Products own defaults,
// field names and serialization; absent products cannot inject/reset fields.
export function extensionSettingsValues(workspace, contributions) {
  return Object.assign({}, ...contributions.map((contribution) => contribution.initialValues?.(workspace) || {}))
}

export function extensionSettingsPayload(values, contributions) {
  return Object.assign({}, ...contributions.map((contribution) => contribution.serialize?.(values) || {}))
}
