import { useCallback, useEffect, useMemo, useRef } from 'react'
import { getWorkspacePathKey } from '@shared/workspace'
import type {
  PersistedWorkspacePaneLayout,
  PersistedWorkspaceState,
  WorkspaceStateUpdate
} from '@shared/workspaceState'
import {
  serializePaneLayoutForWorkspace,
  type WorkspaceLayoutSnapshot
} from '../stores/PaneTabStore'
import { useWikiApi } from './useWikiApi'

export const DEFAULT_WORKSPACE_STATE_SAVE_DEBOUNCE_MS = 250

export interface RestoredWorkspacePersistenceState {
  rootPath: string
  persistedState: PersistedWorkspaceState | null
  restoredExpandedDirs: readonly string[]
  restoredLayout: PersistedWorkspacePaneLayout
  hadPrunedState: boolean
}

export interface UseWorkspaceStatePersistenceOptions {
  workspaceRootPath: string | null
  expandedDirs: ReadonlySet<string>
  layoutSnapshot: WorkspaceLayoutSnapshot
  getLatestLayoutSnapshot: () => WorkspaceLayoutSnapshot
  debounceMs?: number
}

function serializeWorkspaceStateSignature(
  dirs: readonly string[],
  layout: PersistedWorkspacePaneLayout
): string {
  return JSON.stringify({ expandedDirs: dirs, layout })
}

function serializeWorkspaceStatePayload(
  rootPath: string,
  expandedDirs: readonly string[],
  layoutSnapshot: WorkspaceLayoutSnapshot
): { update: WorkspaceStateUpdate; signature: string } {
  const dirs = [...expandedDirs]
  const layout = serializePaneLayoutForWorkspace(rootPath, layoutSnapshot)
  return {
    update: { expandedDirs: dirs, layout },
    signature: serializeWorkspaceStateSignature(dirs, layout)
  }
}

/**
 * Coordinates debounced and immediate-flush persistence of the main window's active workspace state.
 */
export function useWorkspaceStatePersistence({
  workspaceRootPath,
  expandedDirs,
  layoutSnapshot,
  getLatestLayoutSnapshot,
  debounceMs = DEFAULT_WORKSPACE_STATE_SAVE_DEBOUNCE_MS
}: UseWorkspaceStatePersistenceOptions) {
  const wikiApi = useWikiApi()
  const trackedRootPathRef = useRef<string | null>(null)
  const trackedRootKeyRef = useRef<string | null>(null)
  const latestExpandedDirsRef = useRef<string[]>([])
  const getLatestLayoutSnapshotRef = useRef(getLatestLayoutSnapshot)
  getLatestLayoutSnapshotRef.current = getLatestLayoutSnapshot
  const lastSavedSignatureRef = useRef<string | null>(null)
  const hasPendingSaveRef = useRef<boolean>(false)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const workspaceMatchesTracked =
    workspaceRootPath !== null &&
    trackedRootKeyRef.current !== null &&
    getWorkspacePathKey(workspaceRootPath) === trackedRootKeyRef.current
  if (workspaceMatchesTracked) {
    latestExpandedDirsRef.current = [...expandedDirs]
  }

  const clearDebounceTimer = useCallback((): void => {
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = null
    }
  }, [])

  const flush = useCallback(async (): Promise<void> => {
    clearDebounceTimer()
    const targetRoot = trackedRootPathRef.current
    if (!targetRoot) {
      return
    }
    const { update, signature } = serializeWorkspaceStatePayload(
      targetRoot,
      latestExpandedDirsRef.current,
      getLatestLayoutSnapshotRef.current()
    )
    if (!hasPendingSaveRef.current && signature === lastSavedSignatureRef.current) {
      return
    }
    hasPendingSaveRef.current = false
    lastSavedSignatureRef.current = signature

    const saveApi = wikiApi.workspaceState?.save
    if (!saveApi) {
      return
    }
    await saveApi(targetRoot, update).catch(() => undefined)
  }, [clearDebounceTimer, wikiApi])

  const scheduleSave = useCallback((): void => {
    clearDebounceTimer()
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null
      void flush()
    }, debounceMs)
  }, [clearDebounceTimer, debounceMs, flush])

  const markRestored = useCallback(
    (context: RestoredWorkspacePersistenceState): void => {
      clearDebounceTimer()
      const dirs = [...context.restoredExpandedDirs]
      trackedRootPathRef.current = context.rootPath
      trackedRootKeyRef.current = getWorkspacePathKey(context.rootPath)
      latestExpandedDirsRef.current = dirs

      if (context.hadPrunedState && context.persistedState !== null) {
        lastSavedSignatureRef.current = null
        hasPendingSaveRef.current = true
        scheduleSave()
      } else {
        lastSavedSignatureRef.current = serializeWorkspaceStateSignature(
          dirs,
          context.restoredLayout
        )
        hasPendingSaveRef.current = false
      }
    },
    [clearDebounceTimer, scheduleSave]
  )

  const suspendAndFlush = useCallback(async (): Promise<void> => {
    const pendingFlush = flush()
    trackedRootPathRef.current = null
    trackedRootKeyRef.current = null
    hasPendingSaveRef.current = false
    clearDebounceTimer()
    await pendingFlush
  }, [clearDebounceTimer, flush])

  const resumeForWorkspace = useCallback((rootPath: string): void => {
    trackedRootPathRef.current = rootPath
    trackedRootKeyRef.current = getWorkspacePathKey(rootPath)
  }, [])

  useEffect(() => {
    if (!workspaceRootPath || trackedRootKeyRef.current !== getWorkspacePathKey(workspaceRootPath)) {
      return
    }
    const nextDirs = [...expandedDirs]
    latestExpandedDirsRef.current = nextDirs
    const { signature } = serializeWorkspaceStatePayload(workspaceRootPath, nextDirs, layoutSnapshot)
    if (signature === lastSavedSignatureRef.current) {
      if (hasPendingSaveRef.current) {
        hasPendingSaveRef.current = false
        clearDebounceTimer()
      }
      return
    }
    hasPendingSaveRef.current = true
    scheduleSave()
  }, [clearDebounceTimer, expandedDirs, layoutSnapshot, scheduleSave, workspaceRootPath])

  useEffect(() => {
    const handleBeforeUnload = (): void => {
      void flush()
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
      void flush()
    }
  }, [flush])

  return useMemo(
    () => ({
      markRestored,
      flush,
      suspendAndFlush,
      resumeForWorkspace
    }),
    [flush, markRestored, resumeForWorkspace, suspendAndFlush]
  )
}
