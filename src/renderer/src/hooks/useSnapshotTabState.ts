import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toErrorMessage } from '@shared/errors'
import type { WikiApi } from '@shared/ipc'
import type { GitBlobSnapshotRequest } from '@shared/symbol'
import { resolveRepoFileInWorkspace } from '@shared/workspace'
import type { SnapshotContentState } from '../components/SnapshotViewer'
import { formatGitSnapshotTabKey, type PaneId, type PaneLayoutState } from '../stores/PaneTabStore'
import { getGitFileBaseName } from '../utils/gitFilePresentation'

interface UseSnapshotTabStateOptions {
  layout: PaneLayoutState
  workspaceRootPath?: string | null
  repoRoot?: string | null
  gitApi: WikiApi['git']
  openWorkspaceFile: (
    filePath: string,
    targetPaneId?: PaneId,
    explicitName?: string
  ) => Promise<unknown>
}

interface OpenSnapshotEntry {
  tabKey: string
  request: GitBlobSnapshotRequest
  workspaceRootPath?: string
}

/**
 * Loads Git blob snapshots for any Snapshot tabs open in a window's panes
 * and handles `[로컬 파일 열기]` navigation to the workspace file.
 */
export function useSnapshotTabState({
  layout,
  workspaceRootPath = null,
  repoRoot = null,
  gitApi,
  openWorkspaceFile
}: UseSnapshotTabStateOptions) {
  const [snapshotsByKey, setSnapshotsByKey] = useState<Record<string, SnapshotContentState>>({})
  const snapshotsByKeyRef = useRef<Record<string, SnapshotContentState>>({})
  const inFlightKeysRef = useRef<Set<string>>(new Set())
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    snapshotsByKeyRef.current = {}
    inFlightKeysRef.current.clear()
    setSnapshotsByKey({})
  }, [workspaceRootPath])

  const openSnapshotEntries = useMemo<OpenSnapshotEntry[]>(() => {
    const seen = new Set<string>()
    const entries: OpenSnapshotEntry[] = []
    for (const pane of [layout.panes.primary, layout.panes.secondary]) {
      for (const tab of pane.tabs) {
        if (tab.kind !== 'snapshot') continue
        const tabKey = formatGitSnapshotTabKey(tab.snapshot.request)
        if (seen.has(tabKey)) continue
        seen.add(tabKey)
        entries.push({
          tabKey,
          request: tab.snapshot.request,
          workspaceRootPath: tab.snapshot.workspaceRootPath ?? workspaceRootPath ?? undefined
        })
      }
    }
    return entries
  }, [layout.panes.primary, layout.panes.secondary, workspaceRootPath])

  useEffect(() => {
    const openKeys = new Set(openSnapshotEntries.map((entry) => entry.tabKey))
    let changed = false
    const nextMap: Record<string, SnapshotContentState> = {}

    for (const [key, value] of Object.entries(snapshotsByKeyRef.current)) {
      if (openKeys.has(key)) {
        nextMap[key] = value
      } else {
        changed = true
      }
    }

    const toFetch: OpenSnapshotEntry[] = []
    for (const entry of openSnapshotEntries) {
      if (!nextMap[entry.tabKey]) {
        nextMap[entry.tabKey] = { status: 'loading' }
        changed = true
      }
      if (
        entry.workspaceRootPath &&
        nextMap[entry.tabKey].status === 'loading' &&
        !inFlightKeysRef.current.has(entry.tabKey)
      ) {
        toFetch.push(entry)
      }
    }

    if (changed) {
      snapshotsByKeyRef.current = nextMap
      setSnapshotsByKey(nextMap)
    }

    for (const entry of toFetch) {
      const rootPath = entry.workspaceRootPath!
      inFlightKeysRef.current.add(entry.tabKey)
      void gitApi
        .readBlobSnapshot(rootPath, entry.request)
        .then((snapshot) => {
          if (!mountedRef.current) return
          setSnapshotsByKey((current) => {
            if (!(entry.tabKey in current)) return current
            const updated: Record<string, SnapshotContentState> = {
              ...current,
              [entry.tabKey]: { status: 'loaded', snapshot }
            }
            snapshotsByKeyRef.current = updated
            return updated
          })
        })
        .catch((error: unknown) => {
          if (!mountedRef.current) return
          setSnapshotsByKey((current) => {
            if (!(entry.tabKey in current)) return current
            const updated: Record<string, SnapshotContentState> = {
              ...current,
              [entry.tabKey]: {
                status: 'error',
                errorMessage: toErrorMessage(error, '스냅샷을 불러오지 못했습니다.')
              }
            }
            snapshotsByKeyRef.current = updated
            return updated
          })
        })
        .finally(() => {
          inFlightKeysRef.current.delete(entry.tabKey)
        })
    }
  }, [gitApi, openSnapshotEntries])

  const openSnapshotTargetFile = useCallback(
    (repoRelativePath: string): void => {
      const matchedEntryRoot =
        openSnapshotEntries.find((entry) => entry.request.path === repoRelativePath)
          ?.workspaceRootPath ?? openSnapshotEntries[0]?.workspaceRootPath
      const targetRoot = repoRoot ?? workspaceRootPath ?? matchedEntryRoot
      if (!targetRoot) return
      const resolved =
        workspaceRootPath && repoRoot
          ? resolveRepoFileInWorkspace(repoRoot, workspaceRootPath, repoRelativePath)
          : null
      const filePath =
        resolved?.path ??
        `${targetRoot.replace(/[\\/]+$/, '')}/${repoRelativePath.replace(/^\/+/, '')}`
      void openWorkspaceFile(filePath, undefined, getGitFileBaseName(repoRelativePath))
    },
    [openSnapshotEntries, openWorkspaceFile, repoRoot, workspaceRootPath]
  )

  return {
    snapshotsByKey,
    openSnapshotTargetFile
  }
}
