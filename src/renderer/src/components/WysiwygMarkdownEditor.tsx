import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ThemeMode } from '@shared/config'
import type { WorkspaceEntry } from '@shared/workspace'
import type { Editor } from '@tiptap/core'
import { EditorContent, useEditor, useEditorState } from '@tiptap/react'
import {
  areDocumentFindResultReportsEqual,
  type DocumentFindHighlightQuery,
  type DocumentFindResultReport
} from '../editor/documentFind'
import type { MermaidRenderer } from '../editor/mermaidRenderer'
import {
  type MermaidHeightChangeHandler,
  MermaidHeightSessionProvider
} from '../editor/mermaidHeightSession'
import { isLinkNavigationClick } from '../editor/editorModes'
import {
  type HeadingScrollSpySample,
  resolveMatchingOutlineCandidates
} from '../editor/outlineScrollSpy'
import {
  addTableRowBeforeSafely,
  applyWysiwygCtrlK,
  collectWysiwygMermaidPositions,
  createWysiwygExtensions,
  deleteTableRowPreservingHeader,
  detectProseMirrorLinkQuery,
  extractWysiwygHeadingCandidates,
  insertWysiwygImages,
  insertWysiwygLink,
  linkInsertPluginKey,
  prepareMarkdownForTiptap,
  type ProseMirrorLinkQueryMatch,
  sanitizeHtmlWithRehype,
  syncWysiwygImageDisplaySources
} from '../editor/wysiwygMarkdown'
import {
  areWysiwygSearchSnapshotsEqual,
  getWysiwygSearchSnapshot,
  scrollWysiwygActiveMatch,
  syncWysiwygSearchHighlights
} from '../editor/wysiwygSearchHighlight'
import { useDismissable } from '../hooks/useDismissable'
import { useEditorImageTransfer } from '../hooks/useEditorImageTransfer'
import { useContainerOutlineSpy } from '../hooks/useEditorOutlineSpy'
import { useLinkMenu } from '../hooks/useLinkMenu'
import type { MermaidDiagramHeightMap } from '../stores/PaneTabStore'
import { LinkAutocompleteMenu } from './LinkAutocompleteMenu'
import { WysiwygMermaidContext } from './MermaidCodeBlockNodeView'

export interface WysiwygScrollRequest {
  index: number
  nonce: number
}

interface WysiwygMarkdownEditorProps {
  content: string
  scrollTop: number
  theme?: ThemeMode
  enableLinkAutocomplete?: boolean
  isShortcutDisabled?: boolean
  documentTitle?: string
  mermaidRenderer?: MermaidRenderer
  mermaidHeights?: MermaidDiagramHeightMap
  onMermaidHeightChange?: MermaidHeightChangeHandler
  workspaceMarkdownFiles?: readonly WorkspaceEntry[]
  activeFilePath?: string | null
  documentPath?: string
  enableImageInsertion?: boolean
  scrollRequest?: WysiwygScrollRequest | null
  findHighlight?: DocumentFindHighlightQuery | null
  editorRef?: { current: Editor | null }
  isActive?: boolean
  onChangeContent: (nextContent: string) => void
  onScrollTopChange?: (scrollTop: number) => void
  onLinkNavigate?: (href: string) => void
  onActiveHeadingChange?: (sample: HeadingScrollSpySample) => void
  onFindResultChange?: (report: DocumentFindResultReport) => void
}

interface ToolbarStateSnapshot {
  h1: boolean
  h2: boolean
  h3: boolean
  bold: boolean
  italic: boolean
  code: boolean
  codeBlock: boolean
  bulletList: boolean
  orderedList: boolean
  taskList: boolean
  blockquote: boolean
  isTable: boolean
}

type FormatItemDescriptor =
  | {
      kind: 'divider'
      id: string
    }
  | {
      kind: 'button'
      id: string
      label: string
      activeKey?: Exclude<keyof ToolbarStateSnapshot, 'isTable'>
      run: (editor: Editor) => boolean
    }

const FORMAT_TOOLBAR_ITEMS: readonly FormatItemDescriptor[] = [
  {
    kind: 'button',
    id: 'h1',
    label: 'H1',
    activeKey: 'h1',
    run: (editor) => editor.chain().focus().toggleHeading({ level: 1 }).run()
  },
  {
    kind: 'button',
    id: 'h2',
    label: 'H2',
    activeKey: 'h2',
    run: (editor) => editor.chain().focus().toggleHeading({ level: 2 }).run()
  },
  {
    kind: 'button',
    id: 'h3',
    label: 'H3',
    activeKey: 'h3',
    run: (editor) => editor.chain().focus().toggleHeading({ level: 3 }).run()
  },
  { kind: 'divider', id: 'div-heading' },
  {
    kind: 'button',
    id: 'bold',
    label: '굵게',
    activeKey: 'bold',
    run: (editor) => editor.chain().focus().toggleBold().run()
  },
  {
    kind: 'button',
    id: 'italic',
    label: '기울임',
    activeKey: 'italic',
    run: (editor) => editor.chain().focus().toggleItalic().run()
  },
  {
    kind: 'button',
    id: 'code',
    label: '인라인 코드',
    activeKey: 'code',
    run: (editor) => editor.chain().focus().toggleCode().run()
  },
  {
    kind: 'button',
    id: 'codeBlock',
    label: '코드 블록',
    activeKey: 'codeBlock',
    run: (editor) => editor.chain().focus().toggleCodeBlock().run()
  },
  { kind: 'divider', id: 'div-inline' },
  {
    kind: 'button',
    id: 'bulletList',
    label: '글머리 목록',
    activeKey: 'bulletList',
    run: (editor) => editor.chain().focus().toggleBulletList().run()
  },
  {
    kind: 'button',
    id: 'orderedList',
    label: '번호 목록',
    activeKey: 'orderedList',
    run: (editor) => editor.chain().focus().toggleOrderedList().run()
  },
  {
    kind: 'button',
    id: 'taskList',
    label: '체크리스트',
    activeKey: 'taskList',
    run: (editor) => editor.chain().focus().toggleTaskList().run()
  },
  {
    kind: 'button',
    id: 'blockquote',
    label: '인용',
    activeKey: 'blockquote',
    run: (editor) => editor.chain().focus().toggleBlockquote().run()
  },
  { kind: 'divider', id: 'div-block' },
  {
    kind: 'button',
    id: 'insertTable',
    label: '표 삽입',
    run: (editor) =>
      editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
  }
]

const TABLE_ACTION_ITEMS: ReadonlyArray<{
  id: string
  label: string
  danger?: boolean
  run: (editor: Editor) => boolean
}> = [
  {
    id: 'addRowBefore',
    label: '행 위 추가',
    run: (editor) => addTableRowBeforeSafely(editor)
  },
  {
    id: 'addRowAfter',
    label: '행 아래 추가',
    run: (editor) => editor.chain().focus().addRowAfter().run()
  },
  {
    id: 'addColumnBefore',
    label: '열 좌 추가',
    run: (editor) => editor.chain().focus().addColumnBefore().run()
  },
  {
    id: 'addColumnAfter',
    label: '열 우 추가',
    run: (editor) => editor.chain().focus().addColumnAfter().run()
  },
  {
    id: 'deleteRow',
    label: '현재 행 삭제',
    run: (editor) => deleteTableRowPreservingHeader(editor)
  },
  {
    id: 'deleteColumn',
    label: '현재 열 삭제',
    run: (editor) => editor.chain().focus().deleteColumn().run()
  },
  {
    id: 'deleteTable',
    label: '표 삭제',
    danger: true,
    run: (editor) => editor.chain().focus().deleteTable().run()
  }
]

export function WysiwygMarkdownEditor({
  content,
  scrollTop,
  theme = 'light',
  enableLinkAutocomplete = true,
  isShortcutDisabled = false,
  documentTitle,
  mermaidRenderer,
  mermaidHeights,
  onMermaidHeightChange,
  workspaceMarkdownFiles,
  activeFilePath,
  documentPath,
  enableImageInsertion = Boolean(documentPath),
  scrollRequest,
  findHighlight = null,
  editorRef: externalEditorRef,
  isActive = true,
  onChangeContent,
  onScrollTopChange,
  onLinkNavigate,
  onActiveHeadingChange,
  onFindResultChange
}: WysiwygMarkdownEditorProps) {
  const shellRef = useRef<HTMLDivElement | null>(null)
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const contextMenuRef = useRef<HTMLDivElement | null>(null)
  const isProgrammaticSyncRef = useRef(false)
  const lastEmittedMarkdownRef = useRef(content)
  const lastSyncedContentPropRef = useRef(content)
  const onChangeContentRef = useRef(onChangeContent)
  onChangeContentRef.current = onChangeContent
  const onFindResultChangeRef = useRef(onFindResultChange)
  onFindResultChangeRef.current = onFindResultChange
  const lastScrolledFindNonceRef = useRef(findHighlight?.scrollNonce ?? 0)
  const lastReportedFindRef = useRef<DocumentFindResultReport | null>(null)
  const enableLinkAutocompleteRef = useRef(enableLinkAutocomplete)
  enableLinkAutocompleteRef.current = enableLinkAutocomplete
  const isShortcutDisabledRef = useRef(isShortcutDisabled)
  isShortcutDisabledRef.current = isShortcutDisabled
  const documentPathRef = useRef(documentPath)
  documentPathRef.current = documentPath
  const editorRef = useRef<Editor | null>(null)

  const { linkControlsRef, linkMenuProps } = useLinkMenu<ProseMirrorLinkQueryMatch>({
    documentContent: content,
    workspaceMarkdownFiles,
    activeFilePath,
    onSelectCandidate: (candidate, match) => {
      const instance = editorRef.current
      if (!instance || !enableLinkAutocompleteRef.current) {
        return
      }
      insertWysiwygLink(instance, candidate, match)
    }
  })

  const {
    handlePaste: handleImagePaste,
    handleDragOver: handleImageDragOver,
    handleDrop: handleImageDrop
  } = useEditorImageTransfer<Editor['view']>({
    documentPath: documentPath ?? null,
    enableImageInsertion,
    suppressNativeTabDrop: true,
    getTarget: () => {
      const instance = editorRef.current
      return instance && !instance.isDestroyed ? instance.view : null
    },
    posAtCoords: (view, clientX, clientY) =>
      view.posAtCoords({ left: clientX, top: clientY })?.pos ?? null,
    getSelectionRange: (view) => ({
      from: view.state.selection.from,
      to: view.state.selection.to
    }),
    insertImages: (_view, results, range) => {
      const instance = editorRef.current
      if (instance && !instance.isDestroyed) {
        insertWysiwygImages(instance, results, range)
      }
    }
  })
  const dismissLinkMenu = linkMenuProps.onDismiss

  const [cellMenuPos, setCellMenuPos] = useState<{ x: number; y: number } | null>(null)
  const closeCellMenu = useCallback(() => setCellMenuPos(null), [])
  useDismissable(cellMenuPos !== null, contextMenuRef, closeCellMenu)

  const editor = useEditor(
    {
      immediatelyRender: true,
      extensions: createWysiwygExtensions({
        getDocumentPath: () => documentPathRef.current
      }),
      content: prepareMarkdownForTiptap(content),
      contentType: 'markdown',
      editorProps: {
        attributes: {
          class: 'wysiwyg-prosemirror',
          'data-testid': 'document-editor',
          'aria-label': '위지윅 문서 에디터',
          spellcheck: 'false'
        },
        transformPastedHTML: sanitizeHtmlWithRehype,
        handlePaste: (view, event) => handleImagePaste(event, view),
        handleDOMEvents: {
          dragover: (_view, event) => handleImageDragOver(event),
          drop: (view, event) => handleImageDrop(event, view)
        },
        handleKeyDown: (_view, event) => {
          const isCtrlOrMetaK =
            (event.ctrlKey || event.metaKey) &&
            !event.shiftKey &&
            !event.altKey &&
            event.key.toLowerCase() === 'k'
          if (isCtrlOrMetaK) {
            if (!enableLinkAutocompleteRef.current || isShortcutDisabledRef.current) {
              return false
            }
            const instance = editorRef.current
            if (instance && applyWysiwygCtrlK(instance)) {
              event.preventDefault()
              return true
            }
            return false
          }
          const hasModifier = event.shiftKey || event.ctrlKey || event.metaKey || event.altKey
          if (linkControlsRef.current.stateRef.current.isOpen) {
            const activeControls = linkControlsRef.current
            if (event.key === 'ArrowDown' && !hasModifier && activeControls.moveSelection(1)) {
              event.preventDefault()
              return true
            }
            if (event.key === 'ArrowUp' && !hasModifier && activeControls.moveSelection(-1)) {
              event.preventDefault()
              return true
            }
            if (
              (event.key === 'Enter' || event.key === 'Tab') &&
              !hasModifier &&
              activeControls.applySelected()
            ) {
              event.preventDefault()
              return true
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              return activeControls.dismiss()
            }
          }
          return false
        }
      },
      onUpdate: ({ editor: instance, transaction }) => {
        if (isProgrammaticSyncRef.current || !transaction.docChanged) {
          return
        }
        const serialized = instance.getMarkdown()
        lastEmittedMarkdownRef.current = serialized
        onChangeContentRef.current(serialized)
        if (transaction.getMeta(linkInsertPluginKey)) {
          linkControlsRef.current.dismiss()
          return
        }

        const linkMatch = enableLinkAutocompleteRef.current
          ? detectProseMirrorLinkQuery(instance.state)
          : null
        linkControlsRef.current.syncDocMatch(linkMatch, instance.view, shellRef.current, serialized)
      },
      onSelectionUpdate: ({ editor: instance, transaction }) => {
        if (transaction.docChanged) {
          return
        }
        if (linkControlsRef.current.stateRef.current.isOpen) {
          const currentMatch = enableLinkAutocompleteRef.current
            ? detectProseMirrorLinkQuery(instance.state)
            : null
          linkControlsRef.current.syncOpenSelection(
            currentMatch,
            instance.view,
            shellRef.current,
            instance.getMarkdown()
          )
        }
      }
    },
    []
  )
  editorRef.current = editor
  if (externalEditorRef) {
    externalEditorRef.current = editor
  }

  useEffect(() => {
    return () => {
      if (externalEditorRef) {
        externalEditorRef.current = null
      }
    }
  }, [externalEditorRef])

  useEffect(() => {
    documentPathRef.current = documentPath
    syncWysiwygImageDisplaySources(editor, documentPath)
  }, [documentPath, editor])

  const syncEditorContent = useCallback(
    (markdown: string): void => {
      if (!editor) return
      isProgrammaticSyncRef.current = true
      try {
        editor.commands.setContent(prepareMarkdownForTiptap(markdown), {
          emitUpdate: false,
          contentType: 'markdown'
        })
        lastEmittedMarkdownRef.current = markdown
        dismissLinkMenu()
      } finally {
        isProgrammaticSyncRef.current = false
      }
    },
    [dismissLinkMenu, editor]
  )

  useEffect(() => {
    if (!enableLinkAutocomplete) {
      dismissLinkMenu()
    }
  }, [dismissLinkMenu, enableLinkAutocomplete])
  useEffect(() => {
    if (!editor) return
    if (content === lastSyncedContentPropRef.current) return
    lastSyncedContentPropRef.current = content
    if (content === lastEmittedMarkdownRef.current) return
    syncEditorContent(content)
  }, [content, editor, syncEditorContent])

  useContainerOutlineSpy({
    containerRef: scrollContainerRef,
    content,
    scrollTop,
    isReady: Boolean(editor),
    isActive,
    scrollRequest,
    onScrollRequest: (req, headings) => {
      if (!editor) return false

      const candidates = extractWysiwygHeadingCandidates(editor.state.doc)
      const matchedHeadings = resolveMatchingOutlineCandidates(candidates, headings)
      const targetPos = matchedHeadings[req.index]?.pos
      if (targetPos === undefined) return true

      const dom = editor.view.nodeDOM(targetPos)
      if (dom instanceof Element && typeof dom.scrollIntoView === 'function') {
        dom.scrollIntoView({ block: 'start' })
      }
      editor.commands.setTextSelection(targetPos + 1)
      return true
    },
    onScrollTopChange,
    onActiveHeadingChange
  })

  const wysiwygSearchSnapshot = useEditorState({
    editor,
    selector: ({ editor: instance }) => getWysiwygSearchSnapshot(instance),
    equalityFn: areWysiwygSearchSnapshotsEqual
  })

  useLayoutEffect(() => {
    if (!editor || editor.isDestroyed) {
      return
    }

    const nextSnapshot = syncWysiwygSearchHighlights(editor, findHighlight ?? null)
    if (!findHighlight?.isActive || !nextSnapshot) {
      lastReportedFindRef.current = null
      return
    }

    if (!areDocumentFindResultReportsEqual(lastReportedFindRef.current, nextSnapshot.report)) {
      lastReportedFindRef.current = nextSnapshot.report
      onFindResultChangeRef.current?.(nextSnapshot.report)
    }

    if (
      findHighlight.scrollNonce > 0 &&
      findHighlight.scrollNonce !== lastScrolledFindNonceRef.current
    ) {
      if (nextSnapshot.report.matchCount === 0) {
        lastScrolledFindNonceRef.current = findHighlight.scrollNonce
      } else if (nextSnapshot.activeIndex >= 0) {
        lastScrolledFindNonceRef.current = findHighlight.scrollNonce
        scrollWysiwygActiveMatch(editor, scrollContainerRef.current)
      }
    }
  }, [editor, findHighlight, wysiwygSearchSnapshot])

  const toolbarState = useEditorState({
    editor,
    selector: ({ editor: instance }): ToolbarStateSnapshot => ({
      h1: instance.isActive('heading', { level: 1 }),
      h2: instance.isActive('heading', { level: 2 }),
      h3: instance.isActive('heading', { level: 3 }),
      bold: instance.isActive('bold'),
      italic: instance.isActive('italic'),
      code: instance.isActive('code'),
      codeBlock: instance.isActive('codeBlock'),
      bulletList: instance.isActive('bulletList'),
      orderedList: instance.isActive('orderedList'),
      taskList: instance.isActive('taskList'),
      blockquote: instance.isActive('blockquote'),
      isTable: instance.isActive('table')
    })
  })

  const mermaidPositions = useEditorState({
    editor,
    selector: ({ editor: instance }): readonly number[] =>
      collectWysiwygMermaidPositions(instance.state.doc),
    equalityFn: (prev, next) =>
      next !== null &&
      prev.length === next.length &&
      prev.every((pos, index) => pos === next[index])
  })

  const mermaidContextValue = useMemo(
    () => ({ theme, mermaidRenderer, documentTitle, mermaidPositions }),
    [documentTitle, mermaidPositions, mermaidRenderer, theme]
  )

  return (
    <div ref={shellRef} className="wysiwyg-shell">
      <div className="editor-toolbar" role="toolbar" aria-label="위지윅 서식 툴바">
        {FORMAT_TOOLBAR_ITEMS.map((item) => {
          if (item.kind === 'divider') {
            return <span key={item.id} className="toolbar-divider" aria-hidden="true" />
          }
          const isItemActive = item.activeKey ? toolbarState[item.activeKey] : false
          return (
            <button
              key={item.id}
              type="button"
              className={`toolbar-btn${isItemActive ? ' is-active' : ''}`}
              aria-pressed={item.activeKey ? isItemActive : undefined}
              onClick={() => item.run(editor)}
            >
              {item.label}
            </button>
          )
        })}
      </div>

      <div
        ref={scrollContainerRef}
        className="wysiwyg-scroll-container"
        onDragOver={(event) => {
          handleImageDragOver(event.nativeEvent)
        }}
        onDrop={(event) => {
          handleImageDrop(event.nativeEvent, editor.view)
        }}
        onContextMenu={(event) => {
          const target = event.target as HTMLElement | null
          const cellEl = target?.closest('td, th')
          if (!cellEl) {
            setCellMenuPos(null)
            return
          }
          event.preventDefault()
          const coords =
            typeof document.elementFromPoint === 'function' && (event.clientX > 0 || event.clientY > 0)
              ? editor.view.posAtCoords({ left: event.clientX, top: event.clientY })
              : null
          if (coords) {
            editor.commands.setTextSelection(coords.pos)
          } else {
            const domPos = editor.view.posAtDOM(cellEl, 0)
            editor.commands.setTextSelection(domPos + 1)
          }
          setCellMenuPos({ x: event.clientX, y: event.clientY })
        }}
        onClick={(event) => {
          const target = event.target as HTMLElement | null
          const anchor = target?.closest('a')
          if (!anchor) {
            return
          }
          event.preventDefault()
          if (!isLinkNavigationClick('wysiwyg', event)) {
            return
          }
          const href = anchor.getAttribute('href')
          if (href !== null) {
            onLinkNavigate?.(href)
          }
        }}
        onAuxClick={(event) => {
          const target = event.target as HTMLElement | null
          if (target?.closest('a')) {
            event.preventDefault()
          }
        }}
      >
        {toolbarState.isTable && (
          <div
            className="editor-table-toolbar is-floating"
            role="toolbar"
            aria-label="표 편집 툴바"
          >
            <span className="table-toolbar-label">표 편집</span>
            {TABLE_ACTION_ITEMS.map((action) => (
              <button
                key={action.id}
                type="button"
                className={`toolbar-btn${action.danger ? ' is-danger' : ''}`}
                onClick={() => action.run(editor)}
              >
                {action.label}
              </button>
            ))}
          </div>
        )}

        <MermaidHeightSessionProvider
          mermaidHeights={mermaidHeights}
          onMermaidHeightChange={onMermaidHeightChange}
        >
          <WysiwygMermaidContext.Provider value={mermaidContextValue}>
            <EditorContent editor={editor} className="wysiwyg-editor-content" />
          </WysiwygMermaidContext.Provider>
        </MermaidHeightSessionProvider>
      </div>

      {cellMenuPos && (
        <div
          ref={contextMenuRef}
          className="tree-context-menu"
          role="menu"
          aria-label="표 셀 작업 메뉴"
          style={{ left: cellMenuPos.x, top: cellMenuPos.y }}
        >
          {TABLE_ACTION_ITEMS.map((action) => (
            <button
              key={action.id}
              type="button"
              role="menuitem"
              className={`context-menu-item${action.danger ? ' is-danger' : ''}`}
              onClick={() => {
                action.run(editor)
                closeCellMenu()
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
      {enableLinkAutocomplete ? <LinkAutocompleteMenu {...linkMenuProps} /> : null}
    </div>
  )
}
