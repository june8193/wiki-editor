import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { bracketMatching, HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { Annotation, Compartment, EditorState, Extension } from '@codemirror/state'
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers
} from '@codemirror/view'
import { tags } from '@lezer/highlight'
import type { ThemeMode } from '@shared/config'
import { RawTableAction, rawTableKeymap, runRawTableAction } from '../editor/rawTableCommands'
import { detectTableAtOffset } from '../editor/TableMarkdownManipulator'
import type { CursorPosition } from '../stores/PaneTabStore'

const externalSyncAnnotation = Annotation.define<boolean>()

const markdownHighlightStyle = HighlightStyle.define([
  { tag: [tags.heading, tags.heading1, tags.heading2, tags.heading3], color: 'var(--cm-heading)', fontWeight: '700' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: [tags.link, tags.url], color: 'var(--cm-link)', textDecoration: 'underline' },
  { tag: tags.monospace, color: 'var(--cm-code)', backgroundColor: 'var(--code-bg)' },
  { tag: tags.quote, color: 'var(--cm-quote)', fontStyle: 'italic' },
  { tag: tags.keyword, color: 'var(--cm-keyword)' },
  { tag: tags.string, color: 'var(--cm-string)' },
  { tag: [tags.number, tags.bool], color: 'var(--cm-number)' },
  { tag: [tags.comment, tags.meta, tags.processingInstruction], color: 'var(--text-secondary)' },
  { tag: tags.propertyName, color: 'var(--cm-heading)' }
])

function createEditorThemeExtension(theme: ThemeMode): Extension {
  return EditorView.theme(
    {
      '&': {
        height: '100%',
        backgroundColor: 'var(--bg-app)',
        color: 'var(--text-primary)',
        fontSize: '14px'
      },
      '.cm-scroller': {
        overflow: 'auto',
        fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
        lineHeight: '1.6'
      },
      '.cm-content': {
        padding: '16px 0',
        caretColor: 'var(--accent-color)'
      },
      '.cm-line': {
        padding: '0 16px'
      },
      '.cm-gutters': {
        backgroundColor: 'var(--bg-surface)',
        color: 'var(--text-secondary)',
        borderRight: '1px solid var(--border-color)'
      },
      '.cm-activeLine': {
        backgroundColor: 'var(--cm-active-line)'
      },
      '.cm-activeLineGutter': {
        backgroundColor: 'var(--bg-elevated)'
      },
      '&.cm-focused': {
        outline: 'none'
      }
    },
    { dark: theme === 'dark' }
  )
}

function createLanguageExtension(language: 'markdown' | 'json'): Extension {
  if (language === 'json') {
    return json()
  }
  return markdown({ codeLanguages: languages })
}

function clampSelection(docLength: number, cursor: CursorPosition): { anchor: number; head: number } {
  const anchor = Math.max(0, Math.min(cursor.selectionStart, docLength))
  const head = Math.max(anchor, Math.min(cursor.selectionEnd, docLength))
  return { anchor, head }
}

function syncSelectionAttrs(view: EditorView): void {
  const { from, to } = view.state.selection.main
  view.contentDOM.setAttribute('data-selection-start', String(from))
  view.contentDOM.setAttribute('data-selection-end', String(to))
}

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
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const themeCompartmentRef = useRef(new Compartment())
  const languageCompartmentRef = useRef(new Compartment())
  const tableKeymapCompartmentRef = useRef(new Compartment())
  const onChangeContentRef = useRef(onChangeContent)
  const onUpdateViewStateRef = useRef(onUpdateViewState)
  const latestCursorPropRef = useRef(cursor)
  const latestScrollTopRef = useRef(scrollTop)
  const lastAppliedCursorRef = useRef(cursor)
  const isRestoringScrollRef = useRef(false)

  onChangeContentRef.current = onChangeContent
  onUpdateViewStateRef.current = onUpdateViewState
  latestCursorPropRef.current = cursor
  latestScrollTopRef.current = scrollTop

  const [inTable, setInTable] = useState(() =>
    showTableToolbar ? detectTableAtOffset(content, cursor.selectionStart) !== null : false
  )

  const initialLanguage = useMemo(() => createLanguageExtension(language), [language])
  const initialTheme = useMemo(() => createEditorThemeExtension(theme), [theme])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const initialSelection = clampSelection(content.length, latestCursorPropRef.current)
    const state = EditorState.create({
      doc: content,
      selection: initialSelection,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        history(),
        drawSelection(),
        bracketMatching(),
        EditorView.lineWrapping,
        syntaxHighlighting(markdownHighlightStyle),
        languageCompartmentRef.current.of(initialLanguage),
        themeCompartmentRef.current.of(initialTheme),
        tableKeymapCompartmentRef.current.of(showTableToolbar ? rawTableKeymap : []),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorView.contentAttributes.of({
          'data-testid': 'document-editor',
          'aria-label': '문서 에디터',
          spellcheck: 'false'
        }),
        EditorView.updateListener.of((update) => {
          syncSelectionAttrs(update.view)
          if (update.transactions.some((tr) => tr.annotation(externalSyncAnnotation))) {
            return
          }
          if (update.docChanged) {
            onChangeContentRef.current(update.state.doc.toString())
          }
          if (update.docChanged || update.selectionSet) {
            const { from, to } = update.state.selection.main
            lastAppliedCursorRef.current = { selectionStart: from, selectionEnd: to }
            onUpdateViewStateRef.current({
              cursor: { selectionStart: from, selectionEnd: to }
            })
            if (showTableToolbar) {
              setInTable(
                detectTableAtOffset(
                  update.state.doc.toString(),
                  update.state.selection.main.head
                ) !== null
              )
            }
          }
        })
      ]
    })

    const view = new EditorView({
      state,
      parent: host
    })
    view.dom.setAttribute('data-theme-mode', theme)
    syncSelectionAttrs(view)
    view.scrollDOM.scrollTop = latestScrollTopRef.current
    viewRef.current = view

    const handleScroll = (): void => {
      if (isRestoringScrollRef.current) return
      onUpdateViewStateRef.current({ scrollTop: view.scrollDOM.scrollTop })
    }
    view.scrollDOM.addEventListener('scroll', handleScroll)

    return () => {
      view.scrollDOM.removeEventListener('scroll', handleScroll)
      view.destroy()
      viewRef.current = null
    }
    // Mount once per tab/mode instance; external prop updates are synced below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: tableKeymapCompartmentRef.current.reconfigure(
        showTableToolbar ? rawTableKeymap : []
      ),
      annotations: externalSyncAnnotation.of(true)
    })
  }, [showTableToolbar])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dom.setAttribute('data-theme-mode', theme)
    view.dispatch({
      effects: themeCompartmentRef.current.reconfigure(createEditorThemeExtension(theme)),
      annotations: externalSyncAnnotation.of(true)
    })
  }, [theme])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: languageCompartmentRef.current.reconfigure(createLanguageExtension(language)),
      annotations: externalSyncAnnotation.of(true)
    })
  }, [language])

  useLayoutEffect(() => {
    const view = viewRef.current
    if (!view) return

    const currentDoc = view.state.doc.toString()
    const docChanged = currentDoc !== content
    const cursorPropChanged =
      lastAppliedCursorRef.current.selectionStart !== cursor.selectionStart ||
      lastAppliedCursorRef.current.selectionEnd !== cursor.selectionEnd

    if (docChanged || cursorPropChanged) {
      const targetSelection = clampSelection(content.length, cursor)
      const currentSel = view.state.selection.main
      const needSelectionUpdate =
        docChanged
          ? currentSel.from !== targetSelection.anchor || currentSel.to !== targetSelection.head
          : cursorPropChanged &&
            (currentSel.from !== targetSelection.anchor || currentSel.to !== targetSelection.head)

      view.dispatch({
        changes: docChanged ? { from: 0, to: currentDoc.length, insert: content } : undefined,
        selection: needSelectionUpdate || docChanged ? targetSelection : undefined,
        annotations: externalSyncAnnotation.of(true)
      })
      lastAppliedCursorRef.current = {
        selectionStart: targetSelection.anchor,
        selectionEnd: targetSelection.head
      }
      syncSelectionAttrs(view)
    }

    if (showTableToolbar) {
      setInTable(detectTableAtOffset(content, view.state.selection.main.head) !== null)
    }

    if (Math.abs(view.scrollDOM.scrollTop - scrollTop) > 1) {
      isRestoringScrollRef.current = true
      view.scrollDOM.scrollTop = scrollTop
      isRestoringScrollRef.current = false
    }
  }, [content, cursor, scrollTop, showTableToolbar])

  const handleTableAction = (action: RawTableAction): void => {
    const view = viewRef.current
    if (!view) return
    runRawTableAction(view, action)
  }

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
              onClick={() => handleTableAction(btn.action)}
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
