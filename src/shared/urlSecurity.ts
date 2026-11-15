export const ALLOWED_IMAGE_URI_SCHEMES = ['http', 'https'] as const
export const ALLOWED_IMAGE_URI_SCHEME_SET: ReadonlySet<string> = new Set(ALLOWED_IMAGE_URI_SCHEMES)

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
export function isDisallowedRelativePath(value: string): boolean {
  return (
    value.startsWith('/') ||
    value.startsWith('\\') ||
    value.startsWith('#') ||
    value.startsWith('?')
  )
}

/**
 * Validates image destinations against `http`, `https`, or local relative asset paths.
 */
export function isSafeImageUri(url: string): boolean {
  const trimmed = url.trim()
  const { valid, scheme } = inspectUriScheme(trimmed)
  if (!valid) {
    return false
  }
  if (scheme !== null) {
    return ALLOWED_IMAGE_URI_SCHEME_SET.has(scheme)
  }
  return !isDisallowedRelativePath(trimmed)
}
