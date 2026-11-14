import type { Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import {
  addTableColumn,
  addTableRow,
  deleteTable,
  deleteTableColumn,
  deleteTableRow,
  formatTableAtOffset,
  insertMarkdownTable,
  TableEditResult
} from './TableMarkdownManipulator'

export type RawTableAction =
  | 'insert'
  | 'addRowAbove'
  | 'addRowBelow'
  | 'addColLeft'
  | 'addColRight'
  | 'deleteRow'
  | 'deleteCol'
  | 'format'
  | 'deleteTable'

export const RAW_TABLE_SHORTCUTS: ReadonlyArray<{
  key: string
  action: RawTableAction
}> = [
  { key: 'Mod-Alt-t', action: 'insert' },
  { key: 'Mod-Alt-ArrowUp', action: 'addRowAbove' },
  { key: 'Mod-Alt-ArrowDown', action: 'addRowBelow' },
  { key: 'Mod-Alt-ArrowLeft', action: 'addColLeft' },
  { key: 'Mod-Alt-ArrowRight', action: 'addColRight' },
  { key: 'Mod-Alt-Backspace', action: 'deleteRow' },
  { key: 'Mod-Alt-Delete', action: 'deleteCol' },
  { key: 'Mod-Alt-f', action: 'format' }
]

const RAW_TABLE_HANDLERS: Record<
  RawTableAction,
  (content: string, offset: number) => TableEditResult | null
> = {
  insert: (content, offset) => insertMarkdownTable(content, offset),
  addRowAbove: (content, offset) => addTableRow(content, offset, 'above'),
  addRowBelow: (content, offset) => addTableRow(content, offset, 'below'),
  addColLeft: (content, offset) => addTableColumn(content, offset, 'left'),
  addColRight: (content, offset) => addTableColumn(content, offset, 'right'),
  deleteRow: (content, offset) => deleteTableRow(content, offset),
  deleteCol: (content, offset) => deleteTableColumn(content, offset),
  format: (content, offset) => formatTableAtOffset(content, offset),
  deleteTable: (content, offset) => deleteTable(content, offset)
}

/**
 * Runs a TableMarkdownManipulator operation against a live CodeMirror 6 EditorView.
 */
export function runRawTableAction(view: EditorView, action: RawTableAction): boolean {
  const doc = view.state.doc.toString()
  const offset = view.state.selection.main.head
  const result = RAW_TABLE_HANDLERS[action](doc, offset)
  if (!result) return false

  view.dispatch({
    changes: { from: 0, to: doc.length, insert: result.content },
    selection: { anchor: result.cursorOffset, head: result.cursorOffset },
    scrollIntoView: true
  })
  view.focus()
  return true
}

/**
 * CodeMirror 6 keymap binding Mod+Alt table editing shortcuts to TableMarkdownManipulator.
 */
export const rawTableKeymap: Extension = keymap.of(
  RAW_TABLE_SHORTCUTS.map(({ key, action }) => ({
    key,
    run: (view) => runRawTableAction(view, action)
  }))
)
