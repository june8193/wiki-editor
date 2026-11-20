import {
  EditorSelection,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type TransactionSpec
} from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view'
import type { TextMatchSpan } from '@shared/search'
import { clampActiveMatchIndex } from './documentFind'

export interface RawSearchHighlightPayload {
  matches: readonly TextMatchSpan[]
  activeIndex: number
}

export interface RawFindHighlightRequest {
  isActive: boolean
  matches: readonly TextMatchSpan[]
  activeIndex: number
  scrollNonce: number
}

export interface RawJumpHighlightRequest {
  lineNumber: number
  columnStart: number
  columnEnd: number
  nonce: number
}

export const setRawSearchHighlightEffect = StateEffect.define<RawSearchHighlightPayload>()
const setRawSearchJumpHighlightEffect = StateEffect.define<{
  from: number
  to: number
} | null>()

const matchMark = Decoration.mark({ class: 'cm-search-match' })
const activeMatchMark = Decoration.mark({ class: 'cm-search-match cm-search-match-active' })
const jumpMatchMark = Decoration.mark({ class: 'cm-search-jump-highlight' })

function clampSpanToDoc(span: TextMatchSpan, docLength: number): { from: number; to: number } {
  const from = Math.max(0, Math.min(span.start, docLength))
  const to = Math.max(from, Math.min(span.end, docLength))
  return { from, to }
}

function buildSearchDecorations(docLength: number, payload: RawSearchHighlightPayload): DecorationSet {
  const { matches, activeIndex } = payload
  if (matches.length === 0 || docLength <= 0) {
    return Decoration.none
  }

  const builder = new RangeSetBuilder<Decoration>()
  const normalized: Array<{ from: number; to: number; isActive: boolean }> = []
  for (let i = 0; i < matches.length; i += 1) {
    const { from, to } = clampSpanToDoc(matches[i], docLength)
    // CodeMirror Decoration.mark forbids zero-length ranges; empty regex matches still count and scroll.
    if (to <= from) {
      continue
    }
    normalized.push({ from, to, isActive: i === activeIndex })
  }

  normalized.sort((a, b) => a.from - b.from || a.to - b.to)
  for (const item of normalized) {
    builder.add(item.from, item.to, item.isActive ? activeMatchMark : matchMark)
  }
  return builder.finish()
}

export const rawSearchHighlightField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none
  },
  update(decorations, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setRawSearchHighlightEffect)) {
        return buildSearchDecorations(tr.state.doc.length, effect.value)
      }
    }
    if (tr.docChanged) {
      return decorations.map(tr.changes)
    }
    return decorations
  },
  provide: (field) => EditorView.decorations.from(field)
})

export const rawSearchJumpHighlightField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none
  },
  update(decorations, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setRawSearchJumpHighlightEffect)) {
        const range = effect.value
        if (!range) {
          return Decoration.none
        }
        const docLen = tr.state.doc.length
        const from = Math.max(0, Math.min(range.from, docLen))
        const to = Math.max(from, Math.min(range.to, docLen))
        return to > from ? Decoration.set([jumpMatchMark.range(from, to)]) : Decoration.none
      }
    }
    if (tr.docChanged) {
      return Decoration.none
    }
    return decorations
  },
  provide: (field) => EditorView.decorations.from(field)
})

function scrollRawRangeIntoView(
  view: EditorView,
  activeRange: { from: number; to: number },
  onScrolled?: (scrollTop: number, didSetScrollTop: boolean) => void
): void {
  const scroller = view.scrollDOM
  const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
  const isUnlaidOutDom =
    scroller.getBoundingClientRect().height === 0 || view.contentDOM.getClientRects().length === 0

  if (maxScrollTop > 0 && isUnlaidOutDom) {
    const block = view.lineBlockAt(activeRange.from)
    const matchCenterY = view.documentPadding.top + block.top + block.height / 2
    const centeredTop = Math.max(
      0,
      Math.min(maxScrollTop, matchCenterY - scroller.clientHeight / 2)
    )
    const didChange = Math.abs(scroller.scrollTop - centeredTop) > 0.5
    scroller.scrollTop = centeredTop
    onScrolled?.(scroller.scrollTop, didChange)
    return
  }

  if (onScrolled) {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        onScrolled(scroller.scrollTop, false)
      })
    } else {
      onScrolled(scroller.scrollTop, false)
    }
  }
}

/**
 * Applies search match decorations to a CodeMirror 6 view and optionally centers the active match in the scroll area.
 */
export function syncRawSearchHighlights(
  view: EditorView,
  options: {
    isActive: boolean
    matches: readonly TextMatchSpan[]
    activeIndex: number
    scrollToActive: boolean
    externalAnnotation?: TransactionSpec['annotations']
    onScrolled?: (scrollTop: number, didSetScrollTop: boolean) => void
  }
): void {
  const { isActive, matches, activeIndex, scrollToActive, externalAnnotation, onScrolled } = options
  const resolvedMatches = isActive ? matches : []
  const resolvedIndex = isActive
    ? clampActiveMatchIndex(activeIndex, resolvedMatches.length)
    : -1

  const effects: StateEffect<unknown>[] = [
    setRawSearchHighlightEffect.of({
      matches: resolvedMatches,
      activeIndex: resolvedIndex
    })
  ]

  let activeRange: { from: number; to: number } | null = null
  if (scrollToActive && resolvedIndex >= 0) {
    activeRange = clampSpanToDoc(resolvedMatches[resolvedIndex], view.state.doc.length)
    effects.push(
      EditorView.scrollIntoView(EditorSelection.range(activeRange.from, activeRange.to), {
        y: 'center'
      })
    )
  }

  view.dispatch({
    effects,
    ...(externalAnnotation ? { annotations: externalAnnotation } : {})
  })

  if (activeRange) {
    scrollRawRangeIntoView(view, activeRange, onScrolled)
  }
}

/**
 * Resolves a 1-based line and 0-based UTF-16 line columns to clamped CodeMirror document offsets.
 */
function resolveRawLineRange(
  view: EditorView,
  request: Pick<RawJumpHighlightRequest, 'lineNumber' | 'columnStart' | 'columnEnd'>
): { from: number; to: number } {
  const clampedLine = Math.max(1, Math.min(request.lineNumber, view.state.doc.lines))
  const lineInfo = view.state.doc.line(clampedLine)
  const startCol = Math.max(0, Math.min(request.columnStart, lineInfo.length))
  const endCol = Math.max(startCol, Math.min(request.columnEnd, lineInfo.length))
  return {
    from: lineInfo.from + startCol,
    to: lineInfo.from + endCol
  }
}

/**
 * Moves cursor/selection to the jumped line/column range, applies temporary jump decoration,
 * and scrolls the target into view (or clears the temporary decoration when `request` is null).
 */
export function syncRawJumpHighlight(
  view: EditorView,
  request: RawJumpHighlightRequest | null,
  options: {
    externalAnnotation?: TransactionSpec['annotations']
    onScrolled?: (scrollTop: number, didSetScrollTop: boolean) => void
  } = {}
): void {
  if (!request) {
    const currentDecorations = view.state.field(rawSearchJumpHighlightField, false)
    if (!currentDecorations || currentDecorations.size === 0) {
      return
    }
    view.dispatch({
      effects: [setRawSearchJumpHighlightEffect.of(null)],
      ...(options.externalAnnotation ? { annotations: options.externalAnnotation } : {})
    })
    return
  }

  const range = resolveRawLineRange(view, request)
  view.dispatch({
    selection: { anchor: range.from, head: range.to },
    effects: [
      setRawSearchJumpHighlightEffect.of(range),
      EditorView.scrollIntoView(EditorSelection.range(range.from, range.to), {
        y: 'center'
      })
    ]
  })
  scrollRawRangeIntoView(view, range, options.onScrolled)
}
