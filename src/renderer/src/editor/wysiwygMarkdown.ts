import { AnyExtension, createNodeFromContent, Editor, Extension, Node as TiptapNode } from '@tiptap/core'
import Code from '@tiptap/extension-code'
import CodeBlock from '@tiptap/extension-code-block'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import Link from '@tiptap/extension-link'
import { TableKit } from '@tiptap/extension-table'
import { Markdown } from '@tiptap/markdown'
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
  detectLinkQueryFromSegments,
  getLinkCandidateAutoLabel,
  getLinkCandidateHref,
  type LinkCandidate,
  type InlineLinkSegment,
  type InlineLinkSegmentMatch
} from './LinkAutocompleteEngine'
import { isSafeMarkdownUrl, MARKDOWN_SANITIZE_SCHEMA } from './markdownSecurity'
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
}

export const headingNumberingPluginKey = new PluginKey<boolean>('headingNumbering')
export const slashInsertPluginKey = new PluginKey<boolean>('wysiwygSlashInsert')
export const linkInsertPluginKey = new PluginKey<boolean>('wysiwygLinkInsert')

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
const CustomCode = Code.extend({
  excludes: 'bold italic strike underline'
})

const CustomLink = Link.extend({
  inclusive: false
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
      protocols: [],
      isAllowedUri: (url) => isSafeMarkdownUrl(url)
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

export type ProseMirrorLinkQueryMatch = InlineLinkSegmentMatch

function isCodeOnlyBlockParent(node: EditorState['selection']['$from']['parent']): boolean {
  return !node.isTextblock || Boolean(node.type.spec.code) || node.type.name === 'mermaidBlock'
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
