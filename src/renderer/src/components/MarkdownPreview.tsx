import { useLayoutEffect, useMemo, useRef } from 'react'
import { renderMarkdownToReact } from '../editor/markdownPreview'

interface MarkdownPreviewProps {
  content: string
  scrollTop: number
  onScrollTopChange?: (scrollTop: number) => void
  testId?: string
}

export function MarkdownPreview({
  content,
  scrollTop,
  onScrollTopChange,
  testId = 'document-editor'
}: MarkdownPreviewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const rendered = useMemo(() => renderMarkdownToReact(content), [content])

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    if (Math.abs(el.scrollTop - scrollTop) > 1) {
      el.scrollTop = scrollTop
    }
  }, [scrollTop])

  return (
    <div
      ref={containerRef}
      className="markdown-preview"
      data-testid={testId}
      aria-label="마크다운 미리보기"
      tabIndex={0}
      onScroll={(event) => onScrollTopChange?.(event.currentTarget.scrollTop)}
    >
      {content.trim().length === 0 ? (
        <p className="markdown-preview-empty">미리 볼 내용이 없습니다.</p>
      ) : (
        rendered
      )}
    </div>
  )
}
