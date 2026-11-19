import { Extension, type Editor } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import {
  compileSearchMatcher,
  DEFAULT_SEARCH_MATCH_OPTIONS,
  type CompiledSearchMatcher,
  type SearchMatchOptions
} from '@shared/search'
import { isMermaidLanguage } from './codeBlockHighlight'
import {
  areSearchMatchOptionsEqual,
  clampActiveMatchIndex,
  type DocumentFindHighlightQuery,
  extractSingleLineFindQuery,
  readDomSingleLineSelection,
  scrollMatchElementIntoView
} from './documentFind'

export interface ProseMirrorSearchMatch {
  from: number
  to: number
}

export interface WysiwygSearchPluginState {
  isActive: boolean
  query: string
  options: SearchMatchOptions
  activeIndex: number
  matches: readonly ProseMirrorSearchMatch[]
  errorMessage: string | null
  decorations: DecorationSet
}

interface WysiwygSearchMeta {
  isActive: boolean
  query: string
  options: SearchMatchOptions
  activeIndex: number
}

interface TextRunSegment {
  text: string
  pmFrom: number
  startOffset: number
  endOffset: number
}

export const wysiwygSearchHighlightPluginKey = new PluginKey<WysiwygSearchPluginState>(
  'wysiwygSearchHighlight'
)

function createEmptyPluginState(
  overrides: Partial<Pick<WysiwygSearchPluginState, 'isActive' | 'query' | 'options'>> = {}
): WysiwygSearchPluginState {
  return {
    isActive: overrides.isActive ?? false,
    query: overrides.query ?? '',
    options: overrides.options ?? { ...DEFAULT_SEARCH_MATCH_OPTIONS },
    activeIndex: -1,
    matches: [],
    errorMessage: null,
    decorations: DecorationSet.empty
  }
}

function resolveSegmentPmPosition(segments: readonly TextRunSegment[], offset: number): number {
  for (const segment of segments) {
    if (offset <= segment.endOffset) {
      return segment.pmFrom + (offset - segment.startOffset)
    }
  }
  const last = segments[segments.length - 1]
  return last.pmFrom + last.text.length
}

function flushTextRun(
  segments: TextRunSegment[],
  matcher: CompiledSearchMatcher,
  matches: ProseMirrorSearchMatch[]
): void {
  if (segments.length === 0) {
    return
  }
  const combinedText = segments.map((segment) => segment.text).join('')
  for (const span of matcher.findMatches(combinedText)) {
    const from = resolveSegmentPmPosition(segments, span.start)
    const to = resolveSegmentPmPosition(segments, span.end)
    matches.push({ from, to: Math.max(from, to) })
  }
  segments.length = 0
}

function findProseMirrorMatches(
  doc: ProseMirrorNode,
  query: string,
  options: SearchMatchOptions
): { matches: ProseMirrorSearchMatch[]; errorMessage: string | null } {
  if (query.length === 0) {
    return { matches: [], errorMessage: null }
  }
  const compiled = compileSearchMatcher(query, options)
  if (!compiled.ok) {
    return { matches: [], errorMessage: compiled.error }
  }

  const matches: ProseMirrorSearchMatch[] = []
  const runSegments: TextRunSegment[] = []

  doc.descendants((node, pos) => {
    if (node.type.name === 'codeBlock') {
      const language = typeof node.attrs.language === 'string' ? node.attrs.language : ''
      if (isMermaidLanguage(language)) {
        return false
      }
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
  if (!meta.isActive || meta.query.length === 0) {
    return createEmptyPluginState({
      isActive: meta.isActive,
      query: meta.query,
      options: meta.options
    })
  }
  const { matches, errorMessage } = findProseMirrorMatches(doc, meta.query, meta.options)
  const activeIndex = clampActiveMatchIndex(meta.activeIndex, matches.length)
  return {
    isActive: true,
    query: meta.query,
    options: meta.options,
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
                prev.query === meta.query &&
                areSearchMatchOptionsEqual(prev.options, meta.options)
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
                query: prev.query,
                options: prev.options,
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
 * Synchronizes the WYSIWYG ProseMirror search plugin with the active Find Bar query/index
 * without mutating the document or appending undo history.
 */
export function syncWysiwygSearchHighlights(
  editor: Editor,
  request: DocumentFindHighlightQuery | null
): WysiwygSearchPluginState | undefined {
  const current = wysiwygSearchHighlightPluginKey.getState(editor.state)
  if (!current) {
    return undefined
  }

  const nextIsActive = Boolean(request?.isActive)
  const nextQuery = request?.isActive ? request.query : ''
  const nextOptions = request?.options ?? DEFAULT_SEARCH_MATCH_OPTIONS
  const nextRawIndex = request?.isActive ? request.activeIndex : -1

  const sameQuery =
    current.isActive === nextIsActive &&
    current.query === nextQuery &&
    areSearchMatchOptionsEqual(current.options, nextOptions)
  const expectedActiveIndex =
    sameQuery && nextIsActive
      ? clampActiveMatchIndex(nextRawIndex, current.matches.length)
      : nextRawIndex

  if (sameQuery && current.activeIndex === expectedActiveIndex) {
    return current
  }

  const meta: WysiwygSearchMeta = {
    isActive: nextIsActive,
    query: nextQuery,
    options: nextOptions,
    activeIndex: nextRawIndex
  }
  editor.view.dispatch(
    editor.state.tr.setMeta(wysiwygSearchHighlightPluginKey, meta).setMeta('addToHistory', false)
  )
  return wysiwygSearchHighlightPluginKey.getState(editor.state)
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

  if (typeof window !== 'undefined') {
    const domSelection = window.getSelection()
    if (domSelection && domSelection.rangeCount > 0 && !domSelection.isCollapsed) {
      const range = domSelection.getRangeAt(0)
      const shell = editor.view.dom.closest('.wysiwyg-shell') ?? editor.view.dom
      if (shell.contains(range.startContainer) || shell.contains(range.endContainer)) {
        const startEl =
          range.startContainer instanceof Element
            ? range.startContainer
            : range.startContainer.parentElement
        const endEl =
          range.endContainer instanceof Element
            ? range.endContainer
            : range.endContainer.parentElement
        if (
          startEl?.closest(WYSIWYG_SEARCH_CHROME_SELECTOR) ||
          endEl?.closest(WYSIWYG_SEARCH_CHROME_SELECTOR)
        ) {
          return null
        }
        if (
          editor.view.dom.contains(range.startContainer) &&
          editor.view.dom.contains(range.endContainer)
        ) {
          return readDomSingleLineSelection(editor.view.dom, WYSIWYG_SEARCH_CHROME_SELECTOR)
        }
      }
    }
  }

  const { from, to, empty, $from, $to } = editor.state.selection
  if (!empty) {
    if (!$from.sameParent($to)) {
      return null
    }
    if (
      $from.parent.type.name === 'codeBlock' &&
      isMermaidLanguage(
        typeof $from.parent.attrs.language === 'string' ? $from.parent.attrs.language : ''
      )
    ) {
      return null
    }
    return extractSingleLineFindQuery(editor.state.doc.textBetween(from, to, '\n'))
  }

  return null
}
