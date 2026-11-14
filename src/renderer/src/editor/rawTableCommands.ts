import { EditorView } from '@codemirror/view'
import {
  addTableColumn,
  addTableRow,
  deleteTable,
  deleteTableColumn,
  deleteTableRow,
  detectTableAtOffset,
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

function computeRawTableEdit(
  action: RawTableAction,
  content: string,
  offset: number
): TableEditResult | null {
  switch (action) {
    case 'insert':
      return insertMarkdownTable(content, offset)
    case 'addRowAbove':
      return addTableRow(content, offset, 'above')
    case 'addRowBelow':
      return addTableRow(content, offset, 'below')
    case 'addColLeft':
      return addTableColumn(content, offset, 'left')
    case 'addColRight':
      return addTableColumn(content, offset, 'right')
    case 'deleteRow':
      return deleteTableRow(content, offset)
    case 'deleteCol':
      return deleteTableColumn(content, offset)
    case 'format':
      return formatTableAtOffset(content, offset)
    case 'deleteTable':
      return deleteTable(content, offset)
  }
}

export function isCursorInRawTable(content: string, offset: number): boolean {
  return detectTableAtOffset(content, offset) !== null
}

/**
 * Runs a TableMarkdownManipulator operation against a live CodeMirror 6 EditorView.
 */
export function runRawTableAction(view: EditorView, action: RawTableAction): boolean {
  const doc = view.state.doc.toString()
  const offset = view.state.selection.main.head
  const result = computeRawTableEdit(action, doc, offset)
  if (!result) return false

  view.dispatch({
    changes: { from: 0, to: doc.length, insert: result.content },
    selection: { anchor: result.cursorOffset, head: result.cursorOffset },
    scrollIntoView: true
  })
  view.focus()
  return true
}
