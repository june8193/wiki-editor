import { createElement, type ReactNode } from 'react'
import type { SymbolIdentifierToken } from '@shared/symbol'
import type { CodeBlockHighlightSpan } from './codeBlockHighlight'
import { extractIdentifierAtPosition } from './codeSymbolExtractor'

export interface HoveredSymbolRange {
  lineNumber: number
  side?: 'old' | 'new'
  columnStart: number
  columnEnd: number
  name: string
}

export interface SymbolNavigateRequest {
  symbolName: string
  lineNumber: number
  side?: 'old' | 'new'
  columnStart: number
  columnEnd: number
  clientX: number
  clientY: number
  shiftKey: boolean
}

/**
 * Resolves the 0-based character column within a rendered code line element from a mouse event.
 * Uses `caretRangeFromPoint` in browser environments and falls back to `data-col-start` in jsdom.
 */
export function resolveLineColumnFromMouseEvent(
  event: Pick<MouseEvent, 'clientX' | 'clientY' | 'target'>,
  lineRootEl: HTMLElement
): number | null {
  if (typeof document !== 'undefined' && typeof document.caretRangeFromPoint === 'function') {
    const range = document.caretRangeFromPoint(event.clientX, event.clientY)
    if (range && lineRootEl.contains(range.startContainer)) {
      const preRange = document.createRange()
      preRange.selectNodeContents(lineRootEl)
      preRange.setEnd(range.startContainer, range.startOffset)
      return preRange.toString().length
    }
  }

  const targetEl = event.target instanceof Element ? event.target.closest('[data-col-start]') : null
  if (targetEl && lineRootEl.contains(targetEl)) {
    const rawCol = targetEl.getAttribute('data-col-start')
    if (rawCol !== null) {
      const parsed = Number(rawCol)
      if (Number.isFinite(parsed) && parsed >= 0) {
        return parsed
      }
    }
  }
  return null
}

/**
 * Resolves a valid identifier token on a single line of code at the given mouse event position.
 */
export function resolveSingleLineSymbolAtEvent(
  lineText: string,
  lineNumber: number,
  side: 'old' | 'new' | undefined,
  event: Pick<MouseEvent, 'clientX' | 'clientY' | 'target'>,
  lineRootEl: HTMLElement,
  parser: Parameters<typeof extractIdentifierAtPosition>[2]
): HoveredSymbolRange | null {
  if (!lineText || !parser) {
    return null
  }
  const column = resolveLineColumnFromMouseEvent(event, lineRootEl)
  if (column === null) {
    return null
  }
  const token: SymbolIdentifierToken | null = extractIdentifierAtPosition(
    lineText,
    { lineNumber: 1, column },
    parser
  )
  if (!token) {
    return null
  }
  return {
    lineNumber,
    ...(side ? { side } : {}),
    columnStart: token.columnStart,
    columnEnd: token.columnEnd,
    name: token.name
  }
}

export interface FindHighlightSpan {
  from: number
  to: number
  isActive: boolean
}

/**
 * Renders syntax-highlighted spans with `data-col-start` attributes, optional word-diff highlights, hover underline, and find match highlights.
 */
export function renderSyntaxLineWithHover(
  lineText: string,
  syntaxSpans: readonly CodeBlockHighlightSpan[] | undefined,
  hoverRange: { columnStart: number; columnEnd: number } | null,
  wordHighlights?: readonly { from: number; to: number }[],
  findHighlights?: readonly FindHighlightSpan[]
): ReactNode {
  if (!lineText) {
    return '\u00a0'
  }
  const boundaries = new Set<number>([0, lineText.length])
  if (wordHighlights) {
    for (const range of wordHighlights) {
      if (range.from >= 0 && range.from <= lineText.length) boundaries.add(range.from)
      if (range.to >= 0 && range.to <= lineText.length) boundaries.add(range.to)
    }
  }
  if (findHighlights) {
    for (const range of findHighlights) {
      if (range.from >= 0 && range.from <= lineText.length) boundaries.add(range.from)
      if (range.to >= 0 && range.to <= lineText.length) boundaries.add(range.to)
    }
  }
  if (syntaxSpans) {
    for (const span of syntaxSpans) {
      if (span.from >= 0 && span.from <= lineText.length) boundaries.add(span.from)
      if (span.to >= 0 && span.to <= lineText.length) boundaries.add(span.to)
    }
  }
  if (hoverRange) {
    if (hoverRange.columnStart >= 0 && hoverRange.columnStart <= lineText.length) {
      boundaries.add(hoverRange.columnStart)
    }
    if (hoverRange.columnEnd >= 0 && hoverRange.columnEnd <= lineText.length) {
      boundaries.add(hoverRange.columnEnd)
    }
  }

  const sorted = Array.from(boundaries).sort((a, b) => a - b)
  const nodes: ReactNode[] = []
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const from = sorted[i]
    const to = sorted[i + 1]
    if (to <= from) continue
    const text = lineText.slice(from, to)
    const isWordChanged =
      wordHighlights?.some((range) => range.from <= from && to <= range.to) ?? false
    const matchedFind = findHighlights?.find((range) => range.from <= from && to <= range.to)
    const syntaxClass = syntaxSpans?.find((s) => s.from <= from && to <= s.to)?.className ?? null
    const isHovered = Boolean(hoverRange && hoverRange.columnStart <= from && to <= hoverRange.columnEnd)
    const findClass = matchedFind
      ? matchedFind.isActive
        ? 'viewer-search-match is-active'
        : 'viewer-search-match'
      : null
    const className = [syntaxClass, isHovered ? 'symbol-hover-target' : null, findClass]
      .filter(Boolean)
      .join(' ')

    if (isWordChanged || matchedFind) {
      nodes.push(
        createElement(
          'mark',
          {
            key: i,
            'data-col-start': from,
            className: [isWordChanged ? 'git-diff-word-highlight' : null, className]
              .filter(Boolean)
              .join(' ')
          },
          text
        )
      )
    } else {
      nodes.push(
        createElement(
          'span',
          {
            key: i,
            'data-col-start': from,
            className: className || undefined
          },
          text
        )
      )
    }
  }
  return nodes
}
