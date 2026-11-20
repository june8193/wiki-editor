import { useCallback, useMemo } from 'react'
import type { DocumentBufferSnapshot } from '@shared/documentBuffer'
import type { PaneInteractionActions } from '../components/PaneTabBar'
import { isMarkdownDocument } from '../editor/editorModes'
import type { OutlineContextTarget } from '../editor/outlineScrollSpy'
import { useOutlineScrollSpy } from './useOutlineScrollSpy'
import {
  getPaneActiveTab,
  type PaneId,
  type PaneLayoutState,
  type TabViewPatch
} from '../stores/PaneTabStore'

/**
 * Coordinates document outline scroll-spy tracking and heading click-to-scroll
 * navigation for the active tab inside the pane workspace.
 */
export function useDocumentOutline(
  layout: PaneLayoutState,
  buffers: DocumentBufferSnapshot,
  actions: PaneInteractionActions
) {
  const activePane = layout.panes[layout.activePaneId]
  const activeTab = getPaneActiveTab(activePane)
  const activeBuffer = activeTab?.kind === 'document' ? buffers[activeTab.bufferKey] : undefined
  const isActiveMarkdown = activeBuffer ? isMarkdownDocument(activeBuffer) : false
  const activeBufferContent = activeBuffer?.content ?? ''
  const activeTabId = activeTab?.kind === 'document' ? activeTab.id : null
  const activeTabMode = activeTab?.kind === 'document' ? activeTab.mode : null

  const activeOutlineContext = useMemo<OutlineContextTarget | null>(
    () =>
      activeTabId && activeTabMode && isActiveMarkdown
        ? { paneId: activePane.id, tabId: activeTabId, mode: activeTabMode }
        : null,
    [activePane.id, activeTabId, activeTabMode, isActiveMarkdown]
  )

  const {
    outlineScrollRequest,
    activeHeadingIndex,
    handleActiveHeadingReport,
    dispatchHeadingScroll,
    selectHeading,
    clearScrollRequest
  } = useOutlineScrollSpy({
    activeContext: activeOutlineContext,
    bufferContent: activeBufferContent
  })

  const { onChangeContent, onUpdateTabViewState } = actions

  const handlePaneChangeContent = useCallback(
    (bufferKey: string, nextContent: string): void => {
      clearScrollRequest()
      onChangeContent(bufferKey, nextContent)
    },
    [clearScrollRequest, onChangeContent]
  )

  const handlePaneUpdateTabViewState = useCallback(
    (paneId: PaneId, tabId: string, patch: TabViewPatch): void => {
      if (patch.mode !== undefined) {
        clearScrollRequest()
      }
      onUpdateTabViewState(paneId, tabId, patch)
    },
    [clearScrollRequest, onUpdateTabViewState]
  )

  const paneActions = useMemo<PaneInteractionActions>(
    () => ({
      ...actions,
      onChangeContent: handlePaneChangeContent,
      onUpdateTabViewState: handlePaneUpdateTabViewState
    }),
    [actions, handlePaneChangeContent, handlePaneUpdateTabViewState]
  )

  return {
    scrollRequest: outlineScrollRequest,
    handleActiveHeadingChange: handleActiveHeadingReport,
    dispatchHeadingScroll,
    paneActions,
    activeHeadingIndex,
    selectHeading
  }
}
