import { useCallback, useEffect, useMemo, useRef } from 'react'
import { getWorkspacePathKey } from '@shared/workspace'
import type { WorkspaceStateUpdate } from '@shared/workspaceState'
import { useWikiApi } from './useWikiApi'
import type { RestoredWorkspaceContext } from './useWorkspaceTree'

export const DEFAULT_WORKSPACE_STATE_SAVE_DEBOUNCE_MS = 250

export interface UseWorkspaceStatePersistenceOptions {
  workspaceRootPath: string | null
  expandedDirs: ReadonlySet<string>
  debounceMs?: number
}

function serializeExpandedDirsSignature(dirs: readonly string[]): string {
  return JSON.stringify(dirs)
}

/**
 * Coordinates debounced and immediate-flush persistence of the main window's active workspace state.
 */
export function useWorkspaceStatePersistence({
  workspaceRootPath,
  expandedDirs,
  debounceMs = DEFAULT_WORKSPACE_STATE_SAVE_DEBOUNCE_MS
}: UseWorkspaceStatePersistenceOptions) {
  const wikiApi = useWikiApi()
  const trackedRootPathRef = useRef<string | null>(null)
  const trackedRootKeyRef = useRef<string | null>(null)
  const latestExpandedDirsRef = useRef<string[]>([])
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
    if (!targetRoot || !hasPendingSaveRef.current) {
      return
    }
    const dirsSnapshot = [...latestExpandedDirsRef.current]
    const signatureSnapshot = serializeExpandedDirsSignature(dirsSnapshot)
    hasPendingSaveRef.current = false
    lastSavedSignatureRef.current = signatureSnapshot

    const saveApi = wikiApi.workspaceState?.save
    if (!saveApi) {
      return
    }
    const update: WorkspaceStateUpdate = { expandedDirs: dirsSnapshot }
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
    (context: RestoredWorkspaceContext): void => {
      clearDebounceTimer()
      const dirs = [...context.restoredExpandedDirs]
      trackedRootPathRef.current = context.rootPath
      trackedRootKeyRef.current = getWorkspacePathKey(context.rootPath)
      latestExpandedDirsRef.current = dirs

      if (context.hadPrunedExpandedDirs && context.persistedState !== null) {
        lastSavedSignatureRef.current = null
        hasPendingSaveRef.current = true
        scheduleSave()
      } else {
        lastSavedSignatureRef.current = serializeExpandedDirsSignature(dirs)
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
    const nextSignature = serializeExpandedDirsSignature(nextDirs)
    if (nextSignature === lastSavedSignatureRef.current) {
      return
    }
    hasPendingSaveRef.current = true
    scheduleSave()
  }, [expandedDirs, scheduleSave, workspaceRootPath])

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
