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

export const setRawSearchHighlightEffect = StateEffect.define<RawSearchHighlightPayload>()

const matchMark = Decoration.mark({ class: 'cm-search-match' })
const activeMatchMark = Decoration.mark({ class: 'cm-search-match cm-search-match-active' })

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

  if (!activeRange) {
    return
  }

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
