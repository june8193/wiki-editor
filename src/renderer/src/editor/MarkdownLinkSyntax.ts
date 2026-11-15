import { isOffsetInCodeFence } from './MarkdownTocEngine'

const EXTERNAL_SCHEME_REGEX = /^(?:https?:|mailto:)/i
const PARAGRAPH_BREAK_LINE_RE = /^(?:[ \t]*|[ ]{0,3}(?:`{3,}[^`]*|~{3,}.*))$/
const ASCII_PUNCT_ESCAPE_RE = /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g

/** Returns true if `value` starts with an external link scheme (`http:`, `https:`, or `mailto:`). */
export function isExternalLinkScheme(value: string): boolean {
  return EXTERNAL_SCHEME_REGEX.test(value)
}

/** Counts consecutive backticks starting at `start` up to `limit`. */
export function countBacktickRun(text: string, start: number, limit = text.length): number {
  let end = start
  while (end < limit && text[end] === '`') {
    end += 1
  }
  return end - start
}

function stepPastEscaped(cursor: number, limit: number): number {
  return cursor + 1 < limit ? cursor + 2 : limit
}

function isEscapedAt(text: string, index: number): boolean {
  let backslashes = 0
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) {
    backslashes++
  }
  return backslashes % 2 === 1
}

function findInlineCodeClose(text: string, start: number, limit: number): number {
  const tickCount = countBacktickRun(text, start, limit)
  let cursor = start + tickCount

  while (cursor < limit) {
    if (text[cursor] === '`') {
      const run = countBacktickRun(text, cursor, limit)
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

function findLineEndAt(text: string, lineStart: number, limit = text.length): number {
  const nlIndex = text.indexOf('\n', lineStart)
  const rawEnd = nlIndex === -1 || nlIndex > limit ? limit : nlIndex
  return rawEnd > lineStart && text[rawEnd - 1] === '\r' ? rawEnd - 1 : rawEnd
}

function isParagraphBreakLine(text: string, lineStart: number, lineEnd: number): boolean {
  return PARAGRAPH_BREAK_LINE_RE.test(text.slice(lineStart, lineEnd))
}

function findParagraphBoundsAtOffset(
  text: string,
  offset: number
): { paragraphStart: number; paragraphEnd: number } | null {
  const curStart = offset === 0 ? 0 : text.lastIndexOf('\n', offset - 1) + 1
  const curEnd = findLineEndAt(text, curStart)
  if (offset > curEnd || isParagraphBreakLine(text, curStart, curEnd)) {
    return null
  }

  let paragraphStart = curStart
  while (paragraphStart > 0) {
    const prevLf = paragraphStart - 1
    const prevStart = prevLf === 0 ? 0 : text.lastIndexOf('\n', prevLf - 1) + 1
    const prevEnd = prevLf > prevStart && text[prevLf - 1] === '\r' ? prevLf - 1 : prevLf
    if (isParagraphBreakLine(text, prevStart, prevEnd)) {
      break
    }
    paragraphStart = prevStart
  }

  let paragraphEnd = curEnd
  let scan = curEnd
  while (scan < text.length) {
    const nlIndex = text.indexOf('\n', scan)
    if (nlIndex === -1) break
    const nextStart = nlIndex + 1
    const nextEnd = findLineEndAt(text, nextStart)
    if (isParagraphBreakLine(text, nextStart, nextEnd)) {
      break
    }
    paragraphEnd = nextEnd
    scan = nextEnd
  }

  return { paragraphStart, paragraphEnd }
}

function findClosingBracket(text: string, openBracket: number, limit: number): number {
  let depth = 1
  let cursor = openBracket + 1
  while (cursor < limit) {
    const ch = text[cursor]
    if (ch === '\\') {
      cursor = stepPastEscaped(cursor, limit)
      continue
    }
    if (ch === '`') {
      const closed = findInlineCodeClose(text, cursor, limit)
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

function skipHorizontalWhitespace(text: string, start: number, limit: number): number {
  let cursor = start
  while (cursor < limit && (text[cursor] === ' ' || text[cursor] === '\t')) {
    cursor++
  }
  return cursor
}

function unescapeMarkdownDestination(rawHref: string): string {
  return rawHref.replace(ASCII_PUNCT_ESCAPE_RE, '$1')
}

function skipOptionalTitleAndFindParen(text: string, start: number, lineEnd: number): number {
  let cursor = skipHorizontalWhitespace(text, start, lineEnd)
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
    if (text[cursor] === '\\') {
      cursor = stepPastEscaped(cursor, lineEnd)
      continue
    }
    if (text[cursor] === closer) {
      cursor++
      break
    }
    cursor++
  }

  cursor = skipHorizontalWhitespace(text, cursor, lineEnd)
  return cursor < lineEnd && text[cursor] === ')' ? cursor : -1
}

function parseLinkDestination(
  text: string,
  openParen: number,
  lineEnd: number
): { href: string; closeParen: number } | null {
  let cursor = skipHorizontalWhitespace(text, openParen + 1, lineEnd)
  if (cursor >= lineEnd) {
    return null
  }

  if (text[cursor] === '<') {
    cursor++
    const hrefStart = cursor
    while (cursor < lineEnd) {
      if (text[cursor] === '\\') {
        cursor = stepPastEscaped(cursor, lineEnd)
        continue
      }
      if (text[cursor] === '>') {
        const href = unescapeMarkdownDestination(text.slice(hrefStart, cursor))
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
    if (ch === '\\') {
      cursor = stepPastEscaped(cursor, lineEnd)
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
          href: unescapeMarkdownDestination(text.slice(hrefStart, cursor)),
          closeParen: cursor
        }
      }
      cursor++
      continue
    }
    if (ch === ' ' || ch === '\t') {
      const href = unescapeMarkdownDestination(text.slice(hrefStart, cursor))
      const closeParen = skipOptionalTitleAndFindParen(text, cursor, lineEnd)
      return closeParen !== -1 ? { href, closeParen } : null
    }
    cursor++
  }

  return null
}

/**
 * Extracts the `href` of the inline Markdown link `[label](href)` enclosing `offset` on
 * non-fenced paragraphs, ignoring Markdown images (`![alt](src)`), inline code spans, and fences.
 */
export function extractMarkdownLinkHrefAtOffset(text: string, offset: number): string | null {
  if (offset < 0 || offset > text.length || text.length === 0 || isOffsetInCodeFence(text, offset)) {
    return null
  }

  const bounds = findParagraphBoundsAtOffset(text, offset)
  if (!bounds) {
    return null
  }
  const { paragraphStart, paragraphEnd } = bounds

  let cursor = paragraphStart
  while (cursor < paragraphEnd) {
    const ch = text[cursor]
    if (ch === '\\') {
      cursor = stepPastEscaped(cursor, paragraphEnd)
      continue
    }
    if (ch === '`') {
      const closed = findInlineCodeClose(text, cursor, paragraphEnd)
      if (closed !== -1) {
        if (offset >= cursor && offset < closed) {
          return null
        }
        cursor = closed
        continue
      }
    }
    if (ch === '[') {
      const isImage =
        cursor > paragraphStart && text[cursor - 1] === '!' && !isEscapedAt(text, cursor - 1)
      if (!isImage) {
        const closeBracket = findClosingBracket(text, cursor, paragraphEnd)
        if (
          closeBracket !== -1 &&
          closeBracket + 1 < paragraphEnd &&
          text[closeBracket + 1] === '('
        ) {
          const destLineEnd = findLineEndAt(text, closeBracket + 1, paragraphEnd)
          const parsedDest = parseLinkDestination(text, closeBracket + 1, destLineEnd)
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
