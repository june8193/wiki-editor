import { KeyboardEvent as ReactKeyboardEvent, useCallback } from 'react'
import type { ThemeMode } from '@shared/config'
import { getRawEditorLanguage, isMarkdownDocument, resolveModeShortcut } from '../editor/editorModes'
import { DocumentBuffer } from '../stores/DocumentBufferStore'
import { EditorMode, TabItem, TabViewPatch } from '../stores/PaneTabStore'
import { MarkdownPreview } from './MarkdownPreview'
import { RawMarkdownEditor } from './RawMarkdownEditor'
import { WysiwygMarkdownEditor } from './WysiwygMarkdownEditor'

interface DocumentEditorProps {
  document: DocumentBuffer
  tab: TabItem
  theme: ThemeMode
  autoSave: boolean
  isShortcutDisabled?: boolean
  onChangeContent: (nextContent: string) => void
  onSave: () => void
  onUpdateViewState: (patch: TabViewPatch) => void
}

const EDITOR_MODE_OPTIONS: ReadonlyArray<{
  mode: EditorMode
  label: string
  shortcutHint: string
  requiresMarkdown: boolean
}> = [
  { mode: 'raw', label: 'Raw', shortcutHint: 'Ctrl+1', requiresMarkdown: false },
  { mode: 'wysiwyg', label: '위지윅', shortcutHint: 'Ctrl+2', requiresMarkdown: true },
  { mode: 'preview', label: 'Preview', shortcutHint: 'Ctrl+3', requiresMarkdown: true }
]

export function DocumentEditor({
  document: activeDoc,
  tab,
  theme,
  autoSave,
  isShortcutDisabled = false,
  onChangeContent,
  onSave,
  onUpdateViewState
}: DocumentEditorProps) {
  const allowRichModes = isMarkdownDocument(activeDoc)
  const effectiveMode: EditorMode = allowRichModes ? tab.mode : 'raw'
  const rawLanguage = getRawEditorLanguage(activeDoc)

  const handleModeSelect = useCallback(
    (nextMode: EditorMode): void => {
      if (!allowRichModes && nextMode !== 'raw') return
      if (nextMode !== tab.mode) {
        onUpdateViewState({ mode: nextMode })
      }
    },
    [allowRichModes, onUpdateViewState, tab.mode]
  )

  const handleScrollTopChange = useCallback(
    (scrollTop: number): void => {
      onUpdateViewState({ scrollTop })
    },
    [onUpdateViewState]
  )

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (isShortcutDisabled) return

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      event.stopPropagation()
      onSave()
      return
    }

    const nextMode = resolveModeShortcut(event, effectiveMode, allowRichModes)
    if (nextMode) {
      event.preventDefault()
      event.stopPropagation()
      handleModeSelect(nextMode)
    }
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
      onKeyDown={handleKeyDown}
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

        <div className="editor-mode-switcher" role="group" aria-label="에디터 모드 전환">
          {EDITOR_MODE_OPTIONS.map((option) => {
            const isDisabled = option.requiresMarkdown && !allowRichModes
            const isActive = effectiveMode === option.mode
            return (
              <button
                key={option.mode}
                type="button"
                className={`mode-btn${isActive ? ' is-active' : ''}`}
                aria-pressed={isActive}
                disabled={isDisabled}
                title={
                  isDisabled
                    ? '마크다운 파일에서만 사용할 수 있습니다.'
                    : `${option.label} 모드 (${option.shortcutHint}, 순환 Ctrl+Shift+M)`
                }
                onClick={() => handleModeSelect(option.mode)}
              >
                {option.label}
              </button>
            )
          })}
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

      {effectiveMode === 'raw' && (
        <RawMarkdownEditor
          content={activeDoc.content}
          language={rawLanguage}
          theme={theme}
          cursor={tab.cursor}
          scrollTop={tab.scrollTop}
          showTableToolbar={allowRichModes}
          onChangeContent={onChangeContent}
          onUpdateViewState={onUpdateViewState}
        />
      )}

      {effectiveMode === 'wysiwyg' && (
        <WysiwygMarkdownEditor
          content={activeDoc.content}
          scrollTop={tab.scrollTop}
          onChangeContent={onChangeContent}
          onScrollTopChange={handleScrollTopChange}
        />
      )}

      {effectiveMode === 'preview' && (
        <MarkdownPreview
          content={activeDoc.content}
          scrollTop={tab.scrollTop}
          onScrollTopChange={handleScrollTopChange}
        />
      )}
    </section>
  )
}
