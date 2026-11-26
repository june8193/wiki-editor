import { useEffect, useRef, useSyncExternalStore } from 'react'
import {
  CompareSession,
  type CompareDiffTabsCollaborator,
  type ComparePanelActions,
  type ComparePanelState
} from '../stores/CompareSession'
import { useWikiApi } from './useWikiApi'

export interface UseCompareSessionOptions {
  workspaceRootPath: string | null
  isRepo: boolean | null
  diffTabs: CompareDiffTabsCollaborator
}

export interface UseCompareSessionResult {
  state: ComparePanelState
  actions: ComparePanelActions
}

/**
 * React binding hook over `CompareSession` preserving Compare panel state across
 * left-sidebar view switches and resetting when the workspace changes.
 */
export function useCompareSession({
  workspaceRootPath,
  isRepo,
  diffTabs
}: UseCompareSessionOptions): UseCompareSessionResult {
  const wikiApi = useWikiApi()
  const diffTabsRef = useRef(diffTabs)
  diffTabsRef.current = diffTabs

  const sessionRef = useRef<CompareSession | null>(null)
  if (!sessionRef.current) {
    sessionRef.current = new CompareSession({
      gitApi: wikiApi.git,
      diffTabs: {
        openDiffTab: (request, options) => diffTabsRef.current.openDiffTab(request, options),
        reconcileBranchCompareDiffTabs: (baseRef, compareRef, mode, files) =>
          diffTabsRef.current.reconcileBranchCompareDiffTabs(baseRef, compareRef, mode, files)
      },
      workspaceRootPath
    })
  }

  const session = sessionRef.current
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot)

  useEffect(() => {
    session.setWorkspaceContext(workspaceRootPath, isRepo)
  }, [session, workspaceRootPath, isRepo])

  return {
    state,
    actions: session.actions
  }
}
