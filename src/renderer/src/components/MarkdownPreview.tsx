import { useMemo, useRef } from 'react'
import { renderMarkdownToReact } from '../editor/markdownPreview'
import { useSyncScrollTop } from '../hooks/useSyncScrollTop'

interface MarkdownPreviewProps {
  content: string
  scrollTop: number
  onScrollTopChange?: (scrollTop: number) => void
}

export function MarkdownPreview({
  content,
  scrollTop,
  onScrollTopChange
}: MarkdownPreviewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const rendered = useMemo(() => renderMarkdownToReact(content), [content])

  useSyncScrollTop(containerRef, scrollTop)

  return (
    <div
      ref={containerRef}
      className="markdown-preview"
      data-testid="document-editor"
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
