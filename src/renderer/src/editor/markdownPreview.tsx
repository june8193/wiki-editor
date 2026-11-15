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
import { MermaidDiagram } from '../components/MermaidDiagram'
import { resolveImageDisplaySrc } from '@shared/assets'
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

function hasLanguageMermaidClass(className: unknown): boolean {
  if (typeof className === 'string') {
    return className.split(/\s+/).includes('language-mermaid')
  }
  if (Array.isArray(className)) {
    return className.includes('language-mermaid')
  }
  return false
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
  const childrenArray = Children.toArray(props.children)

  if (childrenArray.length === 1) {
    const onlyChild = childrenArray[0]
    if (
      isValidElement<{ className?: unknown; children?: ReactNode }>(onlyChild) &&
      onlyChild.type === 'code' &&
      hasLanguageMermaidClass(onlyChild.props.className)
    ) {
      const diagramCode = extractReactText(onlyChild.props.children).replace(/\n$/, '')
      return (
        <MermaidDiagram
          code={diagramCode}
          theme={theme}
          renderer={mermaidRenderer}
          documentTitle={documentTitle}
          sourceLine={props['data-source-line']}
          sourceEndLine={props['data-source-end-line']}
        />
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
