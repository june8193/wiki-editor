import { KeyboardEvent as ReactKeyboardEvent, useCallback } from 'react'
import type { CustomCommandConfig, ThemeMode } from '@shared/config'
import { getRawEditorLanguage, isMarkdownDocument, resolveEditorShortcut } from '../editor/editorModes'
import type { MermaidRenderer } from '../editor/mermaidRenderer'
import type { DocumentOutlineSpyUpdate, OutlineScrollRequest } from '../editor/outlineScrollSpy'
import { deriveDocumentTitle } from '../editor/SlashCommandEngine'
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
  showHeadingNumbers?: boolean
  customCommands?: readonly CustomCommandConfig[]
  mermaidRenderer?: MermaidRenderer
  scrollRequest?: OutlineScrollRequest | null
  isActive?: boolean
  isShortcutDisabled?: boolean
  onChangeContent: (nextContent: string) => void
  onSave: () => void
  onUpdateViewState: (patch: TabViewPatch) => void
  onActiveHeadingChange?: (update: DocumentOutlineSpyUpdate) => void
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
  showHeadingNumbers = true,
  customCommands,
  mermaidRenderer,
  scrollRequest = null,
  isActive = true,
  isShortcutDisabled = false,
  onChangeContent,
  onSave,
  onUpdateViewState,
  onActiveHeadingChange
}: DocumentEditorProps) {
  const allowRichModes = isMarkdownDocument(activeDoc)
  const effectiveMode: EditorMode = allowRichModes ? tab.mode : 'raw'
  const rawLanguage = getRawEditorLanguage(activeDoc)
  const documentTitle = allowRichModes ? deriveDocumentTitle(activeDoc.name) : undefined
  const matchedScrollRequest =
    scrollRequest && scrollRequest.mode === effectiveMode ? scrollRequest : null

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

    const shortcut = resolveEditorShortcut(event, effectiveMode, allowRichModes)
    if (!shortcut) return

    event.preventDefault()
    event.stopPropagation()
    if (shortcut.type === 'save') {
      onSave()
    } else {
      handleModeSelect(shortcut.mode)
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
          enableSlashCommands={allowRichModes}
          customCommands={customCommands}
          documentTitle={documentTitle}
          scrollRequest={
            matchedScrollRequest
              ? { line: matchedScrollRequest.line, nonce: matchedScrollRequest.nonce }
              : null
          }
          isActive={isActive}
          onChangeContent={onChangeContent}
          onUpdateViewState={onUpdateViewState}
          onActiveHeadingChange={
            allowRichModes && onActiveHeadingChange
              ? (sample) => onActiveHeadingChange({ mode: 'raw', ...sample })
              : undefined
          }
        />
      )}

      {effectiveMode === 'wysiwyg' && (
        <WysiwygMarkdownEditor
          content={activeDoc.content}
          scrollTop={tab.scrollTop}
          theme={theme}
          showHeadingNumbers={showHeadingNumbers}
          customCommands={customCommands}
          documentTitle={documentTitle}
          mermaidRenderer={mermaidRenderer}
          scrollRequest={
            matchedScrollRequest
              ? { index: matchedScrollRequest.index, nonce: matchedScrollRequest.nonce }
              : null
          }
          isActive={isActive}
          onChangeContent={onChangeContent}
          onScrollTopChange={handleScrollTopChange}
          onActiveHeadingChange={
            onActiveHeadingChange
              ? (sample) => onActiveHeadingChange({ mode: 'wysiwyg', ...sample })
              : undefined
          }
        />
      )}

      {effectiveMode === 'preview' && (
        <MarkdownPreview
          content={activeDoc.content}
          scrollTop={tab.scrollTop}
          theme={theme}
          showHeadingNumbers={showHeadingNumbers}
          mermaidRenderer={mermaidRenderer}
          scrollRequest={
            matchedScrollRequest
              ? {
                  slug: matchedScrollRequest.slug,
                  index: matchedScrollRequest.index,
                  nonce: matchedScrollRequest.nonce
                }
              : null
          }
          isActive={isActive}
          onScrollTopChange={handleScrollTopChange}
          onActiveHeadingChange={
            onActiveHeadingChange
              ? (sample) => onActiveHeadingChange({ mode: 'preview', ...sample })
              : undefined
          }
        />
      )}
    </section>
  )
}
