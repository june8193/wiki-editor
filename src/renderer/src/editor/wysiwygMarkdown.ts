import { AnyExtension, Editor, Extension, InputRule, mergeAttributes } from '@tiptap/core'
import Code from '@tiptap/extension-code'
import CodeBlock from '@tiptap/extension-code-block'
import Image, { type ImageOptions } from '@tiptap/extension-image'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import Link from '@tiptap/extension-link'
import { TableKit } from '@tiptap/extension-table'
import { Markdown } from '@tiptap/markdown'
import { resolveImageDisplaySrc, type WorkspaceImageIngestResult } from '@shared/assets'
import { isSafeImageUri } from '@shared/urlSecurity'
import { type Mark, type Schema, Slice } from '@tiptap/pm/model'
import {
  type EditorState,
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
  type Transaction
} from '@tiptap/pm/state'
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
import { CodeBlockNodeView } from '../components/CodeBlockNodeView'
import { getCodeBlockHighlightSpans, isMermaidLanguage } from './codeBlockHighlight'
import { WysiwygSearchHighlight } from './wysiwygSearchHighlight'
import {
  detectLinkQueryFromSegments,
  getLinkCandidateAutoLabel,
  getLinkCandidateHref,
  type LinkCandidate,
  type InlineLinkSegment,
  type InlineLinkSegmentMatch
} from './LinkAutocompleteEngine'
import { isSafeMarkdownUrl, WYSIWYG_SANITIZE_SCHEMA } from './markdownSecurity'

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
  getDocumentPath?: () => string | undefined
}

export const linkInsertPluginKey = new PluginKey<boolean>('wysiwygLinkInsert')
const codeBlockHighlightPluginKey = new PluginKey<DecorationSet>('wysiwygCodeBlockHighlight')
const wysiwygExternalTextPastePluginKey = new PluginKey('wysiwygExternalTextPaste')

function buildCodeBlockHighlightDecorations(doc: EditorState['doc']): DecorationSet {
  const decorations: Decoration[] = []

  doc.descendants((node, pos) => {
    if (node.type.name !== 'codeBlock') {
      return true
    }

    const language = typeof node.attrs.language === 'string' ? node.attrs.language : ''
    if (!language || isMermaidLanguage(language)) {
      return false
    }

    const code = node.textContent
    const spans = getCodeBlockHighlightSpans(code, language)
    const contentStart = pos + 1
    for (const span of spans) {
      if (span.from < 0 || span.to <= span.from || span.to > code.length) {
        continue
      }
      decorations.push(
        Decoration.inline(contentStart + span.from, contentStart + span.to, {
          class: span.className
        })
      )
    }

    return false
  })

  return DecorationSet.create(doc, decorations)
}

function sanitizeIndentedMarkdownParagraph(paragraphText: string): string {
  const sanitizedLines = paragraphText.split('\n').map((line) => {
    const [, indent = '', rest = ''] = line.match(/^([ \t]*)(.*)$/) ?? []
    const cleanRest = prepareMarkdownForTiptap(rest).replace(/\n$/, '')
    return { indent, rest: cleanRest }
  })
  const joinedRest = sanitizedLines.map((line) => line.rest).join('\n')
  const cleanJoined = prepareMarkdownForTiptap(joinedRest)
  if (cleanJoined !== normalizeMarkdownForTiptap(joinedRest)) {
    return `${sanitizedLines[0]?.indent ?? ''}${cleanJoined.replace(/\n$/, '')}`
  }
  return sanitizedLines
    .map((line) => (line.rest ? `${line.indent}${line.rest}` : ''))
    .join('\n')
}

const HighlightedCodeBlock = CodeBlock.extend({
  parseMarkdown: (token, helpers) => {
    const raw = typeof token.raw === 'string' ? token.raw : ''
    const trimmedRaw = raw.trimStart()
    const isFenced =
      token.codeBlockStyle !== 'indented' &&
      (trimmedRaw.startsWith('```') || trimmedRaw.startsWith('~~~'))
    if (!isFenced) {
      const source = (raw || token.text || '').replace(/\r\n?/g, '\n').replace(/\n+$/, '')
      if (!source) {
        return []
      }
      return source.split(/\n(?:[^\S\n]*\n)+/).map((paragraphText) => {
        const sanitized = sanitizeIndentedMarkdownParagraph(paragraphText)
        const inlineContent = sanitized
          ? helpers.tokenizeInline
            ? helpers.parseInline(helpers.tokenizeInline(sanitized))
            : [helpers.createTextNode(sanitized)]
          : []
        return helpers.createNode('paragraph', undefined, inlineContent)
      })
    }
    return helpers.createNode(
      'codeBlock',
      { language: token.lang || null },
      token.text ? [helpers.createTextNode(token.text)] : []
    )
  },
  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockNodeView, {
      stopEvent: ({ event }) => {
        const target = event.target
        if (!(target instanceof Element)) {
          return false
        }
        if (event.type.startsWith('drag') || event.type === 'drop') {
          return false
        }
        if (target.closest('.code-block-header, .mermaid-node-header, .mermaid-node-preview')) {
          return true
        }
        return ['INPUT', 'BUTTON', 'SELECT', 'TEXTAREA'].includes(target.tagName)
      }
    })
  },
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: codeBlockHighlightPluginKey,
        state: {
          init: (_config, state) => buildCodeBlockHighlightDecorations(state.doc),
          apply: (tr, oldSet) =>
            tr.docChanged ? buildCodeBlockHighlightDecorations(tr.doc) : oldSet
        },
        props: {
          decorations(state) {
            return codeBlockHighlightPluginKey.getState(state) ?? DecorationSet.empty
          }
        }
      })
    ]
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

function sanitizeMarkdownPass(markdown: string): { next: string; hadHtmlChange: boolean } {
  const tree = markdownAstParser.parse(markdown) as unknown as MdastPositionNode
  const patches: Array<{ start: number; end: number; replacement: string; isHtml?: boolean }> = []

  const visit = (node: MdastPositionNode): void => {
    const start = node.position?.start?.offset
    const end = node.position?.end?.offset
    if (typeof start === 'number' && typeof end === 'number') {
      if (node.type === 'html') {
        const rawHtml = markdown.slice(start, end)
        patches.push({
          start,
          end,
          replacement: sanitizeHtmlWithRehype(rawHtml),
          isHtml: true
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
      if ((node.type === 'image' || node.type === 'definition') && typeof node.url === 'string') {
        const isSafeTarget =
          node.type === 'image'
            ? isSafeImageUri(node.url)
            : isSafeMarkdownUrl(node.url)
        if (!isSafeTarget) {
          patches.push({
            start,
            end,
            replacement: ''
          })
          return
        }
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
    return { next: markdown, hadHtmlChange: false }
  }

  patches.sort((a, b) => b.start - a.start)
  let sanitized = markdown
  let lastAppliedStart = Number.POSITIVE_INFINITY
  let hadHtmlChange = false
  for (const patch of patches) {
    if (patch.end > lastAppliedStart) continue
    const original = sanitized.slice(patch.start, patch.end)
    if (patch.isHtml && patch.replacement !== original) {
      hadHtmlChange = true
    }
    sanitized = sanitized.slice(0, patch.start) + patch.replacement + sanitized.slice(patch.end)
    lastAppliedStart = patch.start
  }
  return { next: sanitized, hadHtmlChange }
}

/**
 * Normalizes trailing newlines and strips unsafe HTML/URI payloads via `rehype-sanitize` before TipTap parses Markdown.
 */
export function prepareMarkdownForTiptap(markdown: string): string {
  const normalized = normalizeMarkdownForTiptap(markdown)
  if (!normalized) return ''

  let current = normalized
  for (let pass = 0; pass < 3; pass += 1) {
    const { next, hadHtmlChange } = sanitizeMarkdownPass(current)
    current = next
    if (!hadHtmlChange) {
      break
    }
  }
  return current
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
const CustomCode = Code.extend({
  excludes: 'bold italic strike underline'
})

const CustomLink = Link.extend({
  inclusive: false
})

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

function extractSafeImageSrc(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed && isSafeImageUri(trimmed) ? trimmed : null
}

function parseSafeImageAttrs(
  dom: unknown,
  attrName: typeof IMAGE_MARKDOWN_SRC_ATTR | 'src'
): { src: string; alt: string | null; title: string | null } | false {
  if (!(dom instanceof HTMLElement)) {
    return false
  }
  const rawSrc = extractSafeImageSrc(dom.getAttribute(attrName))
  if (!rawSrc) {
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
    const rawSrc = extractSafeImageSrc(node.attrs.src)
    const displaySrc = rawSrc ? resolveImageDisplaySrc(rawSrc, this.options.getDocumentPath?.()) : ''
    const merged = mergeAttributes(this.options.HTMLAttributes, HTMLAttributes)
    delete merged.src
    delete merged[IMAGE_MARKDOWN_SRC_ATTR]
    if (displaySrc) {
      merged.src = displaySrc
    }
    if (rawSrc) {
      merged[IMAGE_MARKDOWN_SRC_ATTR] = rawSrc
    }
    return ['img', merged]
  },

  parseMarkdown: (token, helpers) => {
    const href = extractSafeImageSrc(token.href)
    if (!href) {
      return []
    }
    return helpers.createNode('image', {
      src: href,
      alt: token.text || '',
      title: token.title || null
    })
  },

  renderMarkdown: (node) => {
    const src = extractSafeImageSrc(node.attrs?.src)
    if (!src) {
      return ''
    }
    const alt = typeof node.attrs?.alt === 'string' ? node.attrs.alt : ''
    const title = typeof node.attrs?.title === 'string' ? node.attrs.title : ''
    const destination = formatMarkdownImageDestination(src)
    return title
      ? `![${alt}](${destination} "${title.replace(/"/g, '\\"')}")`
      : `![${alt}](${destination})`
  },

  addCommands() {
    const parentCommands = this.parent?.()
    return {
      ...parentCommands,
      setImage:
        (options) =>
        (commandProps) => {
          const safeSrc = extractSafeImageSrc(options.src)
          if (!safeSrc) {
            return false
          }
          return parentCommands?.setImage?.({ ...options, src: safeSrc })(commandProps) ?? false
        }
    }
  },

  addInputRules() {
    const parentRules = this.parent?.() ?? []
    return parentRules.map(
      (rule) =>
        new InputRule({
          find: rule.find,
          undoable: rule.undoable,
          handler: (props) => {
            if (!extractSafeImageSrc(props.match[3])) {
              return null
            }
            return rule.handler(props)
          }
        })
    )
  }
})

function isCodeBlockParent(node: EditorState['selection']['$from']['parent']): boolean {
  return Boolean(node.type.spec.code) || node.type.name === 'mermaidBlock'
}

function dispatchPasteTransaction(view: Editor['view'], tr: Transaction): true {
  view.dispatch(tr.scrollIntoView().setMeta('paste', true))
  return true
}

/**
 * Handles external clipboard paste in WYSIWYG mode by ignoring external HTML and VS Code
 * metadata and inserting sanitized `text/plain` (parsed as Markdown in normal blocks, or as
 * literal text inside code blocks/inline code), while leaving internal `data-pm-slice` pastes intact.
 */
export function handleWysiwygExternalTextPaste(
  editor: Editor,
  event: ClipboardEvent
): boolean {
  const clipboardData = event.clipboardData
  if (!clipboardData || editor.isDestroyed || !editor.isEditable) {
    return false
  }

  const rawHtml = clipboardData.getData('text/html')
  if (rawHtml && /\bdata-pm-slice\s*=/.test(rawHtml)) {
    return false
  }

  const rawText = clipboardData.getData('text/plain') || clipboardData.getData('Text')
  if (!rawText) {
    return Boolean(rawHtml)
  }

  const normalizedText = rawText.replace(/\r\n?/g, '\n')
  const { view } = editor
  const { state } = view
  const { from, to, empty, $from, $to } = state.selection
  const inCodeBlock = isCodeBlockParent($from.parent) || isCodeBlockParent($to.parent)
  const inInlineCode = !inCodeBlock && editor.isActive('code')

  if (inCodeBlock || inInlineCode) {
    const codeMarkType = state.schema.marks.code
    const activeMarks = state.storedMarks ?? $from.marks()
    const tr =
      inInlineCode && codeMarkType
        ? state.tr.replaceWith(
            from,
            to,
            state.schema.text(
              normalizedText,
              activeMarks.some((mark) => mark.type === codeMarkType)
                ? activeMarks
                : [codeMarkType.create()]
            )
          )
        : state.tr.insertText(normalizedText, from, to)
    return dispatchPasteTransaction(view, tr)
  }

  if (!normalizedText.trim()) {
    return dispatchPasteTransaction(view, state.tr.insertText(normalizedText, from, to))
  }

  if (!editor.markdown) {
    return false
  }

  const prepared = prepareMarkdownForTiptap(normalizedText)
  if (!prepared.trim()) {
    return true
  }

  const parsedJson = editor.markdown.parse(prepared)
  const docNode = state.schema.nodeFromJSON(parsedJson)
  if (docNode.childCount === 0) {
    return true
  }

  const tr = state.tr
  if (docNode.childCount === 1 && docNode.firstChild?.type.name === 'paragraph') {
    tr.replaceSelection(new Slice(docNode.firstChild.content, 0, 0))
  } else if (
    empty &&
    $from.depth === 1 &&
    $from.parent.isTextblock &&
    $from.parent.content.size === 0
  ) {
    tr.replaceRange(from - 1, to + 1, new Slice(docNode.content, 0, 0))
    const mappedEnd = Math.min(tr.doc.content.size, Math.max(0, tr.mapping.map(to + 1) - 1))
    tr.setSelection(Selection.near(tr.doc.resolve(mappedEnd), -1))
  } else if (docNode.childCount === 1 && docNode.firstChild) {
    tr.replaceSelectionWith(docNode.firstChild, false)
  } else {
    const openStart = docNode.firstChild?.type.name === 'paragraph' ? 1 : 0
    const openEnd = docNode.lastChild?.type.name === 'paragraph' ? 1 : 0
    tr.replaceSelection(new Slice(docNode.content, openStart, openEnd))
  }

  return dispatchPasteTransaction(view, tr)
}

const WysiwygExternalTextPaste = Extension.create({
  name: 'wysiwygExternalTextPaste',
  priority: 1100,
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: wysiwygExternalTextPastePluginKey,
        props: {
          handlePaste: (_view, event) => handleWysiwygExternalTextPaste(this.editor, event)
        }
      })
    ]
  }
})

const CODE_BLOCK_INDENT_UNIT = '  '

interface CodeBlockSelectionContext {
  blockStart: number
  text: string
  fromOffset: number
  toOffset: number
  anchorOffset: number
  headOffset: number
}

function getEditableCodeBlockContext(editor: Editor): CodeBlockSelectionContext | null {
  if (!editor.isEditable) {
    return null
  }
  const { selection } = editor.state
  if (!(selection instanceof TextSelection)) {
    return null
  }
  const { $from, $to } = selection
  if (!$from.sameParent($to) || $from.parent.type.name !== 'codeBlock') {
    return null
  }
  const blockStart = $from.start()
  return {
    blockStart,
    text: $from.parent.textContent,
    fromOffset: selection.from - blockStart,
    toOffset: selection.to - blockStart,
    anchorOffset: selection.anchor - blockStart,
    headOffset: selection.head - blockStart
  }
}

function dispatchRemappedCodeBlockSelection(
  view: Editor['view'],
  tr: Transaction,
  ctx: CodeBlockSelectionContext,
  shiftOffset: (offset: number) => number
): true {
  tr.setSelection(
    TextSelection.create(
      tr.doc,
      ctx.blockStart + shiftOffset(ctx.anchorOffset),
      ctx.blockStart + shiftOffset(ctx.headOffset)
    )
  )
  view.dispatch(tr.scrollIntoView())
  return true
}

function getCodeBlockLineStart(text: string, offset: number): number {
  return offset === 0 ? 0 : text.lastIndexOf('\n', offset - 1) + 1
}

function collectSelectedLineStarts(text: string, fromOffset: number, toOffset: number): number[] {
  const firstLineStart = getCodeBlockLineStart(text, fromOffset)
  const effectiveEnd =
    toOffset > fromOffset && text[toOffset - 1] === '\n' ? toOffset - 1 : toOffset
  const starts: number[] = []
  let lineStart = firstLineStart
  while (lineStart <= effectiveEnd) {
    starts.push(lineStart)
    const nextNewline = text.indexOf('\n', lineStart)
    if (nextNewline === -1 || nextNewline >= effectiveEnd) {
      break
    }
    lineStart = nextNewline + 1
  }
  return starts
}

function getCodeBlockOutdentLength(text: string, lineStart: number): number {
  if (text[lineStart] === '\t') {
    return 1
  }
  let count = 0
  while (
    count < CODE_BLOCK_INDENT_UNIT.length &&
    lineStart + count < text.length &&
    text[lineStart + count] === ' '
  ) {
    count += 1
  }
  return count
}

function indentCodeBlockSelection(editor: Editor): boolean {
  const ctx = getEditableCodeBlockContext(editor)
  if (!ctx) {
    return false
  }
  const { state, view } = editor
  if (ctx.fromOffset === ctx.toOffset) {
    view.dispatch(
      state.tr
        .insertText(CODE_BLOCK_INDENT_UNIT, state.selection.from, state.selection.to)
        .scrollIntoView()
    )
    return true
  }

  const lineStarts = collectSelectedLineStarts(ctx.text, ctx.fromOffset, ctx.toOffset)
  const tr = state.tr
  for (let i = lineStarts.length - 1; i >= 0; i -= 1) {
    tr.insertText(CODE_BLOCK_INDENT_UNIT, ctx.blockStart + lineStarts[i])
  }
  return dispatchRemappedCodeBlockSelection(view, tr, ctx, (offset) => {
    let added = 0
    for (const start of lineStarts) {
      if (start <= offset) {
        added += CODE_BLOCK_INDENT_UNIT.length
      }
    }
    return offset + added
  })
}

function outdentCodeBlockSelection(editor: Editor): boolean {
  const ctx = getEditableCodeBlockContext(editor)
  if (!ctx) {
    return false
  }

  const lineStarts = collectSelectedLineStarts(ctx.text, ctx.fromOffset, ctx.toOffset)
  const removals: Array<{ start: number; length: number }> = []
  for (const start of lineStarts) {
    const length = getCodeBlockOutdentLength(ctx.text, start)
    if (length > 0) {
      removals.push({ start, length })
    }
  }
  if (removals.length === 0) {
    return true
  }

  const { state, view } = editor
  const tr = state.tr
  for (let i = removals.length - 1; i >= 0; i -= 1) {
    const { start, length } = removals[i]
    tr.delete(ctx.blockStart + start, ctx.blockStart + start + length)
  }
  return dispatchRemappedCodeBlockSelection(view, tr, ctx, (offset) => {
    let removed = 0
    for (const r of removals) {
      removed += Math.max(0, Math.min(offset, r.start + r.length) - r.start)
    }
    return offset - removed
  })
}

function insertIndentedCodeBlockNewline(editor: Editor): boolean {
  const ctx = getEditableCodeBlockContext(editor)
  if (!ctx) {
    return false
  }
  const lineStart = getCodeBlockLineStart(ctx.text, ctx.fromOffset)
  const leadingIndent = ctx.text.slice(lineStart, ctx.fromOffset).match(/^[ \t]+/)?.[0] ?? ''
  if (!leadingIndent) {
    return false
  }
  const { state, view } = editor
  view.dispatch(
    state.tr
      .insertText(`\n${leadingIndent}`, state.selection.from, state.selection.to)
      .scrollIntoView()
  )
  return true
}

const CodeBlockIndentation = Extension.create({
  name: 'codeBlockIndentation',
  priority: 1000,
  addKeyboardShortcuts() {
    return {
      Tab: () => indentCodeBlockSelection(this.editor),
      'Shift-Tab': () => outdentCodeBlockSelection(this.editor),
      Enter: () => insertIndentedCodeBlockNewline(this.editor)
    }
  }
})

export function createWysiwygExtensions(options: WysiwygExtensionOptions = {}): AnyExtension[] {
  return [
    StarterKit.configure({
      code: false,
      codeBlock: false,
      link: false
    }),
    CustomCode,
    CustomLink.configure({
      openOnClick: false,
      markdownLinks: true,
      protocols: [],
      isAllowedUri: (url) => isSafeMarkdownUrl(url)
    }),
    HighlightedCodeBlock,
    CodeBlockIndentation,
    WikiAssetImage.configure({
      getDocumentPath: options.getDocumentPath
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
    }),
    WysiwygExternalTextPaste,
    WysiwygSearchHighlight
  ]
}

export type ProseMirrorLinkQueryMatch = InlineLinkSegmentMatch

function isCodeOnlyBlockParent(node: EditorState['selection']['$from']['parent']): boolean {
  return !node.isTextblock || isCodeBlockParent(node)
}

/**
 * ProseMirror 현재 텍스트블록 커서 앞에서 `[텍스트](쿼리` 인라인 링크 트리거를 감지한다.
 */
export function detectProseMirrorLinkQuery(state: EditorState): ProseMirrorLinkQueryMatch | null {
  const { $from, empty } = state.selection
  if (!empty || isCodeOnlyBlockParent($from.parent)) {
    return null
  }

  const activeMarks = state.storedMarks ?? $from.marks()
  if (activeMarks.some((mark) => mark.type.name === 'code' || mark.type.name === 'link')) {
    return null
  }

  const segments: InlineLinkSegment[] = []
  const parentStart = $from.start()
  let offset = 0

  for (let i = 0; i < $from.parent.childCount && offset < $from.parentOffset; i += 1) {
    const child = $from.parent.child(i)
    const segFrom = parentStart + offset
    if (child.isText) {
      const sliceLen = Math.min(child.nodeSize, $from.parentOffset - offset)
      const isLinkMark = child.marks.some((mark) => mark.type.name === 'link')
      const isCodeMark = child.marks.some((mark) => mark.type.name === 'code')
      segments.push({
        text: (child.text ?? '').slice(0, sliceLen),
        from: segFrom,
        isCodeMark,
        isBoundaryBreak: isLinkMark
      })
    } else {
      segments.push({
        text: '',
        from: segFrom,
        isBoundaryBreak: true
      })
    }
    offset += child.nodeSize
  }

  return detectLinkQueryFromSegments(segments, $from.pos)
}

/**
 * 감지된 `[라벨](쿼리` 구간을 `link` 마크(섹션/상대 파일 경로)로 치환하고 인접 `)`와 마크 번짐을 정리한다.
 */
export function insertWysiwygLink(
  editor: Editor,
  candidate: LinkCandidate,
  match: ProseMirrorLinkQueryMatch
): boolean {
  const linkMarkType = editor.state.schema.marks.link
  if (!linkMarkType) {
    return false
  }

  const { state } = editor
  const $to = state.doc.resolve(match.rangeTo)
  const hasTrailingCloseParen =
    $to.parentOffset < $to.parent.content.size &&
    state.doc.textBetween(match.rangeTo, match.rangeTo + 1, '') === ')'
  const replaceTo = hasTrailingCloseParen ? match.rangeTo + 1 : match.rangeTo

  const href = getLinkCandidateHref(candidate)
  const linkMark = linkMarkType.create({ href })
  const tr = state.tr.setMeta(linkInsertPluginKey, true)
  let linkEndPos: number

  if (match.label.length > 0) {
    tr.delete(match.closeBracketPos, replaceTo)
    tr.delete(match.rangeFrom, match.rangeFrom + 1)
    linkEndPos = match.closeBracketPos - 1
    tr.addMark(match.rangeFrom, linkEndPos, linkMark)
  } else {
    const labelText = getLinkCandidateAutoLabel(candidate) || href
    const linkedNode = state.schema.text(labelText, [linkMark])
    tr.replaceWith(match.rangeFrom, replaceTo, linkedNode)
    linkEndPos = match.rangeFrom + labelText.length
  }

  tr.setSelection(TextSelection.create(tr.doc, linkEndPos))
  tr.setStoredMarks([])
  editor.view.dispatch(tr)
  editor.view.focus()
  return true
}

function findContiguousLinkRange(
  $from: EditorState['selection']['$from'],
  activeLinkMark: Mark
): { from: number; to: number } | null {
  let pos = $from.start()
  let runStart = -1
  let runEnd = -1
  let containsCursor = false

  for (let i = 0; i < $from.parent.childCount; i += 1) {
    const child = $from.parent.child(i)
    const childStart = pos
    const childEnd = pos + child.nodeSize
    const hasSameLink = child.isText && child.marks.some((mark) => mark.eq(activeLinkMark))

    if (hasSameLink) {
      if (runStart === -1) {
        runStart = childStart
      }
      runEnd = childEnd
      if ($from.pos >= childStart && $from.pos <= childEnd) {
        containsCursor = true
      }
    } else {
      if (containsCursor) {
        return { from: runStart, to: runEnd }
      }
      runStart = -1
      runEnd = -1
      containsCursor = false
    }

    pos = childEnd
  }

  return containsCursor && runStart >= 0 ? { from: runStart, to: runEnd } : null
}

function wrapRangeWithLinkTrigger(editor: Editor, from: number, to: number): boolean {
  const { state } = editor
  const { schema } = state
  const tr = state.tr
  if (from < to && schema.marks.link) {
    tr.removeMark(from, to, schema.marks.link)
  }
  tr.insert(to, schema.text(']('))
  tr.insert(from, schema.text('['))
  tr.setSelection(TextSelection.create(tr.doc, to + 3))
  tr.setStoredMarks([])
  editor.view.dispatch(tr)
  editor.view.focus()
  return true
}

/**
 * 위지윅 편집기에서 `Ctrl+K`/`Meta+K` 단축키로 선택 감싸기·`[]()` 시작 또는 기존 링크 해제를 수행한다.
 */
export function applyWysiwygCtrlK(editor: Editor): boolean {
  if (!editor.isEditable) {
    return false
  }
  const { state } = editor
  const { from, to, empty, $from, $to } = state.selection
  if (isCodeOnlyBlockParent($from.parent) || isCodeOnlyBlockParent($to.parent)) {
    return false
  }

  if (!empty) {
    if (!$from.sameParent($to)) {
      return false
    }
    let hasHardBreak = false
    state.doc.nodesBetween(from, to, (node) => {
      if (node.type.name === 'hardBreak') {
        hasHardBreak = true
        return false
      }
      return true
    })
    if (hasHardBreak) {
      return false
    }
    return wrapRangeWithLinkTrigger(editor, from, to)
  }

  const linkMarkType = state.schema.marks.link
  const activeLinkMark = linkMarkType ? $from.marks().find((mark) => mark.type === linkMarkType) : undefined
  if (activeLinkMark) {
    const linkRange = findContiguousLinkRange($from, activeLinkMark)
    if (linkRange) {
      return wrapRangeWithLinkTrigger(editor, linkRange.from, linkRange.to)
    }
  }

  const activeMarks = state.storedMarks ?? $from.marks()
  if (activeMarks.some((mark) => mark.type.name === 'code')) {
    return false
  }

  return wrapRangeWithLinkTrigger(editor, from, from)
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

/**
 * Collects the ProseMirror document positions of all `mermaid` code blocks in 0-based order.
 */
export function collectWysiwygMermaidPositions(doc: Editor['state']['doc']): number[] {
  const positions: number[] = []
  doc.descendants((node, pos) => {
    if (node.type.name === 'codeBlock') {
      const language = typeof node.attrs.language === 'string' ? node.attrs.language : ''
      if (isMermaidLanguage(language)) {
        positions.push(pos)
      }
      return false
    }
    return true
  })
  return positions
}

/**
 * Inserts ingested images at the given range (or current selection), placing multi-image
 * batches into ordered paragraphs while preserving clean relative Markdown URLs.
 */
export function insertWysiwygImages(
  editor: Editor,
  images: readonly WorkspaceImageIngestResult[],
  range?: { from: number; to: number }
): boolean {
  if (editor.isDestroyed || images.length === 0) {
    return false
  }

  const docSize = editor.state.doc.content.size
  const rawFrom = range?.from ?? editor.state.selection.from
  const rawTo = range?.to ?? editor.state.selection.to
  const from = Math.max(0, Math.min(rawFrom, docSize))
  const to = Math.max(from, Math.min(rawTo, docSize))

  const content =
    images.length === 1
      ? {
          type: 'image',
          attrs: { src: images[0].markdownPath, alt: images[0].altText }
        }
      : images.map((image) => ({
          type: 'paragraph',
          content: [{ type: 'image', attrs: { src: image.markdownPath, alt: image.altText } }]
        }))

  return editor.chain().focus().insertContentAt({ from, to }, content).run()
}
