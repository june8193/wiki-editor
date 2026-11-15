import { useCallback, useEffect, useRef } from 'react'
import type { EditorView } from '@codemirror/view'
import {
  type ScrollSyncLoopGuard,
  type ScrollSyncSide,
  collectPreviewSourceBlocks,
  computePreviewScrollTopFromRaw,
  computeRawScrollTopFromPreview,
  createCodeMirrorRawScrollGeometry,
  createScrollSyncLoopGuard
} from '../editor/splitScrollSync'
import type { EditorMode } from '../stores/PaneTabStore'

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
      const sourceScrollTop = source === 'raw' ? view.scrollDOM.scrollTop : previewEl.scrollTop
      if (guard.shouldIgnoreScroll(source, sourceScrollTop)) {
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

      const targetScrollTop =
        source === 'raw'
          ? computePreviewScrollTopFromRaw(rawGeometry, previewMetrics)
          : computeRawScrollTopFromPreview(previewMetrics, rawGeometry)
      if (targetScrollTop === null) return

      const targetSide: ScrollSyncSide = source === 'raw' ? 'preview' : 'raw'
      const targetEl = targetSide === 'raw' ? view.scrollDOM : previewEl
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
      if (targetSide === 'raw') {
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

  useEffect(() => {
    if (effectiveMode !== 'split' || !matchedScrollRequest) return
    const view = rawEditorViewRef.current
    const previewEl = splitPreviewContainerRef.current
    if (!view || !previewEl) return

    const guard = getScrollSyncGuard()
    guard.markProgrammaticScroll('preview', previewEl.scrollTop)

    const rawGeometry = createCodeMirrorRawScrollGeometry(view)
    const rawMax = Math.max(0, rawGeometry.scrollHeight - rawGeometry.clientHeight)
    const rawOffset =
      rawGeometry.paddingTop + rawGeometry.getOffsetForLine(matchedScrollRequest.line)
    const expectedRawScrollTop = rawMax > 0 ? Math.min(rawMax, rawOffset) : 0
    // CodeMirror scrollIntoView({ y: 'start' }) subtracts a 5px yMargin before clamping to [0, rawMax].
    guard.markProgrammaticScroll('raw', expectedRawScrollTop, 6)
  }, [effectiveMode, getScrollSyncGuard, matchedScrollRequest])

  return {
    rawEditorViewRef,
    splitPreviewContainerRef,
    handleSplitRawScroll,
    handleSplitPreviewScroll
  }
}
