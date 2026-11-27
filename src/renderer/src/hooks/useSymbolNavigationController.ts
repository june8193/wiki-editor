import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DocumentBufferSnapshot } from '@shared/documentBuffer'
import { toErrorMessage } from '@shared/errors'
import type { GitDiffRequest } from '@shared/git'
import type { WikiApi } from '@shared/ipc'
import type { CodeSourceScope, GitBlobSnapshotRequest, SymbolCandidateMatch } from '@shared/symbol'
import { getWorkspacePathKey, joinWorkspacePath } from '@shared/workspace'
import type { GitDiffContentState } from '../components/GitDiffViewer'
import {
  formatReferenceMatchKey,
  IDLE_REFERENCES_STATE,
  type ReferencesSearchState
} from '../components/ReferencesSection'
import type { SnapshotContentState } from '../components/SnapshotViewer'
import type { SymbolNotFoundTooltipState } from '../components/SymbolCandidatePopover'
import type { SymbolContextMenuViewState } from '../components/SymbolContextMenu'
import type { SymbolNavigateRequest } from '../editor/symbolHoverDom'
import {
  normalizeRepoPath,
  resolveDiffLineScope,
  resolveSymbolDefinitions,
  resolveSymbolReferences
} from '../editor/symbolNavigation'
import type {
  PaneNavigationCoordinator,
  PaneNavigationEntry
} from '../stores/PaneNavigationCoordinator'
import {
  formatGitSnapshotTabKey,
  getPaneActiveTab,
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
  diffTabId?: string
  diffSide?: 'old' | 'new'
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

export interface SymbolPaletteScopeInfo {
  scope: CodeSourceScope
  scopeLabel: string
  stashHash?: string
  currentFilePath: string
  changedFilePaths?: ReadonlySet<string>
  diffTabId?: string
  diffSide?: 'old' | 'new'
  isInCurrentDiffHunk?: (repoRelativePath: string, lineNumber: number) => boolean
  workspaceRootPath: string | null
}

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
  onRevealReferencesSection?: () => void
  wikiApi: Pick<WikiApi, 'workspace' | 'git'>
}

interface SymbolContextMenuInternalState {
  view: SymbolContextMenuViewState
  paneId: PaneId
  tabId: string
  request: SymbolNavigateRequest
}

interface ResolvedSymbolRequestContext {
  rootPath: string
  originPath: string
  originContent: string | undefined
  scope: CodeSourceScope
  stashHash: string | undefined
  activeDiffChangedFiles: ReadonlySet<string> | undefined
  isInCurrentDiffHunk: ((repoRelativePath: string, lineNumber: number) => boolean) | undefined
  diffTabId?: string
  diffSide?: 'old' | 'new'
  context: SymbolNavigationTargetContext
}

type ActiveReferencesContext = SymbolNavigationTargetContext & { rootPath: string }

function toRepoRelativePath(absoluteOrRelativePath: string, workspaceRootPath: string): string {
  const normPath = absoluteOrRelativePath.replace(/\\/g, '/')
  const normRoot = workspaceRootPath.replace(/\\/g, '/').replace(/\/+$/, '')
  if (normPath.toLowerCase().startsWith(`${normRoot.toLowerCase()}/`)) {
    return normPath.slice(normRoot.length + 1)
  }
  return normPath.replace(/^\/+/, '')
}

function formatScopeLabel(scope: CodeSourceScope): string {
  return scope.kind === 'working-tree' ? '워킹트리' : scope.displayRef
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

function buildCurrentPaneOriginEntry(
  paneId: PaneId,
  layout: PaneLayoutState,
  buffers: DocumentBufferSnapshot,
  fallbackOrigin: PaneNavigationEntry,
  rootPath: string
): PaneNavigationEntry {
  const pane = layout.panes[paneId]
  const activeTab = getPaneActiveTab(pane)
  if (!activeTab) return fallbackOrigin

  if (activeTab.kind === 'diff') {
    if (fallbackOrigin.kind === 'diff' && fallbackOrigin.tabId === activeTab.id) {
      return fallbackOrigin
    }
    return {
      kind: 'diff',
      tabId: activeTab.id,
      request: activeTab.diff.request,
      viewMode: activeTab.diff.viewMode,
      workspaceRootPath: activeTab.diff.workspaceRootPath ?? rootPath,
      lineNumber: 1,
      side: 'new'
    }
  }

  if (activeTab.kind === 'snapshot') {
    if (fallbackOrigin.kind === 'snapshot' && fallbackOrigin.tabId === activeTab.id) {
      return fallbackOrigin
    }
    return {
      kind: 'snapshot',
      tabId: activeTab.id,
      request: activeTab.snapshot.request,
      workspaceRootPath: activeTab.snapshot.workspaceRootPath ?? rootPath,
      lineNumber: 1,
      columnStart: 0,
      columnEnd: 0
    }
  }

  const buffer = buffers[activeTab.bufferKey]
  if (!buffer) return fallbackOrigin
  if (fallbackOrigin.kind === 'document' && fallbackOrigin.tabId === activeTab.id) {
    return fallbackOrigin
  }
  return {
    kind: 'document',
    tabId: activeTab.id,
    bufferKey: activeTab.bufferKey,
    filePath: buffer.path,
    lineNumber: 1,
    columnStart: 0,
    columnEnd: 0
  }
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
  onRevealReferencesSection,
  wikiApi
}: UseSymbolNavigationControllerOptions) {
  const [candidatePopover, setCandidatePopover] = useState<SymbolCandidatePopoverState | null>(null)
  const [notFoundTooltip, setNotFoundTooltip] = useState<SymbolNotFoundTooltipState | null>(null)
  const [contextMenu, setContextMenu] = useState<SymbolContextMenuInternalState | null>(null)
  const [referencesState, setReferencesState] = useState<ReferencesSearchState>(IDLE_REFERENCES_STATE)
  const navSeqRef = useRef(0)
  const refSeqRef = useRef(0)
  const activeReferencesContextRef = useRef<ActiveReferencesContext | null>(null)

  const latestRef = useRef({
    layout,
    buffers,
    diffsByKey,
    snapshotsByKey,
    workspaceRootPath,
    openSnapshotTab,
    getActiveDiffChangedFiles,
    onRevealReferencesSection,
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
    onRevealReferencesSection,
    wikiApi
  }

  const dismissPopover = useCallback(() => setCandidatePopover(null), [])
  const dismissTooltip = useCallback(() => setNotFoundTooltip(null), [])
  const dismissContextMenu = useCallback(() => setContextMenu(null), [])
  const clampContextMenuPosition = useCallback((x: number, y: number) => {
    setContextMenu((prev) => (prev ? { ...prev, view: { ...prev.view, x, y } } : null))
  }, [])

  useEffect(() => {
    setCandidatePopover(null)
    setNotFoundTooltip(null)
    setContextMenu(null)
    setReferencesState(IDLE_REFERENCES_STATE)
    activeReferencesContextRef.current = null
  }, [workspaceRootPath])

  useEffect(() => {
    if (!notFoundTooltip) return
    const timer = window.setTimeout(() => setNotFoundTooltip(null), 2500)
    const clear = (): void => setNotFoundTooltip(null)
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setNotFoundTooltip(null)
      }
    }
    window.addEventListener('mousedown', clear)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('mousedown', clear)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [notFoundTooltip])

  const resolveRequestContext = useCallback(
    (paneId: PaneId, tabId: string, request: SymbolNavigateRequest): ResolvedSymbolRequestContext | null => {
      const {
        layout: currentLayout,
        buffers: currentBuffers,
        diffsByKey: currentDiffs,
        snapshotsByKey: currentSnapshots,
        workspaceRootPath: propRootPath,
        getActiveDiffChangedFiles: getChangedFiles
      } = latestRef.current
      const pane = currentLayout.panes[paneId]
      const tab = pane.tabs.find((item) => item.id === tabId)
      if (!tab) return null
      const rootPath =
        propRootPath ??
        (tab.kind === 'diff'
          ? tab.diff.workspaceRootPath
          : tab.kind === 'snapshot'
            ? tab.snapshot.workspaceRootPath
            : undefined) ??
        null
      if (!rootPath) return null

      let originPath = ''
      let originContent: string | undefined
      let scope: CodeSourceScope
      let stashHash: string | undefined
      let activeDiffChangedFiles: ReadonlySet<string> | undefined
      let isInCurrentDiffHunk:
        | ((repoRelativePath: string, lineNumber: number) => boolean)
        | undefined
      let diffTabId: string | undefined
      let diffSide: 'old' | 'new' | undefined
      let originEntry: PaneNavigationEntry

      if (tab.kind === 'diff') {
        const side = request.side ?? 'new'
        scope = resolveDiffLineScope(tab.diff.request, side)
        stashHash = tab.diff.request.kind === 'stash' ? tab.diff.request.stashHash : undefined
        diffTabId = tab.id
        diffSide = side
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
        if (!buffer) return null
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

      return {
        rootPath,
        originPath,
        originContent,
        scope,
        stashHash,
        activeDiffChangedFiles,
        isInCurrentDiffHunk,
        diffTabId,
        diffSide,
        context: {
          paneId,
          originEntry,
          scope,
          stashHash,
          pinned: request.shiftKey,
          diffTabId,
          diffSide,
          isInCurrentDiffHunk
        }
      }
    },
    []
  )

  const createSearchCallbacks = useCallback((rootPath: string, stashHash?: string) => {
    const api = latestRef.current.wikiApi
    return {
      searchSymbols: (symbolName: string, targetScope: CodeSourceScope) =>
        api.workspace.searchSymbols?.({ symbolName, scope: targetScope, maxResults: 80 }) ??
        Promise.resolve([]),
      readFileContent: async (repoRelativePath: string, targetScope: CodeSourceScope) => {
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
    }
  }, [])

  const jumpToCandidate = useCallback(
    async (ctx: SymbolNavigationTargetContext, candidate: SymbolCandidateMatch): Promise<void> => {
      const {
        layout: currentLayout,
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

      const targetDiffTabId =
        ctx.diffTabId && currentLayout.panes[paneId].tabs.some((t) => t.id === ctx.diffTabId)
          ? ctx.diffTabId
          : originEntry.kind === 'diff'
            ? originEntry.tabId
            : undefined

      if (
        targetDiffTabId &&
        ctx.isInCurrentDiffHunk?.(candidate.path, candidate.lineNumber)
      ) {
        const side =
          ctx.diffSide ?? (originEntry.kind === 'diff' ? originEntry.side : 'new')
        navigation.jumpToDiffLine(paneId, targetDiffTabId, candidate.lineNumber, side)
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

  const runReferencesSearch = useCallback(
    (
      resolved: ResolvedSymbolRequestContext,
      request: SymbolNavigateRequest,
      fallbackNoticeBuilder?: (count: number) => string
    ): void => {
      const seq = ++refSeqRef.current
      const scopeLabel = formatScopeLabel(resolved.scope)
      const isExplicit = !fallbackNoticeBuilder

      if (isExplicit) {
        setReferencesState({
          status: 'loading',
          symbolName: request.symbolName,
          scopeLabel,
          matches: []
        })
        latestRef.current.onRevealReferencesSection?.()
      }

      const callbacks = createSearchCallbacks(resolved.rootPath, resolved.stashHash)
      void resolveSymbolReferences({
        symbolName: request.symbolName,
        currentFilePath: resolved.originPath,
        currentFileContent: resolved.originContent ?? null,
        scope: resolved.scope,
        workspaceRootPath: resolved.rootPath,
        changedFilePaths: resolved.activeDiffChangedFiles,
        isInActiveDiffHunk: resolved.isInCurrentDiffHunk
          ? (candidate) => resolved.isInCurrentDiffHunk!(candidate.path, candidate.lineNumber)
          : undefined,
        ...callbacks
      })
        .then((matches) => {
          if (refSeqRef.current !== seq) return
          if (fallbackNoticeBuilder) {
            const hasOtherReference = matches.some(
              (match) =>
                !(
                  match.path === resolved.originPath &&
                  match.lineNumber === request.lineNumber &&
                  match.columnStart === request.columnStart
                )
            )
            if (!hasOtherReference) {
              showNotFoundTooltip(request)
              return
            }
          }

          activeReferencesContextRef.current = {
            ...resolved.context,
            rootPath: resolved.rootPath
          }
          setReferencesState({
            status: 'loaded',
            symbolName: request.symbolName,
            scopeLabel,
            ...(fallbackNoticeBuilder ? { fallbackNotice: fallbackNoticeBuilder(matches.length) } : {}),
            matches,
            changedFilePaths: resolved.activeDiffChangedFiles,
            activeMatchKey: null
          })
          if (fallbackNoticeBuilder) {
            latestRef.current.onRevealReferencesSection?.()
          }
        })
        .catch((error: unknown) => {
          if (refSeqRef.current !== seq) return
          if (fallbackNoticeBuilder) {
            showNotFoundTooltip(request)
            return
          }
          setReferencesState({
            status: 'error',
            symbolName: request.symbolName,
            scopeLabel,
            errorMessage: toErrorMessage(error, '레퍼런스를 검색하지 못했습니다.'),
            matches: []
          })
        })
    },
    [createSearchCallbacks, showNotFoundTooltip]
  )

  const handleSymbolNavigate = useCallback(
    (paneId: PaneId, tabId: string, request: SymbolNavigateRequest): void => {
      const resolved = resolveRequestContext(paneId, tabId, request)
      if (!resolved) return

      setCandidatePopover(null)
      setNotFoundTooltip(null)
      setContextMenu(null)

      const seq = ++navSeqRef.current
      const callbacks = createSearchCallbacks(resolved.rootPath, resolved.stashHash)

      void resolveSymbolDefinitions({
        symbolName: request.symbolName,
        currentFilePath: resolved.originPath,
        currentFileContent: resolved.originContent ?? null,
        scope: resolved.scope,
        workspaceRootPath: resolved.rootPath,
        changedFilePaths: resolved.activeDiffChangedFiles,
        isInActiveDiffHunk: resolved.isInCurrentDiffHunk
          ? (candidate) => resolved.isInCurrentDiffHunk!(candidate.path, candidate.lineNumber)
          : undefined,
        ...callbacks
      })
        .then((resolution) => {
          if (navSeqRef.current !== seq) return
          if (resolution.status === 'not-found') {
            runReferencesSearch(
              resolved,
              request,
              (count) => `명확한 선언부를 찾지 못해 참조 ${count}건을 표시합니다`
            )
            return
          }
          if (resolution.status === 'single') {
            void jumpToCandidate(resolved.context, resolution.target)
            return
          }
          setCandidatePopover({
            x: request.clientX,
            y: request.clientY,
            symbolName: request.symbolName,
            candidates: resolution.candidates,
            context: resolved.context
          })
        })
        .catch(() => {
          if (navSeqRef.current !== seq) return
          showNotFoundTooltip(request)
        })
    },
    [createSearchCallbacks, jumpToCandidate, resolveRequestContext, runReferencesSearch, showNotFoundTooltip]
  )

  const handleFindReferences = useCallback(
    (paneId: PaneId, tabId: string, request: SymbolNavigateRequest): void => {
      const resolved = resolveRequestContext(paneId, tabId, request)
      if (!resolved) return

      setCandidatePopover(null)
      setNotFoundTooltip(null)
      setContextMenu(null)
      runReferencesSearch(resolved, request)
    },
    [resolveRequestContext, runReferencesSearch]
  )

  const handleSymbolContextMenu = useCallback(
    (paneId: PaneId, tabId: string, request: SymbolNavigateRequest): void => {
      setCandidatePopover(null)
      setNotFoundTooltip(null)
      setContextMenu({
        view: {
          symbolName: request.symbolName,
          x: request.clientX,
          y: request.clientY
        },
        paneId,
        tabId,
        request
      })
    },
    []
  )

  const dispatchContextMenuAction = useCallback(
    (action: (paneId: PaneId, tabId: string, request: SymbolNavigateRequest) => void) => {
      if (!contextMenu) return
      const { paneId, tabId, request } = contextMenu
      setContextMenu(null)
      action(paneId, tabId, request)
    },
    [contextMenu]
  )

  const runContextMenuGoToDefinition = useCallback(
    () => dispatchContextMenuAction(handleSymbolNavigate),
    [dispatchContextMenuAction, handleSymbolNavigate]
  )

  const runContextMenuFindReferences = useCallback(
    () => dispatchContextMenuAction(handleFindReferences),
    [dispatchContextMenuAction, handleFindReferences]
  )

  const handleSelectReferenceMatch = useCallback(
    (match: SymbolCandidateMatch) => {
      const ctx = activeReferencesContextRef.current
      if (!ctx) return
      const matchKey = formatReferenceMatchKey(match)
      setReferencesState((prev) => ({
        ...prev,
        activeMatchKey: matchKey
      }))
      const { layout: currentLayout, buffers: currentBuffers } = latestRef.current
      const originEntry = buildCurrentPaneOriginEntry(
        ctx.paneId,
        currentLayout,
        currentBuffers,
        ctx.originEntry,
        ctx.rootPath
      )
      void jumpToCandidate({ ...ctx, originEntry, pinned: false }, match)
    },
    [jumpToCandidate]
  )

  const referencesStateWithHandler = useMemo<ReferencesSearchState>(
    () => ({
      ...referencesState,
      onSelectMatch: handleSelectReferenceMatch
    }),
    [handleSelectReferenceMatch, referencesState]
  )

  const resolveActivePaletteScope = useCallback((): SymbolPaletteScopeInfo => {
    const {
      layout: currentLayout,
      buffers: currentBuffers,
      diffsByKey: currentDiffs,
      workspaceRootPath: propRootPath,
      getActiveDiffChangedFiles: getChangedFiles
    } = latestRef.current
    const activePaneId = currentLayout.activePaneId
    const activeTab = getPaneActiveTab(currentLayout.panes[activePaneId])

    if (activeTab?.kind === 'diff') {
      const side: 'old' | 'new' = 'new'
      const scope = resolveDiffLineScope(activeTab.diff.request, side)
      const extraChanged = getChangedFiles?.(activeTab.diff.request)
      const changedFilePaths = new Set<string>([
        normalizeRepoPath(activeTab.diff.request.path),
        ...(extraChanged ? Array.from(extraChanged, normalizeRepoPath) : [])
      ])
      const diffState = currentDiffs[formatGitDiffTabKey(activeTab.diff.request)]
      const isInCurrentDiffHunk =
        diffState?.status === 'loaded' && !diffState.diff.isBinary
          ? buildHunkLineChecker(diffState.diff.rawPatch, activeTab.diff.request.path, side)
          : undefined
      return {
        scope,
        scopeLabel: formatScopeLabel(scope),
        stashHash: activeTab.diff.request.kind === 'stash' ? activeTab.diff.request.stashHash : undefined,
        currentFilePath: activeTab.diff.request.path,
        changedFilePaths,
        diffTabId: activeTab.id,
        diffSide: side,
        isInCurrentDiffHunk,
        workspaceRootPath: activeTab.diff.workspaceRootPath ?? propRootPath ?? null
      }
    }

    if (activeTab?.kind === 'snapshot') {
      return {
        scope: activeTab.snapshot.request.scope,
        scopeLabel: formatScopeLabel(activeTab.snapshot.request.scope),
        stashHash: activeTab.snapshot.request.stashHash,
        currentFilePath: activeTab.snapshot.request.path,
        workspaceRootPath: activeTab.snapshot.workspaceRootPath ?? propRootPath ?? null
      }
    }

    const activeBuffer =
      activeTab?.kind === 'document' ? currentBuffers[activeTab.bufferKey] : undefined
    const rootPath = propRootPath ?? null
    return {
      scope: { kind: 'working-tree' },
      scopeLabel: '워킹트리',
      currentFilePath:
        activeBuffer && rootPath ? toRepoRelativePath(activeBuffer.path, rootPath) : '',
      workspaceRootPath: rootPath
    }
  }, [])

  const jumpToPaletteMatch = useCallback(
    (match: SymbolCandidateMatch, scopeInfo: SymbolPaletteScopeInfo, pinned: boolean): void => {
      const { layout: currentLayout, buffers: currentBuffers } = latestRef.current
      const paneId = currentLayout.activePaneId
      const effectiveRootPath = scopeInfo.workspaceRootPath
      if (!effectiveRootPath) return

      const fallbackOrigin: PaneNavigationEntry = {
        kind: 'document',
        tabId: '',
        bufferKey: '',
        filePath: '',
        lineNumber: 1,
        columnStart: 0,
        columnEnd: 0
      }
      const originEntry = buildCurrentPaneOriginEntry(
        paneId,
        currentLayout,
        currentBuffers,
        fallbackOrigin,
        effectiveRootPath
      )

      const ctx: SymbolNavigationTargetContext = {
        paneId,
        originEntry,
        scope: scopeInfo.scope,
        stashHash: scopeInfo.stashHash,
        pinned,
        diffTabId: scopeInfo.diffTabId,
        diffSide: scopeInfo.diffSide,
        isInCurrentDiffHunk: scopeInfo.isInCurrentDiffHunk
      }
      void jumpToCandidate(ctx, match)
    },
    [jumpToCandidate]
  )

  return {
    candidatePopover,
    notFoundTooltip,
    contextMenu: contextMenu?.view ?? null,
    referencesState: referencesStateWithHandler,
    dismissPopover,
    dismissTooltip,
    dismissContextMenu,
    clampContextMenuPosition,
    runContextMenuGoToDefinition,
    runContextMenuFindReferences,
    selectCandidate,
    handleSymbolNavigate,
    handleSymbolContextMenu,
    handleFindReferences,
    resolveActivePaletteScope,
    jumpToPaletteMatch
  }
}
