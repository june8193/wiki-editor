import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  DocumentSearchJumpRequest,
  SearchMatchOptions,
  WorkspaceSearchFileResult,
  WorkspaceSearchLineMatch
} from '@shared/search'
import type { EditorMode, PaneId } from '@shared/window'
import type { WorkspaceEntry } from '@shared/workspace'
import { getPaneActiveTab, type PaneLayoutState } from '../stores/PaneTabStore'
import type { OpenedWorkspaceDocument } from '../stores/RendererBufferSyncClient'

interface JumpDispatchContext {
  workspaceRootPath: string | null
  paneId: PaneId
  tabId: string
  mode: EditorMode
}

export interface UseWorkspaceSearchJumpOptions {
  workspaceRootPath: string | null
  layout: PaneLayoutState
  query: string
  responseQuery: string | null
  options: SearchMatchOptions
  getSwitchSequence: () => number
  openWorkspaceFile: (
    target: WorkspaceEntry | string,
    targetPaneId?: PaneId,
    explicitName?: string,
    isCancelled?: () => boolean
  ) => Promise<OpenedWorkspaceDocument | null>
}

/**
 * Manages dispatching and invalidating mode-preserving Search View match jump requests
 * across async file opens, tab/mode changes, and workspace switches.
 */
export function useWorkspaceSearchJump({
  workspaceRootPath,
  layout,
  query,
  responseQuery,
  options,
  getSwitchSequence,
  openWorkspaceFile
}: UseWorkspaceSearchJumpOptions) {
  const [searchJumpRequest, setSearchJumpRequest] = useState<DocumentSearchJumpRequest | null>(
    null
  )
  const isMountedRef = useRef<boolean>(true)
  const searchJumpSeqRef = useRef<number>(0)
  const searchJumpContextRef = useRef<JumpDispatchContext | null>(null)

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  const invalidatePendingSearchJumps = useCallback((): void => {
    searchJumpSeqRef.current += 1
    searchJumpContextRef.current = null
    setSearchJumpRequest(null)
  }, [])

  useEffect(() => {
    invalidatePendingSearchJumps()
  }, [invalidatePendingSearchJumps, workspaceRootPath])

  useEffect(() => {
    if (!searchJumpRequest) {
      return
    }
    const targetPane = layout.panes[searchJumpRequest.paneId]
    const activeTab = targetPane ? getPaneActiveTab(targetPane) : null
    const ctx = searchJumpContextRef.current
    if (
      !ctx ||
      ctx.workspaceRootPath !== workspaceRootPath ||
      ctx.paneId !== searchJumpRequest.paneId ||
      ctx.tabId !== searchJumpRequest.tabId ||
      !activeTab ||
      !('mode' in activeTab) ||
      activeTab.id !== searchJumpRequest.tabId ||
      ctx.mode !== activeTab.mode
    ) {
      invalidatePendingSearchJumps()
    }
  }, [invalidatePendingSearchJumps, layout, searchJumpRequest, workspaceRootPath])

  const openSearchLineMatch = useCallback(
    (file: WorkspaceSearchFileResult, line: WorkspaceSearchLineMatch): void => {
      const jumpSeq = ++searchJumpSeqRef.current
      const dispatchSwitchSeq = getSwitchSequence()
      const dispatchWorkspaceRootPath = workspaceRootPath
      const dispatchQuery = responseQuery ?? query
      const dispatchOptions = options
      searchJumpContextRef.current = null
      setSearchJumpRequest(null)

      const firstSpan = line.matches[0]
      const columnStart = firstSpan ? line.lineOffset + firstSpan.start : 0
      const columnEnd = firstSpan ? line.lineOffset + firstSpan.end : 0
      const isCancelled = (): boolean =>
        !isMountedRef.current ||
        searchJumpSeqRef.current !== jumpSeq ||
        getSwitchSequence() !== dispatchSwitchSeq

      void openWorkspaceFile(file.path, undefined, file.name, isCancelled).then((opened) => {
        if (!opened || isCancelled()) {
          return
        }
        searchJumpContextRef.current = {
          workspaceRootPath: dispatchWorkspaceRootPath,
          paneId: opened.paneId,
          tabId: opened.tab.id,
          mode: opened.tab.mode
        }
        setSearchJumpRequest({
          paneId: opened.paneId,
          tabId: opened.tab.id,
          query: dispatchQuery,
          options: dispatchOptions,
          lineNumber: line.lineNumber,
          columnStart,
          columnEnd,
          nonce: jumpSeq
        })
      })
    },
    [
      getSwitchSequence,
      openWorkspaceFile,
      options,
      query,
      responseQuery,
      workspaceRootPath
    ]
  )

  return {
    searchJumpRequest,
    openSearchLineMatch,
    invalidatePendingSearchJumps
  }
}
