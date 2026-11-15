import { KeyboardEvent as ReactKeyboardEvent, useCallback, useMemo, useRef } from 'react'
import type { ThemeMode } from '@shared/config'
import type { WorkspaceEntry } from '@shared/workspace'
import {
  getRawEditorLanguage,
  isImageDocument,
  resolveEditorShortcut,
  resolveEffectiveEditorMode
} from '../editor/editorModes'
import { deriveDocumentTitle } from '../editor/mermaidExport'
import type { MermaidRenderer } from '../editor/mermaidRenderer'
import type { DocumentBuffer } from '@shared/documentBuffer'
import type {
  DocumentOutlineSpyUpdate,
  HeadingScrollSpySample,
  OutlineScrollRequest
} from '../editor/outlineScrollSpy'
import { useSplitScrollSync } from '../hooks/useSplitScrollSync'
import {
  DEFAULT_SPLIT_RATIO,
  DocumentTabItem,
  EditorMode,
  normalizeSplitRatio,
  roundSplitRatio,
  TabViewPatch
} from '../stores/PaneTabStore'
import { ImagePreview } from './ImagePreview'
import { MarkdownPreview } from './MarkdownPreview'
import { RawMarkdownEditor } from './RawMarkdownEditor'
import { SplitSplitter } from './SplitSplitter'
import { WysiwygMarkdownEditor } from './WysiwygMarkdownEditor'

interface DocumentEditorProps {
  document: DocumentBuffer
  tab: DocumentTabItem
  theme: ThemeMode
  autoSave: boolean
  mermaidRenderer?: MermaidRenderer
  scrollRequest?: OutlineScrollRequest | null
  isActive?: boolean
  isShortcutDisabled?: boolean
  workspaceMarkdownFiles?: readonly WorkspaceEntry[]
  onChangeContent: (nextContent: string) => void
  onSave: () => void
  onUpdateViewState: (patch: TabViewPatch) => void
  onNavigateLink?: (href: string) => void
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
  { mode: 'preview', label: 'Preview', shortcutHint: 'Ctrl+3', requiresMarkdown: true },
  { mode: 'split', label: 'Split', shortcutHint: 'Ctrl+4', requiresMarkdown: true }
]

export function DocumentEditor({
  document: activeDoc,
  tab,
  theme,
  autoSave,
  mermaidRenderer,
  scrollRequest = null,
  isActive = true,
  isShortcutDisabled = false,
  workspaceMarkdownFiles,
  onChangeContent,
  onSave,
  onUpdateViewState,
  onNavigateLink,
  onActiveHeadingChange
}: DocumentEditorProps) {
  const activeFilePath = activeDoc.kind === 'workspace' ? activeDoc.path : null
  const isImage = isImageDocument(activeDoc)
  const { allowRichModes, effectiveMode } = resolveEffectiveEditorMode(activeDoc, tab.mode)
  const rawRatio = normalizeSplitRatio(tab.splitPreviewRatio ?? DEFAULT_SPLIT_RATIO)
  const previewRatio = roundSplitRatio(1 - rawRatio)
  const rawLanguage = getRawEditorLanguage(activeDoc)
  const documentTitle = allowRichModes ? deriveDocumentTitle(activeDoc.name) : undefined
  const documentPath =
    activeDoc.kind === 'workspace' && activeDoc.path ? activeDoc.path : undefined
  const matchedScrollRequest =
    scrollRequest && scrollRequest.mode === effectiveMode ? scrollRequest : null
  const previewScrollRequest = matchedScrollRequest
    ? {
        slug: matchedScrollRequest.slug,
        index: matchedScrollRequest.index,
        nonce: matchedScrollRequest.nonce
      }
    : null
  const splitContainerRef = useRef<HTMLDivElement | null>(null)
  const {
    rawEditorViewRef,
    splitPreviewContainerRef,
    handleSplitRawScroll,
    handleSplitPreviewScroll
  } = useSplitScrollSync({
    effectiveMode,
    matchedScrollRequest,
    onUpdateViewState
  })

  const handleSplitRatioChange = useCallback(
    (nextRatio: number): void => {
      onUpdateViewState({ splitPreviewRatio: nextRatio })
    },
    [onUpdateViewState]
  )

  const modeHeadingChangeHandlers = useMemo(() => {
    if (!onActiveHeadingChange) return null
    const createReporter =
      (mode: EditorMode) =>
      (sample: HeadingScrollSpySample): void => {
        onActiveHeadingChange({ mode, ...sample })
      }
    return {
      raw: allowRichModes ? createReporter('raw') : undefined,
      wysiwyg: createReporter('wysiwyg'),
      preview: createReporter('preview'),
      split: allowRichModes ? createReporter('split') : undefined
    }
  }, [allowRichModes, onActiveHeadingChange])

  const handleModeSelect = useCallback(
    (nextMode: EditorMode): void => {
      if (isImage || (!allowRichModes && nextMode !== 'raw')) return
      if (nextMode !== tab.mode) {
        onUpdateViewState({ mode: nextMode })
      }
    },
    [allowRichModes, isImage, onUpdateViewState, tab.mode]
  )

  const handleScrollTopChange = useCallback(
    (scrollTop: number): void => {
      onUpdateViewState({ scrollTop })
    },
    [onUpdateViewState]
  )

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (isShortcutDisabled) return

    const shortcut = resolveEditorShortcut(event, effectiveMode, allowRichModes, isImage)
    if (!shortcut) return

    event.preventDefault()
    event.stopPropagation()
    if (shortcut.type === 'save') {
      onSave()
    } else if (shortcut.type === 'mode') {
      handleModeSelect(shortcut.mode)
    }
  }

  const saveStatusText = isImage
    ? '읽기 전용'
    : activeDoc.isSaving
      ? '저장 중...'
      : activeDoc.isDirty
        ? activeDoc.kind === 'workspace' && autoSave
          ? '자동 저장 대기'
          : '미저장'
        : '저장됨'

  const rawEditorElement =
    !isImage && (effectiveMode === 'raw' || effectiveMode === 'split') ? (
      <RawMarkdownEditor
        content={activeDoc.content}
        language={rawLanguage}
        theme={theme}
        cursor={tab.cursor}
        scrollTop={tab.scrollTop}
        showTableToolbar={allowRichModes}
        enableLinkAutocomplete={allowRichModes}
        isShortcutDisabled={isShortcutDisabled}
        workspaceMarkdownFiles={workspaceMarkdownFiles}
        activeFilePath={activeFilePath}
        documentPath={documentPath}
        enableImageInsertion={allowRichModes && Boolean(documentPath)}
        scrollRequest={
          matchedScrollRequest && (effectiveMode === 'raw' || effectiveMode === 'split')
            ? { line: matchedScrollRequest.line, nonce: matchedScrollRequest.nonce }
            : null
        }
        isActive={isActive}
        editorViewRef={rawEditorViewRef}
        onChangeContent={onChangeContent}
        onUpdateViewState={onUpdateViewState}
        onActiveHeadingChange={
          effectiveMode === 'split'
            ? modeHeadingChangeHandlers?.split
            : modeHeadingChangeHandlers?.raw
        }
        onRawScroll={effectiveMode === 'split' ? handleSplitRawScroll : undefined}
        onLinkNavigate={allowRichModes ? onNavigateLink : undefined}
      />
    ) : null

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
            const isDisabled = isImage || (option.requiresMarkdown && !allowRichModes)
            const isActive = !isImage && effectiveMode === option.mode
            return (
              <button
                key={option.mode}
                type="button"
                className={`mode-btn${isActive ? ' is-active' : ''}`}
                aria-pressed={isActive}
                disabled={isDisabled}
                title={
                  isImage
                    ? '이미지 파일은 읽기 전용 미리보기로 표시됩니다.'
                    : isDisabled
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
            disabled={isImage || !activeDoc.isDirty || activeDoc.isSaving}
            title={isImage ? '이미지 파일은 읽기 전용입니다.' : '저장 (Ctrl+S)'}
          >
            저장
          </button>
        </div>
      </div>

      {isImage ? (
        <ImagePreview
          path={activeDoc.path}
          name={activeDoc.name}
          cacheKey={activeDoc.version > 1 ? activeDoc.version : undefined}
        />
      ) : (
        <>
          {effectiveMode === 'raw' && rawEditorElement}

      {effectiveMode === 'wysiwyg' && (
        <WysiwygMarkdownEditor
          content={activeDoc.content}
          scrollTop={tab.scrollTop}
          theme={theme}
          enableLinkAutocomplete={allowRichModes}
          isShortcutDisabled={isShortcutDisabled}
          workspaceMarkdownFiles={workspaceMarkdownFiles}
          activeFilePath={activeFilePath}
          documentTitle={documentTitle}
          documentPath={documentPath}
          enableImageInsertion={allowRichModes && Boolean(documentPath)}
          mermaidRenderer={mermaidRenderer}
          scrollRequest={
            matchedScrollRequest
              ? { index: matchedScrollRequest.index, nonce: matchedScrollRequest.nonce }
              : null
          }
          isActive={isActive}
          onChangeContent={onChangeContent}
          onScrollTopChange={handleScrollTopChange}
          onLinkNavigate={onNavigateLink}
          onActiveHeadingChange={modeHeadingChangeHandlers?.wysiwyg}
        />
      )}

      {effectiveMode === 'preview' && (
        <MarkdownPreview
          content={activeDoc.content}
          scrollTop={tab.scrollTop}
          theme={theme}
          documentPath={documentPath}
          mermaidRenderer={mermaidRenderer}
          documentTitle={documentTitle}
          scrollRequest={previewScrollRequest}
          isActive={isActive}
          onScrollTopChange={handleScrollTopChange}
          onLinkNavigate={onNavigateLink}
          onActiveHeadingChange={modeHeadingChangeHandlers?.preview}
        />
      )}
      {effectiveMode === 'split' && (
        <div
          ref={splitContainerRef}
          className="editor-split-container"
          data-testid="editor-split-container"
        >
          <div className="editor-split-region is-raw" style={{ flex: `${rawRatio} 1 0%` }}>
            {rawEditorElement}
          </div>
          <SplitSplitter
            containerRef={splitContainerRef}
            direction="horizontal"
            ratio={rawRatio}
            ariaLabel="에디터 분할 크기 조절"
            onChangeRatio={handleSplitRatioChange}
            allowReset
          />
          <div className="editor-split-region is-preview" style={{ flex: `${previewRatio} 1 0%` }}>
            <MarkdownPreview
              scrollContainerRef={splitPreviewContainerRef}
              content={activeDoc.content}
              scrollTop={0}
              theme={theme}
              documentPath={documentPath}
              mermaidRenderer={mermaidRenderer}
              documentTitle={documentTitle}
              scrollRequest={previewScrollRequest}
              isActive={isActive}
              onScrollTopChange={handleSplitPreviewScroll}
              onLinkNavigate={onNavigateLink}
              testId="split-markdown-preview"
            />
          </div>
        </div>
      )}
        </>
      )}
    </section>
  )
}
