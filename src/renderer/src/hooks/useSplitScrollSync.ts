import { useCallback, useEffect, useRef } from 'react'
import type { EditorView } from '@codemirror/view'
import {
  type ScrollSyncLoopGuard,
  type ScrollSyncSide,
  collectPreviewSourceBlocks,
  computePreviewScrollTopFromRaw,
  computeRawScrollTopFromPreview,
  createCodeMirrorRawScrollGeometry,
  createScrollSyncLoopGuard,
  mapLineToRawScrollTop
} from '../editor/splitScrollSync'
import type { EditorMode } from '../stores/PaneTabStore'
import { useOneShotScroll } from './useOneShotScroll'

export interface SplitOutlineJumpRequest {
  line: number
  nonce: number
}

interface UseSplitScrollSyncOptions {
  effectiveMode: EditorMode
  matchedScrollRequest: SplitOutlineJumpRequest | null
  onUpdateViewState: (patch: { scrollTop?: number }) => void
}

/**
 * Coordinates line-based bidirectional scroll sync, boundary preservation,
 * initial Split entry sync, and Outline heading jumps between the Raw and Preview split regions.
 */
export function useSplitScrollSync({
  effectiveMode,
  matchedScrollRequest,
  onUpdateViewState
}: UseSplitScrollSyncOptions) {
  const rawEditorViewRef = useRef<EditorView | null>(null)
  const splitPreviewContainerRef = useRef<HTMLDivElement | null>(null)
  const scrollSyncGuardRef = useRef<ScrollSyncLoopGuard | null>(null)
  const prevEffectiveModeRef = useRef<EditorMode | null>(null)

  const getScrollSyncGuard = useCallback((): ScrollSyncLoopGuard => {
    if (!scrollSyncGuardRef.current) {
      scrollSyncGuardRef.current = createScrollSyncLoopGuard()
    }
    return scrollSyncGuardRef.current
  }, [])

  const syncSplitScroll = useCallback(
    (source: ScrollSyncSide): void => {
      if (effectiveMode !== 'split') return
      const view = rawEditorViewRef.current
      const previewEl = splitPreviewContainerRef.current
      if (!view || !previewEl) return

      const guard = getScrollSyncGuard()
      const sideElements: Record<ScrollSyncSide, HTMLElement> = {
        raw: view.scrollDOM,
        preview: previewEl
      }
      if (guard.shouldIgnoreScroll(source, sideElements[source].scrollTop)) {
        return
      }

      const rawGeometry = createCodeMirrorRawScrollGeometry(view)
      const previewMetrics = {
        scrollTop: previewEl.scrollTop,
        clientHeight: previewEl.clientHeight,
        scrollHeight: previewEl.scrollHeight,
        blocks: collectPreviewSourceBlocks(previewEl),
        totalLines: rawGeometry.totalLines
      }

      const targetRoutes: Record<
        ScrollSyncSide,
        {
          targetSide: ScrollSyncSide
          computeTarget: () => number | null
          persistScrollTop: boolean
        }
      > = {
        raw: {
          targetSide: 'preview',
          computeTarget: () => computePreviewScrollTopFromRaw(rawGeometry, previewMetrics),
          persistScrollTop: false
        },
        preview: {
          targetSide: 'raw',
          computeTarget: () => computeRawScrollTopFromPreview(previewMetrics, rawGeometry),
          persistScrollTop: true
        }
      }

      const { targetSide, computeTarget, persistScrollTop } = targetRoutes[source]
      const targetScrollTop = computeTarget()
      if (targetScrollTop === null) return

      const targetEl = sideElements[targetSide]
      const targetMax = Math.max(0, targetEl.scrollHeight - targetEl.clientHeight)
      if (
        targetEl.scrollTop === targetScrollTop ||
        (Math.abs(targetEl.scrollTop - targetScrollTop) <= 0.5 &&
          targetScrollTop > 0 &&
          targetScrollTop < targetMax)
      ) {
        return
      }

      targetEl.scrollTop = targetScrollTop
      guard.markProgrammaticScroll(targetSide, targetEl.scrollTop)
      if (persistScrollTop) {
        onUpdateViewState({ scrollTop: targetEl.scrollTop })
      }
    },
    [effectiveMode, getScrollSyncGuard, onUpdateViewState]
  )

  const handleSplitRawScroll = useCallback((): void => {
    syncSplitScroll('raw')
  }, [syncSplitScroll])

  const handleSplitPreviewScroll = useCallback((): void => {
    syncSplitScroll('preview')
  }, [syncSplitScroll])

  useEffect(() => {
    const prevMode = prevEffectiveModeRef.current
    prevEffectiveModeRef.current = effectiveMode

    if (effectiveMode === 'split' && prevMode !== 'split' && !matchedScrollRequest) {
      const view = rawEditorViewRef.current
      if (view && view.scrollDOM.scrollTop > 0) {
        syncSplitScroll('raw')
      }
    }
  }, [effectiveMode, matchedScrollRequest, syncSplitScroll])

  useOneShotScroll(matchedScrollRequest, effectiveMode === 'split', (req) => {
    const view = rawEditorViewRef.current
    const previewEl = splitPreviewContainerRef.current
    if (!view || !previewEl) return false

    const guard = getScrollSyncGuard()
    guard.markProgrammaticScroll('preview', previewEl.scrollTop)

    const rawGeometry = createCodeMirrorRawScrollGeometry(view)
    const expectedRawScrollTop = mapLineToRawScrollTop(req.line, rawGeometry)
    // CodeMirror scrollIntoView({ y: 'start' }) subtracts a 5px yMargin before clamping to [0, rawMax].
    guard.markProgrammaticScroll('raw', expectedRawScrollTop, 6)
    return true
  })

  return {
    rawEditorViewRef,
    splitPreviewContainerRef,
    handleSplitRawScroll,
    handleSplitPreviewScroll
  }
}
