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

export type LinkCandidate = HeadingLinkCandidate

export interface RawSectionLinkEdit {
  from: number
  to: number
  text: string
  cursorOffset: number
}

export interface DetectLinkQueryOptions {
  ignoreCodeFences?: boolean
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

const EXTERNAL_SCHEME_REGEX = /^(?:https?:|mailto:)/i
const DISALLOWED_QUERY_CHAR_REGEX = /[\s)]/

function countBacktickRun(text: string, start: number): number {
  let end = start
  while (end < text.length && text[end] === '`') {
    end += 1
  }
  return end - start
}

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
      const pmPos = seg.from + i

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
          pos: pmPos,
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
              candidate = createPendingCandidate(openBracket, pmPos, buffer, labelEndBufferOffset)
              i += 1
            }
          } else {
            pendingCloseBracket = {
              openBracket,
              closeBracketPos: pmPos,
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
  if (DISALLOWED_QUERY_CHAR_REGEX.test(query) || EXTERNAL_SCHEME_REGEX.test(query)) {
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
export function detectLinkQuery(
  text: string,
  cursorOffset: number,
  options: DetectLinkQueryOptions = {}
): LinkQueryMatch | null {
  if (cursorOffset < 0 || cursorOffset > text.length) {
    return null
  }
  if ((options.ignoreCodeFences ?? true) && isOffsetInCodeFence(text, cursorOffset)) {
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

function getCandidateMatchTier(candidate: HeadingLinkCandidate, normalizedTerm: string): number {
  const cleanTitle = stripInlineMarkdown(candidate.title)
  return Math.min(
    getFieldMatchTier(cleanTitle, normalizedTerm),
    getFieldMatchTier(candidate.slug, normalizedTerm)
  )
}

/**
 * Filters heading candidates by `#query` / `query` and prioritizes headings matching `[label]`
 * when the query is empty while preserving document order for remaining headings.
 */
export function filterAndRankLinkCandidates(
  candidates: readonly LinkCandidate[],
  label: string,
  query: string
): LinkCandidate[] {
  const rawQuery = query.startsWith('#') ? query.slice(1) : query
  const normalizedQuery = rawQuery.trim().toLowerCase()
  const normalizedLabel = stripInlineMarkdown(label).trim().toLowerCase()

  if (normalizedQuery) {
    return candidates
      .map((candidate, index) => ({
        candidate,
        index,
        queryTier: getCandidateMatchTier(candidate, normalizedQuery),
        labelTier: normalizedLabel ? getCandidateMatchTier(candidate, normalizedLabel) : 3
      }))
      .filter((entry) => entry.queryTier < 3)
      .sort((a, b) => a.queryTier - b.queryTier || a.labelTier - b.labelTier || a.index - b.index)
      .map((entry) => entry.candidate)
  }

  if (!normalizedLabel) {
    return [...candidates]
  }

  return candidates
    .map((candidate, index) => ({
      candidate,
      index,
      labelTier: getCandidateMatchTier(candidate, normalizedLabel)
    }))
    .sort((a, b) => a.labelTier - b.labelTier || a.index - b.index)
    .map((entry) => entry.candidate)
}

function escapeMarkdownTableCellText(text: string): string {
  return text.replace(/(\\*)\|/g, (full, backslashes: string) =>
    backslashes.length % 2 === 1 ? full : `${backslashes}\\|`
  )
}

function resolveSectionLinkLabel(
  label: string,
  candidate: HeadingLinkCandidate,
  escapeTablePipe: boolean
): string {
  if (label.length > 0) {
    return label
  }
  return escapeTablePipe ? escapeMarkdownTableCellText(candidate.title) : candidate.title
}

/**
 * Computes the Raw Markdown edit for completing `[label](#slug)`, preserving user-typed labels,
 * filling empty `[]` with stripped heading titles (pipe-escaped inside tables), and consuming an
 * immediately adjacent closing `)` to prevent `))`.
 */
export function buildRawSectionLinkEdit(
  docText: string,
  match: LinkQueryMatch,
  candidate: HeadingLinkCandidate
): RawSectionLinkEdit {
  const inTable = detectTableAtOffset(docText, match.rangeFrom) !== null
  const resolvedLabel = resolveSectionLinkLabel(match.label, candidate, inTable)
  const text = `[${resolvedLabel}](#${candidate.slug})`
  const to = docText[match.rangeTo] === ')' ? match.rangeTo + 1 : match.rangeTo

  return {
    from: match.rangeFrom,
    to,
    text,
    cursorOffset: match.rangeFrom + text.length
  }
}
