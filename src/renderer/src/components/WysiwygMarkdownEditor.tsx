import { useCallback, useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { EditorContent, useEditor, useEditorState } from '@tiptap/react'
import {
  addTableRowBeforeSafely,
  createWysiwygExtensions,
  deleteTableRowPreservingHeader,
  prepareMarkdownForTiptap,
  sanitizeHtmlWithRehype
} from '../editor/wysiwygMarkdown'
import { useDismissable } from '../hooks/useDismissable'
import { useSyncScrollTop } from '../hooks/useSyncScrollTop'

interface WysiwygMarkdownEditorProps {
  content: string
  scrollTop: number
  onChangeContent: (nextContent: string) => void
  onScrollTopChange?: (scrollTop: number) => void
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
  onChangeContent,
  onScrollTopChange
}: WysiwygMarkdownEditorProps) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const contextMenuRef = useRef<HTMLDivElement | null>(null)
  const isProgrammaticSyncRef = useRef(false)
  const lastEmittedMarkdownRef = useRef(content)
  const onChangeContentRef = useRef(onChangeContent)
  onChangeContentRef.current = onChangeContent

  const [cellMenuPos, setCellMenuPos] = useState<{ x: number; y: number } | null>(null)
  const closeCellMenu = useCallback(() => setCellMenuPos(null), [])
  useDismissable(cellMenuPos !== null, contextMenuRef, closeCellMenu)

  const editor = useEditor(
    {
      immediatelyRender: true,
      extensions: createWysiwygExtensions(),
      content: prepareMarkdownForTiptap(content),
      contentType: 'markdown',
      editorProps: {
        attributes: {
          class: 'wysiwyg-prosemirror',
          'data-testid': 'document-editor',
          'aria-label': '위지윅 문서 에디터'
        },
        transformPastedHTML: sanitizeHtmlWithRehype
      },
      onUpdate: ({ editor: instance, transaction }) => {
        if (isProgrammaticSyncRef.current || !transaction.docChanged) {
          return
        }
        const serialized = instance.getMarkdown()
        lastEmittedMarkdownRef.current = serialized
        onChangeContentRef.current(serialized)
      }
    },
    []
  )

  useEffect(() => {
    if (!editor) return
    if (content === lastEmittedMarkdownRef.current) return

    isProgrammaticSyncRef.current = true
    try {
      editor.commands.setContent(prepareMarkdownForTiptap(content), {
        emitUpdate: false,
        contentType: 'markdown'
      })
      lastEmittedMarkdownRef.current = content
    } finally {
      isProgrammaticSyncRef.current = false
    }
  }, [content, editor])

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

  return (
    <div className="wysiwyg-shell">
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

        <EditorContent editor={editor} className="wysiwyg-editor-content" />
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
    </div>
  )
}
