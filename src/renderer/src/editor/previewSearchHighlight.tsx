import { cloneElement, Fragment, isValidElement, type ReactElement, type ReactNode } from 'react'
import { compileSearchMatcher, type CompiledSearchMatcher } from '@shared/search'
import type { CodeBlockHighlightSpan } from './codeBlockHighlight'
import {
  areDocumentFindCriteriaEqual,
  consumeMatchedTextRun,
  type DocumentFindCriteria,
  type DocumentFindHighlightQuery,
  type TextRunSegment
} from './documentFind'

export const PREVIEW_SEARCH_CHROME_SELECTOR =
  '.code-block-header, .mermaid-diagram-block, .markdown-preview-empty'

export interface PreviewSearchMatchSpan {
  start: number
  end: number
  matchIndex: number
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
  key: string
): ReactNode {
  if (text.length === 0) {
    return (
      <span
        key={key}
        className="preview-search-match-anchor"
        data-search-match-index={matchIndex}
      />
    )
  }
  const isActive = matchIndex === activeMatchIndex
  return (
    <mark
      key={key}
      className={
        isActive ? 'preview-search-match preview-search-match-active' : 'preview-search-match'
      }
      data-search-match-index={matchIndex}
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
  const anchorMatchesByOffset = new Map<number, number[]>()
  const overlappingMatches: PreviewSearchMatchSpan[] = []

  for (const match of searchHighlights) {
    const start = Math.max(0, Math.min(text.length, match.start))
    const end = Math.max(start, Math.min(text.length, match.end))
    if (end <= start) {
      if (start >= from && (includeEndAnchors ? start <= to : start < to)) {
        const list = anchorMatchesByOffset.get(start)
        if (list) {
          list.push(match.matchIndex)
        } else {
          anchorMatchesByOffset.set(start, [match.matchIndex])
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
        matchIndex: match.matchIndex
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
      for (const matchIndex of anchors) {
        pieces.push(
          wrapSearchMark(
            '',
            matchIndex,
            activeSearchMatchIndex,
            `${keyPrefix}-a-${pos}-${matchIndex}`
          )
        )
      }
    }
    if (i + 1 >= boundaries.length) break
    const nextPos = boundaries[i + 1]
    if (nextPos <= pos) continue

    const slice = text.slice(pos, nextPos)
    const activeMatch = overlappingMatches.find((m) => m.start <= pos && m.end >= nextPos)
    pieces.push(
      activeMatch
        ? wrapSearchMark(slice, activeMatch.matchIndex, activeSearchMatchIndex, `${keyPrefix}-m-${i}`)
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

    const classification = resolvePreviewElementClassification(node, classify)
    if (classification.kind === 'skip') {
      visitor.onBlockBoundary?.()
      return visitor.identity(node)
    }
    if (classification.kind === 'fenced-code') {
      visitor.onBlockBoundary?.()
      const codeSlotId = classification.isMermaid ? -1 : nextCodeSlotId++
      return visitor.onFencedCode(node, codeSlotId, classification.rawCode, classification.isMermaid)
    }
    if (classification.kind === 'block') {
      visitor.onBlockBoundary?.()
      const nextChild = visit(node.props.children, classification.isWhitespaceContainer)
      visitor.onBlockBoundary?.()
      return visitor.combineElement(node, nextChild)
    }
    const nextChild = visit(node.props.children, classification.isWhitespaceContainer)
    return visitor.combineElement(node, nextChild)
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

function flushPreviewTextRun(
  runSegments: TextSlotSegment[],
  matcher: CompiledSearchMatcher,
  textPatches: Map<number, PreviewSearchMatchSpan[]>,
  nextMatchIndex: () => number
): void {
  if (
    runSegments.some((segment) => segment.text.includes('\n')) &&
    runSegments.every((segment) => /^[\r\n\t ]+$/.test(segment.text))
  ) {
    runSegments.length = 0
    return
  }
  consumeMatchedTextRun(runSegments, matcher, (span, segments) => {
    const matchIndex = nextMatchIndex()
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
        matchIndex
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
          matchIndex
        })
      }
    }
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
  if (plan.matchCount === 0) {
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
 * Applies active/inactive `<mark>` search highlights across a rendered Preview React tree
 * while excluding Mermaid diagrams and code block UI chrome.
 */
export function highlightPreviewTree(
  target: PreviewSearchTarget,
  findHighlight: DocumentFindHighlightQuery | null | undefined
): ReactNode {
  if (
    !findHighlight?.isActive ||
    findHighlight.criteria.query.length === 0 ||
    target.isBlankDocument
  ) {
    return target.baseTree
  }
  const plan = buildPreviewSearchPlan(target, findHighlight.criteria)
  return applyPreviewSearchPlan(target.baseTree, plan, findHighlight.activeIndex, target.classify)
}
