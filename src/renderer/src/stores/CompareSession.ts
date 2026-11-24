import { toErrorMessage } from '@shared/errors'
import type {
  GitCompareChangedFile,
  GitCompareMode,
  GitCompareRef,
  GitCompareRefList,
  GitCompareSummary,
  GitDiffRequest
} from '@shared/git'
import type { WikiGitApi } from '@shared/ipc'
import {
  buildCompressedGitFileTree,
  flattenGitFileTreeFiles
} from '../utils/gitFileTree'

export interface ComparePanelState {
  workspaceRootPath: string | null
  refs: GitCompareRefList | null
  baseRef: string | null
  compareRef: string | null
  mode: GitCompareMode
  fileFilter: string
  collapsedTreeDirs: ReadonlySet<string>
  summary: GitCompareSummary | null
  isLoadingRefs: boolean
  isLoadingSummary: boolean
  errorMessage: string | null
}

function createDefaultComparePanelState(workspaceRootPath: string | null = null): ComparePanelState {
  return {
    workspaceRootPath,
    refs: null,
    baseRef: null,
    compareRef: null,
    mode: 'three-dot',
    fileFilter: '',
    collapsedTreeDirs: new Set(),
    summary: null,
    isLoadingRefs: false,
    isLoadingSummary: false,
    errorMessage: null
  }
}

export interface CompareDiffTabsCollaborator {
  openDiffTab(request: GitDiffRequest): void
  reconcileBranchCompareDiffTabs(
    baseRef: string,
    compareRef: string,
    mode: GitCompareMode,
    files: readonly GitCompareChangedFile[]
  ): void
}

export interface CompareSessionOptions {
  gitApi: Pick<WikiGitApi, 'compareRefs' | 'compareSummary'>
  diffTabs: CompareDiffTabsCollaborator
  workspaceRootPath?: string | null
}

export interface ComparePanelActions {
  selectBaseRef: (ref: string) => void
  selectCompareRef: (ref: string) => void
  swapRefs: () => void
  setMode: (mode: GitCompareMode) => void
  setFileFilter: (filter: string) => void
  toggleTreeDirCollapsed: (dirKey: string) => void
  refresh: () => Promise<void>
  openCompareFileDiff: (file: GitCompareChangedFile) => void
  dismissError: () => void
}

/**
 * Filters compare files by substring match against `path` or `origPath`.
 */
export function filterCompareFiles(
  files: readonly GitCompareChangedFile[],
  filter: string
): GitCompareChangedFile[] {
  const normalized = filter.trim().toLowerCase()
  if (!normalized) {
    return [...files]
  }
  return files.filter(
    (file) =>
      file.path.toLowerCase().includes(normalized) ||
      (file.origPath?.toLowerCase().includes(normalized) ?? false)
  )
}

/**
 * Returns visible compare files in the exact depth-first visual order of the compressed folder tree.
 */
export function getOrderedVisibleCompareFiles(
  files: readonly GitCompareChangedFile[],
  filter: string
): GitCompareChangedFile[] {
  const filtered = filterCompareFiles(files, filter)
  return flattenGitFileTreeFiles(buildCompressedGitFileTree(filtered))
}

/**
 * Finds the matching `GitCompareRef` metadata for a selected ref string.
 */
export function findCompareRefOption(
  refs: GitCompareRefList | null,
  refValue: string | null
): GitCompareRef | null {
  if (!refs || !refValue) {
    return null
  }
  const all = [...refs.worktrees, ...refs.localBranches, ...refs.remoteBranches]
  return all.find((item) => item.ref === refValue) ?? null
}

/**
 * Session-scoped store for the Compare view: manages Base/Compare ref selection,
 * 3-dot/2-dot comparison mode, Files filter/tree collapse state, and summary loading.
 * State persists across sidebar view switches/collapses and resets on workspace change.
 */
export class CompareSession {
  private readonly gitApi: Pick<WikiGitApi, 'compareRefs' | 'compareSummary'>
  private readonly diffTabs: CompareDiffTabsCollaborator
  private readonly listeners = new Set<() => void>()

  private state: ComparePanelState
  private workspaceEpoch = 0
  private refsSeq = 0
  private summarySeq = 0
  private isRepo: boolean | null = null

  readonly actions: ComparePanelActions

  constructor(options: CompareSessionOptions) {
    this.gitApi = options.gitApi
    this.diffTabs = options.diffTabs
    this.state = createDefaultComparePanelState(options.workspaceRootPath ?? null)
    this.actions = {
      selectBaseRef: this.selectBaseRef,
      selectCompareRef: this.selectCompareRef,
      swapRefs: this.swapRefs,
      setMode: this.setMode,
      setFileFilter: this.setFileFilter,
      toggleTreeDirCollapsed: this.toggleTreeDirCollapsed,
      refresh: this.refresh,
      openCompareFileDiff: this.openCompareFileDiff,
      dismissError: this.dismissError
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): ComparePanelState => this.state

  setWorkspaceContext(nextRootPath: string | null, nextIsRepo: boolean | null): void {
    const rootChanged = this.state.workspaceRootPath !== nextRootPath
    const repoChanged = this.isRepo !== nextIsRepo

    if (rootChanged) {
      this.workspaceEpoch += 1
      this.refsSeq = 0
      this.summarySeq = 0
      this.isRepo = nextIsRepo
      this.commitState(createDefaultComparePanelState(nextRootPath))
      if (nextRootPath && nextIsRepo === true) {
        void this.loadRefsAndSummary(true)
      }
      return
    }

    if (repoChanged) {
      this.isRepo = nextIsRepo
      if (nextRootPath && nextIsRepo === true) {
        if (!this.state.refs && !this.state.isLoadingRefs) {
          void this.loadRefsAndSummary(true)
        } else if (
          !this.state.summary &&
          !this.state.isLoadingSummary &&
          this.state.baseRef &&
          this.state.compareRef
        ) {
          void this.loadSummary(this.state.baseRef, this.state.compareRef, this.state.mode, true)
        }
      } else if (nextIsRepo === false) {
        this.workspaceEpoch += 1
        this.commitState(createDefaultComparePanelState(nextRootPath))
      }
    }
  }

  private commitState(nextState: ComparePanelState): void {
    this.state = nextState
    for (const listener of this.listeners) {
      listener()
    }
  }

  private updateState(patch: Partial<ComparePanelState>): void {
    this.commitState({
      ...this.state,
      ...patch
    })
  }

  private dismissError = (): void => {
    this.updateState({ errorMessage: null })
  }

  private setFileFilter = (fileFilter: string): void => {
    this.updateState({ fileFilter })
  }

  private toggleTreeDirCollapsed = (dirKey: string): void => {
    const next = new Set(this.state.collapsedTreeDirs)
    if (next.has(dirKey)) {
      next.delete(dirKey)
    } else {
      next.add(dirKey)
    }
    this.updateState({ collapsedTreeDirs: next })
  }

  private selectBaseRef = (baseRef: string): void => {
    if (baseRef === this.state.baseRef) return
    this.updateState({ baseRef, errorMessage: null })
    void this.loadSummary(baseRef, this.state.compareRef, this.state.mode, true)
  }

  private selectCompareRef = (compareRef: string): void => {
    if (compareRef === this.state.compareRef) return
    this.updateState({ compareRef, errorMessage: null })
    void this.loadSummary(this.state.baseRef, compareRef, this.state.mode, true)
  }

  private swapRefs = (): void => {
    const { baseRef, compareRef, mode } = this.state
    if (!baseRef || !compareRef) return
    this.updateState({ baseRef: compareRef, compareRef: baseRef, errorMessage: null })
    void this.loadSummary(compareRef, baseRef, mode, true)
  }

  private setMode = (mode: GitCompareMode): void => {
    if (mode === this.state.mode) return
    this.updateState({ mode, errorMessage: null })
    void this.loadSummary(this.state.baseRef, this.state.compareRef, mode, true)
  }

  private refresh = async (): Promise<void> => {
    await this.loadRefsAndSummary(true)
  }

  private openCompareFileDiff = (file: GitCompareChangedFile): void => {
    const { baseRef, compareRef, mode } = this.state
    if (!baseRef || !compareRef) return
    this.diffTabs.openDiffTab({
      kind: 'branch-compare',
      baseRef,
      compareRef,
      mode,
      path: file.path,
      ...(file.origPath ? { origPath: file.origPath } : {}),
      status: file.status
    })
  }

  private async loadRefsAndSummary(reconcileDiffTabs: boolean): Promise<void> {
    const rootPath = this.state.workspaceRootPath
    if (!rootPath || this.isRepo !== true) return

    const epoch = this.workspaceEpoch
    const seq = ++this.refsSeq
    this.updateState({ isLoadingRefs: true, errorMessage: null })

    try {
      const refs = await this.gitApi.compareRefs(rootPath)
      if (this.workspaceEpoch !== epoch || this.refsSeq !== seq) return

      const nextBaseRef = this.state.baseRef ?? refs.defaultBaseRef ?? refs.currentRef
      const nextCompareRef = this.state.compareRef ?? refs.currentRef ?? refs.defaultBaseRef
      this.updateState({
        refs,
        baseRef: nextBaseRef,
        compareRef: nextCompareRef,
        isLoadingRefs: false
      })

      if (nextBaseRef && nextCompareRef) {
        await this.loadSummary(nextBaseRef, nextCompareRef, this.state.mode, reconcileDiffTabs)
      }
    } catch (error: unknown) {
      if (this.workspaceEpoch !== epoch || this.refsSeq !== seq) return
      this.updateState({
        isLoadingRefs: false,
        errorMessage: toErrorMessage(error, '비교 Ref 목록을 불러오지 못했습니다.')
      })
    }
  }

  private async loadSummary(
    baseRef: string | null,
    compareRef: string | null,
    mode: GitCompareMode,
    reconcileDiffTabs: boolean
  ): Promise<void> {
    const rootPath = this.state.workspaceRootPath
    if (!rootPath || this.isRepo !== true || !baseRef || !compareRef) return

    const epoch = this.workspaceEpoch
    const seq = ++this.summarySeq
    this.updateState({ isLoadingSummary: true, errorMessage: null })

    try {
      const summary = await this.gitApi.compareSummary(rootPath, {
        baseRef,
        compareRef,
        mode
      })
      if (this.workspaceEpoch !== epoch || this.summarySeq !== seq) return

      this.updateState({
        summary,
        isLoadingSummary: false
      })

      if (reconcileDiffTabs) {
        this.diffTabs.reconcileBranchCompareDiffTabs(baseRef, compareRef, mode, summary.files)
      }
    } catch (error: unknown) {
      if (this.workspaceEpoch !== epoch || this.summarySeq !== seq) return
      this.updateState({
        isLoadingSummary: false,
        errorMessage: toErrorMessage(error, '브랜치 비교 결과를 불러오지 못했습니다.')
      })
    }
  }
}
