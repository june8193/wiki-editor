import { cloneElement, Fragment, isValidElement, type ReactElement, type ReactNode } from 'react'
import {
  compileSearchMatcher,
  type CompiledSearchMatcher,
  type DocumentJumpHighlightTarget
} from '@shared/search'
import type { CodeBlockHighlightSpan } from './codeBlockHighlight'
import {
  areDocumentFindCriteriaEqual,
  consumeMatchedTextRun,
  type DocumentFindCriteria,
  type DocumentFindHighlightQuery,
  type TextRunSegment
} from './documentFind'
import {
  analyzeMarkdownSearchJump,
  type MarkdownJumpPlan,
  type NestedBlockHint,
  pickClosestLineBlock,
  selectBestJumpMatchFromRuns
} from './markdownSearchJump'

export const PREVIEW_SEARCH_CHROME_SELECTOR =
  '.code-block-header, .mermaid-diagram-block, .markdown-preview-empty'

export interface PreviewSearchMatchSpan {
  start: number
  end: number
  matchIndex: number
  isJump?: boolean
}

export interface PreviewJumpHighlightQuery extends DocumentJumpHighlightTarget {
  suppressScroll?: boolean
}

export interface PreviewSearchMatchResult {
  matchCount: number
  errorMessage: string | null
}

export interface PreviewPreSearchProps {
  searchHighlightSpans?: readonly PreviewSearchMatchSpan[]
  activeSearchMatchIndex?: number
}

export type PreviewElementClassification =
  | { kind: 'skip' }
  | { kind: 'fenced-code'; rawCode: string; isMermaid: boolean }
  | { kind: 'block'; isWhitespaceContainer: boolean }
  | { kind: 'inline'; isWhitespaceContainer: boolean }

export type PreviewElementClassifier = (
  element: ReactElement<{ children?: ReactNode }>
) => PreviewElementClassification | null

export interface PreviewSearchTarget {
  baseTree: ReactNode
  isBlankDocument: boolean
  classify: PreviewElementClassifier
}

const SKIP_ELEMENT_TAGS = new Set([
  'img',
  'input',
  'br',
  'hr',
  'svg',
  'button',
  'style',
  'script',
  'textarea',
  'select',
  'iframe',
  'object',
  'embed',
  'video',
  'audio',
  'canvas'
])

const BLOCK_ELEMENT_TAGS = new Set([
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'div',
  'blockquote',
  'ul',
  'ol',
  'li',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'dl',
  'dt',
  'dd',
  'section',
  'article',
  'aside',
  'header',
  'footer',
  'nav',
  'main',
  'figure',
  'figcaption',
  'details',
  'summary',
  'address',
  'pre'
])

const STRUCTURAL_WHITESPACE_ONLY_TAGS = new Set([
  'ul',
  'ol',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'colgroup',
  'dl'
])

function resolvePreviewElementClassification(
  element: ReactElement<{ children?: ReactNode }>,
  classifyCustom: PreviewElementClassifier
): PreviewElementClassification {
  const custom = classifyCustom(element)
  if (custom) {
    return custom
  }
  const { type } = element
  if (typeof type === 'string') {
    if (SKIP_ELEMENT_TAGS.has(type)) {
      return { kind: 'skip' }
    }
    if (BLOCK_ELEMENT_TAGS.has(type)) {
      return { kind: 'block', isWhitespaceContainer: STRUCTURAL_WHITESPACE_ONLY_TAGS.has(type) }
    }
    return { kind: 'inline', isWhitespaceContainer: false }
  }
  return { kind: 'inline', isWhitespaceContainer: type === Fragment }
}

interface TextSlotSegment extends TextRunSegment {
  slotId: number
}

interface PreviewSearchPlan {
  matchCount: number
  errorMessage: string | null
  textPatches: Map<number, PreviewSearchMatchSpan[]>
  codePatches: Map<number, PreviewSearchMatchSpan[]>
}

const EMPTY_SEARCH_PLAN: PreviewSearchPlan = {
  matchCount: 0,
  errorMessage: null,
  textPatches: new Map(),
  codePatches: new Map()
}

let cachedSearchPlan: {
  baseTree: ReactNode
  criteria: DocumentFindCriteria
  plan: PreviewSearchPlan
} | null = null

function wrapSearchMark(
  text: string,
  matchIndex: number,
  activeMatchIndex: number,
  isJump: boolean,
  key: string
): ReactNode {
  if (text.length === 0) {
    const anchorClasses = [
      ...(matchIndex >= 0 ? ['preview-search-match-anchor'] : []),
      ...(isJump ? ['preview-search-jump-anchor'] : [])
    ]
    return (
      <span
        key={key}
        className={anchorClasses.join(' ')}
        {...(matchIndex >= 0 ? { 'data-search-match-index': matchIndex } : {})}
        {...(isJump ? { 'data-search-jump': 'true' } : {})}
      />
    )
  }
  const classes: string[] = []
  if (matchIndex >= 0) {
    classes.push('preview-search-match')
    if (matchIndex === activeMatchIndex) {
      classes.push('preview-search-match-active')
    }
  }
  if (isJump) {
    classes.push('preview-search-jump-highlight')
  }
  return (
    <mark
      key={key}
      className={classes.join(' ')}
      {...(matchIndex >= 0 ? { 'data-search-match-index': matchIndex } : {})}
      {...(isJump ? { 'data-search-jump': 'true' } : {})}
    >
      {text}
    </mark>
  )
}

function renderHighlightedSlice(
  text: string,
  from: number,
  to: number,
  includeEndAnchors: boolean,
  searchHighlights: readonly PreviewSearchMatchSpan[],
  activeSearchMatchIndex: number,
  keyPrefix: string
): ReactNode {
  if (searchHighlights.length === 0) {
    return to > from ? text.slice(from, to) : null
  }

  const boundarySet = new Set<number>([from, to])
  const anchorMatchesByOffset = new Map<number, Array<{ matchIndex: number; isJump: boolean }>>()
  const overlappingMatches: PreviewSearchMatchSpan[] = []

  for (const match of searchHighlights) {
    const start = Math.max(0, Math.min(text.length, match.start))
    const end = Math.max(start, Math.min(text.length, match.end))
    if (end <= start) {
      if (start >= from && (includeEndAnchors ? start <= to : start < to)) {
        const entry = { matchIndex: match.matchIndex, isJump: Boolean(match.isJump) }
        const list = anchorMatchesByOffset.get(start)
        if (list) {
          list.push(entry)
        } else {
          anchorMatchesByOffset.set(start, [entry])
        }
        boundarySet.add(start)
      }
      continue
    }
    const clampedStart = Math.max(from, start)
    const clampedEnd = Math.min(to, end)
    if (clampedEnd > clampedStart) {
      overlappingMatches.push({
        start: clampedStart,
        end: clampedEnd,
        matchIndex: match.matchIndex,
        isJump: match.isJump
      })
      boundarySet.add(clampedStart)
      boundarySet.add(clampedEnd)
    }
  }

  if (overlappingMatches.length === 0 && anchorMatchesByOffset.size === 0) {
    return to > from ? text.slice(from, to) : null
  }

  const boundaries = Array.from(boundarySet).sort((a, b) => a - b)
  const pieces: ReactNode[] = []

  for (let i = 0; i < boundaries.length; i += 1) {
    const pos = boundaries[i]
    const anchors = anchorMatchesByOffset.get(pos)
    if (anchors) {
      anchorMatchesByOffset.delete(pos)
      for (let a = 0; a < anchors.length; a += 1) {
        const anchor = anchors[a]
        pieces.push(
          wrapSearchMark(
            '',
            anchor.matchIndex,
            activeSearchMatchIndex,
            anchor.isJump,
            `${keyPrefix}-a-${pos}-${anchor.matchIndex}-${a}`
          )
        )
      }
    }
    if (i + 1 >= boundaries.length) break
    const nextPos = boundaries[i + 1]
    if (nextPos <= pos) continue

    const slice = text.slice(pos, nextPos)
    const findMatch = overlappingMatches.find(
      (m) => m.matchIndex >= 0 && m.start <= pos && m.end >= nextPos
    )
    const jumpMatch = overlappingMatches.find(
      (m) => m.isJump && m.start <= pos && m.end >= nextPos
    )
    pieces.push(
      findMatch || jumpMatch
        ? wrapSearchMark(
            slice,
            findMatch?.matchIndex ?? -1,
            activeSearchMatchIndex,
            Boolean(jumpMatch),
            `${keyPrefix}-m-${i}`
          )
        : slice
    )
  }

  return pieces.length === 1 ? pieces[0] : pieces
}

/**
 * Renders syntax-highlighted code tokens and optional search `<mark>` spans in one pass,
 * avoiding allocation and sorting overhead when no search highlights are active.
 */
export function renderCodeTokensWithSearch(
  code: string,
  syntaxSpans: readonly CodeBlockHighlightSpan[],
  searchHighlights: readonly PreviewSearchMatchSpan[] = [],
  activeSearchMatchIndex = -1
): ReactNode {
  if (syntaxSpans.length === 0 && searchHighlights.length === 0) {
    return code
  }

  const nodes: ReactNode[] = []
  let cursor = 0

  for (let i = 0; i < syntaxSpans.length; i += 1) {
    const span = syntaxSpans[i]
    if (span.from < cursor || span.to <= span.from || span.to > code.length) {
      continue
    }
    if (span.from > cursor) {
      const gapNode = renderHighlightedSlice(
        code,
        cursor,
        span.from,
        false,
        searchHighlights,
        activeSearchMatchIndex,
        `g-${i}`
      )
      if (gapNode !== null) {
        nodes.push(gapNode)
      }
    }
    nodes.push(
      <span key={`tok-${i}`} className={span.className}>
        {renderHighlightedSlice(
          code,
          span.from,
          span.to,
          false,
          searchHighlights,
          activeSearchMatchIndex,
          `t-${i}`
        )}
      </span>
    )
    cursor = span.to
  }

  const trailingNode = renderHighlightedSlice(
    code,
    cursor,
    code.length,
    true,
    searchHighlights,
    activeSearchMatchIndex,
    'end'
  )
  if (trailingNode !== null) {
    nodes.push(trailingNode)
  }

  return nodes
}

function walkPreviewTree<TResult>(
  root: ReactNode,
  classify: PreviewElementClassifier,
  visitor: {
    identity: (node: ReactNode) => TResult
    onText: (text: string, slotId: number) => TResult
    onFencedCode: (
      element: ReactElement,
      codeSlotId: number,
      rawCode: string,
      isMermaid: boolean
    ) => TResult
    onBlockBoundary?: () => void
    onElementEnter?: (element: ReactElement<{ children?: ReactNode }>) => void
    onElementExit?: (element: ReactElement<{ children?: ReactNode }>) => void
    combineArray: (original: ReactNode[], mapped: TResult[]) => TResult
    combineElement: (element: ReactElement<{ children?: ReactNode }>, nextChild: TResult) => TResult
  }
): TResult {
  let nextTextSlotId = 0
  let nextCodeSlotId = 0

  const visit = (node: ReactNode, isWhitespaceContainer: boolean): TResult => {
    if (node === null || node === undefined || typeof node === 'boolean') {
      return visitor.identity(node)
    }
    if (Array.isArray(node)) {
      return visitor.combineArray(
        node,
        node.map((child) => visit(child, isWhitespaceContainer))
      )
    }
    if (typeof node === 'string' || typeof node === 'number') {
      const text = String(node)
      if (isWhitespaceContainer && /^[\r\n\t ]+$/.test(text)) {
        return visitor.identity(node)
      }
      return visitor.onText(text, nextTextSlotId++)
    }
    if (!isValidElement<{ children?: ReactNode }>(node)) {
      return visitor.identity(node)
    }

    visitor.onElementEnter?.(node)
    const classification = resolvePreviewElementClassification(node, classify)
    let result: TResult
    if (classification.kind === 'skip') {
      visitor.onBlockBoundary?.()
      result = visitor.identity(node)
    } else if (classification.kind === 'fenced-code') {
      visitor.onBlockBoundary?.()
      const codeSlotId = classification.isMermaid ? -1 : nextCodeSlotId++
      result = visitor.onFencedCode(node, codeSlotId, classification.rawCode, classification.isMermaid)
    } else if (classification.kind === 'block') {
      visitor.onBlockBoundary?.()
      const nextChild = visit(node.props.children, classification.isWhitespaceContainer)
      visitor.onBlockBoundary?.()
      result = visitor.combineElement(node, nextChild)
    } else {
      const nextChild = visit(node.props.children, classification.isWhitespaceContainer)
      result = visitor.combineElement(node, nextChild)
    }
    visitor.onElementExit?.(node)
    return result
  }

  return visit(root, true)
}

function appendPatch(
  map: Map<number, PreviewSearchMatchSpan[]>,
  slotId: number,
  patch: PreviewSearchMatchSpan
): void {
  const list = map.get(slotId)
  if (list) {
    list.push(patch)
  } else {
    map.set(slotId, [patch])
  }
}

function mapTextRunSpanToSlotPatches(
  segments: readonly TextSlotSegment[],
  span: { start: number; end: number },
  matchIndex: number,
  isJump: boolean,
  textPatches: Map<number, PreviewSearchMatchSpan[]>
): void {
  if (span.end <= span.start) {
    const targetSegment =
      segments.find((seg) => span.start <= seg.endOffset) ?? segments[segments.length - 1]
    const localPos = Math.max(
      0,
      Math.min(targetSegment.text.length, span.start - targetSegment.startOffset)
    )
    appendPatch(textPatches, targetSegment.slotId, {
      start: localPos,
      end: localPos,
      matchIndex,
      ...(isJump ? { isJump: true } : {})
    })
    return
  }

  for (const seg of segments) {
    if (span.end <= seg.startOffset || span.start >= seg.endOffset) {
      continue
    }
    const localStart = Math.max(0, span.start - seg.startOffset)
    const localEnd = Math.min(seg.text.length, span.end - seg.startOffset)
    if (localEnd > localStart) {
      appendPatch(textPatches, seg.slotId, {
        start: localStart,
        end: localEnd,
        matchIndex,
        ...(isJump ? { isJump: true } : {})
      })
    }
  }
}

function isWhitespaceOnlyTextRun(runSegments: readonly TextSlotSegment[]): boolean {
  return (
    runSegments.some((segment) => segment.text.includes('\n')) &&
    runSegments.every((segment) => /^[\r\n\t ]+$/.test(segment.text))
  )
}

function flushPreviewTextRun(
  runSegments: TextSlotSegment[],
  matcher: CompiledSearchMatcher,
  textPatches: Map<number, PreviewSearchMatchSpan[]>,
  nextMatchIndex: () => number
): void {
  if (isWhitespaceOnlyTextRun(runSegments)) {
    runSegments.length = 0
    return
  }
  consumeMatchedTextRun(runSegments, matcher, (span, segments) => {
    mapTextRunSpanToSlotPatches(segments, span, nextMatchIndex(), false, textPatches)
  })
}

function buildPreviewSearchPlan(
  target: PreviewSearchTarget,
  criteria: DocumentFindCriteria
): PreviewSearchPlan {
  if (criteria.query.length === 0) {
    return EMPTY_SEARCH_PLAN
  }
  if (!target.isBlankDocument && cachedSearchPlan) {
    if (
      cachedSearchPlan.baseTree === target.baseTree &&
      areDocumentFindCriteriaEqual(cachedSearchPlan.criteria, criteria)
    ) {
      return cachedSearchPlan.plan
    }
  }

  const compiled = compileSearchMatcher(criteria.query, criteria.options)
  if (!compiled.ok) {
    const errorPlan: PreviewSearchPlan = {
      matchCount: 0,
      errorMessage: compiled.error,
      textPatches: new Map(),
      codePatches: new Map()
    }
    if (!target.isBlankDocument) {
      cachedSearchPlan = { baseTree: target.baseTree, criteria, plan: errorPlan }
    }
    return errorPlan
  }

  if (target.isBlankDocument) {
    return EMPTY_SEARCH_PLAN
  }

  let matchCount = 0
  const allocateMatchIndex = (): number => {
    const idx = matchCount
    matchCount += 1
    return idx
  }

  const textPatches = new Map<number, PreviewSearchMatchSpan[]>()
  const codePatches = new Map<number, PreviewSearchMatchSpan[]>()
  const runSegments: TextSlotSegment[] = []
  let runLength = 0

  const flushRun = (): void => {
    flushPreviewTextRun(runSegments, compiled.matcher, textPatches, allocateMatchIndex)
    runLength = 0
  }

  walkPreviewTree<void>(target.baseTree, target.classify, {
    identity: () => undefined,
    onText: (text, slotId) => {
      runSegments.push({
        slotId,
        text,
        startOffset: runLength,
        endOffset: runLength + text.length
      })
      runLength += text.length
    },
    onFencedCode: (_element, codeSlotId, rawCode, isMermaid) => {
      if (isMermaid || codeSlotId < 0) {
        return
      }
      const spans = compiled.matcher.findMatches(rawCode)
      if (spans.length > 0) {
        codePatches.set(
          codeSlotId,
          spans.map((span) => ({
            start: span.start,
            end: span.end,
            matchIndex: allocateMatchIndex()
          }))
        )
      }
    },
    onBlockBoundary: flushRun,
    combineArray: () => undefined,
    combineElement: () => undefined
  })
  flushRun()

  const plan: PreviewSearchPlan = {
    matchCount,
    errorMessage: null,
    textPatches,
    codePatches
  }
  cachedSearchPlan = { baseTree: target.baseTree, criteria, plan }
  return plan
}

function applyPreviewSearchPlan(
  baseTree: ReactNode,
  plan: PreviewSearchPlan,
  activeMatchIndex: number,
  classify: PreviewElementClassifier
): ReactNode {
  if (plan.textPatches.size === 0 && plan.codePatches.size === 0) {
    return baseTree
  }

  return walkPreviewTree<ReactNode>(baseTree, classify, {
    identity: (node) => node,
    onText: (text, slotId) => {
      const patches = plan.textPatches.get(slotId)
      return patches ? (
        <Fragment key={`smf-${slotId}`}>
          {renderHighlightedSlice(
            text,
            0,
            text.length,
            true,
            patches,
            activeMatchIndex,
            `sm-${slotId}`
          )}
        </Fragment>
      ) : (
        text
      )
    },
    onFencedCode: (element, codeSlotId, _rawCode, isMermaid) => {
      if (isMermaid || codeSlotId < 0) {
        return element
      }
      const patches = plan.codePatches.get(codeSlotId)
      if (!patches) {
        return element
      }
      return cloneElement(element as ReactElement<PreviewPreSearchProps>, {
        searchHighlightSpans: patches,
        activeSearchMatchIndex: activeMatchIndex
      })
    },
    combineArray: (original, mapped) => {
      for (let i = 0; i < original.length; i += 1) {
        if (mapped[i] !== original[i]) {
          return mapped
        }
      }
      return original
    },
    combineElement: (element, nextChildren) => {
      if (nextChildren === element.props.children) {
        return element
      }
      if (Array.isArray(nextChildren)) {
        return cloneElement(element, undefined, ...nextChildren)
      }
      return cloneElement(element, undefined, nextChildren)
    }
  })
}

type PreviewJumpPatchRef =
  | { kind: 'text'; segments: TextSlotSegment[]; span: { start: number; end: number } }
  | { kind: 'code'; codeSlotId: number; span: { start: number; end: number } }

type PreviewJumpRun =
  | { kind: 'text'; text: string; segments: TextSlotSegment[] }
  | { kind: 'code'; text: string; codeSlotId: number }

function parseSourceLineRange(
  startRaw: unknown,
  endRaw: unknown
): { startLine: number; endLine: number } | null {
  if (typeof startRaw !== 'string') return null
  const startLine = Number(startRaw)
  if (!Number.isFinite(startLine) || startLine < 1) return null
  const endLine = typeof endRaw === 'string' ? Number(endRaw) : startLine
  return {
    startLine,
    endLine: Number.isFinite(endLine) && endLine >= startLine ? endLine : startLine
  }
}

function readElementSourceRange(
  element: ReactElement<{ children?: ReactNode }>
): { startLine: number; endLine: number } | null {
  const props = element.props as Record<string, unknown>
  return parseSourceLineRange(props['data-source-line'], props['data-source-end-line'])
}

function buildPreviewJumpPatches(
  target: PreviewSearchTarget,
  markdown: string,
  jumpHighlight: PreviewJumpHighlightQuery
): {
  textPatches: Map<number, PreviewSearchMatchSpan[]>
  codePatches: Map<number, PreviewSearchMatchSpan[]>
} {
  const patches = {
    textPatches: new Map<number, PreviewSearchMatchSpan[]>(),
    codePatches: new Map<number, PreviewSearchMatchSpan[]>()
  }
  if (target.isBlankDocument || jumpHighlight.query.length === 0) {
    return patches
  }

  const jumpPlan: MarkdownJumpPlan = analyzeMarkdownSearchJump(markdown, jumpHighlight)
  if (!jumpPlan.renderedMatch) {
    return patches
  }
  const compiled = compileSearchMatcher(jumpHighlight.query, jumpHighlight.options)
  if (!compiled.ok) {
    return patches
  }

  const blockEntries: Array<{ element: ReactElement; startLine: number; endLine: number }> = []
  const collectTopBlocks = (node: ReactNode): void => {
    if (Array.isArray(node)) {
      for (const child of node) collectTopBlocks(child)
      return
    }
    if (!isValidElement<{ children?: ReactNode }>(node)) {
      return
    }
    const range = readElementSourceRange(node)
    if (range) {
      blockEntries.push({ element: node, ...range })
      return
    }
    if (node.type === Fragment) {
      collectTopBlocks(node.props.children)
    }
  }
  collectTopBlocks(target.baseTree)

  const targetEntry = pickClosestLineBlock(blockEntries, jumpPlan.lineNumber)
  if (!targetEntry) {
    return patches
  }

  const runs: PreviewJumpRun[] = []
  let targetDepth = 0
  const runSegments: TextSlotSegment[] = []
  let runLength = 0

  const flushRun = (): void => {
    if (runSegments.length === 0) return
    if (isWhitespaceOnlyTextRun(runSegments)) {
      runSegments.length = 0
      runLength = 0
      return
    }
    const capturedSegments = [...runSegments]
    runs.push({
      kind: 'text',
      text: capturedSegments.map((seg) => seg.text).join(''),
      segments: capturedSegments
    })
    runSegments.length = 0
    runLength = 0
  }

  walkPreviewTree<void>(target.baseTree, target.classify, {
    identity: () => undefined,
    onElementEnter: (element) => {
      if (targetDepth > 0 || element === targetEntry.element) {
        targetDepth += 1
      }
    },
    onElementExit: (element) => {
      if (targetDepth > 0) {
        if (targetDepth === 1 && element === targetEntry.element) {
          flushRun()
        }
        targetDepth -= 1
      }
    },
    onText: (text, slotId) => {
      if (targetDepth === 0) return
      runSegments.push({
        slotId,
        text,
        startOffset: runLength,
        endOffset: runLength + text.length
      })
      runLength += text.length
    },
    onFencedCode: (_element, codeSlotId, rawCode, isMermaid) => {
      if (targetDepth === 0 || isMermaid || codeSlotId < 0) return
      runs.push({ kind: 'code', text: rawCode, codeSlotId })
    },
    onBlockBoundary: flushRun,
    combineArray: () => undefined,
    combineElement: () => undefined
  })
  flushRun()

  const chosen = selectBestJumpMatchFromRuns<PreviewJumpRun, PreviewJumpPatchRef>(
    runs,
    (run) => run.text,
    (run, span) =>
      run.kind === 'code'
        ? { kind: 'code', codeSlotId: run.codeSlotId, span }
        : { kind: 'text', segments: run.segments, span },
    compiled.matcher,
    jumpHighlight,
    jumpPlan.renderedMatch
  )
  if (!chosen) {
    return patches
  }

  if (chosen.kind === 'code') {
    patches.codePatches.set(chosen.codeSlotId, [
      { start: chosen.span.start, end: chosen.span.end, matchIndex: -1, isJump: true }
    ])
  } else {
    mapTextRunSpanToSlotPatches(chosen.segments, chosen.span, -1, true, patches.textPatches)
  }
  return patches
}

function mergePatchMaps(
  base: Map<number, PreviewSearchMatchSpan[]>,
  extra: Map<number, PreviewSearchMatchSpan[]>
): Map<number, PreviewSearchMatchSpan[]> {
  if (extra.size === 0) return base
  if (base.size === 0) return extra
  const merged = new Map<number, PreviewSearchMatchSpan[]>()
  for (const [key, spans] of base.entries()) {
    merged.set(key, [...spans])
  }
  for (const [key, spans] of extra.entries()) {
    const existing = merged.get(key)
    if (existing) {
      existing.push(...spans)
    } else {
      merged.set(key, [...spans])
    }
  }
  return merged
}

/**
 * Resolves the closest rendered Preview DOM block (or nested list-item/table-row) for `lineNumber`.
 */
export function findClosestPreviewBlockForLine(
  container: HTMLElement,
  markdown: string,
  lineNumber: number,
  jumpHighlight?: PreviewJumpHighlightQuery | null
): Element | null {
  const candidates = Array.from(container.querySelectorAll<HTMLElement>('[data-source-line]')).filter(
    (el) => {
      const parentSource = el.parentElement?.closest('[data-source-line]')
      return !(parentSource && container.contains(parentSource))
    }
  )

  const blocks = candidates
    .map((el) => {
      const range = parseSourceLineRange(
        el.getAttribute('data-source-line'),
        el.getAttribute('data-source-end-line')
      )
      return range ? { el, ...range } : null
    })
    .filter((entry): entry is { el: HTMLElement; startLine: number; endLine: number } => entry !== null)

  const best = pickClosestLineBlock(blocks, lineNumber)
  if (!best) {
    return null
  }

  if (jumpHighlight && lineNumber >= best.startLine && lineNumber <= best.endLine) {
    const hint: NestedBlockHint | null = analyzeMarkdownSearchJump(markdown, jumpHighlight).nestedBlockHint
    if (hint?.kind === 'list-item') {
      const listItem = best.el.querySelectorAll(':scope > li')[hint.index]
      if (listItem) return listItem
    } else if (hint?.kind === 'table-row') {
      const tableRow = best.el.querySelectorAll('tr')[hint.index]
      if (tableRow) return tableRow
    }
  }

  return best.el
}

/**
 * Evaluates Preview search match counts and regex validation errors for a rendered tree,
 * validating regex syntax even when the document is blank or whitespace-only.
 */
export function evaluatePreviewSearchMatches(
  target: PreviewSearchTarget,
  criteria: DocumentFindCriteria
): PreviewSearchMatchResult {
  const plan = buildPreviewSearchPlan(target, criteria)
  return {
    matchCount: plan.matchCount,
    errorMessage: plan.errorMessage
  }
}

/**
 * Applies active/inactive `<mark>` search highlights and optional temporary jump highlights
 * across a rendered Preview React tree while excluding Mermaid diagrams and code block UI chrome.
 */
export function highlightPreviewTree(
  target: PreviewSearchTarget,
  findHighlight: DocumentFindHighlightQuery | null | undefined,
  jumpHighlight?: PreviewJumpHighlightQuery | null,
  markdown = ''
): ReactNode {
  const hasActiveFind = Boolean(
    findHighlight?.isActive && findHighlight.criteria.query.length > 0 && !target.isBlankDocument
  )
  const hasActiveJump = Boolean(
    jumpHighlight && jumpHighlight.query.length > 0 && !target.isBlankDocument
  )
  if (!hasActiveFind && !hasActiveJump) {
    return target.baseTree
  }

  const findPlan = hasActiveFind ? buildPreviewSearchPlan(target, findHighlight!.criteria) : EMPTY_SEARCH_PLAN
  const jumpPatches = hasActiveJump
    ? buildPreviewJumpPatches(target, markdown, jumpHighlight!)
    : { textPatches: new Map<number, PreviewSearchMatchSpan[]>(), codePatches: new Map<number, PreviewSearchMatchSpan[]>() }

  const mergedTextPatches = mergePatchMaps(findPlan.textPatches, jumpPatches.textPatches)
  const mergedCodePatches = mergePatchMaps(findPlan.codePatches, jumpPatches.codePatches)
  if (mergedTextPatches.size === 0 && mergedCodePatches.size === 0) {
    return target.baseTree
  }

  return applyPreviewSearchPlan(
    target.baseTree,
    {
      matchCount: findPlan.matchCount,
      errorMessage: null,
      textPatches: mergedTextPatches,
      codePatches: mergedCodePatches
    },
    hasActiveFind ? findHighlight!.activeIndex : -1,
    target.classify
  )
}
