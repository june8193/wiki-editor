import {
  Children,
  ComponentPropsWithoutRef,
  createContext,
  isValidElement,
  ReactElement,
  ReactNode,
  useContext
} from 'react'
import { Fragment, jsx, jsxs } from 'react/jsx-runtime'
import type { ThemeMode } from '@shared/config'
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
import type { DocumentFindCriteria, DocumentFindHighlightQuery } from './documentFind'
import { MARKDOWN_SANITIZE_SCHEMA } from './markdownSecurity'
import { createHeadingSlugTracker, decodeSlugSafely } from './MarkdownTocEngine'
import type { MermaidRenderer } from './mermaidRenderer'
import { isLinkNavigationClick } from './editorModes'
import {
  evaluatePreviewSearchMatches,
  highlightPreviewTree,
  type PreviewElementClassification,
  type PreviewPreSearchProps,
  type PreviewSearchMatchResult,
  type PreviewSearchMatchSpan,
  renderCodeTokensWithSearch
} from './previewSearchHighlight'

export interface MarkdownPreviewRenderOptions {
  theme?: ThemeMode
  documentPath?: string
  mermaidRenderer?: MermaidRenderer
  documentTitle?: string
  findHighlight?: DocumentFindHighlightQuery | null
  onAnchorNavigate?: (slug: string) => void
  onLinkNavigate?: (href: string) => void
}

interface PreviewRenderContextValue {
  theme: ThemeMode
  documentPath?: string
  mermaidRenderer?: MermaidRenderer
  documentTitle?: string
  onAnchorNavigate?: (slug: string) => void
  onLinkNavigate?: (href: string) => void
}

interface SourceLineDataProps {
  'data-source-line'?: string
  'data-source-end-line'?: string
  'data-mermaid-index'?: string
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

/**
 * Renders highlighted React nodes for a code string while preserving exact source characters
 * and optionally layering in-document search `<mark>` spans across syntax token boundaries.
 */
export function renderHighlightedCodeNodes(
  code: string,
  language: string | null | undefined,
  searchHighlights?: readonly PreviewSearchMatchSpan[],
  activeSearchMatchIndex = -1
): ReactNode {
  const spans = getCodeBlockHighlightSpans(code, language)
  const activeSearchSpans = searchHighlights ?? []
  if (spans.length === 0 && activeSearchSpans.length === 0) {
    return code
  }
  if (activeSearchSpans.length > 0) {
    return renderCodeTokensWithSearch(code, spans, activeSearchSpans, activeSearchMatchIndex)
  }

  const nodes: ReactNode[] = []
  let cursor = 0

  for (let i = 0; i < spans.length; i += 1) {
    const span = spans[i]
    if (span.from < cursor || span.to <= span.from || span.to > code.length) {
      continue
    }
    if (span.from > cursor) {
      nodes.push(code.slice(cursor, span.from))
    }
    nodes.push(
      <span key={`tok-${i}`} className={span.className}>
        {code.slice(span.from, span.to)}
      </span>
    )
    cursor = span.to
  }

  if (cursor < code.length) {
    nodes.push(code.slice(cursor))
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

function PreviewPre(props: ComponentPropsWithoutRef<'pre'> & SourceLineDataProps & PreviewPreSearchProps) {
  const { theme, mermaidRenderer, documentTitle } = useContext(PreviewRenderContext)
  const {
    'data-source-line': sourceLine,
    'data-source-end-line': sourceEndLine,
    'data-mermaid-index': rawMermaidIndex,
    searchHighlightSpans,
    activeSearchMatchIndex = -1,
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
              searchHighlightSpans,
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

function classifyCustomPreviewElement(
  element: ReactElement<{ children?: ReactNode }>
): PreviewElementClassification | null {
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
  return null
}

/**
 * Counts rendered Preview matches (excluding Mermaid diagrams and code block UI chrome)
 * for `markdown` under the supplied search `criteria`.
 */
export function findPreviewSearchMatches(
  markdown: string,
  criteria: DocumentFindCriteria
): PreviewSearchMatchResult {
  const isBlankDocument = markdown.trim().length === 0
  const baseTree = isBlankDocument ? null : processPreviewBaseTree(markdown)
  return evaluatePreviewSearchMatches(
    baseTree,
    isBlankDocument,
    criteria,
    classifyCustomPreviewElement
  )
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
  const contentTree = highlightPreviewTree(
    baseTree,
    markdown.trim().length === 0,
    options.findHighlight,
    classifyCustomPreviewElement
  )

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
