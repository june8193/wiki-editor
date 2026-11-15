import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { OutlineActiveHeadingReport, OutlineScrollRequest } from '../components/DocumentEditor'
import type { MarkdownHeading } from '../editor/MarkdownTocEngine'
import type { EditorMode, PaneId } from '../stores/PaneTabStore'

export interface OutlineContextTarget {
  paneId: PaneId
  tabId: string
  mode: EditorMode
}

interface ActiveOutlineHeadingState {
  context: OutlineContextTarget
  index: number | null
}

interface PinnedOutlineHeadingState {
  context: OutlineContextTarget
  content: string
  index: number
}

export interface UseOutlineScrollSpyOptions {
  paneId: PaneId
  tabId: string | null
  mode: EditorMode | null
  isMarkdownDocument: boolean
  bufferContent: string
}

function isSameOutlineContext(
  a: OutlineContextTarget | null,
  b: OutlineContextTarget | null
): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.paneId === b.paneId && a.tabId === b.tabId && a.mode === b.mode
}

/**
 * Coordinates active Document Outline heading state across scroll-spy reports,
 * one-shot click-to-scroll protection, and context/content transitions.
 */
export function useOutlineScrollSpy({
  paneId,
  tabId,
  mode,
  isMarkdownDocument,
  bufferContent
}: UseOutlineScrollSpyOptions) {
  const [outlineScrollRequest, setOutlineScrollRequest] = useState<OutlineScrollRequest | null>(null)
  const [spyOutlineHeading, setSpyOutlineHeading] = useState<ActiveOutlineHeadingState | null>(null)
  const [pinnedOutlineHeading, setPinnedOutlineHeading] =
    useState<PinnedOutlineHeadingState | null>(null)
  const scrollNonceRef = useRef(0)

  const activeContext = useMemo<OutlineContextTarget | null>(() => {
    if (!tabId || !mode || !isMarkdownDocument) return null
    return { paneId, tabId, mode }
  }, [isMarkdownDocument, mode, paneId, tabId])

  const activeContextRef = useRef<OutlineContextTarget | null>(activeContext)
  activeContextRef.current = activeContext

  const isPinnedOutlineActive =
    activeContext !== null &&
    pinnedOutlineHeading !== null &&
    isSameOutlineContext(pinnedOutlineHeading.context, activeContext) &&
    pinnedOutlineHeading.content === bufferContent

  const activeHeadingIndex = isPinnedOutlineActive
    ? pinnedOutlineHeading.index
    : activeContext !== null &&
        spyOutlineHeading !== null &&
        isSameOutlineContext(spyOutlineHeading.context, activeContext)
      ? spyOutlineHeading.index
      : null

  useEffect(() => {
    setPinnedOutlineHeading((prev) =>
      prev && isSameOutlineContext(prev.context, activeContext) && prev.content === bufferContent
        ? prev
        : null
    )
    setSpyOutlineHeading((prev) =>
      prev && isSameOutlineContext(prev.context, activeContext) ? prev : null
    )
  }, [activeContext, bufferContent])

  useEffect(() => {
    if (outlineScrollRequest !== null) {
      setOutlineScrollRequest(null)
    }
  }, [outlineScrollRequest])

  const handleActiveHeadingReport = useCallback((report: OutlineActiveHeadingReport): void => {
    const currentContext = activeContextRef.current
    const reportContext: OutlineContextTarget = {
      paneId: report.paneId,
      tabId: report.tabId,
      mode: report.mode
    }
    if (!isSameOutlineContext(currentContext, reportContext)) {
      return
    }
    if (report.isUserScroll) {
      setPinnedOutlineHeading((prev) => (prev === null ? prev : null))
    }
    setSpyOutlineHeading((prev) =>
      prev && isSameOutlineContext(prev.context, reportContext) && prev.index === report.headingIndex
        ? prev
        : { context: reportContext, index: report.headingIndex }
    )
  }, [])

  const selectHeading = useCallback(
    (heading: MarkdownHeading, index: number): void => {
      if (!activeContext) return
      scrollNonceRef.current += 1
      setOutlineScrollRequest({
        paneId: activeContext.paneId,
        tabId: activeContext.tabId,
        mode: activeContext.mode,
        line: heading.line,
        slug: heading.slug,
        index,
        nonce: scrollNonceRef.current
      })
      setPinnedOutlineHeading({
        context: activeContext,
        content: bufferContent,
        index
      })
    },
    [activeContext, bufferContent]
  )

  const clearScrollRequest = useCallback((): void => {
    setOutlineScrollRequest((prev) => (prev === null ? prev : null))
  }, [])

  return {
    outlineScrollRequest,
    activeHeadingIndex,
    handleActiveHeadingReport,
    selectHeading,
    clearScrollRequest
  }
}
