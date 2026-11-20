import { Extension, type Editor } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import {
  compileSearchMatcher,
  DEFAULT_SEARCH_MATCH_OPTIONS,
  type CompiledSearchMatcher
} from '@shared/search'
import { isMermaidLanguage } from './codeBlockHighlight'
import {
  areDocumentFindCriteriaEqual,
  areDocumentFindResultReportsEqual,
  clampActiveMatchIndex,
  consumeMatchedTextRun,
  type DocumentFindCriteria,
  type DocumentFindHighlightQuery,
  type DocumentFindResultReport,
  extractSingleLineFindQuery,
  inspectDomSingleLineSelection,
  scrollMatchElementIntoView,
  type TextRunSegment
} from './documentFind'

interface ProseMirrorSearchMatch {
  from: number
  to: number
}

export interface WysiwygSearchSnapshot {
  isActive: boolean
  activeIndex: number
  report: DocumentFindResultReport
}

interface WysiwygSearchPluginState {
  isActive: boolean
  criteria: DocumentFindCriteria
  activeIndex: number
  matches: readonly ProseMirrorSearchMatch[]
  errorMessage: string | null
  decorations: DecorationSet
}

interface WysiwygSearchMeta {
  isActive: boolean
  criteria: DocumentFindCriteria
  activeIndex: number
}

interface PmTextRunSegment extends TextRunSegment {
  pmFrom: number
}

const wysiwygSearchHighlightPluginKey = new PluginKey<WysiwygSearchPluginState>(
  'wysiwygSearchHighlight'
)

function createDefaultCriteria(): DocumentFindCriteria {
  return {
    query: '',
    options: { ...DEFAULT_SEARCH_MATCH_OPTIONS }
  }
}

function createEmptyPluginState(
  overrides: Partial<Pick<WysiwygSearchPluginState, 'isActive' | 'criteria'>> = {}
): WysiwygSearchPluginState {
  return {
    isActive: overrides.isActive ?? false,
    criteria: overrides.criteria ?? createDefaultCriteria(),
    activeIndex: -1,
    matches: [],
    errorMessage: null,
    decorations: DecorationSet.empty
  }
}

function toWysiwygSearchSnapshot(state: WysiwygSearchPluginState): WysiwygSearchSnapshot {
  return {
    isActive: state.isActive,
    activeIndex: state.activeIndex,
    report: {
      criteria: state.criteria,
      matchCount: state.matches.length,
      errorMessage: state.errorMessage
    }
  }
}

function resolveSegmentPmPosition(
  segments: readonly PmTextRunSegment[],
  offset: number
): number {
  for (const segment of segments) {
    if (offset <= segment.endOffset) {
      return segment.pmFrom + (offset - segment.startOffset)
    }
  }
  const last = segments[segments.length - 1]
  return last.pmFrom + last.text.length
}

function flushTextRun(
  segments: PmTextRunSegment[],
  matcher: CompiledSearchMatcher,
  matches: ProseMirrorSearchMatch[]
): void {
  consumeMatchedTextRun(segments, matcher, (span, runSegments) => {
    const from = resolveSegmentPmPosition(runSegments, span.start)
    const to = resolveSegmentPmPosition(runSegments, span.end)
    matches.push({ from, to: Math.max(from, to) })
  })
}

function isMermaidCodeBlockNode(node: ProseMirrorNode): boolean {
  return (
    node.type.name === 'codeBlock' &&
    isMermaidLanguage(typeof node.attrs.language === 'string' ? node.attrs.language : '')
  )
}

function findProseMirrorMatches(
  doc: ProseMirrorNode,
  criteria: DocumentFindCriteria
): { matches: ProseMirrorSearchMatch[]; errorMessage: string | null } {
  if (criteria.query.length === 0) {
    return { matches: [], errorMessage: null }
  }
  const compiled = compileSearchMatcher(criteria.query, criteria.options)
  if (!compiled.ok) {
    return { matches: [], errorMessage: compiled.error }
  }

  const matches: ProseMirrorSearchMatch[] = []
  const runSegments: PmTextRunSegment[] = []

  doc.descendants((node, pos) => {
    if (isMermaidCodeBlockNode(node)) {
      return false
    }

    if (!node.isTextblock) {
      return true
    }

    let childPos = pos + 1
    let runLength = 0
    for (let i = 0; i < node.childCount; i += 1) {
      const child = node.child(i)
      if (child.isText && child.text) {
        runSegments.push({
          text: child.text,
          pmFrom: childPos,
          startOffset: runLength,
          endOffset: runLength + child.text.length
        })
        runLength += child.text.length
      } else {
        flushTextRun(runSegments, compiled.matcher, matches)
        runLength = 0
      }
      childPos += child.nodeSize
    }
    flushTextRun(runSegments, compiled.matcher, matches)
    return false
  })

  return { matches, errorMessage: null }
}

function buildWysiwygSearchDecorations(
  doc: ProseMirrorNode,
  matches: readonly ProseMirrorSearchMatch[],
  activeIndex: number
): DecorationSet {
  if (matches.length === 0) {
    return DecorationSet.empty
  }

  const resolvedActive = clampActiveMatchIndex(activeIndex, matches.length)
  const decorations: Decoration[] = []
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i]
    if (match.to <= match.from) {
      continue
    }
    decorations.push(
      Decoration.inline(match.from, match.to, {
        class: i === resolvedActive ? 'pm-search-match pm-search-match-active' : 'pm-search-match'
      })
    )
  }

  return decorations.length > 0 ? DecorationSet.create(doc, decorations) : DecorationSet.empty
}

function computePluginStateForQuery(
  doc: ProseMirrorNode,
  meta: WysiwygSearchMeta
): WysiwygSearchPluginState {
  if (!meta.isActive || meta.criteria.query.length === 0) {
    return createEmptyPluginState({
      isActive: meta.isActive,
      criteria: meta.criteria
    })
  }
  const { matches, errorMessage } = findProseMirrorMatches(doc, meta.criteria)
  const activeIndex = clampActiveMatchIndex(meta.activeIndex, matches.length)
  return {
    isActive: true,
    criteria: meta.criteria,
    activeIndex,
    matches,
    errorMessage,
    decorations: buildWysiwygSearchDecorations(doc, matches, activeIndex)
  }
}

export const WysiwygSearchHighlight = Extension.create({
  name: 'wysiwygSearchHighlight',
  addProseMirrorPlugins() {
    return [
      new Plugin<WysiwygSearchPluginState>({
        key: wysiwygSearchHighlightPluginKey,
        state: {
          init: () => createEmptyPluginState(),
          apply: (tr, prev) => {
            const meta = tr.getMeta(wysiwygSearchHighlightPluginKey) as
              | WysiwygSearchMeta
              | undefined
            if (meta) {
              if (
                !tr.docChanged &&
                meta.isActive &&
                prev.isActive &&
                areDocumentFindCriteriaEqual(prev.criteria, meta.criteria)
              ) {
                const nextActive = clampActiveMatchIndex(meta.activeIndex, prev.matches.length)
                if (nextActive === prev.activeIndex) {
                  return prev
                }
                return {
                  ...prev,
                  activeIndex: nextActive,
                  decorations: buildWysiwygSearchDecorations(tr.doc, prev.matches, nextActive)
                }
              }
              return computePluginStateForQuery(tr.doc, meta)
            }

            if (tr.docChanged && prev.isActive) {
              return computePluginStateForQuery(tr.doc, {
                isActive: prev.isActive,
                criteria: prev.criteria,
                activeIndex: prev.activeIndex
              })
            }

            return prev
          }
        },
        props: {
          decorations(state) {
            return wysiwygSearchHighlightPluginKey.getState(state)?.decorations ?? DecorationSet.empty
          }
        }
      })
    ]
  }
})

/**
 * Extracts an immutable search snapshot from the WYSIWYG ProseMirror plugin state.
 */
export function getWysiwygSearchSnapshot(editor: Editor): WysiwygSearchSnapshot | null {
  const state = wysiwygSearchHighlightPluginKey.getState(editor.state)
  return state ? toWysiwygSearchSnapshot(state) : null
}

/**
 * Compares two `WysiwygSearchSnapshot` values for structural equality.
 */
export function areWysiwygSearchSnapshotsEqual(
  prev: WysiwygSearchSnapshot | null,
  next: WysiwygSearchSnapshot | null
): boolean {
  if (prev === next) {
    return true
  }
  if (!prev || !next) {
    return false
  }
  return (
    prev.isActive === next.isActive &&
    prev.activeIndex === next.activeIndex &&
    areDocumentFindResultReportsEqual(prev.report, next.report)
  )
}

/**
 * Synchronizes the WYSIWYG ProseMirror search plugin with the active Find Bar query/index
 * without mutating the document or appending undo history.
 */
export function syncWysiwygSearchHighlights(
  editor: Editor,
  request: DocumentFindHighlightQuery | null
): WysiwygSearchSnapshot | null {
  const current = wysiwygSearchHighlightPluginKey.getState(editor.state)
  if (!current) {
    return null
  }

  const nextIsActive = Boolean(request?.isActive)
  const nextCriteria: DocumentFindCriteria = request?.isActive
    ? request.criteria
    : request
      ? { query: '', options: request.criteria.options }
      : createDefaultCriteria()
  const nextRawIndex = request?.isActive ? request.activeIndex : -1

  const sameQuery =
    current.isActive === nextIsActive && areDocumentFindCriteriaEqual(current.criteria, nextCriteria)
  const expectedActiveIndex =
    sameQuery && nextIsActive
      ? clampActiveMatchIndex(nextRawIndex, current.matches.length)
      : nextRawIndex

  if (sameQuery && current.activeIndex === expectedActiveIndex) {
    return toWysiwygSearchSnapshot(current)
  }

  const meta: WysiwygSearchMeta = {
    isActive: nextIsActive,
    criteria: nextCriteria,
    activeIndex: nextRawIndex
  }
  editor.view.dispatch(
    editor.state.tr.setMeta(wysiwygSearchHighlightPluginKey, meta).setMeta('addToHistory', false)
  )
  return getWysiwygSearchSnapshot(editor)
}

/**
 * Scrolls the active ProseMirror search match DOM element into the center of the WYSIWYG scroll container.
 */
export function scrollWysiwygActiveMatch(
  editor: Editor,
  scrollContainer: HTMLElement | null
): void {
  const activeEl = editor.view.dom.querySelector('.pm-search-match-active')
  if (activeEl) {
    scrollMatchElementIntoView(activeEl, scrollContainer)
    return
  }
  const state = wysiwygSearchHighlightPluginKey.getState(editor.state)
  if (!state || state.activeIndex < 0 || state.activeIndex >= state.matches.length) {
    return
  }
  const match = state.matches[state.activeIndex]
  const domPos = editor.view.domAtPos(match.from)
  const target = domPos.node instanceof Element ? domPos.node : domPos.node.parentElement
  scrollMatchElementIntoView(target, scrollContainer)
}

const WYSIWYG_SEARCH_CHROME_SELECTOR =
  '.code-block-header, .mermaid-node-header, .mermaid-node-preview, .mermaid-node-source-wrapper, .mermaid-diagram-block, .editor-toolbar, .editor-table-toolbar'

/**
 * Reads a single-line selection from the WYSIWYG ProseMirror editor (prioritizing active DOM selections
 * inside the WYSIWYG shell so stale ProseMirror selections cannot leak when dragging in UI chrome).
 */
export function readWysiwygSingleLineSelection(editor: Editor | null): string | null {
  if (!editor || editor.isDestroyed) {
    return null
  }

  const shell = editor.view.dom.closest('.wysiwyg-shell') ?? editor.view.dom
  const domResult = inspectDomSingleLineSelection(
    editor.view.dom,
    WYSIWYG_SEARCH_CHROME_SELECTOR,
    shell
  )
  if (domResult.inBoundary) {
    return domResult.value
  }

  const { from, to, empty, $from, $to } = editor.state.selection
  if (!empty) {
    if (!$from.sameParent($to)) {
      return null
    }
    if (isMermaidCodeBlockNode($from.parent)) {
      return null
    }
    return extractSingleLineFindQuery(editor.state.doc.textBetween(from, to, '\n'))
  }

  return null
}
