import { isOffsetInCodeFence } from './MarkdownTocEngine'

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
