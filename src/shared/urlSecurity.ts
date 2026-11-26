export const ALLOWED_HTTP_URI_SCHEMES = ['http', 'https'] as const
export const ALLOWED_HTTP_URI_SCHEME_SET: ReadonlySet<string> = new Set(ALLOWED_HTTP_URI_SCHEMES)
export const ALLOWED_IMAGE_URI_SCHEMES = ALLOWED_HTTP_URI_SCHEMES
export const ALLOWED_IMAGE_URI_SCHEME_SET = ALLOWED_HTTP_URI_SCHEME_SET

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_PATTERN = /[\u0000-\u001F\u007F]/

/**
 * Inspects a URL for control characters and extracts any lowercased URI scheme
 * (returning `scheme: null` for relative URLs without a scheme before `[/?#]`).
 */
export function inspectUriScheme(url: string): { valid: boolean; scheme: string | null } {
  const normalized = url.replace(/[\u0000-\u0020]+/g, '')
  if (!normalized || CONTROL_CHAR_PATTERN.test(url)) {
    return { valid: false, scheme: null }
  }
  const colonIdx = normalized.indexOf(':')
  if (colonIdx === -1) {
    return { valid: true, scheme: null }
  }
  const firstSep = normalized.search(/[/?#]/)
  if (firstSep !== -1 && colonIdx > firstSep) {
    return { valid: true, scheme: null }
  }
  return { valid: true, scheme: normalized.slice(0, colonIdx).toLowerCase() }
}

/**
 * Validates URLs against an allowed URI scheme set (relative URLs without a scheme are permitted).
 */
export function hasAllowedUriScheme(url: string, allowedSchemes: ReadonlySet<string>): boolean {
  const { valid, scheme } = inspectUriScheme(url)
  if (!valid) {
    return false
  }
  return scheme === null || allowedSchemes.has(scheme)
}

/**
 * Rejects root-absolute (`/...`, `\...`), protocol-relative (`//...`, `\\...`),
 * and fragment/query-only (`#...`, `?...`) targets when expecting a local relative file path.
 */
function isDisallowedRelativePath(value: string): boolean {
  return (
    value.startsWith('/') ||
    value.startsWith('\\') ||
    value.startsWith('#') ||
    value.startsWith('?')
  )
}

export type ClassifiedImageUri =
  | { kind: 'unsafe' }
  | { kind: 'external' }
  | { kind: 'relative'; path: string }

/**
 * Classifies an image URI as unsafe, an allowed external (`http`/`https`) URL, or a local relative path.
 */
export function classifyImageUri(url: string): ClassifiedImageUri {
  const trimmed = url.trim()
  const { valid, scheme } = inspectUriScheme(trimmed)
  if (!valid) {
    return { kind: 'unsafe' }
  }
  if (scheme !== null) {
    return ALLOWED_IMAGE_URI_SCHEME_SET.has(scheme) ? { kind: 'external' } : { kind: 'unsafe' }
  }
  if (isDisallowedRelativePath(trimmed)) {
    return { kind: 'unsafe' }
  }
  return { kind: 'relative', path: trimmed }
}

/**
 * Validates image destinations against `http`, `https`, or local relative asset paths.
 */
export function isSafeImageUri(url: string): boolean {
  return classifyImageUri(url).kind !== 'unsafe'
}

/**
 * Validates and trims an external `http://` or `https://` URL, rejecting non-strings,
 * control characters, disallowed schemes, and malformed URLs without a valid host.
 */
export function normalizeAllowedHttpUrl(rawUrl: unknown): string | null {
  if (typeof rawUrl !== 'string') return null
  const trimmed = rawUrl.trim()
  if (!trimmed || /^https?:\/\/(?:[/?#]|$)/i.test(trimmed)) return null
  const { valid, scheme } = inspectUriScheme(trimmed)
  if (!valid || !scheme || !ALLOWED_HTTP_URI_SCHEME_SET.has(scheme)) {
    return null
  }
  try {
    const parsed = new URL(trimmed)
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.hostname.length === 0) {
      return null
    }
    return trimmed
  } catch {
    return null
  }
}
