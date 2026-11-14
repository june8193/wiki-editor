import { AnyExtension, Editor } from '@tiptap/core'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import { Markdown } from '@tiptap/markdown'
import type { Schema } from '@tiptap/pm/model'
import type { Transaction } from '@tiptap/pm/state'
import { deleteRow as pmDeleteRow, isInTable } from '@tiptap/pm/tables'
import StarterKit from '@tiptap/starter-kit'
import rehypeParse from 'rehype-parse'
import rehypeSanitize from 'rehype-sanitize'
import rehypeStringify from 'rehype-stringify'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { isSafeMarkdownUrl, MARKDOWN_SANITIZE_SCHEMA } from './markdownSecurity'

interface MdastPositionNode {
  type?: string
  url?: string
  value?: string
  children?: MdastPositionNode[]
  position?: {
    start?: { offset?: number }
    end?: { offset?: number }
  }
}

const markdownAstParser = unified().use(remarkParse).use(remarkGfm)
const htmlSanitizer = unified()
  .use(rehypeParse, { fragment: true })
  .use(rehypeSanitize, MARKDOWN_SANITIZE_SCHEMA)
  .use(rehypeStringify)

/**
 * Sanitizes untrusted HTML fragments with `rehype-sanitize` using the shared Preview schema.
 */
export function sanitizeHtmlWithRehype(html: string): string {
  if (!html) return ''
  return String(htmlSanitizer.processSync(html))
}

/**
 * Ensures TipTap v3 markdown parser handles trailing task lists and empty documents consistently.
 */
export function normalizeMarkdownForTiptap(markdown: string): string {
  if (!markdown) return ''
  return markdown.endsWith('\n') ? markdown : `${markdown}\n`
}

function extractPlainText(node: MdastPositionNode): string {
  if (typeof node.value === 'string' && node.type !== 'html') {
    return node.value
  }
  if (!node.children) {
    return ''
  }
  return node.children.map(extractPlainText).join('')
}

/**
 * Normalizes trailing newlines and strips unsafe HTML/URI payloads via `rehype-sanitize` before TipTap parses Markdown.
 */
export function prepareMarkdownForTiptap(markdown: string): string {
  const normalized = normalizeMarkdownForTiptap(markdown)
  if (!normalized) return ''

  const tree = markdownAstParser.parse(normalized) as unknown as MdastPositionNode
  const patches: Array<{ start: number; end: number; replacement: string }> = []

  const visit = (node: MdastPositionNode): void => {
    const start = node.position?.start?.offset
    const end = node.position?.end?.offset
    if (typeof start === 'number' && typeof end === 'number') {
      if (node.type === 'html') {
        patches.push({
          start,
          end,
          replacement: sanitizeHtmlWithRehype(normalized.slice(start, end))
        })
        return
      }
      if (node.type === 'link' && typeof node.url === 'string' && !isSafeMarkdownUrl(node.url)) {
        patches.push({
          start,
          end,
          replacement: extractPlainText(node)
        })
        return
      }
      if (
        (node.type === 'image' || node.type === 'definition') &&
        typeof node.url === 'string' &&
        !isSafeMarkdownUrl(node.url)
      ) {
        patches.push({
          start,
          end,
          replacement: ''
        })
        return
      }
    }
    if (node.children) {
      for (const child of node.children) {
        visit(child)
      }
    }
  }

  visit(tree)
  if (patches.length === 0) {
    return normalized
  }

  patches.sort((a, b) => b.start - a.start)
  let sanitized = normalized
  let lastAppliedStart = Number.POSITIVE_INFINITY
  for (const patch of patches) {
    if (patch.end > lastAppliedStart) continue
    sanitized = sanitized.slice(0, patch.start) + patch.replacement + sanitized.slice(patch.end)
    lastAppliedStart = patch.start
  }
  return sanitized
}

function promoteFirstRowToHeaderIfMissing(tr: Transaction, schema: Schema): void {
  const tableHeaderType = schema.nodes.tableHeader
  const tableCellType = schema.nodes.tableCell
  if (!tableHeaderType || !tableCellType) return

  const { $from } = tr.selection
  for (let depth = $from.depth; depth >= 0; depth -= 1) {
    const node = $from.node(depth)
    if (node.type.name === 'table' && node.childCount > 0) {
      const tableStart = $from.start(depth)
      const firstRow = node.child(0)
      for (let i = 0; i < firstRow.childCount; i += 1) {
        if (firstRow.child(i).type === tableHeaderType) {
          return
        }
      }

      let cellPos = tableStart + 1
      for (let i = 0; i < firstRow.childCount; i += 1) {
        const cell = firstRow.child(i)
        if (cell.type === tableCellType) {
          tr.setNodeMarkup(cellPos, tableHeaderType, cell.attrs)
        }
        cellPos += cell.nodeSize
      }
      return
    }
  }
}

/**
 * Inserts a body row above the current body row, or right below the header when cursor is in row 0.
 * Preserves GFM Markdown's single-header-row invariant.
 */
export function addTableRowBeforeSafely(editor: Editor): boolean {
  if (editor.isActive('tableHeader')) {
    return editor.chain().focus().addRowAfter().run()
  }
  return editor.chain().focus().addRowBefore().run()
}

/**
 * Deletes the current table row and promotes the new top row to header in one ProseMirror transaction.
 */
export function deleteTableRowPreservingHeader(editor: Editor): boolean {
  const { state } = editor
  if (!isInTable(state)) return false

  return pmDeleteRow(state, (tr) => {
    promoteFirstRowToHeaderIfMissing(tr, state.schema)
    editor.view.dispatch(tr)
    editor.view.focus()
  })
}

/**
 * Returns the standard TipTap v3 extension stack for GFM WYSIWYG editing and roundtrip serialization.
 */
export function createWysiwygExtensions(): AnyExtension[] {
  return [
    StarterKit.configure({
      link: {
        openOnClick: false,
        protocols: [],
        isAllowedUri: (url) => isSafeMarkdownUrl(url)
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
