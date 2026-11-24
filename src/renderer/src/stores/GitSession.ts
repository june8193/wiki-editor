import { toErrorMessage } from '@shared/errors'
import {
  collectGitStagedPaths,
  collectGitStatusPaths,
  collectGitUnstagedPaths,
  DEFAULT_GIT_LOG_LIMIT,
  getGitChangedCount,
  type GitBranchList,
  type GitCommitDetail,
  type GitDiffRequest,
  type GitGraphCommit,
  type GitLogScope,
  type GitStashCreateOptions,
  type GitStashDetail,
  type GitStashEntry,
  type GitStatus
} from '@shared/git'
import type { WikiGitApi } from '@shared/ipc'
import { resolveRepoFileInWorkspace } from '@shared/workspace'
import type { GitDiffContentState } from '../components/GitDiffViewer'
import {
  promptUnsavedWorkspaceChanges,
  type ConfirmActionDialogRequest,
  type ConfirmUnsavedChangesFn
} from '../utils/confirmPrompts'
import { logRendererError, logRendererWarn } from '../logging/rendererLogger'
import {
  ACCORDION_RESET_RATIO,
  clampSectionHeightRatio,
  computeTwoSectionLayout
} from '../utils/accordionSplit'
import {
  buildDiscardAllConfirmMessage,
  buildStashClearConfirmMessage,
  buildStashDropConfirmMessage,
  formatGitDiffTabKey,
  getGitFileBaseName,
  toGitDiffRequest
} from '../utils/gitFilePresentation'
import { getGitPrimaryActionState, type GitCommitActionMode } from '../utils/gitPrimaryAction'

export type GitDetailState<TDetail> =
  | { status: 'idle' }
  | { status: 'loading'; selectedHash: string }
  | { status: 'loaded'; selectedHash: string; detail: TDetail }
  | { status: 'error'; selectedHash: string; errorMessage: string }

export function createInitialGitDetailState<TDetail>(): GitDetailState<TDetail> {
  return { status: 'idle' }
}

export interface GitGraphState {
  commits: readonly GitGraphCommit[]
  hasMore: boolean
  scope: GitLogScope
  isLoading: boolean
  isLoadingMore: boolean
  errorMessage: string | null
  commitDetail: GitDetailState<GitCommitDetail>
}

export function createInitialGitGraphState(): GitGraphState {
  return {
    commits: [],
    hasMore: false,
    scope: 'all',
    isLoading: false,
    isLoadingMore: false,
    errorMessage: null,
    commitDetail: createInitialGitDetailState()
  }
}

export interface GitPanelSplitState {
  isChangesCollapsed: boolean
  isStashesCollapsed: boolean
  isGraphCollapsed: boolean
  changesHeightRatio: number
}

export type GitStashesBodyMode = 'hidden' | 'compact' | 'fill'

export interface GitSectionLayout {
  showChangesBody: boolean
  showStashesBody: boolean
  showGraphBody: boolean
  showResizer: boolean
  changesFlexRatio: number | null
  stashesFlexRatio: number | null
  stashesBodyMode: GitStashesBodyMode
  graphFlexRatio: number | null
}

export function createDefaultGitPanelSplitState(): GitPanelSplitState {
  return {
    isChangesCollapsed: false,
    isStashesCollapsed: true,
    isGraphCollapsed: false,
    changesHeightRatio: ACCORDION_RESET_RATIO
  }
}

export function computeGitSectionLayout(state: GitPanelSplitState): GitSectionLayout {
  const twoSectionLayout = computeTwoSectionLayout({
    isTopCollapsed: state.isChangesCollapsed,
    isBottomCollapsed: state.isGraphCollapsed,
    topHeightRatio: state.changesHeightRatio
  })
  const showStashesBody = !state.isStashesCollapsed
  const stashesBodyMode: GitStashesBodyMode = !showStashesBody
    ? 'hidden'
    : twoSectionLayout.showTopBody || twoSectionLayout.showBottomBody
      ? 'compact'
      : 'fill'

  return {
    showChangesBody: twoSectionLayout.showTopBody,
    showStashesBody,
    showGraphBody: twoSectionLayout.showBottomBody,
    showResizer: twoSectionLayout.showResizer,
    changesFlexRatio: twoSectionLayout.topFlexRatio,
    stashesFlexRatio: stashesBodyMode === 'fill' ? 1 : null,
    stashesBodyMode,
    graphFlexRatio: twoSectionLayout.bottomFlexRatio
  }
}

export type GitChangesViewMode = 'list' | 'tree'
export type GitChangesGroupKey = 'staged' | 'changes'

export interface GitChangesViewState {
  viewMode: GitChangesViewMode
  isStagedCollapsed: boolean
  isChangesCollapsed: boolean
  collapsedTreeDirs: ReadonlySet<string>
}

export function createDefaultGitChangesViewState(): GitChangesViewState {
  return {
    viewMode: 'list',
    isStagedCollapsed: false,
    isChangesCollapsed: false,
    collapsedTreeDirs: new Set()
  }
}

export interface GitPanelState {
  workspaceRootPath: string | null
  status: GitStatus | null
  branchList: GitBranchList | null
  stashes: readonly GitStashEntry[]
  stashDetail: GitDetailState<GitStashDetail>
  graphState: GitGraphState
  pendingAction: string | null
  errorMessage: string | null
  splitState: GitPanelSplitState
  changesViewState: GitChangesViewState
  stashDialogScope: 'unstaged' | 'all' | null
}

function createDefaultGitPanelState(workspaceRootPath: string | null = null): GitPanelState {
  return {
    workspaceRootPath,
    status: null,
    branchList: null,
    stashes: [],
    stashDetail: createInitialGitDetailState(),
    graphState: createInitialGitGraphState(),
    pendingAction: null,
    errorMessage: null,
    splitState: createDefaultGitPanelSplitState(),
    changesViewState: createDefaultGitChangesViewState(),
    stashDialogScope: null
  }
}

export interface GitSessionSnapshot {
  panelState: GitPanelState
  diffsByKey: Readonly<Record<string, GitDiffContentState>>
  isMutating: boolean
}

export interface GitBufferCollaborator {
  getDirtySummary(targetPaths?: readonly string[]): string | null
  saveDirtyBuffers(targetPaths?: readonly string[]): Promise<boolean>
  prepareDiscardPaths(targetPaths: readonly string[]): Promise<void>
  finishDiscardPaths(targetPaths: readonly string[], forceSync: boolean): Promise<void>
  reconcileWithDisk(): Promise<readonly string[]>
  openWorkspaceFile(filePath: string, explicitName?: string): Promise<unknown> | void
}

export interface GitDiffTabsCollaborator {
  listOpenRequests(): readonly GitDiffRequest[]
  subscribe(listener: () => void): () => void
  openDiffTab(request: GitDiffRequest): void
  closeAllUnstagedDiffTabs(): void
  closeUnstagedDiffTabsForPaths(repoRelativePaths: readonly string[]): void
  closeUnstagedDiffTabsExcept(activeRepoRelativePaths: ReadonlySet<string>): void
  closeStagedDiffTabsExcept(activeRepoRelativePaths: ReadonlySet<string>): void
  reconcileStashDiffTabs(activeStashes: readonly GitStashEntry[]): void
}

export interface GitConfirmCollaborator {
  confirmAction(request: ConfirmActionDialogRequest): Promise<boolean>
  confirmUnsavedChanges: ConfirmUnsavedChangesFn
  isDialogOpen(): boolean
}

export interface GitSessionOptions {
  gitApi: WikiGitApi
  buffers: GitBufferCollaborator
  diffTabs: GitDiffTabsCollaborator
  confirm: GitConfirmCollaborator
  refreshTree: () => Promise<void>
  workspaceRootPath?: string | null
}

export interface GitPanelActions {
  dismissError: () => void
  refreshStatus: () => Promise<void>
  changeLogScope: (nextScope: GitLogScope) => Promise<void>
  loadMoreCommits: () => Promise<void>
  toggleCommitDetail: (commitHash: string) => Promise<void>
  toggleStashDetail: (entry: GitStashEntry) => Promise<void>
  initRepo: () => Promise<void>
  stageFile: (filePath: string) => Promise<void>
  stageAll: () => Promise<void>
  unstageFile: (filePath: string, origPath?: string) => Promise<void>
  unstageAll: () => Promise<void>
  discardFile: (filePath: string) => Promise<void>
  discardAll: () => Promise<boolean>
  stashChanges: () => Promise<boolean>
  stashFile: (filePath: string) => Promise<boolean>
  stashApply: (stashRef: string) => Promise<boolean>
  stashPop: (stashRef: string) => Promise<boolean>
  stashDrop: (stashRef: string) => Promise<boolean>
  stashClear: () => Promise<boolean>
  commit: (message: string, mode?: GitCommitActionMode) => Promise<boolean>
  checkoutBranch: (branchName: string) => Promise<void>
  pull: () => Promise<void>
  push: () => Promise<void>
  fetch: () => Promise<void>
  sync: () => Promise<void>
  openStashDialog: (initialScope?: 'unstaged' | 'all') => void
  closeStashDialog: () => void
  submitStashDialog: (options: GitStashCreateOptions) => Promise<boolean>
  openFileDiff: (request: GitDiffRequest) => void
  openWorkspaceFile: (repoRelativePath: string) => void
  toggleChangesCollapsed: () => void
  toggleStashesCollapsed: () => void
  toggleGraphCollapsed: () => void
  resizeChangesRatio: (nextRatio: number) => void
  toggleChangesViewMode: () => void
  toggleChangesGroupCollapsed: (group: GitChangesGroupKey) => void
  toggleChangesTreeDirCollapsed: (dirKey: string) => void
}

interface GitRequestContext {
  rootPath: string
  epoch: number
}

interface ApplyWorkspaceGitStateOptions {
  fetchRepoMetadata?: boolean
  refreshStashes?: boolean
  skipWorkingTreeDiffRefresh?: boolean
}

interface WorkspaceBufferMutationTarget {
  kind: 'discard-all' | 'discard-paths' | 'stash-create'
  paths: readonly string[]
}

interface GitActionExecutionOptions {
  affectsWorkspaceFiles?: boolean
  fetchRepoMetadata?: boolean
  refreshStashes?: boolean
  bufferMutationTarget?: WorkspaceBufferMutationTarget
  fallbackError: string
  fallbackStatusOnFailure?: GitStatus
  onConfirmCanceled?: () => Promise<void> | void
  run: (rootPath: string) => Promise<GitStatus>
}

interface GitActionRunState {
  ctx: GitRequestContext
  actionLabel: string
  options: GitActionExecutionOptions
  resolvedTargetPaths: readonly string[] | undefined
  needsBracketFinish: boolean
}

function resolveStashCreateTarget(
  status: GitStatus | null,
  options: GitStashCreateOptions
): { actionLabel: string; paths: string[] } {
  const includeUntracked = options.includeUntracked ?? true
  if (options.scope === 'paths') {
    return {
      actionLabel: '파일 Stash',
      paths: options.paths ? [...new Set(options.paths)] : []
    }
  }
  if (options.scope === 'all') {
    return {
      actionLabel: '전체 변경 사항 Stash',
      paths: status ? collectGitStatusPaths(status, includeUntracked) : []
    }
  }
  return {
    actionLabel: 'Changes Stash',
    paths: status ? collectGitUnstagedPaths(status, includeUntracked) : []
  }
}

interface DetailSelectionSpec<TTarget, TDetail> {
  getSelectedHash: (target: TTarget) => string
  fetchDetail: (rootPath: string, target: TTarget) => Promise<TDetail>
  fallbackErrorMessage: string
  logFailure: (rootPath: string, target: TTarget, errorMessage: string, error: unknown) => void
  getState: () => GitDetailState<TDetail>
  setState: (next: GitDetailState<TDetail>) => void
}

class DetailSelectionChannel<TTarget, TDetail> {
  private seq = 0

  constructor(
    private readonly isCurrentRequest: (ctx: GitRequestContext) => boolean,
    private readonly getWorkspaceContext: () => { rootPath: string | null; epoch: number },
    private readonly spec: DetailSelectionSpec<TTarget, TDetail>
  ) {}

  invalidate = (): void => {
    this.seq += 1
  }

  clear = (): void => {
    this.seq += 1
    if (this.spec.getState().status !== 'idle') {
      this.spec.setState(createInitialGitDetailState())
    }
  }

  prune = (validHashes: ReadonlySet<string>): void => {
    const current = this.spec.getState()
    if (current.status !== 'idle' && !validHashes.has(current.selectedHash)) {
      this.clear()
    }
  }

  toggle = async (target: TTarget): Promise<void> => {
    const selectedHash = this.spec.getSelectedHash(target)
    const current = this.spec.getState()
    if (current.status !== 'idle' && current.selectedHash === selectedHash) {
      this.clear()
      return
    }

    const { rootPath, epoch } = this.getWorkspaceContext()
    if (!rootPath) {
      return
    }
    const ctx: GitRequestContext = { rootPath, epoch }
    const detailSeq = ++this.seq
    const isCurrentDetailRequest = (): boolean => {
      const latest = this.spec.getState()
      return (
        this.isCurrentRequest(ctx) &&
        this.seq === detailSeq &&
        latest.status !== 'idle' &&
        latest.selectedHash === selectedHash
      )
    }

    this.spec.setState({ status: 'loading', selectedHash })

    try {
      const detail = await this.spec.fetchDetail(rootPath, target)
      if (!isCurrentDetailRequest()) {
        return
      }
      this.spec.setState({ status: 'loaded', selectedHash, detail })
    } catch (error: unknown) {
      if (!isCurrentDetailRequest()) {
        return
      }
      const message = toErrorMessage(error, this.spec.fallbackErrorMessage)
      this.spec.setState({ status: 'error', selectedHash, errorMessage: message })
      this.spec.logFailure(rootPath, target, message, error)
    }
  }
}

function collectOpenDiffRequests(requests: readonly GitDiffRequest[]): Map<string, GitDiffRequest> {
  const map = new Map<string, GitDiffRequest>()
  for (const request of requests) {
    map.set(formatGitDiffTabKey(request), request)
  }
  return map
}

function resolveEffectiveDiffRequest(
  request: GitDiffRequest,
  status: GitStatus | null
): GitDiffRequest {
  if (
    request.kind === 'commit' ||
    request.kind === 'stash' ||
    request.kind === 'branch-compare' ||
    !status ||
    !status.isRepo
  ) {
    return request
  }

  if (request.kind === 'staged') {
    const match = status.staged.find(
      (item) => item.path === request.path && item.origPath === request.origPath
    )
    return match ? toGitDiffRequest('staged', match) : request
  }

  const untrackedMatch = status.untracked.find((item) => item.path === request.path)
  if (untrackedMatch) {
    return { kind: 'unstaged', path: untrackedMatch.path, status: '?' }
  }

  const unstagedMatch = status.unstaged.find((item) => item.path === request.path)
  if (unstagedMatch) {
    return toGitDiffRequest('unstaged', unstagedMatch)
  }

  // Query tracked diff when a previously untracked file was staged or reverted so git returns an empty patch cleanly.
  if (request.status === '?') {
    return { kind: 'unstaged', path: request.path, status: 'M' }
  }
  return request
}

function appendUniqueCommits(
  existing: readonly GitGraphCommit[],
  incoming: readonly GitGraphCommit[]
): GitGraphCommit[] {
  const seenHashes = new Set(existing.map((commit) => commit.hash))
  const next = [...existing]
  for (const commit of incoming) {
    if (!seenHashes.has(commit.hash)) {
      seenHashes.add(commit.hash)
      next.push(commit)
    }
  }
  return next
}

/**
 * Coordinates workspace Git status, graph history, inline details, mutations, Diff tabs,
 * confirm dialogs, and session-only panel UI state behind a narrow collaborator seam.
 */
export class GitSession {
  private readonly gitApi: WikiGitApi
  private readonly buffers: GitBufferCollaborator
  private readonly diffTabs: GitDiffTabsCollaborator
  private readonly confirm: GitConfirmCollaborator
  private readonly refreshTree: () => Promise<void>

  private readonly listeners = new Set<() => void>()
  private snapshot: GitSessionSnapshot
  private active = true
  private workspaceEpoch = 0
  private requestSeq = 0
  private logRequestSeq = 0
  private mutationToken: number | null = null
  private mutationCounter = 0

  private readonly inFlightDiffSeq = new Map<string, number>()
  private readonly pendingDiffKeys = new Set<string>()
  private openDiffKeys = new Set<string>()
  private unsubscribeDiffTabs: (() => void) | null = null
  private isStatusRefreshInFlight = false

  private readonly commitDetailChannel: DetailSelectionChannel<string, GitCommitDetail>
  private readonly stashDetailChannel: DetailSelectionChannel<GitStashEntry, GitStashDetail>

  readonly actions: GitPanelActions

  constructor(options: GitSessionOptions) {
    this.gitApi = options.gitApi
    this.buffers = options.buffers
    this.diffTabs = options.diffTabs
    this.confirm = options.confirm
    this.refreshTree = options.refreshTree

    const initialRoot = options.workspaceRootPath ?? null
    this.snapshot = {
      panelState: createDefaultGitPanelState(initialRoot),
      diffsByKey: {},
      isMutating: false
    }

    const getWorkspaceContext = () => ({
      rootPath: this.snapshot.panelState.workspaceRootPath,
      epoch: this.workspaceEpoch
    })

    this.commitDetailChannel = new DetailSelectionChannel<string, GitCommitDetail>(
      this.isCurrentRequest,
      getWorkspaceContext,
      {
        getSelectedHash: (commitHash) => commitHash,
        fetchDetail: (rootPath, commitHash) => this.gitApi.commitDetail(rootPath, commitHash),
        fallbackErrorMessage: '커밋 상세 정보를 불러오지 못했습니다.',
        logFailure: (rootPath, commitHash, errorMessage, error) => {
          logRendererError('git', 'Git commit detail fetch failed', {
            data: { workspaceRootPath: rootPath, commitHash, errorMessage },
            error
          })
        },
        getState: () => this.snapshot.panelState.graphState.commitDetail,
        setState: (commitDetail) =>
          this.updatePanelState({
            graphState: {
              ...this.snapshot.panelState.graphState,
              commitDetail
            }
          })
      }
    )

    this.stashDetailChannel = new DetailSelectionChannel<GitStashEntry, GitStashDetail>(
      this.isCurrentRequest,
      getWorkspaceContext,
      {
        getSelectedHash: (entry) => entry.hash,
        fetchDetail: (rootPath, entry) => this.gitApi.stashDetail(rootPath, entry.ref),
        fallbackErrorMessage: 'Stash 상세 정보를 불러오지 못했습니다.',
        logFailure: (rootPath, entry, errorMessage, error) => {
          logRendererError('git', 'Git stash detail fetch failed', {
            data: {
              workspaceRootPath: rootPath,
              stashRef: entry.ref,
              stashHash: entry.hash,
              errorMessage
            },
            error
          })
        },
        getState: () => this.snapshot.panelState.stashDetail,
        setState: (stashDetail) => this.updatePanelState({ stashDetail })
      }
    )

    this.actions = {
      dismissError: this.dismissError,
      refreshStatus: this.refreshStatus,
      changeLogScope: this.changeLogScope,
      loadMoreCommits: this.loadMoreCommits,
      toggleCommitDetail: this.toggleCommitDetail,
      toggleStashDetail: this.toggleStashDetail,
      initRepo: this.initRepo,
      stageFile: this.stageFile,
      stageAll: this.stageAll,
      unstageFile: this.unstageFile,
      unstageAll: this.unstageAll,
      discardFile: this.discardFile,
      discardAll: this.discardAll,
      stashChanges: this.stashChanges,
      stashFile: this.stashFile,
      stashApply: this.stashApply,
      stashPop: this.stashPop,
      stashDrop: this.stashDrop,
      stashClear: this.stashClear,
      commit: this.commit,
      checkoutBranch: this.checkoutBranch,
      pull: this.pull,
      push: this.push,
      fetch: this.fetch,
      sync: this.sync,
      openStashDialog: this.openStashDialog,
      closeStashDialog: this.closeStashDialog,
      submitStashDialog: this.submitStashDialog,
      openFileDiff: this.openFileDiff,
      openWorkspaceFile: this.openWorkspaceFile,
      toggleChangesCollapsed: this.toggleChangesCollapsed,
      toggleStashesCollapsed: this.toggleStashesCollapsed,
      toggleGraphCollapsed: this.toggleGraphCollapsed,
      resizeChangesRatio: this.resizeChangesRatio,
      toggleChangesViewMode: this.toggleChangesViewMode,
      toggleChangesGroupCollapsed: this.toggleChangesGroupCollapsed,
      toggleChangesTreeDirCollapsed: this.toggleChangesTreeDirCollapsed
    }

    this.ensureDiffTabsSubscription()
    this.syncOpenDiffTabs()
    if (initialRoot) {
      void this.refreshStatus()
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): GitSessionSnapshot => this.snapshot

  start = (): (() => void) => {
    this.active = true
    this.ensureDiffTabsSubscription()
    this.syncOpenDiffTabs()
    if (
      this.snapshot.panelState.workspaceRootPath &&
      !this.snapshot.panelState.status &&
      !this.isStatusRefreshInFlight
    ) {
      void this.refreshStatus()
    }
    return this.dispose
  }

  private resetTransientTracking(): void {
    this.workspaceEpoch += 1
    this.requestSeq += 1
    this.logRequestSeq += 1
    this.mutationToken = null
    this.isStatusRefreshInFlight = false
    this.inFlightDiffSeq.clear()
    this.pendingDiffKeys.clear()
    this.openDiffKeys.clear()
    this.commitDetailChannel.invalidate()
    this.stashDetailChannel.invalidate()
  }

  dispose = (): void => {
    this.active = false
    this.unsubscribeDiffTabs?.()
    this.unsubscribeDiffTabs = null
    this.resetTransientTracking()

    const prevDiffs = this.snapshot.diffsByKey
    const hasLoadingDiff = Object.values(prevDiffs).some((entry) => entry.status === 'loading')
    const prevPanel = this.snapshot.panelState
    const prevGraph = prevPanel.graphState
    const hasLoadingGraph = prevGraph.isLoading || prevGraph.isLoadingMore
    const hasLoadingCommitDetail = prevGraph.commitDetail.status === 'loading'
    const hasLoadingStashDetail = prevPanel.stashDetail.status === 'loading'
    if (
      hasLoadingDiff ||
      hasLoadingGraph ||
      hasLoadingCommitDetail ||
      hasLoadingStashDetail ||
      this.snapshot.isMutating ||
      prevPanel.pendingAction !== null
    ) {
      let nextDiffs: Readonly<Record<string, GitDiffContentState>> = prevDiffs
      if (hasLoadingDiff) {
        const filteredDiffs: Record<string, GitDiffContentState> = {}
        for (const [key, entry] of Object.entries(prevDiffs)) {
          if (entry.status !== 'loading') {
            filteredDiffs[key] = entry
          }
        }
        nextDiffs = filteredDiffs
      }
      this.commitSnapshot({
        ...this.snapshot,
        isMutating: false,
        diffsByKey: nextDiffs,
        panelState: {
          ...prevPanel,
          pendingAction: null,
          stashDetail: hasLoadingStashDetail ? createInitialGitDetailState() : prevPanel.stashDetail,
          graphState:
            hasLoadingGraph || hasLoadingCommitDetail
              ? {
                  ...prevGraph,
                  isLoading: false,
                  isLoadingMore: false,
                  commitDetail: hasLoadingCommitDetail
                    ? createInitialGitDetailState()
                    : prevGraph.commitDetail
                }
              : prevGraph
        }
      })
    }
  }

  private ensureDiffTabsSubscription(): void {
    if (this.unsubscribeDiffTabs) {
      return
    }
    this.unsubscribeDiffTabs = this.diffTabs.subscribe(() => {
      this.syncOpenDiffTabs()
    })
  }

  setWorkspaceRootPath = (nextRootPath: string | null): void => {
    if (this.snapshot.panelState.workspaceRootPath === nextRootPath) {
      return
    }
    this.resetTransientTracking()

    const prevSplit = this.snapshot.panelState.splitState
    const nextSplit: GitPanelSplitState = prevSplit.isStashesCollapsed
      ? prevSplit
      : { ...prevSplit, isStashesCollapsed: true }
    const prevView = this.snapshot.panelState.changesViewState
    const nextView: GitChangesViewState =
      prevView.collapsedTreeDirs.size === 0
        ? prevView
        : { ...prevView, collapsedTreeDirs: new Set() }

    this.commitSnapshot({
      panelState: {
        ...createDefaultGitPanelState(nextRootPath),
        splitState: {
          ...nextSplit,
          changesHeightRatio: clampSectionHeightRatio(nextSplit.changesHeightRatio, ACCORDION_RESET_RATIO)
        },
        changesViewState: nextView
      },
      diffsByKey: {},
      isMutating: false
    })

    if (nextRootPath) {
      void this.refreshStatus()
    }
  }

  private commitSnapshot(next: GitSessionSnapshot): void {
    this.snapshot = next
    for (const listener of this.listeners) {
      listener()
    }
  }

  private updatePanelState(patch: Partial<GitPanelState>): void {
    this.commitSnapshot({
      ...this.snapshot,
      panelState: {
        ...this.snapshot.panelState,
        ...patch
      }
    })
  }

  private isCurrentRequest = (ctx: GitRequestContext): boolean =>
    this.active &&
    this.snapshot.panelState.workspaceRootPath === ctx.rootPath &&
    this.workspaceEpoch === ctx.epoch

  private currentRequestContext(): GitRequestContext | null {
    const rootPath = this.snapshot.panelState.workspaceRootPath
    return rootPath ? { rootPath, epoch: this.workspaceEpoch } : null
  }

  private resetGraph(nextScope?: GitLogScope): void {
    this.logRequestSeq += 1
    this.commitDetailChannel.clear()
    const prevGraph = this.snapshot.panelState.graphState
    this.updatePanelState({
      graphState: {
        commits: [],
        hasMore: false,
        scope: nextScope ?? prevGraph.scope,
        isLoading: false,
        isLoadingMore: false,
        errorMessage: null,
        commitDetail: createInitialGitDetailState()
      }
    })
  }

  private syncStashesState(nextStashes: GitStashEntry[]): void {
    this.stashDetailChannel.prune(new Set(nextStashes.map((entry) => entry.hash)))
    this.updatePanelState({ stashes: nextStashes })
    this.diffTabs.reconcileStashDiffTabs(nextStashes)
    this.syncOpenDiffTabs()
  }

  private setDiffCacheEntry(tabKey: string, nextState: GitDiffContentState): void {
    this.commitSnapshot({
      ...this.snapshot,
      diffsByKey: {
        ...this.snapshot.diffsByKey,
        [tabKey]: nextState
      }
    })
  }

  private fetchDiffForKey(
    tabKey: string,
    request: GitDiffRequest,
    ctx: GitRequestContext,
    showLoadingWhenAbsent: boolean
  ): void {
    const nextSeq = (this.inFlightDiffSeq.get(tabKey) ?? 0) + 1
    this.inFlightDiffSeq.set(tabKey, nextSeq)
    this.pendingDiffKeys.add(tabKey)

    if (showLoadingWhenAbsent && !this.snapshot.diffsByKey[tabKey]) {
      this.setDiffCacheEntry(tabKey, { status: 'loading' })
    }

    const isCurrentOpenRequest = (): boolean =>
      this.active &&
      this.workspaceEpoch === ctx.epoch &&
      this.openDiffKeys.has(tabKey) &&
      this.inFlightDiffSeq.get(tabKey) === nextSeq

    const effectiveRequest = resolveEffectiveDiffRequest(request, this.snapshot.panelState.status)
    void this.gitApi
      .diff(ctx.rootPath, effectiveRequest)
      .then((diff) => {
        if (!isCurrentOpenRequest()) return
        this.setDiffCacheEntry(tabKey, { status: 'loaded', diff })
      })
      .catch((error: unknown) => {
        if (!isCurrentOpenRequest()) return
        this.setDiffCacheEntry(tabKey, {
          status: 'error',
          errorMessage: toErrorMessage(error, 'Diff를 불러오지 못했습니다.')
        })
      })
      .finally(() => {
        if (this.inFlightDiffSeq.get(tabKey) === nextSeq) {
          this.pendingDiffKeys.delete(tabKey)
        }
      })
  }

  private syncOpenDiffTabs = (): void => {
    const openMap = collectOpenDiffRequests(this.diffTabs.listOpenRequests())
    this.openDiffKeys = new Set(openMap.keys())
    for (const key of this.pendingDiffKeys) {
      if (!openMap.has(key)) {
        this.pendingDiffKeys.delete(key)
      }
    }

    const prevDiffs = this.snapshot.diffsByKey
    const staleKeys = Object.keys(prevDiffs).filter((key) => !openMap.has(key))
    if (staleKeys.length > 0) {
      const nextDiffs: Record<string, GitDiffContentState> = {}
      for (const [key, value] of Object.entries(prevDiffs)) {
        if (openMap.has(key)) {
          nextDiffs[key] = value
        }
      }
      this.commitSnapshot({
        ...this.snapshot,
        diffsByKey: nextDiffs
      })
    }

    const ctx = this.currentRequestContext()
    if (!ctx) return

    for (const [tabKey, request] of openMap.entries()) {
      if (!this.snapshot.diffsByKey[tabKey] && !this.pendingDiffKeys.has(tabKey)) {
        this.fetchDiffForKey(tabKey, request, ctx, true)
      }
    }
  }

  private refreshOpenWorkingTreeDiffs(ctx: GitRequestContext, nextStatus: GitStatus): void {
    if (!nextStatus.isRepo || !this.isCurrentRequest(ctx)) {
      return
    }
    const openMap = collectOpenDiffRequests(this.diffTabs.listOpenRequests())
    for (const [tabKey, request] of openMap.entries()) {
      if (request.kind === 'staged' || request.kind === 'unstaged') {
        this.fetchDiffForKey(tabKey, request, ctx, false)
      }
    }
  }

  private openFileDiff = (request: GitDiffRequest): void => {
    const tabKey = formatGitDiffTabKey(request)
    const seqBefore = this.inFlightDiffSeq.get(tabKey) ?? 0
    this.diffTabs.openDiffTab(request)
    if ((this.inFlightDiffSeq.get(tabKey) ?? 0) === seqBefore) {
      const ctx = this.currentRequestContext()
      if (!ctx) return
      this.openDiffKeys.add(tabKey)
      this.fetchDiffForKey(tabKey, request, ctx, true)
    }
  }

  private isCurrentLogRequest(
    ctx: GitRequestContext,
    logSeq: number,
    scope: GitLogScope
  ): boolean {
    return (
      this.isCurrentRequest(ctx) &&
      this.logRequestSeq === logSeq &&
      this.snapshot.panelState.graphState.scope === scope
    )
  }

  private async fetchCommitLog(
    ctx: GitRequestContext,
    scope: GitLogScope,
    append: boolean
  ): Promise<void> {
    if (!this.isCurrentRequest(ctx)) {
      return
    }
    const logSeq = ++this.logRequestSeq
    const currentGraph = this.snapshot.panelState.graphState
    const skip = append ? currentGraph.commits.length : 0

    this.updatePanelState({
      graphState: {
        ...currentGraph,
        isLoading: append ? currentGraph.isLoading : true,
        isLoadingMore: append,
        errorMessage: null
      }
    })

    try {
      const result = await this.gitApi.log(ctx.rootPath, {
        scope,
        limit: DEFAULT_GIT_LOG_LIMIT,
        skip
      })
      if (!this.isCurrentLogRequest(ctx, logSeq, scope)) {
        return
      }

      const latestGraph = this.snapshot.panelState.graphState
      const nextCommits = append
        ? appendUniqueCommits(latestGraph.commits, result.commits)
        : result.commits
      if (!append) {
        this.commitDetailChannel.prune(new Set(nextCommits.map((commit) => commit.hash)))
      }
      this.updatePanelState({
        graphState: {
          ...this.snapshot.panelState.graphState,
          commits: nextCommits,
          hasMore: result.hasMore
        }
      })
    } catch (error: unknown) {
      if (!this.isCurrentLogRequest(ctx, logSeq, scope)) {
        return
      }
      const message = toErrorMessage(error, '커밋 히스토리를 불러오지 못했습니다.')
      this.updatePanelState({
        graphState: {
          ...this.snapshot.panelState.graphState,
          errorMessage: message
        }
      })
      logRendererError('git', 'Git commit log fetch failed', {
        data: { workspaceRootPath: ctx.rootPath, scope, skip, errorMessage: message },
        error
      })
    } finally {
      if (this.active && this.logRequestSeq === logSeq) {
        const latest = this.snapshot.panelState.graphState
        this.updatePanelState({
          graphState: {
            ...latest,
            isLoading: append ? latest.isLoading : false,
            isLoadingMore: append ? false : latest.isLoadingMore
          }
        })
      }
    }
  }

  private async applyWorkspaceGitState(
    ctx: GitRequestContext,
    nextStatus: GitStatus,
    options: ApplyWorkspaceGitStateOptions = {}
  ): Promise<void> {
    if (!this.isCurrentRequest(ctx)) {
      return
    }
    const fetchRepoMetadata = options.fetchRepoMetadata ?? false
    const refreshStashes = options.refreshStashes ?? fetchRepoMetadata
    const skipWorkingTreeDiffRefresh = options.skipWorkingTreeDiffRefresh ?? false

    const applySeq = ++this.requestSeq
    this.updatePanelState({
      status: nextStatus,
      ...(!nextStatus.isRepo ? { stashDialogScope: null } : {})
    })

    if (!nextStatus.isRepo) {
      this.updatePanelState({ branchList: null })
      this.syncStashesState([])
      this.resetGraph()
      return
    }
    if (!skipWorkingTreeDiffRefresh) {
      this.refreshOpenWorkingTreeDiffs(ctx, nextStatus)
    }
    if (!fetchRepoMetadata && !refreshStashes) return

    const runNonFatalQuery = <T,>(query: Promise<T>, applyResult: (value: T) => void): Promise<void> =>
      query
        .then((value) => {
          if (!this.isCurrentRequest(ctx) || this.requestSeq !== applySeq) {
            return
          }
          applyResult(value)
        })
        .catch(() => {
          // Auxiliary metadata lookups are non-fatal when Git status already succeeded
        })

    const tasks: Array<Promise<unknown>> = []
    if (refreshStashes) {
      tasks.push(
        runNonFatalQuery(this.gitApi.stashList(ctx.rootPath), (list) => this.syncStashesState(list))
      )
    }
    if (fetchRepoMetadata) {
      tasks.push(
        runNonFatalQuery(this.gitApi.branches(ctx.rootPath), (branchList) =>
          this.updatePanelState({ branchList })
        ),
        this.fetchCommitLog(ctx, this.snapshot.panelState.graphState.scope, false)
      )
    }
    await Promise.all(tasks)
  }

  private dismissError = (): void => {
    this.updatePanelState({ errorMessage: null })
  }

  private refreshStatus = async (): Promise<void> => {
    const ctx = this.currentRequestContext()
    if (!ctx) {
      this.commitDetailChannel.clear()
      this.stashDetailChannel.clear()
      this.updatePanelState({
        status: null,
        branchList: null,
        stashes: [],
        errorMessage: null
      })
      this.resetGraph()
      return
    }
    if (this.mutationToken !== null) {
      return
    }

    const refreshSeq = ++this.requestSeq
    this.isStatusRefreshInFlight = true
    try {
      const nextStatus = await this.gitApi.status(ctx.rootPath)
      if (
        this.mutationToken !== null ||
        !this.isCurrentRequest(ctx) ||
        this.requestSeq !== refreshSeq
      ) {
        return
      }
      await this.applyWorkspaceGitState(ctx, nextStatus, { fetchRepoMetadata: true })
    } catch (error: unknown) {
      if (!this.isCurrentRequest(ctx)) {
        return
      }
      const message = toErrorMessage(error, 'Git 상태를 불러오지 못했습니다.')
      this.updatePanelState({ errorMessage: message })
      logRendererError('git', 'Git status refresh failed', {
        data: { workspaceRootPath: ctx.rootPath, errorMessage: message },
        error
      })
    } finally {
      if (this.requestSeq === refreshSeq) {
        this.isStatusRefreshInFlight = false
      }
    }
  }

  private changeLogScope = async (nextScope: GitLogScope): Promise<void> => {
    if (this.snapshot.panelState.graphState.scope === nextScope) {
      return
    }
    this.resetGraph(nextScope)
    const ctx = this.currentRequestContext()
    if (!ctx) {
      return
    }
    await this.fetchCommitLog(ctx, nextScope, false)
  }

  private loadMoreCommits = async (): Promise<void> => {
    const ctx = this.currentRequestContext()
    const current = this.snapshot.panelState.graphState
    if (!ctx || current.isLoading || current.isLoadingMore || !current.hasMore) {
      return
    }
    await this.fetchCommitLog(ctx, current.scope, true)
  }

  private toggleCommitDetail = (commitHash: string): Promise<void> =>
    this.commitDetailChannel.toggle(commitHash)

  private toggleStashDetail = (entry: GitStashEntry): Promise<void> =>
    this.stashDetailChannel.toggle(entry)

  private async withMutationLock(run: (ctx: GitRequestContext) => Promise<boolean>): Promise<boolean> {
    const rootPath = this.snapshot.panelState.workspaceRootPath
    if (!rootPath || this.mutationToken !== null) return false

    const epoch = this.workspaceEpoch
    const token = ++this.mutationCounter
    this.mutationToken = token
    this.commitSnapshot({
      ...this.snapshot,
      isMutating: true,
      panelState: {
        ...this.snapshot.panelState,
        errorMessage: null
      }
    })

    try {
      return await run({ rootPath, epoch })
    } finally {
      if (this.mutationToken === token) {
        this.mutationToken = null
        if (this.active) {
          this.commitSnapshot({
            ...this.snapshot,
            isMutating: false,
            panelState: {
              ...this.snapshot.panelState,
              pendingAction: null
            }
          })
        }
      }
    }
  }

  private reportGitActionError(
    ctx: GitRequestContext,
    actionLabel: string,
    error: unknown,
    fallbackError: string
  ): void {
    if (!this.isCurrentRequest(ctx)) return
    const message = toErrorMessage(error, fallbackError)
    this.updatePanelState({ errorMessage: message })
    logRendererError('git', 'Git action failed', {
      data: { action: actionLabel, workspaceRootPath: ctx.rootPath, errorMessage: message },
      error
    })
  }

  private canStartInteractiveAction(): boolean {
    return (
      !this.confirm.isDialogOpen() &&
      this.snapshot.panelState.stashDialogScope === null &&
      this.mutationToken === null &&
      Boolean(this.snapshot.panelState.status?.isRepo)
    )
  }

  private resolveTargetWorkspacePaths(targetRepoPaths: readonly string[]): string[] {
    const workspaceRoot = this.snapshot.panelState.workspaceRootPath
    if (!workspaceRoot) return []
    const repoRoot = this.snapshot.panelState.status?.repoRoot ?? workspaceRoot
    const resolved: string[] = []
    for (const repoRelativePath of targetRepoPaths) {
      const resolvedEntry = resolveRepoFileInWorkspace(repoRoot, workspaceRoot, repoRelativePath)
      if (resolvedEntry) {
        resolved.push(resolvedEntry.path)
      }
    }
    return resolved
  }

  private closeDiffTabsForMutationTarget(
    target: WorkspaceBufferMutationTarget,
    latestStatus: GitStatus | null
  ): void {
    if (target.kind === 'discard-all') {
      this.diffTabs.closeAllUnstagedDiffTabs()
      return
    }
    if (target.kind === 'discard-paths') {
      this.diffTabs.closeUnstagedDiffTabsForPaths(target.paths)
      return
    }
    if (latestStatus) {
      this.diffTabs.closeStagedDiffTabsExcept(new Set(collectGitStagedPaths(latestStatus)))
      this.diffTabs.closeUnstagedDiffTabsExcept(new Set(collectGitUnstagedPaths(latestStatus, true)))
    }
  }

  private syncAndRefreshOpenDiffs(
    ctx: GitRequestContext,
    latestStatus: GitStatus | null,
    syncOpenTabs: boolean
  ): void {
    if (syncOpenTabs) {
      this.syncOpenDiffTabs()
    }
    if (latestStatus && this.isCurrentRequest(ctx)) {
      this.refreshOpenWorkingTreeDiffs(ctx, latestStatus)
    }
  }

  private async finishBufferBracket(run: GitActionRunState, succeeded: boolean): Promise<void> {
    if (!run.needsBracketFinish) {
      return
    }
    run.needsBracketFinish = false
    if (run.resolvedTargetPaths && run.resolvedTargetPaths.length > 0) {
      await this.buffers.finishDiscardPaths(run.resolvedTargetPaths, succeeded)
    }
  }

  private async completeWorkspaceMutationEffects(
    run: GitActionRunState,
    succeeded: boolean,
    latestStatus: GitStatus | null
  ): Promise<void> {
    const { ctx, actionLabel, options } = run
    if (!options.affectsWorkspaceFiles) {
      return
    }

    await this.finishBufferBracket(run, succeeded)

    if (options.bufferMutationTarget) {
      if (!succeeded) {
        this.syncAndRefreshOpenDiffs(ctx, latestStatus, false)
        return
      }
      this.closeDiffTabsForMutationTarget(options.bufferMutationTarget, latestStatus)
      this.syncAndRefreshOpenDiffs(ctx, latestStatus, true)
      await this.refreshTree()
      return
    }

    if (latestStatus) {
      this.diffTabs.closeUnstagedDiffTabsExcept(new Set(collectGitUnstagedPaths(latestStatus, true)))
    }
    this.syncAndRefreshOpenDiffs(ctx, latestStatus, Boolean(latestStatus))
    await this.refreshTree()
    const warnings = await this.buffers.reconcileWithDisk()
    if (succeeded && warnings.length > 0 && this.isCurrentRequest(ctx)) {
      const message = warnings.join(' ')
      this.updatePanelState({ errorMessage: message })
      logRendererWarn('git', 'Git workspace mutation completed with warnings', {
        data: { action: actionLabel, workspaceRootPath: ctx.rootPath, warningMessage: message }
      })
    }
  }

  private async recoverFailedGitAction(run: GitActionRunState): Promise<void> {
    const { ctx, options } = run
    const affectsWorkspaceFiles = options.affectsWorkspaceFiles ?? false
    const freshStatus = affectsWorkspaceFiles
      ? await this.gitApi.status(ctx.rootPath).catch(() => null)
      : null
    if (!this.isCurrentRequest(ctx)) {
      return
    }
    const recoveryStatus = freshStatus ?? options.fallbackStatusOnFailure
    if (recoveryStatus) {
      await this.applyWorkspaceGitState(ctx, recoveryStatus, {
        fetchRepoMetadata: options.fetchRepoMetadata,
        refreshStashes: options.refreshStashes,
        skipWorkingTreeDiffRefresh: affectsWorkspaceFiles
      })
    }
    if (affectsWorkspaceFiles && this.isCurrentRequest(ctx)) {
      await this.completeWorkspaceMutationEffects(run, false, freshStatus).catch(() => undefined)
    }
  }

  private async executeGitActionBody(
    ctx: GitRequestContext,
    actionLabel: string,
    options: GitActionExecutionOptions
  ): Promise<boolean> {
    const runState: GitActionRunState = {
      ctx,
      actionLabel,
      options,
      resolvedTargetPaths: options.bufferMutationTarget
        ? this.resolveTargetWorkspacePaths(options.bufferMutationTarget.paths)
        : undefined,
      needsBracketFinish: false
    }

    try {
      if (options.affectsWorkspaceFiles) {
        this.updatePanelState({ pendingAction: null })
        const confirmed = await promptUnsavedWorkspaceChanges(
          this.buffers,
          this.confirm.confirmUnsavedChanges,
          {
            targetPaths: runState.resolvedTargetPaths,
            message: (dirtySummary) =>
              `"${dirtySummary}"에 저장하지 않은 변경 사항이 있습니다. ${actionLabel} 전에 어떻게 할까요?`,
            confirmLabel: '저장 후 진행',
            secondaryLabel: '저장 없이 진행'
          }
        )
        if (!this.isCurrentRequest(ctx)) {
          return false
        }
        if (!confirmed) {
          await options.onConfirmCanceled?.()
          return false
        }
      }

      this.updatePanelState({ pendingAction: actionLabel })

      if (
        options.bufferMutationTarget &&
        runState.resolvedTargetPaths &&
        runState.resolvedTargetPaths.length > 0
      ) {
        runState.needsBracketFinish = true
        await this.buffers.prepareDiscardPaths(runState.resolvedTargetPaths)
        if (!this.isCurrentRequest(ctx)) {
          return false
        }
      }

      const nextStatus = await options.run(ctx.rootPath)
      await this.applyWorkspaceGitState(ctx, nextStatus, {
        fetchRepoMetadata: options.fetchRepoMetadata,
        refreshStashes: options.refreshStashes,
        skipWorkingTreeDiffRefresh: options.affectsWorkspaceFiles
      })
      if (this.isCurrentRequest(ctx)) {
        await this.completeWorkspaceMutationEffects(runState, true, nextStatus)
      }
      return this.isCurrentRequest(ctx)
    } catch (error: unknown) {
      this.reportGitActionError(ctx, actionLabel, error, options.fallbackError)
      if (this.isCurrentRequest(ctx)) {
        await this.recoverFailedGitAction(runState)
      }
      return false
    } finally {
      await this.finishBufferBracket(runState, false).catch(() => undefined)
    }
  }

  private runGitAction(actionLabel: string, options: GitActionExecutionOptions): Promise<boolean> {
    return this.withMutationLock((ctx) => this.executeGitActionBody(ctx, actionLabel, options))
  }

  private get stageAllSpec(): GitActionExecutionOptions {
    return {
      fallbackError: '전체 파일을 Stage하지 못했습니다.',
      run: (rootPath) => this.gitApi.stageAll(rootPath)
    }
  }

  private get pushSpec(): GitActionExecutionOptions {
    return {
      fetchRepoMetadata: true,
      fallbackError: 'Push에 실패했습니다.',
      run: (rootPath) => this.gitApi.push(rootPath)
    }
  }

  private get syncSpec(): GitActionExecutionOptions {
    return {
      affectsWorkspaceFiles: true,
      fetchRepoMetadata: true,
      fallbackError: 'Sync에 실패했습니다.',
      run: async (rootPath) => (await this.gitApi.sync(rootPath)).status
    }
  }

  private async executePostCommitRemoteStep(
    ctx: GitRequestContext,
    mode: GitCommitActionMode,
    committedStatus: GitStatus
  ): Promise<void> {
    if (mode === 'commit') {
      return
    }
    if (mode === 'commit-push') {
      await this.executeGitActionBody(ctx, 'Push', {
        ...this.pushSpec,
        fallbackStatusOnFailure: committedStatus
      })
      return
    }
    await this.executeGitActionBody(ctx, 'Sync', {
      ...this.syncSpec,
      fallbackStatusOnFailure: committedStatus,
      onConfirmCanceled: async () => {
        this.updatePanelState({
          errorMessage: '미저장 문서 확인이 취소되어 Sync를 실행하지 않았습니다.'
        })
        await this.applyWorkspaceGitState(ctx, committedStatus, { fetchRepoMetadata: true })
      }
    })
  }

  private initRepo = async (): Promise<void> => {
    await this.runGitAction('Git 초기화', {
      fetchRepoMetadata: true,
      fallbackError: 'Git 저장소를 초기화하지 못했습니다.',
      run: (rootPath) => this.gitApi.init(rootPath)
    })
  }

  private stageFile = async (filePath: string): Promise<void> => {
    await this.runGitAction('Stage', {
      fallbackError: '파일을 Stage하지 못했습니다.',
      run: (rootPath) => this.gitApi.stage(rootPath, [filePath])
    })
  }

  private stageAll = async (): Promise<void> => {
    await this.runGitAction('전체 Stage', this.stageAllSpec)
  }

  private unstageFile = async (filePath: string, origPath?: string): Promise<void> => {
    const targets = origPath ? [filePath, origPath] : [filePath]
    await this.runGitAction('Unstage', {
      fallbackError: '파일을 Unstage하지 못했습니다.',
      run: (rootPath) => this.gitApi.unstage(rootPath, targets)
    })
  }

  private unstageAll = async (): Promise<void> => {
    await this.runGitAction('전체 Unstage', {
      fallbackError: '전체 파일을 Unstage하지 못했습니다.',
      run: (rootPath) => this.gitApi.unstageAll(rootPath)
    })
  }

  private discardFile = async (filePath: string): Promise<void> => {
    await this.runGitAction('변경 사항 롤백', {
      affectsWorkspaceFiles: true,
      fetchRepoMetadata: false,
      bufferMutationTarget: { kind: 'discard-paths', paths: [filePath] },
      fallbackError: '변경 사항을 롤백하지 못했습니다.',
      run: (rootPath) => this.gitApi.discard(rootPath, [filePath])
    })
  }

  private discardAll = async (): Promise<boolean> => {
    const status = this.snapshot.panelState.status
    if (!this.canStartInteractiveAction() || !status) {
      return false
    }
    const trackedCount = status.unstaged.length
    const untrackedCount = status.untracked.length
    if (trackedCount === 0 && untrackedCount === 0) {
      return false
    }

    return this.withMutationLock(async (ctx) => {
      const confirmed = await this.confirm.confirmAction({
        title: '전체 변경 사항 롤백',
        message: buildDiscardAllConfirmMessage(trackedCount, untrackedCount),
        confirmLabel: '전체 롤백',
        confirmTone: 'danger'
      })
      if (!confirmed || !this.isCurrentRequest(ctx)) {
        return false
      }
      const latestStatus = this.snapshot.panelState.status
      const paths = latestStatus ? collectGitUnstagedPaths(latestStatus, true) : []
      return this.executeGitActionBody(ctx, '전체 변경 사항 롤백', {
        affectsWorkspaceFiles: true,
        fetchRepoMetadata: false,
        bufferMutationTarget: { kind: 'discard-all', paths },
        fallbackError: '전체 변경 사항을 롤백하지 못했습니다.',
        run: (rootPath) => this.gitApi.discardAll(rootPath)
      })
    })
  }

  private commit = async (message: string, mode: GitCommitActionMode = 'commit'): Promise<boolean> => {
    const trimmed = message.trim()
    const currentStatus = this.snapshot.panelState.status
    if (!trimmed || currentStatus?.hasConflicts) {
      return false
    }
    const primaryAction = getGitPrimaryActionState(currentStatus)
    const needsAutoStage =
      primaryAction.kind === 'commit' && primaryAction.requiresAutoStageConfirm

    return this.withMutationLock(async (ctx) => {
      if (needsAutoStage) {
        const approved = await this.confirm.confirmAction({
          title: '자동 Stage 후 커밋',
          message:
            '스테이지된 변경 사항이 없습니다. 모든 변경 사항을 자동으로 Stage하고 커밋할까요?',
          confirmLabel: 'Stage 후 커밋'
        })
        if (!approved || !this.isCurrentRequest(ctx)) {
          return false
        }
        const stagedOk = await this.executeGitActionBody(ctx, '전체 Stage', this.stageAllSpec)
        if (!stagedOk || !this.isCurrentRequest(ctx)) {
          return false
        }
      }

      let committedStatus: GitStatus | null = null
      const committedOk = await this.executeGitActionBody(ctx, 'Commit', {
        fetchRepoMetadata: mode === 'commit',
        fallbackError: '커밋에 실패했습니다.',
        run: async (rootPath) => {
          committedStatus = await this.gitApi.commit(rootPath, trimmed)
          return committedStatus
        }
      })
      if (!committedOk || !committedStatus || !this.isCurrentRequest(ctx)) {
        return false
      }

      await this.executePostCommitRemoteStep(ctx, mode, committedStatus)
      return true
    })
  }

  private checkoutBranch = async (branchName: string): Promise<void> => {
    await this.runGitAction('브랜치 전환', {
      affectsWorkspaceFiles: true,
      fetchRepoMetadata: true,
      fallbackError: '브랜치를 전환하지 못했습니다.',
      run: (rootPath) => this.gitApi.checkout(rootPath, branchName)
    })
  }

  private pull = async (): Promise<void> => {
    await this.runGitAction('Pull', {
      affectsWorkspaceFiles: true,
      fetchRepoMetadata: true,
      fallbackError: 'Pull에 실패했습니다.',
      run: (rootPath) => this.gitApi.pull(rootPath)
    })
  }

  private push = async (): Promise<void> => {
    await this.runGitAction('Push', this.pushSpec)
  }

  private fetch = async (): Promise<void> => {
    await this.runGitAction('Fetch', {
      fetchRepoMetadata: true,
      fallbackError: 'Fetch에 실패했습니다.',
      run: (rootPath) => this.gitApi.fetch(rootPath)
    })
  }

  private sync = async (): Promise<void> => {
    await this.runGitAction('Sync', this.syncSpec)
  }

  private openStashDialog = (initialScope: 'unstaged' | 'all' = 'unstaged'): void => {
    const status = this.snapshot.panelState.status
    if (!this.canStartInteractiveAction() || !status || getGitChangedCount(status) === 0) {
      return
    }
    this.updatePanelState({ stashDialogScope: initialScope })
  }

  private closeStashDialog = (): void => {
    if (this.snapshot.panelState.stashDialogScope === null) {
      return
    }
    this.updatePanelState({ stashDialogScope: null })
  }

  private submitStashDialog = async (options: GitStashCreateOptions): Promise<boolean> => {
    this.closeStashDialog()
    return this.stashWithOptions(options)
  }

  private openWorkspaceFile = (repoRelativePath: string): void => {
    const targetPath = this.resolveTargetWorkspacePaths([repoRelativePath])[0]
    if (!targetPath) {
      return
    }
    void this.buffers.openWorkspaceFile(targetPath, getGitFileBaseName(targetPath))
  }

  private toggleSplitFlag(
    key: 'isChangesCollapsed' | 'isStashesCollapsed' | 'isGraphCollapsed'
  ): void {
    const splitState = this.snapshot.panelState.splitState
    this.updatePanelState({
      splitState: {
        ...splitState,
        [key]: !splitState[key]
      }
    })
  }

  private toggleChangesCollapsed = (): void => {
    this.toggleSplitFlag('isChangesCollapsed')
  }

  private toggleStashesCollapsed = (): void => {
    this.toggleSplitFlag('isStashesCollapsed')
  }

  private toggleGraphCollapsed = (): void => {
    this.toggleSplitFlag('isGraphCollapsed')
  }

  private resizeChangesRatio = (nextRatio: number): void => {
    const clamped = clampSectionHeightRatio(nextRatio, ACCORDION_RESET_RATIO)
    const splitState = this.snapshot.panelState.splitState
    if (clamped === splitState.changesHeightRatio) {
      return
    }
    this.updatePanelState({
      splitState: {
        ...splitState,
        changesHeightRatio: clamped
      }
    })
  }

  private toggleChangesViewMode = (): void => {
    const viewState = this.snapshot.panelState.changesViewState
    this.updatePanelState({
      changesViewState: {
        ...viewState,
        viewMode: viewState.viewMode === 'list' ? 'tree' : 'list'
      }
    })
  }

  private toggleChangesGroupCollapsed = (group: GitChangesGroupKey): void => {
    const viewState = this.snapshot.panelState.changesViewState
    this.updatePanelState({
      changesViewState:
        group === 'staged'
          ? { ...viewState, isStagedCollapsed: !viewState.isStagedCollapsed }
          : { ...viewState, isChangesCollapsed: !viewState.isChangesCollapsed }
    })
  }

  private toggleChangesTreeDirCollapsed = (dirKey: string): void => {
    const viewState = this.snapshot.panelState.changesViewState
    const nextDirs = new Set(viewState.collapsedTreeDirs)
    if (nextDirs.has(dirKey)) {
      nextDirs.delete(dirKey)
    } else {
      nextDirs.add(dirKey)
    }
    this.updatePanelState({
      changesViewState: {
        ...viewState,
        collapsedTreeDirs: nextDirs
      }
    })
  }

  private stashWithOptions = async (options: GitStashCreateOptions): Promise<boolean> => {
    const { actionLabel, paths } = resolveStashCreateTarget(
      this.snapshot.panelState.status,
      options
    )
    const succeeded = await this.runGitAction(actionLabel, {
      affectsWorkspaceFiles: true,
      fetchRepoMetadata: false,
      refreshStashes: true,
      bufferMutationTarget: {
        kind: 'stash-create',
        paths
      },
      fallbackError: 'Stash를 생성하지 못했습니다.',
      run: (rootPath) => this.gitApi.stashCreate(rootPath, options)
    })
    if (succeeded && this.active && this.snapshot.panelState.splitState.isStashesCollapsed) {
      this.updatePanelState({
        splitState: {
          ...this.snapshot.panelState.splitState,
          isStashesCollapsed: false
        }
      })
    }
    return succeeded
  }

  private stashChanges = (): Promise<boolean> =>
    this.stashWithOptions({ scope: 'unstaged', includeUntracked: true })

  private stashFile = (filePath: string): Promise<boolean> =>
    this.stashWithOptions({ scope: 'paths', includeUntracked: true, paths: [filePath] })

  private runStashRestore(
    actionLabel: string,
    fallbackError: string,
    run: (rootPath: string) => Promise<GitStatus>
  ): Promise<boolean> {
    return this.runGitAction(actionLabel, {
      affectsWorkspaceFiles: true,
      fetchRepoMetadata: false,
      refreshStashes: true,
      fallbackError,
      run
    })
  }

  private stashApply = (stashRef: string): Promise<boolean> =>
    this.runStashRestore('Stash Apply', 'Stash를 적용하지 못했습니다.', (rootPath) =>
      this.gitApi.stashApply(rootPath, stashRef)
    )

  private stashPop = (stashRef: string): Promise<boolean> =>
    this.runStashRestore('Stash Pop', 'Stash를 복원(Pop)하지 못했습니다.', (rootPath) =>
      this.gitApi.stashPop(rootPath, stashRef)
    )

  private async runConfirmedStashListMutation(
    actionLabel: string,
    fallbackError: string,
    confirmRequest: { title: string; message: string; confirmLabel: string },
    run: (rootPath: string) => Promise<GitStashEntry[]>
  ): Promise<boolean> {
    return this.withMutationLock(async (ctx) => {
      const confirmed = await this.confirm.confirmAction({
        ...confirmRequest,
        confirmTone: 'danger'
      })
      if (!confirmed || !this.isCurrentRequest(ctx)) {
        return false
      }
      this.updatePanelState({ pendingAction: actionLabel })
      try {
        const nextStashes = await run(ctx.rootPath)
        if (!this.isCurrentRequest(ctx)) {
          return false
        }
        this.syncStashesState(nextStashes)
        const nextStatus = await this.gitApi.status(ctx.rootPath).catch(() => null)
        if (nextStatus && this.isCurrentRequest(ctx)) {
          await this.applyWorkspaceGitState(ctx, nextStatus, {
            fetchRepoMetadata: false,
            refreshStashes: false
          })
        }
        return true
      } catch (error: unknown) {
        this.reportGitActionError(ctx, actionLabel, error, fallbackError)
        return false
      }
    })
  }

  private stashDrop = async (stashRef: string): Promise<boolean> => {
    if (!this.canStartInteractiveAction()) {
      return false
    }
    const entry = this.snapshot.panelState.stashes.find((item) => item.ref === stashRef)
    if (!entry) {
      return false
    }
    return this.runConfirmedStashListMutation(
      'Stash Drop',
      'Stash 항목을 삭제하지 못했습니다.',
      {
        title: 'Stash 삭제',
        message: buildStashDropConfirmMessage(entry),
        confirmLabel: 'Drop'
      },
      (rootPath) => this.gitApi.stashDrop(rootPath, stashRef)
    )
  }

  private stashClear = async (): Promise<boolean> => {
    const stashCount = this.snapshot.panelState.stashes.length
    if (!this.canStartInteractiveAction() || stashCount === 0) {
      return false
    }
    return this.runConfirmedStashListMutation(
      'Stash Clear All',
      'Stash 목록을 비우지 못했습니다.',
      {
        title: '모든 Stash 삭제',
        message: buildStashClearConfirmMessage(stashCount),
        confirmLabel: 'Clear All'
      },
      (rootPath) => this.gitApi.stashClear(rootPath)
    )
  }
}
