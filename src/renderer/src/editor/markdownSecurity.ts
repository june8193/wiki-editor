import { defaultSchema, type Options as SanitizeSchema } from 'rehype-sanitize'
import { ALLOWED_IMAGE_URI_SCHEMES, hasAllowedUriScheme } from '@shared/urlSecurity'

export const ALLOWED_URI_SCHEMES = ['http', 'https', 'mailto'] as const
const ALLOWED_URI_SCHEME_SET = new Set<string>(ALLOWED_URI_SCHEMES)

/**
 * Validates URLs against safe Markdown schemes (`http`, `https`, `mailto`, or relative paths).
 */
export function isSafeMarkdownUrl(url: string): boolean {
  return hasAllowedUriScheme(url, ALLOWED_URI_SCHEME_SET)
}

const baseCodeAttributes = (defaultSchema.attributes?.code ?? []).filter(
  (attr) => attr !== 'className' && !(Array.isArray(attr) && attr[0] === 'className')
)

/**
 * Shared HTML sanitization policy for both Preview rendering and WYSIWYG HTML sanitization.
 */
export const MARKDOWN_SANITIZE_SCHEMA: SanitizeSchema = {
  ...defaultSchema,
  strip: [...(defaultSchema.strip ?? ['script']), 'style', 'iframe', 'object', 'embed'],
  attributes: {
    ...defaultSchema.attributes,
    code: [...baseCodeAttributes, ['className', /^language-[\w+#.-]+$/]],
    th: [...(defaultSchema.attributes?.th ?? []), 'align'],
    td: [...(defaultSchema.attributes?.td ?? []), 'align'],
    input: ['disabled', 'checked', ['type', 'checkbox']]
  },
  protocols: {
    ...defaultSchema.protocols,
    href: [...ALLOWED_URI_SCHEMES],
    src: [...ALLOWED_IMAGE_URI_SCHEMES]
  }
}

/**
 * WYSIWYG clipboard HTML sanitization schema preserving lossless `data-markdown-src` on safe URLs
 * without opening `wiki-asset:` or other unsafe protocols.
 */
export const WYSIWYG_SANITIZE_SCHEMA: SanitizeSchema = {
  ...MARKDOWN_SANITIZE_SCHEMA,
  attributes: {
    ...MARKDOWN_SANITIZE_SCHEMA.attributes,
    img: [...(MARKDOWN_SANITIZE_SCHEMA.attributes?.img ?? []), 'dataMarkdownSrc']
  },
  protocols: {
    ...MARKDOWN_SANITIZE_SCHEMA.protocols,
    dataMarkdownSrc: [...ALLOWED_IMAGE_URI_SCHEMES]
  }
}
