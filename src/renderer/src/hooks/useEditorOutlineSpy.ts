import { useCallback, useEffect, useMemo, useRef } from 'react'
import { type MarkdownHeading, parseMarkdownHeadings } from '../editor/MarkdownTocEngine'
import type { HeadingScrollSpySample } from '../editor/outlineScrollSpy'
import { useUserScrollIntent } from './useUserScrollIntent'

export interface UseEditorOutlineSpyOptions {
  content: string
  isReady: boolean
  isActive?: boolean
  measure: (headings: readonly MarkdownHeading[]) => number | null
  onActiveHeadingChange?: (sample: HeadingScrollSpySample) => void
}

/**
 * Shared scroll-spy wiring for editor views (Raw, WYSIWYG, Preview).
 * Parses document headings from markdown, reports active heading changes on mount,
 * content updates, active-pane focus transitions, and scrolls, while tracking
 * explicit user scroll intent so programmatic jumps do not drop outline pins.
 */
export function useEditorOutlineSpy({
  content,
  isReady,
  isActive = true,
  measure,
  onActiveHeadingChange
}: UseEditorOutlineSpyOptions) {
  const onActiveHeadingChangeRef = useRef(onActiveHeadingChange)
  onActiveHeadingChangeRef.current = onActiveHeadingChange

  const measureRef = useRef(measure)
  measureRef.current = measure

  const {
    markUserScrollIntent,
    resetScrollIntent,
    consumeUserScrollIntent,
    scrollIntentHandlers,
    attachScrollIntentListeners
  } = useUserScrollIntent()

  const parsedHeadings = useMemo(() => parseMarkdownHeadings(content), [content])

  const reportActiveHeading = useCallback(
    (isUserScroll: boolean): void => {
      const callback = onActiveHeadingChangeRef.current
      if (!callback) return
      const headingIndex = measureRef.current(parsedHeadings)
      callback({ headingIndex, isUserScroll })
    },
    [parsedHeadings]
  )

  const hasCallback = Boolean(onActiveHeadingChange)
  useEffect(() => {
    if (!isReady || !hasCallback) return
    reportActiveHeading(false)
  }, [hasCallback, isActive, isReady, reportActiveHeading])

  const handleContainerScroll = useCallback((): void => {
    const isUserScroll = consumeUserScrollIntent()
    reportActiveHeading(isUserScroll)
  }, [consumeUserScrollIntent, reportActiveHeading])

  return {
    markUserScrollIntent,
    resetScrollIntent,
    handleContainerScroll,
    scrollIntentHandlers,
    attachScrollIntentListeners
  }
}
