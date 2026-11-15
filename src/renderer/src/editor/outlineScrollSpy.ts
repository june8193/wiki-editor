import type { EditorMode, PaneId } from '../stores/PaneTabStore'
import type { MarkdownHeading } from './MarkdownTocEngine'

export const OUTLINE_SPY_TOP_THRESHOLD_PX = 24
export const OUTLINE_SPY_BOTTOM_EPSILON_PX = 2

export interface HeadingScrollSpySample {
  headingIndex: number | null
  isUserScroll: boolean
}

export interface OutlineContextTarget {
  paneId: PaneId
  tabId: string
  mode: EditorMode
}

export interface OutlineScrollRequest extends OutlineContextTarget {
  line: number
  slug: string
  index: number
  nonce: number
}

export interface DocumentOutlineSpyUpdate extends HeadingScrollSpySample {
  mode: EditorMode
}

export interface OutlineActiveHeadingReport extends HeadingScrollSpySample {
  context: OutlineContextTarget
}

export interface ScrollContainerMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

export interface OffsetActiveHeadingInput extends ScrollContainerMetrics {
  /** Heading top positions relative to the scroll container's visible top edge */
  headingTopOffsets: readonly number[]
}

export interface LineActiveHeadingInput extends ScrollContainerMetrics {
  /** Parsed markdown headings in document order */
  headings: readonly Pick<MarkdownHeading, 'line'>[]
  /** 1-based line number at the scroll container's visible top baseline */
  topLine: number
}

/**
 * Returns true when a scrollable container has actually been scrolled (`scrollTop > 0`)
 * to within `OUTLINE_SPY_BOTTOM_EPSILON_PX` of its bottom edge.
 */
function isScrollAtBottom(metrics: ScrollContainerMetrics): boolean {
  const { scrollTop, scrollHeight, clientHeight } = metrics
  return (
    scrollTop > 0 &&
    scrollHeight > clientHeight &&
    scrollHeight - scrollTop - clientHeight <= OUTLINE_SPY_BOTTOM_EPSILON_PX
  )
}

function resolveLastMatchingHeadingIndex<T>(
  items: readonly T[],
  metrics: ScrollContainerMetrics,
  matchesBaseline: (item: T) => boolean
): number | null {
  if (items.length === 0) return null
  if (isScrollAtBottom(metrics)) {
    return items.length - 1
  }

  let activeIndex: number | null = null
  for (let i = 0; i < items.length; i += 1) {
    if (matchesBaseline(items[i])) {
      activeIndex = i
    }
  }
  return activeIndex
}

/**
 * Resolves the active 0-based heading index from DOM heading top offsets relative to
 * the visible scroll container top edge, accounting for prefaces and manual bottom scrolling.
 */
export function resolveActiveHeadingIndexByOffsets(
  input: OffsetActiveHeadingInput
): number | null {
  return resolveLastMatchingHeadingIndex(
    input.headingTopOffsets,
    input,
    (topOffset) => topOffset <= OUTLINE_SPY_TOP_THRESHOLD_PX
  )
}

/**
 * Resolves the active 0-based heading index from a 1-based visible top line number,
 * accounting for prefaces and manual bottom scrolling.
 */
export function resolveActiveHeadingIndexByLine(input: LineActiveHeadingInput): number | null {
  return resolveLastMatchingHeadingIndex(
    input.headings,
    input,
    (heading) => heading.line <= input.topLine
  )
}

const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6'

function resolveMatchingHeadingElements(
  container: HTMLElement,
  headings: readonly MarkdownHeading[]
): HTMLElement[] {
  const allHeadings = Array.from(container.querySelectorAll<HTMLElement>(HEADING_SELECTOR))
  if (allHeadings.length === headings.length) {
    return allHeadings
  }

  const byId = new Map<string, HTMLElement>()
  for (const el of allHeadings) {
    if (el.id && !byId.has(el.id)) {
      byId.set(el.id, el)
    }
  }

  const matched: HTMLElement[] = []
  for (const heading of headings) {
    const match = byId.get(heading.slug)
    if (match) {
      matched.push(match)
    }
  }
  return matched.length === headings.length ? matched : allHeadings
}

function hasMeasuredElementBox(
  el: HTMLElement,
  rect: DOMRect = el.getBoundingClientRect()
): boolean {
  return el.clientHeight > 0 || el.scrollHeight > 0 || rect.height > 0
}

function resolveDocumentPaddingTop(
  documentPaddingTop: number | undefined,
  contentDOM: HTMLElement
): number {
  if (typeof documentPaddingTop === 'number' && documentPaddingTop > 0) {
    return documentPaddingTop
  }
  const parsed = Number.parseFloat(getComputedStyle(contentDOM).paddingTop)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

export interface RawScrollViewportLike {
  scrollDOM: HTMLElement
  contentDOM: HTMLElement
  documentPadding?: { top: number }
  defaultLineHeight?: number
  state: {
    doc: {
      lines: number
      lineAt: (pos: number) => { number: number }
    }
  }
  lineBlockAtHeight: (height: number) => { from: number; top?: number; bottom?: number }
}

/**
 * Measures heading positions inside a scrollable rendered markdown container (Preview / WYSIWYG)
 * and resolves the active 0-based outline heading index, returning `null` when layout geometry
 * is absent (e.g., unmocked jsdom) or when the scroll position sits in the preface.
 */
export function measureActiveHeadingIndexInContainer(
  container: HTMLElement,
  headings: readonly MarkdownHeading[]
): number | null {
  if (headings.length === 0) return null

  const headingEls = resolveMatchingHeadingElements(container, headings)
  if (headingEls.length === 0) return null

  const containerRect = container.getBoundingClientRect()
  const headingRects = headingEls.map((el) => el.getBoundingClientRect())
  const hasLayoutGeometry =
    hasMeasuredElementBox(container, containerRect) ||
    headingRects.some((rect) => rect.height > 0 || rect.top !== containerRect.top)

  if (!hasLayoutGeometry) {
    return null
  }

  const headingTopOffsets = headingRects.map((rect) => rect.top - containerRect.top)
  return resolveActiveHeadingIndexByOffsets({
    headingTopOffsets,
    scrollTop: container.scrollTop,
    scrollHeight: container.scrollHeight,
    clientHeight: container.clientHeight
  })
}

/**
 * Resolves the active 0-based outline heading index from a CodeMirror 6 Raw editor viewport,
 * returning `null` when layout geometry is absent (e.g., unmocked jsdom) or when the top
 * visible line sits in the preface.
 */
export function measureActiveHeadingIndexInRawEditor(
  view: RawScrollViewportLike,
  headings: readonly Pick<MarkdownHeading, 'line'>[]
): number | null {
  if (headings.length === 0) return null

  const { scrollDOM, contentDOM } = view
  if (!hasMeasuredElementBox(scrollDOM)) {
    return null
  }

  const paddingTop = resolveDocumentPaddingTop(view.documentPadding?.top, contentDOM)
  const baselineHeight = Math.max(
    0,
    scrollDOM.scrollTop + OUTLINE_SPY_TOP_THRESHOLD_PX - paddingTop
  )
  const topBlock = view.lineBlockAtHeight(baselineHeight)
  let topLine = view.state.doc.lineAt(topBlock.from).number
  // In headless jsdom after a CM6 DOM measure cycle, zero-height `.cm-line` rects collapse
  // `heightMap` blocks to zero height (`bottom <= top`); fall back to `defaultLineHeight`.
  const isZeroHeightBlock =
    typeof topBlock.bottom === 'number' && topBlock.bottom <= (topBlock.top ?? 0)
  if (isZeroHeightBlock && baselineHeight > 0) {
    const fallbackLineHeight =
      typeof view.defaultLineHeight === 'number' && view.defaultLineHeight > 0
        ? view.defaultLineHeight
        : 14
    topLine = Math.max(
      1,
      Math.min(view.state.doc.lines, Math.floor(baselineHeight / fallbackLineHeight) + 1)
    )
  }

  return resolveActiveHeadingIndexByLine({
    headings,
    topLine,
    scrollTop: scrollDOM.scrollTop,
    scrollHeight: scrollDOM.scrollHeight,
    clientHeight: scrollDOM.clientHeight
  })
}
