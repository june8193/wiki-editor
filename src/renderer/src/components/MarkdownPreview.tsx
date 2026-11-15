import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { ThemeMode } from '@shared/config'
import { renderMarkdownToReact } from '../editor/markdownPreview'
import { parseMarkdownHeadings } from '../editor/MarkdownTocEngine'
import type { MermaidRenderer } from '../editor/mermaidRenderer'
import {
  type HeadingScrollSpySample,
  measureActiveHeadingIndexInContainer
} from '../editor/outlineScrollSpy'
import { useOneShotScroll } from '../hooks/useOneShotScroll'
import { useSyncScrollTop } from '../hooks/useSyncScrollTop'
import { useUserScrollIntent } from '../hooks/useUserScrollIntent'

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
  onActiveHeadingChange?: (sample: HeadingScrollSpySample) => void
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
  const onActiveHeadingChangeRef = useRef(onActiveHeadingChange)
  onActiveHeadingChangeRef.current = onActiveHeadingChange

  const { markUserScrollIntent, resetScrollIntent, consumeUserScrollIntent, scrollIntentHandlers } =
    useUserScrollIntent()

  const parsedHeadings = useMemo(() => parseMarkdownHeadings(content), [content])

  const reportActiveHeading = useCallback(
    (container: HTMLDivElement, isUserScroll: boolean): void => {
      const callback = onActiveHeadingChangeRef.current
      if (!callback) return
      const headingIndex = measureActiveHeadingIndexInContainer(container, parsedHeadings)
      callback({ headingIndex, isUserScroll })
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
      markUserScrollIntent()
      scrollToHeading(slug)
    },
    [markUserScrollIntent, scrollToHeading]
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
    resetScrollIntent()
    scrollToHeading(req.slug, req.index)
  })

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    reportActiveHeading(container, false)
  }, [reportActiveHeading])

  return (
    <div
      ref={containerRef}
      className="markdown-preview"
      data-testid="document-editor"
      aria-label="마크다운 미리보기"
      tabIndex={0}
      {...scrollIntentHandlers}
      onScroll={(event) => {
        onScrollTopChange?.(event.currentTarget.scrollTop)
        const isUserScroll = consumeUserScrollIntent()
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
