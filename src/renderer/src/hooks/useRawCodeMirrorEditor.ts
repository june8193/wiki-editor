import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { bracketMatching, HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { Annotation, Compartment, EditorState, Extension, Prec, StateEffect, StateField } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers
} from '@codemirror/view'
import { tags } from '@lezer/highlight'
import type { ThemeMode } from '@shared/config'
import { isOffsetInFrontmatter } from '@shared/frontmatter'
import type { WorkspaceEntry } from '@shared/workspace'
import { formatRawMarkdownImages } from '../editor/imageIngestion'
import {
  rawSearchHighlightField,
  rawSearchJumpHighlightField,
  type RawFindHighlightRequest,
  type RawJumpHighlightRequest,
  syncRawJumpHighlight,
  syncRawSearchHighlights
} from '../editor/rawSearchHighlight'
import { RawTableAction, rawTableKeymap, runRawTableAction } from '../editor/rawTableCommands'
import { detectTableAtOffset } from '../editor/TableMarkdownManipulator'
import {
  buildRawLinkEdit,
  detectLinkQuery,
  type LinkQueryMatch
} from '../editor/LinkAutocompleteEngine'
import { isLinkNavigationClick, type RawEditorLanguage } from '../editor/editorModes'
import { extractMarkdownLinkHrefAtOffset } from '../editor/MarkdownLinkSyntax'
import { extractIdentifierAtPosition, isSymbolSupportedFile } from '../editor/codeSymbolExtractor'
import type { SymbolNavigateRequest } from '../editor/symbolHoverDom'
import { isSymbolModifierPressed } from '../editor/symbolNavigation'
import { loadDiffLanguageParser, resolveDiffLanguageParserSync } from '../utils/diffSyntaxHighlight'
import {
  loadRawCodeLanguage,
  resolveRawCodeLanguageSync
} from '../editor/rawLanguageSupport'
import {
  detectDocumentLineEnding,
  isOffsetInCodeFence,
  normalizeLineEndingsToLf
} from '../editor/MarkdownTocEngine'
import {
  type HeadingScrollSpySample,
  measureActiveHeadingIndexInRawEditor
} from '../editor/outlineScrollSpy'
import type { CursorPosition } from '../stores/PaneTabStore'
import { useEditorImageTransfer } from './useEditorImageTransfer'
import { useEditorOutlineSpy } from './useEditorOutlineSpy'
import { useLinkMenu } from './useLinkMenu'
import { syncElementScrollTop } from './useSyncScrollTop'

const externalSyncAnnotation = Annotation.define<boolean>()
const linkInsertAnnotation = Annotation.define<boolean>()
const setSymbolHoverRangeEffect = StateEffect.define<{ from: number; to: number } | null>()
const symbolHoverMark = Decoration.mark({ class: 'symbol-hover-target' })
const symbolHoverHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, tr) {
    let next = decorations.map(tr.changes)
    for (const effect of tr.effects) {
      if (effect.is(setSymbolHoverRangeEffect)) {
        next = effect.value
          ? Decoration.set([symbolHoverMark.range(effect.value.from, effect.value.to)])
          : Decoration.none
      }
    }
    return next
  },
  provide: (field) => EditorView.decorations.from(field)
})

export interface RawScrollRequest {
  line: number
  nonce: number
}

function clearSymbolHover(view: EditorView): void {
  if (view.state.field(symbolHoverHighlightField).size > 0) {
    view.dispatch({ effects: setSymbolHoverRangeEffect.of(null) })
  }
}

function resolveRawSymbolTokenAtEvent(
  view: EditorView,
  event: MouseEvent,
  targetName: string,
  cachedParser: { path: string; parser: Parameters<typeof extractIdentifierAtPosition>[2] }
) {
  const parser =
    cachedParser.path === targetName
      ? cachedParser.parser
      : resolveDiffLanguageParserSync(targetName).parser
  const offset = resolveRawClickOffset(view, event)
  if (offset === null || !parser) {
    return null
  }
  return extractIdentifierAtPosition(view.state.doc.toString(), offset, parser)
}

export interface UseRawCodeMirrorEditorOptions {
  content: string
  language: RawEditorLanguage
  fileName?: string
  theme: ThemeMode
  cursor: CursorPosition
  scrollTop: number
  showTableToolbar: boolean
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
  onActiveHeadingChange?: (sample: HeadingScrollSpySample) => void
  onRawScroll?: () => void
}

const markdownHighlightStyle = HighlightStyle.define([
  { tag: [tags.heading, tags.heading1, tags.heading2, tags.heading3], color: 'var(--cm-heading)', fontWeight: '700' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: [tags.link, tags.url], color: 'var(--cm-link)', textDecoration: 'underline' },
  { tag: tags.monospace, color: 'var(--cm-code)' },
  { tag: tags.quote, color: 'var(--cm-quote)', fontStyle: 'italic' },
  {
    tag: [
      tags.function(tags.variableName),
      tags.function(tags.propertyName),
      tags.function(tags.definition(tags.variableName)),
      tags.standard(tags.function(tags.variableName))
    ],
    color: 'var(--cm-function)'
  },
  {
    tag: [
      tags.keyword,
      tags.controlKeyword,
      tags.definitionKeyword,
      tags.moduleKeyword,
      tags.operatorKeyword,
      tags.modifier
    ],
    color: 'var(--cm-keyword)'
  },
  { tag: [tags.string, tags.special(tags.string), tags.attributeValue, tags.regexp], color: 'var(--cm-string)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--cm-number)' },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment, tags.meta, tags.processingInstruction],
    color: 'var(--text-secondary)'
  },
  { tag: [tags.typeName, tags.className, tags.standard(tags.typeName), tags.tagName, tags.namespace], color: 'var(--cm-type)' },
  { tag: [tags.propertyName, tags.attributeName, tags.labelName, tags.definition(tags.propertyName)], color: 'var(--cm-heading)' },
  {
    tag: [tags.operator, tags.compareOperator, tags.logicOperator, tags.arithmeticOperator, tags.updateOperator],
    color: 'var(--cm-operator)'
  }
])

function resolveRawClickOffset(view: EditorView, event: MouseEvent): number | null {
  if (event.clientX !== 0 || event.clientY !== 0) {
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
    if (pos === null) {
      return null
    }
    const line = view.state.doc.lineAt(pos)
    if (pos === line.from) {
      const charRect = view.coordsAtPos(pos)
      if (
        charRect &&
        (charRect.right > charRect.left || charRect.bottom > charRect.top) &&
        event.clientX < charRect.left
      ) {
        return null
      }
    }
    return pos
  }

  const target = event.target
  if (!(target instanceof Node) || !view.contentDOM.contains(target)) {
    return null
  }
  if (target === view.contentDOM) {
    return view.state.selection.main.head
  }
  try {
    return view.posAtDOM(target, 0)
  } catch {
    return null
  }
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

function createLanguageExtension(language: RawEditorLanguage, fileName?: string | null): Extension {
  if (language === 'json') {
    return json()
  }
  if (language === 'markdown') {
    return markdown({ codeLanguages: languages })
  }
  return resolveRawCodeLanguageSync(fileName).extension ?? []
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
  fileName,
  theme,
  cursor,
  scrollTop,
  showTableToolbar,
  enableLinkAutocomplete = language === 'markdown',
  isShortcutDisabled = false,
  workspaceMarkdownFiles,
  activeFilePath,
  documentPath,
  enableImageInsertion = language === 'markdown' && Boolean(documentPath),
  scrollRequest,
  findHighlight = null,
  jumpHighlight = null,
  isActive = true,
  editorViewRef,
  onChangeContent,
  onUpdateViewState,
  onLinkNavigate,
  onSymbolNavigate,
  onActiveHeadingChange,
  onRawScroll
}: UseRawCodeMirrorEditorOptions) {
  const shellRef = useRef<HTMLDivElement | null>(null)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const lastScrolledFindNonceRef = useRef(0)
  const lastHandledJumpNonceRef = useRef(0)
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
    fileName,
    theme,
    cursor,
    scrollTop,
    showTableToolbar,
    enableLinkAutocomplete,
    isShortcutDisabled,
    findHighlight,
    onChangeContent,
    onUpdateViewState,
    onLinkNavigate,
    onSymbolNavigate,
    onRawScroll
  })
  runtimeRef.current = {
    content,
    language,
    fileName,
    theme,
    cursor,
    scrollTop,
    showTableToolbar,
    enableLinkAutocomplete,
    isShortcutDisabled,
    findHighlight,
    onChangeContent,
    onUpdateViewState,
    onLinkNavigate,
    onSymbolNavigate,
    onRawScroll
  }
  const symbolParserRef = useRef<{ path: string; parser: ReturnType<typeof resolveDiffLanguageParserSync>['parser'] }>({
    path: '',
    parser: null
  })
  useEffect(() => {
    const targetName = fileName ?? documentPath ?? ''
    if (!targetName || language === 'markdown' || !isSymbolSupportedFile(targetName)) {
      symbolParserRef.current = { path: '', parser: null }
      return
    }
    const sync = resolveDiffLanguageParserSync(targetName)
    if (sync.parser) {
      symbolParserRef.current = { path: targetName, parser: sync.parser }
      return
    }
    if (!sync.needsAsyncLoad) return
    let cancelled = false
    void loadDiffLanguageParser(targetName).then((parser) => {
      if (!cancelled) {
        symbolParserRef.current = { path: targetName, parser }
      }
    })
    return () => {
      cancelled = true
    }
  }, [documentPath, fileName, language])

  const { linkControlsRef, linkMenuProps } = useLinkMenu({
    documentContent: content,
    workspaceMarkdownFiles,
    activeFilePath,
    onSelectCandidate: (candidate, match: LinkQueryMatch) => {
      const view = viewRef.current
      if (!view || !runtimeRef.current.enableLinkAutocomplete) {
        return
      }
      const docText = view.state.doc.toString()
      const edit = buildRawLinkEdit(docText, match, candidate)
      view.dispatch({
        changes: { from: edit.from, to: edit.to, insert: edit.text },
        selection: { anchor: edit.cursorOffset },
        annotations: linkInsertAnnotation.of(true)
      })
      view.focus()
    }
  })

  const {
    handlePaste: handleImagePaste,
    handleDragOver: handleImageDragOver,
    handleDrop: handleImageDrop
  } = useEditorImageTransfer<EditorView>({
    documentPath: documentPath ?? null,
    enableImageInsertion,
    getTarget: () => viewRef.current,
    posAtCoords: (view, clientX, clientY) => view.posAtCoords({ x: clientX, y: clientY }),
    getSelectionRange: (view) => {
      const sel = view.state.selection.main
      return { from: sel.from, to: sel.to }
    },
    insertImages: (view, results, range) => {
      const docLen = view.state.doc.length
      const clampedFrom = Math.max(0, Math.min(range.from, docLen))
      const clampedTo = Math.max(clampedFrom, Math.min(range.to, docLen))
      const markdownText = formatRawMarkdownImages(results)
      view.dispatch({
        changes: { from: clampedFrom, to: clampedTo, insert: markdownText },
        selection: { anchor: clampedFrom + markdownText.length }
      })
      view.focus()
    }
  })
  const dismissLinkMenu = linkMenuProps.onDismiss
  const lineEndingRef = useRef<'\r\n' | '\n'>(detectDocumentLineEnding(content))
  const lastCursorPropRef = useRef<CursorPosition>(cursor)
  const prevCompartmentsRef = useRef({
    language,
    languageTarget: fileName ?? documentPath ?? null,
    theme,
    showTableToolbar
  })

  const [inTable, setInTable] = useState(() => {
    if (!showTableToolbar) return false
    const normalized = normalizeLineEndingsToLf(content)
    const { anchor } = clampSelection(normalized.length, cursor)
    return detectTableAtOffset(normalized, anchor) !== null
  })

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const initial = runtimeRef.current
    const compartments = compartmentsRef.current
    const normalizedInitial = normalizeLineEndingsToLf(initial.content)
    const initialSelection = clampSelection(normalizedInitial.length, initial.cursor)
    lastCursorPropRef.current = initial.cursor

    const handleRawCtrlK = (view: EditorView): boolean => {
      if (!runtimeRef.current.enableLinkAutocomplete || runtimeRef.current.isShortcutDisabled) {
        return false
      }
      const { from, to, empty } = view.state.selection.main
      const docText = view.state.doc.toString()
      if (
        isOffsetInFrontmatter(docText, from) ||
        isOffsetInCodeFence(docText, from) ||
        isOffsetInCodeFence(docText, to)
      ) {
        return false
      }
      const selected = empty ? '' : docText.slice(from, to)
      if (selected.includes('\n')) {
        return false
      }
      const insert = `[${selected}](`
      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: from + insert.length }
      })
      return true
    }
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
        rawSearchHighlightField,
        rawSearchJumpHighlightField,
        symbolHoverHighlightField,
        compartments.language.of(
          createLanguageExtension(initial.language, initial.fileName ?? documentPath)
        ),
        compartments.theme.of(createEditorThemeExtension(initial.theme)),
        compartments.tableKeymap.of(initial.showTableToolbar ? rawTableKeymap : []),
        EditorView.domEventHandlers({
          mousemove: (event, view) => {
            const targetName = runtimeRef.current.fileName ?? documentPath ?? ''
            if (
              runtimeRef.current.language === 'markdown' ||
              !isSymbolModifierPressed(event) ||
              !isSymbolSupportedFile(targetName)
            ) {
              clearSymbolHover(view)
              return false
            }
            const token = resolveRawSymbolTokenAtEvent(
              view,
              event,
              targetName,
              symbolParserRef.current
            )
            if (!token) {
              clearSymbolHover(view)
              return false
            }
            const line = view.state.doc.line(token.lineNumber)
            const from = line.from + token.columnStart
            const to = line.from + token.columnEnd
            view.dispatch({ effects: setSymbolHoverRangeEffect.of({ from, to }) })
            return false
          },
          mouseleave: (_event, view) => {
            clearSymbolHover(view)
            return false
          },
          keyup: (event, view) => {
            if (!isSymbolModifierPressed(event)) {
              clearSymbolHover(view)
            }
            return false
          },
          click: (event, view) => {
            if (runtimeRef.current.language === 'markdown') {
              if (!isLinkNavigationClick('raw', event)) {
                return false
              }
              const navigate = runtimeRef.current.onLinkNavigate
              if (!navigate) {
                return false
              }
              const offset = resolveRawClickOffset(view, event)
              if (offset === null) {
                return false
              }
              const href = extractMarkdownLinkHrefAtOffset(view.state.doc.toString(), offset)
              if (href === null) {
                return false
              }
              event.preventDefault()
              navigate(href)
              return true
            }

            if (!isSymbolModifierPressed(event)) {
              return false
            }
            const symbolNavigate = runtimeRef.current.onSymbolNavigate
            const targetName = runtimeRef.current.fileName ?? documentPath ?? ''
            if (!symbolNavigate || !isSymbolSupportedFile(targetName)) {
              return false
            }
            const token = resolveRawSymbolTokenAtEvent(
              view,
              event,
              targetName,
              symbolParserRef.current
            )
            if (!token) {
              return false
            }
            event.preventDefault()
            symbolNavigate({
              symbolName: token.name,
              lineNumber: token.lineNumber,
              columnStart: token.columnStart,
              columnEnd: token.columnEnd,
              clientX: event.clientX,
              clientY: event.clientY,
              shiftKey: event.shiftKey
            })
            return true
          }
        }),
        Prec.highest(
          keymap.of([
            {
              key: 'ArrowDown',
              run: () => linkControlsRef.current.moveSelection(1)
            },
            {
              key: 'ArrowUp',
              run: () => linkControlsRef.current.moveSelection(-1)
            },
            {
              key: 'Enter',
              run: () => linkControlsRef.current.applySelected()
            },
            {
              key: 'Tab',
              run: () => linkControlsRef.current.applySelected()
            },
            {
              key: 'Escape',
              run: () => linkControlsRef.current.dismiss()
            },
            { key: 'Ctrl-k', run: handleRawCtrlK },
            { key: 'Meta-k', run: handleRawCtrlK }
          ])
        ),
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab
        ]),
        EditorView.contentAttributes.of({
          'data-testid': 'document-editor',
          'aria-label': '문서 에디터',
          spellcheck: 'false'
        }),
        Prec.high(
          EditorView.domEventHandlers({
            paste: (event, view) => handleImagePaste(event, view),
            dragover: (event) => handleImageDragOver(event),
            drop: (event, view) => handleImageDrop(event, view)
          })
        ),
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
          const isProgrammaticInsert = update.transactions.some((tr) =>
            tr.annotation(linkInsertAnnotation)
          )
          if (isProgrammaticInsert) {
            return
          }
          if (update.docChanged) {
            const sel = update.state.selection.main
            const docText = update.state.doc.toString()
            const linkMatch =
              runtimeRef.current.enableLinkAutocomplete && sel.empty
                ? detectLinkQuery(docText, sel.head)
                : null

            linkControlsRef.current.syncDocMatch(linkMatch, update.view, shellRef.current, docText)
          } else if (update.selectionSet) {
            if (linkControlsRef.current.stateRef.current.isOpen) {
              const sel = update.state.selection.main
              const docText = update.state.doc.toString()
              const currentMatch =
                runtimeRef.current.enableLinkAutocomplete && sel.empty
                  ? detectLinkQuery(docText, sel.head)
                  : null
              linkControlsRef.current.syncOpenSelection(
                currentMatch,
                update.view,
                shellRef.current,
                docText
              )
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
    if (initial.findHighlight) {
      lastScrolledFindNonceRef.current = initial.findHighlight.scrollNonce
      if (initial.findHighlight.isActive && initial.findHighlight.matches.length > 0) {
        syncRawSearchHighlights(view, {
          isActive: true,
          matches: initial.findHighlight.matches,
          activeIndex: initial.findHighlight.activeIndex,
          scrollToActive: false,
          externalAnnotation: externalSyncAnnotation.of(true)
        })
      }
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
    const languageTarget = fileName ?? documentPath ?? null

    if (prev.language !== language || prev.languageTarget !== languageTarget) {
      effects.push(
        compartments.language.reconfigure(createLanguageExtension(language, languageTarget))
      )
    }
    if (!enableLinkAutocomplete) {
      dismissLinkMenu()
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
    prevCompartmentsRef.current = { language, languageTarget, theme, showTableToolbar }
    view.dispatch({ effects, annotations: externalSyncAnnotation.of(true) })
  }, [
    dismissLinkMenu,
    documentPath,
    enableLinkAutocomplete,
    fileName,
    language,
    theme,
    showTableToolbar
  ])

  useEffect(() => {
    const languageTarget = fileName ?? documentPath ?? null
    if (language !== 'code' || !languageTarget) return
    const resolution = resolveRawCodeLanguageSync(languageTarget)
    if (!resolution.needsAsyncLoad) return

    let cancelled = false
    void loadRawCodeLanguage(languageTarget).then((extension) => {
      if (cancelled || !extension) return
      const view = viewRef.current
      const currentTarget = runtimeRef.current.fileName ?? documentPath ?? null
      if (!view || runtimeRef.current.language !== 'code' || currentTarget !== languageTarget) {
        return
      }
      view.dispatch({
        effects: compartmentsRef.current.language.reconfigure(extension),
        annotations: externalSyncAnnotation.of(true)
      })
    })

    return () => {
      cancelled = true
    }
  }, [documentPath, fileName, language])

  useLayoutEffect(() => {
    const view = viewRef.current
    if (!view) return

    const normalizedPropDoc = normalizeLineEndingsToLf(content)
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
      if (docChanged) {
        dismissLinkMenu()
      }
      lastCursorPropRef.current = cursor
      syncSelectionAttrs(view)
    }

    if (showTableToolbar && (docChanged || cursorPropChanged)) {
      setInTable(isViewCursorInRawTable(view))
    }
  }, [content, cursor, dismissLinkMenu, showTableToolbar])

  useLayoutEffect(() => {
    const view = viewRef.current
    if (!view) return
    syncElementScrollTop(view.scrollDOM, scrollTop)
  }, [scrollTop])

  useLayoutEffect(() => {
    const view = viewRef.current
    if (!view) return
    if (!findHighlight) {
      syncRawSearchHighlights(view, {
        isActive: false,
        matches: [],
        activeIndex: -1,
        scrollToActive: false,
        externalAnnotation: externalSyncAnnotation.of(true)
      })
      return
    }

    const shouldScroll =
      findHighlight.isActive &&
      findHighlight.matches.length > 0 &&
      findHighlight.scrollNonce > 0 &&
      findHighlight.scrollNonce !== lastScrolledFindNonceRef.current
    if (shouldScroll) {
      lastScrolledFindNonceRef.current = findHighlight.scrollNonce
    }

    syncRawSearchHighlights(view, {
      isActive: findHighlight.isActive,
      matches: findHighlight.matches,
      activeIndex: findHighlight.activeIndex,
      scrollToActive: shouldScroll,
      externalAnnotation: externalSyncAnnotation.of(true),
      onScrolled: (nextScrollTop, didSetScrollTop) => {
        if (didSetScrollTop) {
          runtimeRef.current.onUpdateViewState({ scrollTop: nextScrollTop })
        }
        runtimeRef.current.onRawScroll?.()
      }
    })
  }, [content, findHighlight])

  useLayoutEffect(() => {
    const view = viewRef.current
    if (!view || jumpHighlight) return
    syncRawJumpHighlight(view, null, {
      externalAnnotation: externalSyncAnnotation.of(true)
    })
  }, [jumpHighlight])

  useEffect(() => {
    const view = viewRef.current
    if (!view || !jumpHighlight) return
    if (jumpHighlight.nonce <= 0 || jumpHighlight.nonce === lastHandledJumpNonceRef.current) {
      return
    }
    lastHandledJumpNonceRef.current = jumpHighlight.nonce
    syncRawJumpHighlight(view, jumpHighlight, {
      onScrolled: (nextScrollTop, didSetScrollTop) => {
        if (didSetScrollTop) {
          runtimeRef.current.onUpdateViewState({ scrollTop: nextScrollTop })
        }
        runtimeRef.current.onRawScroll?.()
      }
    })
  }, [jumpHighlight])

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

  return {
    shellRef,
    hostRef,
    inTable,
    runTableAction,
    linkMenuProps,
    shellDragProps: {
      onDragOver: (event: { nativeEvent: DragEvent }) => {
        handleImageDragOver(event.nativeEvent)
      },
      onDrop: (event: { nativeEvent: DragEvent }) => {
        handleImageDrop(event.nativeEvent, viewRef.current)
      }
    }
  }
}
