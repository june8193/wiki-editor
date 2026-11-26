import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

export const VIRTUAL_SCROLL_ROW_THRESHOLD = 200
export const DEFAULT_DIFF_ROW_HEIGHT = 22
export const DEFAULT_DIFF_VIEWPORT_HEIGHT = 600
export const DIFF_VIRTUAL_OVERSCAN_ROWS = 15

interface UseDiffVirtualScrollOptions {
  totalRows: number
  /** Deterministic identifier for the diff target (e.g. formatGitDiffTabKey). Changes reset scrollTop to 0. */
  fileKey: string
  /** Current view mode; changes clear measured row heights without resetting scrollTop. */
  viewMode: string
  /** Reference identity for parsed patch content; changes clear measured row heights. */
  patchIdentity: unknown
}

export interface UseDiffVirtualScrollResult {
  isVirtualized: boolean
  startIndex: number
  endIndex: number
  topSpacerHeight: number
  bottomSpacerHeight: number
  scrollContainerRef: (element: HTMLDivElement | null) => void
  scrollToRowIndex: (rowIndex: number) => void
}

function findRowIndexAtOffset(offsets: Float64Array, targetOffset: number): number {
  const rowCount = offsets.length - 1
  if (rowCount <= 0) {
    return 0
  }
  let low = 0
  let high = rowCount - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (offsets[mid] <= targetOffset) {
      low = mid
    } else {
      high = mid - 1
    }
  }
  return low
}

/**
 * Provides viewport windowing (virtual scroll) for large diff tables while preserving
 * total scroll height via top/bottom spacer rows, variable wrapped-row height measurement,
 * and automatic scrollTop reset when switching to a different diff target file.
 */
export function useDiffVirtualScroll({
  totalRows,
  fileKey,
  viewMode,
  patchIdentity
}: UseDiffVirtualScrollOptions): UseDiffVirtualScrollResult {
  const isVirtualized = totalRows > VIRTUAL_SCROLL_ROW_THRESHOLD
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  const [measureVersion, setMeasureVersion] = useState(0)

  const measuredHeightsRef = useRef<Map<number, number>>(new Map())
  const prevFileKeyRef = useRef(fileKey)
  const prevViewModeRef = useRef(viewMode)
  const prevPatchIdentityRef = useRef(patchIdentity)

  const scrollContainerRef = useCallback((element: HTMLDivElement | null) => {
    setScrollElement(element)
  }, [])

  // Reset scrollTop only when switching to a different file/diff target
  useLayoutEffect(() => {
    if (prevFileKeyRef.current !== fileKey) {
      prevFileKeyRef.current = fileKey
      if (scrollElement) {
        scrollElement.scrollTop = 0
      }
      setScrollTop(0)
    }
  }, [fileKey, scrollElement])

  const rowOffsets = useMemo(() => {
    if (
      prevViewModeRef.current !== viewMode ||
      prevPatchIdentityRef.current !== patchIdentity ||
      prevFileKeyRef.current !== fileKey
    ) {
      prevViewModeRef.current = viewMode
      prevPatchIdentityRef.current = patchIdentity
      measuredHeightsRef.current.clear()
    }
    if (!isVirtualized) {
      return null
    }
    const offsets = new Float64Array(totalRows + 1)
    const measured = measuredHeightsRef.current
    for (let i = 0; i < totalRows; i += 1) {
      offsets[i + 1] = offsets[i] + (measured.get(i) ?? DEFAULT_DIFF_ROW_HEIGHT)
    }
    return offsets
    // measureVersion intentionally invalidates offsets when measuredHeightsRef updates
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVirtualized, totalRows, measureVersion, fileKey, viewMode, patchIdentity])

  const { startIndex, endIndex, topSpacerHeight, bottomSpacerHeight } = useMemo(() => {
    if (!isVirtualized || !rowOffsets) {
      return {
        startIndex: 0,
        endIndex: totalRows,
        topSpacerHeight: 0,
        bottomSpacerHeight: 0
      }
    }
    const totalHeight = rowOffsets[totalRows]
    const effectiveViewport = viewportHeight > 0 ? viewportHeight : DEFAULT_DIFF_VIEWPORT_HEIGHT
    const maxScroll = Math.max(0, totalHeight - effectiveViewport)
    const clampedScrollTop = Math.max(0, Math.min(scrollTop, maxScroll))

    const visibleStart = findRowIndexAtOffset(rowOffsets, clampedScrollTop)
    const visibleEnd = Math.min(
      totalRows,
      findRowIndexAtOffset(rowOffsets, clampedScrollTop + effectiveViewport) + 1
    )

    const nextStart = Math.max(0, visibleStart - DIFF_VIRTUAL_OVERSCAN_ROWS)
    const nextEnd = Math.min(totalRows, visibleEnd + DIFF_VIRTUAL_OVERSCAN_ROWS)

    return {
      startIndex: nextStart,
      endIndex: nextEnd,
      topSpacerHeight: rowOffsets[nextStart],
      bottomSpacerHeight: Math.max(0, totalHeight - rowOffsets[nextEnd])
    }
  }, [isVirtualized, rowOffsets, totalRows, viewportHeight, scrollTop])

  const measureMountedRows = useCallback(() => {
    if (!isVirtualized || !scrollElement || !rowOffsets) {
      return
    }
    const rows = scrollElement.querySelectorAll<HTMLTableRowElement>('tr[data-row-index]')
    if (rows.length === 0) {
      return
    }
    let changed = false
    let aboveViewportDelta = 0
    const currentScrollTop = scrollElement.scrollTop

    for (const row of rows) {
      const idxAttr = row.getAttribute('data-row-index')
      if (idxAttr === null) {
        continue
      }
      const idx = Number(idxAttr)
      if (!Number.isInteger(idx) || idx < 0 || idx >= totalRows) {
        continue
      }
      const rectHeight = row.getBoundingClientRect().height
      const measuredHeight = rectHeight > 0 ? rectHeight : row.offsetHeight
      if (measuredHeight <= 0) {
        continue
      }
      const prevHeight = measuredHeightsRef.current.get(idx) ?? DEFAULT_DIFF_ROW_HEIGHT
      if (Math.abs(measuredHeight - prevHeight) > 0.5) {
        measuredHeightsRef.current.set(idx, measuredHeight)
        changed = true
        if (currentScrollTop > 0 && rowOffsets[idx] < currentScrollTop) {
          aboveViewportDelta += measuredHeight - prevHeight
        }
      }
    }

    if (changed) {
      if (aboveViewportDelta !== 0 && currentScrollTop > 0) {
        const nextScrollTop = Math.max(0, currentScrollTop + aboveViewportDelta)
        scrollElement.scrollTop = nextScrollTop
        setScrollTop(nextScrollTop)
      }
      setMeasureVersion((v) => v + 1)
    }
  }, [isVirtualized, scrollElement, rowOffsets, totalRows])

  // Measure newly mounted rows after each window render
  useLayoutEffect(() => {
    measureMountedRows()
  }, [measureMountedRows, startIndex, endIndex])

  // Track scroll position and container/row resizes
  useEffect(() => {
    if (!scrollElement) {
      return
    }

    const syncViewportAndRows = () => {
      const nextHeight = scrollElement.clientHeight
      setViewportHeight((prev) => (prev === nextHeight ? prev : nextHeight))
      const nextScrollTop = scrollElement.scrollTop
      setScrollTop((prev) => (prev === nextScrollTop ? prev : nextScrollTop))
      measureMountedRows()
    }

    const handleScroll = () => {
      setScrollTop(scrollElement.scrollTop)
    }

    syncViewportAndRows()
    scrollElement.addEventListener('scroll', handleScroll, { passive: true })

    let observer: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => {
        syncViewportAndRows()
      })
      observer.observe(scrollElement)
    }

    return () => {
      scrollElement.removeEventListener('scroll', handleScroll)
      observer?.disconnect()
    }
  }, [scrollElement, measureMountedRows])

  const scrollToRowIndex = useCallback(
    (rowIndex: number) => {
      if (rowIndex < 0 || rowIndex >= totalRows || !scrollElement) {
        return
      }
      if (isVirtualized && rowOffsets) {
        const totalHeight = rowOffsets[totalRows]
        const effectiveViewport = viewportHeight > 0 ? viewportHeight : DEFAULT_DIFF_VIEWPORT_HEIGHT
        const maxScroll = Math.max(0, totalHeight - effectiveViewport)
        const rowTop = rowOffsets[rowIndex]
        const rowHeight = (rowOffsets[rowIndex + 1] ?? rowTop + DEFAULT_DIFF_ROW_HEIGHT) - rowTop
        const centeredTop = Math.max(
          0,
          Math.min(maxScroll, rowTop - effectiveViewport / 2 + rowHeight / 2)
        )
        scrollElement.scrollTop = centeredTop
        setScrollTop(centeredTop)
        return
      }
      const targetRow = scrollElement.querySelector<HTMLElement>(`tr[data-row-index="${rowIndex}"]`)
      if (targetRow && typeof targetRow.scrollIntoView === 'function') {
        targetRow.scrollIntoView({ block: 'center' })
      }
    },
    [isVirtualized, rowOffsets, scrollElement, totalRows, viewportHeight]
  )

  return {
    isVirtualized,
    startIndex,
    endIndex,
    topSpacerHeight,
    bottomSpacerHeight,
    scrollContainerRef,
    scrollToRowIndex
  }
}
