import { useCallback, useEffect, useRef, useState } from 'react'
import type { DocumentBufferSnapshot } from '@shared/documentBuffer'
import type { GitDiffRequest } from '@shared/git'
import type { WikiApi } from '@shared/ipc'
import type { CodeSourceScope, GitBlobSnapshotRequest, SymbolCandidateMatch } from '@shared/symbol'
import { getWorkspacePathKey, joinWorkspacePath } from '@shared/workspace'
import type { GitDiffContentState } from '../components/GitDiffViewer'
import type { SnapshotContentState } from '../components/SnapshotViewer'
import type { SymbolNotFoundTooltipState } from '../components/SymbolCandidatePopover'
import type { SymbolNavigateRequest } from '../editor/symbolHoverDom'
import { resolveDiffLineScope, resolveSymbolDefinitions } from '../editor/symbolNavigation'
import type {
  PaneNavigationCoordinator,
  PaneNavigationEntry
} from '../stores/PaneNavigationCoordinator'
import {
  formatGitSnapshotTabKey,
  type OpenSnapshotTabOptions,
  type PaneId,
  type PaneLayoutState,
  type SnapshotTabItem
} from '../stores/PaneTabStore'
import { loadDiffLanguageParser } from '../utils/diffSyntaxHighlight'
import { formatGitDiffTabKey } from '../utils/gitFilePresentation'
import { parseUnifiedDiff } from '../utils/unifiedDiff'

export interface SymbolNavigationTargetContext {
  paneId: PaneId
  originEntry: PaneNavigationEntry
  scope: CodeSourceScope
  stashHash?: string
  pinned: boolean
  isInCurrentDiffHunk?: (repoRelativePath: string, lineNumber: number) => boolean
}

export interface SymbolCandidatePopoverState {
  x: number
  y: number
  symbolName: string
  candidates: readonly SymbolCandidateMatch[]
  context: SymbolNavigationTargetContext
}

export type { SymbolNotFoundTooltipState }

interface UseSymbolNavigationControllerOptions {
  layout: PaneLayoutState
  buffers: DocumentBufferSnapshot
  diffsByKey: Record<string, GitDiffContentState>
  snapshotsByKey?: Record<string, SnapshotContentState>
  workspaceRootPath: string | null
  navigation: PaneNavigationCoordinator
  openSnapshotTab?: (
    request: GitBlobSnapshotRequest,
    options?: OpenSnapshotTabOptions
  ) => SnapshotTabItem
  getActiveDiffChangedFiles?: (request: GitDiffRequest) => ReadonlySet<string> | undefined
  wikiApi: Pick<WikiApi, 'workspace' | 'git'>
}

function toRepoRelativePath(absoluteOrRelativePath: string, workspaceRootPath: string): string {
  const normPath = absoluteOrRelativePath.replace(/\\/g, '/')
  const normRoot = workspaceRootPath.replace(/\\/g, '/').replace(/\/+$/, '')
  if (normPath.toLowerCase().startsWith(`${normRoot.toLowerCase()}/`)) {
    return normPath.slice(normRoot.length + 1)
  }
  return normPath.replace(/^\/+/, '')
}

function buildHunkLineChecker(
  rawPatch: string,
  targetPath: string,
  side: 'old' | 'new'
): (repoRelativePath: string, lineNumber: number) => boolean {
  const parsed = parseUnifiedDiff(rawPatch)
  const hunkLineSet = new Set<number>()
  for (const hunk of parsed.hunks) {
    for (const line of hunk.lines) {
      const ln = side === 'old' ? line.oldLineNumber : line.newLineNumber
      if (ln !== null && line.type !== 'context') {
        hunkLineSet.add(ln)
      }
    }
  }
  return (repoRelativePath: string, lineNumber: number): boolean =>
    repoRelativePath === targetPath && hunkLineSet.has(lineNumber)
}

export function useSymbolNavigationController({
  layout,
  buffers,
  diffsByKey,
  snapshotsByKey = {},
  workspaceRootPath,
  navigation,
  openSnapshotTab,
  getActiveDiffChangedFiles,
  wikiApi
}: UseSymbolNavigationControllerOptions) {
  const [candidatePopover, setCandidatePopover] = useState<SymbolCandidatePopoverState | null>(null)
  const [notFoundTooltip, setNotFoundTooltip] = useState<SymbolNotFoundTooltipState | null>(null)
  const navSeqRef = useRef(0)
  const latestRef = useRef({
    layout,
    buffers,
    diffsByKey,
    snapshotsByKey,
    workspaceRootPath,
    openSnapshotTab,
    getActiveDiffChangedFiles,
    wikiApi
  })
  latestRef.current = {
    layout,
    buffers,
    diffsByKey,
    snapshotsByKey,
    workspaceRootPath,
    openSnapshotTab,
    getActiveDiffChangedFiles,
    wikiApi
  }

  const dismissPopover = useCallback(() => setCandidatePopover(null), [])
  const dismissTooltip = useCallback(() => setNotFoundTooltip(null), [])

  useEffect(() => {
    setCandidatePopover(null)
    setNotFoundTooltip(null)
  }, [workspaceRootPath])

  useEffect(() => {
    if (!notFoundTooltip) return
    const timer = window.setTimeout(() => setNotFoundTooltip(null), 2500)
    const clear = (): void => setNotFoundTooltip(null)
    window.addEventListener('mousedown', clear)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('mousedown', clear)
    }
  }, [notFoundTooltip])

  const jumpToCandidate = useCallback(
    async (ctx: SymbolNavigationTargetContext, candidate: SymbolCandidateMatch): Promise<void> => {
      const {
        diffsByKey: currentDiffs,
        workspaceRootPath: propRootPath,
        openSnapshotTab: openSnap
      } = latestRef.current
      const { paneId, originEntry, scope, stashHash, pinned } = ctx
      const effectiveRootPath =
        propRootPath ??
        (originEntry.kind !== 'document' ? originEntry.workspaceRootPath : undefined) ??
        null
      if (!effectiveRootPath) return

      navigation.recordNavigationOrigin(paneId, originEntry)

      if (
        originEntry.kind === 'diff' &&
        ctx.isInCurrentDiffHunk?.(candidate.path, candidate.lineNumber)
      ) {
        navigation.jumpToDiffLine(paneId, originEntry.tabId, candidate.lineNumber, originEntry.side)
        return
      }

      if (scope.kind === 'working-tree') {
        const absPath = joinWorkspacePath(effectiveRootPath, candidate.path)
        await navigation.openFileAtLine(absPath, candidate.lineNumber, candidate.columnStart + 1)
        return
      }

      if (!openSnap) return
      const snapTab = openSnap(
        {
          path: candidate.path,
          scope,
          ...(stashHash ? { stashHash } : {})
        },
        {
          paneId,
          workspaceRootPath: effectiveRootPath,
          pinned
        }
      )
      navigation.jumpToSnapshotLine(
        paneId,
        snapTab.id,
        candidate.lineNumber,
        candidate.columnStart,
        candidate.columnEnd
      )
    },
    [navigation]
  )

  const selectCandidate = useCallback(
    (candidate: SymbolCandidateMatch) => {
      if (!candidatePopover) return
      const { context } = candidatePopover
      setCandidatePopover(null)
      void jumpToCandidate(context, candidate)
    },
    [candidatePopover, jumpToCandidate]
  )

  const showNotFoundTooltip = useCallback((request: SymbolNavigateRequest) => {
    setNotFoundTooltip({
      x: request.clientX,
      y: request.clientY,
      symbolName: request.symbolName
    })
  }, [])

  const handleSymbolNavigate = useCallback(
    (paneId: PaneId, tabId: string, request: SymbolNavigateRequest): void => {
      const {
        layout: currentLayout,
        buffers: currentBuffers,
        diffsByKey: currentDiffs,
        snapshotsByKey: currentSnapshots,
        workspaceRootPath: propRootPath,
        getActiveDiffChangedFiles: getChangedFiles,
        wikiApi: api
      } = latestRef.current
      const pane = currentLayout.panes[paneId]
      const tab = pane.tabs.find((item) => item.id === tabId)
      if (!tab) return
      const rootPath =
        propRootPath ??
        (tab.kind === 'diff'
          ? tab.diff.workspaceRootPath
          : tab.kind === 'snapshot'
            ? tab.snapshot.workspaceRootPath
            : undefined) ??
        null
      if (!rootPath) return

      setCandidatePopover(null)
      setNotFoundTooltip(null)

      let originPath = ''
      let originContent: string | undefined
      let scope: CodeSourceScope
      let stashHash: string | undefined
      let activeDiffChangedFiles: ReadonlySet<string> | undefined
      let isInCurrentDiffHunk:
        | ((repoRelativePath: string, lineNumber: number) => boolean)
        | undefined
      let originEntry: PaneNavigationEntry

      if (tab.kind === 'diff') {
        const side = request.side ?? 'new'
        scope = resolveDiffLineScope(tab.diff.request, side)
        stashHash = tab.diff.request.kind === 'stash' ? tab.diff.request.stashHash : undefined
        originPath =
          side === 'old' && tab.diff.request.origPath
            ? tab.diff.request.origPath
            : tab.diff.request.path
        const extraChanged = getChangedFiles?.(tab.diff.request)
        activeDiffChangedFiles = new Set([
          tab.diff.request.path,
          ...(extraChanged ? Array.from(extraChanged) : [])
        ])
        const diffState = currentDiffs[formatGitDiffTabKey(tab.diff.request)]
        if (diffState?.status === 'loaded' && !diffState.diff.isBinary) {
          isInCurrentDiffHunk = buildHunkLineChecker(
            diffState.diff.rawPatch,
            tab.diff.request.path,
            side
          )
        }
        originEntry = {
          kind: 'diff',
          tabId: tab.id,
          request: tab.diff.request,
          viewMode: tab.diff.viewMode,
          workspaceRootPath: tab.diff.workspaceRootPath ?? rootPath,
          lineNumber: request.lineNumber,
          side
        }
      } else if (tab.kind === 'snapshot') {
        scope = tab.snapshot.request.scope
        stashHash = tab.snapshot.request.stashHash
        originPath = tab.snapshot.request.path
        const snapState = currentSnapshots?.[formatGitSnapshotTabKey(tab.snapshot.request)]
        if (snapState?.status === 'loaded' && !snapState.snapshot.isBinary) {
          originContent = snapState.snapshot.content
        }
        originEntry = {
          kind: 'snapshot',
          tabId: tab.id,
          request: tab.snapshot.request,
          workspaceRootPath: tab.snapshot.workspaceRootPath ?? rootPath,
          lineNumber: request.lineNumber,
          columnStart: request.columnStart,
          columnEnd: request.columnEnd
        }
      } else {
        const buffer = currentBuffers[tab.bufferKey]
        if (!buffer) return
        scope = { kind: 'working-tree' }
        originPath = toRepoRelativePath(buffer.path, rootPath)
        originContent = buffer.content
        originEntry = {
          kind: 'document',
          tabId: tab.id,
          bufferKey: tab.bufferKey,
          filePath: buffer.path,
          lineNumber: request.lineNumber,
          columnStart: request.columnStart,
          columnEnd: request.columnEnd
        }
      }

      const seq = ++navSeqRef.current
      const context: SymbolNavigationTargetContext = {
        paneId,
        originEntry,
        scope,
        stashHash,
        pinned: request.shiftKey,
        isInCurrentDiffHunk
      }

      void resolveSymbolDefinitions({
        symbolName: request.symbolName,
        currentFilePath: originPath,
        currentFileContent: originContent ?? null,
        scope,
        workspaceRootPath: rootPath,
        changedFilePaths: activeDiffChangedFiles,
        isInActiveDiffHunk: isInCurrentDiffHunk
          ? (candidate) => isInCurrentDiffHunk!(candidate.path, candidate.lineNumber)
          : undefined,
        searchSymbols: (symbolName, targetScope) =>
          api.workspace.searchSymbols?.({ symbolName, scope: targetScope, maxResults: 80 }) ??
          Promise.resolve([]),
        readFileContent: async (repoRelativePath, targetScope) => {
          if (targetScope.kind === 'working-tree') {
            const absPath = joinWorkspacePath(rootPath, repoRelativePath)
            const openBuf = latestRef.current.buffers[getWorkspacePathKey(absPath)]
            if (openBuf && openBuf.kind === 'workspace') {
              return openBuf.content
            }
            return await api.workspace.readFile(absPath)
          }
          const blob = await api.git.readBlobSnapshot(rootPath, {
            path: repoRelativePath,
            scope: targetScope,
            ...(stashHash ? { stashHash } : {})
          })
          return blob.isBinary ? null : blob.content
        },
        getParserForPath: loadDiffLanguageParser
      })
        .then((resolution) => {
          if (navSeqRef.current !== seq) return
          if (resolution.status === 'not-found') {
            showNotFoundTooltip(request)
            return
          }
          if (resolution.status === 'single') {
            void jumpToCandidate(context, resolution.target)
            return
          }
          setCandidatePopover({
            x: request.clientX,
            y: request.clientY,
            symbolName: request.symbolName,
            candidates: resolution.candidates,
            context
          })
        })
        .catch(() => {
          if (navSeqRef.current !== seq) return
          showNotFoundTooltip(request)
        })
    },
    [jumpToCandidate, showNotFoundTooltip]
  )

  return {
    candidatePopover,
    notFoundTooltip,
    dismissPopover,
    dismissTooltip,
    selectCandidate,
    handleSymbolNavigate
  }
}
