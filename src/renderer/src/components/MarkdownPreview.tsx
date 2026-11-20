import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import type { ThemeMode } from '@shared/config'
import { extractFrontmatterBody } from '@shared/frontmatter'
import {
  applyFindScrollNonce,
  type DocumentFindHighlightQuery,
  scrollMatchElementIntoView
} from '../editor/documentFind'
import { renderMarkdownToReact } from '../editor/markdownPreview'
import {
  findClosestPreviewBlockForLine,
  type PreviewJumpHighlightQuery
} from '../editor/previewSearchHighlight'
import {
  type MermaidHeightChangeHandler,
  MermaidHeightSessionProvider
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
  findHighlight?: DocumentFindHighlightQuery | null
  jumpHighlight?: PreviewJumpHighlightQuery | null
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
  findHighlight = null,
  jumpHighlight = null,
  isActive = true,
  scrollContainerRef,
  testId = 'document-editor',
  onScrollTopChange,
  onActiveHeadingChange,
  onLinkNavigate
}: MarkdownPreviewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const onScrollTopChangeRef = useRef(onScrollTopChange)
  onScrollTopChangeRef.current = onScrollTopChange
  const lastScrolledFindNonceRef = useRef(findHighlight?.scrollNonce ?? 0)
  const lastHandledJumpNonceRef = useRef(0)

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
        findHighlight,
        jumpHighlight,
        onAnchorNavigate: onLinkNavigate ? undefined : handleAnchorNavigate,
        onLinkNavigate
      }),
    [
      content,
      documentPath,
      documentTitle,
      findHighlight,
      handleAnchorNavigate,
      jumpHighlight,
      mermaidRenderer,
      onLinkNavigate,
      theme
    ]
  )

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container || !findHighlight?.isActive) {
      return
    }
    applyFindScrollNonce(lastScrolledFindNonceRef, findHighlight.scrollNonce, {
      skipScroll: findHighlight.activeIndex < 0,
      performScroll: () => {
        const activeEl = container.querySelector(
          `[data-search-match-index="${findHighlight.activeIndex}"]`
        )
        if (!activeEl) {
          return false
        }
        scrollMatchElementIntoView(activeEl, container)
        return true
      }
    })
  }, [content, findHighlight])

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container || !jumpHighlight || jumpHighlight.suppressScroll) {
      return
    }
    applyFindScrollNonce(lastHandledJumpNonceRef, jumpHighlight.nonce, {
      skipScroll: false,
      performScroll: () => {
        const fmSlice = extractFrontmatterBody(content)
        if (fmSlice.hasFrontmatter && jumpHighlight.lineNumber < fmSlice.bodyStartLine) {
          container.scrollTop = 0
          onScrollTopChangeRef.current?.(0)
          return true
        }
        const jumpEl = container.querySelector('[data-search-jump="true"]')
        if (jumpEl) {
          scrollMatchElementIntoView(jumpEl, container)
          return true
        }
        const fallbackEl = findClosestPreviewBlockForLine(
          container,
          content,
          jumpHighlight.lineNumber,
          jumpHighlight
        )
        if (fallbackEl) {
          scrollMatchElementIntoView(fallbackEl, container)
        }
        return true
      }
    })
  }, [content, jumpHighlight])

  const setPreviewContainerRef = useCallback(
    (el: HTMLDivElement | null): void => {
      containerRef.current = el
      if (scrollContainerRef) {
        scrollContainerRef.current = el
      }
    },
    [scrollContainerRef]
  )

  const hasPreviewBody = useMemo(
    () => extractFrontmatterBody(content).body.trim().length > 0,
    [content]
  )

  return (
    <MermaidHeightSessionProvider
      mermaidHeights={mermaidHeights}
      onMermaidHeightChange={onMermaidHeightChange}
    >
      <div
        ref={setPreviewContainerRef}
        className="markdown-preview"
        data-testid={testId}
        aria-label="마크다운 미리보기"
        tabIndex={0}
      >
        {!hasPreviewBody ? (
          <p className="markdown-preview-empty">미리 볼 내용이 없습니다.</p>
        ) : (
          rendered
        )}
      </div>
    </MermaidHeightSessionProvider>
  )
}
