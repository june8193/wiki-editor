import type { TextMatchSpan } from '@shared/search'

export interface KeyboardEventLike {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
  isComposing?: boolean
}

export interface SearchFocusRequest {
  nonce: number
  selectAll: boolean
}

export interface TextMatchSegment {
  text: string
  isMatch: boolean
}

/**
 * Returns true when a keyboard event matches the Main Window workspace search shortcut (`Ctrl+Shift+F` / `Cmd+Shift+F`).
 */
export function isWorkspaceSearchShortcut(event: KeyboardEventLike): boolean {
  return (
    (event.ctrlKey || event.metaKey) &&
    event.shiftKey &&
    !event.altKey &&
    !event.isComposing &&
    event.key.toLowerCase() === 'f'
  )
}

/**
 * Splits `text` into plain and matched segments according to UTF-16 `spans` without dropping or
 * duplicating characters on unsorted, overlapping, or zero-length spans.
 */
export function splitTextByMatchSpans(
  text: string,
  spans: readonly TextMatchSpan[]
): TextMatchSegment[] {
  if (text.length === 0) {
    return []
  }
  if (spans.length === 0) {
    return [{ text, isMatch: false }]
  }

  const ordered = spans
    .filter((span) => Number.isFinite(span.start) && Number.isFinite(span.end))
    .map((span) => ({
      start: Math.max(0, Math.min(text.length, span.start)),
      end: Math.max(0, Math.min(text.length, span.end))
    }))
    .filter((span) => span.end > span.start)
    .sort((a, b) => a.start - b.start || a.end - b.end)

  if (ordered.length === 0) {
    return [{ text, isMatch: false }]
  }

  const segments: TextMatchSegment[] = []
  let cursor = 0

  for (const span of ordered) {
    if (span.start > cursor) {
      segments.push({ text: text.slice(cursor, span.start), isMatch: false })
    }
    const matchStart = Math.max(cursor, span.start)
    if (span.end > matchStart) {
      segments.push({ text: text.slice(matchStart, span.end), isMatch: true })
      cursor = span.end
    }
  }

  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), isMatch: false })
  }

  return segments
}
