import type { EditorView } from '@codemirror/view'
import type { ThemeMode } from '@shared/config'
import type { WorkspaceEntry } from '@shared/workspace'
import type { HeadingScrollSpySample } from '../editor/outlineScrollSpy'
import type { RawEditorLanguage } from '../editor/rawEditorLanguage'
import type { RawFindHighlightRequest, RawJumpHighlightRequest } from '../editor/rawSearchHighlight'
import type { RawTableAction } from '../editor/rawTableCommands'
import { type RawScrollRequest, useRawCodeMirrorEditor } from '../hooks/useRawCodeMirrorEditor'
import type { SymbolNavigateRequest } from '../editor/symbolHoverDom'
import type { CursorPosition } from '../stores/PaneTabStore'
import { LinkAutocompleteMenu } from './LinkAutocompleteMenu'

interface RawMarkdownEditorProps {
  content: string
  language: RawEditorLanguage
  fileName?: string
  theme: ThemeMode
  cursor: CursorPosition
  scrollTop: number
  showTableToolbar?: boolean
  enableLinkAutocomplete?: boolean
  isShortcutDisabled?: boolean
  workspaceMarkdownFiles?: readonly WorkspaceEntry[]
  activeFilePath?: string | null
  documentPath?: string
  enableImageInsertion?: boolean
  scrollRequest?: RawScrollRequest | null
  findHighlight?: RawFindHighlightRequest | null
  jumpHighlight?: RawJumpHighlightRequest | null
  isActive?: boolean
  editorViewRef?: { current: EditorView | null }
  onChangeContent: (nextContent: string) => void
  onUpdateViewState: (patch: { cursor?: CursorPosition; scrollTop?: number }) => void
  onLinkNavigate?: (href: string) => void
  onSymbolNavigate?: (request: SymbolNavigateRequest) => void
  onSymbolContextMenu?: (request: SymbolNavigateRequest) => void
  onFindReferences?: (request: SymbolNavigateRequest) => void
  onActiveHeadingChange?: (sample: HeadingScrollSpySample) => void
  onRawScroll?: () => void
}

const RAW_TABLE_BUTTONS: ReadonlyArray<{
  action: RawTableAction
  label: string
  requiresTable: boolean
  danger?: boolean
}> = [
  { action: 'insert', label: '표 삽입', requiresTable: false },
  { action: 'addRowAbove', label: '행 위 추가', requiresTable: true },
  { action: 'addRowBelow', label: '행 아래 추가', requiresTable: true },
  { action: 'addColLeft', label: '열 좌 추가', requiresTable: true },
  { action: 'addColRight', label: '열 우 추가', requiresTable: true },
  { action: 'deleteRow', label: '현재 행 삭제', requiresTable: true },
  { action: 'deleteCol', label: '현재 열 삭제', requiresTable: true },
  { action: 'format', label: '표 정렬', requiresTable: true },
  { action: 'deleteTable', label: '표 삭제', requiresTable: true, danger: true }
]

export function RawMarkdownEditor({
  content,
  language,
  fileName,
  theme,
  cursor,
  scrollTop,
  showTableToolbar = false,
  enableLinkAutocomplete = language === 'markdown',
  isShortcutDisabled = false,
  workspaceMarkdownFiles,
  activeFilePath,
  documentPath,
  enableImageInsertion = language === 'markdown' && Boolean(documentPath),
  scrollRequest,
  findHighlight,
  jumpHighlight,
  isActive = true,
  editorViewRef,
  onChangeContent,
  onUpdateViewState,
  onLinkNavigate,
  onSymbolNavigate,
  onSymbolContextMenu,
  onFindReferences,
  onActiveHeadingChange,
  onRawScroll
}: RawMarkdownEditorProps) {
  const { shellRef, hostRef, inTable, runTableAction, linkMenuProps, shellDragProps } =
    useRawCodeMirrorEditor({
      content,
      language,
      fileName,
      theme,
      cursor,
      scrollTop,
      showTableToolbar,
      enableLinkAutocomplete,
      isShortcutDisabled,
      workspaceMarkdownFiles,
      activeFilePath,
      documentPath,
      enableImageInsertion,
      scrollRequest,
      findHighlight,
      jumpHighlight,
      isActive,
      editorViewRef,
      onChangeContent,
      onUpdateViewState,
      onLinkNavigate,
      onSymbolNavigate,
      onSymbolContextMenu,
      onFindReferences,
      onActiveHeadingChange,
      onRawScroll
    })

  return (
    <div ref={shellRef} className="raw-editor-shell" {...shellDragProps}>
      {showTableToolbar && (
        <div className="editor-toolbar" role="toolbar" aria-label="Raw 표 편집 툴바">
          {RAW_TABLE_BUTTONS.map((btn) => (
            <button
              key={btn.action}
              type="button"
              className={`toolbar-btn${btn.danger ? ' is-danger' : ''}`}
              disabled={btn.requiresTable && !inTable}
              onClick={() => runTableAction(btn.action)}
            >
              {btn.label}
            </button>
          ))}
        </div>
      )}
      <div ref={hostRef} className="codemirror-host" />
      {enableLinkAutocomplete ? <LinkAutocompleteMenu {...linkMenuProps} /> : null}
    </div>
  )
}
