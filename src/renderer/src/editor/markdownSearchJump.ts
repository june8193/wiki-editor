import type { Code, Content, Definition, Html, List, ListItem, Parent, Root, RootContent, Table } from 'mdast'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import {
  compileSearchMatcher,
  type CompiledSearchMatcher,
  type DocumentJumpLocation,
  splitSearchLines,
  type TextMatchSpan
} from '@shared/search'
import { isMermaidLanguage } from './codeBlockHighlight'
import { normalizeLineEndingsToLf } from './MarkdownTocEngine'

interface MarkdownBlockRange {
  startLine: number
  endLine: number
}

interface MarkdownJumpCandidateMatch {
  occurrenceInBlock: number
  contextBefore: string
  matchedText: string
  contextAfter: string
  codeSpan?: { start: number; end: number }
}

export interface NestedBlockHint {
  kind: 'list-item' | 'table-row'
  index: number
}

export interface MarkdownJumpPlan {
  lineNumber: number
  targetBlock: MarkdownBlockRange | null
  nestedItemIndex: NestedBlockHint | null
  renderedMatch: MarkdownJumpCandidateMatch | null
}

interface ContextualMatchCandidate<TRef> {
  ref: TRef
  contextBefore: string
  matchedText: string
  contextAfter: string
}

export type MarkdownTopBlockKind =
  | 'heading'
  | 'paragraph'
  | 'list'
  | 'blockquote'
  | 'table'
  | 'code'
  | 'thematicBreak'
  | 'html'

interface TopLevelMarkdownBlock extends MarkdownBlockRange {
  kind: MarkdownTopBlockKind
  plainText: string
  isMermaid: boolean
  isIndentedCode: boolean
  node: RootContent
}

interface RenderedBlockSummary {
  kind: MarkdownTopBlockKind
  plainText: string
  isMermaid: boolean
}

export type AlignedBlock<T extends RenderedBlockSummary> = T & MarkdownBlockRange

const CONTEXT_SLICE_LEN = 32
const mdastParser = unified().use(remarkParse).use(remarkGfm)

function computeLineStartOffsets(lines: readonly string[]): number[] {
  const offsets: number[] = []
  let offset = 0
  for (const line of lines) {
    offsets.push(offset)
    offset += line.length + 1
  }
  return offsets
}

function getNodeRange(node: { position?: { start?: { line?: number; offset?: number }; end?: { line?: number; offset?: number } } }): {
  startLine: number
  endLine: number
  startOffset: number
  endOffset: number
} | null {
  const startLine = node.position?.start?.line
  const endLine = node.position?.end?.line
  const startOffset = node.position?.start?.offset
  const endOffset = node.position?.end?.offset
  if (
    typeof startLine !== 'number' ||
    typeof endLine !== 'number' ||
    typeof startOffset !== 'number' ||
    typeof endOffset !== 'number'
  ) {
    return null
  }
  return { startLine, endLine, startOffset, endOffset }
}

function isFencedCodeRaw(rawSlice: string): boolean {
  const trimmed = rawSlice.trimStart()
  return trimmed.startsWith('```') || trimmed.startsWith('~~~')
}

function isClosingFenceLine(lineText: string, fenceChar: '`' | '~', fenceLen: number): boolean {
  const trimmed = lineText.replace(/^[ ]{0,3}/, '')
  let count = 0
  while (count < trimmed.length && trimmed[count] === fenceChar) {
    count += 1
  }
  return count >= fenceLen && /^[ \t]*$/.test(trimmed.slice(count))
}

function extractInlineCodeValueRange(
  content: string,
  nodeStart: number,
  nodeEnd: number
): { valueStart: number; valueEnd: number } {
  const raw = content.slice(nodeStart, nodeEnd)
  let tickCount = 0
  while (tickCount < raw.length && raw[tickCount] === '`') {
    tickCount += 1
  }
  if (tickCount === 0 || tickCount * 2 > raw.length) {
    return { valueStart: nodeStart, valueEnd: nodeEnd }
  }
  let valueStart = nodeStart + tickCount
  let valueEnd = nodeEnd - tickCount
  const inner = content.slice(valueStart, valueEnd)
  if (inner.length >= 2 && inner.startsWith(' ') && inner.endsWith(' ') && /[^ ]/.test(inner)) {
    valueStart += 1
    valueEnd -= 1
  }
  return { valueStart, valueEnd }
}

function extractPlainTextFromMdast(node: RootContent | Content): string {
  if (node.type === 'text' || node.type === 'inlineCode') {
    return node.value
  }
  if (node.type === 'code') {
    return isMermaidLanguage(node.lang ?? '') ? '' : node.value
  }
  if (node.type === 'image' || node.type === 'imageReference' || node.type === 'definition') {
    return ''
  }
  if (node.type === 'html') {
    return node.value.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, '')
  }
  if ('children' in node && Array.isArray(node.children)) {
    return node.children.map((child) => extractPlainTextFromMdast(child as Content)).join('')
  }
  return ''
}

function isCommentOnlyHtml(node: Html): boolean {
  const stripped = node.value.replace(/<!--[\s\S]*?-->/g, '').trim()
  return stripped.length === 0
}

function toTopBlockKind(node: RootContent): MarkdownTopBlockKind | null {
  switch (node.type) {
    case 'heading':
    case 'paragraph':
    case 'list':
    case 'blockquote':
    case 'table':
    case 'code':
    case 'thematicBreak':
    case 'html':
      return node.type
    default:
      return null
  }
}

/**
 * Parses top-level markdown blocks with 1-based line spans and normalized plain text
 * (omitting unrendered definitions and HTML-comment-only nodes).
 */
export function collectTopLevelMarkdownBlocks(rawContent: string): TopLevelMarkdownBlock[] {
  const content = normalizeLineEndingsToLf(rawContent)
  if (!content.trim()) {
    return []
  }
  const tree = mdastParser.parse(content) as Root
  const blocks: TopLevelMarkdownBlock[] = []

  for (const child of tree.children) {
    if (child.type === 'definition') {
      continue
    }
    if (child.type === 'html' && isCommentOnlyHtml(child)) {
      continue
    }
    const kind = toTopBlockKind(child)
    const range = getNodeRange(child)
    if (!kind || !range) {
      continue
    }
    const rawSlice = content.slice(range.startOffset, range.endOffset)
    const isCode = child.type === 'code'
    const isMermaid = isCode && isMermaidLanguage(child.lang ?? '')
    const isIndentedCode = isCode && !isFencedCodeRaw(rawSlice)
    blocks.push({
      kind,
      startLine: range.startLine,
      endLine: range.endLine,
      plainText: extractPlainTextFromMdast(child).replace(/\s+/g, ' ').trim(),
      isMermaid,
      isIndentedCode,
      node: child
    })
  }

  return blocks
}

/**
 * Picks the block whose `[startLine, endLine]` covers `lineNumber` or lies closest to it.
 */
export function pickClosestLineBlock<T extends MarkdownBlockRange>(
  blocks: readonly T[],
  lineNumber: number
): T | null {
  if (blocks.length === 0) {
    return null
  }

  let best: T | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const block of blocks) {
    const distance =
      lineNumber < block.startLine
        ? block.startLine - lineNumber
        : lineNumber > block.endLine
          ? lineNumber - block.endLine
          : 0
    if (distance < bestDistance) {
      bestDistance = distance
      best = block
      if (distance === 0) {
        break
      }
    }
  }
  return best
}

interface InlineRunSegment {
  text: string
  rawStart: number
  rawEnd: number
  runOffsetStart: number
  runOffsetEnd: number
}

const BLOCK_BOUNDARY_TYPES = new Set([
  'paragraph',
  'heading',
  'listItem',
  'blockquote',
  'tableRow',
  'tableCell',
  'thematicBreak',
  'code',
  'image',
  'imageReference',
  'break'
])

function collectHtmlTextSegments(
  rawHtml: string,
  baseRawOffset: number,
  segments: InlineRunSegment[],
  runLengthRef: { value: number }
): void {
  // Scan visible text outside HTML comments, tags, and script/style blocks.
  let cursor = 0
  while (cursor < rawHtml.length) {
    const lt = rawHtml.indexOf('<', cursor)
    const textEnd = lt === -1 ? rawHtml.length : lt
    if (textEnd > cursor) {
      const text = rawHtml.slice(cursor, textEnd)
      if (text.length > 0 && !/^\s+$/.test(text)) {
        segments.push({
          text,
          rawStart: baseRawOffset + cursor,
          rawEnd: baseRawOffset + textEnd,
          runOffsetStart: runLengthRef.value,
          runOffsetEnd: runLengthRef.value + text.length
        })
        runLengthRef.value += text.length
      }
    }
    if (lt === -1) {
      break
    }
    if (rawHtml.startsWith('<!--', lt)) {
      const commentEnd = rawHtml.indexOf('-->', lt + 4)
      cursor = commentEnd === -1 ? rawHtml.length : commentEnd + 3
      continue
    }
    const tagEnd = rawHtml.indexOf('>', lt + 1)
    if (tagEnd === -1) {
      break
    }
    const tagBody = rawHtml.slice(lt + 1, tagEnd).trim().toLowerCase()
    cursor = tagEnd + 1
    if (tagBody.startsWith('script') || tagBody.startsWith('style')) {
      const closeTag = tagBody.startsWith('script') ? '</script>' : '</style>'
      const closeIdx = rawHtml.toLowerCase().indexOf(closeTag, cursor)
      cursor = closeIdx === -1 ? rawHtml.length : closeIdx + closeTag.length
    }
  }
}

function collectBlockInlineRuns(content: string, rootNode: RootContent): InlineRunSegment[][] {
  const runs: InlineRunSegment[][] = []
  let currentRun: InlineRunSegment[] = []
  const runLengthRef = { value: 0 }

  const flushRun = (): void => {
    if (currentRun.length > 0) {
      runs.push(currentRun)
      currentRun = []
      runLengthRef.value = 0
    }
  }

  const pushSegment = (text: string, rawStart: number, rawEnd: number): void => {
    if (!text) return
    currentRun.push({
      text,
      rawStart,
      rawEnd,
      runOffsetStart: runLengthRef.value,
      runOffsetEnd: runLengthRef.value + text.length
    })
    runLengthRef.value += text.length
  }

  const visit = (node: Content | RootContent): void => {
    const range = getNodeRange(node)
    if (node.type === 'text') {
      if (range) {
        pushSegment(node.value, range.startOffset, range.endOffset)
      }
      return
    }
    if (node.type === 'inlineCode') {
      if (range) {
        const { valueStart, valueEnd } = extractInlineCodeValueRange(
          content,
          range.startOffset,
          range.endOffset
        )
        pushSegment(node.value, valueStart, valueEnd)
      }
      return
    }
    if (node.type === 'html') {
      if (range) {
        const lower = node.value.trim().toLowerCase()
        if (/^<(br|hr|img|div|p|section|article|blockquote|li|tr|td|th|h[1-6]|pre|table)\b/.test(lower)) {
          flushRun()
        }
        collectHtmlTextSegments(node.value, range.startOffset, currentRun, runLengthRef)
      }
      return
    }
    if (BLOCK_BOUNDARY_TYPES.has(node.type)) {
      flushRun()
      if ('children' in node && Array.isArray(node.children)) {
        for (const child of node.children) {
          visit(child as Content)
        }
      }
      flushRun()
      return
    }
    if ('children' in node && Array.isArray(node.children)) {
      for (const child of node.children) {
        visit(child as Content)
      }
    }
  }

  visit(rootNode)
  flushRun()
  return runs
}

function mapRunOffsetToRaw(segments: readonly InlineRunSegment[], runOffset: number): number {
  for (const seg of segments) {
    if (runOffset <= seg.runOffsetEnd) {
      const localOffset = runOffset - seg.runOffsetStart
      const rawSpan = seg.rawEnd - seg.rawStart
      if (rawSpan === seg.text.length) {
        return seg.rawStart + localOffset
      }
      // Approximate proportionally when markdown escapes or entities alter raw vs rendered length.
      const ratio = seg.text.length > 0 ? localOffset / seg.text.length : 0
      return seg.rawStart + Math.round(ratio * rawSpan)
    }
  }
  const last = segments[segments.length - 1]
  return last.rawEnd
}

function isRawSpanEndpointsInSegments(
  segments: readonly InlineRunSegment[],
  rawFrom: number,
  rawTo: number
): boolean {
  if (rawFrom === rawTo) {
    return segments.some((seg) => rawFrom >= seg.rawStart && rawFrom <= seg.rawEnd)
  }
  const startInSeg = segments.some((seg) => rawFrom >= seg.rawStart && rawFrom < seg.rawEnd)
  const endInSeg = segments.some((seg) => rawTo > seg.rawStart && rawTo <= seg.rawEnd)
  return startInSeg && endInSeg
}

function buildContextualSlice(
  text: string,
  start: number,
  end: number
): Pick<ContextualMatchCandidate<never>, 'contextBefore' | 'matchedText' | 'contextAfter'> {
  return {
    contextBefore: text.slice(Math.max(0, start - CONTEXT_SLICE_LEN), start),
    matchedText: text.slice(start, end),
    contextAfter: text.slice(end, end + CONTEXT_SLICE_LEN)
  }
}

function mapRawOffsetToRun(segments: readonly InlineRunSegment[], rawOffset: number): number {
  for (const seg of segments) {
    if (rawOffset <= seg.rawEnd) {
      if (rawOffset <= seg.rawStart) {
        return seg.runOffsetStart
      }
      const rawSpan = seg.rawEnd - seg.rawStart
      const localRaw = rawOffset - seg.rawStart
      if (rawSpan === seg.text.length) {
        return seg.runOffsetStart + localRaw
      }
      const ratio = rawSpan > 0 ? localRaw / rawSpan : 0
      return seg.runOffsetStart + Math.round(ratio * seg.text.length)
    }
  }
  const last = segments[segments.length - 1]
  return last ? last.runOffsetEnd : 0
}

function resolveInlineBlockMatch(
  content: string,
  blockNode: RootContent,
  matcher: CompiledSearchMatcher,
  rawFrom: number,
  rawTo: number
): MarkdownJumpCandidateMatch | null {
  const runs = collectBlockInlineRuns(content, blockNode)
  let occurrenceCounter = 0

  for (const runSegments of runs) {
    const runText = runSegments.map((seg) => seg.text).join('')
    const spans = matcher.findMatches(runText)
    const endpointsInsideRun = isRawSpanEndpointsInSegments(runSegments, rawFrom, rawTo)
    for (const span of spans) {
      const mappedStart = mapRunOffsetToRaw(runSegments, span.start)
      const mappedEnd = mapRunOffsetToRaw(runSegments, span.end)

      const matchesExactOrEscaped =
        endpointsInsideRun &&
        ((rawFrom >= mappedStart && rawTo <= mappedEnd) ||
          (mappedStart >= rawFrom && mappedEnd <= rawTo) ||
          (rawFrom === rawTo && Math.abs(rawFrom - mappedStart) <= 1))

      if (matchesExactOrEscaped) {
        return {
          occurrenceInBlock: occurrenceCounter,
          ...buildContextualSlice(runText, span.start, span.end)
        }
      }
      occurrenceCounter += 1
    }
  }

  // Fallback for line-anchored regex matches (e.g. ^foo / bar$) inside multi-line wrapped blocks:
  // rendered DOM runs concatenate lines, so line-based regex anchors may not match runText directly.
  if (rawTo > rawFrom) {
    for (let runIdx = 0; runIdx < runs.length; runIdx += 1) {
      const runSegments = runs[runIdx]
      if (!isRawSpanEndpointsInSegments(runSegments, rawFrom, rawTo)) {
        continue
      }
      const runText = runSegments.map((seg) => seg.text).join('')
      const runStart = Math.max(0, Math.min(runText.length, mapRawOffsetToRun(runSegments, rawFrom)))
      const runEnd = Math.max(runStart, Math.min(runText.length, mapRawOffsetToRun(runSegments, rawTo)))
      if (runEnd > runStart) {
        const slice = buildContextualSlice(runText, runStart, runEnd)
        let fallbackOccurrence = 0
        const literal = compileSearchMatcher(slice.matchedText, {
          caseSensitive: true,
          wholeWord: false,
          useRegex: false
        })
        if (literal.ok) {
          for (let priorIdx = 0; priorIdx <= runIdx; priorIdx += 1) {
            const priorText = runs[priorIdx].map((seg) => seg.text).join('')
            for (const span of literal.matcher.findMatches(priorText)) {
              if (priorIdx < runIdx || span.start < runStart) {
                fallbackOccurrence += 1
              }
            }
          }
        }
        return {
          occurrenceInBlock: fallbackOccurrence,
          ...slice
        }
      }
    }
  }

  return null
}

function resolveCodeBlockJumpMatch(
  content: string,
  lines: readonly string[],
  codeNode: Code,
  matcher: CompiledSearchMatcher,
  lineNumber: number,
  colStart: number,
  colEnd: number
): MarkdownJumpCandidateMatch | null {
  if (isMermaidLanguage(codeNode.lang ?? '')) {
    return null
  }
  const range = getNodeRange(codeNode)
  if (!range) {
    return null
  }

  const rawSlice = content.slice(range.startOffset, range.endOffset)
  const rawFenceLine = lines[range.startLine - 1] ?? ''
  const isFenced = isFencedCodeRaw(rawSlice)

  let bodyStartLine = range.startLine
  let bodyEndLine = range.endLine
  let strippedIndentLimit = 4

  if (isFenced) {
    const trimmedFence = rawFenceLine.trimStart()
    const fenceChar = trimmedFence[0] === '~' ? '~' : '`'
    let fenceLen = 0
    while (fenceLen < trimmedFence.length && trimmedFence[fenceLen] === fenceChar) {
      fenceLen += 1
    }
    strippedIndentLimit = Math.min(3, rawFenceLine.length - trimmedFence.length)
    bodyStartLine = range.startLine + 1
    const lastLineText = lines[range.endLine - 1] ?? ''
    if (range.endLine > range.startLine && isClosingFenceLine(lastLineText, fenceChar, fenceLen)) {
      bodyEndLine = range.endLine - 1
    }
  }

  if (lineNumber < bodyStartLine || lineNumber > bodyEndLine) {
    return null
  }

  const targetRawLine = lines[lineNumber - 1] ?? ''
  let strippedOnLine = 0
  if (!isFenced && targetRawLine.startsWith('\t')) {
    strippedOnLine = 1
  } else {
    while (
      strippedOnLine < strippedIndentLimit &&
      strippedOnLine < targetRawLine.length &&
      targetRawLine[strippedOnLine] === ' '
    ) {
      strippedOnLine += 1
    }
  }
  if (colEnd <= strippedOnLine && colStart < colEnd) {
    return null
  }

  const codeLines = splitSearchLines(codeNode.value)
  const targetCodeLineIdx = lineNumber - bodyStartLine
  if (targetCodeLineIdx < 0 || targetCodeLineIdx >= codeLines.length) {
    return null
  }

  let codeLineStartOffset = 0
  for (let i = 0; i < targetCodeLineIdx; i += 1) {
    codeLineStartOffset += codeLines[i].length + 1
  }
  const codeLineLen = codeLines[targetCodeLineIdx].length
  const localColStart = Math.max(0, Math.min(colStart - strippedOnLine, codeLineLen))
  const localColEnd = Math.max(localColStart, Math.min(colEnd - strippedOnLine, codeLineLen))
  const targetCodeFrom = codeLineStartOffset + localColStart
  const targetCodeTo = codeLineStartOffset + localColEnd

  const spans = matcher.findMatches(codeNode.value)
  for (let i = 0; i < spans.length; i += 1) {
    const span = spans[i]
    if (span.start === targetCodeFrom && span.end === targetCodeTo) {
      return {
        occurrenceInBlock: i,
        ...buildContextualSlice(codeNode.value, span.start, span.end),
        codeSpan: { start: span.start, end: span.end }
      }
    }
  }

  return null
}

function resolveNestedBlockHint(node: RootContent, lineNumber: number): NestedBlockHint | null {
  if (node.type === 'list') {
    const listNode = node as List
    for (let i = 0; i < listNode.children.length; i += 1) {
      const item: ListItem = listNode.children[i]
      const range = getNodeRange(item)
      if (range && lineNumber >= range.startLine && lineNumber <= range.endLine) {
        return { kind: 'list-item', index: i }
      }
    }
  } else if (node.type === 'table') {
    const tableNode = node as Table
    for (let i = 0; i < tableNode.children.length; i += 1) {
      const row = tableNode.children[i]
      const range = getNodeRange(row)
      if (range && lineNumber >= range.startLine && lineNumber <= range.endLine) {
        return { kind: 'table-row', index: i }
      }
    }
  }
  return null
}

/**
 * Analyzes how a workspace search `(lineNumber, columnStart, columnEnd)` jump maps to
 * rendered Markdown blocks vs non-rendered Markdown syntax/URLs/Mermaid blocks.
 */
export function analyzeMarkdownSearchJump(
  rawContent: string,
  jump: DocumentJumpLocation
): MarkdownJumpPlan {
  const content = normalizeLineEndingsToLf(rawContent)
  const lines = splitSearchLines(content)
  const lineNumber = Math.max(1, Math.min(jump.lineNumber, lines.length))
  const lineStartOffsets = computeLineStartOffsets(lines)
  const rawLine = lines[lineNumber - 1] ?? ''
  const colStart = Math.max(0, Math.min(jump.columnStart, rawLine.length))
  const colEnd = Math.max(colStart, Math.min(jump.columnEnd, rawLine.length))
  const rawFrom = lineStartOffsets[lineNumber - 1] + colStart
  const rawTo = lineStartOffsets[lineNumber - 1] + colEnd

  const topBlocks = collectTopLevelMarkdownBlocks(content)
  const closestBlock = pickClosestLineBlock(topBlocks, lineNumber)
  const containingBlock =
    closestBlock && lineNumber >= closestBlock.startLine && lineNumber <= closestBlock.endLine
      ? closestBlock
      : null

  const targetBlock = closestBlock
    ? { startLine: closestBlock.startLine, endLine: closestBlock.endLine }
    : null
  const nestedItemIndex = containingBlock
    ? resolveNestedBlockHint(containingBlock.node, lineNumber)
    : null

  if (!containingBlock || jump.query.length === 0) {
    return { lineNumber, targetBlock, nestedItemIndex, renderedMatch: null }
  }

  const compiled = compileSearchMatcher(jump.query, jump.options)
  if (!compiled.ok) {
    return { lineNumber, targetBlock, nestedItemIndex, renderedMatch: null }
  }

  if (containingBlock.node.type === 'code') {
    return {
      lineNumber,
      targetBlock,
      nestedItemIndex: null,
      renderedMatch: resolveCodeBlockJumpMatch(
        content,
        lines,
        containingBlock.node,
        compiled.matcher,
        lineNumber,
        colStart,
        colEnd
      )
    }
  }

  if (
    containingBlock.node.type === 'thematicBreak' ||
    (containingBlock.node as RootContent | Definition).type === 'definition'
  ) {
    return { lineNumber, targetBlock, nestedItemIndex: null, renderedMatch: null }
  }

  return {
    lineNumber,
    targetBlock,
    nestedItemIndex,
    renderedMatch: resolveInlineBlockMatch(
      content,
      containingBlock.node,
      compiled.matcher,
      rawFrom,
      rawTo
    )
  }
}

function normalizeContext(text: string): string {
  return text.replace(/\s+/g, ' ')
}

function commonSuffixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length)
  let count = 0
  while (count < max && a[a.length - 1 - count] === b[b.length - 1 - count]) {
    count += 1
  }
  return count
}

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length)
  let count = 0
  while (count < max && a[count] === b[count]) {
    count += 1
  }
  return count
}

/**
 * Selects the rendered match candidate inside the target block that best aligns with
 * the target's surrounding text context and within-block occurrence index.
 */
function selectBestJumpCandidate<TRef>(
  candidates: readonly ContextualMatchCandidate<TRef>[],
  target: MarkdownJumpCandidateMatch
): TRef | null {
  if (candidates.length === 0) {
    return null
  }
  const targetBefore = normalizeContext(target.contextBefore)
  const targetAfter = normalizeContext(target.contextAfter)
  const targetMatchedLower = target.matchedText.toLowerCase()

  let bestCandidate = candidates[0]
  let bestScore = Number.NEGATIVE_INFINITY

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i]
    let score = 0
    if (candidate.matchedText === target.matchedText) {
      score += 1000
    } else if (candidate.matchedText.toLowerCase() === targetMatchedLower) {
      score += 500
    }

    score += 3 * commonSuffixLength(normalizeContext(candidate.contextBefore), targetBefore)
    score += 3 * commonPrefixLength(normalizeContext(candidate.contextAfter), targetAfter)
    if (i === target.occurrenceInBlock) {
      score += 100
    } else {
      score -= Math.abs(i - target.occurrenceInBlock)
    }

    if (score > bestScore) {
      bestScore = score
      bestCandidate = candidate
    }
  }

  return bestCandidate.ref
}

function blockKindsCompatible(md: TopLevelMarkdownBlock, pm: RenderedBlockSummary): boolean {
  if (md.isIndentedCode && pm.kind === 'paragraph') {
    return true
  }
  if (md.kind === 'html') {
    return true
  }
  return md.kind === pm.kind && md.isMermaid === pm.isMermaid
}

function compactWhitespace(text: string): string {
  return text.replace(/\s+/g, '')
}

/**
 * Aligns rendered top-level blocks (such as ProseMirror document children) against parsed
 * markdown blocks so each rendered block receives its source `[startLine, endLine]` span.
 */
export function alignRenderedBlocksToMarkdown<T extends RenderedBlockSummary>(
  renderedBlocks: readonly T[],
  mdBlocks: readonly TopLevelMarkdownBlock[]
): AlignedBlock<T>[] {
  if (renderedBlocks.length === 0) {
    return []
  }
  if (mdBlocks.length === 0) {
    return renderedBlocks.map((block) => ({ ...block, startLine: 1, endLine: 1 }))
  }

  const aligned: AlignedBlock<T>[] = []
  let mdIdx = 0
  let listCompactConsumed = 0

  for (let pmIdx = 0; pmIdx < renderedBlocks.length; pmIdx += 1) {
    const pm = renderedBlocks[pmIdx]
    while (mdIdx < mdBlocks.length && !blockKindsCompatible(mdBlocks[mdIdx], pm)) {
      mdIdx += 1
      listCompactConsumed = 0
    }
    const matchedMd = mdBlocks[mdIdx] ?? mdBlocks[mdBlocks.length - 1]
    aligned.push({
      ...pm,
      startLine: matchedMd.startLine,
      endLine: matchedMd.endLine
    })

    if (matchedMd.isIndentedCode && pmIdx + 1 < renderedBlocks.length) {
      const nextPm = renderedBlocks[pmIdx + 1]
      if (
        nextPm.kind === 'paragraph' &&
        nextPm.plainText.length > 0 &&
        matchedMd.plainText.includes(nextPm.plainText)
      ) {
        continue
      }
    }

    if (matchedMd.kind === 'list' && pm.kind === 'list' && pmIdx + 1 < renderedBlocks.length) {
      const nextPm = renderedBlocks[pmIdx + 1]
      listCompactConsumed += compactWhitespace(pm.plainText).length
      const nextCompact = compactWhitespace(nextPm.plainText)
      if (
        nextPm.kind === 'list' &&
        nextCompact.length > 0 &&
        compactWhitespace(matchedMd.plainText).slice(listCompactConsumed).startsWith(nextCompact)
      ) {
        continue
      }
    }

    if (mdIdx < mdBlocks.length) {
      mdIdx += 1
      listCompactConsumed = 0
    }
  }

  return aligned
}

function collectRunContextualCandidates<TRef>(
  runText: string,
  matcher: CompiledSearchMatcher,
  makeRef: (span: TextMatchSpan) => TRef
): ContextualMatchCandidate<TRef>[] {
  const results: ContextualMatchCandidate<TRef>[] = []
  for (const span of matcher.findMatches(runText)) {
    results.push({
      ref: makeRef(span),
      ...buildContextualSlice(runText, span.start, span.end)
    })
  }
  return results
}

/**
 * Selects the best contextual match across rendered runs, falling back to literal matching
 * of `renderedMatch.matchedText` when line-anchored regexes cannot match across wrapped runs.
 */
export function selectBestJumpMatchFromRuns<TRun, TRef>(
  runs: readonly TRun[],
  getText: (run: TRun) => string,
  makeRef: (run: TRun, span: TextMatchSpan) => TRef,
  matcher: CompiledSearchMatcher,
  jump: DocumentJumpLocation,
  renderedMatch: NonNullable<MarkdownJumpPlan['renderedMatch']>
): TRef | null {
  const collectForMatcher = (
    activeMatcher: CompiledSearchMatcher
  ): ContextualMatchCandidate<TRef>[] => {
    const found: ContextualMatchCandidate<TRef>[] = []
    for (const run of runs) {
      found.push(
        ...collectRunContextualCandidates(getText(run), activeMatcher, (span) => makeRef(run, span))
      )
    }
    return found
  }

  let candidates = collectForMatcher(matcher)
  if (candidates.length === 0 && jump.options.useRegex && renderedMatch.matchedText.length > 0) {
    const literal = compileSearchMatcher(renderedMatch.matchedText, {
      caseSensitive: jump.options.caseSensitive,
      wholeWord: false,
      useRegex: false
    })
    if (literal.ok) {
      candidates = collectForMatcher(literal.matcher)
    }
  }

  return selectBestJumpCandidate(candidates, renderedMatch)
}
