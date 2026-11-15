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

export interface UniformRawScrollOptions {
  scrollTop: number
  clientHeight: number
  scrollHeight: number
  lineHeight: number
  totalLines: number
  paddingTop?: number
}

export type ScrollSyncSide = 'raw' | 'preview'

export interface ScrollSyncLoopGuardOptions {
  windowMs?: number
  tolerancePx?: number
  now?: () => number
}

export interface ScrollSyncLoopGuard {
  markProgrammaticScroll: (
    side: ScrollSyncSide,
    expectedScrollTop: number,
    tolerancePx?: number
  ) => void
  shouldIgnoreScroll: (side: ScrollSyncSide, actualScrollTop: number) => boolean
  clear: (side?: ScrollSyncSide) => void
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
    const rawEndLine = Number(el.getAttribute('data-source-end-line'))
    const endLine =
      Number.isFinite(rawEndLine) && rawEndLine >= startLine ? rawEndLine : startLine
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
 * Builds a uniform line-height Raw scroll geometry descriptor for deterministic mapping and unit testing.
 */
export function createUniformRawScrollGeometry(options: UniformRawScrollOptions): RawScrollGeometry {
  const paddingTop = Math.max(0, options.paddingTop ?? 0)
  const totalLines = Math.max(1, options.totalLines)
  const lineHeight = Math.max(1, options.lineHeight)

  return {
    scrollTop: options.scrollTop,
    clientHeight: options.clientHeight,
    scrollHeight: options.scrollHeight,
    paddingTop,
    totalLines,
    getLineAtOffset(docY: number): number {
      if (docY <= 0 || totalLines <= 0) return 1
      return clamp(1 + docY / lineHeight, 1, totalLines + 1)
    },
    getOffsetForLine(line: number): number {
      const clampedLine = clamp(line, 1, totalLines + 1)
      return (clampedLine - 1) * lineHeight
    }
  }
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
 * Maps Raw `scrollTop` to a fractional 1-based source line number.
 */
export function mapRawScrollTopToLine(raw: RawScrollGeometry): number {
  if (raw.scrollTop <= 0) return 1
  const docY = Math.max(0, raw.scrollTop - raw.paddingTop)
  return raw.getLineAtOffset(docY)
}

/**
 * Maps a fractional 1-based source line number to a clamped Raw `scrollTop` offset.
 */
export function mapLineToRawScrollTop(line: number, raw: RawScrollGeometry): number {
  const maxScrollTop = Math.max(0, raw.scrollHeight - raw.clientHeight)
  if (line <= 1 || maxScrollTop <= 0) return 0
  return clamp(raw.paddingTop + raw.getOffsetForLine(line), 0, maxScrollTop)
}

/**
 * Maps a fractional 1-based source line number to a clamped Preview `scrollTop` offset
 * by linearly interpolating across `[data-source-line]` blocks and inter-block gaps.
 */
export function mapLineToPreviewScrollTop(
  line: number,
  preview: Omit<PreviewScrollMetrics, 'scrollTop'>
): number {
  const maxScrollTop = Math.max(0, preview.scrollHeight - preview.clientHeight)
  const blocks = normalizeBlocks(preview.blocks)
  if (blocks.length === 0) return 0

  const first = blocks[0]
  if (line < first.startLine) {
    const offset =
      first.startLine <= 1
        ? first.top
        : interpolateLinear(line, 1, first.startLine, 0, first.top)
    return clamp(offset, 0, maxScrollTop)
  }

  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i]
    const blockEnd = block.endLine + 1
    const blockBottom = block.top + block.height

    if (line <= blockEnd) {
      return clamp(
        interpolateLinear(line, block.startLine, blockEnd, block.top, blockBottom),
        0,
        maxScrollTop
      )
    }

    if (i + 1 < blocks.length) {
      const next = blocks[i + 1]
      if (line < next.startLine) {
        return clamp(
          interpolateLinear(line, blockEnd, next.startLine, blockBottom, next.top),
          0,
          maxScrollTop
        )
      }
    }
  }

  const last = blocks[blocks.length - 1]
  const lastEnd = last.endLine + 1
  const lastBottom = last.top + last.height
  const targetEndLine = Math.max((preview.totalLines ?? last.endLine) + 1, lastEnd)
  const targetEndOffset = Math.max(lastBottom, preview.scrollHeight)

  if (targetEndLine > lastEnd && targetEndOffset > lastBottom) {
    return clamp(
      interpolateLinear(line, lastEnd, targetEndLine, lastBottom, targetEndOffset),
      0,
      maxScrollTop
    )
  }
  return clamp(lastBottom, 0, maxScrollTop)
}

/**
 * Inverse-interpolates Preview `scrollTop` to a fractional 1-based source line number.
 */
export function mapPreviewScrollTopToLine(preview: PreviewScrollMetrics): number {
  const blocks = normalizeBlocks(preview.blocks)
  if (blocks.length === 0) return 1

  const y = Math.max(0, preview.scrollTop)
  const first = blocks[0]
  if (y < first.top) {
    if (first.top <= 0 || first.startLine <= 1) return first.startLine
    return interpolateLinear(y, 0, first.top, 1, first.startLine)
  }

  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i]
    const blockEnd = block.endLine + 1
    const blockBottom = block.top + block.height

    if (y <= blockBottom) {
      return interpolateLinear(y, block.top, blockBottom, block.startLine, blockEnd)
    }

    if (i + 1 < blocks.length) {
      const next = blocks[i + 1]
      if (y < next.top) {
        return interpolateLinear(y, blockBottom, next.top, blockEnd, next.startLine)
      }
    }
  }

  const last = blocks[blocks.length - 1]
  const lastEnd = last.endLine + 1
  const lastBottom = last.top + last.height
  const targetEndLine = Math.max((preview.totalLines ?? last.endLine) + 1, lastEnd)
  const targetEndOffset = Math.max(lastBottom, preview.scrollHeight)

  if (targetEndOffset > lastBottom && targetEndLine > lastEnd) {
    return interpolateLinear(y, lastBottom, targetEndOffset, lastEnd, targetEndLine)
  }
  return lastEnd
}

/**
 * Computes target Preview `scrollTop` from Raw scroll geometry, preserving top/bottom boundaries.
 * Returns `null` when either container is non-scrollable.
 */
export function computePreviewScrollTopFromRaw(
  raw: RawScrollGeometry,
  preview: PreviewScrollMetrics
): number | null {
  const rawMax = Math.max(0, raw.scrollHeight - raw.clientHeight)
  const previewMax = Math.max(0, preview.scrollHeight - preview.clientHeight)
  if (rawMax <= 0 || previewMax <= 0) return null

  if (raw.scrollTop <= 0) return 0
  if (isAtBottomBoundary(raw.scrollTop, rawMax)) return previewMax

  const blocks = normalizeBlocks(preview.blocks)
  if (blocks.length === 0) {
    return clamp((raw.scrollTop / rawMax) * previewMax, 0, previewMax)
  }

  if (
    raw.paddingTop > 0 &&
    raw.scrollTop < raw.paddingTop &&
    blocks[0].startLine === 1 &&
    blocks[0].top > 0
  ) {
    return clamp(interpolateLinear(raw.scrollTop, 0, raw.paddingTop, 0, blocks[0].top), 0, previewMax)
  }

  const line = mapRawScrollTopToLine(raw)
  return mapLineToPreviewScrollTop(line, {
    clientHeight: preview.clientHeight,
    scrollHeight: preview.scrollHeight,
    blocks,
    totalLines: preview.totalLines ?? raw.totalLines
  })
}

/**
 * Computes target Raw `scrollTop` from Preview scroll metrics, preserving top/bottom boundaries.
 * Returns `null` when either container is non-scrollable.
 */
export function computeRawScrollTopFromPreview(
  preview: PreviewScrollMetrics,
  raw: RawScrollGeometry
): number | null {
  const previewMax = Math.max(0, preview.scrollHeight - preview.clientHeight)
  const rawMax = Math.max(0, raw.scrollHeight - raw.clientHeight)
  if (previewMax <= 0 || rawMax <= 0) return null

  if (preview.scrollTop <= 0) return 0
  if (isAtBottomBoundary(preview.scrollTop, previewMax)) return rawMax

  const blocks = normalizeBlocks(preview.blocks)
  if (blocks.length === 0) {
    return clamp((preview.scrollTop / previewMax) * rawMax, 0, rawMax)
  }

  if (
    raw.paddingTop > 0 &&
    blocks[0].startLine === 1 &&
    blocks[0].top > 0 &&
    preview.scrollTop < blocks[0].top
  ) {
    return clamp(interpolateLinear(preview.scrollTop, 0, blocks[0].top, 0, raw.paddingTop), 0, rawMax)
  }

  const line = mapPreviewScrollTopToLine({
    ...preview,
    blocks,
    totalLines: preview.totalLines ?? raw.totalLines
  })
  return mapLineToRawScrollTop(line, raw)
}

/**
 * Direction-aware programmatic scroll guard that prevents Raw <-> Preview ping-pong loops
 * while immediately recognizing subsequent genuine user scrolls on either pane.
 */
export function createScrollSyncLoopGuard(
  options: ScrollSyncLoopGuardOptions = {}
): ScrollSyncLoopGuard {
  const windowMs = options.windowMs ?? DEFAULT_GUARD_WINDOW_MS
  const tolerancePx = options.tolerancePx ?? DEFAULT_GUARD_TOLERANCE_PX
  const now = options.now ?? Date.now

  const pending: Record<
    ScrollSyncSide,
    { expectedScrollTop: number; expiresAt: number; tolerancePx: number } | null
  > = {
    raw: null,
    preview: null
  }

  return {
    markProgrammaticScroll(
      side: ScrollSyncSide,
      expectedScrollTop: number,
      overrideTolerancePx?: number
    ): void {
      pending[side] = {
        expectedScrollTop,
        expiresAt: now() + windowMs,
        tolerancePx: overrideTolerancePx ?? tolerancePx
      }
    },
    shouldIgnoreScroll(side: ScrollSyncSide, actualScrollTop: number): boolean {
      const entry = pending[side]
      if (!entry) return false
      pending[side] = null
      if (now() > entry.expiresAt) {
        return false
      }
      return Math.abs(actualScrollTop - entry.expectedScrollTop) <= entry.tolerancePx
    },
    clear(side?: ScrollSyncSide): void {
      if (side) {
        pending[side] = null
      } else {
        pending.raw = null
        pending.preview = null
      }
    }
  }
}
