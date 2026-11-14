import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { RAW_TABLE_SHORTCUTS, rawTableKeymap, runRawTableAction } from './rawTableCommands'

function createEditor(doc: string, selectionOffset: number): { view: EditorView; host: HTMLElement } {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: selectionOffset },
      extensions: [rawTableKeymap]
    }),
    parent: host
  })
  return { view, host }
}

describe('rawTableCommands', () => {
  it('executes every RawTableAction against a live CodeMirror EditorView', () => {
    const { view, host } = createEditor('# Intro', 7)

    // 1) insert
    expect(runRawTableAction(view, 'insert')).toBe(true)
    expect(view.state.doc.toString()).toContain('| 열 1 | 열 2 | 열 3 |')

    // Move cursor to first body row, first column
    const bodyStart = view.state.doc.toString().lastIndexOf('|      |') + 2
    view.dispatch({ selection: { anchor: bodyStart } })

    // 2) addRowAbove & addRowBelow
    expect(runRawTableAction(view, 'addRowAbove')).toBe(true)
    expect(runRawTableAction(view, 'addRowBelow')).toBe(true)
    expect(
      view.state.doc
        .toString()
        .split('\n')
        .filter((line) => line.startsWith('|'))
    ).toHaveLength(6)

    // 3) addColLeft & addColRight
    expect(runRawTableAction(view, 'addColLeft')).toBe(true)
    expect(runRawTableAction(view, 'addColRight')).toBe(true)
    const afterCols = view.state.doc
      .toString()
      .split('\n')
      .find((line) => line.startsWith('|'))!
    expect(afterCols.split('|').slice(1, -1)).toHaveLength(5)

    // 4) deleteRow & deleteCol
    expect(runRawTableAction(view, 'deleteRow')).toBe(true)
    expect(runRawTableAction(view, 'deleteCol')).toBe(true)
    const afterDeletes = view.state.doc
      .toString()
      .split('\n')
      .filter((line) => line.startsWith('|'))
    expect(afterDeletes).toHaveLength(5)
    expect(afterDeletes[0].split('|').slice(1, -1)).toHaveLength(4)

    // 5) format
    view.dispatch({
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: '| A|Long Header|\n|:---|---:|\n|x|y|'
      },
      selection: { anchor: 2 }
    })
    expect(runRawTableAction(view, 'format')).toBe(true)
    expect(view.state.doc.toString()).toBe(
      ['| A    | Long Header |', '| :--- | ----------: |', '| x    |           y |'].join('\n')
    )

    // 6) deleteTable
    expect(runRawTableAction(view, 'deleteTable')).toBe(true)
    expect(view.state.doc.toString()).toBe('')

    view.destroy()
    host.remove()
  })

  it('registers CodeMirror Mod+Alt keyboard shortcuts for Raw table actions', () => {
    expect(RAW_TABLE_SHORTCUTS.map((entry) => entry.action)).toEqual([
      'insert',
      'addRowAbove',
      'addRowBelow',
      'addColLeft',
      'addColRight',
      'deleteRow',
      'deleteCol',
      'format'
    ])

    const { view, host } = createEditor('', 0)
    // Simulate Mod-Alt-t (Ctrl+Alt+t on Windows) directly via CM6 DOM keydown
    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key: 't', ctrlKey: true, altKey: true, bubbles: true })
    )
    expect(view.state.doc.toString()).toContain('| 열 1 | 열 2 | 열 3 |')

    view.destroy()
    host.remove()
  })
})
