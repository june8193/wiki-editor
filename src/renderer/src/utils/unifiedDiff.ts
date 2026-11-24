export type UnifiedDiffLineType = 'context' | 'add' | 'delete' | 'note'

export interface DiffTextRange {
  from: number
  to: number
}

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
      wordHighlights?: DiffTextRange[]
    }

export interface UnifiedDiffSideCell {
  type: UnifiedDiffLineType
  marker: ' ' | '+' | '-' | '\\'
  lineNumber: number | null
  content: string
  wordHighlights?: DiffTextRange[]
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

const MAX_INTRA_LINE_LENGTH = 500
const MAX_INTRA_LINE_TOKENS = 200
const INTRA_LINE_TOKEN_REGEX = /(\s+|[\p{L}\p{N}_$]+|[^\s\p{L}\p{N}_$])/gu

interface DiffToken {
  text: string
  from: number
  to: number
}

function tokenizeLine(line: string): DiffToken[] {
  const tokens: DiffToken[] = []
  INTRA_LINE_TOKEN_REGEX.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = INTRA_LINE_TOKEN_REGEX.exec(line)) !== null) {
    tokens.push({
      text: match[0],
      from: match.index,
      to: match.index + match[0].length
    })
  }
  return tokens
}

function mergeTokenRanges(tokens: readonly DiffToken[], matched: readonly boolean[]): DiffTextRange[] {
  const ranges: DiffTextRange[] = []
  for (let i = 0; i < tokens.length; i += 1) {
    if (matched[i]) {
      continue
    }
    const token = tokens[i]
    const prev = ranges[ranges.length - 1]
    if (prev && prev.to === token.from) {
      prev.to = token.to
    } else {
      ranges.push({ from: token.from, to: token.to })
    }
  }
  return ranges
}

function computeIntraLineHighlights(
  oldText: string,
  newText: string
): { oldRanges: DiffTextRange[]; newRanges: DiffTextRange[] } {
  if (oldText === newText) {
    return { oldRanges: [], newRanges: [] }
  }

  const fullFallback = () => ({
    oldRanges: oldText.length > 0 ? [{ from: 0, to: oldText.length }] : [],
    newRanges: newText.length > 0 ? [{ from: 0, to: newText.length }] : []
  })

  if (oldText.length > MAX_INTRA_LINE_LENGTH || newText.length > MAX_INTRA_LINE_LENGTH) {
    return fullFallback()
  }

  const oldTokens = tokenizeLine(oldText)
  const newTokens = tokenizeLine(newText)

  let prefix = 0
  while (
    prefix < oldTokens.length &&
    prefix < newTokens.length &&
    oldTokens[prefix].text === newTokens[prefix].text
  ) {
    prefix += 1
  }

  let suffix = 0
  while (
    suffix < oldTokens.length - prefix &&
    suffix < newTokens.length - prefix &&
    oldTokens[oldTokens.length - 1 - suffix].text ===
      newTokens[newTokens.length - 1 - suffix].text
  ) {
    suffix += 1
  }

  const oldMidLen = oldTokens.length - prefix - suffix
  const newMidLen = newTokens.length - prefix - suffix

  if (oldMidLen > MAX_INTRA_LINE_TOKENS || newMidLen > MAX_INTRA_LINE_TOKENS) {
    return fullFallback()
  }

  const oldMatched = new Array<boolean>(oldTokens.length).fill(false)
  const newMatched = new Array<boolean>(newTokens.length).fill(false)

  for (let i = 0; i < prefix; i += 1) {
    oldMatched[i] = true
    newMatched[i] = true
  }
  for (let i = 0; i < suffix; i += 1) {
    oldMatched[oldTokens.length - 1 - i] = true
    newMatched[newTokens.length - 1 - i] = true
  }

  if (oldMidLen > 0 && newMidLen > 0) {
    const dp: number[][] = Array.from({ length: oldMidLen + 1 }, () =>
      new Array<number>(newMidLen + 1).fill(0)
    )
    for (let i = oldMidLen - 1; i >= 0; i -= 1) {
      const oldTok = oldTokens[prefix + i].text
      for (let j = newMidLen - 1; j >= 0; j -= 1) {
        if (oldTok === newTokens[prefix + j].text) {
          dp[i][j] = dp[i + 1][j + 1] + 1
        } else {
          dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1])
        }
      }
    }

    let i = 0
    let j = 0
    while (i < oldMidLen && j < newMidLen) {
      if (oldTokens[prefix + i].text === newTokens[prefix + j].text) {
        oldMatched[prefix + i] = true
        newMatched[prefix + j] = true
        i += 1
        j += 1
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        i += 1
      } else {
        j += 1
      }
    }
  }

  return {
    oldRanges: mergeTokenRanges(oldTokens, oldMatched),
    newRanges: mergeTokenRanges(newTokens, newMatched)
  }
}

function forEachHunkChangeRun(
  lines: readonly UnifiedDiffLine[],
  onChangeRun: (deletedRun: readonly UnifiedDiffLine[], addedRun: readonly UnifiedDiffLine[]) => void,
  onOtherLine?: (line: UnifiedDiffLine, pendingSideHint: 'old' | 'new' | null) => void
): void {
  let deletedRun: UnifiedDiffLine[] = []
  let addedRun: UnifiedDiffLine[] = []

  const flushRun = (): void => {
    if (deletedRun.length === 0 && addedRun.length === 0) {
      return
    }
    onChangeRun(deletedRun, addedRun)
    deletedRun = []
    addedRun = []
  }

  for (const line of lines) {
    if (line.type === 'delete') {
      if (addedRun.length > 0) {
        flushRun()
      }
      deletedRun.push(line)
      continue
    }
    if (line.type === 'add') {
      addedRun.push(line)
      continue
    }
    const pendingSideHint = addedRun.length > 0 ? 'new' : deletedRun.length > 0 ? 'old' : null
    flushRun()
    onOtherLine?.(line, pendingSideHint)
  }
  flushRun()
}

function buildHunkWordHighlightMap(hunk: UnifiedDiffHunk): Map<UnifiedDiffLine, DiffTextRange[]> {
  const map = new Map<UnifiedDiffLine, DiffTextRange[]>()
  forEachHunkChangeRun(hunk.lines, (deletedRun, addedRun) => {
    if (deletedRun.length > 0 && deletedRun.length === addedRun.length) {
      for (let i = 0; i < deletedRun.length; i += 1) {
        const delLine = deletedRun[i]
        const addLine = addedRun[i]
        const { oldRanges, newRanges } = computeIntraLineHighlights(
          delLine.content,
          addLine.content
        )
        if (oldRanges.length > 0) {
          map.set(delLine, oldRanges)
        }
        if (newRanges.length > 0) {
          map.set(addLine, newRanges)
        }
      }
    }
  })
  return map
}

/**
 * Flattens parsed hunks into inline (unified) diff rows with dual line-number columns.
 */
export function buildInlineDiffRows(parsed: ParsedUnifiedDiff): UnifiedDiffInlineRow[] {
  const rows: UnifiedDiffInlineRow[] = []
  for (const hunk of parsed.hunks) {
    rows.push({ kind: 'hunk', header: hunk.header })
    const wordHighlights = buildHunkWordHighlightMap(hunk)
    for (const line of hunk.lines) {
      rows.push({
        kind: 'line',
        lineType: line.type,
        marker: line.marker,
        oldLineNumber: line.oldLineNumber,
        newLineNumber: line.newLineNumber,
        content: line.content,
        wordHighlights: wordHighlights.get(line)
      })
    }
  }
  return rows
}

function toSideCell(
  line: UnifiedDiffLine,
  side: 'old' | 'new',
  wordHighlights?: DiffTextRange[]
): UnifiedDiffSideCell {
  return {
    type: line.type,
    marker: line.marker,
    lineNumber: side === 'old' ? line.oldLineNumber : line.newLineNumber,
    content: line.content,
    wordHighlights
  }
}

/**
 * Aligns consecutive delete (`-`) and add (`+`) blocks row-by-row for Side-by-Side display.
 */
export function buildSideBySideDiffRows(parsed: ParsedUnifiedDiff): UnifiedDiffSideBySideRow[] {
  const rows: UnifiedDiffSideBySideRow[] = []

  for (const hunk of parsed.hunks) {
    rows.push({ kind: 'hunk', header: hunk.header })
    const wordHighlights = buildHunkWordHighlightMap(hunk)
    let lastChangedSide: 'old' | 'new' | 'both' = 'both'

    forEachHunkChangeRun(
      hunk.lines,
      (deletedRun, addedRun) => {
        const pairCount = Math.max(deletedRun.length, addedRun.length)
        for (let i = 0; i < pairCount; i += 1) {
          const delLine = deletedRun[i]
          const addLine = addedRun[i]
          const oldCell = delLine
            ? toSideCell(delLine, 'old', wordHighlights.get(delLine))
            : null
          const newCell = addLine
            ? toSideCell(addLine, 'new', wordHighlights.get(addLine))
            : null
          const rowKind: UnifiedDiffSideRowKind =
            oldCell && newCell ? 'change' : oldCell ? 'delete' : 'add'
          rows.push({ kind: 'pair', rowKind, oldCell, newCell })
        }
        lastChangedSide =
          addedRun.length === 0 ? 'old' : deletedRun.length === 0 ? 'new' : 'both'
      },
      (line, pendingSideHint) => {
        if (line.type === 'note') {
          const sideHint = pendingSideHint ?? lastChangedSide
          const noteCell = toSideCell(line, 'new')
          rows.push({
            kind: 'pair',
            rowKind: 'note',
            oldCell: sideHint === 'old' || sideHint === 'both' ? noteCell : null,
            newCell: sideHint === 'new' || sideHint === 'both' ? noteCell : null
          })
          return
        }
        rows.push({
          kind: 'pair',
          rowKind: 'context',
          oldCell: toSideCell(line, 'old'),
          newCell: toSideCell(line, 'new')
        })
        lastChangedSide = 'both'
      }
    )
  }

  return rows
}
