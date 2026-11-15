import { decodeSlugSafely } from './MarkdownTocEngine'

export interface MarkdownLinkContext {
  workspaceRootPath: string | null
  activeFilePath: string | null
}

export type ResolvedMarkdownLinkTarget =
  | { kind: 'external' }
  | { kind: 'same-doc-section'; slug: string }
  | { kind: 'workspace-file'; targetPath: string; slug: string | null }
  | { kind: 'error'; message: string }

const EXTERNAL_SCHEME_REGEX = /^(https?:|mailto:)/i
const URI_SCHEME_REGEX = /^([a-zA-Z][a-zA-Z0-9+.-]{1,}):/
const WINDOWS_DRIVE_PREFIX_REGEX = /^([a-zA-Z]:)([/\\]?)/
const UNC_PREFIX_REGEX = /^([/\\]{2}[^/\\]+[/\\][^/\\]+)([/\\]?)/

interface ParsedFsPath {
  rootPrefix: string
  separator: '/' | '\\'
  caseInsensitive: boolean
  segments: string[]
}

function resolveSegmentStack(
  rawSegments: readonly string[],
  initialStack: readonly string[] = []
): { segments: string[]; underflowed: boolean } {
  const segments = [...initialStack]
  let underflowed = false
  for (const segment of rawSegments) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) {
        underflowed = true
        continue
      }
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return { segments, underflowed }
}

function parseFsPath(inputPath: string): ParsedFsPath | null {
  const trimmed = inputPath.trim()
  if (trimmed.length === 0) return null

  const uncMatch = trimmed.match(UNC_PREFIX_REGEX)
  if (uncMatch) {
    return {
      rootPrefix: uncMatch[1].replace(/\//g, '\\'),
      separator: '\\',
      caseInsensitive: true,
      segments: resolveSegmentStack(trimmed.slice(uncMatch[0].length).split(/[/\\]+/)).segments
    }
  }

  const winDriveMatch = trimmed.match(WINDOWS_DRIVE_PREFIX_REGEX)
  if (winDriveMatch) {
    const separator: '/' | '\\' = trimmed.includes('\\')
      ? '\\'
      : winDriveMatch[2] === '\\'
        ? '\\'
        : '/'
    return {
      rootPrefix: winDriveMatch[1],
      separator,
      caseInsensitive: true,
      segments: resolveSegmentStack(trimmed.slice(winDriveMatch[0].length).split(/[/\\]+/)).segments
    }
  }

  if (trimmed.startsWith('/')) {
    return {
      rootPrefix: '/',
      separator: '/',
      caseInsensitive: false,
      segments: resolveSegmentStack(trimmed.slice(1).split(/[/\\]+/)).segments
    }
  }

  return null
}

function isStrictDescendantSegments(
  target: readonly string[],
  root: readonly string[],
  caseInsensitive: boolean
): boolean {
  if (target.length <= root.length) return false
  for (let i = 0; i < root.length; i++) {
    const left = caseInsensitive ? target[i].toLowerCase() : target[i]
    const right = caseInsensitive ? root[i].toLowerCase() : root[i]
    if (left !== right) return false
  }
  return true
}

function hasAbsoluteOrDrivePrefix(value: string): boolean {
  return (
    WINDOWS_DRIVE_PREFIX_REGEX.test(value) || value.startsWith('/') || value.startsWith('\\')
  )
}

function outsideWorkspaceError(targetHref: string): ResolvedMarkdownLinkTarget {
  return {
    kind: 'error',
    message: `워크스페이스 루트 밖의 경로에는 접근할 수 없습니다: ${targetHref}`
  }
}

function unwrapLinkHref(rawHref: string): string {
  const trimmed = rawHref.trim()
  if (trimmed.startsWith('<') && trimmed.endsWith('>') && trimmed.length >= 2) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

/**
 * Classifies and resolves a Markdown link target (external URL, same-document `#slug`, or
 * workspace-relative file link with optional `#slug`), rejecting workspace escapes and malformed paths.
 */
export function resolveMarkdownLinkTarget(
  rawHref: string,
  context: MarkdownLinkContext
): ResolvedMarkdownLinkTarget {
  const trimmed = unwrapLinkHref(rawHref)
  if (trimmed.length === 0) {
    return { kind: 'error', message: '링크 대상을 찾을 수 없습니다.' }
  }
  if (EXTERNAL_SCHEME_REGEX.test(trimmed)) {
    return { kind: 'external' }
  }
  if (hasAbsoluteOrDrivePrefix(trimmed)) {
    return outsideWorkspaceError(trimmed)
  }
  if (URI_SCHEME_REGEX.test(trimmed)) {
    return { kind: 'error', message: `지원하지 않는 링크 형식입니다: ${trimmed}` }
  }

  if (trimmed.startsWith('#')) {
    const slug = decodeSlugSafely(trimmed.slice(1))
    if (slug.trim().length === 0) {
      return { kind: 'error', message: '섹션을 찾을 수 없습니다: #' }
    }
    return { kind: 'same-doc-section', slug }
  }

  const hashIndex = trimmed.indexOf('#')
  const rawPathPart = hashIndex >= 0 ? trimmed.slice(0, hashIndex) : trimmed
  const rawFragmentPart = hashIndex >= 0 ? trimmed.slice(hashIndex + 1) : null

  let decodedPathPart: string
  try {
    decodedPathPart = decodeURIComponent(rawPathPart)
  } catch {
    return { kind: 'error', message: `잘못된 링크 경로입니다: ${trimmed}` }
  }

  const rawSegments = decodedPathPart.split(/[/\\]+/)
  const lastRawSegment = rawSegments[rawSegments.length - 1]
  if (
    decodedPathPart.length === 0 ||
    decodedPathPart.includes('\0') ||
    decodedPathPart.endsWith('/') ||
    decodedPathPart.endsWith('\\') ||
    lastRawSegment === '.' ||
    lastRawSegment === '..'
  ) {
    return { kind: 'error', message: `대상 파일을 찾을 수 없습니다: ${trimmed}` }
  }
  if (hasAbsoluteOrDrivePrefix(decodedPathPart)) {
    return outsideWorkspaceError(trimmed)
  }
  if (!context.workspaceRootPath || !context.activeFilePath) {
    return { kind: 'error', message: '현재 문서 경로를 확인할 수 없습니다.' }
  }

  const parsedRoot = parseFsPath(context.workspaceRootPath)
  const parsedActive = parseFsPath(context.activeFilePath)
  if (!parsedRoot || !parsedActive) {
    return outsideWorkspaceError(trimmed)
  }
  const sameRootPrefix =
    parsedRoot.caseInsensitive || parsedActive.caseInsensitive
      ? parsedRoot.rootPrefix.toLowerCase() === parsedActive.rootPrefix.toLowerCase()
      : parsedRoot.rootPrefix === parsedActive.rootPrefix
  if (!sameRootPrefix) {
    return outsideWorkspaceError(trimmed)
  }

  const { segments: resolvedSegments, underflowed } = resolveSegmentStack(
    rawSegments,
    parsedActive.segments.slice(0, -1)
  )
  if (
    underflowed ||
    !isStrictDescendantSegments(resolvedSegments, parsedRoot.segments, parsedRoot.caseInsensitive)
  ) {
    return outsideWorkspaceError(trimmed)
  }

  const targetPath =
    parsedRoot.rootPrefix === '/'
      ? `/${resolvedSegments.join('/')}`
      : `${parsedRoot.rootPrefix}${parsedRoot.separator}${resolvedSegments.join(parsedRoot.separator)}`
  const slug = rawFragmentPart !== null ? decodeSlugSafely(rawFragmentPart) : null

  return { kind: 'workspace-file', targetPath, slug }
}
