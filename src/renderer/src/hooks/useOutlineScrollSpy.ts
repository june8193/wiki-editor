import { useCallback, useEffect, useRef, useState } from 'react'
import type { MarkdownHeading } from '../editor/MarkdownTocEngine'
import type {
  OutlineActiveHeadingReport,
  OutlineContextTarget,
  OutlineScrollRequest
} from '../editor/outlineScrollSpy'

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
  activeContext: OutlineContextTarget | null
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

function isPinValidForContext(
  pin: PinnedOutlineHeadingState | null,
  activeContext: OutlineContextTarget | null,
  bufferContent: string
): pin is PinnedOutlineHeadingState {
  return (
    pin !== null &&
    activeContext !== null &&
    isSameOutlineContext(pin.context, activeContext) &&
    pin.content === bufferContent
  )
}

function isSpyValidForContext(
  spy: ActiveOutlineHeadingState | null,
  activeContext: OutlineContextTarget | null
): spy is ActiveOutlineHeadingState {
  return spy !== null && activeContext !== null && isSameOutlineContext(spy.context, activeContext)
}

/**
 * Coordinates active Document Outline heading state across scroll-spy reports,
 * one-shot click-to-scroll protection, and context/content transitions.
 */
export function useOutlineScrollSpy({
  activeContext,
  bufferContent
}: UseOutlineScrollSpyOptions) {
  const [outlineScrollRequest, setOutlineScrollRequest] = useState<OutlineScrollRequest | null>(null)
  const [spyOutlineHeading, setSpyOutlineHeading] = useState<ActiveOutlineHeadingState | null>(null)
  const [pinnedOutlineHeading, setPinnedOutlineHeading] =
    useState<PinnedOutlineHeadingState | null>(null)
  const scrollNonceRef = useRef(0)

  const activeContextRef = useRef<OutlineContextTarget | null>(activeContext)
  activeContextRef.current = activeContext

  const activeHeadingIndex = isPinValidForContext(
    pinnedOutlineHeading,
    activeContext,
    bufferContent
  )
    ? pinnedOutlineHeading.index
    : isSpyValidForContext(spyOutlineHeading, activeContext)
      ? spyOutlineHeading.index
      : null

  useEffect(() => {
    setPinnedOutlineHeading((prev) =>
      isPinValidForContext(prev, activeContext, bufferContent) ? prev : null
    )
    setSpyOutlineHeading((prev) =>
      isSpyValidForContext(prev, activeContext) ? prev : null
    )
  }, [activeContext, bufferContent])

  useEffect(() => {
    if (outlineScrollRequest !== null) {
      setOutlineScrollRequest(null)
    }
  }, [outlineScrollRequest])

  const handleActiveHeadingReport = useCallback((report: OutlineActiveHeadingReport): void => {
    if (!isSameOutlineContext(activeContextRef.current, report.context)) {
      return
    }
    if (report.isUserScroll) {
      setPinnedOutlineHeading((prev) => (prev === null ? prev : null))
    }
    setSpyOutlineHeading((prev) =>
      prev && isSameOutlineContext(prev.context, report.context) && prev.index === report.headingIndex
        ? prev
        : { context: report.context, index: report.headingIndex }
    )
  }, [])

  const selectHeading = useCallback(
    (heading: MarkdownHeading, index: number): void => {
      if (!activeContext) return
      scrollNonceRef.current += 1
      setOutlineScrollRequest({
        ...activeContext,
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
