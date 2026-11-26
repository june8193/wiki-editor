import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toErrorMessage } from '@shared/errors'
import type { GitDiffRequest } from '@shared/git'
import type { WikiApi } from '@shared/ipc'
import { resolveRepoFileInWorkspace } from '@shared/workspace'
import type { GitDiffContentState } from '../components/GitDiffViewer'
import type { PaneId, PaneLayoutState } from '../stores/PaneTabStore'
import { formatGitDiffTabKey, getGitFileBaseName } from '../utils/gitFilePresentation'
import { ImmutableDiffLruCache, reconcileDiffMapWithCache } from '../utils/immutableDiffCache'

interface UseAuxiliaryDiffStateOptions {
  layout: PaneLayoutState
  gitApi: WikiApi['git']
  openWorkspaceFile: (
    filePath: string,
    targetPaneId?: PaneId,
    explicitName?: string
  ) => Promise<unknown>
}

interface OpenDiffTargetEntry {
  tabKey: string
  request: GitDiffRequest
  workspaceRootPath?: string
}

/**
 * Loads Git diff contents for any Diff tabs open in an auxiliary window with
 * bounded LRU caching for immutable diffs and handles `파일 열기` into the auxiliary editor.
 */
export function useAuxiliaryDiffState({
  layout,
  gitApi,
  openWorkspaceFile
}: UseAuxiliaryDiffStateOptions) {
  const [diffsByKey, setDiffsByKey] = useState<Record<string, GitDiffContentState>>({})
  const diffsByKeyRef = useRef<Record<string, GitDiffContentState>>({})
  const inFlightKeysRef = useRef<Set<string>>(new Set())
  const openKeysRef = useRef<Set<string>>(new Set())
  const immutableCacheRef = useRef<ImmutableDiffLruCache | null>(null)
  if (!immutableCacheRef.current) {
    immutableCacheRef.current = new ImmutableDiffLruCache()
  }
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      immutableCacheRef.current?.clear()
    }
  }, [])

  const openDiffEntries = useMemo<OpenDiffTargetEntry[]>(() => {
    const seen = new Set<string>()
    const entries: OpenDiffTargetEntry[] = []
    for (const pane of [layout.panes.primary, layout.panes.secondary]) {
      for (const tab of pane.tabs) {
        if (tab.kind !== 'diff') continue
        const tabKey = formatGitDiffTabKey(tab.diff.request)
        if (seen.has(tabKey)) continue
        seen.add(tabKey)
        entries.push({
          tabKey,
          request: tab.diff.request,
          workspaceRootPath: tab.diff.workspaceRootPath
        })
      }
    }
    return entries
  }, [layout.panes.primary, layout.panes.secondary])

  useEffect(() => {
    const cache = immutableCacheRef.current!
    const openKeys = new Set(openDiffEntries.map((entry) => entry.tabKey))
    openKeysRef.current = openKeys

    const { nextDiffs, changed, toFetch } = reconcileDiffMapWithCache({
      prevDiffs: diffsByKeyRef.current,
      entries: openDiffEntries,
      openKeys,
      cache,
      canStartFetch: (entry) =>
        Boolean(entry.workspaceRootPath) && !inFlightKeysRef.current.has(entry.tabKey)
    })

    if (changed) {
      diffsByKeyRef.current = nextDiffs
      setDiffsByKey(nextDiffs)
    }

    for (const entry of toFetch) {
      const rootPath = entry.workspaceRootPath!
      inFlightKeysRef.current.add(entry.tabKey)
      void gitApi
        .diff(rootPath, entry.request)
        .then((diff) => {
          if (!mountedRef.current) return
          cache.storeIfImmutable(entry.tabKey, entry.request, diff, openKeysRef.current)
          setDiffsByKey((current) => {
            const updated: Record<string, GitDiffContentState> = {
              ...current,
              [entry.tabKey]: { status: 'loaded', diff }
            }
            diffsByKeyRef.current = updated
            return updated
          })
        })
        .catch((error: unknown) => {
          if (!mountedRef.current) return
          setDiffsByKey((current) => {
            const updated: Record<string, GitDiffContentState> = {
              ...current,
              [entry.tabKey]: {
                status: 'error',
                errorMessage: toErrorMessage(error, 'Diff를 불러오지 못했습니다.')
              }
            }
            diffsByKeyRef.current = updated
            return updated
          })
        })
        .finally(() => {
          inFlightKeysRef.current.delete(entry.tabKey)
        })
    }
  }, [gitApi, openDiffEntries])

  const openDiffTargetFile = useCallback(
    (repoRelativePath: string): void => {
      const activePane = layout.panes[layout.activePaneId]
      const activeTab = activePane.tabs.find((t) => t.id === activePane.activeTabId)
      const workspaceRootPath =
        (activeTab?.kind === 'diff' ? activeTab.diff.workspaceRootPath : undefined) ??
        openDiffEntries.find((entry) => Boolean(entry.workspaceRootPath))?.workspaceRootPath
      if (!workspaceRootPath) return

      const resolved = resolveRepoFileInWorkspace(
        workspaceRootPath,
        workspaceRootPath,
        repoRelativePath
      )
      if (!resolved) return
      void openWorkspaceFile(resolved.path, layout.activePaneId, getGitFileBaseName(resolved.path))
    },
    [layout.activePaneId, layout.panes, openDiffEntries, openWorkspaceFile]
  )

  return {
    diffsByKey,
    openDiffTargetFile
  }
}
