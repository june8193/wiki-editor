export type TableAlignment = 'left' | 'center' | 'right' | 'none'

export type TableSection = 'header' | 'separator' | 'body'

export interface TableContext {
  startLine: number
  endLine: number
  startOffset: number
  endOffset: number
  lineIndex: number
  section: TableSection
  bodyRowIndex: number
  colIndex: number
  columnCount: number
  alignments: TableAlignment[]
  header: string[]
  bodyRows: string[][]
}

export interface TableEditResult {
  content: string
  cursorOffset: number
}

interface LineSpan {
  text: string
  start: number
  end: number
}

interface ParsedRow {
  cells: string[]
  cellBounds: Array<{ startCol: number; endCol: number }>
  hasPipe: boolean
}

const FENCE_OPEN_RE = /^[ ]{0,3}(`{3,}|~{3,})(.*)$/
const SEPARATOR_CELL_RE = /^:?-+:?$/

function splitLinesWithOffsets(markdown: string): LineSpan[] {
  const lines: LineSpan[] = []
  let lineStart = 0

  for (let i = 0; i <= markdown.length; i += 1) {
    if (i === markdown.length || markdown[i] === '\n') {
      const rawEnd = i
      const textEnd = rawEnd > lineStart && markdown[rawEnd - 1] === '\r' ? rawEnd - 1 : rawEnd
      lines.push({
        text: markdown.slice(lineStart, textEnd),
        start: lineStart,
        end: rawEnd
      })
      lineStart = i + 1
    }
  }

  return lines
}

function findLineIndexAtOffset(lines: readonly LineSpan[], offset: number): number {
  const clamped = Math.max(0, offset)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (clamped >= line.start && clamped <= line.end) {
      return i
    }
  }
  return Math.max(0, lines.length - 1)
}

function computeFencedLineMask(lines: readonly LineSpan[]): boolean[] {
  const inFence = new Array<boolean>(lines.length).fill(false)
  let activeChar: '`' | '~' | null = null
  let activeLen = 0

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].text
    if (activeChar === null) {
      const match = FENCE_OPEN_RE.exec(line)
      if (match) {
        const marker = match[1]
        const info = match[2]
        const char = marker[0] as '`' | '~'
        if (char === '`' && info.includes('`')) {
          continue
        }
        activeChar = char
        activeLen = marker.length
        inFence[i] = true
      }
      continue
    }

    inFence[i] = true
    const trimmed = line.trim()
    if (
      trimmed.length >= activeLen &&
      [...trimmed].every((ch) => ch === activeChar)
    ) {
      activeChar = null
      activeLen = 0
    }
  }

  return inFence
}

function splitTableRow(line: string): ParsedRow {
  const pipeIndices: number[] = []
  let i = 0

  while (i < line.length) {
    const ch = line[i]
    if (ch === '\\' && i + 1 < line.length) {
      i += 2
      continue
    }
    if (ch === '`') {
      let tickLen = 1
      while (i + tickLen < line.length && line[i + tickLen] === '`') {
        tickLen += 1
      }
      const closer = line.indexOf('`'.repeat(tickLen), i + tickLen)
      if (closer !== -1) {
        i = closer + tickLen
        continue
      }
      i += tickLen
      continue
    }
    if (ch === '|') {
      pipeIndices.push(i)
    }
    i += 1
  }

  if (pipeIndices.length === 0) {
    return {
      cells: [line.trim()],
      cellBounds: [{ startCol: 0, endCol: line.length }],
      hasPipe: false
    }
  }

  const trimmed = line.trim()
  const leadingTrimmedStart = line.length - line.trimStart().length
  const hasLeadingPipe = trimmed.startsWith('|') && pipeIndices[0] === leadingTrimmedStart
  const lastPipeIdx = pipeIndices[pipeIndices.length - 1]
  const hasTrailingPipe =
    trimmed.endsWith('|') &&
    pipeIndices.length > (hasLeadingPipe ? 1 : 0) &&
    line.slice(lastPipeIdx + 1).trim().length === 0

  const segments: Array<{ startCol: number; endCol: number }> = []
  let segStart = hasLeadingPipe ? pipeIndices[0] + 1 : 0
  const startPipeLoop = hasLeadingPipe ? 1 : 0

  for (let p = startPipeLoop; p < pipeIndices.length; p += 1) {
    segments.push({ startCol: segStart, endCol: pipeIndices[p] })
    segStart = pipeIndices[p] + 1
  }

  if (!hasTrailingPipe) {
    segments.push({ startCol: segStart, endCol: line.length })
  }

  return {
    cells: segments.map(({ startCol, endCol }) => line.slice(startCol, endCol).trim()),
    cellBounds: segments,
    hasPipe: true
  }
}

function parseSeparatorAlignments(line: string): TableAlignment[] | null {
  const parsed = splitTableRow(line)
  if (!parsed.hasPipe || parsed.cells.length === 0) {
    return null
  }

  const alignments: TableAlignment[] = []
  for (const cell of parsed.cells) {
    if (!SEPARATOR_CELL_RE.test(cell)) {
      return null
    }
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    if (left && right) {
      alignments.push('center')
    } else if (left) {
      alignments.push('left')
    } else if (right) {
      alignments.push('right')
    } else {
      alignments.push('none')
    }
  }
  return alignments
}

function getDisplayWidth(text: string): number {
  let width = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    const isWide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6)
    width += isWide ? 2 : 1
  }
  return width
}

interface AlignmentSpec {
  minWidth: number
  formatMarker: (width: number) => string
  padText: (trimmed: string, gap: number) => string
}

const ALIGNMENT_SPECS: Record<TableAlignment, AlignmentSpec> = {
  left: {
    minWidth: 4,
    formatMarker: (width) => `:${'-'.repeat(width - 1)}`,
    padText: (trimmed, gap) => `${trimmed}${' '.repeat(gap)}`
  },
  center: {
    minWidth: 5,
    formatMarker: (width) => `:${'-'.repeat(width - 2)}:`,
    padText: (trimmed, gap) => {
      const leftPad = Math.floor(gap / 2)
      return `${' '.repeat(leftPad)}${trimmed}${' '.repeat(gap - leftPad)}`
    }
  },
  right: {
    minWidth: 4,
    formatMarker: (width) => `${'-'.repeat(width - 1)}:`,
    padText: (trimmed, gap) => `${' '.repeat(gap)}${trimmed}`
  },
  none: {
    minWidth: 3,
    formatMarker: (width) => '-'.repeat(width),
    padText: (trimmed, gap) => `${trimmed}${' '.repeat(gap)}`
  }
}

function getMinAlignmentWidth(alignment: TableAlignment): number {
  return ALIGNMENT_SPECS[alignment].minWidth
}

function formatAlignmentMarker(alignment: TableAlignment, colWidth: number): string {
  const spec = ALIGNMENT_SPECS[alignment]
  return spec.formatMarker(Math.max(spec.minWidth, colWidth))
}

function padCellText(text: string, colWidth: number, alignment: TableAlignment): string {
  const trimmed = text.trim()
  const gap = Math.max(0, colWidth - getDisplayWidth(trimmed))
  return gap === 0 ? trimmed : ALIGNMENT_SPECS[alignment].padText(trimmed, gap)
}

function formatTableRowLine(
  cells: readonly string[],
  colWidths: readonly number[],
  alignments: readonly TableAlignment[],
  isSeparator = false
): string {
  const normalized: string[] = []
  for (let c = 0; c < colWidths.length; c += 1) {
    if (isSeparator) {
      normalized.push(formatAlignmentMarker(alignments[c] ?? 'none', colWidths[c]))
    } else {
      normalized.push(padCellText(cells[c] ?? '', colWidths[c], alignments[c] ?? 'none'))
    }
  }
  return `| ${normalized.join(' | ')} |`
}

function serializeTableLines(
  header: readonly string[],
  alignments: readonly TableAlignment[],
  bodyRows: readonly string[][]
): string[] {
  const columnCount = Math.max(1, alignments.length, header.length)
  const normAlignments: TableAlignment[] = []
  const colWidths: number[] = []

  for (let c = 0; c < columnCount; c += 1) {
    const alignment = alignments[c] ?? 'none'
    normAlignments.push(alignment)
    let width = Math.max(
      getMinAlignmentWidth(alignment),
      getDisplayWidth((header[c] ?? '').trim())
    )
    for (const row of bodyRows) {
      width = Math.max(width, getDisplayWidth((row[c] ?? '').trim()))
    }
    colWidths.push(width)
  }

  const lines = [
    formatTableRowLine(header, colWidths, normAlignments),
    formatTableRowLine([], colWidths, normAlignments, true)
  ]
  for (const row of bodyRows) {
    lines.push(formatTableRowLine(row, colWidths, normAlignments))
  }
  return lines
}

function getColumnIndexInLine(parsed: ParsedRow, colInLine: number, maxCols: number): number {
  for (let i = 0; i < parsed.cellBounds.length; i += 1) {
    const bound = parsed.cellBounds[i]
    if (colInLine <= bound.endCol) {
      return Math.min(i, Math.max(0, maxCols - 1))
    }
  }
  return Math.max(0, Math.min(parsed.cellBounds.length - 1, maxCols - 1))
}

function computeCellCursorOffset(
  tableStartOffset: number,
  tableLines: readonly string[],
  rowInTable: number,
  colIndex: number,
  lineEnding: string
): number {
  const clampedRow = Math.max(0, Math.min(rowInTable, tableLines.length - 1))
  let offset = tableStartOffset
  for (let r = 0; r < clampedRow; r += 1) {
    offset += tableLines[r].length + lineEnding.length
  }
  const targetLine = tableLines[clampedRow]
  const parsed = splitTableRow(targetLine)
  const clampedCol = Math.max(0, Math.min(colIndex, parsed.cellBounds.length - 1))
  const bound = parsed.cellBounds[clampedCol]
  if (!bound) {
    return offset
  }
  const rawSlice = targetLine.slice(bound.startCol, bound.endCol)
  const leadingSpaces = rawSlice.length - rawSlice.trimStart().length
  return offset + bound.startCol + (rawSlice.trim().length === 0 ? 1 : leadingSpaces)
}

function applyTableRewrite(
  markdown: string,
  context: TableContext,
  nextHeader: readonly string[],
  nextAlignments: readonly TableAlignment[],
  nextBodyRows: readonly string[][],
  cursorRowInTable: number,
  cursorColIndex: number
): TableEditResult {
  const lineEnding = markdown.includes('\r\n') ? '\r\n' : '\n'
  const tableLines = serializeTableLines(nextHeader, nextAlignments, nextBodyRows)
  const replacement = tableLines.join(lineEnding)
  const content =
    markdown.slice(0, context.startOffset) + replacement + markdown.slice(context.endOffset)
  const cursorOffset = computeCellCursorOffset(
    context.startOffset,
    tableLines,
    cursorRowInTable,
    cursorColIndex,
    lineEnding
  )
  return { content, cursorOffset }
}

/**
 * Detects a GFM pipe table surrounding the given character offset, ignoring fenced code blocks.
 */
export function detectTableAtOffset(markdown: string, offset: number): TableContext | null {
  const lines = splitLinesWithOffsets(markdown)
  if (lines.length < 2) return null

  const fencedMask = computeFencedLineMask(lines)
  const cursorLineIndex = findLineIndexAtOffset(lines, offset)
  if (fencedMask[cursorLineIndex]) return null

  const isTableLine = (idx: number): boolean => {
    if (idx < 0 || idx >= lines.length || fencedMask[idx]) return false
    return splitTableRow(lines[idx].text).hasPipe
  }

  if (!isTableLine(cursorLineIndex)) return null

  let startLine = cursorLineIndex
  while (startLine > 0 && isTableLine(startLine - 1)) {
    startLine -= 1
  }

  let endLine = cursorLineIndex
  while (endLine + 1 < lines.length && isTableLine(endLine + 1)) {
    endLine += 1
  }

  // Locate separator line inside the contiguous pipe block around cursor
  let headerLine = startLine
  let alignments = startLine + 1 <= endLine ? parseSeparatorAlignments(lines[startLine + 1].text) : null

  if (!alignments) {
    // Allow blocks where a non-table pipe line immediately precedes a real header + separator
    for (let i = startLine + 1; i < endLine; i += 1) {
      const candidate = parseSeparatorAlignments(lines[i + 1].text)
      if (candidate && splitTableRow(lines[i].text).hasPipe) {
        headerLine = i
        alignments = candidate
        startLine = i
        break
      }
    }
  }

  if (!alignments || cursorLineIndex < headerLine) {
    return null
  }

  const headerParsed = splitTableRow(lines[headerLine].text)
  if (!headerParsed.hasPipe) return null

  const columnCount = Math.max(headerParsed.cells.length, alignments.length)
  const normalizedAlignments: TableAlignment[] = []
  for (let c = 0; c < columnCount; c += 1) {
    normalizedAlignments.push(alignments[c] ?? 'none')
  }

  const bodyRows: string[][] = []
  for (let r = headerLine + 2; r <= endLine; r += 1) {
    const rowCells = splitTableRow(lines[r].text).cells
    const padded = Array.from({ length: columnCount }, (_, idx) => rowCells[idx] ?? '')
    bodyRows.push(padded)
  }

  const normalizedHeader = Array.from(
    { length: columnCount },
    (_, idx) => headerParsed.cells[idx] ?? ''
  )

  const currentLineParsed = splitTableRow(lines[cursorLineIndex].text)
  const colInLine = Math.max(0, offset - lines[cursorLineIndex].start)
  const colIndex = getColumnIndexInLine(currentLineParsed, colInLine, columnCount)

  let section: TableSection = 'body'
  let bodyRowIndex = cursorLineIndex - (headerLine + 2)
  if (cursorLineIndex === headerLine) {
    section = 'header'
    bodyRowIndex = -1
  } else if (cursorLineIndex === headerLine + 1) {
    section = 'separator'
    bodyRowIndex = -1
  }

  return {
    startLine: headerLine,
    endLine,
    startOffset: lines[headerLine].start,
    endOffset: lines[endLine].end,
    lineIndex: cursorLineIndex,
    section,
    bodyRowIndex,
    colIndex,
    columnCount,
    alignments: normalizedAlignments,
    header: normalizedHeader,
    bodyRows
  }
}

/**
 * Generates a clean GFM table snippet with the cursor positioned inside the first header cell.
 */
export function createTableTemplate(
  rows = 2,
  cols = 3,
  lineEnding = '\n'
): { markdown: string; cursorOffsetInSnippet: number } {
  const colCount = Math.max(1, cols)
  const bodyCount = Math.max(1, rows)
  const header = Array.from({ length: colCount }, (_, idx) => `열 ${idx + 1}`)
  const alignments = Array.from({ length: colCount }, () => 'none' as const)
  const bodyRows = Array.from({ length: bodyCount }, () =>
    Array.from({ length: colCount }, () => '')
  )
  const lines = serializeTableLines(header, alignments, bodyRows)
  const markdown = lines.join(lineEnding)
  const cursorOffsetInSnippet = computeCellCursorOffset(0, lines, 0, 0, lineEnding)
  return { markdown, cursorOffsetInSnippet }
}

function computeBoundaryNewlines(
  slice: string,
  edge: 'before' | 'after',
  lineEnding: string
): string {
  if (slice.length === 0) return ''
  const doubleBreak = `${lineEnding}${lineEnding}`
  if (edge === 'before') {
    if (slice.endsWith(doubleBreak) || slice.endsWith('\n\n')) return ''
    return slice.endsWith('\n') || slice.endsWith('\r') ? lineEnding : doubleBreak
  }
  if (slice.startsWith(doubleBreak) || slice.startsWith('\n\n')) return ''
  return slice.startsWith('\n') || slice.startsWith('\r') ? lineEnding : doubleBreak
}

/**
 * Inserts a formatted GFM table at the given cursor offset with surrounding blank line separation.
 */
export function insertMarkdownTable(
  markdown: string,
  offset: number,
  rows = 2,
  cols = 3
): TableEditResult {
  const clamped = Math.max(0, Math.min(offset, markdown.length))
  const lineEnding = markdown.includes('\r\n') ? '\r\n' : '\n'
  const { markdown: snippet, cursorOffsetInSnippet } = createTableTemplate(rows, cols, lineEnding)

  const before = markdown.slice(0, clamped)
  const after = markdown.slice(clamped)
  const leadingBreak = computeBoundaryNewlines(before, 'before', lineEnding)
  const trailingBreak = computeBoundaryNewlines(after, 'after', lineEnding)

  const content = `${before}${leadingBreak}${snippet}${trailingBreak}${after}`
  const cursorOffset = before.length + leadingBreak.length + cursorOffsetInSnippet
  return { content, cursorOffset }
}

/**
 * Normalizes table cell spacing and separator alignment syntax for the table at offset.
 */
export function formatTableAtOffset(markdown: string, offset: number): TableEditResult | null {
  const context = detectTableAtOffset(markdown, offset)
  if (!context) return null
  const rowInTable = context.lineIndex - context.startLine
  return applyTableRewrite(
    markdown,
    context,
    context.header,
    context.alignments,
    context.bodyRows,
    rowInTable,
    context.colIndex
  )
}

/**
 * Inserts a new empty row above or below the current table row.
 */
export function addTableRow(
  markdown: string,
  offset: number,
  position: 'above' | 'below'
): TableEditResult | null {
  const context = detectTableAtOffset(markdown, offset)
  if (!context) return null

  const emptyRow = Array.from({ length: context.columnCount }, () => '')
  const nextBodyRows = context.bodyRows.map((row) => [...row])

  let insertBodyIndex: number
  if (context.section !== 'body') {
    insertBodyIndex = 0
  } else {
    insertBodyIndex = position === 'above' ? context.bodyRowIndex : context.bodyRowIndex + 1
  }

  nextBodyRows.splice(insertBodyIndex, 0, emptyRow)
  return applyTableRewrite(
    markdown,
    context,
    context.header,
    context.alignments,
    nextBodyRows,
    2 + insertBodyIndex,
    context.colIndex
  )
}

/**
 * Inserts a new column to the left or right of the current table column.
 */
export function addTableColumn(
  markdown: string,
  offset: number,
  position: 'left' | 'right'
): TableEditResult | null {
  const context = detectTableAtOffset(markdown, offset)
  if (!context) return null

  const insertCol = position === 'left' ? context.colIndex : context.colIndex + 1
  const nextHeader = [...context.header]
  nextHeader.splice(insertCol, 0, '열')

  const nextAlignments = [...context.alignments]
  nextAlignments.splice(insertCol, 0, 'none')

  const nextBodyRows = context.bodyRows.map((row) => {
    const copy = [...row]
    copy.splice(insertCol, 0, '')
    return copy
  })

  const rowInTable = context.lineIndex - context.startLine
  return applyTableRewrite(
    markdown,
    context,
    nextHeader,
    nextAlignments,
    nextBodyRows,
    rowInTable,
    insertCol
  )
}

/**
 * Deletes the current body row while safely guarding header and separator rows.
 */
export function deleteTableRow(markdown: string, offset: number): TableEditResult | null {
  const context = detectTableAtOffset(markdown, offset)
  if (!context || context.section !== 'body') {
    return null
  }

  const nextBodyRows = context.bodyRows
    .filter((_, idx) => idx !== context.bodyRowIndex)
    .map((row) => [...row])

  const targetRowInTable =
    nextBodyRows.length === 0
      ? 0
      : 2 + Math.min(context.bodyRowIndex, nextBodyRows.length - 1)

  return applyTableRewrite(
    markdown,
    context,
    context.header,
    context.alignments,
    nextBodyRows,
    targetRowInTable,
    context.colIndex
  )
}

/**
 * Deletes the current column while guarding single-column tables from producing invalid syntax.
 */
export function deleteTableColumn(markdown: string, offset: number): TableEditResult | null {
  const context = detectTableAtOffset(markdown, offset)
  if (!context || context.columnCount <= 1) {
    return null
  }

  const removeCol = context.colIndex
  const nextHeader = context.header.filter((_, idx) => idx !== removeCol)
  const nextAlignments = context.alignments.filter((_, idx) => idx !== removeCol)
  const nextBodyRows = context.bodyRows.map((row) => row.filter((_, idx) => idx !== removeCol))

  const nextColIndex = Math.min(removeCol, nextHeader.length - 1)
  const rowInTable = context.lineIndex - context.startLine
  return applyTableRewrite(
    markdown,
    context,
    nextHeader,
    nextAlignments,
    nextBodyRows,
    rowInTable,
    nextColIndex
  )
}

/**
 * Removes the entire GFM table surrounding the cursor offset.
 */
export function deleteTable(markdown: string, offset: number): TableEditResult | null {
  const context = detectTableAtOffset(markdown, offset)
  if (!context) return null

  const before = markdown.slice(0, context.startOffset)
  const after = markdown.slice(context.endOffset)

  let nextBefore = before
  let nextAfter = after

  if (nextAfter.startsWith('\r\n')) {
    nextAfter = nextAfter.slice(2)
  } else if (nextAfter.startsWith('\n')) {
    nextAfter = nextAfter.slice(1)
  } else if (nextBefore.endsWith('\r\n')) {
    nextBefore = nextBefore.slice(0, -2)
  } else if (nextBefore.endsWith('\n')) {
    nextBefore = nextBefore.slice(0, -1)
  }

  return {
    content: `${nextBefore}${nextAfter}`,
    cursorOffset: nextBefore.length
  }
}
