import {
  Children,
  ComponentPropsWithoutRef,
  createContext,
  isValidElement,
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
import { MARKDOWN_SANITIZE_SCHEMA } from './markdownSecurity'
import { createHeadingSlugTracker, decodeSlugSafely } from './MarkdownTocEngine'
import type { MermaidRenderer } from './mermaidRenderer'
import { isLinkNavigationClick } from './editorModes'

export interface MarkdownPreviewRenderOptions {
  theme?: ThemeMode
  documentPath?: string
  mermaidRenderer?: MermaidRenderer
  documentTitle?: string
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
 * Renders highlighted React nodes for a code string while preserving exact source characters.
 */
export function renderHighlightedCodeNodes(
  code: string,
  language: string | null | undefined
): ReactNode {
  const spans = getCodeBlockHighlightSpans(code, language)
  if (spans.length === 0) {
    return code
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

function PreviewPre(props: ComponentPropsWithoutRef<'pre'> & SourceLineDataProps) {
  const { theme, mermaidRenderer, documentTitle } = useContext(PreviewRenderContext)
  const {
    'data-source-line': sourceLine,
    'data-source-end-line': sourceEndLine,
    'data-mermaid-index': rawMermaidIndex,
    ...preProps
  } = props
  const meaningfulChildren = Children.toArray(preProps.children).filter(
    (child) => typeof child !== 'string' || child.trim().length > 0
  )

  if (meaningfulChildren.length === 1) {
    const onlyChild = meaningfulChildren[0]
    if (
      isValidElement<{ className?: unknown; children?: ReactNode }>(onlyChild) &&
      onlyChild.type === 'code'
    ) {
      const rawLanguage = extractCodeLanguage(onlyChild.props.className)
      const rawCode = extractReactText(onlyChild.props.children).replace(/\n$/, '')

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

      const codeClassName = normalizeCodeClassName(onlyChild.props.className)
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
              {renderHighlightedCodeNodes(rawCode, rawLanguage)}
            </code>
          </pre>
        </div>
      )
    }
  }

  return <pre {...props} />
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

/**
 * Parses GFM Markdown, sanitizes unsafe HTML/URIs, applies heading anchor slugs,
 * and renders Mermaid code blocks and safe React elements.
 */
export function renderMarkdownToReact(
  markdown: string,
  options: MarkdownPreviewRenderOptions = {}
): ReactNode {
  const file = previewProcessor.processSync(markdown)
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
      {file.result as ReactNode}
    </PreviewRenderContext.Provider>
  )
}
