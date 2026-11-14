import type { ThemeMode } from '@shared/config'
import type { RawTableAction } from '../editor/rawTableCommands'
import { useRawCodeMirrorEditor } from '../hooks/useRawCodeMirrorEditor'
import type { CursorPosition } from '../stores/PaneTabStore'

interface RawMarkdownEditorProps {
  content: string
  language: 'markdown' | 'json'
  theme: ThemeMode
  cursor: CursorPosition
  scrollTop: number
  showTableToolbar?: boolean
  onChangeContent: (nextContent: string) => void
  onUpdateViewState: (patch: { cursor?: CursorPosition; scrollTop?: number }) => void
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
  theme,
  cursor,
  scrollTop,
  showTableToolbar = false,
  onChangeContent,
  onUpdateViewState
}: RawMarkdownEditorProps) {
  const { hostRef, inTable, runTableAction } = useRawCodeMirrorEditor({
    content,
    language,
    theme,
    cursor,
    scrollTop,
    showTableToolbar,
    onChangeContent,
    onUpdateViewState
  })

  return (
    <div className="raw-editor-shell">
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
    </div>
  )
}
