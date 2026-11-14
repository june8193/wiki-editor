import { AnyExtension, Editor } from '@tiptap/core'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import { Markdown } from '@tiptap/markdown'
import StarterKit from '@tiptap/starter-kit'

/**
 * Ensures TipTap v3 markdown parser handles trailing task lists and empty documents consistently.
 */
export function normalizeMarkdownForTiptap(markdown: string): string {
  if (!markdown) return ''
  return markdown.endsWith('\n') ? markdown : `${markdown}\n`
}

/**
 * Serializes a TipTap editor document back to clean GFM Markdown.
 */
export function serializeTiptapEditorToMarkdown(editor: Editor): string {
  return editor.getMarkdown()
}

/**
 * Returns the standard TipTap v3 extension stack for GFM WYSIWYG editing and roundtrip serialization.
 */
export function createWysiwygExtensions(): AnyExtension[] {
  return [
    StarterKit.configure({
      link: {
        openOnClick: false
      }
    }),
    Markdown.configure({
      markedOptions: {
        gfm: true,
        breaks: false
      }
    }),
    TableKit.configure({
      table: {
        resizable: false
      }
    }),
    TaskList,
    TaskItem.configure({
      nested: true
    })
  ]
}
