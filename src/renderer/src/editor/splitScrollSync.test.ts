import { describe, expect, it } from 'vitest'
import {
  collectPreviewSourceBlocks,
  computePreviewScrollTopFromRaw,
  computeRawScrollTopFromPreview,
  createScrollSyncLoopGuard,
  type PreviewSourceBlock,
  type RawScrollGeometry
} from './splitScrollSync'

function createUniformRawScrollGeometry(options: {
  scrollTop: number
  clientHeight: number
  scrollHeight: number
  lineHeight: number
  totalLines: number
  paddingTop?: number
}): RawScrollGeometry {
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
      if (docY <= 0) return 1
      return Math.min(totalLines + 1, Math.max(1, 1 + docY / lineHeight))
    },
    getOffsetForLine(line: number): number {
      const clampedLine = Math.min(totalLines + 1, Math.max(1, line))
      return (clampedLine - 1) * lineHeight
    }
  }
}

describe('splitScrollSync bidirectional line-based interpolation & loop guard', () => {
  const sampleBlocks: readonly PreviewSourceBlock[] = [
    { startLine: 1, endLine: 1, top: 16, height: 40 },
    { startLine: 3, endLine: 6, top: 76, height: 200 }, // e.g. 4-line Mermaid block: [3, 7] -> [76, 276]
    { startLine: 8, endLine: 20, top: 296, height: 520 } // [8, 21] -> [296, 816]
  ]

  it('preserves top (scrollTop = 0) and bottom (maxScrollTop) boundaries in both directions', () => {
    const rawAtTop = createUniformRawScrollGeometry({
      scrollTop: 0,
      clientHeight: 300,
      scrollHeight: 620, // 20 lines * 30px + 20px padding? -> let's use lineHeight 20, paddingTop 16: total 20*20+32 = 432
      lineHeight: 20,
      totalLines: 20,
      paddingTop: 16
    })
    const previewMetrics = {
      scrollTop: 0,
      clientHeight: 300,
      scrollHeight: 832, // maxScrollTop = 532
      blocks: sampleBlocks,
      totalLines: 20
    }

    expect(computePreviewScrollTopFromRaw(rawAtTop, previewMetrics)).toBe(0)
    expect(computeRawScrollTopFromPreview(previewMetrics, rawAtTop)).toBe(0)

    // Bottom boundary: even when Raw and Preview have mismatched heights, reaching bottom aligns to target bottom
    const rawAtBottom = createUniformRawScrollGeometry({
      scrollTop: 320, // 620 - 300 = 320
      clientHeight: 300,
      scrollHeight: 620,
      lineHeight: 20,
      totalLines: 20,
      paddingTop: 16
    })
    expect(computePreviewScrollTopFromRaw(rawAtBottom, previewMetrics)).toBe(532)

    // Sub-pixel Chromium bottom rounding (maxScrollTop - 0.5) also preserves bottom boundary
    const rawNearBottom = createUniformRawScrollGeometry({
      scrollTop: 319.5,
      clientHeight: 300,
      scrollHeight: 620,
      lineHeight: 20,
      totalLines: 20,
      paddingTop: 16
    })
    expect(computePreviewScrollTopFromRaw(rawNearBottom, previewMetrics)).toBe(532)

    const previewAtBottom = { ...previewMetrics, scrollTop: 532 }
    expect(computeRawScrollTopFromPreview(previewAtBottom, rawAtTop)).toBe(320)

    // Top-padding bridge remains continuous across scrollTop = 0 .. paddingTop (16) -> blocks[0].top (16)
    expect(computePreviewScrollTopFromRaw({ ...rawAtTop, scrollTop: 8 }, previewMetrics)).toBe(8)
    expect(computeRawScrollTopFromPreview({ ...previewMetrics, scrollTop: 8 }, rawAtTop)).toBe(8)
    expect(computePreviewScrollTopFromRaw({ ...rawAtTop, scrollTop: 16 }, previewMetrics)).toBe(16)
    expect(computeRawScrollTopFromPreview({ ...previewMetrics, scrollTop: 16 }, rawAtTop)).toBe(16)
  })

  it('linearly interpolates within multi-line blocks and inter-block gaps bidirectionally', () => {
    // 20 lines, 20px per line, paddingTop = 0 => line L starts at (L - 1) * 20
    const makeRaw = (scrollTop: number) =>
      createUniformRawScrollGeometry({
        scrollTop,
        clientHeight: 300,
        scrollHeight: 800, // maxScrollTop = 500
        lineHeight: 20,
        totalLines: 20,
        paddingTop: 0
      })
    const makePreview = (scrollTop: number) => ({
      scrollTop,
      clientHeight: 300,
      scrollHeight: 900, // maxScrollTop = 600
      blocks: sampleBlocks,
      totalLines: 20
    })

    // Line 3 starts at raw scrollTop = (3 - 1) * 20 = 40 -> Preview block[1].top = 76
    expect(computePreviewScrollTopFromRaw(makeRaw(40), makePreview(0))).toBe(76)

    // Line 5 (50% through 4-line block [3, 7] -> 76 + 0.5 * 200 = 176): raw scrollTop = (5 - 1) * 20 = 80
    expect(computePreviewScrollTopFromRaw(makeRaw(80), makePreview(0))).toBe(176)
    expect(computeRawScrollTopFromPreview(makePreview(176), makeRaw(0))).toBe(80)

    // Midpoint of gap between block[1] (end=7, bottom=276) and block[2] (start=8, top=296): line 7.5
    // Raw scrollTop for line 7.5 = (7.5 - 1) * 20 = 130 -> Preview scrollTop = 276 + 0.5 * 20 = 286
    expect(computePreviewScrollTopFromRaw(makeRaw(130), makePreview(0))).toBe(286)
    expect(computeRawScrollTopFromPreview(makePreview(286), makeRaw(0))).toBe(130)

    // Line 14.5 inside block[2] ([8, 21] span 13 lines -> [296, 816], 40px/line):
    // 296 + ((14.5 - 8) / 13) * 520 = 296 + 0.5 * 520 = 556 -> raw (14.5 - 1) * 20 = 270
    expect(computePreviewScrollTopFromRaw(makeRaw(270), makePreview(0))).toBe(556)
    expect(computeRawScrollTopFromPreview(makePreview(556), makeRaw(0))).toBe(270)
  })

  it('handles pre-block leading gaps, empty block proportional fallback, and unscrollable regions cleanly', () => {
    const delayedBlocks: readonly PreviewSourceBlock[] = [
      { startLine: 5, endLine: 6, top: 40, height: 60 }
    ]
    // Between line 1 (y=0) and line 5 (y=40), line 3 (raw scrollTop = 40 at 20px/line) is 50% -> y = 20
    const delayedRaw = createUniformRawScrollGeometry({
      scrollTop: 40,
      clientHeight: 200,
      scrollHeight: 600,
      lineHeight: 20,
      totalLines: 10
    })
    const delayedPreview = {
      scrollTop: 20,
      clientHeight: 200,
      scrollHeight: 600,
      blocks: delayedBlocks,
      totalLines: 10
    }
    expect(computePreviewScrollTopFromRaw(delayedRaw, delayedPreview)).toBe(20)
    expect(computeRawScrollTopFromPreview(delayedPreview, delayedRaw)).toBe(40)

    // Unscrollable region (scrollHeight <= clientHeight) returns null so jsdom/short docs don't jump
    const unscrollableRaw = createUniformRawScrollGeometry({
      scrollTop: 50,
      clientHeight: 400,
      scrollHeight: 400,
      lineHeight: 20,
      totalLines: 5
    })
    const scrollablePreview = {
      scrollTop: 100,
      clientHeight: 200,
      scrollHeight: 600,
      blocks: sampleBlocks,
      totalLines: 20
    }
    expect(computePreviewScrollTopFromRaw(unscrollableRaw, scrollablePreview)).toBeNull()
    expect(computeRawScrollTopFromPreview(scrollablePreview, unscrollableRaw)).toBeNull()

    // Empty blocks list falls back to proportional scroll mapping
    const scrollableRaw = createUniformRawScrollGeometry({
      scrollTop: 100,
      clientHeight: 200,
      scrollHeight: 600, // max = 400 -> 25%
      lineHeight: 20,
      totalLines: 30
    })
    const emptyBlocksPreview = {
      scrollTop: 150,
      clientHeight: 200,
      scrollHeight: 800, // max = 600 -> 25%
      blocks: [],
      totalLines: 30
    }
    expect(computePreviewScrollTopFromRaw(scrollableRaw, emptyBlocksPreview)).toBe(150)
    expect(computeRawScrollTopFromPreview(emptyBlocksPreview, scrollableRaw)).toBe(100)
  })

  it('collects top-level [data-source-line] preview blocks relative to scroll container and skips nested duplicates', () => {
    const container = document.createElement('div')
    container.scrollTop = 120
    container.getBoundingClientRect = () =>
      ({ top: 100, left: 0, right: 500, bottom: 500, width: 500, height: 400, x: 0, y: 100, toJSON: () => ({}) })

    const b1 = document.createElement('h1')
    b1.setAttribute('data-source-line', '1')
    b1.setAttribute('data-source-end-line', '1')
    b1.getBoundingClientRect = () =>
      ({ top: -4, left: 0, right: 500, bottom: 36, width: 500, height: 40, x: 0, y: -4, toJSON: () => ({}) })

    const b2 = document.createElement('div')
    b2.setAttribute('data-source-line', '3')
    b2.setAttribute('data-source-end-line', '8')
    b2.getBoundingClientRect = () =>
      ({ top: 56, left: 0, right: 500, bottom: 256, width: 500, height: 200, x: 0, y: 56, toJSON: () => ({}) })

    // Nested element with data-source-line should be ignored so parent span stays monotonic
    const nested = document.createElement('p')
    nested.setAttribute('data-source-line', '4')
    nested.getBoundingClientRect = () =>
      ({ top: 80, left: 0, right: 500, bottom: 100, width: 500, height: 20, x: 0, y: 80, toJSON: () => ({}) })
    b2.appendChild(nested)

    container.appendChild(b2)
    container.appendChild(b1) // appended out of order to verify sorting by startLine

    const collected = collectPreviewSourceBlocks(container)
    expect(collected).toEqual([
      { startLine: 1, endLine: 1, top: 16, height: 40 },
      { startLine: 3, endLine: 8, top: 76, height: 200 }
    ])
  })

  it('prevents infinite scroll ping-pong via ScrollSyncLoopGuard while allowing subsequent genuine user scrolls', () => {
    let clock = 1000
    const guard = createScrollSyncLoopGuard({
      windowMs: 150,
      tolerancePx: 2,
      now: () => clock
    })

    // Programmatic sync sets preview to 420 -> immediate echo event at 420 (or 421 within tolerance) is ignored once
    guard.markProgrammaticScroll('preview', 420)
    expect(guard.shouldIgnoreScroll('preview', 420)).toBe(true)
    // Consumed after echo is handled, so next user scroll is NOT ignored
    expect(guard.shouldIgnoreScroll('preview', 420)).toBe(false)

    // Scroll to a noticeably different offset is treated as genuine user scroll even within windowMs
    guard.markProgrammaticScroll('raw', 250)
    clock += 10
    expect(guard.shouldIgnoreScroll('raw', 310)).toBe(false)

    // Expired programmatic lock does not swallow later user scroll
    guard.markProgrammaticScroll('preview', 500)
    clock += 200
    expect(guard.shouldIgnoreScroll('preview', 500)).toBe(false)

    // Independent sides (marking raw does not affect preview)
    guard.markProgrammaticScroll('preview', 200)
    expect(guard.shouldIgnoreScroll('raw', 100)).toBe(false)
    expect(guard.shouldIgnoreScroll('preview', 200)).toBe(true)

    // Custom tolerance override allows CodeMirror scrollIntoView yMargin offsets
    guard.markProgrammaticScroll('raw', 300, 6)
    expect(guard.shouldIgnoreScroll('raw', 295)).toBe(true)
  })
})
