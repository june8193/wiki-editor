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
        end: textEnd
      })
      lineStart = i + 1
    }
  }

  return lines
}

function findLineIndexAtOffset(lines: readonly LineSpan[], offset: number): number {
  const clamped = Math.max(0, offset)
  for (let i = 0; i < lines.length; i += 1) {
    if (i === lines.length - 1 || clamped < lines[i + 1].start) {
      return i
    }
  }
  return 0
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
      ALIGNMENT_SPECS[alignment].minWidth,
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

interface RewriteTableInput {
  markdown: string
  context: TableContext
  header: readonly string[]
  alignments: readonly TableAlignment[]
  bodyRows: readonly string[][]
  cursorRow: number
  cursorCol: number
}

function applyTableRewrite({
  markdown,
  context,
  header,
  alignments,
  bodyRows,
  cursorRow,
  cursorCol
}: RewriteTableInput): TableEditResult {
  const lineEnding = markdown.includes('\r\n') ? '\r\n' : '\n'
  const tableLines = serializeTableLines(header, alignments, bodyRows)
  const replacement = tableLines.join(lineEnding)
  const content =
    markdown.slice(0, context.startOffset) + replacement + markdown.slice(context.endOffset)
  const cursorOffset = computeCellCursorOffset(
    context.startOffset,
    tableLines,
    cursorRow,
    cursorCol,
    lineEnding
  )
  return { content, cursorOffset }
}

function normalizeRowCells(cells: readonly string[], columnCount: number): string[] {
  return Array.from({ length: columnCount }, (_, idx) => cells[idx] ?? '')
}

function locateTableBlock(
  lines: readonly LineSpan[],
  fencedMask: readonly boolean[],
  cursorLineIndex: number
): { headerLine: number; endLine: number; alignments: TableAlignment[] } | null {
  const isPipeLine = (idx: number): boolean =>
    idx >= 0 && idx < lines.length && !fencedMask[idx] && splitTableRow(lines[idx].text).hasPipe

  if (!isPipeLine(cursorLineIndex)) return null

  let startLine = cursorLineIndex
  while (isPipeLine(startLine - 1)) startLine -= 1

  let endLine = cursorLineIndex
  while (isPipeLine(endLine + 1)) endLine += 1

  for (let i = startLine; i < endLine; i += 1) {
    const alignments = parseSeparatorAlignments(lines[i + 1].text)
    if (alignments && splitTableRow(lines[i].text).hasPipe) {
      return cursorLineIndex < i ? null : { headerLine: i, endLine, alignments }
    }
  }

  return null
}

function resolveTableCursor(
  lines: readonly LineSpan[],
  headerLine: number,
  cursorLineIndex: number,
  offset: number,
  columnCount: number
): { colIndex: number; section: TableSection; bodyRowIndex: number } {
  const currentLineParsed = splitTableRow(lines[cursorLineIndex].text)
  const colInLine = Math.max(0, offset - lines[cursorLineIndex].start)
  const colIndex = getColumnIndexInLine(currentLineParsed, colInLine, columnCount)

  if (cursorLineIndex === headerLine) {
    return { colIndex, section: 'header', bodyRowIndex: -1 }
  }
  if (cursorLineIndex === headerLine + 1) {
    return { colIndex, section: 'separator', bodyRowIndex: -1 }
  }
  return { colIndex, section: 'body', bodyRowIndex: cursorLineIndex - (headerLine + 2) }
}

/**
 * Detects a GFM pipe table surrounding the given character offset, ignoring fenced code blocks.
 */
export function detectTableAtOffset(markdown: string, offset: number): TableContext | null {
  const lines = splitLinesWithOffsets(markdown)
  if (lines.length < 2) return null

  const fencedMask = computeFencedLineMask(lines)
  const cursorLineIndex = findLineIndexAtOffset(lines, offset)
  const block = locateTableBlock(lines, fencedMask, cursorLineIndex)
  if (!block) return null

  const headerParsed = splitTableRow(lines[block.headerLine].text)
  const columnCount = Math.max(headerParsed.cells.length, block.alignments.length)
  const normalizedAlignments = Array.from(
    { length: columnCount },
    (_, c) => block.alignments[c] ?? 'none'
  )

  const bodyRows: string[][] = []
  for (let r = block.headerLine + 2; r <= block.endLine; r += 1) {
    bodyRows.push(normalizeRowCells(splitTableRow(lines[r].text).cells, columnCount))
  }

  const cursor = resolveTableCursor(lines, block.headerLine, cursorLineIndex, offset, columnCount)

  return {
    startLine: block.headerLine,
    endLine: block.endLine,
    startOffset: lines[block.headerLine].start,
    endOffset: lines[block.endLine].end,
    lineIndex: cursorLineIndex,
    section: cursor.section,
    bodyRowIndex: cursor.bodyRowIndex,
    colIndex: cursor.colIndex,
    columnCount,
    alignments: normalizedAlignments,
    header: normalizeRowCells(headerParsed.cells, columnCount),
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
  return applyTableRewrite({
    markdown,
    context,
    header: context.header,
    alignments: context.alignments,
    bodyRows: context.bodyRows,
    cursorRow: context.lineIndex - context.startLine,
    cursorCol: context.colIndex
  })
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
  return applyTableRewrite({
    markdown,
    context,
    header: context.header,
    alignments: context.alignments,
    bodyRows: nextBodyRows,
    cursorRow: 2 + insertBodyIndex,
    cursorCol: context.colIndex
  })
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

  return applyTableRewrite({
    markdown,
    context,
    header: nextHeader,
    alignments: nextAlignments,
    bodyRows: nextBodyRows,
    cursorRow: context.lineIndex - context.startLine,
    cursorCol: insertCol
  })
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

  return applyTableRewrite({
    markdown,
    context,
    header: context.header,
    alignments: context.alignments,
    bodyRows: nextBodyRows,
    cursorRow: targetRowInTable,
    cursorCol: context.colIndex
  })
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

  return applyTableRewrite({
    markdown,
    context,
    header: nextHeader,
    alignments: nextAlignments,
    bodyRows: nextBodyRows,
    cursorRow: context.lineIndex - context.startLine,
    cursorCol: Math.min(removeCol, nextHeader.length - 1)
  })
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

  // Collapse double blank lines left when both sides had blank-line separation around the table
  if (nextBefore.endsWith('\r\n\r\n') && nextAfter.startsWith('\r\n')) {
    nextAfter = nextAfter.slice(2)
  } else if (nextBefore.endsWith('\n\n') && nextAfter.startsWith('\n')) {
    nextAfter = nextAfter.slice(1)
  }

  return {
    content: `${nextBefore}${nextAfter}`,
    cursorOffset: nextBefore.length
  }
}
