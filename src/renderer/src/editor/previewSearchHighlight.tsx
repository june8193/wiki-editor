import { cloneElement, Fragment, isValidElement, type ReactElement, type ReactNode } from 'react'
import { compileSearchMatcher, type CompiledSearchMatcher } from '@shared/search'
import type { CodeBlockHighlightSpan } from './codeBlockHighlight'
import {
  areDocumentFindCriteriaEqual,
  type DocumentFindCriteria,
  type DocumentFindHighlightQuery
} from './documentFind'

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

interface TextSlotSegment {
  slotId: number
  text: string
  startOffset: number
  endOffset: number
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

/**
 * Renders syntax-highlighted code tokens layered with in-document search `<mark>` spans,
 * cleanly splitting across token boundaries while preserving exact source characters.
 */
export function renderCodeTokensWithSearch(
  code: string,
  syntaxSpans: readonly CodeBlockHighlightSpan[],
  searchHighlights: readonly PreviewSearchMatchSpan[],
  activeSearchMatchIndex: number
): ReactNode {
  const boundarySet = new Set<number>([0, code.length])
  const validSyntaxSpans: CodeBlockHighlightSpan[] = []
  for (const span of syntaxSpans) {
    if (span.from >= 0 && span.to > span.from && span.to <= code.length) {
      validSyntaxSpans.push(span)
      boundarySet.add(span.from)
      boundarySet.add(span.to)
    }
  }

  const anchorMatchesByOffset = new Map<number, number[]>()
  const rangeSearchSpans: PreviewSearchMatchSpan[] = []
  for (const match of searchHighlights) {
    const start = Math.max(0, Math.min(code.length, match.start))
    const end = Math.max(start, Math.min(code.length, match.end))
    if (end <= start) {
      const existing = anchorMatchesByOffset.get(start)
      if (existing) {
        existing.push(match.matchIndex)
      } else {
        anchorMatchesByOffset.set(start, [match.matchIndex])
      }
      boundarySet.add(start)
    } else {
      rangeSearchSpans.push({ start, end, matchIndex: match.matchIndex })
      boundarySet.add(start)
      boundarySet.add(end)
    }
  }

  const boundaries = Array.from(boundarySet).sort((a, b) => a - b)
  const nodes: ReactNode[] = []

  const emitAnchorsAt = (offset: number): void => {
    const anchors = anchorMatchesByOffset.get(offset)
    if (!anchors) return
    anchorMatchesByOffset.delete(offset)
    for (const matchIndex of anchors) {
      nodes.push(wrapSearchMark('', matchIndex, activeSearchMatchIndex, `ca-${offset}-${matchIndex}`))
    }
  }

  for (let i = 0; i < boundaries.length; i += 1) {
    const start = boundaries[i]
    emitAnchorsAt(start)
    if (i + 1 >= boundaries.length) break
    const end = boundaries[i + 1]
    if (end <= start) continue

    const slice = code.slice(start, end)
    const syntaxSpan = validSyntaxSpans.find((span) => span.from <= start && span.to >= end)
    const searchMatch = rangeSearchSpans.find((span) => span.start <= start && span.end >= end)

    let piece: ReactNode = slice
    if (searchMatch) {
      piece = wrapSearchMark(
        slice,
        searchMatch.matchIndex,
        activeSearchMatchIndex,
        `cm-${i}-${searchMatch.matchIndex}`
      )
    }
    if (syntaxSpan) {
      piece = (
        <span key={`tok-${i}`} className={syntaxSpan.className}>
          {piece}
        </span>
      )
    }
    nodes.push(piece)
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
  if (runSegments.length === 0) {
    return
  }
  const combined = runSegments.map((segment) => segment.text).join('')
  if (combined.includes('\n') && /^[\r\n\t ]+$/.test(combined)) {
    runSegments.length = 0
    return
  }
  for (const span of matcher.findMatches(combined)) {
    const matchIndex = nextMatchIndex()
    if (span.end <= span.start) {
      const targetSegment =
        runSegments.find((seg) => span.start <= seg.endOffset) ??
        runSegments[runSegments.length - 1]
      const localPos = Math.max(
        0,
        Math.min(targetSegment.text.length, span.start - targetSegment.startOffset)
      )
      appendPatch(textPatches, targetSegment.slotId, {
        start: localPos,
        end: localPos,
        matchIndex
      })
      continue
    }

    for (const seg of runSegments) {
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
  }
  runSegments.length = 0
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

function renderPatchedText(
  text: string,
  patches: readonly PreviewSearchMatchSpan[],
  activeMatchIndex: number,
  slotId: number
): ReactNode {
  const ordered = [...patches].sort(
    (a, b) => a.start - b.start || a.end - b.end || a.matchIndex - b.matchIndex
  )
  const parts: ReactNode[] = []
  let cursor = 0

  for (let i = 0; i < ordered.length; i += 1) {
    const patch = ordered[i]
    if (patch.start > cursor) {
      parts.push(text.slice(cursor, patch.start))
    }
    if (patch.end <= patch.start) {
      parts.push(
        wrapSearchMark('', patch.matchIndex, activeMatchIndex, `sma-${slotId}-${i}-${patch.matchIndex}`)
      )
      cursor = Math.max(cursor, patch.start)
      continue
    }
    const start = Math.max(cursor, patch.start)
    if (patch.end > start) {
      parts.push(
        wrapSearchMark(
          text.slice(start, patch.end),
          patch.matchIndex,
          activeMatchIndex,
          `sm-${slotId}-${i}-${patch.matchIndex}`
        )
      )
      cursor = patch.end
    }
  }

  if (cursor < text.length) {
    parts.push(text.slice(cursor))
  }

  return <Fragment key={`smf-${slotId}`}>{parts}</Fragment>
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
      return patches ? renderPatchedText(text, patches, activeMatchIndex, slotId) : text
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
