import {
  KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { Search } from 'lucide-react'
import type { ThemeMode } from '@shared/config'
import type { SearchMatchOptions } from '@shared/search'
import type { WorkspaceEntry } from '@shared/workspace'
import {
  clampActiveMatchIndex,
  createDefaultDocumentFindState,
  type DocumentFindState,
  findTextMatchesInDocument,
  isDocumentFindShortcut,
  readRawEditorSingleLineSelection,
  resolveFindBarKeyAction,
  stepActiveMatchIndex
} from '../editor/documentFind'
import {
  getRawEditorLanguage,
  isImageDocument,
  resolveEditorShortcut,
  resolveEffectiveEditorMode
} from '../editor/editorModes'
import { deriveDocumentTitle } from '../editor/mermaidExport'
import { updateMermaidHeightMap } from '../editor/mermaidHeightSession'
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
import { DocumentFindBar } from './DocumentFindBar'
import { ImagePreview } from './ImagePreview'
import { MarkdownPreview } from './MarkdownPreview'
import { RawMarkdownEditor } from './RawMarkdownEditor'
import { SplitSplitter } from './SplitSplitter'
import { WysiwygMarkdownEditor } from './WysiwygMarkdownEditor'

export interface DocumentEditorFindControl {
  state: DocumentFindState
  onOpen: (initialQuery?: string | null) => void
  onToggle: () => void
  onClose: () => void
  onChangeQuery: (query: string) => void
  onToggleOption: (optionKey: keyof SearchMatchOptions) => void
  onRegisterSelectionReader?: (reader: (() => string | null) | null) => void
  onConsumeFocusNonce?: (nonce: number) => boolean
}

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
  findControl?: DocumentEditorFindControl
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
  findControl,
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
  const editorBodyRef = useRef<HTMLDivElement | null>(null)
  const splitContainerRef = useRef<HTMLDivElement | null>(null)
  const localFocusNonceRef = useRef(0)
  const [localFindState, setLocalFindState] = useState<DocumentFindState>(
    createDefaultDocumentFindState
  )
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

  const effectiveFindState = findControl?.state ?? localFindState

  const openFind = useCallback(
    (initialQuery?: string | null): void => {
      if (findControl) {
        findControl.onOpen(initialQuery)
        return
      }
      localFocusNonceRef.current += 1
      const nonce = localFocusNonceRef.current
      setLocalFindState((prev) => ({
        ...prev,
        isOpen: true,
        query: initialQuery !== null && initialQuery !== undefined ? initialQuery : prev.query,
        focusRequest: { nonce, selectAll: true }
      }))
    },
    [findControl]
  )

  const toggleFind = useCallback((): void => {
    if (findControl) {
      findControl.onToggle()
      return
    }
    localFocusNonceRef.current += 1
    const nonce = localFocusNonceRef.current
    setLocalFindState((prev) =>
      prev.isOpen
        ? { ...prev, isOpen: false }
        : { ...prev, isOpen: true, focusRequest: { nonce, selectAll: true } }
    )
  }, [findControl])

  const focusActiveEditorBody = useCallback((): void => {
    if (effectiveMode === 'raw' || effectiveMode === 'split') {
      rawEditorViewRef.current?.focus()
      return
    }
    const target = editorBodyRef.current?.querySelector<HTMLElement>('[data-testid="document-editor"]')
    target?.focus()
  }, [effectiveMode, rawEditorViewRef])

  const closeFind = useCallback((): void => {
    if (findControl) {
      findControl.onClose()
    } else {
      setLocalFindState((prev) => (prev.isOpen ? { ...prev, isOpen: false } : prev))
    }
    focusActiveEditorBody()
  }, [findControl, focusActiveEditorBody])

  const changeFindQuery = useCallback(
    (nextQuery: string): void => {
      if (findControl) {
        findControl.onChangeQuery(nextQuery)
        return
      }
      setLocalFindState((prev) => (prev.query === nextQuery ? prev : { ...prev, query: nextQuery }))
    },
    [findControl]
  )

  const toggleFindOption = useCallback(
    (optionKey: keyof SearchMatchOptions): void => {
      if (findControl) {
        findControl.onToggleOption(optionKey)
        return
      }
      setLocalFindState((prev) => ({
        ...prev,
        options: {
          ...prev.options,
          [optionKey]: !prev.options[optionKey]
        }
      }))
    },
    [findControl]
  )

  const readSingleLineSelection = useCallback((): string | null => {
    if (isImage) return null
    if (effectiveMode === 'raw' || effectiveMode === 'split') {
      return readRawEditorSingleLineSelection(rawEditorViewRef.current)
    }
    return null
  }, [effectiveMode, isImage, rawEditorViewRef])

  const registerSelectionReader = findControl?.onRegisterSelectionReader
  useEffect(() => {
    if (!registerSelectionReader) return
    registerSelectionReader(readSingleLineSelection)
    return () => {
      registerSelectionReader(null)
    }
  }, [readSingleLineSelection, registerSelectionReader])

  const isFindActive = !isImage && effectiveFindState.isOpen
  const isRawFindMode = isFindActive && (effectiveMode === 'raw' || effectiveMode === 'split')
  const rawFindResult = useMemo(
    () =>
      isRawFindMode
        ? findTextMatchesInDocument(
            activeDoc.content,
            effectiveFindState.query,
            effectiveFindState.options
          )
        : { matches: [], errorMessage: null },
    [activeDoc.content, effectiveFindState.options, effectiveFindState.query, isRawFindMode]
  )

  const findMatches = rawFindResult.matches
  const findMatchCount = findMatches.length
  const findErrorMessage = rawFindResult.errorMessage

  const [matchCursor, setMatchCursor] = useState<{
    index: number
    scrollNonce: number
    wasOpen: boolean
    query: string
    options: SearchMatchOptions
    mode: EditorMode
  }>(() => ({
    index: isFindActive && findMatchCount > 0 ? 0 : -1,
    scrollNonce: 0,
    wasOpen: isFindActive,
    query: effectiveFindState.query,
    options: effectiveFindState.options,
    mode: effectiveMode
  }))

  const findCriteriaChanged =
    matchCursor.wasOpen !== isFindActive ||
    matchCursor.query !== effectiveFindState.query ||
    matchCursor.options !== effectiveFindState.options ||
    matchCursor.mode !== effectiveMode

  const resolvedActiveMatchIndex = !isFindActive
    ? -1
    : findCriteriaChanged
      ? findMatchCount > 0
        ? 0
        : -1
      : clampActiveMatchIndex(matchCursor.index, findMatchCount)

  useLayoutEffect(() => {
    const queryOrOptionsOrOpenChanged =
      !matchCursor.wasOpen && isFindActive
        ? true
        : isFindActive &&
          (matchCursor.query !== effectiveFindState.query ||
            matchCursor.options !== effectiveFindState.options)
    const modeChanged = matchCursor.mode !== effectiveMode
    const closedNow = matchCursor.wasOpen && !isFindActive

    if (queryOrOptionsOrOpenChanged) {
      setMatchCursor((prev) => ({
        index: findMatchCount > 0 ? 0 : -1,
        scrollNonce: findMatchCount > 0 ? prev.scrollNonce + 1 : prev.scrollNonce,
        wasOpen: isFindActive,
        query: effectiveFindState.query,
        options: effectiveFindState.options,
        mode: effectiveMode
      }))
      return
    }

    if (closedNow) {
      setMatchCursor((prev) => ({
        ...prev,
        index: -1,
        wasOpen: false,
        query: effectiveFindState.query,
        options: effectiveFindState.options,
        mode: effectiveMode
      }))
      return
    }

    if (modeChanged || resolvedActiveMatchIndex !== matchCursor.index) {
      setMatchCursor((prev) => ({
        ...prev,
        index: resolvedActiveMatchIndex,
        wasOpen: isFindActive,
        query: effectiveFindState.query,
        options: effectiveFindState.options,
        mode: effectiveMode
      }))
    }
  }, [
    effectiveFindState.options,
    effectiveFindState.query,
    effectiveMode,
    findMatchCount,
    isFindActive,
    matchCursor.index,
    matchCursor.mode,
    matchCursor.options,
    matchCursor.query,
    matchCursor.wasOpen,
    resolvedActiveMatchIndex
  ])

  const stepActiveMatch = useCallback(
    (direction: 'next' | 'prev'): void => {
      if (!isFindActive || findMatchCount === 0) return
      const nextIndex = stepActiveMatchIndex(resolvedActiveMatchIndex, findMatchCount, direction)
      setMatchCursor((prev) => ({
        index: nextIndex,
        scrollNonce: prev.scrollNonce + 1,
        wasOpen: isFindActive,
        query: effectiveFindState.query,
        options: effectiveFindState.options,
        mode: effectiveMode
      }))
    },
    [
      effectiveFindState.options,
      effectiveFindState.query,
      effectiveMode,
      findMatchCount,
      isFindActive,
      resolvedActiveMatchIndex
    ]
  )

  const handleNextMatch = useCallback((): void => {
    stepActiveMatch('next')
  }, [stepActiveMatch])

  const handlePreviousMatch = useCallback((): void => {
    stepActiveMatch('prev')
  }, [stepActiveMatch])

  const rawFindHighlight = useMemo(
    () =>
      isRawFindMode
        ? {
            isActive: true,
            matches: findMatches,
            activeIndex: resolvedActiveMatchIndex,
            scrollNonce: matchCursor.scrollNonce
          }
        : null,
    [findMatches, isRawFindMode, matchCursor.scrollNonce, resolvedActiveMatchIndex]
  )

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

  const lastTabRef = useRef(tab)
  const mermaidHeightsRef = useRef(tab.mermaidHeights)
  if (lastTabRef.current !== tab) {
    lastTabRef.current = tab
    mermaidHeightsRef.current = tab.mermaidHeights
  }

  const handleMermaidHeightChange = useCallback(
    (blockIndex: number, nextHeightPx: number | null): void => {
      const nextHeights = updateMermaidHeightMap(mermaidHeightsRef.current, blockIndex, nextHeightPx)
      if (nextHeights === mermaidHeightsRef.current) {
        return
      }
      mermaidHeightsRef.current = nextHeights
      onUpdateViewState({ mermaidHeights: nextHeights })
    },
    [onUpdateViewState]
  )

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (isShortcutDisabled) return

    if (
      isDocumentFindShortcut({
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        isComposing: event.nativeEvent.isComposing
      })
    ) {
      event.preventDefault()
      event.stopPropagation()
      if (!isImage) {
        openFind(readSingleLineSelection())
      }
      return
    }

    if (isFindActive && !event.defaultPrevented) {
      const findAction = resolveFindBarKeyAction(
        {
          key: event.key,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          isComposing: event.nativeEvent.isComposing
        },
        { allowEnter: false }
      )
      if (findAction) {
        event.preventDefault()
        event.stopPropagation()
        if (findAction === 'next') {
          handleNextMatch()
        } else if (findAction === 'prev') {
          handlePreviousMatch()
        } else {
          closeFind()
        }
        return
      }
    }

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
        findHighlight={rawFindHighlight}
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
          <button
            type="button"
            className={`icon-btn editor-find-btn${effectiveFindState.isOpen && !isImage ? ' is-active' : ''}`}
            aria-label="문서 내 찾기"
            aria-pressed={effectiveFindState.isOpen && !isImage}
            title="문서 내 찾기 (Ctrl+F)"
            disabled={isImage}
            onClick={() => {
              if (!isImage) {
                toggleFind()
              }
            }}
          >
            <Search size={14} strokeWidth={1.75} aria-hidden="true" />
          </button>
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

      <div ref={editorBodyRef} className="editor-body">
        {isFindActive && (
          <DocumentFindBar
            query={effectiveFindState.query}
            options={effectiveFindState.options}
            matchCount={findMatchCount}
            activeMatchIndex={resolvedActiveMatchIndex}
            errorMessage={findErrorMessage}
            focusRequest={effectiveFindState.focusRequest}
            onConsumeFocusNonce={findControl?.onConsumeFocusNonce}
            onQueryChange={changeFindQuery}
            onToggleOption={toggleFindOption}
            onNextMatch={handleNextMatch}
            onPreviousMatch={handlePreviousMatch}
            onClose={closeFind}
          />
        )}

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
                mermaidHeights={tab.mermaidHeights}
                onMermaidHeightChange={handleMermaidHeightChange}
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
                mermaidHeights={tab.mermaidHeights}
                onMermaidHeightChange={handleMermaidHeightChange}
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
                    mermaidHeights={tab.mermaidHeights}
                    onMermaidHeightChange={handleMermaidHeightChange}
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
      </div>
    </section>
  )
}
