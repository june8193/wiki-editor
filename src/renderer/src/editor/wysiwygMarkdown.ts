import {
  AnyExtension,
  createNodeFromContent,
  Editor,
  Extension,
  mergeAttributes,
  Node as TiptapNode
} from '@tiptap/core'
import CodeBlock from '@tiptap/extension-code-block'
import Image, { type ImageOptions } from '@tiptap/extension-image'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import { Markdown } from '@tiptap/markdown'
import { resolveImageDisplaySrc } from '@shared/assets'
import { Fragment, type Mark, type Schema, Slice } from '@tiptap/pm/model'
import {
  type EditorState,
  Plugin,
  PluginKey,
  TextSelection,
  type Transaction
} from '@tiptap/pm/state'
import { deleteRow as pmDeleteRow, isInTable } from '@tiptap/pm/tables'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
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
import {
  isSafeMarkdownImageUrl,
  isSafeMarkdownUrl,
  WYSIWYG_SANITIZE_SCHEMA
} from './markdownSecurity'
import {
  detectSlashQuery,
  expandSlashTemplate,
  isDefaultTocCommand,
  resolveSlashCommandSnippet,
  type SlashQueryMatch
} from './SlashCommandEngine'
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
  getDocumentPath?: () => string | undefined
}

export const headingNumberingPluginKey = new PluginKey<boolean>('headingNumbering')
export const slashInsertPluginKey = new PluginKey<boolean>('wysiwygSlashInsert')

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
  .use(rehypeSanitize, WYSIWYG_SANITIZE_SCHEMA)
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
const IMAGE_MARKDOWN_SRC_ATTR = 'data-markdown-src'

interface WikiAssetImageOptions extends ImageOptions {
  getDocumentPath?: () => string | undefined
}

function formatMarkdownImageDestination(src: string): string {
  if (/[\s<>]/.test(src)) {
    return `<${src.replace(/[<>]/g, encodeURIComponent)}>`
  }
  let balance = 0
  for (const ch of src) {
    if (ch === '(') {
      balance += 1
    } else if (ch === ')') {
      balance -= 1
      if (balance < 0) {
        return `<${src}>`
      }
    }
  }
  return balance === 0 ? src : `<${src}>`
}

function parseSafeImageAttrs(
  dom: unknown,
  attrName: typeof IMAGE_MARKDOWN_SRC_ATTR | 'src'
): { src: string; alt: string | null; title: string | null } | false {
  if (!(dom instanceof HTMLElement)) {
    return false
  }
  const rawSrc = dom.getAttribute(attrName)?.trim() ?? ''
  if (!rawSrc || !isSafeMarkdownImageUrl(rawSrc)) {
    return false
  }
  return {
    src: rawSrc,
    alt: dom.getAttribute('alt') ?? null,
    title: dom.getAttribute('title') ?? null
  }
}

export function syncWysiwygImageDisplaySources(
  editor: Editor | null,
  documentPath?: string
): void {
  if (!editor || editor.isDestroyed) {
    return
  }
  for (const img of editor.view.dom.querySelectorAll(`img[${IMAGE_MARKDOWN_SRC_ATTR}]`)) {
    const rawSrc = img.getAttribute(IMAGE_MARKDOWN_SRC_ATTR) ?? ''
    const nextSrc = resolveImageDisplaySrc(rawSrc, documentPath)
    if (nextSrc && img.getAttribute('src') !== nextSrc) {
      img.setAttribute('src', nextSrc)
    }
  }
}

const WikiAssetImage = Image.extend<WikiAssetImageOptions>({
  addOptions() {
    return {
      ...this.parent?.(),
      inline: true,
      allowBase64: false,
      resize: false,
      HTMLAttributes: {},
      getDocumentPath: undefined
    }
  },

  parseHTML() {
    return [
      {
        tag: `img[${IMAGE_MARKDOWN_SRC_ATTR}]`,
        getAttrs: (dom) => parseSafeImageAttrs(dom, IMAGE_MARKDOWN_SRC_ATTR)
      },
      {
        tag: `img[src]:not([${IMAGE_MARKDOWN_SRC_ATTR}]):not([src^="data:"])`,
        getAttrs: (dom) => parseSafeImageAttrs(dom, 'src')
      }
    ]
  },

  renderHTML({ node, HTMLAttributes }) {
    const rawSrc = typeof node.attrs.src === 'string' ? node.attrs.src : ''
    const displaySrc = rawSrc
      ? resolveImageDisplaySrc(rawSrc, this.options.getDocumentPath?.())
      : ''
    const merged = mergeAttributes(this.options.HTMLAttributes, HTMLAttributes)
    delete merged.src
    delete merged[IMAGE_MARKDOWN_SRC_ATTR]
    if (displaySrc) {
      merged.src = displaySrc
    }
    if (rawSrc && isSafeMarkdownImageUrl(rawSrc)) {
      merged[IMAGE_MARKDOWN_SRC_ATTR] = rawSrc
    }
    return ['img', merged]
  },

  parseMarkdown: (token, helpers) => {
    const href = typeof token.href === 'string' ? token.href : ''
    if (!href || !isSafeMarkdownImageUrl(href)) {
      return []
    }
    return helpers.createNode('image', {
      src: href,
      alt: token.text || '',
      title: token.title || null
    })
  },

  renderMarkdown: (node) => {
    const src = typeof node.attrs?.src === 'string' ? node.attrs.src : ''
    if (!src || !isSafeMarkdownImageUrl(src)) {
      return ''
    }
    const alt = typeof node.attrs?.alt === 'string' ? node.attrs.alt : ''
    const title = typeof node.attrs?.title === 'string' ? node.attrs.title : ''
    const destination = formatMarkdownImageDestination(src)
    return title
      ? `![${alt}](${destination} "${title.replace(/"/g, '\\"')}")`
      : `![${alt}](${destination})`
  }
})

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
    WikiAssetImage.configure({
      getDocumentPath: options.getDocumentPath
    }),
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

  if (isDefaultTocCommand(command)) {
    markdownToInsert = resolveSlashCommandSnippet(editor.getMarkdown(), command, context).text
  } else {
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
