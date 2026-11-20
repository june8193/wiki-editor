import type { SearchMatchOptions, TextMatchSpan } from '@shared/search'

export interface SearchOptionDescriptor {
  key: keyof SearchMatchOptions
  shortLabel: string
  ariaLabel: string
  title: string
}

export const SEARCH_OPTION_BUTTONS: readonly SearchOptionDescriptor[] = [
  {
    key: 'caseSensitive',
    shortLabel: 'Aa',
    ariaLabel: '대소문자 구분 (Aa)',
    title: '대소문자 구분'
  },
  {
    key: 'wholeWord',
    shortLabel: 'ab',
    ariaLabel: '단어 단위 (ab)',
    title: '단어 단위'
  },
  {
    key: 'useRegex',
    shortLabel: '.*',
    ariaLabel: '정규식 (.*)',
    title: '정규식'
  }
]

export interface KeyboardEventLike {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
  isComposing?: boolean
  keyCode?: number
  nativeEvent?: { isComposing?: boolean }
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
 * Returns true when a DOM or React keyboard event is part of an active IME composition.
 */
export function isKeyboardEventComposing(event: KeyboardEventLike): boolean {
  return Boolean(event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229)
}

function isFindShortcut(event: KeyboardEventLike, requireShift: boolean): boolean {
  return (
    (event.ctrlKey || event.metaKey) &&
    event.shiftKey === requireShift &&
    !event.altKey &&
    !isKeyboardEventComposing(event) &&
    event.key.toLowerCase() === 'f'
  )
}

/**
 * Returns true when a keyboard event matches the Main Window workspace search shortcut (`Ctrl+Shift+F` / `Cmd+Shift+F`).
 */
export function isWorkspaceSearchShortcut(event: KeyboardEventLike): boolean {
  return isFindShortcut(event, true)
}

/**
 * Returns true when a keyboard event matches the in-document find shortcut (`Ctrl+F` / `Cmd+F` without Shift/Alt).
 */
export function isDocumentFindShortcut(event: KeyboardEventLike): boolean {
  return isFindShortcut(event, false)
}

/**
 * Returns true when a DOM event originated inside another window's `.app-shell` element.
 */
export function isEventOutsideShell(
  target: EventTarget | null,
  shellEl: HTMLElement | null
): boolean {
  if (!shellEl || !(target instanceof Element)) return false
  const targetShell = target.closest('.app-shell')
  return targetShell !== null && targetShell !== shellEl
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
