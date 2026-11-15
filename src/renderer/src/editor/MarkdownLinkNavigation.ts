import type { EditorMode } from '../stores/PaneTabStore'
import { type MarkdownHeading, parseMarkdownHeadings } from './MarkdownTocEngine'

export interface LinkClickModifierState {
  button: number
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}

export interface MarkdownInlineLinkMatch {
  href: string
  from: number
  to: number
}

export interface MarkdownLinkContext {
  workspaceRootPath: string | null
  activeFilePath: string | null
}

export type MarkdownLinkErrorReason =
  | 'empty-target'
  | 'missing-context'
  | 'invalid-path'
  | 'outside-workspace'
  | 'unsupported-scheme'

export type ResolvedMarkdownLinkTarget =
  | {
      kind: 'external'
      href: string
    }
  | {
      kind: 'same-doc-section'
      slug: string
      rawHref: string
    }
  | {
      kind: 'workspace-file'
      targetPath: string
      slug: string | null
      rawHref: string
    }
  | {
      kind: 'error'
      reason: MarkdownLinkErrorReason
      message: string
      rawHref: string
    }

export interface MarkdownHeadingTarget {
  heading: MarkdownHeading
  index: number
}

const EXTERNAL_SCHEME_REGEX = /^(https?:|mailto:)/i
const URI_SCHEME_REGEX = /^([a-zA-Z][a-zA-Z0-9+.-]{1,}):/
const WINDOWS_DRIVE_PREFIX_REGEX = /^([a-zA-Z]:)([/\\]?)/
const UNC_PREFIX_REGEX = /^([/\\]{2}[^/\\]+[/\\][^/\\]+)([/\\]?)/

/**
 * Determines whether a mouse click should trigger Markdown link navigation in the given editor mode.
 * Preview navigates on primary click, whereas Raw and WYSIWYG require Ctrl/Meta+click so normal
 * clicks continue to move the editing caret.
 */
export function isLinkNavigationClick(
  mode: EditorMode | 'unsupported',
  event: LinkClickModifierState
): boolean {
  if (event.button !== 0 || event.altKey) {
    return false
  }
  if (mode === 'preview') {
    return true
  }
  if (mode === 'raw' || mode === 'wysiwyg') {
    return event.ctrlKey || event.metaKey
  }
  return false
}

export function decodeSlugSafely(rawSlug: string): string {
  try {
    return decodeURIComponent(rawSlug)
  } catch {
    return rawSlug
  }
}

function countPrecedingBackslashes(text: string, index: number): number {
  let count = 0
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) {
    count++
  }
  return count
}

function isEscapedAt(text: string, index: number): boolean {
  return countPrecedingBackslashes(text, index) % 2 === 1
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

function parseOpeningFence(line: string): { marker: '`' | '~'; length: number } | null {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
  if (!match) {
    return null
  }
  const fence = match[1]
  const marker = fence[0] as '`' | '~'
  const info = match[2]
  if (marker === '`' && info.includes('`')) {
    return null
  }
  return { marker, length: fence.length }
}

function isClosingFence(line: string, marker: '`' | '~', openLength: number): boolean {
  const trimmed = line.match(/^ {0,3}(`+|~+)[ \t]*$/)
  if (!trimmed) {
    return false
  }
  const fence = trimmed[1]
  return fence[0] === marker && fence.length >= openLength
}

function findLineBoundsWithFenceState(
  text: string,
  offset: number
): { lineStart: number; lineEnd: number; isFenced: boolean } {
  let pos = 0
  let activeFence: { marker: '`' | '~'; length: number } | null = null

  while (pos <= text.length) {
    const nlIndex = text.indexOf('\n', pos)
    const rawLineEnd = nlIndex === -1 ? text.length : nlIndex
    const lineContentEnd =
      rawLineEnd > pos && text[rawLineEnd - 1] === '\r' ? rawLineEnd - 1 : rawLineEnd
    const line = text.slice(pos, lineContentEnd)

    let lineIsFenced = activeFence !== null
    if (activeFence === null) {
      const opening = parseOpeningFence(line)
      if (opening) {
        activeFence = opening
        lineIsFenced = true
      }
    } else if (isClosingFence(line, activeFence.marker, activeFence.length)) {
      activeFence = null
      lineIsFenced = true
    }

    const nextLineStart = nlIndex === -1 ? text.length + 1 : nlIndex + 1
    if (offset >= pos && offset <= rawLineEnd) {
      return {
        lineStart: pos,
        lineEnd: lineContentEnd,
        isFenced: lineIsFenced
      }
    }

    if (nlIndex === -1) {
      break
    }
    pos = nextLineStart
  }

  return { lineStart: 0, lineEnd: 0, isFenced: false }
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

function skipOptionalTitleAndFindParen(
  text: string,
  start: number,
  lineEnd: number
): number {
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
        return {
          href: text.slice(hrefStart, cursor),
          closeParen: cursor
        }
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
 * Finds the inline Markdown link `[label](href)` enclosing `offset` on non-fenced lines,
 * ignoring Markdown images (`![alt](src)`), inline code spans, and fenced code blocks.
 */
export function extractMarkdownLinkAtOffset(
  text: string,
  offset: number
): MarkdownInlineLinkMatch | null {
  if (offset < 0 || offset > text.length || text.length === 0) {
    return null
  }

  const { lineStart, lineEnd, isFenced } = findLineBoundsWithFenceState(text, offset)
  if (isFenced || offset > lineEnd) {
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
      const precededByBang = cursor > lineStart && text[cursor - 1] === '!'
      const isImage = precededByBang && !isEscapedAt(text, cursor - 1)
      if (!isImage) {
        const closeBracket = findClosingBracket(text, cursor, lineEnd)
        if (closeBracket !== -1 && closeBracket + 1 < lineEnd && text[closeBracket + 1] === '(') {
          const parsedDest = parseLinkDestination(text, closeBracket + 1, lineEnd)
          if (parsedDest) {
            const linkTo = parsedDest.closeParen + 1
            if (offset >= cursor && offset < linkTo) {
              return {
                href: parsedDest.href,
                from: cursor,
                to: linkTo
              }
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

function parseFsPath(inputPath: string): ParsedFsPath | null {
  const trimmed = inputPath.trim()
  if (trimmed.length === 0) {
    return null
  }

  const uncMatch = trimmed.match(UNC_PREFIX_REGEX)
  if (uncMatch) {
    const prefix = uncMatch[1].replace(/\//g, '\\')
    const rest = trimmed.slice(uncMatch[0].length)
    return {
      rootPrefix: prefix,
      separator: '\\',
      caseInsensitive: true,
      segments: normalizeRawSegments(rest)
    }
  }

  const winDriveMatch = trimmed.match(WINDOWS_DRIVE_PREFIX_REGEX)
  if (winDriveMatch) {
    const drivePrefix = winDriveMatch[1]
    const separator: '/' | '\\' = trimmed.includes('\\') && !trimmed.includes('/') ? '\\' : winDriveMatch[2] === '\\' ? '\\' : '/'
    const rest = trimmed.slice(winDriveMatch[0].length)
    return {
      rootPrefix: drivePrefix,
      separator: trimmed.includes('\\') ? '\\' : separator,
      caseInsensitive: true,
      segments: normalizeRawSegments(rest)
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

function normalizeRawSegments(raw: string): string[] {
  const stack: string[] = []
  for (const part of raw.split(/[/\\]+/)) {
    if (part === '' || part === '.') {
      continue
    }
    if (part === '..') {
      if (stack.length > 0) {
        stack.pop()
      }
      continue
    }
    stack.push(part)
  }
  return stack
}

function formatParsedFsPath(parsed: ParsedFsPath, segments: readonly string[]): string {
  if (parsed.rootPrefix === '/') {
    return `/${segments.join('/')}`
  }
  return `${parsed.rootPrefix}${parsed.separator}${segments.join(parsed.separator)}`
}

function segmentsStartWith(
  target: readonly string[],
  root: readonly string[],
  caseInsensitive: boolean
): boolean {
  if (target.length <= root.length) {
    return false
  }
  for (let i = 0; i < root.length; i++) {
    const left = caseInsensitive ? target[i].toLowerCase() : target[i]
    const right = caseInsensitive ? root[i].toLowerCase() : root[i]
    if (left !== right) {
      return false
    }
  }
  return true
}

function prefixesEqual(left: ParsedFsPath, right: ParsedFsPath): boolean {
  if (left.caseInsensitive || right.caseInsensitive) {
    return left.rootPrefix.toLowerCase() === right.rootPrefix.toLowerCase()
  }
  return left.rootPrefix === right.rootPrefix
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
    return {
      kind: 'error',
      reason: 'empty-target',
      message: '링크 대상을 찾을 수 없습니다.',
      rawHref: trimmed
    }
  }

  if (EXTERNAL_SCHEME_REGEX.test(trimmed)) {
    return {
      kind: 'external',
      href: trimmed
    }
  }

  if (
    WINDOWS_DRIVE_PREFIX_REGEX.test(trimmed) ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('\\')
  ) {
    return {
      kind: 'error',
      reason: 'outside-workspace',
      message: `워크스페이스 루트 밖의 경로에는 접근할 수 없습니다: ${trimmed}`,
      rawHref: trimmed
    }
  }

  if (URI_SCHEME_REGEX.test(trimmed)) {
    return {
      kind: 'error',
      reason: 'unsupported-scheme',
      message: `지원하지 않는 링크 형식입니다: ${trimmed}`,
      rawHref: trimmed
    }
  }

  if (trimmed.startsWith('#')) {
    const rawFragment = trimmed.slice(1)
    const slug = decodeSlugSafely(rawFragment)
    if (slug.trim().length === 0) {
      return {
        kind: 'error',
        reason: 'empty-target',
        message: '섹션을 찾을 수 없습니다: #',
        rawHref: trimmed
      }
    }
    return {
      kind: 'same-doc-section',
      slug,
      rawHref: trimmed
    }
  }

  const hashIndex = trimmed.indexOf('#')
  const rawPathPart = hashIndex >= 0 ? trimmed.slice(0, hashIndex) : trimmed
  const rawFragmentPart = hashIndex >= 0 ? trimmed.slice(hashIndex + 1) : null

  let decodedPathPart: string
  try {
    decodedPathPart = decodeURIComponent(rawPathPart)
  } catch {
    return {
      kind: 'error',
      reason: 'invalid-path',
      message: `잘못된 링크 경로입니다: ${trimmed}`,
      rawHref: trimmed
    }
  }

  if (
    decodedPathPart.length === 0 ||
    decodedPathPart.includes('\0') ||
    decodedPathPart.endsWith('/') ||
    decodedPathPart.endsWith('\\')
  ) {
    return {
      kind: 'error',
      reason: 'invalid-path',
      message: `대상 파일을 찾을 수 없습니다: ${trimmed}`,
      rawHref: trimmed
    }
  }

  if (
    WINDOWS_DRIVE_PREFIX_REGEX.test(decodedPathPart) ||
    decodedPathPart.startsWith('/') ||
    decodedPathPart.startsWith('\\')
  ) {
    return {
      kind: 'error',
      reason: 'outside-workspace',
      message: `워크스페이스 루트 밖의 경로에는 접근할 수 없습니다: ${trimmed}`,
      rawHref: trimmed
    }
  }

  if (!context.workspaceRootPath || !context.activeFilePath) {
    return {
      kind: 'error',
      reason: 'missing-context',
      message: '현재 문서 경로를 확인할 수 없습니다.',
      rawHref: trimmed
    }
  }

  const parsedRoot = parseFsPath(context.workspaceRootPath)
  const parsedActive = parseFsPath(context.activeFilePath)
  if (!parsedRoot || !parsedActive || !prefixesEqual(parsedRoot, parsedActive)) {
    return {
      kind: 'error',
      reason: 'outside-workspace',
      message: `워크스페이스 루트 밖의 경로에는 접근할 수 없습니다: ${trimmed}`,
      rawHref: trimmed
    }
  }

  const resolvedSegments = parsedActive.segments.slice(0, -1)
  for (const segment of decodedPathPart.split(/[/\\]+/)) {
    if (segment === '' || segment === '.') {
      continue
    }
    if (segment === '..') {
      if (resolvedSegments.length === 0) {
        return {
          kind: 'error',
          reason: 'outside-workspace',
          message: `워크스페이스 루트 밖의 경로에는 접근할 수 없습니다: ${trimmed}`,
          rawHref: trimmed
        }
      }
      resolvedSegments.pop()
      continue
    }
    resolvedSegments.push(segment)
  }

  if (!segmentsStartWith(resolvedSegments, parsedRoot.segments, parsedRoot.caseInsensitive)) {
    return {
      kind: 'error',
      reason: 'outside-workspace',
      message: `워크스페이스 루트 밖의 경로에는 접근할 수 없습니다: ${trimmed}`,
      rawHref: trimmed
    }
  }

  const targetPath = formatParsedFsPath(parsedRoot, resolvedSegments)
  const slug = rawFragmentPart !== null ? decodeSlugSafely(rawFragmentPart) : null

  return {
    kind: 'workspace-file',
    targetPath,
    slug,
    rawHref: trimmed
  }
}

/**
 * Finds the heading and its 0-based outline index matching `rawSlug` (decoding percent escapes).
 */
export function findMarkdownHeadingBySlug(
  markdownContent: string,
  rawSlug: string
): MarkdownHeadingTarget | null {
  const targetSlug = decodeSlugSafely(rawSlug)
  if (targetSlug.length === 0) {
    return null
  }

  const headings = parseMarkdownHeadings(markdownContent)
  for (let index = 0; index < headings.length; index++) {
    const heading = headings[index]
    if (heading.slug === targetSlug) {
      return { heading, index }
    }
  }
  return null
}
