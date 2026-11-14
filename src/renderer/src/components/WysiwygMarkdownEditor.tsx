import { useEffect, useLayoutEffect, useRef } from 'react'
import type { Editor } from '@tiptap/core'
import { EditorContent, useEditor, useEditorState } from '@tiptap/react'
import {
  createWysiwygExtensions,
  normalizeMarkdownForTiptap,
  serializeTiptapEditorToMarkdown
} from '../editor/wysiwygMarkdown'

function tableHasHeaderRow(editor: Editor): boolean {
  const { $from } = editor.state.selection
  for (let depth = $from.depth; depth >= 0; depth -= 1) {
    const node = $from.node(depth)
    if (node.type.name === 'table' && node.childCount > 0) {
      const firstRow = node.child(0)
      for (let i = 0; i < firstRow.childCount; i += 1) {
        if (firstRow.child(i).type.name === 'tableHeader') {
          return true
        }
      }
      return false
    }
  }
  return true
}

interface WysiwygMarkdownEditorProps {
  content: string
  scrollTop: number
  onChangeContent: (nextContent: string) => void
  onScrollTopChange?: (scrollTop: number) => void
  testId?: string
}

export function WysiwygMarkdownEditor({
  content,
  scrollTop,
  onChangeContent,
  onScrollTopChange,
  testId = 'document-editor'
}: WysiwygMarkdownEditorProps) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const isProgrammaticSyncRef = useRef(false)
  const lastEmittedMarkdownRef = useRef(content)
  const onChangeContentRef = useRef(onChangeContent)
  onChangeContentRef.current = onChangeContent

  const editor = useEditor(
    {
      immediatelyRender: true,
      extensions: createWysiwygExtensions(),
      content: normalizeMarkdownForTiptap(content),
      contentType: 'markdown',
      editorProps: {
        attributes: {
          class: 'wysiwyg-prosemirror',
          'data-testid': testId,
          'aria-label': '위지윅 문서 에디터'
        }
      },
      onUpdate: ({ editor: instance, transaction }) => {
        if (isProgrammaticSyncRef.current || !transaction.docChanged) {
          return
        }
        const serialized = serializeTiptapEditorToMarkdown(instance)
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
      editor.commands.setContent(normalizeMarkdownForTiptap(content), {
        emitUpdate: false,
        contentType: 'markdown'
      })
      lastEmittedMarkdownRef.current = content
    } finally {
      isProgrammaticSyncRef.current = false
    }
  }, [content, editor])

  useLayoutEffect(() => {
    const el = scrollContainerRef.current
    if (!el) return
    if (Math.abs(el.scrollTop - scrollTop) > 1) {
      el.scrollTop = scrollTop
    }
  }, [scrollTop])

  const toolbarState = useEditorState({
    editor,
    selector: ({ editor: instance }) => ({
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
        <button
          type="button"
          className={`toolbar-btn${toolbarState.h1 ? ' is-active' : ''}`}
          aria-pressed={toolbarState.h1}
          onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
        >
          H1
        </button>
        <button
          type="button"
          className={`toolbar-btn${toolbarState.h2 ? ' is-active' : ''}`}
          aria-pressed={toolbarState.h2}
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        >
          H2
        </button>
        <button
          type="button"
          className={`toolbar-btn${toolbarState.h3 ? ' is-active' : ''}`}
          aria-pressed={toolbarState.h3}
          onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
        >
          H3
        </button>
        <span className="toolbar-divider" aria-hidden="true" />
        <button
          type="button"
          className={`toolbar-btn${toolbarState.bold ? ' is-active' : ''}`}
          aria-pressed={toolbarState.bold}
          onClick={() => editor.chain().focus().toggleBold().run()}
        >
          굵게
        </button>
        <button
          type="button"
          className={`toolbar-btn${toolbarState.italic ? ' is-active' : ''}`}
          aria-pressed={toolbarState.italic}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        >
          기울임
        </button>
        <button
          type="button"
          className={`toolbar-btn${toolbarState.code ? ' is-active' : ''}`}
          aria-pressed={toolbarState.code}
          onClick={() => editor.chain().focus().toggleCode().run()}
        >
          인라인 코드
        </button>
        <button
          type="button"
          className={`toolbar-btn${toolbarState.codeBlock ? ' is-active' : ''}`}
          aria-pressed={toolbarState.codeBlock}
          onClick={() => editor.chain().focus().toggleCodeBlock().run()}
        >
          코드 블록
        </button>
        <span className="toolbar-divider" aria-hidden="true" />
        <button
          type="button"
          className={`toolbar-btn${toolbarState.bulletList ? ' is-active' : ''}`}
          aria-pressed={toolbarState.bulletList}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
        >
          글머리 목록
        </button>
        <button
          type="button"
          className={`toolbar-btn${toolbarState.orderedList ? ' is-active' : ''}`}
          aria-pressed={toolbarState.orderedList}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
        >
          번호 목록
        </button>
        <button
          type="button"
          className={`toolbar-btn${toolbarState.taskList ? ' is-active' : ''}`}
          aria-pressed={toolbarState.taskList}
          onClick={() => editor.chain().focus().toggleTaskList().run()}
        >
          체크리스트
        </button>
        <button
          type="button"
          className={`toolbar-btn${toolbarState.blockquote ? ' is-active' : ''}`}
          aria-pressed={toolbarState.blockquote}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
        >
          인용
        </button>
        <span className="toolbar-divider" aria-hidden="true" />
        <button
          type="button"
          className="toolbar-btn"
          onClick={() =>
            editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
          }
        >
          표 삽입
        </button>
      </div>

      {toolbarState.isTable && (
        <div
          className="editor-table-toolbar"
          role="toolbar"
          aria-label="표 편집 툴바"
        >
          <span className="table-toolbar-label">표 편집</span>
          <button
            type="button"
            className="toolbar-btn"
            onClick={() => editor.chain().focus().addRowBefore().run()}
          >
            행 위 추가
          </button>
          <button
            type="button"
            className="toolbar-btn"
            onClick={() => editor.chain().focus().addRowAfter().run()}
          >
            행 아래 추가
          </button>
          <button
            type="button"
            className="toolbar-btn"
            onClick={() => editor.chain().focus().addColumnBefore().run()}
          >
            열 좌 추가
          </button>
          <button
            type="button"
            className="toolbar-btn"
            onClick={() => editor.chain().focus().addColumnAfter().run()}
          >
            열 우 추가
          </button>
          <button
            type="button"
            className="toolbar-btn"
            onClick={() => {
              if (!editor.chain().focus().deleteRow().run()) return
              // Keep GFM tables valid by promoting the new top row if the header row was removed.
              if (editor.isActive('table') && !tableHasHeaderRow(editor)) {
                editor.chain().focus().toggleHeaderRow().run()
              }
            }}
          >
            현재 행 삭제
          </button>
          <button
            type="button"
            className="toolbar-btn"
            onClick={() => editor.chain().focus().deleteColumn().run()}
          >
            현재 열 삭제
          </button>
          <button
            type="button"
            className="toolbar-btn is-danger"
            onClick={() => editor.chain().focus().deleteTable().run()}
          >
            표 삭제
          </button>
        </div>
      )}

      <div
        ref={scrollContainerRef}
        className="wysiwyg-scroll-container"
        onScroll={(event) => onScrollTopChange?.(event.currentTarget.scrollTop)}
        onClick={(event) => {
          const target = event.target as HTMLElement | null
          if (target?.closest('a')) {
            event.preventDefault()
          }
        }}
      >
        <EditorContent editor={editor} className="wysiwyg-editor-content" />
      </div>
    </div>
  )
}
