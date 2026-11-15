import { type RefObject, useCallback, useEffect, useMemo, useRef } from 'react'
import { type MarkdownHeading, parseMarkdownHeadings } from '../editor/MarkdownTocEngine'
import {
  type HeadingScrollSpySample,
  measureActiveHeadingIndexInContainer
} from '../editor/outlineScrollSpy'
import { useOneShotScroll } from './useOneShotScroll'
import { useSyncScrollTop } from './useSyncScrollTop'
import { useUserScrollIntent } from './useUserScrollIntent'

export interface UseEditorOutlineSpyOptions<TReq extends { nonce: number } = { nonce: number }> {
  content: string
  isReady: boolean
  isActive?: boolean
  scrollRequest?: TReq | null
  isScrollRequestReady?: boolean
  onScrollRequest?: (req: TReq, headings: readonly MarkdownHeading[]) => boolean | void
  onScrollTopChange?: (scrollTop: number) => void
  measure: (headings: readonly MarkdownHeading[]) => number | null
  onActiveHeadingChange?: (sample: HeadingScrollSpySample) => void
}

export interface UseContainerOutlineSpyOptions<TReq extends { nonce: number } = { nonce: number }>
  extends Omit<UseEditorOutlineSpyOptions<TReq>, 'measure'> {
  containerRef: RefObject<HTMLElement | null>
  scrollTop: number
}

/**
 * Shared scroll-spy wiring across Document Editor modes (Raw, 위지윅, Preview).
 * Parses headings from markdown, reports active heading changes on mount, content edits,
 * active-Pane focus changes, and scrolls, while resetting user scroll intent around
 * Document Outline one-shot jumps so programmatic scrolls do not drop Document Outline pins.
 */
export function useEditorOutlineSpy<TReq extends { nonce: number } = { nonce: number }>({
  content,
  isReady,
  isActive = true,
  scrollRequest,
  isScrollRequestReady,
  onScrollRequest,
  onScrollTopChange,
  measure,
  onActiveHeadingChange
}: UseEditorOutlineSpyOptions<TReq>) {
  const onActiveHeadingChangeRef = useRef(onActiveHeadingChange)
  onActiveHeadingChangeRef.current = onActiveHeadingChange

  const measureRef = useRef(measure)
  measureRef.current = measure

  const onScrollRequestRef = useRef(onScrollRequest)
  onScrollRequestRef.current = onScrollRequest

  const onScrollTopChangeRef = useRef(onScrollTopChange)
  onScrollTopChangeRef.current = onScrollTopChange

  const {
    markUserScrollIntent,
    resetScrollIntent,
    consumeUserScrollIntent,
    attachScrollIntentListeners
  } = useUserScrollIntent()

  const parsedHeadings = useMemo(() => parseMarkdownHeadings(content), [content])
  const parsedHeadingsRef = useRef(parsedHeadings)
  parsedHeadingsRef.current = parsedHeadings

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

  useOneShotScroll(scrollRequest, isScrollRequestReady ?? isReady, (req) => {
    resetScrollIntent()
    return onScrollRequestRef.current?.(req, parsedHeadingsRef.current) ?? true
  })

  const handleContainerScroll = useCallback((): void => {
    const isUserScroll = consumeUserScrollIntent()
    reportActiveHeading(isUserScroll)
  }, [consumeUserScrollIntent, reportActiveHeading])

  const handleContainerScrollRef = useRef(handleContainerScroll)
  handleContainerScrollRef.current = handleContainerScroll

  const attachScrollElement = useCallback(
    (element: HTMLElement): (() => void) => {
      const onScroll = (): void => {
        onScrollTopChangeRef.current?.(element.scrollTop)
        handleContainerScrollRef.current()
      }
      element.addEventListener('scroll', onScroll)
      const detachIntent = attachScrollIntentListeners(element)
      return () => {
        detachIntent()
        element.removeEventListener('scroll', onScroll)
      }
    },
    [attachScrollIntentListeners]
  )

  const runWithUserScrollIntent = useCallback(
    (action: () => void): void => {
      markUserScrollIntent()
      action()
    },
    [markUserScrollIntent]
  )

  return {
    attachScrollElement,
    runWithUserScrollIntent
  }
}

/**
 * Scroll-spy, scroll-top synchronization, and DOM listener attachment for React scrollable
 * containers used by Preview and 위지윅 modes.
 */
export function useContainerOutlineSpy<TReq extends { nonce: number } = { nonce: number }>({
  containerRef,
  scrollTop,
  isReady,
  ...spyOptions
}: UseContainerOutlineSpyOptions<TReq>) {
  useSyncScrollTop(containerRef, scrollTop)

  const { attachScrollElement, runWithUserScrollIntent } = useEditorOutlineSpy({
    ...spyOptions,
    isReady,
    measure: (headings) => {
      const container = containerRef.current
      return container ? measureActiveHeadingIndexInContainer(container, headings) : null
    }
  })

  useEffect(() => {
    if (!isReady) return
    const container = containerRef.current
    return container ? attachScrollElement(container) : undefined
  }, [attachScrollElement, containerRef, isReady])

  return {
    runWithUserScrollIntent
  }
}
