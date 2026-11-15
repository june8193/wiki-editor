import { AnyExtension, createNodeFromContent, Editor } from '@tiptap/core'
import CodeBlock from '@tiptap/extension-code-block'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import { Markdown } from '@tiptap/markdown'
import { Fragment, type Mark, type Schema, Slice } from '@tiptap/pm/model'
import {
  type EditorState,
  PluginKey,
  TextSelection,
  type Transaction
} from '@tiptap/pm/state'
import { deleteRow as pmDeleteRow, isInTable } from '@tiptap/pm/tables'
import { ReactNodeViewRenderer } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import type { CustomCommandConfig } from '@shared/config'
import rehypeParse from 'rehype-parse'
import rehypeSanitize from 'rehype-sanitize'
import rehypeStringify from 'rehype-stringify'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { MermaidCodeBlockNodeView } from '../components/MermaidCodeBlockNodeView'
import { isSafeMarkdownUrl, MARKDOWN_SANITIZE_SCHEMA } from './markdownSecurity'
import {
  detectSlashQuery,
  expandSlashTemplate,
  type SlashQueryMatch
} from './SlashCommandEngine'

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

export const slashInsertPluginKey = new PluginKey<boolean>('wysiwygSlashInsert')

const MermaidAwareCodeBlock = CodeBlock.extend({
  addNodeView() {
    return ReactNodeViewRenderer(MermaidCodeBlockNodeView)
  }
})

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
        const rawHtml = normalized.slice(start, end)
        patches.push({
          start,
          end,
          replacement: sanitizeHtmlWithRehype(rawHtml)
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
 * Returns the standard TipTap v3 extension stack for GFM WYSIWYG editing, Mermaid NodeView,
 * and roundtrip serialization.
 */
export function createWysiwygExtensions(): AnyExtension[] {
  return [
    StarterKit.configure({
      codeBlock: false,
      link: {
        openOnClick: false,
        protocols: [],
        isAllowedUri: (url) => isSafeMarkdownUrl(url)
      }
    }),
    MermaidAwareCodeBlock,
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

/**
 * Detects an active `/query` token before the ProseMirror caret outside code blocks, inline code marks, and URLs.
 */
export function detectProseMirrorSlashQuery(state: EditorState): SlashQueryMatch | null {
  const { $from, empty } = state.selection
  if (!empty || !$from.parent.isTextblock || $from.parent.type.name === 'codeBlock') {
    return null
  }
  if ($from.marks().some((mark) => mark.type.name === 'code')) {
    return null
  }

  const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, '\uFFFC')
  const localMatch = detectSlashQuery(textBefore, textBefore.length, { ignoreCodeFences: false })
  if (!localMatch) {
    return null
  }

  const tokenLength = localMatch.rangeTo - localMatch.rangeFrom
  const nodeBefore = $from.nodeBefore
  if (!nodeBefore || !nodeBefore.isText || (nodeBefore.text?.length ?? 0) < tokenLength) {
    return null
  }

  return {
    query: localMatch.query,
    rangeFrom: $from.pos - tokenLength,
    rangeTo: $from.pos
  }
}

function pickCursorSentinel(expandedText: string, docText: string): string {
  let index = 0
  while (expandedText.includes(`WIKICURSOR${index}`) || docText.includes(`WIKICURSOR${index}`)) {
    index += 1
  }
  return `WIKICURSOR${index}`
}

function buildWysiwygCommandFragment(
  editor: Editor,
  command: CustomCommandConfig,
  context?: { title?: string; date?: string; now?: Date }
): { fragment: Fragment; sentinel: string | null } {
  let markdownToInsert: string
  let sentinel: string | null = null

  const expanded = expandSlashTemplate(command.template, context)
  if (expanded.hasCursorPlaceholder) {
    const existingDocText = editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n')
    sentinel = pickCursorSentinel(expanded.text, existingDocText)
    markdownToInsert =
      expanded.text.slice(0, expanded.cursorOffset) +
      sentinel +
      expanded.text.slice(expanded.cursorOffset)
  } else {
    markdownToInsert = expanded.text
  }

  const prepared = prepareMarkdownForTiptap(markdownToInsert)
  const parsedDoc = editor.markdown?.parse(prepared)
  const jsonBlocks = Array.isArray(parsedDoc?.content) ? parsedDoc.content : []
  const created =
    jsonBlocks.length > 0
      ? createNodeFromContent(jsonBlocks, editor.state.schema, { slice: false })
      : Fragment.empty
  const fragment = created instanceof Fragment ? created : Fragment.from(created)
  return { fragment, sentinel }
}

function applyWysiwygFragmentReplacement(
  tr: Transaction,
  range: Pick<SlashQueryMatch, 'rangeFrom' | 'rangeTo'>,
  fragment: Fragment
): { searchFrom: number; fallbackEndPos: number } {
  const { rangeFrom, rangeTo } = range
  const $from = tr.doc.resolve(rangeFrom)
  const isStandaloneTopParagraph =
    $from.depth === 1 &&
    $from.parent.type.name === 'paragraph' &&
    rangeTo <= $from.end(1) &&
    $from.parent.textBetween(0, rangeFrom - $from.start(1), undefined, '\uFFFC').trim() === '' &&
    $from.parent.textBetween(rangeTo - $from.start(1), $from.parent.content.size, undefined, '\uFFFC').trim() ===
      ''

  if (isStandaloneTopParagraph) {
    const replaceFrom = $from.before(1)
    const replaceTo = $from.after(1)
    const replacement =
      fragment.childCount === 0
        ? Fragment.from(tr.doc.type.schema.nodes.paragraph.create())
        : fragment
    tr.replaceWith(replaceFrom, replaceTo, replacement)
    return { searchFrom: replaceFrom, fallbackEndPos: replaceFrom + replacement.size }
  }

  if (fragment.childCount === 1 && fragment.firstChild?.type.name === 'paragraph') {
    const inlineContent = fragment.firstChild.content
    tr.replaceWith(rangeFrom, rangeTo, inlineContent)
    return { searchFrom: rangeFrom, fallbackEndPos: rangeFrom + inlineContent.size }
  }

  if (fragment.childCount === 0) {
    tr.delete(rangeFrom, rangeTo)
    return { searchFrom: rangeFrom, fallbackEndPos: rangeFrom }
  }

  tr.replaceRange(rangeFrom, rangeTo, new Slice(fragment, 0, 0))
  return {
    searchFrom: Math.max(0, rangeFrom - 1),
    fallbackEndPos: Math.min(tr.doc.content.size, rangeFrom + fragment.size + 2)
  }
}

function consumeCursorSentinel(
  tr: Transaction,
  sentinel: string,
  searchFrom: number,
  searchTo: number
): { pos: number; marks: readonly Mark[] } | null {
  let foundFrom: number | null = null
  let foundTo: number | null = null
  let marks: readonly Mark[] = []
  const clampedFrom = Math.max(0, searchFrom)
  const clampedTo = Math.min(tr.doc.content.size, Math.max(clampedFrom, searchTo))

  tr.doc.nodesBetween(clampedFrom, clampedTo, (node, pos) => {
    if (foundFrom !== null) return false
    if (node.isText && node.text) {
      const idx = node.text.indexOf(sentinel)
      if (idx !== -1) {
        foundFrom = pos + idx
        foundTo = foundFrom + sentinel.length
        marks = node.marks
        return false
      }
    }
    return true
  })

  if (foundFrom === null || foundTo === null) {
    return null
  }
  tr.delete(foundFrom, foundTo)
  return { pos: foundFrom, marks }
}

/**
 * Replaces the active `/query` ProseMirror range with sanitized Markdown nodes in a single
 * transaction and moves the cursor to the expanded `{{cursor}}` position.
 */
export function insertWysiwygMarkdownWithCursor(
  editor: Editor,
  command: CustomCommandConfig,
  range: Pick<SlashQueryMatch, 'rangeFrom' | 'rangeTo'>,
  context?: { title?: string; date?: string; now?: Date }
): boolean {
  const { state } = editor
  if (range.rangeFrom < 0 || range.rangeTo > state.doc.content.size || range.rangeFrom > range.rangeTo) {
    return false
  }

  const { fragment, sentinel } = buildWysiwygCommandFragment(editor, command, context)
  const tr = state.tr
  const { searchFrom, fallbackEndPos } = applyWysiwygFragmentReplacement(tr, range, fragment)
  const consumed = sentinel
    ? consumeCursorSentinel(tr, sentinel, searchFrom, fallbackEndPos + 2)
    : null

  const targetPos = Math.max(0, Math.min(consumed?.pos ?? fallbackEndPos, tr.doc.content.size))
  tr.setSelection(TextSelection.near(tr.doc.resolve(targetPos), consumed ? 1 : -1))
  if (consumed && consumed.marks.length > 0) {
    tr.setStoredMarks(consumed.marks)
  }
  tr.setMeta(slashInsertPluginKey, true)

  editor.view.dispatch(tr)
  editor.view.focus()
  return true
}

export interface WysiwygHeadingCandidate {
  pos: number
  level: number
  text: string
  hasMedia: boolean
}

/**
 * Extracts top-level ProseMirror heading candidates (preserving inline image `alt` text and
 * excluding `codeBlock` / `blockquote` subtrees) for alignment with Document Outline ATX headings.
 */
export function extractWysiwygHeadingCandidates(
  doc: Editor['state']['doc']
): WysiwygHeadingCandidate[] {
  const candidates: WysiwygHeadingCandidate[] = []
  doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      let text = ''
      let hasMedia = false
      node.descendants((child) => {
        if (child.isText) {
          text += child.text ?? ''
          return false
        }
        if (child.type.name === 'image') {
          hasMedia = true
          text += typeof child.attrs.alt === 'string' ? child.attrs.alt : ''
          return false
        }
        return true
      })
      candidates.push({
        pos,
        level: Number(node.attrs.level ?? 1),
        text,
        hasMedia
      })
      return false
    }
    return node.type.name !== 'codeBlock' && node.type.name !== 'blockquote'
  })
  return candidates
}
