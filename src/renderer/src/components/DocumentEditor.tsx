import { useLayoutEffect, useRef } from 'react'
import { DocumentBuffer } from '../stores/DocumentBufferStore'
import { CursorPosition, TabItem } from '../stores/PaneTabStore'

interface DocumentEditorProps {
  document: DocumentBuffer
  tab: TabItem
  autoSave: boolean
  onChangeContent: (nextContent: string) => void
  onSave: () => void
  onUpdateViewState: (patch: { cursor?: CursorPosition; scrollTop?: number }) => void
}

export function DocumentEditor({
  document: activeDoc,
  tab,
  autoSave,
  onChangeContent,
  onSave,
  onUpdateViewState
}: DocumentEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const lastRestoredKeyRef = useRef<string | null>(null)

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return

    const restoreKey = `${tab.id}:${tab.mode}`
    if (lastRestoredKeyRef.current !== restoreKey) {
      lastRestoredKeyRef.current = restoreKey
      const maxOffset = activeDoc.content.length
      const start = Math.max(0, Math.min(tab.cursor.selectionStart, maxOffset))
      const end = Math.max(start, Math.min(tab.cursor.selectionEnd, maxOffset))
      textarea.scrollTop = tab.scrollTop
      if (textarea.selectionStart !== start || textarea.selectionEnd !== end) {
        textarea.setSelectionRange(start, end)
      }
    }
  }, [
    tab.id,
    tab.mode,
    tab.cursor.selectionStart,
    tab.cursor.selectionEnd,
    tab.scrollTop,
    activeDoc.content.length
  ])

  const syncViewState = (el: HTMLTextAreaElement): void => {
    onUpdateViewState({
      cursor: {
        selectionStart: el.selectionStart ?? 0,
        selectionEnd: el.selectionEnd ?? 0
      },
      scrollTop: el.scrollTop
    })
  }

  const saveStatusText = activeDoc.isSaving
    ? '저장 중...'
    : activeDoc.isDirty
      ? activeDoc.kind === 'workspace' && autoSave
        ? '자동 저장 대기'
        : '미저장'
      : '저장됨'

  return (
    <section
      className="editor-pane"
      aria-label="문서 편집 영역"
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
          event.preventDefault()
          event.stopPropagation()
          onSave()
        }
      }}
    >
      <div className="editor-header">
        <div className="editor-doc-meta">
          <span className="editor-doc-title">{activeDoc.name}</span>
          {activeDoc.isDirty && (
            <span
              className="dirty-badge"
              data-testid="dirty-indicator"
              aria-label="저장되지 않은 변경 사항"
            >
              ●
            </span>
          )}
          <span className="editor-doc-path" title={activeDoc.path}>
            {activeDoc.path}
          </span>
        </div>

        <div className="editor-header-actions">
          <span className="editor-save-status">{saveStatusText}</span>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={onSave}
            disabled={!activeDoc.isDirty || activeDoc.isSaving}
            title="저장 (Ctrl+S)"
          >
            저장
          </button>
        </div>
      </div>

      <textarea
        ref={textareaRef}
        className="document-textarea"
        aria-label="문서 에디터"
        data-testid="document-editor"
        value={activeDoc.content}
        onChange={(event) => {
          onChangeContent(event.target.value)
          syncViewState(event.currentTarget)
        }}
        onSelect={(event) => syncViewState(event.currentTarget)}
        onKeyUp={(event) => syncViewState(event.currentTarget)}
        onMouseUp={(event) => syncViewState(event.currentTarget)}
        onScroll={(event) => syncViewState(event.currentTarget)}
        onBlur={(event) => syncViewState(event.currentTarget)}
        spellCheck={false}
      />
    </section>
  )
}
