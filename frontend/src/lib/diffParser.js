/**
 * Parse unified diff text into structured lines for rendering.
 * @param {string} rawDiff - Raw unified diff output from git
 * @returns {Array<{type: string, text: string, lineOld?: number, lineNew?: number}>}
 */
export function parseDiffLines(rawDiff) {
  if (!rawDiff) return []
  const lines = rawDiff.split('\n')
  const result = []
  let lineOld = 0
  let lineNew = 0

  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      result.push({ type: 'file-header', text: line })
    } else if (line.startsWith('---') || line.startsWith('+++')) {
      result.push({ type: 'file-header', text: line })
    } else if (line.startsWith('@@')) {
      // Parse hunk header: @@ -oldStart,oldCount +newStart,newCount @@
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      if (match) {
        lineOld = parseInt(match[1], 10)
        lineNew = parseInt(match[2], 10)
      }
      result.push({ type: 'hunk-header', text: line })
    } else if (line.startsWith('+')) {
      result.push({ type: 'add', text: line, lineNew })
      lineNew++
    } else if (line.startsWith('-')) {
      result.push({ type: 'remove', text: line, lineOld })
      lineOld++
    } else if (line.startsWith(' ')) {
      result.push({ type: 'context', text: line, lineOld, lineNew })
      lineOld++
      lineNew++
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file"
      result.push({ type: 'info', text: line })
    } else if (line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file') || line.startsWith('old mode') || line.startsWith('new mode') || line.startsWith('similarity') || line.startsWith('rename') || line.startsWith('Binary')) {
      result.push({ type: 'info', text: line })
    } else if (line.trim() === '') {
      // Skip empty trailing lines
    } else {
      result.push({ type: 'context', text: line, lineOld, lineNew })
      lineOld++
      lineNew++
    }
  }
  return result
}

/**
 * Split a combined diff into per-file sections.
 * @param {string} rawDiff
 * @returns {Array<{file: string, diff: string}>}
 */
export function splitDiffByFile(rawDiff) {
  if (!rawDiff) return []
  const sections = []
  const parts = rawDiff.split(/^(?=diff --git )/m)

  for (const part of parts) {
    if (!part.trim()) continue
    // Extract filename from "diff --git a/path b/path"
    const match = part.match(/^diff --git a\/.+ b\/(.+)/)
    const file = match ? match[1] : 'unknown'
    sections.push({ file, diff: part })
  }
  return sections
}
