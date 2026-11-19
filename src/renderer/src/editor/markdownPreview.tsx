import {
  Children,
  cloneElement,
  ComponentPropsWithoutRef,
  createContext,
  isValidElement,
  ReactElement,
  ReactNode,
  useContext
} from 'react'
import { Fragment, jsx, jsxs } from 'react/jsx-runtime'
import type { ThemeMode } from '@shared/config'
import {
  compileSearchMatcher,
  type CompiledSearchMatcher,
  type SearchMatchOptions
} from '@shared/search'
import type { Element as HastElement, Root as HastRoot, RootContent as HastRootContent } from 'hast'
import rehypeRaw from 'rehype-raw'
import rehypeReact from 'rehype-react'
import rehypeSanitize from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'
import { CodeBlockCopyButton } from '../components/CodeBlockHeaderControls'
import { MermaidDiagram } from '../components/MermaidDiagram'
import { resolveImageDisplaySrc } from '@shared/assets'
import {
  formatCodeBlockLanguageLabel,
  getCodeBlockHighlightSpans,
  isMermaidLanguage
} from './codeBlockHighlight'
import {
  areSearchMatchOptionsEqual,
  type DocumentFindHighlightQuery
} from './documentFind'
import { MARKDOWN_SANITIZE_SCHEMA } from './markdownSecurity'
import { createHeadingSlugTracker, decodeSlugSafely } from './MarkdownTocEngine'
import type { MermaidRenderer } from './mermaidRenderer'
import { isLinkNavigationClick } from './editorModes'

export interface MarkdownPreviewRenderOptions {
  theme?: ThemeMode
  documentPath?: string
  mermaidRenderer?: MermaidRenderer
  documentTitle?: string
  findHighlight?: DocumentFindHighlightQuery | null
  onAnchorNavigate?: (slug: string) => void
  onLinkNavigate?: (href: string) => void
}

export interface PreviewSearchMatchResult {
  matchCount: number
  errorMessage: string | null
}

interface PreviewRenderContextValue {
  theme: ThemeMode
  documentPath?: string
  mermaidRenderer?: MermaidRenderer
  documentTitle?: string
  onAnchorNavigate?: (slug: string) => void
  onLinkNavigate?: (href: string) => void
}

interface CodeSearchMatchSpan {
  start: number
  end: number
  matchIndex: number
}

interface SourceLineDataProps {
  'data-source-line'?: string
  'data-source-end-line'?: string
  'data-mermaid-index'?: string
  __searchHighlights?: readonly CodeSearchMatchSpan[]
  __activeSearchMatchIndex?: number
}

const PreviewRenderContext = createContext<PreviewRenderContextValue>({ theme: 'light' })

function extractHastText(node: HastElement | HastRootContent): string {
  if (node.type === 'text') {
    return node.value
  }
  if (node.type === 'element' && node.tagName === 'img') {
    return typeof node.properties?.alt === 'string' ? node.properties.alt : ''
  }
  if ('children' in node && Array.isArray(node.children)) {
    return node.children.map(extractHastText).join('')
  }
  return ''
}

function rehypeSourceLineAnnotation() {
  return (tree: HastRoot): void => {
    for (const child of tree.children) {
      if (child.type !== 'element') continue
      const startLine = child.position?.start?.line
      if (typeof startLine !== 'number' || !Number.isFinite(startLine) || startLine < 1) continue
      const rawEndLine = child.position?.end?.line
      const endLine =
        typeof rawEndLine === 'number' && Number.isFinite(rawEndLine) && rawEndLine >= startLine
          ? rawEndLine
          : startLine

      child.properties = {
        ...child.properties,
        'data-source-line': String(startLine),
        'data-source-end-line': String(endLine)
      }
    }
  }
}

function isMermaidHastPreElement(node: HastRoot | HastRootContent): node is HastElement {
  if (node.type !== 'element' || node.tagName !== 'pre') return false
  const meaningfulChildren = node.children.filter(
    (child) => child.type !== 'text' || child.value.trim().length > 0
  )
  if (meaningfulChildren.length !== 1) return false
  const onlyChild = meaningfulChildren[0]
  if (onlyChild.type !== 'element' || onlyChild.tagName !== 'code') return false
  return isMermaidLanguage(extractCodeLanguage(onlyChild.properties?.className))
}

function rehypeMermaidIndexAnnotation() {
  return (tree: HastRoot): void => {
    let nextIndex = 0
    const visit = (node: HastRoot | HastRootContent): void => {
      if (isMermaidHastPreElement(node)) {
        node.properties = {
          ...node.properties,
          'data-mermaid-index': String(nextIndex)
        }
        nextIndex += 1
        return
      }
      if ('children' in node && Array.isArray(node.children)) {
        for (const child of node.children) {
          visit(child)
        }
      }
    }
    visit(tree)
  }
}

function rehypeHeadingEnhancer() {
  return (tree: HastRoot): void => {
    const slugTracker = createHeadingSlugTracker()

    const visit = (node: HastRoot | HastRootContent): void => {
      if (node.type === 'element' && /^h[1-6]$/.test(node.tagName)) {
        const fullText = extractHastText(node)
        const slug = slugTracker.next(fullText)
        node.properties = {
          ...node.properties,
          id: slug
        }
        return
      }

      if ('children' in node && Array.isArray(node.children)) {
        for (const child of node.children) {
          visit(child)
        }
      }
    }

    visit(tree)
  }
}

function extractReactText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }
  if (Array.isArray(node)) {
    return node.map(extractReactText).join('')
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return extractReactText(node.props.children)
  }
  return ''
}

function getCodeClassTokens(className: unknown): string[] {
  if (typeof className === 'string') {
    return className.split(/\s+/).filter(Boolean)
  }
  if (Array.isArray(className)) {
    return className.filter((token): token is string => typeof token === 'string' && token.length > 0)
  }
  return []
}

function extractCodeLanguage(className: unknown): string {
  for (const token of getCodeClassTokens(className)) {
    if (token.startsWith('language-') && token.length > 'language-'.length) {
      return token.slice('language-'.length)
    }
  }
  return ''
}

function normalizeCodeClassName(className: unknown): string | undefined {
  const tokens = getCodeClassTokens(className)
  return tokens.length > 0 ? tokens.join(' ') : undefined
}

function wrapSearchMark(
  text: string,
  matchIndex: number,
  activeMatchIndex: number,
  key: string
): ReactNode {
  if (text.length === 0) {
    return (
      <span
        key={key}
        className="preview-search-match-anchor"
        data-search-match-index={matchIndex}
      />
    )
  }
  const isActive = matchIndex === activeMatchIndex
  return (
    <mark
      key={key}
      className={isActive ? 'preview-search-match preview-search-match-active' : 'preview-search-match'}
      data-search-match-index={matchIndex}
    >
      {text}
    </mark>
  )
}

/**
 * Renders highlighted React nodes for a code string while preserving exact source characters
 * and optionally layering in-document search `<mark>` spans across syntax token boundaries.
 */
export function renderHighlightedCodeNodes(
  code: string,
  language: string | null | undefined,
  searchHighlights?: readonly CodeSearchMatchSpan[],
  activeSearchMatchIndex = -1
): ReactNode {
  const spans = getCodeBlockHighlightSpans(code, language)
  const activeSearchSpans = searchHighlights ?? []
  if (spans.length === 0 && activeSearchSpans.length === 0) {
    return code
  }

  const boundarySet = new Set<number>([0, code.length])
  const validSyntaxSpans: typeof spans = []
  for (const span of spans) {
    if (span.from >= 0 && span.to > span.from && span.to <= code.length) {
      validSyntaxSpans.push(span)
      boundarySet.add(span.from)
      boundarySet.add(span.to)
    }
  }

  const anchorMatchesByOffset = new Map<number, number[]>()
  const rangeSearchSpans: CodeSearchMatchSpan[] = []
  for (const match of activeSearchSpans) {
    const start = Math.max(0, Math.min(code.length, match.start))
    const end = Math.max(start, Math.min(code.length, match.end))
    if (end <= start) {
      const existing = anchorMatchesByOffset.get(start)
      if (existing) {
        existing.push(match.matchIndex)
      } else {
        anchorMatchesByOffset.set(start, [match.matchIndex])
      }
      boundarySet.add(start)
    } else {
      rangeSearchSpans.push({ start, end, matchIndex: match.matchIndex })
      boundarySet.add(start)
      boundarySet.add(end)
    }
  }

  const boundaries = Array.from(boundarySet).sort((a, b) => a - b)
  const nodes: ReactNode[] = []

  const emitAnchorsAt = (offset: number): void => {
    const anchors = anchorMatchesByOffset.get(offset)
    if (!anchors) return
    anchorMatchesByOffset.delete(offset)
    for (const matchIndex of anchors) {
      nodes.push(wrapSearchMark('', matchIndex, activeSearchMatchIndex, `ca-${offset}-${matchIndex}`))
    }
  }

  for (let i = 0; i < boundaries.length; i += 1) {
    const start = boundaries[i]
    emitAnchorsAt(start)
    if (i + 1 >= boundaries.length) break
    const end = boundaries[i + 1]
    if (end <= start) continue

    const slice = code.slice(start, end)
    const syntaxSpan = validSyntaxSpans.find((span) => span.from <= start && span.to >= end)
    const searchMatch = rangeSearchSpans.find((span) => span.start <= start && span.end >= end)

    let piece: ReactNode = slice
    if (searchMatch) {
      piece = wrapSearchMark(
        slice,
        searchMatch.matchIndex,
        activeSearchMatchIndex,
        `cm-${i}-${searchMatch.matchIndex}`
      )
    }
    if (syntaxSpan) {
      piece = (
        <span key={`tok-${i}`} className={syntaxSpan.className}>
          {piece}
        </span>
      )
    }
    nodes.push(piece)
  }

  return nodes
}

function SafeLink(props: ComponentPropsWithoutRef<'a'>) {
  const { href, onClick, onAuxClick, children, ...rest } = props
  const { onAnchorNavigate, onLinkNavigate } = useContext(PreviewRenderContext)
  const isInternalAnchor = typeof href === 'string' && href.startsWith('#')

  return (
    <a
      {...rest}
      href={href}
      rel={href && !isInternalAnchor ? 'noopener noreferrer' : undefined}
      onClick={(event) => {
        event.preventDefault()
        if (typeof href === 'string' && isLinkNavigationClick('preview', event)) {
          if (onLinkNavigate) {
            onLinkNavigate(href)
          } else if (isInternalAnchor && href.length > 1) {
            onAnchorNavigate?.(decodeSlugSafely(href.slice(1)))
          }
        }
        onClick?.(event)
      }}
      onAuxClick={(event) => {
        event.preventDefault()
        onAuxClick?.(event)
      }}
    >
      {children}
    </a>
  )
}

function PreviewCheckbox(props: ComponentPropsWithoutRef<'input'>) {
  if (props.type !== 'checkbox') {
    return null
  }
  return (
    <input
      type="checkbox"
      className={props.className}
      checked={Boolean(props.checked)}
      disabled
      readOnly
    />
  )
}

interface FencedCodeBlockInfo {
  rawLanguage: string
  rawCode: string
  codeClassName: string | undefined
}

function extractFencedCodeBlockInfo(children: ReactNode): FencedCodeBlockInfo | null {
  const meaningfulChildren = Children.toArray(children).filter(
    (child) => typeof child !== 'string' || child.trim().length > 0
  )
  if (meaningfulChildren.length !== 1) {
    return null
  }
  const onlyChild = meaningfulChildren[0]
  if (
    !isValidElement<{ className?: unknown; children?: ReactNode }>(onlyChild) ||
    onlyChild.type !== 'code'
  ) {
    return null
  }
  return {
    rawLanguage: extractCodeLanguage(onlyChild.props.className),
    rawCode: extractReactText(onlyChild.props.children).replace(/\n$/, ''),
    codeClassName: normalizeCodeClassName(onlyChild.props.className)
  }
}

function PreviewPre(props: ComponentPropsWithoutRef<'pre'> & SourceLineDataProps) {
  const { theme, mermaidRenderer, documentTitle } = useContext(PreviewRenderContext)
  const {
    'data-source-line': sourceLine,
    'data-source-end-line': sourceEndLine,
    'data-mermaid-index': rawMermaidIndex,
    __searchHighlights: searchHighlights,
    __activeSearchMatchIndex: activeSearchMatchIndex = -1,
    ...preProps
  } = props
  const fencedInfo = extractFencedCodeBlockInfo(preProps.children)

  if (fencedInfo) {
    const { rawLanguage, rawCode, codeClassName } = fencedInfo

    if (isMermaidLanguage(rawLanguage)) {
      const blockIndex =
        rawMermaidIndex !== undefined && /^\d+$/.test(rawMermaidIndex)
          ? Number(rawMermaidIndex)
          : undefined
      return (
        <MermaidDiagram
          code={rawCode}
          theme={theme}
          renderer={mermaidRenderer}
          documentTitle={documentTitle}
          blockIndex={blockIndex}
          sourceLine={sourceLine}
          sourceEndLine={sourceEndLine}
        />
      )
    }

    return (
      <div
        className="md-code-block"
        data-testid="preview-code-block"
        data-language={rawLanguage || 'plaintext'}
        data-source-line={sourceLine}
        data-source-end-line={sourceEndLine}
      >
        <div className="code-block-header">
          <span className="code-block-language-label" data-testid="code-block-language-label">
            {formatCodeBlockLanguageLabel(rawLanguage)}
          </span>
          <CodeBlockCopyButton code={rawCode} />
        </div>
        <pre {...preProps}>
          <code className={codeClassName}>
            {renderHighlightedCodeNodes(
              rawCode,
              rawLanguage,
              searchHighlights,
              activeSearchMatchIndex
            )}
          </code>
        </pre>
      </div>
    )
  }

  return <pre {...preProps} />
}

function PreviewTable(props: ComponentPropsWithoutRef<'table'> & SourceLineDataProps) {
  const {
    'data-source-line': sourceLine,
    'data-source-end-line': sourceEndLine,
    ...tableProps
  } = props
  return (
    <div
      className="md-table-wrapper"
      data-source-line={sourceLine}
      data-source-end-line={sourceEndLine}
    >
      <table {...tableProps} />
    </div>
  )
}

function PreviewImage({ src, ...props }: ComponentPropsWithoutRef<'img'>): ReactNode {
  const { documentPath } = useContext(PreviewRenderContext)
  if (typeof src !== 'string') {
    return <img {...props} />
  }
  const resolvedSrc = resolveImageDisplaySrc(src, documentPath)
  if (!resolvedSrc) {
    return <img {...props} />
  }
  return <img {...props} src={resolvedSrc} />
}

function buildPreviewProcessor() {
  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSanitize, MARKDOWN_SANITIZE_SCHEMA)
    .use(rehypeSourceLineAnnotation)
    .use(rehypeMermaidIndexAnnotation)
    .use(rehypeHeadingEnhancer)
    .use(rehypeReact, {
      Fragment,
      jsx,
      jsxs,
      components: {
        a: SafeLink,
        img: PreviewImage,
        input: PreviewCheckbox,
        pre: PreviewPre,
        table: PreviewTable
      }
    })
}

const previewProcessor = buildPreviewProcessor()

const MAX_BASE_TREE_CACHE_ENTRIES = 8
const previewBaseTreeCache = new Map<string, ReactNode>()

function processPreviewBaseTree(markdown: string): ReactNode {
  const cached = previewBaseTreeCache.get(markdown)
  if (cached !== undefined) {
    // Refresh insertion order for small LRU retention across dual-pane previews.
    previewBaseTreeCache.delete(markdown)
    previewBaseTreeCache.set(markdown, cached)
    return cached
  }
  const tree = previewProcessor.processSync(markdown).result as ReactNode
  if (previewBaseTreeCache.size >= MAX_BASE_TREE_CACHE_ENTRIES) {
    const oldestKey = previewBaseTreeCache.keys().next().value
    if (oldestKey !== undefined) {
      previewBaseTreeCache.delete(oldestKey)
    }
  }
  previewBaseTreeCache.set(markdown, tree)
  return tree
}

const SKIP_ELEMENT_TAGS = new Set([
  'img',
  'input',
  'br',
  'hr',
  'svg',
  'button',
  'style',
  'script',
  'textarea',
  'select',
  'iframe',
  'object',
  'embed',
  'video',
  'audio',
  'canvas'
])

const BLOCK_ELEMENT_TAGS = new Set([
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'div',
  'blockquote',
  'ul',
  'ol',
  'li',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'dl',
  'dt',
  'dd',
  'section',
  'article',
  'aside',
  'header',
  'footer',
  'nav',
  'main',
  'figure',
  'figcaption',
  'details',
  'summary',
  'address',
  'pre'
])

const STRUCTURAL_WHITESPACE_ONLY_TAGS = new Set([
  'ul',
  'ol',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'colgroup',
  'dl'
])

type PreviewElementClassification =
  | { kind: 'skip' }
  | { kind: 'fenced-code'; rawCode: string; isMermaid: boolean }
  | { kind: 'block'; isWhitespaceContainer: boolean }
  | { kind: 'inline'; isWhitespaceContainer: boolean }

function classifyPreviewElement(
  element: ReactElement<{ children?: ReactNode }>
): PreviewElementClassification {
  const { type } = element
  if (type === PreviewPre) {
    const fenced = extractFencedCodeBlockInfo(element.props.children)
    if (fenced) {
      return {
        kind: 'fenced-code',
        rawCode: fenced.rawCode,
        isMermaid: isMermaidLanguage(fenced.rawLanguage)
      }
    }
    return { kind: 'block', isWhitespaceContainer: false }
  }
  if (type === PreviewImage || type === PreviewCheckbox) {
    return { kind: 'skip' }
  }
  if (type === PreviewTable) {
    return { kind: 'block', isWhitespaceContainer: true }
  }
  if (typeof type === 'string') {
    if (SKIP_ELEMENT_TAGS.has(type)) {
      return { kind: 'skip' }
    }
    if (BLOCK_ELEMENT_TAGS.has(type)) {
      return { kind: 'block', isWhitespaceContainer: STRUCTURAL_WHITESPACE_ONLY_TAGS.has(type) }
    }
    return { kind: 'inline', isWhitespaceContainer: false }
  }
  return { kind: 'inline', isWhitespaceContainer: type === Fragment }
}

interface TextSlotSegment {
  slotId: number
  text: string
  startOffset: number
  endOffset: number
}

interface PreviewSearchPlan {
  matchCount: number
  errorMessage: string | null
  textPatches: Map<number, CodeSearchMatchSpan[]>
  codePatches: Map<number, CodeSearchMatchSpan[]>
}

const EMPTY_SEARCH_PLAN: PreviewSearchPlan = {
  matchCount: 0,
  errorMessage: null,
  textPatches: new Map(),
  codePatches: new Map()
}

let cachedSearchPlan: {
  baseTree: ReactNode
  query: string
  options: SearchMatchOptions
  plan: PreviewSearchPlan
} | null = null

function isStructuralWhitespaceText(
  text: string,
  isStructuralWhitespaceContainer: boolean
): boolean {
  return isStructuralWhitespaceContainer && /^[\r\n\t ]+$/.test(text)
}

function appendPatch(
  map: Map<number, CodeSearchMatchSpan[]>,
  slotId: number,
  patch: CodeSearchMatchSpan
): void {
  const list = map.get(slotId)
  if (list) {
    list.push(patch)
  } else {
    map.set(slotId, [patch])
  }
}

function flushPreviewTextRun(
  runSegments: TextSlotSegment[],
  matcher: CompiledSearchMatcher,
  textPatches: Map<number, CodeSearchMatchSpan[]>,
  nextMatchIndex: () => number
): void {
  if (runSegments.length === 0) {
    return
  }
  const combined = runSegments.map((segment) => segment.text).join('')
  if (combined.includes('\n') && /^[\r\n\t ]+$/.test(combined)) {
    runSegments.length = 0
    return
  }
  for (const span of matcher.findMatches(combined)) {
    const matchIndex = nextMatchIndex()
    if (span.end <= span.start) {
      const targetSegment =
        runSegments.find((seg) => span.start <= seg.endOffset) ??
        runSegments[runSegments.length - 1]
      const localPos = Math.max(0, Math.min(targetSegment.text.length, span.start - targetSegment.startOffset))
      appendPatch(textPatches, targetSegment.slotId, {
        start: localPos,
        end: localPos,
        matchIndex
      })
      continue
    }

    for (const seg of runSegments) {
      if (span.end <= seg.startOffset || span.start >= seg.endOffset) {
        continue
      }
      const localStart = Math.max(0, span.start - seg.startOffset)
      const localEnd = Math.min(seg.text.length, span.end - seg.startOffset)
      if (localEnd > localStart) {
        appendPatch(textPatches, seg.slotId, {
          start: localStart,
          end: localEnd,
          matchIndex
        })
      }
    }
  }
  runSegments.length = 0
}

function buildPreviewSearchPlan(
  baseTree: ReactNode,
  query: string,
  options: SearchMatchOptions
): PreviewSearchPlan {
  if (query.length === 0) {
    return EMPTY_SEARCH_PLAN
  }
  if (
    cachedSearchPlan &&
    cachedSearchPlan.baseTree === baseTree &&
    cachedSearchPlan.query === query &&
    areSearchMatchOptionsEqual(cachedSearchPlan.options, options)
  ) {
    return cachedSearchPlan.plan
  }

  const compiled = compileSearchMatcher(query, options)
  if (!compiled.ok) {
    const errorPlan: PreviewSearchPlan = {
      matchCount: 0,
      errorMessage: compiled.error,
      textPatches: new Map(),
      codePatches: new Map()
    }
    cachedSearchPlan = { baseTree, query, options, plan: errorPlan }
    return errorPlan
  }

  let nextTextSlotId = 0
  let nextCodeSlotId = 0
  let matchCount = 0
  const allocateMatchIndex = (): number => {
    const idx = matchCount
    matchCount += 1
    return idx
  }

  const textPatches = new Map<number, CodeSearchMatchSpan[]>()
  const codePatches = new Map<number, CodeSearchMatchSpan[]>()
  const runSegments: TextSlotSegment[] = []
  let runLength = 0

  const flushRun = (): void => {
    flushPreviewTextRun(runSegments, compiled.matcher, textPatches, allocateMatchIndex)
    runLength = 0
  }

  const visit = (node: ReactNode, isStructuralWhitespaceContainer: boolean): void => {
    if (node === null || node === undefined || typeof node === 'boolean') {
      return
    }
    if (Array.isArray(node)) {
      for (const child of node) {
        visit(child, isStructuralWhitespaceContainer)
      }
      return
    }
    if (typeof node === 'string' || typeof node === 'number') {
      const text = String(node)
      if (isStructuralWhitespaceText(text, isStructuralWhitespaceContainer)) {
        return
      }
      const slotId = nextTextSlotId++
      runSegments.push({
        slotId,
        text,
        startOffset: runLength,
        endOffset: runLength + text.length
      })
      runLength += text.length
      return
    }
    if (!isValidElement<{ children?: ReactNode }>(node)) {
      return
    }

    const classification = classifyPreviewElement(node)
    if (classification.kind === 'skip') {
      flushRun()
      return
    }
    if (classification.kind === 'fenced-code') {
      flushRun()
      if (!classification.isMermaid) {
        const codeSlotId = nextCodeSlotId++
        const spans = compiled.matcher.findMatches(classification.rawCode)
        if (spans.length > 0) {
          codePatches.set(
            codeSlotId,
            spans.map((span) => ({
              start: span.start,
              end: span.end,
              matchIndex: allocateMatchIndex()
            }))
          )
        }
      }
      return
    }
    if (classification.kind === 'block') {
      flushRun()
      visit(node.props.children, classification.isWhitespaceContainer)
      flushRun()
      return
    }
    visit(node.props.children, classification.isWhitespaceContainer)
  }

  visit(baseTree, true)
  flushRun()

  const plan: PreviewSearchPlan = {
    matchCount,
    errorMessage: null,
    textPatches,
    codePatches
  }
  cachedSearchPlan = { baseTree, query, options, plan }
  return plan
}

function renderPatchedText(
  text: string,
  patches: readonly CodeSearchMatchSpan[],
  activeMatchIndex: number,
  slotId: number
): ReactNode {
  const ordered = [...patches].sort((a, b) => a.start - b.start || a.end - b.end || a.matchIndex - b.matchIndex)
  const parts: ReactNode[] = []
  let cursor = 0

  for (let i = 0; i < ordered.length; i += 1) {
    const patch = ordered[i]
    if (patch.start > cursor) {
      parts.push(text.slice(cursor, patch.start))
    }
    if (patch.end <= patch.start) {
      parts.push(
        wrapSearchMark('', patch.matchIndex, activeMatchIndex, `sma-${slotId}-${i}-${patch.matchIndex}`)
      )
      cursor = Math.max(cursor, patch.start)
      continue
    }
    const start = Math.max(cursor, patch.start)
    if (patch.end > start) {
      parts.push(
        wrapSearchMark(
          text.slice(start, patch.end),
          patch.matchIndex,
          activeMatchIndex,
          `sm-${slotId}-${i}-${patch.matchIndex}`
        )
      )
      cursor = patch.end
    }
  }

  if (cursor < text.length) {
    parts.push(text.slice(cursor))
  }

  return <Fragment key={`smf-${slotId}`}>{parts}</Fragment>
}

function applyPreviewSearchPlan(
  baseTree: ReactNode,
  plan: PreviewSearchPlan,
  activeMatchIndex: number
): ReactNode {
  if (plan.matchCount === 0) {
    return baseTree
  }

  let nextTextSlotId = 0
  let nextCodeSlotId = 0

  const rewrite = (node: ReactNode, isStructuralWhitespaceContainer: boolean): ReactNode => {
    if (node === null || node === undefined || typeof node === 'boolean') {
      return node
    }
    if (Array.isArray(node)) {
      let changed = false
      const mapped = node.map((child) => {
        const nextChild = rewrite(child, isStructuralWhitespaceContainer)
        if (nextChild !== child) {
          changed = true
        }
        return nextChild
      })
      return changed ? mapped : node
    }
    if (typeof node === 'string' || typeof node === 'number') {
      const text = String(node)
      if (isStructuralWhitespaceText(text, isStructuralWhitespaceContainer)) {
        return node
      }
      const slotId = nextTextSlotId++
      const patches = plan.textPatches.get(slotId)
      return patches ? renderPatchedText(text, patches, activeMatchIndex, slotId) : node
    }
    if (!isValidElement<{ children?: ReactNode }>(node)) {
      return node
    }

    const classification = classifyPreviewElement(node)
    if (classification.kind === 'skip') {
      return node
    }
    if (classification.kind === 'fenced-code') {
      if (!classification.isMermaid) {
        const codeSlotId = nextCodeSlotId++
        const patches = plan.codePatches.get(codeSlotId)
        if (patches) {
          return cloneElement(node as ReactElement<SourceLineDataProps>, {
            __searchHighlights: patches,
            __activeSearchMatchIndex: activeMatchIndex
          })
        }
      }
      return node
    }

    const prevChildren = node.props.children
    const nextChildren = rewrite(prevChildren, classification.isWhitespaceContainer)
    if (nextChildren === prevChildren) {
      return node
    }
    if (Array.isArray(nextChildren)) {
      return cloneElement(node, undefined, ...nextChildren)
    }
    return cloneElement(node, undefined, nextChildren)
  }

  return rewrite(baseTree, true)
}

/**
 * Counts rendered Preview matches (excluding Mermaid diagrams and code block UI chrome)
 * for `markdown` under the supplied search `query` and `options`.
 */
export function findPreviewSearchMatches(
  markdown: string,
  query: string,
  options: SearchMatchOptions
): PreviewSearchMatchResult {
  if (query.length === 0 || markdown.trim().length === 0) {
    return { matchCount: 0, errorMessage: null }
  }
  const baseTree = processPreviewBaseTree(markdown)
  const plan = buildPreviewSearchPlan(baseTree, query, options)
  return {
    matchCount: plan.matchCount,
    errorMessage: plan.errorMessage
  }
}

/**
 * Parses GFM Markdown, sanitizes unsafe HTML/URIs, applies heading anchor slugs,
 * and renders Mermaid code blocks, search highlights, and safe React elements.
 */
export function renderMarkdownToReact(
  markdown: string,
  options: MarkdownPreviewRenderOptions = {}
): ReactNode {
  const baseTree = processPreviewBaseTree(markdown)
  const { findHighlight } = options
  const contentTree =
    findHighlight?.isActive && findHighlight.query.length > 0 && markdown.trim().length > 0
      ? applyPreviewSearchPlan(
          baseTree,
          buildPreviewSearchPlan(baseTree, findHighlight.query, findHighlight.options),
          findHighlight.activeIndex
        )
      : baseTree

  const contextValue: PreviewRenderContextValue = {
    theme: options.theme ?? 'light',
    documentPath: options.documentPath,
    mermaidRenderer: options.mermaidRenderer,
    documentTitle: options.documentTitle,
    onAnchorNavigate: options.onAnchorNavigate,
    onLinkNavigate: options.onLinkNavigate
  }
  return (
    <PreviewRenderContext.Provider value={contextValue}>
      {contentTree}
    </PreviewRenderContext.Provider>
  )
}
