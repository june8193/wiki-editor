import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { bracketMatching, HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { Annotation, Compartment, EditorState, Extension, StateEffect } from '@codemirror/state'
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
import { detectDocumentLineEnding, insertOrUpdateTocBlock } from '../editor/MarkdownTocEngine'
import {
  type HeadingScrollSpySample,
  measureActiveHeadingIndexInRawEditor
} from '../editor/outlineScrollSpy'
import type { CursorPosition } from '../stores/PaneTabStore'
import { useEditorOutlineSpy } from './useEditorOutlineSpy'
import { syncElementScrollTop } from './useSyncScrollTop'

const externalSyncAnnotation = Annotation.define<boolean>()

function applyRawTocCommand(view: EditorView): boolean {
  const sel = view.state.selection.main
  const line = view.state.doc.lineAt(sel.from)
  const docText = view.state.doc.toString()
  const nextDoc = insertOrUpdateTocBlock(docText, line.number)

  if (nextDoc === docText) {
    return false
  }

  const nextCursor = Math.min(
    nextDoc.length,
    Math.max(0, sel.from + (nextDoc.length - docText.length))
  )
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: nextDoc },
    selection: { anchor: nextCursor }
  })
  return true
}

export interface RawScrollRequest {
  line: number
  nonce: number
}

export interface UseRawCodeMirrorEditorOptions {
  content: string
  language: 'markdown' | 'json'
  theme: ThemeMode
  cursor: CursorPosition
  scrollTop: number
  showTableToolbar: boolean
  scrollRequest?: RawScrollRequest | null
  isActive?: boolean
  editorViewRef?: { current: EditorView | null }
  onChangeContent: (nextContent: string) => void
  onUpdateViewState: (patch: { cursor?: CursorPosition; scrollTop?: number }) => void
  onActiveHeadingChange?: (sample: HeadingScrollSpySample) => void
  onRawScroll?: () => void
}

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

function normalizeDocText(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

function createEditorThemeExtension(theme: ThemeMode): Extension {
  return [
    EditorView.editorAttributes.of({ 'data-theme-mode': theme }),
    EditorView.theme(
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
  ]
}

function createLanguageExtension(language: 'markdown' | 'json'): Extension {
  return language === 'json' ? json() : markdown({ codeLanguages: languages })
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

function isViewCursorInRawTable(view: EditorView): boolean {
  const head = view.state.selection.main.head
  const line = view.state.doc.lineAt(head)
  if (!line.text.includes('|')) {
    return false
  }
  return detectTableAtOffset(view.state.doc.toString(), head) !== null
}

/**
 * Manages a mounted CodeMirror 6 EditorView instance with CRLF line-ending safety,
 * dynamic compartment reconfiguration, cursor/scroll restoration, and Raw table state.
 */
export function useRawCodeMirrorEditor({
  content,
  language,
  theme,
  cursor,
  scrollTop,
  showTableToolbar,
  scrollRequest,
  isActive = true,
  editorViewRef,
  onChangeContent,
  onUpdateViewState,
  onActiveHeadingChange,
  onRawScroll
}: UseRawCodeMirrorEditorOptions) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const outlineSpyRef = useRef<{
    attachScrollElement: (element: HTMLElement) => () => void
  }>({
    attachScrollElement: () => () => {}
  })
  const compartmentsRef = useRef({
    language: new Compartment(),
    theme: new Compartment(),
    tableKeymap: new Compartment()
  })
  const runtimeRef = useRef({
    content,
    language,
    theme,
    cursor,
    scrollTop,
    showTableToolbar,
    onChangeContent,
    onUpdateViewState,
    onRawScroll
  })
  runtimeRef.current = {
    content,
    language,
    theme,
    cursor,
    scrollTop,
    showTableToolbar,
    onChangeContent,
    onUpdateViewState,
    onRawScroll
  }

  const lineEndingRef = useRef<'\r\n' | '\n'>(detectDocumentLineEnding(content))
  const lastCursorPropRef = useRef<CursorPosition>(cursor)
  const prevCompartmentsRef = useRef({ language, theme, showTableToolbar })

  const [inTable, setInTable] = useState(() => {
    if (!showTableToolbar) return false
    const normalized = normalizeDocText(content)
    const { anchor } = clampSelection(normalized.length, cursor)
    return detectTableAtOffset(normalized, anchor) !== null
  })

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const initial = runtimeRef.current
    const compartments = compartmentsRef.current
    const normalizedInitial = normalizeDocText(initial.content)
    const initialSelection = clampSelection(normalizedInitial.length, initial.cursor)
    lastCursorPropRef.current = initial.cursor

    const state = EditorState.create({
      doc: normalizedInitial,
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
        compartments.language.of(createLanguageExtension(initial.language)),
        compartments.theme.of(createEditorThemeExtension(initial.theme)),
        compartments.tableKeymap.of(initial.showTableToolbar ? rawTableKeymap : []),
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
            const doc = update.state.doc
            runtimeRef.current.onChangeContent(
              doc.sliceString(0, doc.length, lineEndingRef.current)
            )
          }
          if (update.docChanged || update.selectionSet) {
            const { from, to } = update.state.selection.main
            const nextCursor = { selectionStart: from, selectionEnd: to }
            lastCursorPropRef.current = nextCursor
            runtimeRef.current.onUpdateViewState({ cursor: nextCursor })
            if (runtimeRef.current.showTableToolbar) {
              setInTable(isViewCursorInRawTable(update.view))
            }
          }
        })
      ]
    })

    const view = new EditorView({ state, parent: host })
    syncSelectionAttrs(view)
    view.scrollDOM.scrollTop = initial.scrollTop
    viewRef.current = view
    if (editorViewRef) {
      editorViewRef.current = view
    }

    const detachOutlineScroll = outlineSpyRef.current.attachScrollElement(view.scrollDOM)

    return () => {
      detachOutlineScroll()
      view.destroy()
      viewRef.current = null
      if (editorViewRef) {
        editorViewRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return

    const prev = prevCompartmentsRef.current
    const compartments = compartmentsRef.current
    const effects: StateEffect<unknown>[] = []

    if (prev.language !== language) {
      effects.push(compartments.language.reconfigure(createLanguageExtension(language)))
    }
    if (prev.theme !== theme) {
      effects.push(compartments.theme.reconfigure(createEditorThemeExtension(theme)))
    }
    if (prev.showTableToolbar !== showTableToolbar) {
      effects.push(
        compartments.tableKeymap.reconfigure(showTableToolbar ? rawTableKeymap : [])
      )
      setInTable(showTableToolbar ? isViewCursorInRawTable(view) : false)
    }

    if (effects.length === 0) return
    prevCompartmentsRef.current = { language, theme, showTableToolbar }
    view.dispatch({ effects, annotations: externalSyncAnnotation.of(true) })
  }, [language, theme, showTableToolbar])

  useLayoutEffect(() => {
    const view = viewRef.current
    if (!view) return

    const normalizedPropDoc = normalizeDocText(content)
    const currentDoc = view.state.doc.toString()
    const docChanged = currentDoc !== normalizedPropDoc
    if (docChanged && (content.includes('\n') || content.includes('\r'))) {
      lineEndingRef.current = detectDocumentLineEnding(content)
    }

    const cursorPropChanged =
      lastCursorPropRef.current.selectionStart !== cursor.selectionStart ||
      lastCursorPropRef.current.selectionEnd !== cursor.selectionEnd

    if (docChanged || cursorPropChanged) {
      const targetDocLength = normalizedPropDoc.length
      const targetSelection = clampSelection(targetDocLength, cursor)
      const currentSel = view.state.selection.main
      const selectionDiffers =
        currentSel.from !== targetSelection.anchor || currentSel.to !== targetSelection.head

      view.dispatch({
        changes: docChanged ? { from: 0, to: currentDoc.length, insert: normalizedPropDoc } : undefined,
        selection: docChanged || (cursorPropChanged && selectionDiffers) ? targetSelection : undefined,
        annotations: externalSyncAnnotation.of(true)
      })
      lastCursorPropRef.current = cursor
      syncSelectionAttrs(view)
    }

    if (showTableToolbar && (docChanged || cursorPropChanged)) {
      setInTable(isViewCursorInRawTable(view))
    }
  }, [content, cursor, showTableToolbar])

  useLayoutEffect(() => {
    const view = viewRef.current
    if (!view) return
    syncElementScrollTop(view.scrollDOM, scrollTop)
  }, [scrollTop])

  const outlineSpy = useEditorOutlineSpy({
    content,
    isReady: language === 'markdown',
    isActive,
    scrollRequest,
    onScrollRequest: (req) => {
      const view = viewRef.current
      if (!view) return false

      const lineCount = view.state.doc.lines
      const clampedLine = Math.max(1, Math.min(req.line, lineCount))
      const lineInfo = view.state.doc.line(clampedLine)
      view.dispatch({
        selection: { anchor: lineInfo.from },
        effects: EditorView.scrollIntoView(lineInfo.from, { y: 'start' })
      })
      syncSelectionAttrs(view)
      view.focus()
      return true
    },
    onScrollTopChange: (nextScrollTop) => {
      runtimeRef.current.onUpdateViewState({ scrollTop: nextScrollTop })
      runtimeRef.current.onRawScroll?.()
    },
    measure: (headings) => {
      const view = viewRef.current
      if (!view) return null
      const { doc } = view.state
      return measureActiveHeadingIndexInRawEditor(
        {
          scrollDOM: view.scrollDOM,
          contentDOM: view.contentDOM,
          documentPaddingTop: view.documentPadding.top,
          defaultLineHeight: view.defaultLineHeight,
          lineCount: doc.lines,
          lineNumberAt: (pos) => doc.lineAt(pos).number,
          lineBlockAtHeight: (height) => view.lineBlockAtHeight(height)
        },
        headings
      )
    },
    onActiveHeadingChange
  })
  outlineSpyRef.current = outlineSpy

  const runTableAction = useCallback((action: RawTableAction): void => {
    const view = viewRef.current
    if (view) {
      runRawTableAction(view, action)
    }
  }, [])

  const insertToc = useCallback((): void => {
    const view = viewRef.current
    if (!view || runtimeRef.current.language !== 'markdown') return
    applyRawTocCommand(view)
  }, [])

  return {
    hostRef,
    inTable,
    runTableAction,
    insertToc
  }
}
