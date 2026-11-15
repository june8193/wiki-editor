export const WIKI_ASSET_SCHEME = 'wiki-asset'
export const WIKI_ASSET_HOST = 'local'
export const WIKI_ASSET_PATHNAME = '/asset'

export const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif'
}

export const SUPPORTED_IMAGE_EXTENSIONS: readonly string[] = Object.keys(IMAGE_MIME_TYPES)

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_PATTERN = /[\u0000-\u001F\u007F]/
const URI_SCHEME_PATTERN = /^([a-zA-Z][a-zA-Z0-9+.-]*):/

export function getImageMimeType(filePath: string): string | null {
  const fileName = filePath.split(/[\\/]/).pop() ?? ''
  const dotIndex = fileName.lastIndexOf('.')
  if (dotIndex <= 0) {
    return null
  }
  const ext = fileName.slice(dotIndex).toLowerCase()
  return Object.prototype.hasOwnProperty.call(IMAGE_MIME_TYPES, ext)
    ? IMAGE_MIME_TYPES[ext]
    : null
}

export function isSupportedImagePath(filePath: string): boolean {
  return getImageMimeType(filePath) !== null
}

export function buildWikiAssetUrl(filePath: string): string {
  return `${WIKI_ASSET_SCHEME}://${WIKI_ASSET_HOST}${WIKI_ASSET_PATHNAME}?path=${encodeURIComponent(filePath)}`
}

export function parseWikiAssetUrl(rawUrl: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return null
  }

  if (
    parsed.protocol !== `${WIKI_ASSET_SCHEME}:` ||
    parsed.hostname.toLowerCase() !== WIKI_ASSET_HOST ||
    parsed.pathname !== WIKI_ASSET_PATHNAME
  ) {
    return null
  }

  const targetPath = parsed.searchParams.get('path')
  if (!targetPath || targetPath.includes('\0')) {
    return null
  }

  return targetPath
}

function safeDecodeUriComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function splitRootAndSegments(filePath: string): {
  rootPrefix: string
  segments: string[]
  useBackslash: boolean
} {
  const useBackslash = /^[a-zA-Z]:\\/.test(filePath) || filePath.startsWith('\\\\')
  const posixLike = filePath.replace(/\\/g, '/')

  let rootPrefix = ''
  let remainder = posixLike

  const uncMatch = /^\/\/[^/]+\/[^/]+\//.exec(posixLike)
  if (uncMatch) {
    rootPrefix = uncMatch[0]
    remainder = posixLike.slice(rootPrefix.length)
  } else {
    const driveMatch = /^[a-zA-Z]:\//.exec(posixLike)
    if (driveMatch) {
      rootPrefix = driveMatch[0]
      remainder = posixLike.slice(rootPrefix.length)
    } else if (posixLike.startsWith('/')) {
      rootPrefix = '/'
      remainder = posixLike.slice(1)
    }
  }

  return {
    rootPrefix,
    segments: remainder.split('/').filter(Boolean),
    useBackslash
  }
}

function isDisallowedRelativeTarget(value: string): boolean {
  if (!value || CONTROL_CHAR_PATTERN.test(value)) {
    return true
  }
  if (
    value.startsWith('/') ||
    value.startsWith('\\') ||
    value.startsWith('#') ||
    value.startsWith('?')
  ) {
    return true
  }
  return URI_SCHEME_PATTERN.test(value)
}

export function resolveWorkspaceImagePath(rawSrc: string, documentPath: string): string | null {
  const trimmed = rawSrc.trim()
  if (isDisallowedRelativeTarget(trimmed) || !documentPath) {
    return null
  }

  const pathPart = trimmed.split(/[?#]/, 1)[0]
  if (!pathPart) {
    return null
  }

  const decodedPath = safeDecodeUriComponent(pathPart)
  if (isDisallowedRelativeTarget(decodedPath)) {
    return null
  }

  const { rootPrefix, segments, useBackslash } = splitRootAndSegments(documentPath)
  const dirSegments = segments.slice(0, -1)

  for (const segment of decodedPath.replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') {
      continue
    }
    if (segment === '..') {
      if (dirSegments.length > 0) {
        dirSegments.pop()
      }
      continue
    }
    dirSegments.push(segment)
  }

  const joined = `${rootPrefix}${dirSegments.join('/')}`
  return useBackslash ? joined.replace(/\//g, '\\') : joined
}

export function resolveImageDisplaySrc(rawSrc: string, documentPath?: string): string {
  const trimmed = rawSrc.trim()
  if (!trimmed || CONTROL_CHAR_PATTERN.test(trimmed)) {
    return ''
  }

  const schemeMatch = URI_SCHEME_PATTERN.exec(trimmed)
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase()
    if (scheme === 'http' || scheme === 'https') {
      return rawSrc
    }
    return ''
  }

  if (documentPath) {
    const resolvedPath = resolveWorkspaceImagePath(trimmed, documentPath)
    if (resolvedPath) {
      return buildWikiAssetUrl(resolvedPath)
    }
  }

  return rawSrc
}
