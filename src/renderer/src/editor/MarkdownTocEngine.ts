export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6

export interface MarkdownHeading {
  /** 1-based line number in the markdown document */
  line: number
  level: HeadingLevel
  /** 0-based outline indentation depth */
  depth: number
  /** Hierarchical number string such as "1.", "1.1.", "1.1.1." */
  number: string
  /** Heading text as written in markdown (trailing closing # removed) */
  rawTitle: string
  /** Plain display title with leading explicit number and inline markdown syntax stripped */
  title: string
  /** Unique GitHub-style anchor slug matching rendered Preview heading id */
  slug: string
  hasExplicitNumber: boolean
}

interface NumberFrame {
  level: number
  label: number
  childCount: number
}

interface ParsedFenceLine {
  char: '`' | '~'
  length: number
}

interface ScannedLine {
  lineNumber: number
  text: string
  inCodeFence: boolean
}

export const LEADING_HEADING_NUMBER_RE = /^(\d+(?:\.\d+)*\.)([ \t]+)/
const ATX_HEADING_RE = /^[ ]{0,3}(#{1,6})[ \t]+(.+?)[ \t]*$/
const TRAILING_CLOSING_HASHES_RE = /^(.*?)(?:[ \t]+#+)?$/
const FENCE_OPEN_RE = /^[ ]{0,3}(`{3,}|~{3,})(.*)$/

export function detectDocumentLineEnding(markdown: string): '\r\n' | '\n' {
  return markdown.includes('\r\n') ? '\r\n' : '\n'
}

export function normalizeLineEndingsToLf(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

export function getLineNumberAtOffset(text: string, offset: number): number {
  const clamped = Math.max(0, Math.min(offset, text.length))
  let line = 1
  for (let i = 0; i < clamped; i += 1) {
    if (text[i] === '\n') {
      line += 1
    }
  }
  return line
}

/**
 * Returns true if the given character offset sits inside a fenced code block (``` or ~~~).
 */
export function isOffsetInCodeFence(markdown: string, offset: number): boolean {
  if (!markdown) return false
  const lineNumber = getLineNumberAtOffset(markdown, offset)
  const lines = scanMarkdownLines(markdown)
  return lines[lineNumber - 1]?.inCodeFence ?? false
}

/**
 * Formats an Outline heading label consistently with dynamic numbering settings.
 */
export function formatOutlineHeadingTitle(
  heading: MarkdownHeading,
  showHeadingNumbers: boolean
): string {
  if (!showHeadingNumbers && heading.hasExplicitNumber) {
    return stripInlineMarkdown(heading.rawTitle) || heading.rawTitle
  }
  return heading.title
}

function tryOpenFence(line: string): ParsedFenceLine | null {
  const match = FENCE_OPEN_RE.exec(line)
  if (!match) return null
  const fence = match[1]
  const info = match[2]
  const char = fence[0] as '`' | '~'
  // CommonMark: backtick fence info strings cannot contain backticks
  if (char === '`' && info.includes('`')) {
    return null
  }
  return { char, length: fence.length }
}

function isClosingFence(line: string, active: ParsedFenceLine): boolean {
  const trimmed = line.replace(/^[ ]{0,3}/, '')
  let count = 0
  while (count < trimmed.length && trimmed[count] === active.char) {
    count += 1
  }
  if (count < active.length) return false
  return /^[ \t]*$/.test(trimmed.slice(count))
}

function scanMarkdownLines(markdown: string): ScannedLine[] {
  const result: ScannedLine[] = []
  let activeFence: ParsedFenceLine | null = null
  let index = 0
  let lineNumber = 1

  while (index <= markdown.length) {
    const lfPos = markdown.indexOf('\n', index)
    let endOfText: number
    let nextIndex: number
    if (lfPos === -1) {
      endOfText = markdown.length
      nextIndex = markdown.length + 1
    } else {
      const hasCr = lfPos > index && markdown[lfPos - 1] === '\r'
      endOfText = hasCr ? lfPos - 1 : lfPos
      nextIndex = lfPos + 1
    }

    const text = markdown.slice(index, endOfText)

    let inCodeFence = activeFence !== null
    if (activeFence) {
      if (isClosingFence(text, activeFence)) {
        activeFence = null
        inCodeFence = true
      }
    } else {
      const opened = tryOpenFence(text)
      if (opened) {
        activeFence = opened
        inCodeFence = true
      }
    }

    result.push({ lineNumber, text, inCodeFence })
    if (lfPos === -1) break
    index = nextIndex
    lineNumber += 1
  }

  return result
}

export function hasHeadingNumberPrefix(text: string): boolean {
  const match = LEADING_HEADING_NUMBER_RE.exec(text)
  return match !== null && /\S/.test(text.slice(match[0].length))
}

export function stripHeadingNumberPrefix(text: string): string {
  return hasHeadingNumberPrefix(text) ? text.replace(LEADING_HEADING_NUMBER_RE, '') : text
}

function nextMarkdownCursor(text: string, index: number): number {
  return text[index] === '\\' && index + 1 < text.length ? index + 2 : index + 1
}

function findClosingDestinationParen(text: string, openParenIndex: number): number {
  let cursor = openParenIndex + 1
  while (cursor < text.length && text[cursor] === ' ') {
    cursor += 1
  }

  if (text[cursor] === '<') {
    cursor += 1
    while (cursor < text.length) {
      if (text[cursor] === '>') {
        cursor += 1
        break
      }
      cursor = nextMarkdownCursor(text, cursor)
    }
  }

  let parenDepth = 1
  while (cursor < text.length) {
    const ch = text[cursor]
    if (ch === '(') {
      parenDepth += 1
    } else if (ch === ')') {
      parenDepth -= 1
      if (parenDepth === 0) {
        return cursor
      }
    }
    cursor = nextMarkdownCursor(text, cursor)
  }
  return -1
}

function findClosingLabelBracket(text: string, labelStart: number): number {
  let depth = 1
  let cursor = labelStart

  while (cursor < text.length) {
    const ch = text[cursor]
    if (ch === '[') {
      depth += 1
    } else if (ch === ']') {
      depth -= 1
      if (depth === 0) {
        return cursor
      }
    }
    cursor = nextMarkdownCursor(text, cursor)
  }

  return -1
}

function stripInlineLinksAndImages(text: string): string {
  let result = ''
  let i = 0

  while (i < text.length) {
    const isImage = text[i] === '!' && text[i + 1] === '['
    const isLink = !isImage && text[i] === '['
    if (isImage || isLink) {
      const labelStart = i + (isImage ? 2 : 1)
      const closeBracket = findClosingLabelBracket(text, labelStart)
      const hasValidLabel = isImage ? closeBracket >= labelStart : closeBracket > labelStart
      if (hasValidLabel && text[closeBracket + 1] === '(') {
        const closeParen = findClosingDestinationParen(text, closeBracket + 1)
        if (closeParen !== -1) {
          result += stripInlineLinksAndImages(text.slice(labelStart, closeBracket))
          i = closeParen + 1
          continue
        }
      }
    }

    result += text[i]
    i += 1
  }

  return result
}

export function stripInlineMarkdown(text: string): string {
  return stripInlineLinksAndImages(text)
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(\*\*|__|~~)(?=\S)(.+?)(?<=\S)\1/g, '$2')
    .replace(/(^|[\s(])([*_])(?=\S)(.+?)(?<=\S)\2(?=$|[\s).,!?:;])/g, '$1$3')
    .replace(/\\([\\`*_{}[\]()#+\-.!])/g, '$1')
    .trim()
}

export function slugifyHeading(text: string): string {
  const plain = stripInlineMarkdown(text)
  const slug = plain
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'section'
}

export function createHeadingSlugTracker(): { next: (text: string) => string } {
  const seen = new Map<string, number>()
  return {
    next(text: string): string {
      const base = slugifyHeading(text)
      const count = seen.get(base) ?? 0
      seen.set(base, count + 1)
      return count === 0 ? base : `${base}-${count}`
    }
  }
}

/**
 * Stateful stack-based hierarchical number tracker (1., 1.1., ...) that handles skipped
 * heading levels monotonically without producing 0 segments or duplicate numbers.
 */
export function createHeadingNumberTracker(): {
  next: (level: number) => { number: string; depth: number }
} {
  const stack: NumberFrame[] = [{ level: 0, label: 0, childCount: 0 }]

  return {
    next(level: number): { number: string; depth: number } {
      while (stack.length > 1 && stack[stack.length - 1].level >= level) {
        stack.pop()
      }
      const parent = stack[stack.length - 1]
      parent.childCount += 1
      stack.push({ level, label: parent.childCount, childCount: 0 })

      const parts = stack.slice(1).map((frame) => frame.label)
      return {
        number: `${parts.join('.')}.`,
        depth: parts.length - 1
      }
    }
  }
}

interface MatchedAtxHeading {
  level: HeadingLevel
  rawTitle: string
}

function matchAtxHeadingLine(lineText: string): MatchedAtxHeading | null {
  const match = ATX_HEADING_RE.exec(lineText)
  if (!match) return null

  const [, hashes, coreContent] = match
  const closingMatch = TRAILING_CLOSING_HASHES_RE.exec(coreContent)
  const withoutClosingHashes = (closingMatch ? closingMatch[1] : coreContent).trim()
  if (!withoutClosingHashes || /^#+$/.test(withoutClosingHashes)) {
    return null
  }

  return {
    level: hashes.length as HeadingLevel,
    rawTitle: withoutClosingHashes
  }
}

/**
 * Parses ATX headings (# through ######) ignoring headings inside fenced code blocks.
 */
export function parseMarkdownHeadings(markdown: string): MarkdownHeading[] {
  if (!markdown) return []

  const lines = scanMarkdownLines(markdown)
  const numberTracker = createHeadingNumberTracker()
  const slugTracker = createHeadingSlugTracker()
  const headings: MarkdownHeading[] = []

  for (const line of lines) {
    if (line.inCodeFence) continue
    const parsed = matchAtxHeadingLine(line.text)
    if (!parsed) continue

    const { number, depth } = numberTracker.next(parsed.level)
    const hasExplicitNumber = hasHeadingNumberPrefix(parsed.rawTitle)
    const titleWithoutNumber = stripHeadingNumberPrefix(parsed.rawTitle)
    const title = stripInlineMarkdown(titleWithoutNumber) || titleWithoutNumber
    const slug = slugTracker.next(parsed.rawTitle)

    headings.push({
      line: line.lineNumber,
      level: parsed.level,
      depth,
      number,
      rawTitle: parsed.rawTitle,
      title,
      slug,
      hasExplicitNumber
    })
  }

  return headings
}

export interface MarkdownHeadingTarget {
  heading: MarkdownHeading
  index: number
}

export function decodeSlugSafely(rawSlug: string): string {
  try {
    return decodeURIComponent(rawSlug)
  } catch {
    return rawSlug
  }
}

/**
 * Finds the heading and its 0-based outline index matching an already-decoded `slug`.
 */
export function findMarkdownHeadingBySlug(
  markdownContent: string,
  slug: string
): MarkdownHeadingTarget | null {
  if (slug.length === 0) {
    return null
  }

  const headings = parseMarkdownHeadings(markdownContent)
  for (let index = 0; index < headings.length; index++) {
    const heading = headings[index]
    if (heading.slug === slug) {
      return { heading, index }
    }
  }
  return null
}
