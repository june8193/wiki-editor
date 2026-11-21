import { useEffect, useMemo, useRef } from 'react'
import type { AppConfig } from '@shared/config'
import { DEFAULT_SPLIT_RATIO, type WindowInitContext } from '@shared/window'
import { createEmptyPersistedWorkspaceLayout } from '@shared/workspaceState'
import {
  MainWindowWorkspaceLifecycle,
  type WorkspaceConfirmCollaborator,
  type WorkspaceEditorCollaborator,
  type WorkspaceLifecycleUiCollaborator,
  type WorkspaceTreeCollaborator
} from '../stores/MainWindowWorkspaceLifecycle'
import type { WorkspaceLayoutSnapshot } from '../stores/workspaceLayoutPersistence'
import { useWikiApi } from './useWikiApi'

const EMPTY_EXPANDED_DIRS: ReadonlySet<string> = new Set()
const EMPTY_LAYOUT_SNAPSHOT: WorkspaceLayoutSnapshot = {
  layout: {
    splitMode: 'single',
    splitRatio: DEFAULT_SPLIT_RATIO,
    activePaneId: 'primary',
    panes: {
      primary: { id: 'primary', tabs: [], activeTabId: null },
      secondary: { id: 'secondary', tabs: [], activeTabId: null }
    }
  },
  buffers: {}
}

export interface MainWorkspaceLifecycleCollaborators {
  tree: WorkspaceTreeCollaborator
  editor: WorkspaceEditorCollaborator
  confirm: WorkspaceConfirmCollaborator
  ui: WorkspaceLifecycleUiCollaborator
}

export interface UseMainWorkspaceLifecycleOptions {
  collaboratorsRef: { current: MainWorkspaceLifecycleCollaborators | null }
}

export interface MainWorkspaceLifecycleHandle {
  loadInitContext: () => Promise<WindowInitContext | null>
  handleInitialConfigLoaded: (config: AppConfig) => void
  switchWorkspace: (targetPath: string) => void
  selectFolder: () => void
  openInNewWindow: (targetPath: string) => void
  markUserSelectedSidebarView: () => void
  getSwitchSequence: () => number
  syncPersistenceState: () => void
  flushWorkspaceState: () => Promise<void>
}

/**
 * React binding hook over `MainWindowWorkspaceLifecycle`, bridging MainAppShell's tree,
 * editor, confirm dialog, and UI callbacks into a single workspace lifecycle module.
 */
export function useMainWorkspaceLifecycle({
  collaboratorsRef
}: UseMainWorkspaceLifecycleOptions): MainWorkspaceLifecycleHandle {
  const wikiApi = useWikiApi()

  const lifecycleRef = useRef<MainWindowWorkspaceLifecycle | null>(null)
  if (!lifecycleRef.current) {
    lifecycleRef.current = new MainWindowWorkspaceLifecycle({
      workspaceApi: wikiApi.workspace,
      workspaceStateApi: wikiApi.workspaceState,
      windowApi: wikiApi.window,
      tree: {
        getExpandedDirs: () =>
          collaboratorsRef.current?.tree.getExpandedDirs() ?? EMPTY_EXPANDED_DIRS,
        applyOpenedWorkspace: (opened) => {
          collaboratorsRef.current?.tree.applyOpenedWorkspace(opened)
        }
      },
      editor: {
        getDirtyWorkspaceSummary: () =>
          collaboratorsRef.current?.editor.getDirtyWorkspaceSummary() ?? null,
        ensureAllWorkspaceBuffersSaved: () =>
          collaboratorsRef.current?.editor.ensureAllWorkspaceBuffersSaved() ?? Promise.resolve(true),
        clearWorkspaceBuffers: () => {
          collaboratorsRef.current?.editor.clearWorkspaceBuffers()
        },
        restoreWorkspaceLayout: (options) =>
          collaboratorsRef.current?.editor.restoreWorkspaceLayout(options) ??
          Promise.resolve({
            restored: false,
            hadPrunedTabs: false,
            reconciledLayout: createEmptyPersistedWorkspaceLayout()
          }),
        getLatestLayoutSnapshot: () =>
          collaboratorsRef.current?.editor.getLatestLayoutSnapshot() ?? EMPTY_LAYOUT_SNAPSHOT
      },
      confirm: {
        confirmUnsavedChanges: (request) =>
          collaboratorsRef.current?.confirm.confirmUnsavedChanges(request) ??
          Promise.resolve(false),
        isDialogOpen: () => collaboratorsRef.current?.confirm.isDialogOpen() ?? false
      },
      ui: {
        reportError: (message, error) => {
          collaboratorsRef.current?.ui.reportError(message, error)
        },
        removeRecentWorkspace: (workspacePath) => {
          collaboratorsRef.current?.ui.removeRecentWorkspace(workspacePath)
        },
        onEnterExplorerView: (reason) => {
          collaboratorsRef.current?.ui.onEnterExplorerView(reason)
        }
      }
    })
  }

  const lifecycle = lifecycleRef.current
  useEffect(() => lifecycle.start(), [lifecycle])

  return useMemo<MainWorkspaceLifecycleHandle>(
    () => ({
      loadInitContext: lifecycle.loadInitContext,
      handleInitialConfigLoaded: lifecycle.handleInitialConfigLoaded,
      switchWorkspace: (targetPath) => {
        void lifecycle.switchWorkspace(targetPath)
      },
      selectFolder: () => {
        void lifecycle.selectFolder()
      },
      openInNewWindow: (targetPath) => {
        void lifecycle.openInNewWindow(targetPath)
      },
      markUserSelectedSidebarView: lifecycle.markUserSelectedSidebarView,
      getSwitchSequence: lifecycle.getSwitchSequence,
      syncPersistenceState: lifecycle.syncPersistenceState,
      flushWorkspaceState: lifecycle.flushWorkspaceState
    }),
    [lifecycle]
  )
}
