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
import {
  createHeadingNumberTracker,
  createHeadingSlugTracker,
  hasHeadingNumberPrefix,
  LEADING_HEADING_NUMBER_RE
} from './MarkdownTocEngine'
import type { MermaidRenderer } from './mermaidRenderer'

export interface MarkdownPreviewRenderOptions {
  theme?: ThemeMode
  showHeadingNumbers?: boolean
  documentPath?: string
  mermaidRenderer?: MermaidRenderer
  onAnchorNavigate?: (slug: string) => void
}

interface PreviewRenderContextValue {
  theme: ThemeMode
  documentPath?: string
  mermaidRenderer?: MermaidRenderer
  onAnchorNavigate?: (slug: string) => void
}

interface SourceLineDataProps {
  'data-source-line'?: string
  'data-source-end-line'?: string
}

const PreviewRenderContext = createContext<PreviewRenderContextValue>({ theme: 'light' })

function decodeSlugSafely(rawSlug: string): string {
  try {
    return decodeURIComponent(rawSlug)
  } catch {
    return rawSlug
  }
}

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

function stripLeadingNumberFromFirstTextLeaf(children: HastRootContent[]): boolean {
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i]
    if (child.type === 'text') {
      if (child.value.length === 0) continue
      const stripped = child.value.replace(LEADING_HEADING_NUMBER_RE, '')
      if (stripped !== child.value) {
        child.value = stripped
        return true
      }
      return false
    }
    if (child.type === 'element' && stripLeadingNumberFromFirstTextLeaf(child.children)) {
      return true
    }
  }
  return false
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

function rehypeHeadingEnhancer(options: { showHeadingNumbers: boolean }) {
  return (tree: HastRoot): void => {
    const slugTracker = createHeadingSlugTracker()
    const numberTracker = createHeadingNumberTracker()

    const visit = (node: HastRoot | HastRootContent): void => {
      if (node.type === 'element' && /^h[1-6]$/.test(node.tagName)) {
        const level = Number(node.tagName[1])
        const fullText = extractHastText(node)
        const slug = slugTracker.next(fullText)
        node.properties = {
          ...node.properties,
          id: slug
        }

        const { number } = numberTracker.next(level)
        if (options.showHeadingNumbers && fullText.trim().length > 0) {
          if (hasHeadingNumberPrefix(fullText)) {
            stripLeadingNumberFromFirstTextLeaf(node.children)
          }
          node.children.unshift({
            type: 'element',
            tagName: 'span',
            properties: {
              className: ['heading-number'],
              ariaHidden: 'true'
            },
            children: [{ type: 'text', value: `${number} ` }]
          })
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
  const { href, onClick, children, ...rest } = props
  const { onAnchorNavigate } = useContext(PreviewRenderContext)
  const isInternalAnchor = typeof href === 'string' && href.startsWith('#')

  return (
    <a
      {...rest}
      href={href}
      rel={href && !isInternalAnchor ? 'noopener noreferrer' : undefined}
      onClick={(event) => {
        event.preventDefault()
        if (isInternalAnchor && href.length > 1) {
          onAnchorNavigate?.(decodeSlugSafely(href.slice(1)))
        }
        onClick?.(event)
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
  const { theme, mermaidRenderer } = useContext(PreviewRenderContext)
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

function buildPreviewProcessor(showHeadingNumbers: boolean) {
  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSanitize, MARKDOWN_SANITIZE_SCHEMA)
    .use(rehypeSourceLineAnnotation)
    .use(rehypeHeadingEnhancer, { showHeadingNumbers })
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

const previewProcessorPlain = buildPreviewProcessor(false)
const previewProcessorNumbered = buildPreviewProcessor(true)

/**
 * Parses GFM Markdown, sanitizes unsafe HTML/URIs, applies dynamic heading numbering & slugs,
 * and renders Mermaid code blocks and safe React elements.
 */
export function renderMarkdownToReact(
  markdown: string,
  options: MarkdownPreviewRenderOptions = {}
): ReactNode {
  const processor = options.showHeadingNumbers ? previewProcessorNumbered : previewProcessorPlain
  const file = processor.processSync(markdown)
  const contextValue: PreviewRenderContextValue = {
    theme: options.theme ?? 'light',
    documentPath: options.documentPath,
    mermaidRenderer: options.mermaidRenderer,
    onAnchorNavigate: options.onAnchorNavigate
  }
  return (
    <PreviewRenderContext.Provider value={contextValue}>
      {file.result as ReactNode}
    </PreviewRenderContext.Provider>
  )
}
