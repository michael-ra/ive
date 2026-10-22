// cx — tiny classNames joiner. Flattens arrays, drops falsy, supports
// { 'class': condition } objects, joins with spaces. It does NOT resolve
// conflicts: with Tailwind the stylesheet order decides, not the order in the
// string. Use mergeClasses (./mergeClasses) when a caller must override.
export function cx(...parts) {
  const out = []
  for (const p of parts) {
    if (!p) continue
    if (typeof p === 'string') out.push(p)
    else if (Array.isArray(p)) { const s = cx(...p); if (s) out.push(s) }
    else if (typeof p === 'object') { for (const k in p) if (p[k]) out.push(k) }
  }
  return out.join(' ')
}

export default cx
