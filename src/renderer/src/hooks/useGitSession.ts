import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import type { GitStashEntry } from '@shared/git'
import {
  GitSession,
  type GitConfirmCollaborator,
  type GitPanelActions,
  type GitPanelState,
  type GitSessionSnapshot
} from '../stores/GitSession'
import type { useEditorWorkspace } from './useEditorWorkspace'
import { useWikiApi } from './useWikiApi'

export interface GitSessionRuntimeCollaborators {
  editor: ReturnType<typeof useEditorWorkspace>
  refreshTree: () => Promise<void>
  onBeforeOpenTab?: () => void
}

export interface UseGitSessionOptions {
  confirm: GitConfirmCollaborator
  collaboratorsRef: { current: GitSessionRuntimeCollaborators | null }
}

export interface UseGitSessionResult {
  panelState: GitPanelState
  diffsByKey: GitSessionSnapshot['diffsByKey']
  isMutating: boolean
  actions: GitPanelActions
  setWorkspaceRootPath: (nextRootPath: string | null) => void
  isStashDialogOpen: () => boolean
}

/**
 * React binding hook over `GitSession`, bridging MainAppShell's confirm dialog,
 * editor workspace buffers/diff tabs, and workspace tree refresh into one session store.
 */
export function useGitSession({
  confirm,
  collaboratorsRef
}: UseGitSessionOptions): UseGitSessionResult {
  const wikiApi = useWikiApi()
  const confirmRef = useRef(confirm)
  confirmRef.current = confirm

  const subscriptionBridgeRef = useRef<{
    listener: (() => void) | null
    unsubscribe: (() => void) | null
    attach: () => void
  } | null>(null)
  if (!subscriptionBridgeRef.current) {
    const bridge = {
      listener: null as (() => void) | null,
      unsubscribe: null as (() => void) | null,
      attach: () => {
        if (!bridge.listener || bridge.unsubscribe || !collaboratorsRef.current) {
          return
        }
        bridge.unsubscribe = collaboratorsRef.current.editor.subscribeLayout(bridge.listener)
      }
    }
    subscriptionBridgeRef.current = bridge
  }

  const sessionRef = useRef<GitSession | null>(null)
  if (!sessionRef.current) {
    const bridge = subscriptionBridgeRef.current
    sessionRef.current = new GitSession({
      gitApi: wikiApi.git,
      buffers: {
        getDirtySummary: (targetPaths) =>
          collaboratorsRef.current?.editor.getDirtyWorkspaceSummary(targetPaths) ?? null,
        saveDirtyBuffers: (targetPaths) =>
          collaboratorsRef.current?.editor.ensureAllWorkspaceBuffersSaved(targetPaths) ??
          Promise.resolve(true),
        prepareDiscardPaths: (targetPaths) =>
          collaboratorsRef.current?.editor.prepareWorkspacePathsForDiscard(targetPaths) ??
          Promise.resolve(),
        finishDiscardPaths: (targetPaths, forceSync) =>
          collaboratorsRef.current?.editor.finishWorkspacePathsDiscard(targetPaths, forceSync) ??
          Promise.resolve(),
        reconcileWithDisk: () =>
          collaboratorsRef.current?.editor.reconcileWorkspaceBuffersWithDisk() ??
          Promise.resolve([]),
        openWorkspaceFile: (filePath, explicitName) => {
          const runtime = collaboratorsRef.current
          if (!runtime) return
          runtime.onBeforeOpenTab?.()
          return runtime.editor.openWorkspaceFile(filePath, undefined, explicitName)
        }
      },
      diffTabs: {
        listOpenRequests: () =>
          collaboratorsRef.current?.editor.listOpenDiffRequests() ?? [],
        subscribe: (listener) => {
          bridge.listener = listener
          bridge.attach()
          return () => {
            bridge.listener = null
            bridge.unsubscribe?.()
            bridge.unsubscribe = null
          }
        },
        openDiffTab: (request) => {
          const runtime = collaboratorsRef.current
          if (!runtime) return
          runtime.onBeforeOpenTab?.()
          runtime.editor.openDiffTab(request)
        },
        closeAllUnstagedDiffTabs: () =>
          collaboratorsRef.current?.editor.closeAllUnstagedDiffTabs(),
        closeUnstagedDiffTabsForPaths: (paths) =>
          collaboratorsRef.current?.editor.closeUnstagedDiffTabsForPaths(paths),
        closeUnstagedDiffTabsExcept: (activePaths) =>
          collaboratorsRef.current?.editor.closeUnstagedDiffTabsExcept(activePaths),
        closeStagedDiffTabsExcept: (activePaths) =>
          collaboratorsRef.current?.editor.closeStagedDiffTabsExcept(activePaths),
        reconcileStashDiffTabs: (activeStashes: readonly GitStashEntry[]) =>
          collaboratorsRef.current?.editor.reconcileStashDiffTabs(activeStashes)
      },
      confirm: {
        confirmAction: (request) => confirmRef.current.confirmAction(request),
        confirmUnsavedChanges: (request) => confirmRef.current.confirmUnsavedChanges(request),
        isDialogOpen: () => confirmRef.current.isDialogOpen()
      },
      refreshTree: () => collaboratorsRef.current?.refreshTree() ?? Promise.resolve()
    })
  }

  const session = sessionRef.current
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)

  useEffect(() => {
    subscriptionBridgeRef.current?.attach()
    return session.start()
  }, [session])

  const setWorkspaceRootPath = useCallback(
    (nextRootPath: string | null) => {
      session.setWorkspaceRootPath(nextRootPath)
    },
    [session]
  )

  const isStashDialogOpen = useCallback(
    () => session.getSnapshot().panelState.stashDialogScope !== null,
    [session]
  )

  return {
    panelState: snapshot.panelState,
    diffsByKey: snapshot.diffsByKey,
    isMutating: snapshot.isMutating,
    actions: session.actions,
    setWorkspaceRootPath,
    isStashDialogOpen
  }
}
