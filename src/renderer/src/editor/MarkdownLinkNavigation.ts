import type { EditorMode } from '../stores/PaneTabStore'
import { decodeSlugSafely, isOffsetInCodeFence } from './MarkdownTocEngine'

export interface LinkClickModifierState {
  button: number
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}

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

/**
 * Determines whether a mouse click should trigger Markdown link navigation in the given editor mode.
 * Preview navigates on primary click, whereas Raw and WYSIWYG require Ctrl/Meta+click so normal
 * clicks continue to move the editing caret.
 */
export function isLinkNavigationClick(mode: EditorMode, event: LinkClickModifierState): boolean {
  if (event.button !== 0 || event.altKey) {
    return false
  }
  if (mode === 'preview') {
    return true
  }
  return event.ctrlKey || event.metaKey
}

function isEscapedAt(text: string, index: number): boolean {
  let backslashes = 0
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) {
    backslashes++
  }
  return backslashes % 2 === 1
}

function findInlineCodeClose(text: string, start: number, limit: number): number {
  let tickCount = 0
  let cursor = start
  while (cursor < limit && text[cursor] === '`') {
    tickCount++
    cursor++
  }

  while (cursor < limit) {
    if (text[cursor] === '`') {
      let run = 0
      while (cursor + run < limit && text[cursor + run] === '`') {
        run++
      }
      if (run === tickCount) {
        return cursor + run
      }
      cursor += run
      continue
    }
    cursor++
  }

  return -1
}

function findLineBoundsAtOffset(
  text: string,
  offset: number
): { lineStart: number; lineEnd: number } {
  const lineStart = offset === 0 ? 0 : text.lastIndexOf('\n', offset - 1) + 1
  const nlIndex = text.indexOf('\n', lineStart)
  const rawLineEnd = nlIndex === -1 ? text.length : nlIndex
  const lineEnd =
    rawLineEnd > lineStart && text[rawLineEnd - 1] === '\r' ? rawLineEnd - 1 : rawLineEnd
  return { lineStart, lineEnd }
}

function findClosingBracket(text: string, openBracket: number, lineEnd: number): number {
  let depth = 1
  let cursor = openBracket + 1
  while (cursor < lineEnd) {
    const ch = text[cursor]
    if (ch === '\\' && cursor + 1 < lineEnd) {
      cursor += 2
      continue
    }
    if (ch === '`') {
      const closed = findInlineCodeClose(text, cursor, lineEnd)
      if (closed !== -1) {
        cursor = closed
        continue
      }
    }
    if (ch === '[') {
      depth++
    } else if (ch === ']') {
      depth--
      if (depth === 0) {
        return cursor
      }
    }
    cursor++
  }
  return -1
}

function skipOptionalTitleAndFindParen(text: string, start: number, lineEnd: number): number {
  let cursor = start
  while (cursor < lineEnd && (text[cursor] === ' ' || text[cursor] === '\t')) {
    cursor++
  }
  if (cursor >= lineEnd) {
    return -1
  }
  if (text[cursor] === ')') {
    return cursor
  }

  const opener = text[cursor]
  if (opener !== '"' && opener !== "'" && opener !== '(') {
    return -1
  }
  const closer = opener === '(' ? ')' : opener
  cursor++
  while (cursor < lineEnd) {
    if (text[cursor] === '\\' && cursor + 1 < lineEnd) {
      cursor += 2
      continue
    }
    if (text[cursor] === closer) {
      cursor++
      break
    }
    cursor++
  }

  while (cursor < lineEnd && (text[cursor] === ' ' || text[cursor] === '\t')) {
    cursor++
  }
  return cursor < lineEnd && text[cursor] === ')' ? cursor : -1
}

function parseLinkDestination(
  text: string,
  openParen: number,
  lineEnd: number
): { href: string; closeParen: number } | null {
  let cursor = openParen + 1
  while (cursor < lineEnd && (text[cursor] === ' ' || text[cursor] === '\t')) {
    cursor++
  }
  if (cursor >= lineEnd) {
    return null
  }

  if (text[cursor] === '<') {
    cursor++
    const hrefStart = cursor
    while (cursor < lineEnd) {
      if (text[cursor] === '\\' && cursor + 1 < lineEnd) {
        cursor += 2
        continue
      }
      if (text[cursor] === '>') {
        const href = text.slice(hrefStart, cursor)
        const closeParen = skipOptionalTitleAndFindParen(text, cursor + 1, lineEnd)
        return closeParen !== -1 ? { href, closeParen } : null
      }
      if (text[cursor] === '<') {
        return null
      }
      cursor++
    }
    return null
  }

  const hrefStart = cursor
  let parenDepth = 1
  while (cursor < lineEnd) {
    const ch = text[cursor]
    if (ch === '\\' && cursor + 1 < lineEnd) {
      cursor += 2
      continue
    }
    if (ch === '(') {
      parenDepth++
      cursor++
      continue
    }
    if (ch === ')') {
      parenDepth--
      if (parenDepth === 0) {
        return { href: text.slice(hrefStart, cursor), closeParen: cursor }
      }
      cursor++
      continue
    }
    if (ch === ' ' || ch === '\t') {
      const href = text.slice(hrefStart, cursor)
      const closeParen = skipOptionalTitleAndFindParen(text, cursor, lineEnd)
      return closeParen !== -1 ? { href, closeParen } : null
    }
    cursor++
  }

  return null
}

/**
 * Extracts the `href` of the inline Markdown link `[label](href)` enclosing `offset` on
 * non-fenced lines, ignoring Markdown images (`![alt](src)`), inline code spans, and fences.
 */
export function extractMarkdownLinkHrefAtOffset(text: string, offset: number): string | null {
  if (offset < 0 || offset > text.length || text.length === 0 || isOffsetInCodeFence(text, offset)) {
    return null
  }

  const { lineStart, lineEnd } = findLineBoundsAtOffset(text, offset)
  if (offset > lineEnd) {
    return null
  }

  let cursor = lineStart
  while (cursor < lineEnd) {
    const ch = text[cursor]
    if (ch === '\\' && cursor + 1 < lineEnd) {
      cursor += 2
      continue
    }
    if (ch === '`') {
      const closed = findInlineCodeClose(text, cursor, lineEnd)
      if (closed !== -1) {
        if (offset >= cursor && offset < closed) {
          return null
        }
        cursor = closed
        continue
      }
    }
    if (ch === '[') {
      const isImage = cursor > lineStart && text[cursor - 1] === '!' && !isEscapedAt(text, cursor - 1)
      if (!isImage) {
        const closeBracket = findClosingBracket(text, cursor, lineEnd)
        if (closeBracket !== -1 && closeBracket + 1 < lineEnd && text[closeBracket + 1] === '(') {
          const parsedDest = parseLinkDestination(text, closeBracket + 1, lineEnd)
          if (parsedDest) {
            const linkTo = parsedDest.closeParen + 1
            if (offset >= cursor && offset < linkTo) {
              return parsedDest.href
            }
            cursor = linkTo
            continue
          }
        }
      }
    }
    cursor++
  }

  return null
}

interface ParsedFsPath {
  rootPrefix: string
  separator: '/' | '\\'
  caseInsensitive: boolean
  segments: string[]
}

function normalizeRawSegments(raw: string): string[] {
  const stack: string[] = []
  for (const part of raw.split(/[/\\]+/)) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (stack.length > 0) stack.pop()
      continue
    }
    stack.push(part)
  }
  return stack
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
      segments: normalizeRawSegments(trimmed.slice(uncMatch[0].length))
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
      segments: normalizeRawSegments(trimmed.slice(winDriveMatch[0].length))
    }
  }

  if (trimmed.startsWith('/')) {
    return {
      rootPrefix: '/',
      separator: '/',
      caseInsensitive: false,
      segments: normalizeRawSegments(trimmed.slice(1))
    }
  }

  return null
}

function segmentsStartWith(
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

  const resolvedSegments = parsedActive.segments.slice(0, -1)
  for (const segment of rawSegments) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (resolvedSegments.length === 0) return outsideWorkspaceError(trimmed)
      resolvedSegments.pop()
      continue
    }
    resolvedSegments.push(segment)
  }

  if (!segmentsStartWith(resolvedSegments, parsedRoot.segments, parsedRoot.caseInsensitive)) {
    return outsideWorkspaceError(trimmed)
  }

  const targetPath =
    parsedRoot.rootPrefix === '/'
      ? `/${resolvedSegments.join('/')}`
      : `${parsedRoot.rootPrefix}${parsedRoot.separator}${resolvedSegments.join(parsedRoot.separator)}`
  const slug = rawFragmentPart !== null ? decodeSlugSafely(rawFragmentPart) : null

  return { kind: 'workspace-file', targetPath, slug }
}
