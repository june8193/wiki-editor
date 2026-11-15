export type UnifiedDiffLineType = 'context' | 'add' | 'delete' | 'note'

export interface UnifiedDiffLine {
  type: UnifiedDiffLineType
  marker: ' ' | '+' | '-' | '\\'
  oldLineNumber: number | null
  newLineNumber: number | null
  content: string
}

export interface UnifiedDiffHunk {
  header: string
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: UnifiedDiffLine[]
}

export interface ParsedUnifiedDiff {
  hunks: UnifiedDiffHunk[]
}

export type UnifiedDiffInlineRow =
  | { kind: 'hunk'; header: string }
  | {
      kind: 'line'
      lineType: UnifiedDiffLineType
      marker: ' ' | '+' | '-' | '\\'
      oldLineNumber: number | null
      newLineNumber: number | null
      content: string
    }

export interface UnifiedDiffSideCell {
  type: UnifiedDiffLineType
  marker: ' ' | '+' | '-' | '\\'
  lineNumber: number | null
  content: string
}

export type UnifiedDiffSideRowKind = 'context' | 'change' | 'add' | 'delete' | 'note'

export type UnifiedDiffSideBySideRow =
  | { kind: 'hunk'; header: string }
  | {
      kind: 'pair'
      rowKind: UnifiedDiffSideRowKind
      oldCell: UnifiedDiffSideCell | null
      newCell: UnifiedDiffSideCell | null
    }

const HUNK_HEADER_REGEX = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/

/**
 * Parses a unified diff patch into structured hunks with accurate old/new line numbers.
 */
export function parseUnifiedDiff(rawPatch: string): ParsedUnifiedDiff {
  if (!rawPatch) {
    return { hunks: [] }
  }

  const hunks: UnifiedDiffHunk[] = []
  let currentHunk: UnifiedDiffHunk | null = null
  let oldLine = 0
  let newLine = 0
  let remainingOld = 0
  let remainingNew = 0

  const flushHunk = (): void => {
    if (currentHunk) {
      hunks.push(currentHunk)
      currentHunk = null
    }
  }

  for (const rawLine of rawPatch.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    const expectingHunkLine = currentHunk !== null && (remainingOld > 0 || remainingNew > 0)

    if (!expectingHunkLine) {
      if (line.startsWith('diff --git ')) {
        flushHunk()
        continue
      }
      const match = HUNK_HEADER_REGEX.exec(line)
      if (match) {
        flushHunk()
        const oldStart = Number.parseInt(match[1], 10)
        const oldCount = match[2] !== undefined ? Number.parseInt(match[2], 10) : 1
        const newStart = Number.parseInt(match[3], 10)
        const newCount = match[4] !== undefined ? Number.parseInt(match[4], 10) : 1
        currentHunk = {
          header: line,
          oldStart,
          oldCount,
          newStart,
          newCount,
          lines: []
        }
        oldLine = oldStart
        newLine = newStart
        remainingOld = oldCount
        remainingNew = newCount
        continue
      }
    }

    if (!currentHunk) {
      continue
    }

    if (line.startsWith('\\ ')) {
      currentHunk.lines.push({
        type: 'note',
        marker: '\\',
        oldLineNumber: null,
        newLineNumber: null,
        content: line.slice(2)
      })
      continue
    }

    const prefix = line[0]
    if (prefix === ' ' || line === '') {
      // Tolerate trailing empty line only if still inside hunk; ignore trailing patch newline outside hunk
      if (line === '' && remainingOld === 0 && remainingNew === 0) {
        flushHunk()
        continue
      }
      if (line === '') {
        continue
      }
      currentHunk.lines.push({
        type: 'context',
        marker: ' ',
        oldLineNumber: oldLine,
        newLineNumber: newLine,
        content: line.slice(1)
      })
      oldLine += 1
      newLine += 1
      remainingOld = Math.max(0, remainingOld - 1)
      remainingNew = Math.max(0, remainingNew - 1)
      continue
    }

    if (prefix === '-') {
      currentHunk.lines.push({
        type: 'delete',
        marker: '-',
        oldLineNumber: oldLine,
        newLineNumber: null,
        content: line.slice(1)
      })
      oldLine += 1
      remainingOld = Math.max(0, remainingOld - 1)
      continue
    }

    if (prefix === '+') {
      currentHunk.lines.push({
        type: 'add',
        marker: '+',
        oldLineNumber: null,
        newLineNumber: newLine,
        content: line.slice(1)
      })
      newLine += 1
      remainingNew = Math.max(0, remainingNew - 1)
    }
  }

  flushHunk()
  return { hunks }
}

/**
 * Flattens parsed hunks into inline (unified) diff rows with dual line-number columns.
 */
export function buildInlineDiffRows(parsed: ParsedUnifiedDiff): UnifiedDiffInlineRow[] {
  const rows: UnifiedDiffInlineRow[] = []
  for (const hunk of parsed.hunks) {
    rows.push({ kind: 'hunk', header: hunk.header })
    for (const line of hunk.lines) {
      rows.push({
        kind: 'line',
        lineType: line.type,
        marker: line.marker,
        oldLineNumber: line.oldLineNumber,
        newLineNumber: line.newLineNumber,
        content: line.content
      })
    }
  }
  return rows
}

function toSideCell(line: UnifiedDiffLine, side: 'old' | 'new'): UnifiedDiffSideCell {
  return {
    type: line.type,
    marker: line.marker,
    lineNumber: side === 'old' ? line.oldLineNumber : line.newLineNumber,
    content: line.content
  }
}

/**
 * Aligns consecutive delete (`-`) and add (`+`) blocks row-by-row for Side-by-Side display.
 */
export function buildSideBySideDiffRows(parsed: ParsedUnifiedDiff): UnifiedDiffSideBySideRow[] {
  const rows: UnifiedDiffSideBySideRow[] = []

  for (const hunk of parsed.hunks) {
    rows.push({ kind: 'hunk', header: hunk.header })
    let deletedRun: UnifiedDiffLine[] = []
    let addedRun: UnifiedDiffLine[] = []
    let lastChangedSide: 'old' | 'new' | 'both' = 'both'

    const flushChangeRuns = (): void => {
      if (deletedRun.length === 0 && addedRun.length === 0) {
        return
      }
      const pairCount = Math.max(deletedRun.length, addedRun.length)
      for (let i = 0; i < pairCount; i += 1) {
        const delLine = deletedRun[i]
        const addLine = addedRun[i]
        const oldCell = delLine ? toSideCell(delLine, 'old') : null
        const newCell = addLine ? toSideCell(addLine, 'new') : null
        const rowKind: UnifiedDiffSideRowKind =
          oldCell && newCell ? 'change' : oldCell ? 'delete' : 'add'
        rows.push({ kind: 'pair', rowKind, oldCell, newCell })
      }
      lastChangedSide =
        addedRun.length === 0 ? 'old' : deletedRun.length === 0 ? 'new' : 'both'
      deletedRun = []
      addedRun = []
    }

    for (const line of hunk.lines) {
      if (line.type === 'delete') {
        if (addedRun.length > 0) {
          flushChangeRuns()
        }
        deletedRun.push(line)
        continue
      }
      if (line.type === 'add') {
        addedRun.push(line)
        continue
      }

      if (line.type === 'note') {
        const sideHint = addedRun.length > 0 ? 'new' : deletedRun.length > 0 ? 'old' : lastChangedSide
        flushChangeRuns()
        const noteCell = toSideCell(line, 'new')
        rows.push({
          kind: 'pair',
          rowKind: 'note',
          oldCell: sideHint === 'old' || sideHint === 'both' ? noteCell : null,
          newCell: sideHint === 'new' || sideHint === 'both' ? noteCell : null
        })
        continue
      }

      flushChangeRuns()
      rows.push({
        kind: 'pair',
        rowKind: 'context',
        oldCell: toSideCell(line, 'old'),
        newCell: toSideCell(line, 'new')
      })
      lastChangedSide = 'both'
    }

    flushChangeRuns()
  }

  return rows
}
