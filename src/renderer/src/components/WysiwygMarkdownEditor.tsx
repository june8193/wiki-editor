import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DEFAULT_CUSTOM_COMMANDS,
  type CustomCommandConfig,
  type ThemeMode
} from '@shared/config'
import type { WorkspaceEntry } from '@shared/workspace'
import type { Editor } from '@tiptap/core'
import { EditorContent, useEditor, useEditorState } from '@tiptap/react'
import type { MermaidRenderer } from '../editor/mermaidRenderer'
import { isLinkNavigationClick } from '../editor/MarkdownLinkNavigation'
import { findFirstNonFencedSlashTocLine, insertOrUpdateTocBlock } from '../editor/MarkdownTocEngine'
import {
  addTableRowBeforeSafely,
  applyWysiwygCtrlK,
  createWysiwygExtensions,
  deleteTableRowPreservingHeader,
  detectProseMirrorLinkQuery,
  detectProseMirrorSlashQuery,
  headingNumberingPluginKey,
  insertWysiwygLink,
  insertWysiwygMarkdownWithCursor,
  linkInsertPluginKey,
  prepareMarkdownForTiptap,
  type ProseMirrorLinkQueryMatch,
  sanitizeHtmlWithRehype,
  slashInsertPluginKey
} from '../editor/wysiwygMarkdown'
import { useDismissable } from '../hooks/useDismissable'
import { useLinkMenu } from '../hooks/useLinkMenu'
import { useOneShotScroll } from '../hooks/useOneShotScroll'
import { readSafeCaretCoords, type SlashMenuRange, useSlashMenu } from '../hooks/useSlashMenu'
import { useSyncScrollTop } from '../hooks/useSyncScrollTop'
import { LinkAutocompleteMenu } from './LinkAutocompleteMenu'
import { WysiwygMermaidContext } from './MermaidCodeBlockNodeView'
import { SlashCommandMenu } from './SlashCommandMenu'

export interface WysiwygScrollRequest {
  index: number
  nonce: number
}

interface WysiwygMarkdownEditorProps {
  content: string
  scrollTop: number
  theme?: ThemeMode
  showHeadingNumbers?: boolean
  enableLinkAutocomplete?: boolean
  isShortcutDisabled?: boolean
  mermaidRenderer?: MermaidRenderer
  customCommands?: readonly CustomCommandConfig[]
  documentTitle?: string
  workspaceMarkdownFiles?: readonly WorkspaceEntry[]
  activeFilePath?: string | null
  scrollRequest?: WysiwygScrollRequest | null
  onChangeContent: (nextContent: string) => void
  onScrollTopChange?: (scrollTop: number) => void
  onLinkNavigate?: (href: string) => void
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
  showHeadingNumbers = false,
  enableLinkAutocomplete = true,
  isShortcutDisabled = false,
  mermaidRenderer,
  customCommands = DEFAULT_CUSTOM_COMMANDS,
  documentTitle,
  workspaceMarkdownFiles,
  activeFilePath,
  scrollRequest,
  onChangeContent,
  onScrollTopChange,
  onLinkNavigate
}: WysiwygMarkdownEditorProps) {
  const shellRef = useRef<HTMLDivElement | null>(null)
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const contextMenuRef = useRef<HTMLDivElement | null>(null)
  const isProgrammaticSyncRef = useRef(false)
  const hasLocalEditRef = useRef(false)
  const contentRef = useRef(content)
  contentRef.current = content
  const lastEmittedMarkdownRef = useRef(content)
  const lastSyncedContentPropRef = useRef(content)
  const onChangeContentRef = useRef(onChangeContent)
  onChangeContentRef.current = onChangeContent
  const documentTitleRef = useRef(documentTitle)
  documentTitleRef.current = documentTitle
  const enableLinkAutocompleteRef = useRef(enableLinkAutocomplete)
  enableLinkAutocompleteRef.current = enableLinkAutocomplete
  const isShortcutDisabledRef = useRef(isShortcutDisabled)
  isShortcutDisabledRef.current = isShortcutDisabled
  const insertTocRef = useRef<() => void>(() => undefined)
  const editorRef = useRef<Editor | null>(null)

  const {
    controlsRef: slashControlsRef,
    menuProps: slashMenuProps,
    dismiss: dismissSlashMenu
  } = useSlashMenu(customCommands, (command, explicitRange?: SlashMenuRange) => {
    const instance = editorRef.current
    if (!instance) return false
    const range = explicitRange ?? detectProseMirrorSlashQuery(instance.state)
    if (!range) return false

    return insertWysiwygMarkdownWithCursor(instance, command, range, {
      title: documentTitleRef.current
    })
  })

  const { linkControlsRef, linkMenuProps } = useLinkMenu<ProseMirrorLinkQueryMatch>({
    documentContent: content,
    workspaceMarkdownFiles,
    activeFilePath,
    onOpenMenu: dismissSlashMenu,
    onSelectCandidate: (candidate, match) => {
      const instance = editorRef.current
      if (!instance || !enableLinkAutocompleteRef.current) {
        return
      }
      insertWysiwygLink(instance, candidate, match)
    }
  })
  const dismissLinkMenu = linkMenuProps.onDismiss

  const [cellMenuPos, setCellMenuPos] = useState<{ x: number; y: number } | null>(null)
  const closeCellMenu = useCallback(() => setCellMenuPos(null), [])
  useDismissable(cellMenuPos !== null, contextMenuRef, closeCellMenu)

  const editor = useEditor(
    {
      immediatelyRender: true,
      extensions: createWysiwygExtensions({ showHeadingNumbers }),
      content: prepareMarkdownForTiptap(content),
      contentType: 'markdown',
      editorProps: {
        attributes: {
          class: 'wysiwyg-prosemirror',
          'data-testid': 'document-editor',
          'aria-label': '위지윅 문서 에디터'
        },
        transformPastedHTML: sanitizeHtmlWithRehype,
        handleKeyDown: (view, event) => {
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
          const activeControls = linkControlsRef.current.stateRef.current.isOpen
            ? linkControlsRef.current
            : slashControlsRef.current.stateRef.current.isOpen
              ? slashControlsRef.current
              : null

          if (activeControls) {
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

          if (event.key === 'Enter' && !hasModifier) {
            const { $from, empty } = view.state.selection
            if (
              empty &&
              $from.parent.type.name === 'paragraph' &&
              $from.parent.textContent.trim() === '/toc'
            ) {
              event.preventDefault()
              insertTocRef.current()
              return true
            }
          }
          return false
        }
      },
      onUpdate: ({ editor: instance, transaction }) => {
        if (isProgrammaticSyncRef.current || !transaction.docChanged) {
          return
        }
        hasLocalEditRef.current = true
        const serialized = instance.getMarkdown()
        lastEmittedMarkdownRef.current = serialized
        onChangeContentRef.current(serialized)

        if (
          transaction.getMeta(slashInsertPluginKey) ||
          transaction.getMeta(linkInsertPluginKey)
        ) {
          slashControlsRef.current.dismiss()
          linkControlsRef.current.dismiss()
          return
        }

        const linkMatch = enableLinkAutocompleteRef.current
          ? detectProseMirrorLinkQuery(instance.state)
          : null
        if (linkControlsRef.current.syncDocMatch(linkMatch, instance.view, shellRef.current, serialized)) {
          slashControlsRef.current.dismiss()
          return
        }

        const match = detectProseMirrorSlashQuery(instance.state)
        const coords = match ? readSafeCaretCoords(instance.view, match.rangeFrom) : null
        slashControlsRef.current.updateFromMatch(match, coords, shellRef.current)
      },
      onSelectionUpdate: ({ editor: instance, transaction }) => {
        if (transaction.docChanged) {
          return
        }
        const { from, to, empty } = instance.state.selection
        slashControlsRef.current.dismissIfSelectionOutside(from, to, empty)
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

  const syncEditorContent = useCallback(
    (markdown: string, markLocalEdit: boolean): void => {
      if (!editor) return
      isProgrammaticSyncRef.current = true
      try {
        editor.commands.setContent(prepareMarkdownForTiptap(markdown), {
          emitUpdate: false,
          contentType: 'markdown'
        })
        hasLocalEditRef.current = markLocalEdit
        lastEmittedMarkdownRef.current = markdown
        dismissSlashMenu()
        dismissLinkMenu()
      } finally {
        isProgrammaticSyncRef.current = false
      }
    },
    [dismissLinkMenu, dismissSlashMenu, editor]
  )

  useEffect(() => {
    if (!enableLinkAutocomplete) {
      dismissLinkMenu()
    }
  }, [dismissLinkMenu, enableLinkAutocomplete])

  const handleInsertToc = useCallback((): void => {
    if (!editor) return
    const currentMd = hasLocalEditRef.current ? editor.getMarkdown() : contentRef.current
    const cursorLine = findFirstNonFencedSlashTocLine(currentMd)
    const nextMd = insertOrUpdateTocBlock(currentMd, cursorLine)
    if (nextMd === currentMd) return

    syncEditorContent(nextMd, true)
    onChangeContentRef.current(nextMd)
  }, [editor, syncEditorContent])

  insertTocRef.current = handleInsertToc

  useEffect(() => {
    if (!editor) return
    if (content === lastSyncedContentPropRef.current) return
    lastSyncedContentPropRef.current = content
    if (content === lastEmittedMarkdownRef.current) return
    syncEditorContent(content, false)
  }, [content, editor, syncEditorContent])

  useEffect(() => {
    if (!editor) return
    const current = headingNumberingPluginKey.getState(editor.state)
    if (current !== showHeadingNumbers) {
      editor.view.dispatch(editor.state.tr.setMeta(headingNumberingPluginKey, showHeadingNumbers))
    }
  }, [editor, showHeadingNumbers])

  useOneShotScroll(scrollRequest, Boolean(editor), (req) => {
    if (!editor) return false

    const headingPositions: number[] = []
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'heading') {
        headingPositions.push(pos)
        return false
      }
      return node.type.name !== 'codeBlock'
    })

    const targetPos = headingPositions[req.index]
    if (targetPos === undefined) return true

    const dom = editor.view.nodeDOM(targetPos)
    if (dom instanceof Element && typeof dom.scrollIntoView === 'function') {
      dom.scrollIntoView({ block: 'start' })
    }
    editor.commands.setTextSelection(targetPos + 1)
    return true
  })

  useSyncScrollTop(scrollContainerRef, scrollTop)

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

  const mermaidContextValue = useMemo(
    () => ({ theme, mermaidRenderer }),
    [mermaidRenderer, theme]
  )

  return (
    <div ref={shellRef} className="wysiwyg-shell">
      <div className="editor-toolbar" role="toolbar" aria-label="위지윅 서식 툴바">
        {FORMAT_TOOLBAR_ITEMS.map((item) => {
          if (item.kind === 'divider') {
            return <span key={item.id} className="toolbar-divider" aria-hidden="true" />
          }
          const isActive = item.activeKey ? toolbarState[item.activeKey] : false
          return (
            <button
              key={item.id}
              type="button"
              className={`toolbar-btn${isActive ? ' is-active' : ''}`}
              aria-pressed={item.activeKey ? isActive : undefined}
              onClick={() => item.run(editor)}
            >
              {item.label}
            </button>
          )
        })}
        <button
          type="button"
          className="toolbar-btn"
          title="본문에 목차(/toc) 삽입"
          onClick={handleInsertToc}
        >
          목차 삽입
        </button>
      </div>

      <div
        ref={scrollContainerRef}
        className="wysiwyg-scroll-container"
        onScroll={(event) => onScrollTopChange?.(event.currentTarget.scrollTop)}
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

        <WysiwygMermaidContext.Provider value={mermaidContextValue}>
          <EditorContent editor={editor} className="wysiwyg-editor-content" />
        </WysiwygMermaidContext.Provider>
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

      <SlashCommandMenu {...slashMenuProps} />
      {enableLinkAutocomplete ? <LinkAutocompleteMenu {...linkMenuProps} /> : null}
    </div>
  )
}
