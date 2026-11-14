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

export interface TocGenerateOptions {
  includeNumbers?: boolean
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
  rawLine: string
  text: string
  lineEnding: string
  inCodeFence: boolean
}

export const HEADING_NUMBER_PREFIX_RE = /^(\d+(?:\.\d+)*\.)([ \t]+)(?=\S)/
const ATX_HEADING_RE = /^([ ]{0,3})(#{1,6})([ \t]+)(.+?)([ \t]*)$/
const TRAILING_CLOSING_HASHES_RE = /^(.*?)(?:[ \t]+#+)?$/
const FENCE_OPEN_RE = /^[ ]{0,3}(`{3,}|~{3,})(.*)$/
const TOC_START_MARKER = '<!-- toc -->'
const TOC_END_MARKER = '<!-- /toc -->'

export function detectDocumentLineEnding(markdown: string): '\r\n' | '\n' {
  return markdown.includes('\r\n') ? '\r\n' : '\n'
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
 * Resolves the 1-based markdown line number corresponding to an LF-normalized cursor offset
 * (as reported by CodeMirror 6), safely handling CRLF documents.
 */
export function resolveRawCursorLine(markdown: string, lfOffset: number): number {
  return getLineNumberAtOffset(markdown.replace(/\r\n/g, '\n'), lfOffset)
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
    let lineEnding = ''
    let nextIndex: number

    if (lfPos === -1) {
      endOfText = markdown.length
      nextIndex = markdown.length + 1
    } else {
      const hasCr = lfPos > index && markdown[lfPos - 1] === '\r'
      endOfText = hasCr ? lfPos - 1 : lfPos
      lineEnding = hasCr ? '\r\n' : '\n'
      nextIndex = lfPos + 1
    }

    const text = markdown.slice(index, endOfText)
    const rawLine = markdown.slice(index, lfPos === -1 ? markdown.length : lfPos + 1)

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

    result.push({ lineNumber, rawLine, text, lineEnding, inCodeFence })
    if (lfPos === -1) break
    index = nextIndex
    lineNumber += 1
  }

  return result
}

export function isLineInsideCodeFence(markdown: string, targetLine1Based: number): boolean {
  const lines = scanMarkdownLines(markdown)
  const target = lines[targetLine1Based - 1]
  return target ? target.inCodeFence : false
}

export function hasHeadingNumberPrefix(text: string): boolean {
  return HEADING_NUMBER_PREFIX_RE.test(text)
}

export function stripHeadingNumberPrefix(text: string): string {
  return text.replace(HEADING_NUMBER_PREFIX_RE, '')
}

export function stripInlineMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
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
  indent: string
  hashes: string
  separator: string
  level: HeadingLevel
  coreContent: string
  trailingWhitespace: string
  rawTitle: string
}

function matchAtxHeadingLine(lineText: string): MatchedAtxHeading | null {
  const match = ATX_HEADING_RE.exec(lineText)
  if (!match) return null

  const [, indent, hashes, separator, coreContent, trailingWhitespace] = match
  const closingMatch = TRAILING_CLOSING_HASHES_RE.exec(coreContent)
  const withoutClosingHashes = (closingMatch ? closingMatch[1] : coreContent).trim()
  if (!withoutClosingHashes || /^#+$/.test(withoutClosingHashes)) {
    return null
  }

  return {
    indent,
    hashes,
    separator,
    level: hashes.length as HeadingLevel,
    coreContent,
    trailingWhitespace,
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

/**
 * Generates nested Markdown bullet list items for the document's headings.
 */
export function generateTocMarkdown(markdown: string, options: TocGenerateOptions = {}): string {
  const headings = parseMarkdownHeadings(markdown)
  if (headings.length === 0) return ''

  const includeNumbers = options.includeNumbers ?? false
  return headings
    .map((heading) => {
      const indent = '  '.repeat(heading.depth)
      const label = includeNumbers
        ? `${heading.number} ${heading.title}`
        : heading.hasExplicitNumber
          ? heading.rawTitle
          : heading.title
      return `${indent}- [${label}](#${heading.slug})`
    })
    .join('\n')
}

function findExistingTocMarkerRange(
  lines: readonly ScannedLine[]
): { startIdx: number; endIdx: number } | null {
  let startIdx = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].inCodeFence) continue
    const trimmed = lines[i].text.trim()
    if (startIdx === -1) {
      if (trimmed === TOC_START_MARKER) {
        startIdx = i
      }
    } else if (trimmed === TOC_END_MARKER) {
      return { startIdx, endIdx: i }
    }
  }
  return null
}

/**
 * Inserts a new TOC block (or updates an existing `<!-- toc -->` block in-place) safely
 * outside fenced code blocks while preserving CRLF/LF line endings.
 */
export function insertOrUpdateTocBlock(
  markdown: string,
  cursorLine?: number,
  options: TocGenerateOptions = {}
): string {
  const lineEnding = detectDocumentLineEnding(markdown)
  const tocBody = generateTocMarkdown(markdown, options)
  const tocLines = tocBody
    ? [TOC_START_MARKER, ...tocBody.split('\n'), TOC_END_MARKER]
    : [TOC_START_MARKER, TOC_END_MARKER]

  const lines = scanMarkdownLines(markdown)
  const existingRange = findExistingTocMarkerRange(lines)

  const textLines = lines.map((line) => line.text)

  if (existingRange) {
    const nextLines = [
      ...textLines.slice(0, existingRange.startIdx),
      ...tocLines,
      ...textLines.slice(existingRange.endIdx + 1)
    ]
    return nextLines.join(lineEnding)
  }

  if (cursorLine !== undefined && cursorLine >= 1 && cursorLine <= lines.length) {
    const cursorIdx = cursorLine - 1
    if (!lines[cursorIdx].inCodeFence && textLines[cursorIdx].trim() === '/toc') {
      const nextLines = [
        ...textLines.slice(0, cursorIdx),
        ...tocLines,
        ...textLines.slice(cursorIdx + 1)
      ]
      return nextLines.join(lineEnding)
    }
  }

  if (!tocBody) {
    return markdown
  }

  let insertIdx = 0
  if (cursorLine !== undefined && cursorLine >= 1 && cursorLine <= lines.length) {
    insertIdx = cursorLine - 1
    if (lines[insertIdx].inCodeFence) {
      while (insertIdx < lines.length && lines[insertIdx].inCodeFence) {
        insertIdx += 1
      }
    }
  } else {
    const headings = parseMarkdownHeadings(markdown)
    if (headings.length > 0 && headings[0].level === 1) {
      insertIdx = headings[0].line // 1-based line number = index right after H1
    }
  }

  const before = textLines.slice(0, insertIdx)
  const after = textLines.slice(insertIdx)
  const needsBlankBefore = before.length > 0 && before[before.length - 1].trim() !== ''
  const needsBlankAfter = after.length > 0 && after[0].trim() !== ''

  const blockToInsert: string[] = [
    ...(needsBlankBefore ? [''] : []),
    ...tocLines,
    ...(needsBlankAfter ? [''] : [])
  ]

  return [...before, ...blockToInsert, ...after].join(lineEnding)
}

/**
 * Replaces a `/toc` command on `targetLine1Based` with an inserted/updated TOC block if and only if
 * that line is outside fenced code blocks and produces a modified document; otherwise returns `null`.
 */
export function tryReplaceSlashTocAtLine(
  markdown: string,
  targetLine1Based: number,
  options: TocGenerateOptions = {}
): string | null {
  const lines = scanMarkdownLines(markdown)
  const target = lines[targetLine1Based - 1]
  if (!target || target.inCodeFence || target.text.trim() !== '/toc') {
    return null
  }
  const next = insertOrUpdateTocBlock(markdown, targetLine1Based, options)
  return next === markdown ? null : next
}

/**
 * Returns the 1-based line number of the first standalone `/toc` line outside code fences, if any.
 */
export function findFirstNonFencedSlashTocLine(markdown: string): number | undefined {
  const lines = scanMarkdownLines(markdown)
  const found = lines.find((line) => !line.inCodeFence && line.text.trim() === '/toc')
  return found?.lineNumber
}

function transformHeadingLines(
  markdown: string,
  transformCore: (coreContent: string, number: string) => string
): string {
  if (!markdown) return markdown

  const lines = scanMarkdownLines(markdown)
  const numberTracker = createHeadingNumberTracker()
  let changed = false

  const output = lines.map((line) => {
    if (line.inCodeFence) {
      return line.rawLine
    }
    const parsed = matchAtxHeadingLine(line.text)
    if (!parsed) {
      return line.rawLine
    }

    const { number } = numberTracker.next(parsed.level)
    const nextCore = transformCore(parsed.coreContent, number)
    if (nextCore === parsed.coreContent) {
      return line.rawLine
    }
    changed = true
    return `${parsed.indent}${parsed.hashes}${parsed.separator}${nextCore}${parsed.trailingWhitespace}${line.lineEnding}`
  })

  return changed ? output.join('') : markdown
}

/**
 * Writes hierarchical numbers ("1.", "1.1.", ...) onto ATX headings outside code fences,
 * preserving line endings (CRLF/LF) and trailing whitespace.
 */
export function applyHeadingNumbers(markdown: string): string {
  return transformHeadingLines(markdown, (coreContent, number) => {
    const stripped = stripHeadingNumberPrefix(coreContent)
    return `${number} ${stripped}`
  })
}

/**
 * Strips hierarchical numbers from ATX headings outside code fences,
 * preserving line endings (CRLF/LF) and trailing whitespace.
 */
export function stripHeadingNumbers(markdown: string): string {
  return transformHeadingLines(markdown, (coreContent) => stripHeadingNumberPrefix(coreContent))
}
