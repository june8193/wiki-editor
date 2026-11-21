import type { EditorView } from '@codemirror/view'

export interface PreviewSourceBlock {
  startLine: number
  endLine: number
  top: number
  height: number
}

export interface PreviewScrollMetrics {
  scrollTop: number
  clientHeight: number
  scrollHeight: number
  blocks: readonly PreviewSourceBlock[]
  totalLines?: number
}

export interface RawScrollGeometry {
  scrollTop: number
  clientHeight: number
  scrollHeight: number
  paddingTop: number
  totalLines: number
  getLineAtOffset: (docY: number) => number
  getOffsetForLine: (line: number) => number
}

export type ScrollSyncSide = 'raw' | 'preview'

export interface ScrollSyncLoopGuardOptions {
  windowMs?: number
  tolerancePx?: number
  now?: () => number
}

export interface ScrollSyncLoopGuard {
  markProgrammaticScroll: (side: ScrollSyncSide, expectedScrollTop: number) => void
  shouldIgnoreScroll: (side: ScrollSyncSide, actualScrollTop: number) => boolean
}

interface PreviewLineSegment {
  lineStart: number
  lineEnd: number
  offsetStart: number
  offsetEnd: number
}

interface NormalizedPreviewLayout {
  blocks: readonly PreviewSourceBlock[]
  clientHeight: number
  scrollHeight: number
  totalLines: number
}

const DEFAULT_GUARD_WINDOW_MS = 150
const DEFAULT_GUARD_TOLERANCE_PX = 2

function clamp(value: number, min: number, max: number): number {
  if (max <= min) return min
  return Math.min(max, Math.max(min, value))
}

function interpolateLinear(x: number, x0: number, x1: number, y0: number, y1: number): number {
  if (x1 <= x0) return y0
  const progress = clamp((x - x0) / (x1 - x0), 0, 1)
  return y0 + progress * (y1 - y0)
}

function isAtBottomBoundary(scrollTop: number, maxScrollTop: number): boolean {
  if (maxScrollTop <= 0) return false
  // Allow sub-pixel rounding (e.g. fractional DPI zoom in Chromium) while preserving intermediate steps.
  const epsilon = Math.min(1, maxScrollTop * 0.01)
  return scrollTop >= maxScrollTop - epsilon
}

function normalizeBlocks(blocks: readonly PreviewSourceBlock[]): PreviewSourceBlock[] {
  const normalized: PreviewSourceBlock[] = []
  for (const block of blocks) {
    if (
      !Number.isFinite(block.startLine) ||
      block.startLine < 1 ||
      !Number.isFinite(block.top) ||
      !Number.isFinite(block.height) ||
      block.height < 0
    ) {
      continue
    }
    const endLine =
      Number.isFinite(block.endLine) && block.endLine >= block.startLine
        ? block.endLine
        : block.startLine
    normalized.push({
      startLine: block.startLine,
      endLine,
      top: block.top,
      height: block.height
    })
  }
  normalized.sort((a, b) => a.startLine - b.startLine || a.top - b.top)
  return normalized
}

function buildPreviewLineSegments(layout: NormalizedPreviewLayout): PreviewLineSegment[] {
  const { blocks, scrollHeight, totalLines } = layout
  if (blocks.length === 0) return []

  const segments: PreviewLineSegment[] = []
  const first = blocks[0]
  if (first.startLine > 1 && first.top > 0) {
    segments.push({
      lineStart: 1,
      lineEnd: first.startLine,
      offsetStart: 0,
      offsetEnd: first.top
    })
  }

  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i]
    const blockEnd = block.endLine + 1
    const blockBottom = block.top + block.height
    segments.push({
      lineStart: block.startLine,
      lineEnd: blockEnd,
      offsetStart: block.top,
      offsetEnd: blockBottom
    })

    if (i + 1 < blocks.length) {
      const next = blocks[i + 1]
      if (next.startLine > blockEnd) {
        segments.push({
          lineStart: blockEnd,
          lineEnd: next.startLine,
          offsetStart: blockBottom,
          offsetEnd: next.top
        })
      }
    }
  }

  const last = blocks[blocks.length - 1]
  const lastEnd = last.endLine + 1
  const lastBottom = last.top + last.height
  const targetEndLine = Math.max(totalLines + 1, lastEnd)
  const targetEndOffset = Math.max(lastBottom, scrollHeight)
  if (targetEndLine > lastEnd && targetEndOffset > lastBottom) {
    segments.push({
      lineStart: lastEnd,
      lineEnd: targetEndLine,
      offsetStart: lastBottom,
      offsetEnd: targetEndOffset
    })
  }

  return segments
}

function mapRawScrollTopToLine(raw: RawScrollGeometry): number {
  if (raw.scrollTop <= 0) return 1
  const docY = Math.max(0, raw.scrollTop - raw.paddingTop)
  return raw.getLineAtOffset(docY)
}

function mapLineAcrossBlocks(line: number, layout: NormalizedPreviewLayout): number {
  const maxScrollTop = Math.max(0, layout.scrollHeight - layout.clientHeight)
  const segments = buildPreviewLineSegments(layout)
  if (segments.length === 0) return 0

  for (const seg of segments) {
    if (line <= seg.lineEnd) {
      return clamp(
        interpolateLinear(line, seg.lineStart, seg.lineEnd, seg.offsetStart, seg.offsetEnd),
        0,
        maxScrollTop
      )
    }
  }

  return clamp(segments[segments.length - 1].offsetEnd, 0, maxScrollTop)
}

function mapOffsetAcrossBlocks(scrollTop: number, layout: NormalizedPreviewLayout): number {
  const segments = buildPreviewLineSegments(layout)
  if (segments.length === 0) return 1

  const y = Math.max(0, scrollTop)
  for (const seg of segments) {
    if (y <= seg.offsetEnd) {
      return interpolateLinear(y, seg.offsetStart, seg.offsetEnd, seg.lineStart, seg.lineEnd)
    }
  }

  return segments[segments.length - 1].lineEnd
}

function prepareSplitSync(params: {
  sourceTop: number
  sourceMax: number
  targetMax: number
  rawPaddingTop: number
  preview: Omit<PreviewScrollMetrics, 'scrollTop'>
  fallbackTotalLines: number
}):
  | { kind: 'resolved'; scrollTop: number | null }
  | { kind: 'interpolate'; layout: NormalizedPreviewLayout; hasTopPaddingBridge: boolean } {
  const { sourceTop, sourceMax, targetMax, rawPaddingTop, preview, fallbackTotalLines } = params
  if (sourceMax <= 0 || targetMax <= 0) {
    return { kind: 'resolved', scrollTop: null }
  }
  if (sourceTop <= 0) {
    return { kind: 'resolved', scrollTop: 0 }
  }
  if (isAtBottomBoundary(sourceTop, sourceMax)) {
    return { kind: 'resolved', scrollTop: targetMax }
  }

  const blocks = normalizeBlocks(preview.blocks)
  if (blocks.length === 0) {
    return {
      kind: 'resolved',
      scrollTop: clamp((sourceTop / sourceMax) * targetMax, 0, targetMax)
    }
  }

  return {
    kind: 'interpolate',
    layout: {
      blocks,
      clientHeight: preview.clientHeight,
      scrollHeight: preview.scrollHeight,
      totalLines: preview.totalLines ?? fallbackTotalLines
    },
    hasTopPaddingBridge: rawPaddingTop > 0 && blocks[0].startLine === 1 && blocks[0].top > 0
  }
}

/**
 * Collects top-level `[data-source-line]` Preview block positions relative to the scroll container.
 */
export function collectPreviewSourceBlocks(container: HTMLElement): PreviewSourceBlock[] {
  const containerRect = container.getBoundingClientRect()
  const baseTop = containerRect.top + container.clientTop - container.scrollTop
  const candidates = container.querySelectorAll<HTMLElement>('[data-source-line]')
  const rawBlocks: PreviewSourceBlock[] = []

  for (const el of candidates) {
    const parentSource = el.parentElement?.closest('[data-source-line]')
    if (parentSource && container.contains(parentSource)) {
      continue
    }
    const startLine = Number(el.getAttribute('data-source-line'))
    if (!Number.isFinite(startLine) || startLine < 1) continue
    const endLine = Number(el.getAttribute('data-source-end-line') ?? startLine)
    const rect = el.getBoundingClientRect()
    rawBlocks.push({
      startLine,
      endLine,
      top: rect.top - baseTop,
      height: Math.max(0, rect.height)
    })
  }

  return normalizeBlocks(rawBlocks)
}

/**
 * Builds a Raw scroll geometry adapter backed by CodeMirror 6 line blocks (line-wrapping safe).
 */
export function createCodeMirrorRawScrollGeometry(view: EditorView): RawScrollGeometry {
  const paddingTop = view.documentPadding.top
  const paddingBottom = view.documentPadding.bottom
  const totalLines = Math.max(1, view.state.doc.lines)
  const scrollTop = view.scrollDOM.scrollTop
  const clientHeight = view.scrollDOM.clientHeight
  const scrollHeight = view.scrollDOM.scrollHeight
  const viewDocHeight = Math.max(1, view.contentHeight - paddingTop - paddingBottom)
  const domDocHeight =
    scrollHeight > clientHeight ? Math.max(1, scrollHeight - paddingTop - paddingBottom) : viewDocHeight
  const scale = Math.abs(domDocHeight - viewDocHeight) > 4 ? viewDocHeight / domDocHeight : 1

  return {
    scrollTop,
    clientHeight,
    scrollHeight,
    paddingTop,
    totalLines,
    getLineAtOffset(docY: number): number {
      if (docY <= 0) return 1
      const scaledY = Math.max(0, docY * scale)
      const block = view.lineBlockAtHeight(scaledY)
      const lineNumber = view.state.doc.lineAt(block.from).number
      const fraction = block.height > 0 ? clamp((scaledY - block.top) / block.height, 0, 1) : 0
      return clamp(lineNumber + fraction, 1, totalLines + 1)
    },
    getOffsetForLine(line: number): number {
      const clampedLine = clamp(line, 1, totalLines + 1)
      const baseLineNumber = Math.min(totalLines, Math.floor(clampedLine))
      const fraction = clampedLine - baseLineNumber
      const lineInfo = view.state.doc.line(baseLineNumber)
      const block = view.lineBlockAt(lineInfo.from)
      const viewDocY = block.top + fraction * block.height
      return scale > 0 ? viewDocY / scale : viewDocY
    }
  }
}

/**
 * Maps a 1-based fractional source line to a clamped Raw `scrollTop` offset (preserving `paddingTop`).
 */
export function mapLineToRawScrollTop(line: number, raw: RawScrollGeometry): number {
  const maxScrollTop = Math.max(0, raw.scrollHeight - raw.clientHeight)
  if (maxScrollTop <= 0) return 0
  return clamp(raw.paddingTop + raw.getOffsetForLine(line), 0, maxScrollTop)
}

/**
 * Computes target Preview `scrollTop` from Raw scroll geometry, preserving top/bottom boundaries.
 * Returns `null` when either split region is non-scrollable.
 */
export function computePreviewScrollTopFromRaw(
  raw: RawScrollGeometry,
  preview: PreviewScrollMetrics
): number | null {
  const rawMax = Math.max(0, raw.scrollHeight - raw.clientHeight)
  const previewMax = Math.max(0, preview.scrollHeight - preview.clientHeight)
  const prep = prepareSplitSync({
    sourceTop: raw.scrollTop,
    sourceMax: rawMax,
    targetMax: previewMax,
    rawPaddingTop: raw.paddingTop,
    preview,
    fallbackTotalLines: raw.totalLines
  })
  if (prep.kind === 'resolved') return prep.scrollTop

  if (prep.hasTopPaddingBridge && raw.scrollTop < raw.paddingTop) {
    return clamp(
      interpolateLinear(raw.scrollTop, 0, raw.paddingTop, 0, prep.layout.blocks[0].top),
      0,
      previewMax
    )
  }

  return mapLineAcrossBlocks(mapRawScrollTopToLine(raw), prep.layout)
}

/**
 * Computes target Raw `scrollTop` from Preview scroll metrics, preserving top/bottom boundaries.
 * Returns `null` when either split region is non-scrollable.
 */
export function computeRawScrollTopFromPreview(
  preview: PreviewScrollMetrics,
  raw: RawScrollGeometry
): number | null {
  const previewMax = Math.max(0, preview.scrollHeight - preview.clientHeight)
  const rawMax = Math.max(0, raw.scrollHeight - raw.clientHeight)
  const prep = prepareSplitSync({
    sourceTop: preview.scrollTop,
    sourceMax: previewMax,
    targetMax: rawMax,
    rawPaddingTop: raw.paddingTop,
    preview,
    fallbackTotalLines: raw.totalLines
  })
  if (prep.kind === 'resolved') return prep.scrollTop

  if (prep.hasTopPaddingBridge && preview.scrollTop < prep.layout.blocks[0].top) {
    return clamp(
      interpolateLinear(preview.scrollTop, 0, prep.layout.blocks[0].top, 0, raw.paddingTop),
      0,
      rawMax
    )
  }

  const line = mapOffsetAcrossBlocks(preview.scrollTop, prep.layout)
  return mapLineToRawScrollTop(line, raw)
}

/**
 * Direction-aware programmatic scroll guard that prevents Raw <-> Preview ping-pong loops
 * while immediately recognizing subsequent genuine user scrolls on either split region.
 */
export function createScrollSyncLoopGuard(
  options: ScrollSyncLoopGuardOptions = {}
): ScrollSyncLoopGuard {
  const windowMs = options.windowMs ?? DEFAULT_GUARD_WINDOW_MS
  const tolerancePx = options.tolerancePx ?? DEFAULT_GUARD_TOLERANCE_PX
  const now = options.now ?? Date.now

  const pending: Record<
    ScrollSyncSide,
    { expectedScrollTop: number; expiresAt: number } | null
  > = {
    raw: null,
    preview: null
  }

  return {
    markProgrammaticScroll(side: ScrollSyncSide, expectedScrollTop: number): void {
      pending[side] = {
        expectedScrollTop,
        expiresAt: now() + windowMs
      }
    },
    shouldIgnoreScroll(side: ScrollSyncSide, actualScrollTop: number): boolean {
      const entry = pending[side]
      if (!entry) return false
      pending[side] = null
      if (now() > entry.expiresAt) {
        return false
      }
      return Math.abs(actualScrollTop - entry.expectedScrollTop) <= tolerancePx
    }
  }
}
