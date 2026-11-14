import { ComponentPropsWithoutRef, ReactNode } from 'react'
import { Fragment, jsx, jsxs } from 'react/jsx-runtime'
import rehypeRaw from 'rehype-raw'
import rehypeReact from 'rehype-react'
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'

export const PREVIEW_SANITIZE_SCHEMA: SanitizeSchema = {
  ...defaultSchema,
  strip: [...(defaultSchema.strip ?? ['script']), 'style', 'iframe', 'object', 'embed'],
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code ?? []), ['className', /^language-[\w-]+$/]],
    th: [...(defaultSchema.attributes?.th ?? []), 'align'],
    td: [...(defaultSchema.attributes?.td ?? []), 'align'],
    input: ['disabled', 'checked', ['type', 'checkbox']]
  },
  protocols: {
    ...defaultSchema.protocols,
    href: ['http', 'https', 'mailto'],
    src: ['http', 'https']
  }
}

function SafeLink(props: ComponentPropsWithoutRef<'a'>) {
  const { href, onClick, children, ...rest } = props
  return (
    <a
      {...rest}
      href={href}
      rel={href ? 'noopener noreferrer' : undefined}
      onClick={(event) => {
        event.preventDefault()
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

function PreviewTable(props: ComponentPropsWithoutRef<'table'>) {
  return (
    <div className="md-table-wrapper">
      <table {...props} />
    </div>
  )
}

const previewProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeSanitize, PREVIEW_SANITIZE_SCHEMA)
  .use(rehypeReact, {
    Fragment,
    jsx,
    jsxs,
    components: {
      a: SafeLink,
      input: PreviewCheckbox,
      table: PreviewTable
    }
  })

/**
 * Parses GFM Markdown, sanitizes unsafe HTML/URIs, and renders safe React elements.
 */
export function renderMarkdownToReact(markdown: string): ReactNode {
  const file = previewProcessor.processSync(markdown)
  return file.result as ReactNode
}
