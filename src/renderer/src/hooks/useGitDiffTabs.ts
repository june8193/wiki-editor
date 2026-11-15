import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitDiffRequest, GitStatus } from '@shared/git'
import type { GitDiffContentState } from '../components/GitDiffViewer'
import type { DiffTabItem, PaneLayoutState } from '../stores/PaneTabStore'
import { formatGitDiffTabKey } from '../utils/gitFilePresentation'
import { toErrorMessage } from '../utils/toErrorMessage'

interface UseGitDiffTabsOptions {
  workspaceRootPath: string | null
  gitStatus: GitStatus | null
  layout: PaneLayoutState
}

function collectOpenDiffRequests(layout: PaneLayoutState): Map<string, GitDiffRequest> {
  const map = new Map<string, GitDiffRequest>()
  for (const pane of [layout.panes.primary, layout.panes.secondary]) {
    for (const tab of pane.tabs) {
      if (tab.kind === 'diff') {
        map.set(tab.bufferKey, (tab as DiffTabItem).diff.request)
      }
    }
  }
  return map
}

function resolveEffectiveDiffRequest(
  request: GitDiffRequest,
  status: GitStatus | null
): GitDiffRequest {
  if (request.kind === 'commit' || !status || !status.isRepo) {
    return request
  }

  if (request.kind === 'staged') {
    const match = status.staged.find(
      (item) => item.path === request.path && item.origPath === request.origPath
    )
    if (match) {
      return {
        kind: 'staged',
        path: match.path,
        ...(match.origPath ? { origPath: match.origPath } : {}),
        status: match.status
      }
    }
    return request
  }

  const untrackedMatch = status.untracked.find((item) => item.path === request.path)
  if (untrackedMatch) {
    return { kind: 'unstaged', path: untrackedMatch.path, status: '?' }
  }

  const unstagedMatch = status.unstaged.find((item) => item.path === request.path)
  if (unstagedMatch) {
    return {
      kind: 'unstaged',
      path: unstagedMatch.path,
      ...(unstagedMatch.origPath ? { origPath: unstagedMatch.origPath } : {}),
      status: unstagedMatch.status
    }
  }

  // If previously untracked file was staged/reverted, query tracked diff so git returns empty patch cleanly.
  if (request.status === '?') {
    return { kind: 'unstaged', path: request.path, status: 'M' }
  }
  return request
}

/**
 * Loads, caches, prunes, and refreshes read-only Git diff payloads for open Diff tabs.
 */
export function useGitDiffTabs({
  workspaceRootPath,
  gitStatus,
  layout
}: UseGitDiffTabsOptions): {
  diffsByKey: Record<string, GitDiffContentState>
  refreshDiffRequest: (request: GitDiffRequest) => void
} {
  const [diffsByKey, setDiffsByKey] = useState<Record<string, GitDiffContentState>>({})
  const mountedRef = useRef(true)
  const workspaceEpochRef = useRef(0)
  const inFlightSeqRef = useRef<Map<string, number>>(new Map())
  const pendingKeysRef = useRef<Set<string>>(new Set())
  const openKeysRef = useRef<Set<string>>(new Set())
  const diffsByKeyRef = useRef(diffsByKey)
  diffsByKeyRef.current = diffsByKey

  const layoutRef = useRef(layout)
  layoutRef.current = layout
  const gitStatusRef = useRef(gitStatus)
  gitStatusRef.current = gitStatus
  const workspaceRootRef = useRef(workspaceRootPath)
  workspaceRootRef.current = workspaceRootPath
  const lastRefreshedStatusRef = useRef<GitStatus | null>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const fetchDiffForKey = useCallback(
    (
      tabKey: string,
      request: GitDiffRequest,
      rootPath: string,
      epoch: number,
      showLoadingWhenAbsent: boolean
    ): void => {
      const nextSeq = (inFlightSeqRef.current.get(tabKey) ?? 0) + 1
      inFlightSeqRef.current.set(tabKey, nextSeq)
      pendingKeysRef.current.add(tabKey)

      if (showLoadingWhenAbsent) {
        setDiffsByKey((prev) =>
          prev[tabKey] ? prev : { ...prev, [tabKey]: { status: 'loading' } }
        )
      }

      const effectiveRequest = resolveEffectiveDiffRequest(request, gitStatusRef.current)
      void window.wikiApi.git
        .diff(rootPath, effectiveRequest)
        .then((diff) => {
          if (
            !mountedRef.current ||
            workspaceEpochRef.current !== epoch ||
            !openKeysRef.current.has(tabKey) ||
            inFlightSeqRef.current.get(tabKey) !== nextSeq
          ) {
            return
          }
          setDiffsByKey((prev) => ({
            ...prev,
            [tabKey]: { status: 'loaded', diff }
          }))
        })
        .catch((error: unknown) => {
          if (
            !mountedRef.current ||
            workspaceEpochRef.current !== epoch ||
            !openKeysRef.current.has(tabKey) ||
            inFlightSeqRef.current.get(tabKey) !== nextSeq
          ) {
            return
          }
          setDiffsByKey((prev) => ({
            ...prev,
            [tabKey]: {
              status: 'error',
              errorMessage: toErrorMessage(error, 'Diff를 불러오지 못했습니다.')
            }
          }))
        })
        .finally(() => {
          if (inFlightSeqRef.current.get(tabKey) === nextSeq) {
            pendingKeysRef.current.delete(tabKey)
          }
        })
    },
    []
  )

  useEffect(() => {
    workspaceEpochRef.current += 1
    inFlightSeqRef.current.clear()
    pendingKeysRef.current.clear()
    lastRefreshedStatusRef.current = null
    setDiffsByKey({})
  }, [workspaceRootPath])

  useEffect(() => {
    const openMap = collectOpenDiffRequests(layout)
    openKeysRef.current = new Set(openMap.keys())
    for (const key of pendingKeysRef.current) {
      if (!openMap.has(key)) {
        pendingKeysRef.current.delete(key)
      }
    }

    setDiffsByKey((prev) => {
      const staleKeys = Object.keys(prev).filter((key) => !openMap.has(key))
      if (staleKeys.length === 0) return prev
      const next: Record<string, GitDiffContentState> = {}
      for (const [key, value] of Object.entries(prev)) {
        if (openMap.has(key)) {
          next[key] = value
        }
      }
      return next
    })

    if (!workspaceRootPath) return
    const epoch = workspaceEpochRef.current

    for (const [tabKey, request] of openMap.entries()) {
      if (!diffsByKeyRef.current[tabKey] && !pendingKeysRef.current.has(tabKey)) {
        fetchDiffForKey(tabKey, request, workspaceRootPath, epoch, true)
      }
    }
  }, [fetchDiffForKey, layout, workspaceRootPath])

  useEffect(() => {
    if (!workspaceRootPath || !gitStatus || !gitStatus.isRepo) {
      return
    }
    if (lastRefreshedStatusRef.current === gitStatus) {
      return
    }
    lastRefreshedStatusRef.current = gitStatus

    const openMap = collectOpenDiffRequests(layoutRef.current)
    const epoch = workspaceEpochRef.current
    for (const [tabKey, request] of openMap.entries()) {
      if (request.kind === 'staged' || request.kind === 'unstaged') {
        fetchDiffForKey(tabKey, request, workspaceRootPath, epoch, false)
      }
    }
  }, [fetchDiffForKey, gitStatus, workspaceRootPath])

  const refreshDiffRequest = useCallback(
    (request: GitDiffRequest): void => {
      const rootPath = workspaceRootRef.current
      if (!rootPath) return
      const tabKey = formatGitDiffTabKey(request)
      openKeysRef.current.add(tabKey)
      fetchDiffForKey(tabKey, request, rootPath, workspaceEpochRef.current, true)
    },
    [fetchDiffForKey]
  )

  return { diffsByKey, refreshDiffRequest }
}
