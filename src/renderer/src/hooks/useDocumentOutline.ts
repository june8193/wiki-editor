import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DocumentBufferSnapshot } from '@shared/documentBuffer'
import type { OutlineScrollRequest } from '../components/DocumentEditor'
import type { DocumentOutlinePanelProps } from '../components/DocumentOutlinePanel'
import type { PaneInteractionActions } from '../components/PaneTabBar'
import { isMarkdownDocument } from '../editor/editorModes'
import {
  applyHeadingNumbers,
  findFirstNonFencedSlashTocLine,
  insertOrUpdateTocBlock,
  type MarkdownHeading,
  resolveRawCursorLine,
  stripHeadingNumbers
} from '../editor/MarkdownTocEngine'
import {
  getPaneActiveTab,
  type PaneId,
  type PaneLayoutState,
  type TabViewPatch
} from '../stores/PaneTabStore'

export type DocumentOutlineContentProps = Omit<
  DocumentOutlinePanelProps,
  'showHeadingNumbers' | 'onToggleHeadingNumbers' | 'onCollapse'
>

/**
 * Coordinates document outline heading navigation, `/toc` insertion, and heading numbering
 * transforms for the active tab inside the pane workspace.
 */
export function useDocumentOutline(
  layout: PaneLayoutState,
  buffers: DocumentBufferSnapshot,
  actions: PaneInteractionActions
) {
  const [scrollRequest, setScrollRequest] = useState<OutlineScrollRequest | null>(null)
  const scrollNonceRef = useRef(0)

  const activePane = layout.panes[layout.activePaneId]
  const activeTab = getPaneActiveTab(activePane)
  const activeBuffer = activeTab ? buffers[activeTab.bufferKey] : undefined
  const isActiveMarkdown = activeBuffer ? isMarkdownDocument(activeBuffer) : false
  const { onChangeContent, onUpdateTabViewState } = actions

  const applyActiveMarkdownTransform = useCallback(
    (transform: (content: string) => string): void => {
      if (!activeBuffer || !isActiveMarkdown) return
      const nextContent = transform(activeBuffer.content)
      if (nextContent !== activeBuffer.content) {
        onChangeContent(activeBuffer.key, nextContent)
      }
    },
    [activeBuffer, isActiveMarkdown, onChangeContent]
  )

  const handleSelectHeading = useCallback(
    (heading: MarkdownHeading, index: number): void => {
      if (!activeTab || !isActiveMarkdown) return
      scrollNonceRef.current += 1
      setScrollRequest({
        paneId: activePane.id,
        tabId: activeTab.id,
        mode: activeTab.mode,
        line: heading.line,
        slug: heading.slug,
        index,
        nonce: scrollNonceRef.current
      })
    },
    [activePane.id, activeTab, isActiveMarkdown]
  )

  useEffect(() => {
    if (scrollRequest !== null) {
      setScrollRequest(null)
    }
  }, [scrollRequest])

  const handleInsertToc = useCallback((): void => {
    applyActiveMarkdownTransform((content) => {
      const cursorLine =
        activeTab?.mode === 'raw'
          ? resolveRawCursorLine(content, activeTab.cursor.selectionStart)
          : findFirstNonFencedSlashTocLine(content)
      return insertOrUpdateTocBlock(content, cursorLine)
    })
  }, [activeTab?.cursor.selectionStart, activeTab?.mode, applyActiveMarkdownTransform])

  const handleApplyHeadingNumbers = useCallback((): void => {
    applyActiveMarkdownTransform(applyHeadingNumbers)
  }, [applyActiveMarkdownTransform])

  const handleStripHeadingNumbers = useCallback((): void => {
    applyActiveMarkdownTransform(stripHeadingNumbers)
  }, [applyActiveMarkdownTransform])

  const handlePaneChangeContent = useCallback(
    (bufferKey: string, nextContent: string): void => {
      setScrollRequest(null)
      onChangeContent(bufferKey, nextContent)
    },
    [onChangeContent]
  )

  const handlePaneUpdateTabViewState = useCallback(
    (paneId: PaneId, tabId: string, patch: TabViewPatch): void => {
      if (patch.mode !== undefined) {
        setScrollRequest(null)
      }
      onUpdateTabViewState(paneId, tabId, patch)
    },
    [onUpdateTabViewState]
  )

  const paneActions = useMemo<PaneInteractionActions>(
    () => ({
      ...actions,
      onChangeContent: handlePaneChangeContent,
      onUpdateTabViewState: handlePaneUpdateTabViewState
    }),
    [actions, handlePaneChangeContent, handlePaneUpdateTabViewState]
  )

  const documentOutlineProps: DocumentOutlineContentProps = {
    documentName: activeBuffer?.name ?? null,
    content: activeBuffer?.content ?? '',
    isMarkdownDocument: isActiveMarkdown,
    onSelectHeading: handleSelectHeading,
    onInsertToc: handleInsertToc,
    onApplyHeadingNumbers: handleApplyHeadingNumbers,
    onStripHeadingNumbers: handleStripHeadingNumbers
  }

  return {
    scrollRequest,
    paneActions,
    documentOutlineProps
  }
}
