// Discovery has independently refreshed tabs. Ignore stale responses after a
// filter/project change, and keep the last successful data on a failed refresh.
export function createDiscoveryReader(onState) {
  let generation = 0
  const latest = new Map()
  return {
    invalidate() { generation++; latest.clear() },
    async run(key, read, apply) {
      const scope = generation
      const request = Symbol(key)
      latest.set(key, request)
      const current = () => generation === scope && latest.get(key) === request
      onState(key, { loading: true, error: '' })
      try {
        const value = await read()
        if (!current()) return
        apply(value)
        onState(key, { loading: false, error: '' })
      } catch (error) {
        if (current()) onState(key, { loading: false, error: error?.message || 'The request failed. Please retry.' })
      }
    },
  }
}
