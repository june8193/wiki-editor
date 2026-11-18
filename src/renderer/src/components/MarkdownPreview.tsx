import { useCallback, useMemo, useRef } from 'react'
import type { ThemeMode } from '@shared/config'
import { renderMarkdownToReact } from '../editor/markdownPreview'
import {
  type MermaidHeightChangeHandler,
  MermaidHeightSessionContext
} from '../editor/mermaidHeightSession'
import type { MermaidRenderer } from '../editor/mermaidRenderer'
import type { HeadingScrollSpySample } from '../editor/outlineScrollSpy'
import { useContainerOutlineSpy } from '../hooks/useEditorOutlineSpy'
import type { MermaidDiagramHeightMap } from '../stores/PaneTabStore'

export interface PreviewScrollRequest {
  slug?: string
  index: number
  nonce: number
}

interface MarkdownPreviewProps {
  content: string
  scrollTop: number
  theme?: ThemeMode
  documentPath?: string
  mermaidRenderer?: MermaidRenderer
  documentTitle?: string
  mermaidHeights?: MermaidDiagramHeightMap
  onMermaidHeightChange?: MermaidHeightChangeHandler
  scrollRequest?: PreviewScrollRequest | null
  isActive?: boolean
  scrollContainerRef?: { current: HTMLDivElement | null }
  testId?: string
  onScrollTopChange?: (scrollTop: number) => void
  onActiveHeadingChange?: (sample: HeadingScrollSpySample) => void
  onLinkNavigate?: (href: string) => void
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
  documentPath,
  mermaidRenderer,
  documentTitle,
  mermaidHeights,
  onMermaidHeightChange,
  scrollRequest,
  isActive = true,
  scrollContainerRef,
  testId = 'document-editor',
  onScrollTopChange,
  onActiveHeadingChange,
  onLinkNavigate
}: MarkdownPreviewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)

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

  const { runWithUserScrollIntent } = useContainerOutlineSpy({
    containerRef,
    content,
    scrollTop,
    isReady: true,
    isActive,
    scrollRequest,
    onScrollRequest: (req) => scrollToHeading(req.slug, req.index),
    onScrollTopChange,
    onActiveHeadingChange
  })

  const handleAnchorNavigate = useCallback(
    (slug: string): void => {
      runWithUserScrollIntent(() => scrollToHeading(slug))
    },
    [runWithUserScrollIntent, scrollToHeading]
  )

  const rendered = useMemo(
    () =>
      renderMarkdownToReact(content, {
        theme,
        documentPath,
        mermaidRenderer,
        documentTitle,
        onAnchorNavigate: onLinkNavigate ? undefined : handleAnchorNavigate,
        onLinkNavigate
      }),
    [content, documentPath, documentTitle, handleAnchorNavigate, mermaidRenderer, onLinkNavigate, theme]
  )

  const mermaidHeightSessionValue = useMemo(
    () => ({ mermaidHeights, onMermaidHeightChange }),
    [mermaidHeights, onMermaidHeightChange]
  )

  return (
    <MermaidHeightSessionContext.Provider value={mermaidHeightSessionValue}>
      <div
        ref={(el) => {
          containerRef.current = el
          if (scrollContainerRef) {
            scrollContainerRef.current = el
          }
        }}
        className="markdown-preview"
        data-testid={testId}
        aria-label="마크다운 미리보기"
        tabIndex={0}
      >
        {content.trim().length === 0 ? (
          <p className="markdown-preview-empty">미리 볼 내용이 없습니다.</p>
        ) : (
          rendered
        )}
      </div>
    </MermaidHeightSessionContext.Provider>
  )
}
