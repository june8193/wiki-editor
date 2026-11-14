import { ComponentPropsWithoutRef, ReactNode } from 'react'
import { Fragment, jsx, jsxs } from 'react/jsx-runtime'
import rehypeRaw from 'rehype-raw'
import rehypeReact from 'rehype-react'
import rehypeSanitize from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'
import { MARKDOWN_SANITIZE_SCHEMA } from './markdownSecurity'

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
  .use(rehypeSanitize, MARKDOWN_SANITIZE_SCHEMA)
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
