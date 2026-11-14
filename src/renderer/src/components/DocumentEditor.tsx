import { useEffect } from 'react'

export interface ActiveDocument {
  kind: 'workspace' | 'config'
  path: string
  name: string
  content: string
  savedContent: string
}

interface DocumentEditorProps {
  document: ActiveDocument | null
  isSaving: boolean
  autoSave: boolean
  onChangeContent: (nextContent: string) => void
  onSave: () => void
}

export function DocumentEditor({
  document: activeDoc,
  isSaving,
  autoSave,
  onChangeContent,
  onSave
}: DocumentEditorProps) {
  const isDirty = activeDoc !== null && activeDoc.content !== activeDoc.savedContent

  useEffect(() => {
    if (!activeDoc) return

    const handleGlobalKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        onSave()
      }
    }

    window.addEventListener('keydown', handleGlobalKeyDown)
    return () => {
      window.removeEventListener('keydown', handleGlobalKeyDown)
    }
  }, [activeDoc, onSave])

  if (!activeDoc) {
    return (
      <section className="workspace-placeholder">
        <p>마크다운 위키 에디터 준비 완료</p>
        <p className="workspace-placeholder-hint">
          폴더를 열어 문서를 선택하거나, 설정에서 config.json을 직접 편집할 수 있습니다.
        </p>
      </section>
    )
  }

  const saveStatusText = isSaving
    ? '저장 중...'
    : isDirty
      ? autoSave
        ? '자동 저장 대기'
        : '미저장'
      : '저장됨'

  return (
    <section className="editor-pane" aria-label="문서 편집 영역">
      <div className="editor-header">
        <div className="editor-doc-meta">
          <span className="editor-doc-title">{activeDoc.name}</span>
          {isDirty && (
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
            disabled={!isDirty || isSaving}
            title="저장 (Ctrl+S)"
          >
            저장
          </button>
        </div>
      </div>

      <textarea
        className="document-textarea"
        aria-label="문서 에디터"
        data-testid="document-editor"
        value={activeDoc.content}
        onChange={(event) => onChangeContent(event.target.value)}
        spellCheck={false}
      />
    </section>
  )
}
