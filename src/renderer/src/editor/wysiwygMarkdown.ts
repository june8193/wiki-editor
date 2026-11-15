import { AnyExtension, Editor, Extension, Node as TiptapNode } from '@tiptap/core'
import CodeBlock from '@tiptap/extension-code-block'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import { Markdown } from '@tiptap/markdown'
import type { Schema } from '@tiptap/pm/model'
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state'
import { deleteRow as pmDeleteRow, isInTable } from '@tiptap/pm/tables'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { ReactNodeViewRenderer } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import rehypeParse from 'rehype-parse'
import rehypeSanitize from 'rehype-sanitize'
import rehypeStringify from 'rehype-stringify'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { MermaidCodeBlockNodeView } from '../components/MermaidCodeBlockNodeView'
import { isSafeMarkdownUrl, MARKDOWN_SANITIZE_SCHEMA } from './markdownSecurity'
import {
  createHeadingNumberTracker,
  hasHeadingNumberPrefix,
  LEADING_HEADING_NUMBER_RE,
  stripHeadingNumberPrefix
} from './MarkdownTocEngine'

const TOC_MARKER_COMMENT_RE = /^[ \t]*<!--\s*(\/?toc)\s*-->[ \t]*$/i
const TOC_MARKER_LINE_RE = /^[ \t]*<!--\s*(\/?toc)\s*-->[ \t]*(?:\r?\n|$)/i
const TOC_MARKER_SEARCH_RE = /<!--\s*\/?toc\s*-->/i

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

export interface WysiwygExtensionOptions {
  showHeadingNumbers?: boolean
}

export const headingNumberingPluginKey = new PluginKey<boolean>('headingNumbering')

const HeadingNumberingExtension = Extension.create<{ showHeadingNumbers: boolean }>({
  name: 'headingNumbering',
  addOptions() {
    return {
      showHeadingNumbers: false
    }
  },
  addProseMirrorPlugins() {
    const initialEnabled = this.options.showHeadingNumbers
    return [
      new Plugin<boolean>({
        key: headingNumberingPluginKey,
        state: {
          init: () => initialEnabled,
          apply: (tr, prev) => {
            const meta = tr.getMeta(headingNumberingPluginKey)
            return typeof meta === 'boolean' ? meta : prev
          }
        },
        props: {
          decorations: (state) => {
            const enabled = headingNumberingPluginKey.getState(state)
            if (!enabled) {
              return DecorationSet.empty
            }

            const tracker = createHeadingNumberTracker()
            const decorations: Decoration[] = []

            state.doc.descendants((node, pos) => {
              if (node.type.name === 'heading') {
                const level = Number(node.attrs.level ?? 1)
                const { number } = tracker.next(level)
                const text = node.textContent
                if (stripHeadingNumberPrefix(text).trim().length > 0) {
                  if (hasHeadingNumberPrefix(text)) {
                    const firstChild = node.firstChild
                    const explicitMatch =
                      firstChild && firstChild.isText && firstChild.text
                        ? LEADING_HEADING_NUMBER_RE.exec(firstChild.text)
                        : null
                    if (explicitMatch) {
                      decorations.push(
                        Decoration.inline(pos + 1, pos + 1 + explicitMatch[0].length, {
                          class: 'heading-number-suppressed',
                          'aria-hidden': 'true'
                        })
                      )
                    }
                  }
                  decorations.push(
                    Decoration.widget(
                      pos + 1,
                      () => {
                        const span = document.createElement('span')
                        span.className = 'heading-number'
                        span.setAttribute('aria-hidden', 'true')
                        span.textContent = `${number} `
                        return span
                      },
                      {
                        side: -1,
                        key: `heading-num-${pos}-${number}`
                      }
                    )
                  )
                }
                return false
              }
              return node.type.name !== 'codeBlock'
            })

            return DecorationSet.create(state.doc, decorations)
          }
        }
      })
    ]
  }
})

const MermaidAwareCodeBlock = CodeBlock.extend({
  addNodeView() {
    return ReactNodeViewRenderer(MermaidCodeBlockNodeView)
  }
})

/**
 * Preserves `<!-- toc -->` and `<!-- /toc -->` markers cleanly across WYSIWYG roundtrips
 * without weakening HTML comment/tag XSS sanitization for any other HTML input.
 */
const TocMarker = TiptapNode.create({
  name: 'tocMarker',
  group: 'block',
  atom: true,
  selectable: false,
  draggable: false,

  addAttributes() {
    return {
      kind: {
        default: 'start'
      }
    }
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-toc-marker]',
        getAttrs: (el) => {
          const raw = el instanceof Element ? el.getAttribute('data-toc-marker') : null
          return { kind: raw === 'end' ? 'end' : 'start' }
        }
      }
    ]
  },

  renderHTML({ node }) {
    return [
      'div',
      {
        'data-toc-marker': node.attrs.kind === 'end' ? 'end' : 'start',
        'aria-hidden': 'true',
        class: 'wysiwyg-toc-marker'
      }
    ]
  },

  markdownTokenizer: {
    name: 'tocMarker',
    level: 'block',
    start: (src) => {
      const match = TOC_MARKER_SEARCH_RE.exec(src)
      return match ? match.index : -1
    },
    tokenize: (src) => {
      const match = TOC_MARKER_LINE_RE.exec(src)
      if (!match) return undefined
      return {
        type: 'tocMarker',
        raw: match[0],
        kind: match[1].toLowerCase() === '/toc' ? 'end' : 'start'
      }
    }
  },

  parseMarkdown(token, helpers) {
    return helpers.createNode('tocMarker', {
      kind: token.kind === 'end' ? 'end' : 'start'
    })
  },

  renderMarkdown(node) {
    return node.attrs?.kind === 'end' ? '<!-- /toc -->' : '<!-- toc -->'
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
        if (TOC_MARKER_COMMENT_RE.test(rawHtml)) {
          return
        }
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
 * dynamic heading numbering decorations, and roundtrip serialization.
 */
export function createWysiwygExtensions(options: WysiwygExtensionOptions = {}): AnyExtension[] {
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
    TocMarker,
    HeadingNumberingExtension.configure({
      showHeadingNumbers: options.showHeadingNumbers ?? false
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
