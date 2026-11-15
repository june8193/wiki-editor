import {
  compareWorkspaceEntriesByRelativePath,
  getWorkspacePathKey,
  isMarkdownFileName,
  isSameWorkspacePath,
  normalizeWorkspacePath,
  stripMarkdownExtension,
  type WorkspaceEntry
} from '@shared/workspace'
import { countBacktickRun, isExternalLinkScheme } from './MarkdownLinkSyntax'
import {
  isOffsetInCodeFence,
  parseMarkdownHeadings,
  stripInlineMarkdown,
  type MarkdownHeading
} from './MarkdownTocEngine'
import { detectTableAtOffset } from './TableMarkdownManipulator'

export interface LinkQueryMatch {
  label: string
  query: string
  rangeFrom: number
  rangeTo: number
}

export interface HeadingLinkCandidate {
  kind: 'heading'
  id: string
  heading: MarkdownHeading
  title: string
  slug: string
}

export interface FileLinkCandidate {
  kind: 'file'
  id: string
  name: string
  path: string
  relativePath: string
  href: string
  displayName: string
}

export type LinkCandidate = HeadingLinkCandidate | FileLinkCandidate

export interface RawLinkEdit {
  from: number
  to: number
  text: string
  cursorOffset: number
}

export interface InlineLinkSegment {
  text: string
  from: number
  isCodeMark?: boolean
  isBoundaryBreak?: boolean
}

export interface InlineLinkSegmentMatch extends LinkQueryMatch {
  closeBracketPos: number
}

interface OpenBracketEntry {
  pos: number
  labelStartBufferOffset: number
  precededByBang: boolean
}

interface PendingLinkCandidate {
  bracketPos: number
  precededByBang: boolean
  closeBracketPos: number
  label: string
  queryStartBufferOffset: number
}

const DISALLOWED_QUERY_CHAR_REGEX = /[\s)]/

function wrapCodeSpanMarkdown(text: string): string {
  let maxRun = 0
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '`') {
      const runLen = countBacktickRun(text, i)
      if (runLen > maxRun) {
        maxRun = runLen
      }
      i += runLen - 1
    }
  }
  const fence = '`'.repeat(maxRun + 1)
  const padded =
    maxRun > 0 && (text.startsWith('`') || text.endsWith('`')) ? ` ${text} ` : text
  return `${fence}${padded}${fence}`
}

function createPendingCandidate(
  openBracket: OpenBracketEntry,
  closeBracketPos: number,
  buffer: string,
  labelEndBufferOffset: number
): PendingLinkCandidate {
  return {
    bracketPos: openBracket.pos,
    precededByBang: openBracket.precededByBang,
    closeBracketPos,
    label: buffer.slice(openBracket.labelStartBufferOffset, labelEndBufferOffset),
    queryStartBufferOffset: buffer.length
  }
}

/**
 * Detects an open Markdown link query (`[label](query`) across segmented inline spans.
 * Shared by Raw text scanning and ProseMirror inline segment scanning.
 */
export function detectLinkQueryFromSegments(
  segments: readonly InlineLinkSegment[],
  cursorPos: number
): InlineLinkSegmentMatch | null {
  let inBacktickCount = 0
  let pendingUnescapedBang = false
  let buffer = ''

  const bracketStack: OpenBracketEntry[] = []
  let candidate: PendingLinkCandidate | null = null
  let pendingCloseBracket: {
    openBracket: OpenBracketEntry
    closeBracketPos: number
    labelEndBufferOffset: number
  } | null = null

  for (const seg of segments) {
    if (seg.isBoundaryBreak) {
      inBacktickCount = 0
      pendingUnescapedBang = false
      bracketStack.length = 0
      candidate = null
      pendingCloseBracket = null
      buffer = ''
      continue
    }

    if (seg.isCodeMark) {
      pendingUnescapedBang = false
      pendingCloseBracket = null
      candidate = null
      buffer += wrapCodeSpanMarkdown(seg.text)
      continue
    }

    for (let i = 0; i < seg.text.length; i += 1) {
      const ch = seg.text[i]
      const charPos = seg.from + i

      if (pendingCloseBracket !== null) {
        const matchedCrossSegment = i === 0 && ch === '(' && inBacktickCount === 0
        const prev = pendingCloseBracket
        pendingCloseBracket = null
        if (matchedCrossSegment) {
          buffer += '('
          candidate = createPendingCandidate(
            prev.openBracket,
            prev.closeBracketPos,
            buffer,
            prev.labelEndBufferOffset
          )
          pendingUnescapedBang = false
          continue
        }
      }

      if (inBacktickCount > 0) {
        if (ch === '`') {
          const runLen = countBacktickRun(seg.text, i)
          if (runLen === inBacktickCount) {
            inBacktickCount = 0
          }
          buffer += seg.text.slice(i, i + runLen)
          i += runLen - 1
        } else {
          buffer += ch
        }
        continue
      }

      if (ch === '\\') {
        pendingUnescapedBang = false
        if (i + 1 < seg.text.length) {
          buffer += ch + seg.text[i + 1]
          i += 1
        } else {
          buffer += ch
        }
        continue
      }

      if (ch === '`') {
        pendingUnescapedBang = false
        const runLen = countBacktickRun(seg.text, i)
        inBacktickCount = runLen
        buffer += seg.text.slice(i, i + runLen)
        i += runLen - 1
        continue
      }

      if (ch === '!') {
        pendingUnescapedBang = true
        buffer += ch
        continue
      }

      if (ch === '[') {
        buffer += '['
        bracketStack.push({
          pos: charPos,
          labelStartBufferOffset: buffer.length,
          precededByBang: pendingUnescapedBang
        })
        pendingUnescapedBang = false
        continue
      }

      if (ch === ']') {
        pendingUnescapedBang = false
        const labelEndBufferOffset = buffer.length
        buffer += ']'
        const openBracket = bracketStack.pop()
        if (openBracket !== undefined) {
          if (i + 1 < seg.text.length) {
            if (seg.text[i + 1] === '(') {
              buffer += '('
              candidate = createPendingCandidate(openBracket, charPos, buffer, labelEndBufferOffset)
              i += 1
            }
          } else {
            pendingCloseBracket = {
              openBracket,
              closeBracketPos: charPos,
              labelEndBufferOffset
            }
          }
        }
        continue
      }

      pendingUnescapedBang = false
      buffer += ch
    }
  }

  if (inBacktickCount > 0 || !candidate || candidate.precededByBang) {
    return null
  }

  const query = buffer.slice(candidate.queryStartBufferOffset)
  if (DISALLOWED_QUERY_CHAR_REGEX.test(query) || isExternalLinkScheme(query)) {
    return null
  }

  return {
    label: candidate.label,
    query,
    rangeFrom: candidate.bracketPos,
    closeBracketPos: candidate.closeBracketPos,
    rangeTo: cursorPos
  }
}

/** Detects a `[label](query` link autocomplete trigger at `cursorOffset` in Raw Markdown. */
export function detectLinkQuery(text: string, cursorOffset: number): LinkQueryMatch | null {
  if (cursorOffset < 0 || cursorOffset > text.length) {
    return null
  }
  if (isOffsetInCodeFence(text, cursorOffset)) {
    return null
  }

  const lineStart = text.lastIndexOf('\n', cursorOffset - 1) + 1
  const lineText = text.slice(lineStart, cursorOffset)
  const match = detectLinkQueryFromSegments([{ text: lineText, from: lineStart }], cursorOffset)
  if (!match) {
    return null
  }

  return {
    label: match.label,
    query: match.query,
    rangeFrom: match.rangeFrom,
    rangeTo: match.rangeTo
  }
}

/** Builds heading link candidates using `parseMarkdownHeadings` to match TOC and Preview slugs. */
export function buildHeadingLinkCandidates(markdown: string): HeadingLinkCandidate[] {
  return parseMarkdownHeadings(markdown).map((heading) => ({
    kind: 'heading',
    id: `heading:${heading.line}:${heading.slug}`,
    heading,
    title: heading.title || heading.rawTitle,
    slug: heading.slug
  }))
}

const MARKDOWN_PATH_SEGMENT_UNSAFE_RE = /[\u0000-\u0020\u007f"%<>\\^`|{}()[\]#?]/g

/**
 * Percent-encodes markdown/URI-unsafe characters in a single path segment while keeping printable
 * Unicode (such as Korean filenames) readable.
 */
export function encodeMarkdownPathSegment(segment: string): string {
  return segment.replace(MARKDOWN_PATH_SEGMENT_UNSAFE_RE, (ch) => {
    if (ch === '(') return '%28'
    if (ch === ')') return '%29'
    return encodeURIComponent(ch)
  })
}

function encodePosixRelativeSegments(relativePosixPath: string): string {
  return relativePosixPath
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .map(encodeMarkdownPathSegment)
    .join('/')
}

/**
 * Computes a POSIX relative Markdown href (`./...` or `../...`) from `activeFilePath`'s directory
 * to `targetEntry`, percent-encoding unsafe characters in each path segment.
 */
export function computeRelativeMarkdownHref(
  activeFilePath: string | null | undefined,
  targetEntry: Pick<WorkspaceEntry, 'path' | 'relativePath'>
): string {
  const fallbackHref = `./${encodePosixRelativeSegments(targetEntry.relativePath)}`
  if (!activeFilePath || !activeFilePath.trim()) {
    return fallbackHref
  }

  const toPosix = normalizeWorkspacePath(targetEntry.path).replace(/\\/g, '/')
  const fromPosix = normalizeWorkspacePath(activeFilePath).replace(/\\/g, '/')
  const toKey = getWorkspacePathKey(targetEntry.path)
  const fromKey = getWorkspacePathKey(activeFilePath)
  if (!toPosix || !fromPosix || !toKey || !fromKey) {
    return fallbackHref
  }

  const toParts = toPosix.split('/')
  const toKeyParts = toKey.split('/')
  const fromDirParts = fromPosix.split('/').slice(0, -1)
  const fromDirKeyParts = fromKey.split('/').slice(0, -1)

  let commonLen = 0
  const maxCommon = Math.min(fromDirKeyParts.length, Math.max(0, toKeyParts.length - 1))
  while (commonLen < maxCommon && fromDirKeyParts[commonLen] === toKeyParts[commonLen]) {
    commonLen += 1
  }

  if (commonLen === 0) {
    return fallbackHref
  }

  const upCount = fromDirParts.length - commonLen
  const down = toParts.slice(commonLen).map(encodeMarkdownPathSegment).join('/')
  if (upCount === 0) {
    return `./${down}`
  }
  return `${'../'.repeat(upCount)}${down}`
}

/**
 * Builds file link candidates from workspace markdown files, excluding the currently active file
 * and sorting alphabetically by workspace-root `relativePath`.
 */
export function buildFileLinkCandidates(
  entries: readonly WorkspaceEntry[],
  activeFilePath?: string | null
): FileLinkCandidate[] {
  return entries
    .filter(
      (entry) =>
        entry.kind === 'file' &&
        isMarkdownFileName(entry.name) &&
        !(activeFilePath && isSameWorkspacePath(entry.path, activeFilePath))
    )
    .sort(compareWorkspaceEntriesByRelativePath)
    .map((entry) => ({
      kind: 'file',
      id: `file:${entry.relativePath}`,
      name: entry.name,
      path: entry.path,
      relativePath: entry.relativePath,
      href: computeRelativeMarkdownHref(activeFilePath, entry),
      displayName: stripMarkdownExtension(entry.name)
    }))
}

function getFieldMatchTier(field: string, normalizedTerm: string): number {
  const normalizedField = field.trim().toLowerCase()
  if (!normalizedField) {
    return 3
  }
  if (normalizedField === normalizedTerm) {
    return 0
  }
  if (normalizedField.startsWith(normalizedTerm)) {
    return 1
  }
  if (normalizedField.includes(normalizedTerm)) {
    return 2
  }
  return 3
}

function safelyDecodeHref(href: string): string {
  try {
    return decodeURIComponent(href)
  } catch {
    return href
  }
}

function getFilePathQueryMatchTier(candidate: FileLinkCandidate, normalizedPathQuery: string): number {
  const requiredPrefix = normalizedPathQuery.startsWith('../') ? '../' : './'
  const rawHref = candidate.href.toLowerCase()
  if (!rawHref.startsWith(requiredPrefix)) {
    return 3
  }
  if (normalizedPathQuery === requiredPrefix) {
    return 0
  }

  const decodedHref = safelyDecodeHref(candidate.href).toLowerCase()
  if (rawHref === normalizedPathQuery || decodedHref === normalizedPathQuery) {
    return 0
  }
  if (rawHref.startsWith(normalizedPathQuery) || decodedHref.startsWith(normalizedPathQuery)) {
    return 1
  }

  const tail = normalizedPathQuery.slice(requiredPrefix.length)
  if (tail) {
    const rawTail = rawHref.slice(requiredPrefix.length)
    const decodedTail = decodedHref.slice(requiredPrefix.length)
    if (rawTail.includes(tail) || decodedTail.includes(tail)) {
      return 2
    }
  }
  return 3
}

function getCandidateMatchTier(candidate: LinkCandidate, normalizedTerm: string): number {
  if (!normalizedTerm) {
    return 3
  }
  if (candidate.kind === 'heading') {
    const cleanTitle = stripInlineMarkdown(candidate.title)
    return Math.min(
      getFieldMatchTier(cleanTitle, normalizedTerm),
      getFieldMatchTier(candidate.slug, normalizedTerm)
    )
  }

  const decodedHref = safelyDecodeHref(candidate.href)
  const relWithoutExt = stripMarkdownExtension(candidate.relativePath)
  return Math.min(
    getFieldMatchTier(candidate.displayName, normalizedTerm),
    getFieldMatchTier(candidate.name, normalizedTerm),
    getFieldMatchTier(relWithoutExt, normalizedTerm),
    getFieldMatchTier(candidate.relativePath, normalizedTerm),
    getFieldMatchTier(decodedHref, normalizedTerm)
  )
}

/**
 * Filters and ranks heading and workspace file candidates by `#` / `./` / `../` / general queries,
 * boosting items matching `[label]` and keeping headings ahead of files on ties.
 */
export function filterAndRankLinkCandidates<T extends LinkCandidate>(
  candidates: readonly T[],
  label: string,
  query: string
): T[] {
  const normalizedQuery = query.trim().toLowerCase()
  const normalizedLabel = stripInlineMarkdown(label).trim().toLowerCase()

  const isHeadingOnly = normalizedQuery.startsWith('#')
  const isPathOnly =
    !isHeadingOnly && (normalizedQuery.startsWith('./') || normalizedQuery.startsWith('../'))

  const effectiveQuery = isHeadingOnly ? normalizedQuery.slice(1).trim() : normalizedQuery
  const primaryTerm = effectiveQuery || normalizedLabel
  const secondaryTerm = effectiveQuery ? normalizedLabel : ''

  const scored: Array<{
    candidate: T
    index: number
    kindRank: number
    primaryTier: number
    secondaryTier: number
  }> = []

  candidates.forEach((candidate, index) => {
    if (isHeadingOnly && candidate.kind !== 'heading') return
    if (isPathOnly && candidate.kind !== 'file') return

    let primaryTier = 3
    if (isPathOnly && candidate.kind === 'file') {
      primaryTier = getFilePathQueryMatchTier(candidate, normalizedQuery)
      if (primaryTier >= 3) return
    } else {
      primaryTier = getCandidateMatchTier(candidate, primaryTerm)
      if (effectiveQuery && primaryTier >= 3) return
    }
    const secondaryTier = getCandidateMatchTier(candidate, secondaryTerm)

    scored.push({
      candidate,
      index,
      kindRank: candidate.kind === 'heading' ? 0 : 1,
      primaryTier,
      secondaryTier
    })
  })

  return scored
    .sort(
      (a, b) =>
        a.primaryTier - b.primaryTier ||
        a.secondaryTier - b.secondaryTier ||
        a.kindRank - b.kindRank ||
        a.index - b.index
    )
    .map((entry) => entry.candidate)
}

function escapeMarkdownTableCellText(text: string): string {
  return text.replace(/(\\*)\|/g, (full, backslashes: string) =>
    backslashes.length % 2 === 1 ? full : `${backslashes}\\|`
  )
}

/** Returns the Markdown link destination (`#slug` or POSIX relative path) for a candidate. */
export function getLinkCandidateHref(candidate: LinkCandidate): string {
  return candidate.kind === 'heading' ? `#${candidate.slug}` : candidate.href
}

/** Returns the default link label when completing an empty `[]` bracket pair. */
export function getLinkCandidateAutoLabel(candidate: LinkCandidate): string {
  return candidate.kind === 'heading' ? candidate.title : candidate.displayName
}

function resolveLinkLabel(
  label: string,
  candidate: LinkCandidate,
  escapeTablePipe: boolean
): string {
  if (label.length > 0) {
    return label
  }
  const autoLabel = getLinkCandidateAutoLabel(candidate)
  return escapeTablePipe ? escapeMarkdownTableCellText(autoLabel) : autoLabel
}

/**
 * Computes the Raw Markdown edit for completing `[label](href)`, preserving user-typed labels,
 * filling empty `[]` with default labels (pipe-escaped inside tables), and consuming an adjacent
 * closing `)` to prevent `))`.
 */
export function buildRawLinkEdit(
  docText: string,
  match: LinkQueryMatch,
  candidate: LinkCandidate
): RawLinkEdit {
  const inTable = detectTableAtOffset(docText, match.rangeFrom) !== null
  const resolvedLabel = resolveLinkLabel(match.label, candidate, inTable)
  const text = `[${resolvedLabel}](${getLinkCandidateHref(candidate)})`
  const to = docText[match.rangeTo] === ')' ? match.rangeTo + 1 : match.rangeTo

  return {
    from: match.rangeFrom,
    to,
    text,
    cursorOffset: match.rangeFrom + text.length
  }
}
