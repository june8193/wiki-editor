import { type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useMemo, useRef } from 'react'
import type { ThemeMode } from '@shared/config'
import { renderMarkdownToReact } from '../editor/markdownPreview'
import { parseMarkdownHeadings } from '../editor/MarkdownTocEngine'
import type { MermaidRenderer } from '../editor/mermaidRenderer'
import { isScrollNavigationKey, measureActiveHeadingIndexInContainer } from '../editor/outlineScrollSpy'
import { useOneShotScroll } from '../hooks/useOneShotScroll'
import { useSyncScrollTop } from '../hooks/useSyncScrollTop'

export interface PreviewScrollRequest {
  slug?: string
  index: number
  nonce: number
}

interface MarkdownPreviewProps {
  content: string
  scrollTop: number
  theme?: ThemeMode
  showHeadingNumbers?: boolean
  mermaidRenderer?: MermaidRenderer
  scrollRequest?: PreviewScrollRequest | null
  onScrollTopChange?: (scrollTop: number) => void
  onActiveHeadingChange?: (headingIndex: number | null, isUserScroll: boolean) => void
}

function scrollHeadingIntoView(target: Element): void {
  if (typeof target.scrollIntoView === 'function') {
    target.scrollIntoView({ block: 'start' })
  }
}

export function MarkdownPreview({
  content,
  scrollTop,
  theme = 'light',
  showHeadingNumbers = false,
  mermaidRenderer,
  scrollRequest,
  onScrollTopChange,
  onActiveHeadingChange
}: MarkdownPreviewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const userScrollIntentRef = useRef(false)
  const onActiveHeadingChangeRef = useRef(onActiveHeadingChange)
  onActiveHeadingChangeRef.current = onActiveHeadingChange

  const parsedHeadings = useMemo(() => parseMarkdownHeadings(content), [content])

  const reportActiveHeading = useCallback(
    (container: HTMLDivElement, isUserScroll: boolean): void => {
      const callback = onActiveHeadingChangeRef.current
      if (!callback) return
      const nextIndex = measureActiveHeadingIndexInContainer(container, parsedHeadings)
      callback(nextIndex, isUserScroll)
    },
    [parsedHeadings]
  )

  const scrollToHeading = useCallback((slug?: string, index?: number): void => {
    const container = containerRef.current
    if (!container) return

    const headings = Array.from(container.querySelectorAll('h1, h2, h3, h4, h5, h6'))
    if (slug) {
      const bySlug = headings.find((el) => el.id === slug)
      if (bySlug) {
        scrollHeadingIntoView(bySlug)
        return
      }
    }
    if (index !== undefined && index >= 0 && index < headings.length) {
      scrollHeadingIntoView(headings[index])
    }
  }, [])

  const handleAnchorNavigate = useCallback(
    (slug: string): void => {
      userScrollIntentRef.current = true
      scrollToHeading(slug)
    },
    [scrollToHeading]
  )

  const rendered = useMemo(
    () =>
      renderMarkdownToReact(content, {
        theme,
        showHeadingNumbers,
        mermaidRenderer,
        onAnchorNavigate: handleAnchorNavigate
      }),
    [content, handleAnchorNavigate, mermaidRenderer, showHeadingNumbers, theme]
  )

  useSyncScrollTop(containerRef, scrollTop)

  useOneShotScroll(scrollRequest, true, (req) => {
    userScrollIntentRef.current = false
    scrollToHeading(req.slug, req.index)
  })

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    reportActiveHeading(container, false)
  }, [reportActiveHeading])

  const markUserScrollIntent = (): void => {
    userScrollIntentRef.current = true
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (isScrollNavigationKey(event)) {
      markUserScrollIntent()
    }
  }

  return (
    <div
      ref={containerRef}
      className="markdown-preview"
      data-testid="document-editor"
      aria-label="마크다운 미리보기"
      tabIndex={0}
      onWheel={markUserScrollIntent}
      onTouchStart={markUserScrollIntent}
      onPointerDown={markUserScrollIntent}
      onMouseDown={markUserScrollIntent}
      onKeyDown={handleKeyDown}
      onScroll={(event) => {
        onScrollTopChange?.(event.currentTarget.scrollTop)
        const isUserScroll = userScrollIntentRef.current
        userScrollIntentRef.current = false
        reportActiveHeading(event.currentTarget, isUserScroll)
      }}
    >
      {content.trim().length === 0 ? (
        <p className="markdown-preview-empty">미리 볼 내용이 없습니다.</p>
      ) : (
        rendered
      )}
    </div>
  )
}
