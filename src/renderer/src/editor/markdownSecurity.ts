import { defaultSchema, type Options as SanitizeSchema } from 'rehype-sanitize'

export const ALLOWED_URI_SCHEMES = ['http', 'https', 'mailto'] as const
const ALLOWED_URI_SCHEME_SET = new Set<string>(ALLOWED_URI_SCHEMES)
const ALLOWED_IMAGE_URI_SCHEMES = new Set<string>(['http', 'https'])

function hasAllowedScheme(url: string, allowedSchemes: ReadonlySet<string>): boolean {
  const normalized = url.replace(/[\u0000-\u0020]+/g, '')
  if (!normalized) {
    return false
  }
  const colonIdx = normalized.indexOf(':')
  if (colonIdx === -1) {
    return true
  }
  const firstSep = normalized.search(/[/?#]/)
  if (firstSep !== -1 && colonIdx > firstSep) {
    return true
  }
  const scheme = normalized.slice(0, colonIdx).toLowerCase()
  return allowedSchemes.has(scheme)
}

/**
 * Validates URLs against safe Markdown schemes (`http`, `https`, `mailto`, or relative paths).
 */
export function isSafeMarkdownUrl(url: string): boolean {
  return hasAllowedScheme(url, ALLOWED_URI_SCHEME_SET)
}

/**
 * Validates image URLs against safe image schemes (`http`, `https`, or relative paths).
 */
export function isSafeMarkdownImageUrl(url: string): boolean {
  return hasAllowedScheme(url, ALLOWED_IMAGE_URI_SCHEMES)
}

/**
 * Shared HTML sanitization policy for both Preview rendering and WYSIWYG HTML sanitization.
 */
export const MARKDOWN_SANITIZE_SCHEMA: SanitizeSchema = {
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
    href: [...ALLOWED_URI_SCHEMES],
    src: ['http', 'https']
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
    dataMarkdownSrc: ['http', 'https']
  }
}
