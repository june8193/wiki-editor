import { KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useRef } from 'react'
import type { EditorView } from '@codemirror/view'
import type { CustomCommandConfig, ThemeMode } from '@shared/config'
import { getRawEditorLanguage, resolveEditorShortcut, resolveEffectiveEditorMode } from '../editor/editorModes'
import type { MermaidRenderer } from '../editor/mermaidRenderer'
import {
  type ScrollSyncLoopGuard,
  type ScrollSyncSide,
  collectPreviewSourceBlocks,
  computePreviewScrollTopFromRaw,
  computeRawScrollTopFromPreview,
  createCodeMirrorRawScrollGeometry,
  createScrollSyncLoopGuard,
  mapLineToRawScrollTop
} from '../editor/splitScrollSync'
import { deriveDocumentTitle } from '../editor/SlashCommandEngine'
import { DocumentBuffer } from '../stores/DocumentBufferStore'
import {
  DEFAULT_SPLIT_RATIO,
  EditorMode,
  PaneId,
  TabItem,
  TabViewPatch,
  normalizeSplitRatio,
  roundSplitRatio
} from '../stores/PaneTabStore'
import { MarkdownPreview } from './MarkdownPreview'
import { RawMarkdownEditor } from './RawMarkdownEditor'
import { SplitSplitter } from './SplitSplitter'
import { WysiwygMarkdownEditor } from './WysiwygMarkdownEditor'

export interface OutlineScrollRequest {
  paneId: PaneId
  tabId: string
  mode: EditorMode
  line: number
  slug: string
  index: number
  nonce: number
}

interface DocumentEditorProps {
  document: DocumentBuffer
  tab: TabItem
  theme: ThemeMode
  autoSave: boolean
  showHeadingNumbers?: boolean
  customCommands?: readonly CustomCommandConfig[]
  mermaidRenderer?: MermaidRenderer
  scrollRequest?: OutlineScrollRequest | null
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
  { mode: 'preview', label: 'Preview', shortcutHint: 'Ctrl+3', requiresMarkdown: true },
  { mode: 'split', label: 'Split', shortcutHint: 'Ctrl+4', requiresMarkdown: true }
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
  isShortcutDisabled = false,
  onChangeContent,
  onSave,
  onUpdateViewState
}: DocumentEditorProps) {
  const { allowRichModes, effectiveMode } = resolveEffectiveEditorMode(activeDoc, tab.mode)
  const rawRatio = normalizeSplitRatio(tab.splitPreviewRatio ?? DEFAULT_SPLIT_RATIO)
  const previewRatio = roundSplitRatio(1 - rawRatio)
  const rawLanguage = getRawEditorLanguage(activeDoc)
  const documentTitle = allowRichModes ? deriveDocumentTitle(activeDoc.name) : undefined
  const matchedScrollRequest =
    scrollRequest && scrollRequest.mode === effectiveMode ? scrollRequest : null
  const splitContainerRef = useRef<HTMLDivElement | null>(null)
  const rawEditorViewRef = useRef<EditorView | null>(null)
  const splitPreviewContainerRef = useRef<HTMLDivElement | null>(null)
  const scrollSyncGuardRef = useRef<ScrollSyncLoopGuard | null>(null)
  const prevEffectiveModeRef = useRef<EditorMode | null>(null)

  const getScrollSyncGuard = useCallback((): ScrollSyncLoopGuard => {
    if (!scrollSyncGuardRef.current) {
      scrollSyncGuardRef.current = createScrollSyncLoopGuard()
    }
    return scrollSyncGuardRef.current
  }, [])

  const syncSplitScroll = useCallback(
    (source: ScrollSyncSide): void => {
      if (effectiveMode !== 'split') return
      const view = rawEditorViewRef.current
      const previewEl = splitPreviewContainerRef.current
      if (!view || !previewEl) return

      const guard = getScrollSyncGuard()
      const sourceScrollTop = source === 'raw' ? view.scrollDOM.scrollTop : previewEl.scrollTop
      if (guard.shouldIgnoreScroll(source, sourceScrollTop)) {
        return
      }

      const rawGeometry = createCodeMirrorRawScrollGeometry(view)
      const previewMetrics = {
        scrollTop: previewEl.scrollTop,
        clientHeight: previewEl.clientHeight,
        scrollHeight: previewEl.scrollHeight,
        blocks: collectPreviewSourceBlocks(previewEl),
        totalLines: rawGeometry.totalLines
      }

      const targetScrollTop =
        source === 'raw'
          ? computePreviewScrollTopFromRaw(rawGeometry, previewMetrics)
          : computeRawScrollTopFromPreview(previewMetrics, rawGeometry)
      if (targetScrollTop === null) return

      const targetSide: ScrollSyncSide = source === 'raw' ? 'preview' : 'raw'
      const targetEl = targetSide === 'raw' ? view.scrollDOM : previewEl
      const targetMax = Math.max(0, targetEl.scrollHeight - targetEl.clientHeight)
      if (
        targetEl.scrollTop === targetScrollTop ||
        (Math.abs(targetEl.scrollTop - targetScrollTop) <= 0.5 &&
          targetScrollTop > 0 &&
          targetScrollTop < targetMax)
      ) {
        return
      }

      targetEl.scrollTop = targetScrollTop
      guard.markProgrammaticScroll(targetSide, targetEl.scrollTop)
      if (targetSide === 'raw') {
        onUpdateViewState({ scrollTop: targetEl.scrollTop })
      }
    },
    [effectiveMode, getScrollSyncGuard, onUpdateViewState]
  )

  const handleSplitRawScroll = useCallback((): void => {
    syncSplitScroll('raw')
  }, [syncSplitScroll])

  const handleSplitPreviewScroll = useCallback((): void => {
    syncSplitScroll('preview')
  }, [syncSplitScroll])

  useEffect(() => {
    const prevMode = prevEffectiveModeRef.current
    prevEffectiveModeRef.current = effectiveMode

    if (effectiveMode === 'split' && prevMode !== 'split' && !matchedScrollRequest) {
      const view = rawEditorViewRef.current
      if (view && view.scrollDOM.scrollTop > 0) {
        syncSplitScroll('raw')
      }
    }
  }, [effectiveMode, matchedScrollRequest, syncSplitScroll])

  useEffect(() => {
    if (effectiveMode !== 'split' || !matchedScrollRequest) return
    const view = rawEditorViewRef.current
    const previewEl = splitPreviewContainerRef.current
    if (!view || !previewEl) return

    const guard = getScrollSyncGuard()
    guard.markProgrammaticScroll('preview', previewEl.scrollTop)

    const rawGeometry = createCodeMirrorRawScrollGeometry(view)
    const expectedRawScrollTop = mapLineToRawScrollTop(matchedScrollRequest.line, rawGeometry)
    // CodeMirror scrollIntoView({ y: 'start' }) applies a default 5px yMargin before clamping.
    guard.markProgrammaticScroll('raw', expectedRawScrollTop, 6)
  }, [effectiveMode, getScrollSyncGuard, matchedScrollRequest])

  const handleSplitRatioChange = useCallback(
    (nextRatio: number): void => {
      onUpdateViewState({ splitPreviewRatio: nextRatio })
    },
    [onUpdateViewState]
  )

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

  const rawEditorElement =
    effectiveMode === 'raw' || effectiveMode === 'split' ? (
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
          matchedScrollRequest && (effectiveMode === 'raw' || effectiveMode === 'split')
            ? { line: matchedScrollRequest.line, nonce: matchedScrollRequest.nonce }
            : null
        }
        editorViewRef={rawEditorViewRef}
        onChangeContent={onChangeContent}
        onUpdateViewState={onUpdateViewState}
        onRawScroll={effectiveMode === 'split' ? handleSplitRawScroll : undefined}
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

      {effectiveMode === 'raw' && rawEditorElement}

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
          onChangeContent={onChangeContent}
          onScrollTopChange={handleScrollTopChange}
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
          onScrollTopChange={handleScrollTopChange}
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
              onScrollTopChange={handleSplitPreviewScroll}
              testId="split-markdown-preview"
            />
          </div>
        </div>
      )}
    </section>
  )
}
