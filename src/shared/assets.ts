import { classifyImageUri } from './urlSecurity'

export const WIKI_ASSET_SCHEME = 'wiki-asset'
const WIKI_ASSET_HOST = 'local'
const WIKI_ASSET_PATHNAME = '/asset'

const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif'
}

const MIME_TYPE_EXTENSIONS: Record<string, string> = Object.entries(IMAGE_MIME_TYPES).reduce<
  Record<string, string>
>((acc, [ext, mime]) => {
  if (!(mime in acc)) {
    acc[mime] = ext
  }
  return acc
}, {})

export type WorkspaceImageIngestSource =
  | { kind: 'clipboard'; bytes: Uint8Array; mimeType: string; now?: number }
  | { kind: 'filePath'; filePath: string }
  | { kind: 'fileBytes'; fileName: string; bytes: Uint8Array }

export interface WorkspaceImageIngestInput {
  documentPath: string
  source: WorkspaceImageIngestSource
}

export interface WorkspaceImageIngestResult {
  markdownPath: string
  altText: string
  savedPath: string
}

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

/**
 * Resolves a MIME type (stripping parameters such as charset) to its canonical image extension.
 */
export function getImageExtensionForMimeType(mimeType: string): string | null {
  const normalized = mimeType.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  return normalized && Object.prototype.hasOwnProperty.call(MIME_TYPE_EXTENSIONS, normalized)
    ? MIME_TYPE_EXTENSIONS[normalized]
    : null
}

export function isSupportedImageMimeType(mimeType: string): boolean {
  return getImageExtensionForMimeType(mimeType) !== null
}

export function isSupportedImageFile(filePath: string): boolean {
  return getImageMimeType(filePath) !== null
}

/**
 * Percent-encodes `%`, whitespace/control chars, and CommonMark/URI delimiters inside a single path segment.
 */
export function encodeMarkdownImagePathSegment(segment: string): string {
  if (segment === '.' || segment === '..') {
    return segment
  }
  // eslint-disable-next-line no-control-regex -- intentionally escape ASCII control chars inside Markdown URI destinations
  return segment.replace(/[\u0000-\u0020\u007f%()[\]<>"'`\\#?{}|^]/g, (ch) => {
    return `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`
  })
}

/**
 * Converts a POSIX relative path into a normalized `./` or `../` CommonMark-safe destination.
 */
export function toMarkdownRelativeImagePath(relativePosixPath: string): string {
  const encodedSegments = relativePosixPath
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeMarkdownImagePathSegment(segment))
  const joined = encodedSegments.join('/')
  if (!joined) {
    return ''
  }
  if (
    joined === '.' ||
    joined === '..' ||
    joined.startsWith('./') ||
    joined.startsWith('../')
  ) {
    return joined
  }
  return `./${joined}`
}

/**
 * Formats an ingested image result as an escaped Markdown image token.
 */
export function formatMarkdownImage(
  image: Pick<WorkspaceImageIngestResult, 'altText' | 'markdownPath'>
): string {
  const safeAlt = image.altText.replace(/\r?\n+/g, ' ').replace(/([[\]])/g, '\\$1')
  return `![${safeAlt}](${image.markdownPath})`
}

export function buildWikiAssetUrl(filePath: string, cacheKey?: string | number): string {
  const baseUrl = `${WIKI_ASSET_SCHEME}://${WIKI_ASSET_HOST}${WIKI_ASSET_PATHNAME}?path=${encodeURIComponent(filePath)}`
  if (cacheKey === undefined || cacheKey === '') {
    return baseUrl
  }
  return `${baseUrl}&v=${encodeURIComponent(String(cacheKey))}`
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

export function safeDecodeUriComponent(value: string): string {
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

function resolveValidatedRelativePath(trimmedSrc: string, documentPath: string): string | null {
  const pathPart = trimmedSrc.split(/[?#]/, 1)[0]
  if (!pathPart) {
    return null
  }

  const decodedPath = safeDecodeUriComponent(pathPart)
  if (classifyImageUri(decodedPath).kind !== 'relative') {
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
  const classified = classifyImageUri(rawSrc)
  if (classified.kind === 'unsafe') {
    return ''
  }
  if (classified.kind === 'external' || !documentPath) {
    return rawSrc
  }
  const resolvedPath = resolveValidatedRelativePath(classified.path, documentPath)
  return resolvedPath ? buildWikiAssetUrl(resolvedPath) : ''
}
