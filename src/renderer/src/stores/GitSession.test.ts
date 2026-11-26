import { describe, expect, it, vi } from 'vitest'
import {
  createEmptyGitStatus,
  type GitCommitDetail,
  type GitDiffRequest,
  type GitFileDiff,
  type GitGraphCommit,
  type GitStashCreateOptions,
  type GitStashDetail,
  type GitStashEntry,
  type GitStatus
} from '@shared/git'
import type { WikiGitApi } from '@shared/ipc'
import { formatGitDiffTabKey } from '../utils/gitFilePresentation'
import {
  computeGitSectionLayout,
  GitSession,
  type GitBufferCollaborator,
  type GitConfirmCollaborator,
  type GitDiffTabsCollaborator
} from './GitSession'
import { PaneTabStore } from './PaneTabStore'

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function makeStatus(branch: string, ahead = 0, repoRoot = 'C:/wiki'): GitStatus {
  return {
    ...createEmptyGitStatus(true, repoRoot),
    branch,
    hasUpstream: true,
    ahead
  }
}

function makeCommit(hash: string): GitGraphCommit {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    parents: [],
    subject: `commit ${hash}`,
    authorName: 'Tester',
    committedAt: '2026-11-15T12:00:00+09:00',
    refs: []
  }
}

function makeCommitDetail(hash: string): GitCommitDetail {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    parents: [],
    subject: `commit ${hash}`,
    body: `Detail body for ${hash}`,
    authorName: 'Tester',
    authorEmail: 'tester@example.com',
    committedAt: '2026-11-15T12:00:00+09:00',
    files: [{ path: `${hash}.md`, status: 'A' }]
  }
}

function createTestGitApi(overrides: Partial<WikiGitApi> = {}): WikiGitApi {
  return {
    status: vi.fn(async (ws) => makeStatus('main', 0, ws)),
    init: vi.fn(async (ws) => makeStatus('main', 0, ws)),
    stage: vi.fn(async (ws) => makeStatus('main', 0, ws)),
    stageAll: vi.fn(async (ws) => makeStatus('main', 0, ws)),
    unstage: vi.fn(async (ws) => makeStatus('main', 0, ws)),
    unstageAll: vi.fn(async (ws) => makeStatus('main', 0, ws)),
    discard: vi.fn(async (ws) => makeStatus('main', 0, ws)),
    discardAll: vi.fn(async (ws) => makeStatus('main', 0, ws)),
    commit: vi.fn(async (ws) => makeStatus('main', 0, ws)),
    branches: vi.fn(async () => ({ current: 'main', isDetached: false, branches: [] })),
    checkout: vi.fn(async (ws) => makeStatus('main', 0, ws)),
    pull: vi.fn(async (ws) => makeStatus('main', 0, ws)),
    push: vi.fn(async (ws) => makeStatus('main', 0, ws)),
    fetch: vi.fn(async (ws) => makeStatus('main', 0, ws)),
    sync: vi.fn(async (ws) => ({
      status: makeStatus('main', 0, ws),
      pulled: true,
      pushed: true,
      summary: 'ok'
    })),
    log: vi.fn(async () => ({ commits: [], hasMore: false })),
    commitDetail: vi.fn(async (_ws, hash) => makeCommitDetail(hash)),
    diff: vi.fn(async (_ws, req: GitDiffRequest) => ({
      path: req.path,
      ...(req.origPath ? { origPath: req.origPath } : {}),
      status: req.status,
      isBinary: false,
      isTruncated: false,
      existsInWorkspace: true,
      rawPatch: ''
    })),
    compareRefs: vi.fn(async () => ({
      defaultBaseRef: 'main',
      currentRef: 'main',
      worktrees: [],
      localBranches: [],
      remoteBranches: []
    })),
    compareSummary: vi.fn(async (_ws, req) => ({
      baseRef: req.baseRef,
      compareRef: req.compareRef,
      mode: req.mode,
      mergeBaseHash: null,
      totalAdditions: 0,
      totalDeletions: 0,
      files: [],
      commits: []
    })),
    stashList: vi.fn(async () => []),
    stashDetail: vi.fn(async (_ws, ref) => ({
      ref,
      hash: '0000000000000000000000000000000000000000',
      branch: null,
      message: '',
      createdAt: '',
      files: []
    })),
    stashCreate: vi.fn(async (ws) => makeStatus('main', 0, ws)),
    stashApply: vi.fn(async (ws) => makeStatus('main', 0, ws)),
    stashPop: vi.fn(async (ws) => makeStatus('main', 0, ws)),
    stashDrop: vi.fn(async () => []),
    stashClear: vi.fn(async () => []),
    ...overrides
  }
}

function createStubDiffTabs(): GitDiffTabsCollaborator {
  return {
    listOpenRequests: vi.fn(() => []),
    subscribe: vi.fn(() => () => undefined),
    openDiffTab: vi.fn(),
    closeAllUnstagedDiffTabs: vi.fn(),
    closeUnstagedDiffTabsForPaths: vi.fn(),
    closeUnstagedDiffTabsExcept: vi.fn(),
    closeStagedDiffTabsExcept: vi.fn(),
    reconcileStashDiffTabs: vi.fn()
  }
}

function createStubBuffers(overrides: Partial<GitBufferCollaborator> = {}): GitBufferCollaborator {
  return {
    getDirtySummary: vi.fn(() => null),
    saveDirtyBuffers: vi.fn(async () => true),
    prepareDiscardPaths: vi.fn(async () => undefined),
    finishDiscardPaths: vi.fn(async () => undefined),
    reconcileWithDisk: vi.fn(async () => []),
    openWorkspaceFile: vi.fn(),
    ...overrides
  }
}

function createStubConfirm(overrides: Partial<GitConfirmCollaborator> = {}): GitConfirmCollaborator {
  return {
    confirmAction: vi.fn(async () => true),
    confirmUnsavedChanges: vi.fn(async () => true),
    isDialogOpen: vi.fn(() => false),
    ...overrides
  }
}

function createPaneTabDiffAdapter(tabStore: PaneTabStore): GitDiffTabsCollaborator {
  return {
    listOpenRequests: tabStore.listOpenDiffRequests,
    subscribe: tabStore.subscribe,
    openDiffTab: (request) => tabStore.openDiffTab(request),
    closeAllUnstagedDiffTabs: tabStore.closeAllUnstagedDiffTabs,
    closeUnstagedDiffTabsForPaths: tabStore.closeUnstagedDiffTabsForPaths,
    closeUnstagedDiffTabsExcept: tabStore.closeUnstagedDiffTabsExcept,
    closeStagedDiffTabsExcept: tabStore.closeStagedDiffTabsExcept,
    reconcileStashDiffTabs: tabStore.reconcileStashDiffTabs
  }
}

async function flushAsync(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('GitSession', () => {
  it('loads workspace Git state, handles non-repo init, skips watcher refresh while mutating, and discards stale responses across workspace switches', async () => {
    const firstStatus = createDeferred<GitStatus>()
    const pullDeferred = createDeferred<GitStatus>()
    let isRepo = false
    const statusMock = vi
      .fn<(ws: string) => Promise<GitStatus>>()
      .mockImplementationOnce(() => firstStatus.promise)
      .mockImplementation(async (ws) =>
        isRepo ? makeStatus('main', 0, ws) : createEmptyGitStatus(false, ws)
      )
    const initMock = vi.fn(async (ws: string) => {
      isRepo = true
      return makeStatus('main', 0, ws)
    })
    const pullMock = vi.fn(() => pullDeferred.promise)

    const gitApi = createTestGitApi({
      status: statusMock,
      init: initMock,
      pull: pullMock,
      branches: vi.fn(async () => ({
        current: 'main',
        isDetached: false,
        branches: [{ name: 'main', current: true, upstream: 'origin/main' }]
      }))
    })
    const refreshTree = vi.fn(async () => undefined)
    const buffers = createStubBuffers()

    const session = new GitSession({
      gitApi,
      buffers,
      diffTabs: createStubDiffTabs(),
      confirm: createStubConfirm(),
      refreshTree,
      workspaceRootPath: 'C:/repo-a'
    })

    // Switch to repo-b before repo-a status resolves -> stale repo-a response ignored
    session.setWorkspaceRootPath('C:/repo-b')
    await flushAsync()
    expect(session.getSnapshot().panelState.status?.isRepo).toBe(false)

    firstStatus.resolve(makeStatus('stale-a', 9, 'C:/repo-a'))
    await flushAsync()
    expect(session.getSnapshot().panelState.status?.isRepo).toBe(false)
    expect(session.getSnapshot().panelState.workspaceRootPath).toBe('C:/repo-b')

    // Initialize non-repo workspace
    await session.actions.initRepo()
    expect(initMock).toHaveBeenCalledWith('C:/repo-b')
    expect(session.getSnapshot().panelState.status?.isRepo).toBe(true)
    expect(session.getSnapshot().panelState.branchList?.current).toBe('main')

    // Start Pull (mutating lock active) -> concurrent refreshStatus must be skipped
    const pullPromise = session.actions.pull()
    await flushAsync()
    expect(session.getSnapshot().isMutating).toBe(true)
    expect(session.getSnapshot().panelState.pendingAction).toBe('Pull')

    const statusCallsBeforeWatcher = statusMock.mock.calls.length
    await session.actions.refreshStatus()
    expect(statusMock.mock.calls.length).toBe(statusCallsBeforeWatcher)

    pullDeferred.resolve(makeStatus('feature', 2, 'C:/repo-b'))
    await pullPromise
    expect(session.getSnapshot().isMutating).toBe(false)
    expect(session.getSnapshot().panelState.pendingAction).toBeNull()
    expect(session.getSnapshot().panelState.status?.branch).toBe('feature')
    expect(refreshTree).toHaveBeenCalledTimes(1)
    expect(buffers.reconcileWithDisk).toHaveBeenCalledTimes(1)

    session.dispose()
  })

  it('manages Graph scope switching, paginated deduplication, and inline commit/stash single-expand detail with stale drop and prune', async () => {
    const commit1 = makeCommit('1111111111111111111111111111111111111111')
    const commit2 = makeCommit('2222222222222222222222222222222222222222')
    const commit3 = makeCommit('3333333333333333333333333333333333333333')
    const stash0: GitStashEntry = {
      ref: 'stash@{0}',
      hash: 'aaaa000000000000000000000000000000000000',
      branch: 'main',
      message: 'first stash',
      createdAt: '2026-11-20T10:00:00Z'
    }
    const stash1: GitStashEntry = {
      ref: 'stash@{1}',
      hash: 'bbbb000000000000000000000000000000000000',
      branch: 'main',
      message: 'second stash',
      createdAt: '2026-11-20T09:00:00Z'
    }
    const delayedCommitDetail = createDeferred<GitCommitDetail>()
    const delayedStashDetail = createDeferred<GitStashDetail>()

    let currentStashes: GitStashEntry[] = [stash0, stash1]
    let failStash1Detail = true

    const gitApi = createTestGitApi({
      log: vi.fn(async (_ws, options) => {
        if (options?.scope === 'current') {
          if ((options.skip ?? 0) === 0) {
            return { commits: [commit1], hasMore: true }
          }
          // Include overlapping commit1 to verify deduplication
          return { commits: [commit1, commit3], hasMore: false }
        }
        return { commits: [commit1, commit2], hasMore: false }
      }),
      commitDetail: vi.fn((_ws, hash) =>
        hash === commit1.hash ? delayedCommitDetail.promise : Promise.resolve(makeCommitDetail(hash))
      ),
      stashList: vi.fn(async () => currentStashes),
      stashDetail: vi.fn(async (_ws, stashRef) => {
        if (stashRef === stash0.ref) {
          return delayedStashDetail.promise
        }
        if (failStash1Detail) {
          throw new Error('Stash 상세 조회 실패')
        }
        return { ...stash1, files: [{ path: 'notes.md', status: 'M' as const }] }
      })
    })

    const session = new GitSession({
      gitApi,
      buffers: createStubBuffers(),
      diffTabs: createStubDiffTabs(),
      confirm: createStubConfirm(),
      refreshTree: vi.fn(async () => undefined),
      workspaceRootPath: 'C:/wiki'
    })
    await flushAsync()

    expect(session.getSnapshot().panelState.graphState.commits.map((c) => c.hash)).toEqual([
      commit1.hash,
      commit2.hash
    ])
    expect(session.getSnapshot().panelState.stashes).toEqual([stash0, stash1])

    // Switch scope to 'current' & paginate with dedupe
    await session.actions.changeLogScope('current')
    expect(session.getSnapshot().panelState.graphState.scope).toBe('current')
    expect(session.getSnapshot().panelState.graphState.hasMore).toBe(true)

    await session.actions.loadMoreCommits()
    expect(session.getSnapshot().panelState.graphState.commits.map((c) => c.hash)).toEqual([
      commit1.hash,
      commit3.hash
    ])
    expect(session.getSnapshot().panelState.graphState.hasMore).toBe(false)

    // Inline commit detail: stale first response ignored when switching to commit3, then click commit3 again collapses
    const pCommit1 = session.actions.toggleCommitDetail(commit1.hash)
    await session.actions.toggleCommitDetail(commit3.hash)
    expect(session.getSnapshot().panelState.graphState.commitDetail).toEqual({
      status: 'loaded',
      selectedHash: commit3.hash,
      detail: makeCommitDetail(commit3.hash)
    })

    delayedCommitDetail.resolve(makeCommitDetail(commit1.hash))
    await pCommit1
    expect(session.getSnapshot().panelState.graphState.commitDetail.status).toBe('loaded')
    expect(session.getSnapshot().panelState.graphState.commitDetail).toMatchObject({
      selectedHash: commit3.hash
    })

    await session.actions.toggleCommitDetail(commit3.hash)
    expect(session.getSnapshot().panelState.graphState.commitDetail).toEqual({ status: 'idle' })

    // Inline stash detail: stale drop, error state, loaded, then pruned when entry disappears on refresh
    const pStash0 = session.actions.toggleStashDetail(stash0)
    await session.actions.toggleStashDetail(stash1)
    expect(session.getSnapshot().panelState.stashDetail).toEqual({
      status: 'error',
      selectedHash: stash1.hash,
      errorMessage: 'Stash 상세 조회 실패'
    })
    delayedStashDetail.resolve({ ...stash0, files: [] })
    await pStash0
    expect(session.getSnapshot().panelState.stashDetail).toMatchObject({
      status: 'error',
      selectedHash: stash1.hash
    })

    // Collapse error & reload cleanly
    await session.actions.toggleStashDetail(stash1)
    expect(session.getSnapshot().panelState.stashDetail).toEqual({ status: 'idle' })

    failStash1Detail = false
    await session.actions.toggleStashDetail(stash1)
    expect(session.getSnapshot().panelState.stashDetail.status).toBe('loaded')

    // Prune stash1 when refresh removes it
    currentStashes = [stash0]
    await session.actions.refreshStatus()
    expect(session.getSnapshot().panelState.stashDetail).toEqual({ status: 'idle' })

    session.dispose()
  })

  it('handles stage/unstage, commit auto-stage confirm, Commit & Push / Sync compound flows, and fetch vs checkout/sync dirty guards', async () => {
    const baseStatus = makeStatus('main', 0)
    const unstagedOnly: GitStatus = {
      ...baseStatus,
      unstaged: [{ path: 'note.md', status: 'M' }]
    }
    const stagedStatus: GitStatus = {
      ...baseStatus,
      staged: [{ path: 'note.md', status: 'M' }]
    }
    const committedStatus: GitStatus = makeStatus('main', 1)
    const syncedStatus: GitStatus = makeStatus('main', 0)

    let phase: 'unstaged' | 'staged' | 'committed' = 'unstaged'
    const callOrder: string[] = []
    let failPush = false
    let syncProceed = false

    const stageMock = vi.fn(async () => stagedStatus)
    const unstageMock = vi.fn(async () => unstagedOnly)
    const stageAllMock = vi.fn(async () => {
      callOrder.push('stageAll')
      phase = 'staged'
      return stagedStatus
    })
    const commitMock = vi.fn(async () => {
      callOrder.push('commit')
      phase = 'committed'
      return committedStatus
    })
    const pushMock = vi.fn(async () => {
      callOrder.push('push')
      if (failPush) {
        throw new Error('Push rejected')
      }
      return syncedStatus
    })
    const syncMock = vi.fn(async () => {
      callOrder.push('sync')
      return { status: syncedStatus, pulled: true, pushed: true, summary: 'done' }
    })
    const fetchMock = vi.fn(async () => ({ ...stagedStatus, behind: 2 }))
    const checkoutMock = vi.fn(async (_ws: string, branch: string) => makeStatus(branch))

    const gitApi = createTestGitApi({
      status: vi.fn(async () =>
        phase === 'unstaged' ? unstagedOnly : phase === 'staged' ? stagedStatus : committedStatus
      ),
      stage: stageMock,
      unstage: unstageMock,
      stageAll: stageAllMock,
      commit: commitMock,
      push: pushMock,
      sync: syncMock,
      fetch: fetchMock,
      checkout: checkoutMock,
      log: vi.fn(async () => ({
        commits: phase === 'committed' ? [makeCommit('abc1111')] : [],
        hasMore: false
      }))
    })

    let confirmActionApproved = false
    const confirmAction = vi.fn(async () => confirmActionApproved)
    const confirmUnsavedChanges = vi.fn(async () => syncProceed)
    const buffers = createStubBuffers({
      getDirtySummary: vi.fn(() => 'note.md'),
      reconcileWithDisk: vi.fn(async () => ['외부 충돌 경고'])
    })
    const refreshTree = vi.fn(async () => undefined)

    const session = new GitSession({
      gitApi,
      buffers,
      diffTabs: createStubDiffTabs(),
      confirm: { confirmAction, confirmUnsavedChanges, isDialogOpen: () => false },
      refreshTree,
      workspaceRootPath: 'C:/wiki'
    })
    await flushAsync()

    // 1. stageFile / unstageFile (origPath forwarding) skip dirty confirm & tree refresh
    await session.actions.stageFile?.('note.md')
    expect(stageMock).toHaveBeenCalledWith('C:/wiki', ['note.md'])
    await session.actions.unstageFile?.('new.md', 'old.md')
    expect(unstageMock).toHaveBeenCalledWith('C:/wiki', ['new.md', 'old.md'])
    expect(confirmUnsavedChanges).not.toHaveBeenCalled()
    expect(refreshTree).not.toHaveBeenCalled()

    // 2. fetch skips dirty confirm & tree refresh
    await session.actions.fetch?.()
    expect(fetchMock).toHaveBeenCalledWith('C:/wiki')
    expect(confirmUnsavedChanges).not.toHaveBeenCalled()
    expect(session.getSnapshot().panelState.status?.behind).toBe(2)

    // 3. Auto-stage commit cancel aborts cleanly
    phase = 'unstaged'
    await session.actions.refreshStatus()
    await expect(session.actions.commit?.('feat: blocked', 'commit')).resolves.toBe(false)
    expect(confirmAction).toHaveBeenCalledWith({
      title: '자동 Stage 후 커밋',
      message: '스테이지된 변경 사항이 없습니다. 모든 변경 사항을 자동으로 Stage하고 커밋할까요?',
      confirmLabel: 'Stage 후 커밋'
    })
    expect(stageAllMock).not.toHaveBeenCalled()
    expect(commitMock).not.toHaveBeenCalled()

    // 4. Approved auto-stage Commit & Sync where Sync dirty confirm is canceled -> commit returns true, graph updates, Sync error shown
    confirmActionApproved = true
    syncProceed = false
    await expect(session.actions.commit?.('feat: commit ok sync cancel', 'commit-sync')).resolves.toBe(
      true
    )
    expect(callOrder).toEqual(['stageAll', 'commit'])
    expect(syncMock).not.toHaveBeenCalled()
    expect(session.getSnapshot().panelState.errorMessage).toMatch(/Sync/)
    expect(session.getSnapshot().panelState.graphState.commits.map((c) => c.hash)).toEqual(['abc1111'])

    // 5. Commit & Push where Push fails -> commit returns true, Push error surfaced
    phase = 'staged'
    failPush = true
    await session.actions.refreshStatus()
    await expect(session.actions.commit?.('feat: push fails', 'commit-push')).resolves.toBe(true)
    expect(session.getSnapshot().panelState.errorMessage).toBe('Push rejected')

    // 6. checkoutBranch runs dirty confirm (full workspace), tree refresh, and surfaces reconcile warnings
    syncProceed = true
    await session.actions.checkoutBranch?.('docs-v2')
    expect(buffers.getDirtySummary).toHaveBeenLastCalledWith(undefined)
    expect(checkoutMock).toHaveBeenCalledWith('C:/wiki', 'docs-v2')
    expect(refreshTree).toHaveBeenCalledTimes(1)
    expect(session.getSnapshot().panelState.errorMessage).toBe('외부 충돌 경고')

    session.dispose()
  })

  it('encapsulates subfolder repo path resolution, discard brackets, danger confirms, stash create/restore/drop/clear, and finally bracket cleanup', async () => {
    const repoRoot = 'C:/repo'
    const workspaceRoot = 'C:/repo/wiki'
    const initialStatus: GitStatus = {
      ...makeStatus('main', 0, repoRoot),
      staged: [{ path: 'wiki/staged.md', status: 'M' }],
      unstaged: [
        { path: 'wiki/notes.md', status: 'M' },
        { path: 'outside/ext.md', status: 'M' }
      ],
      untracked: [{ path: 'wiki/draft.md', status: '?' }]
    }
    const afterDiscardAllStatus: GitStatus = {
      ...makeStatus('main', 0, repoRoot),
      staged: [{ path: 'wiki/staged.md', status: 'M' }]
    }
    const stash0: GitStashEntry = {
      ref: 'stash@{0}',
      hash: '1111111111111111111111111111111111111111',
      branch: 'main',
      message: 'wip',
      createdAt: '2026-11-20T12:00:00Z'
    }

    let currentStatus = initialStatus
    let currentStashes: GitStashEntry[] = []
    const prepareDeferred = createDeferred<void>()

    const discardMock = vi.fn(async () => ({
      ...currentStatus,
      unstaged: currentStatus.unstaged.filter((i) => i.path !== 'wiki/notes.md')
    }))
    const discardAllMock = vi.fn(async () => afterDiscardAllStatus)
    const stashCreateMock = vi.fn(async (_ws: string, opts: GitStashCreateOptions) => {
      currentStashes = [stash0]
      return {
        ...makeStatus('main', 0, repoRoot),
        staged: opts.scope === 'all' ? [] : initialStatus.staged,
        unstaged: [],
        untracked: opts.includeUntracked === false ? initialStatus.untracked : []
      }
    })
    const stashPopMock = vi.fn(async () => {
      throw new Error('병합 충돌(Conflict)이 발생했습니다.')
    })
    const stashDropMock = vi.fn(async () => {
      currentStashes = []
      return currentStashes
    })
    const stashClearMock = vi.fn(async () => {
      currentStashes = []
      return currentStashes
    })

    let dangerApproved = false
    const confirmAction = vi.fn(async () => dangerApproved)
    const confirmUnsavedChanges = vi.fn(async () => true)
    const getDirtySummary = vi.fn((paths?: readonly string[]) =>
      paths && paths.length > 0 ? paths.join(',') : null
    )
    const saveDirtyBuffers = vi.fn(async () => true)
    const prepareDiscardPaths = vi.fn(async (): Promise<void> => {})
    const finishDiscardPaths = vi.fn(async (): Promise<void> => {})
    const diffTabs = createStubDiffTabs()
    const refreshTree = vi.fn(async () => undefined)

    const session = new GitSession({
      gitApi: createTestGitApi({
        status: vi.fn(async () => currentStatus),
        discard: discardMock,
        discardAll: discardAllMock,
        stashList: vi.fn(async () => currentStashes),
        stashCreate: stashCreateMock,
        stashPop: stashPopMock,
        stashDrop: stashDropMock,
        stashClear: stashClearMock
      }),
      buffers: createStubBuffers({
        getDirtySummary,
        saveDirtyBuffers,
        prepareDiscardPaths,
        finishDiscardPaths
      }),
      diffTabs,
      confirm: { confirmAction, confirmUnsavedChanges, isDialogOpen: () => false },
      refreshTree,
      workspaceRootPath: workspaceRoot
    })
    await flushAsync()

    // 1. discardFile('outside/ext.md') skips buffer dirty prompt & discard bracket (outside workspace)
    await session.actions.discardFile?.('outside/ext.md')
    expect(getDirtySummary).toHaveBeenLastCalledWith([])
    expect(prepareDiscardPaths).not.toHaveBeenCalled()
    expect(finishDiscardPaths).not.toHaveBeenCalled()
    expect(diffTabs.closeUnstagedDiffTabsForPaths).toHaveBeenCalledWith(['outside/ext.md'])

    // 2. discardFile('wiki/notes.md') scopes dirty prompt & discard bracket to C:\repo\wiki\notes.md
    await session.actions.discardFile?.('wiki/notes.md')
    expect(getDirtySummary).toHaveBeenLastCalledWith(['C:/repo/wiki/notes.md'])
    expect(prepareDiscardPaths).toHaveBeenLastCalledWith(['C:/repo/wiki/notes.md'])
    expect(finishDiscardPaths).toHaveBeenLastCalledWith(['C:/repo/wiki/notes.md'], true)
    expect(diffTabs.closeUnstagedDiffTabsForPaths).toHaveBeenLastCalledWith(['wiki/notes.md'])

    // 3. discardAll: canceled danger confirm aborts cleanly; approved runs danger -> scoped dirty prompt -> bracket -> closes all unstaged diffs
    currentStatus = initialStatus
    await session.actions.refreshStatus()
    await expect(session.actions.discardAll?.()).resolves.toBe(false)
    expect(confirmAction).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: '전체 변경 사항 롤백',
        confirmLabel: '전체 롤백',
        confirmTone: 'danger'
      })
    )
    expect(discardAllMock).not.toHaveBeenCalled()

    dangerApproved = true
    await expect(session.actions.discardAll?.()).resolves.toBe(true)
    expect(getDirtySummary).toHaveBeenLastCalledWith([
      'C:/repo/wiki/notes.md',
      'C:/repo/wiki/draft.md'
    ])
    expect(prepareDiscardPaths).toHaveBeenLastCalledWith([
      'C:/repo/wiki/notes.md',
      'C:/repo/wiki/draft.md'
    ])
    expect(finishDiscardPaths).toHaveBeenLastCalledWith(
      ['C:/repo/wiki/notes.md', 'C:/repo/wiki/draft.md'],
      true
    )
    expect(diffTabs.closeAllUnstagedDiffTabs).toHaveBeenCalledTimes(1)

    // 4. Stash create via submitStashDialog (scope='all', includeUntracked=false) excludes untracked draft.md and closes staged diffs
    currentStatus = initialStatus
    await session.actions.refreshStatus()
    await expect(
      session.actions.submitStashDialog({
        scope: 'all',
        message: 'checkpoint',
        includeUntracked: false
      })
    ).resolves.toBe(true)
    expect(getDirtySummary).toHaveBeenLastCalledWith(['C:/repo/wiki/staged.md', 'C:/repo/wiki/notes.md'])
    expect(diffTabs.closeStagedDiffTabsExcept).toHaveBeenCalledWith(new Set())
    expect(session.getSnapshot().panelState.stashes).toEqual([stash0])

    // 5. stashPop failure preserves conflict error and refreshes tree/buffers
    await expect(session.actions.stashPop?.('stash@{0}')).resolves.toBe(false)
    expect(session.getSnapshot().panelState.errorMessage).toMatch(/충돌/)

    // 6. stashDrop & stashClear require danger confirm and bypass dirty prompt / discard bracket
    const confirmUnsavedCountBeforeDrop = confirmUnsavedChanges.mock.calls.length
    dangerApproved = false
    await expect(session.actions.stashDrop?.('stash@{0}')).resolves.toBe(false)
    expect(stashDropMock).not.toHaveBeenCalled()

    dangerApproved = true
    await expect(session.actions.stashDrop?.('stash@{0}')).resolves.toBe(true)
    expect(stashDropMock).toHaveBeenCalledWith(workspaceRoot, 'stash@{0}')
    expect(confirmAction).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: 'Stash 삭제', confirmLabel: 'Drop', confirmTone: 'danger' })
    )
    expect(confirmUnsavedChanges).toHaveBeenCalledTimes(confirmUnsavedCountBeforeDrop)

    // Re-seed stash & test stashClear
    currentStashes = [stash0]
    await session.actions.refreshStatus()
    await expect(session.actions.stashClear?.()).resolves.toBe(true)
    expect(stashClearMock).toHaveBeenCalledWith(workspaceRoot)
    expect(confirmAction).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: '모든 Stash 삭제',
        confirmLabel: 'Clear All',
        confirmTone: 'danger'
      })
    )

    // 7. Workspace switch while prepareDiscardPaths is awaiting STILL runs finishDiscardPaths(..., false) in finally
    currentStatus = initialStatus
    await session.actions.refreshStatus()
    prepareDiscardPaths.mockImplementationOnce(() => prepareDeferred.promise)
    const pendingDiscard = session.actions.discardFile?.('wiki/notes.md')
    await flushAsync()
    session.setWorkspaceRootPath(null)
    prepareDeferred.resolve()
    await pendingDiscard
    expect(finishDiscardPaths).toHaveBeenLastCalledWith(['C:/repo/wiki/notes.md'], false)

    session.dispose()
  })

  it('coordinates Diff tab loading, caching, silent working-tree refresh, pruning on close/discard/stash, stash ref renumbering, and stale diff cancellation', async () => {
    const tabStore = new PaneTabStore()
    // Seed a document tab so moving Diff tabs to secondary pane works cleanly
    tabStore.openTab('c:/wiki/keep.md')

    const stash0: GitStashEntry = {
      ref: 'stash@{0}',
      hash: '1111111111111111111111111111111111111111',
      branch: 'main',
      message: 'first',
      createdAt: '2026-11-20T10:00:00Z'
    }
    const stash1: GitStashEntry = {
      ref: 'stash@{1}',
      hash: '2222222222222222222222222222222222222222',
      branch: 'main',
      message: 'second',
      createdAt: '2026-11-20T09:00:00Z'
    }

    let currentStashes: GitStashEntry[] = [stash0, stash1]
    let currentStatus: GitStatus = {
      ...makeStatus('main', 0, 'C:/wiki'),
      staged: [{ path: 'staged.md', status: 'M' }],
      unstaged: [{ path: 'notes.md', status: 'M' }],
      untracked: [{ path: 'draft.md', status: '?' }]
    }
    let patchRevision = 1
    let failDraftDiff = false
    const delayedDiff = createDeferred<{
      path: string
      status: 'M'
      isBinary: boolean
      isTruncated: boolean
      existsInWorkspace: boolean
      rawPatch: string
    }>()

    const diffMock = vi.fn(async (_ws: string, req: GitDiffRequest) => {
      if (req.kind === 'unstaged' && req.path === 'draft.md' && failDraftDiff) {
        throw new Error('Diff 로드 실패')
      }
      if (req.kind === 'commit' && req.path === 'slow.md') {
        return delayedDiff.promise
      }
      return {
        path: req.path,
        ...(req.origPath ? { origPath: req.origPath } : {}),
        status: req.status,
        isBinary: false,
        isTruncated: false,
        existsInWorkspace: true,
        rawPatch: `patch:${req.kind}:${req.path}:r${patchRevision}`
      }
    })

    const session = new GitSession({
      gitApi: createTestGitApi({
        status: vi.fn(async () => currentStatus),
        stashList: vi.fn(async () => currentStashes),
        stage: vi.fn(async (_ws, paths) => {
          currentStatus = {
            ...currentStatus,
            staged: [...currentStatus.staged, { path: paths[0], status: 'A' }],
            untracked: []
          }
          return currentStatus
        }),
        discard: vi.fn(async () => {
          currentStatus = { ...currentStatus, unstaged: [] }
          return currentStatus
        }),
        stashDrop: vi.fn(async (_ws, ref) => {
          currentStashes = currentStashes
            .filter((s) => s.ref !== ref)
            .map((s, idx) => ({ ...s, ref: `stash@{${idx}}` }))
          return currentStashes
        }),
        diff: diffMock
      }),
      buffers: createStubBuffers(),
      diffTabs: createPaneTabDiffAdapter(tabStore),
      confirm: createStubConfirm(),
      refreshTree: vi.fn(async () => undefined),
      workspaceRootPath: 'C:/wiki'
    })
    await flushAsync()

    // 1. Open untracked draft.md Diff tab -> fetches exactly once (no double fetch)
    const draftReq: GitDiffRequest = { kind: 'unstaged', path: 'draft.md', status: '?' }
    const draftKey = formatGitDiffTabKey(draftReq)
    session.actions.openFileDiff?.(draftReq)
    expect(diffMock).toHaveBeenCalledTimes(1)
    await flushAsync()
    expect(session.getSnapshot().diffsByKey[draftKey]).toEqual({
      status: 'loaded',
      diff: expect.objectContaining({ rawPatch: 'patch:unstaged:draft.md:r1' })
    })

    // Re-opening same Diff tab refreshes payload cleanly
    patchRevision = 2
    session.actions.openFileDiff?.(draftReq)
    expect(diffMock).toHaveBeenCalledTimes(2)
    await flushAsync()
    expect(session.getSnapshot().diffsByKey[draftKey]).toMatchObject({
      status: 'loaded',
      diff: { rawPatch: 'patch:unstaged:draft.md:r2' }
    })

    // 2. Stage draft.md -> resolves '?' -> 'M' fallback on status refresh without resetting to loading
    const loadingObservedDuringStage: string[] = []
    const unsub = session.subscribe(() => {
      const entry = session.getSnapshot().diffsByKey[draftKey]
      if (entry) loadingObservedDuringStage.push(entry.status)
    })
    patchRevision = 3
    await session.actions.stageFile?.('draft.md')
    await flushAsync()
    unsub()
    expect(loadingObservedDuringStage).not.toContain('loading')
    expect(diffMock).toHaveBeenLastCalledWith('C:/wiki', {
      kind: 'unstaged',
      path: 'draft.md',
      status: 'M'
    })

    // 3. Open notes.md unstaged Diff in primary and duplicate to secondary; open commit Diff in primary
    const notesReq: GitDiffRequest = { kind: 'unstaged', path: 'notes.md', status: 'M' }
    const notesKey = formatGitDiffTabKey(notesReq)
    session.actions.openFileDiff?.(notesReq)
    await flushAsync()
    const primaryDiffTab = tabStore.getActiveTab('primary')!
    tabStore.duplicateTabToOtherPane('primary', primaryDiffTab.id)
    expect(tabStore.getSnapshot().splitMode).toBe('horizontal')

    const commitReq: GitDiffRequest = {
      kind: 'commit',
      commitHash: 'deadbeef1234',
      shortHash: 'deadbee',
      path: 'hist.md',
      status: 'M'
    }
    const commitKey = formatGitDiffTabKey(commitReq)
    tabStore.focusPane('primary')
    session.actions.openFileDiff?.(commitReq)
    await flushAsync()
    expect(session.getSnapshot().diffsByKey[draftKey]).toBeUndefined()
    expect(session.getSnapshot().diffsByKey[commitKey]).toMatchObject({ status: 'loaded' })

    // Closing commit Diff tab in PaneTabStore prunes diffsByKey automatically
    const commitTab = tabStore.getActiveTab('primary')!
    tabStore.closeTab('primary', commitTab.id)
    expect(session.getSnapshot().diffsByKey[commitKey]).toBeUndefined()

    // 4. discardFile('notes.md') closes secondary unstaged diff tab AND prunes diffsByKey
    await session.actions.discardFile?.('notes.md')
    await flushAsync()
    expect(tabStore.getSnapshot().splitMode).toBe('single')
    expect(session.getSnapshot().diffsByKey[notesKey]).toBeUndefined()

    // 5. Open stash@{0} and stash@{1} Diff tabs -> drop stash@{0} closes stash0 tab/cache and renumbers stash1 -> stash@{0}
    const stash0Req: GitDiffRequest = {
      kind: 'stash',
      stashRef: stash0.ref,
      stashHash: stash0.hash,
      path: 'a.md',
      status: 'M'
    }
    const stash1Req: GitDiffRequest = {
      kind: 'stash',
      stashRef: stash1.ref,
      stashHash: stash1.hash,
      path: 'b.md',
      status: 'M'
    }
    session.actions.openFileDiff?.(stash0Req)
    await flushAsync()
    const stash0Tab = tabStore.getActiveTab('primary')!
    tabStore.moveTab('primary', 'secondary', stash0Tab.id)
    tabStore.focusPane('primary')
    session.actions.openFileDiff?.(stash1Req)
    await flushAsync()

    await session.actions.stashDrop?.('stash@{0}')
    await flushAsync()
    expect(session.getSnapshot().diffsByKey[formatGitDiffTabKey(stash0Req)]).toBeUndefined()
    expect(session.getSnapshot().diffsByKey[formatGitDiffTabKey(stash1Req)]).toBeDefined()
    const survivingStashTab = tabStore
      .getSnapshot()
      .panes.primary.tabs.find((t) => t.kind === 'diff')
    expect(
      survivingStashTab?.kind === 'diff' &&
        survivingStashTab.diff.request.kind === 'stash' &&
        survivingStashTab.diff.request.stashRef
    ).toBe('stash@{0}')

    // 6. Error state and stale in-flight diff dropped on workspace switch
    failDraftDiff = true
    session.actions.openFileDiff?.(draftReq)
    await flushAsync()
    expect(session.getSnapshot().diffsByKey[draftKey]).toEqual({
      status: 'error',
      errorMessage: 'Diff 로드 실패'
    })

    const slowReq: GitDiffRequest = {
      kind: 'commit',
      commitHash: 'feed0000',
      shortHash: 'feed000',
      path: 'slow.md',
      status: 'M'
    }
    session.actions.openFileDiff?.(slowReq)
    session.setWorkspaceRootPath(null)
    delayedDiff.resolve({
      path: 'slow.md',
      status: 'M',
      isBinary: false,
      isTruncated: false,
      existsInWorkspace: true,
      rawPatch: 'stale'
    })
    await flushAsync()
    expect(session.getSnapshot().diffsByKey).toEqual({})

    session.dispose()
  })

  it('owns session UI state (accordion split via shared accordionSplit, changes view/tree collapses, stash dialog lifecycle, auto-expand, and repo file opening)', async () => {
    const repoRoot = 'C:/repo'
    const workspaceRoot = 'C:/repo/wiki'
    const dirtyStatus: GitStatus = {
      ...makeStatus('main', 0, repoRoot),
      unstaged: [{ path: 'wiki/a/b/note.md', status: 'M' }]
    }
    const cleanStatus = makeStatus('main', 0, repoRoot)

    let currentStatus = cleanStatus
    let confirmDirty = false
    let failStash = false
    const openWorkspaceFile = vi.fn()

    const session = new GitSession({
      gitApi: createTestGitApi({
        status: vi.fn(async () => currentStatus),
        stashCreate: vi.fn(async () => {
          if (failStash) throw new Error('stash failed')
          return cleanStatus
        })
      }),
      buffers: createStubBuffers({
        getDirtySummary: vi.fn(() => 'note.md'),
        openWorkspaceFile
      }),
      diffTabs: createStubDiffTabs(),
      confirm: createStubConfirm({
        confirmUnsavedChanges: vi.fn(async () => confirmDirty)
      }),
      refreshTree: vi.fn(async () => undefined),
      workspaceRootPath: workspaceRoot
    })
    await flushAsync()

    // 1. Default split & changesView state + computeGitSectionLayout for all collapse modes
    expect(session.getSnapshot().panelState.splitState).toEqual({
      isChangesCollapsed: false,
      isStashesCollapsed: true,
      isGraphCollapsed: false,
      changesHeightRatio: 0.5
    })
    expect(computeGitSectionLayout(session.getSnapshot().panelState.splitState)).toEqual({
      showChangesBody: true,
      showStashesBody: false,
      showGraphBody: true,
      showResizer: true,
      changesFlexRatio: 0.5,
      stashesFlexRatio: null,
      stashesBodyMode: 'hidden',
      graphFlexRatio: 0.5
    })

    session.actions.resizeChangesRatio?.(0.95)
    expect(session.getSnapshot().panelState.splitState.changesHeightRatio).toBe(0.8)
    session.actions.resizeChangesRatio?.(Number.NaN)
    expect(session.getSnapshot().panelState.splitState.changesHeightRatio).toBe(0.5)
    session.actions.resizeChangesRatio?.(0.65)
    expect(session.getSnapshot().panelState.splitState.changesHeightRatio).toBe(0.65)

    // Toggle Stashes expanded while Changes/Graph collapsed -> 'fill' mode
    session.actions.toggleChangesCollapsed?.()
    session.actions.toggleGraphCollapsed?.()
    session.actions.toggleStashesCollapsed?.()
    expect(computeGitSectionLayout(session.getSnapshot().panelState.splitState)).toEqual({
      showChangesBody: false,
      showStashesBody: true,
      showGraphBody: false,
      showResizer: false,
      changesFlexRatio: null,
      stashesFlexRatio: 1,
      stashesBodyMode: 'fill',
      graphFlexRatio: null
    })

    // 2. Changes view mode, subgroup collapses, and compressed tree folder collapses
    session.actions.toggleChangesViewMode?.()
    session.actions.toggleChangesGroupCollapsed?.('staged')
    session.actions.toggleChangesGroupCollapsed?.('changes')
    session.actions.toggleChangesTreeDirCollapsed?.('changes:wiki/a/b')
    expect(session.getSnapshot().panelState.changesViewState).toEqual({
      viewMode: 'tree',
      isStagedCollapsed: true,
      isChangesCollapsed: true,
      collapsedTreeDirs: new Set(['changes:wiki/a/b'])
    })

    // 3. Stash dialog blocked when clean; opens when dirty; cancel/failure do NOT auto-expand Stashes; success auto-expands
    session.actions.openStashDialog?.('unstaged')
    expect(session.getSnapshot().panelState.stashDialogScope).toBeNull()

    currentStatus = dirtyStatus
    await session.actions.refreshStatus()
    session.actions.toggleStashesCollapsed?.() // collapse Stashes back to true
    expect(session.getSnapshot().panelState.splitState.isStashesCollapsed).toBe(true)

    session.actions.openStashDialog?.('all')
    expect(session.getSnapshot().panelState.stashDialogScope).toBe('all')
    session.actions.closeStashDialog?.()
    expect(session.getSnapshot().panelState.stashDialogScope).toBeNull()

    // Submit while dirty confirm canceled -> closes dialog, does NOT auto-expand Stashes
    session.actions.openStashDialog?.('unstaged')
    confirmDirty = false
    await expect(
      session.actions.submitStashDialog?.({ scope: 'unstaged', includeUntracked: true })
    ).resolves.toBe(false)
    expect(session.getSnapshot().panelState.stashDialogScope).toBeNull()
    expect(session.getSnapshot().panelState.splitState.isStashesCollapsed).toBe(true)

    // Submit when stashCreate succeeds -> auto-expands Stashes
    confirmDirty = true
    failStash = false
    await expect(
      session.actions.submitStashDialog?.({ scope: 'unstaged', includeUntracked: true })
    ).resolves.toBe(true)
    expect(session.getSnapshot().panelState.splitState.isStashesCollapsed).toBe(false)

    // 4. openWorkspaceFile resolves repo-relative path within workspace and ignores outside-workspace paths
    session.actions.openWorkspaceFile?.('wiki/a/b/note.md')
    expect(openWorkspaceFile).toHaveBeenCalledTimes(1)
    expect(openWorkspaceFile).toHaveBeenCalledWith('C:/repo/wiki/a/b/note.md', 'note.md')
    session.actions.openWorkspaceFile?.('outside/secret.md')
    expect(openWorkspaceFile).toHaveBeenCalledTimes(1)

    // 5. Workspace switch resets Stashes collapsed & collapsedTreeDirs while preserving viewMode, subgroup collapses, and changesHeightRatio
    session.setWorkspaceRootPath('C:/repo/other')
    const afterSwitch = session.getSnapshot().panelState
    expect(afterSwitch.splitState.isStashesCollapsed).toBe(true)
    expect(afterSwitch.splitState.changesHeightRatio).toBe(0.65)
    expect(afterSwitch.changesViewState).toEqual({
      viewMode: 'tree',
      isStagedCollapsed: true,
      isChangesCollapsed: true,
      collapsedTreeDirs: new Set()
    })

    session.dispose()
  })

  it('computes 3-tier Git section layout modes (hidden, compact, fill, all collapsed) consistently with accordionSplit', () => {
    expect(
      computeGitSectionLayout({
        isChangesCollapsed: false,
        isStashesCollapsed: false,
        isGraphCollapsed: true,
        changesHeightRatio: 0.7
      })
    ).toEqual({
      showChangesBody: true,
      showStashesBody: true,
      showGraphBody: false,
      showResizer: false,
      changesFlexRatio: 1,
      stashesFlexRatio: null,
      stashesBodyMode: 'compact',
      graphFlexRatio: null
    })

    expect(
      computeGitSectionLayout({
        isChangesCollapsed: false,
        isStashesCollapsed: false,
        isGraphCollapsed: false,
        changesHeightRatio: 0.6
      })
    ).toEqual({
      showChangesBody: true,
      showStashesBody: true,
      showGraphBody: true,
      showResizer: true,
      changesFlexRatio: 0.6,
      stashesFlexRatio: null,
      stashesBodyMode: 'compact',
      graphFlexRatio: 0.4
    })

    expect(
      computeGitSectionLayout({
        isChangesCollapsed: true,
        isStashesCollapsed: true,
        isGraphCollapsed: true,
        changesHeightRatio: 0.5
      })
    ).toEqual({
      showChangesBody: false,
      showStashesBody: false,
      showGraphBody: false,
      showResizer: false,
      changesFlexRatio: null,
      stashesFlexRatio: null,
      stashesBodyMode: 'hidden',
      graphFlexRatio: null
    })
  })

  it('resets stranded loading states and mutation locks across dispose() -> start() restarts (StrictMode parity)', async () => {
    const req: GitDiffRequest = { kind: 'unstaged', path: 'note.md', status: 'M' }
    const tabKey = formatGitDiffTabKey(req)
    const tabStore = new PaneTabStore()
    let resolvePendingDiff!: (value: GitFileDiff) => void
    let resolvePendingDiscard!: (value: GitStatus) => void
    const diffMock = vi
      .fn<WikiGitApi['diff']>()
      .mockImplementationOnce(
        () =>
          new Promise<GitFileDiff>((resolve) => {
            resolvePendingDiff = resolve
          })
      )
      .mockResolvedValueOnce({
        path: 'note.md',
        status: 'M',
        isBinary: false,
        isTruncated: false,
        existsInWorkspace: true,
        rawPatch: '@@ recovered @@'
      })
    const discardMock = vi.fn<WikiGitApi['discard']>(
      () =>
        new Promise<GitStatus>((resolve) => {
          resolvePendingDiscard = resolve
        })
    )

    const session = new GitSession({
      gitApi: createTestGitApi({
        status: vi.fn(async () => makeStatus('main', 0, 'C:/repo')),
        diff: diffMock,
        discard: discardMock
      }),
      buffers: createStubBuffers(),
      diffTabs: createPaneTabDiffAdapter(tabStore),
      confirm: createStubConfirm(),
      refreshTree: vi.fn(async (): Promise<void> => undefined),
      workspaceRootPath: 'C:/repo'
    })
    await flushAsync()

    // Start both an in-flight diff load and an in-flight mutation, then dispose mid-flight
    session.actions.openFileDiff(req)
    expect(session.getSnapshot().diffsByKey[tabKey]).toEqual({ status: 'loading' })

    const discardPromise = session.actions.discardFile('note.md')
    await flushAsync()
    expect(session.getSnapshot().isMutating).toBe(true)
    expect(session.getSnapshot().panelState.pendingAction).toBe('변경 사항 롤백')

    session.dispose()

    // Disposed snapshot must not strand loading diffs or active mutation locks
    expect(session.getSnapshot().isMutating).toBe(false)
    expect(session.getSnapshot().panelState.pendingAction).toBeNull()
    expect(session.getSnapshot().diffsByKey[tabKey]).toBeUndefined()

    // Restarting re-fetches open diff tab cleanly and ignores stale pre-dispose resolutions
    const stopRestart = session.start()
    await flushAsync()
    expect(diffMock).toHaveBeenCalledTimes(2)
    expect(session.getSnapshot().diffsByKey[tabKey]).toMatchObject({
      status: 'loaded',
      diff: { rawPatch: '@@ recovered @@' }
    })

    resolvePendingDiff({
      path: 'note.md',
      status: 'M',
      isBinary: false,
      isTruncated: false,
      existsInWorkspace: true,
      rawPatch: 'stale pre-dispose'
    })
    resolvePendingDiscard(makeStatus('main', 0, 'C:/repo'))
    await discardPromise
    await flushAsync()

    expect(session.getSnapshot().diffsByKey[tabKey]).toMatchObject({
      status: 'loaded',
      diff: { rawPatch: '@@ recovered @@' }
    })
    expect(session.getSnapshot().isMutating).toBe(false)

    stopRestart()
  })

  it('aborts failure recovery side effects if workspace switches while recovery status is in flight', async () => {
    const recoveryStatusDeferred = createDeferred<GitStatus>()
    const statusMock = vi
      .fn<WikiGitApi['status']>()
      .mockResolvedValueOnce(makeStatus('main', 0, 'C:/repo-a'))
      .mockImplementationOnce(() => recoveryStatusDeferred.promise)
      .mockResolvedValueOnce(makeStatus('main', 0, 'C:/repo-b'))
    const pullMock = vi.fn<WikiGitApi['pull']>(async () => {
      throw new Error('pull failed')
    })
    const refreshTree = vi.fn(async (): Promise<void> => undefined)
    const reconcileWithDisk = vi.fn(async (): Promise<readonly string[]> => [])
    const diffTabs = createStubDiffTabs()

    const session = new GitSession({
      gitApi: createTestGitApi({ status: statusMock, pull: pullMock }),
      buffers: createStubBuffers({ reconcileWithDisk }),
      diffTabs,
      confirm: createStubConfirm(),
      refreshTree,
      workspaceRootPath: 'C:/repo-a'
    })
    await flushAsync()
    refreshTree.mockClear()
    reconcileWithDisk.mockClear()

    const pullPromise = session.actions.pull()
    await flushAsync()

    // Switch workspace while recoverFailedGitAction awaits statusMock for C:/repo-a
    session.setWorkspaceRootPath('C:/repo-b')
    recoveryStatusDeferred.resolve(makeStatus('stale', 0, 'C:/repo-a'))
    await pullPromise
    await flushAsync()

    expect(refreshTree).not.toHaveBeenCalled()
    expect(reconcileWithDisk).not.toHaveBeenCalled()
    expect(diffTabs.closeUnstagedDiffTabsExcept).not.toHaveBeenCalled()
    expect(session.getSnapshot().panelState.workspaceRootPath).toBe('C:/repo-b')
    expect(session.getSnapshot().panelState.status?.repoRoot).toBe('C:/repo-b')

    session.dispose()
  })

  it('caches loaded immutable diffs across tab switches, merges snapshot commits, and does not cache error states', async () => {
    const tabStore = new PaneTabStore()
    let failErrFile = true
    const diffMock = vi.fn<WikiGitApi['diff']>(async (_ws, req) => {
      if (req.path === 'err.md' && failErrFile) {
        throw new Error('network error')
      }
      return {
        path: req.path,
        status: req.status,
        isBinary: false,
        isTruncated: false,
        existsInWorkspace: true,
        rawPatch: `patch:${req.path}`
      }
    })

    const session = new GitSession({
      gitApi: createTestGitApi({ diff: diffMock }),
      buffers: createStubBuffers(),
      diffTabs: createPaneTabDiffAdapter(tabStore),
      confirm: createStubConfirm(),
      refreshTree: vi.fn(async () => undefined),
      workspaceRootPath: 'C:/repo'
    })
    session.start()
    await flushAsync()

    const reqA: GitDiffRequest = {
      kind: 'branch-compare',
      baseRef: 'main',
      compareRef: 'feat/a',
      mode: 'three-dot',
      mergeBaseHash: '1111111',
      path: 'a.md',
      status: 'M'
    }
    const reqB: GitDiffRequest = {
      kind: 'branch-compare',
      baseRef: 'main',
      compareRef: 'feat/a',
      mode: 'three-dot',
      mergeBaseHash: '1111111',
      path: 'b.md',
      status: 'M'
    }
    const keyA = formatGitDiffTabKey(reqA)
    const keyB = formatGitDiffTabKey(reqB)

    // Load A, then replace with B (miss -> single merged snapshot commit for pruning A + loading B)
    session.actions.openFileDiff(reqA)
    await flushAsync()
    expect(diffMock).toHaveBeenCalledTimes(1)

    const missSnapshots: string[] = []
    const unsubMiss = session.subscribe(() => {
      missSnapshots.push(session.getSnapshot().diffsByKey[keyB]?.status ?? 'missing')
    })
    session.actions.openFileDiff(reqB)
    unsubMiss()
    expect(missSnapshots).toEqual(['loading'])
    await flushAsync()
    expect(diffMock).toHaveBeenCalledTimes(2)
    expect(session.getSnapshot().diffsByKey[keyA]).toBeUndefined()

    // Revisit A -> cache hit: 0 IPC calls, single snapshot commit, no 'loading' state
    const hitStatuses: string[] = []
    const unsubHit = session.subscribe(() => {
      hitStatuses.push(session.getSnapshot().diffsByKey[keyA]?.status ?? 'missing')
    })
    session.actions.openFileDiff(reqA)
    unsubHit()
    expect(diffMock).toHaveBeenCalledTimes(2)
    expect(hitStatuses).toEqual(['loaded'])
    expect(session.getSnapshot().diffsByKey[keyA]).toMatchObject({
      status: 'loaded',
      diff: { rawPatch: 'patch:a.md' }
    })

    // Error state is not cached and retries on revisit
    const reqErr: GitDiffRequest = {
      kind: 'commit',
      commitHash: 'deadbeef',
      shortHash: 'deadbee',
      path: 'err.md',
      status: 'M'
    }
    session.actions.openFileDiff(reqErr)
    await flushAsync()
    expect(diffMock).toHaveBeenCalledTimes(3)
    expect(session.getSnapshot().diffsByKey[formatGitDiffTabKey(reqErr)]?.status).toBe('error')

    session.actions.openFileDiff(reqA)
    expect(diffMock).toHaveBeenCalledTimes(3)

    failErrFile = false
    session.actions.openFileDiff(reqErr)
    await flushAsync()
    expect(diffMock).toHaveBeenCalledTimes(4)
    expect(session.getSnapshot().diffsByKey[formatGitDiffTabKey(reqErr)]).toMatchObject({
      status: 'loaded',
      diff: { rawPatch: 'patch:err.md' }
    })

    session.dispose()
  })

  it('evicts least-recently-used non-open immutable diffs when exceeding entry count or byte budget', async () => {
    const tabStore = new PaneTabStore()
    let patchSize = 10
    const diffMock = vi.fn<WikiGitApi['diff']>(async (_ws, req) => ({
      path: req.path,
      status: req.status,
      isBinary: false,
      isTruncated: false,
      existsInWorkspace: true,
      rawPatch: 'x'.repeat(patchSize)
    }))

    const session = new GitSession({
      gitApi: createTestGitApi({ diff: diffMock }),
      buffers: createStubBuffers(),
      diffTabs: createPaneTabDiffAdapter(tabStore),
      confirm: createStubConfirm(),
      refreshTree: vi.fn(async () => undefined),
      workspaceRootPath: 'C:/repo'
    })
    session.start()
    await flushAsync()

    const makeCompareReq = (name: string): GitDiffRequest => ({
      kind: 'branch-compare',
      baseRef: 'main',
      compareRef: 'feat/lru',
      mode: 'three-dot',
      mergeBaseHash: '1111111',
      path: name,
      status: 'M'
    })

    // 1. Entry count bound (40): open f-0 .. f-39
    for (let i = 0; i < 40; i++) {
      session.actions.openFileDiff(makeCompareReq(`f-${i}.md`))
      await flushAsync()
    }
    expect(diffMock).toHaveBeenCalledTimes(40)

    // Revisit f-0 -> promotes f-0 to MRU (f-1 becomes LRU) without calling diffMock
    session.actions.openFileDiff(makeCompareReq('f-0.md'))
    expect(diffMock).toHaveBeenCalledTimes(40)

    // Open f-40 (41st) -> evicts f-1, keeps f-0
    session.actions.openFileDiff(makeCompareReq('f-40.md'))
    await flushAsync()
    expect(diffMock).toHaveBeenCalledTimes(41)

    session.actions.openFileDiff(makeCompareReq('f-0.md'))
    expect(diffMock).toHaveBeenCalledTimes(41)

    session.actions.openFileDiff(makeCompareReq('f-1.md'))
    await flushAsync()
    expect(diffMock).toHaveBeenCalledTimes(42)

    // 2. Byte budget bound (12MB): open 13 x 1MB patches -> oldest 1MB entry evicted, open tab protected
    patchSize = 1024 * 1024
    for (let i = 0; i < 12; i++) {
      session.actions.openFileDiff(makeCompareReq(`big-${i}.md`))
      await flushAsync()
    }
    const callsAfter12 = diffMock.mock.calls.length
    // Keep big-0 open in secondary pane to verify open tabs are protected from eviction
    session.actions.openFileDiff(makeCompareReq('big-0.md'))
    expect(diffMock).toHaveBeenCalledTimes(callsAfter12)
    const big0Tab = tabStore.getActiveTab('primary')!
    tabStore.duplicateTabToOtherPane('primary', big0Tab.id)
    tabStore.focusPane('primary')

    // Open big-12 (13th 1MB patch) -> big-0 is open so big-1 is evicted instead
    session.actions.openFileDiff(makeCompareReq('big-12.md'))
    await flushAsync()
    expect(diffMock).toHaveBeenCalledTimes(callsAfter12 + 1)

    // Close big-0 in secondary, revisit big-0 (still cached), then revisit big-1 (evicted -> refetches)
    const secTab = tabStore.getActiveTab('secondary')!
    tabStore.closeTab('secondary', secTab.id)
    session.actions.openFileDiff(makeCompareReq('big-0.md'))
    expect(diffMock).toHaveBeenCalledTimes(callsAfter12 + 1)

    session.actions.openFileDiff(makeCompareReq('big-1.md'))
    await flushAsync()
    expect(diffMock).toHaveBeenCalledTimes(callsAfter12 + 2)

    session.dispose()
  })

  it('invalidates cached stash diffs when stash is dropped, and clears all immutable caches on workspace switch or dispose', async () => {
    const tabStore = new PaneTabStore()
    const stash0: GitStashEntry = {
      ref: 'stash@{0}',
      hash: 'hash-s0',
      branch: 'main',
      message: 's0',
      createdAt: '2026-11-15T12:00:00+09:00'
    }
    const stash1: GitStashEntry = {
      ref: 'stash@{1}',
      hash: 'hash-s1',
      branch: 'main',
      message: 's1',
      createdAt: '2026-11-15T11:00:00+09:00'
    }
    let activeStashes: GitStashEntry[] = [stash0, stash1]
    const diffMock = vi.fn<WikiGitApi['diff']>(async (_ws, req) => ({
      path: req.path,
      status: req.status,
      isBinary: false,
      isTruncated: false,
      existsInWorkspace: true,
      rawPatch: `patch:${req.path}`
    }))

    const session = new GitSession({
      gitApi: createTestGitApi({
        stashList: vi.fn(async () => activeStashes),
        stashDrop: vi.fn(async () => {
          activeStashes = [{ ...stash1, ref: 'stash@{0}' }]
          return activeStashes
        }),
        diff: diffMock
      }),
      buffers: createStubBuffers(),
      diffTabs: createPaneTabDiffAdapter(tabStore),
      confirm: createStubConfirm(),
      refreshTree: vi.fn(async () => undefined),
      workspaceRootPath: 'C:/repo-a'
    })
    session.start()
    await flushAsync()

    const stash0Req: GitDiffRequest = {
      kind: 'stash',
      stashRef: stash0.ref,
      stashHash: stash0.hash,
      path: 's0.md',
      status: 'M'
    }
    const stash1Req: GitDiffRequest = {
      kind: 'stash',
      stashRef: stash1.ref,
      stashHash: stash1.hash,
      path: 's1.md',
      status: 'M'
    }
    const commitReq: GitDiffRequest = {
      kind: 'commit',
      commitHash: 'abc1234',
      shortHash: 'abc1234',
      path: 'c.md',
      status: 'M'
    }

    // Load stash0, stash1, then switch single tab to commitReq (so stash0 & stash1 are only in LRU cache)
    session.actions.openFileDiff(stash0Req)
    await flushAsync()
    session.actions.openFileDiff(stash1Req)
    await flushAsync()
    session.actions.openFileDiff(commitReq)
    await flushAsync()
    expect(diffMock).toHaveBeenCalledTimes(3)

    // Drop stash@{0} -> hash-s0 pruned from LRU cache, hash-s1 preserved
    await session.actions.stashDrop('stash@{0}')
    await flushAsync()

    session.actions.openFileDiff(stash1Req)
    expect(diffMock).toHaveBeenCalledTimes(3)

    session.actions.openFileDiff(stash0Req)
    await flushAsync()
    expect(diffMock).toHaveBeenCalledTimes(4)

    // Workspace switch clears cache
    session.setWorkspaceRootPath('C:/repo-b')
    await flushAsync()
    session.setWorkspaceRootPath('C:/repo-a')
    await flushAsync()
    session.actions.openFileDiff(commitReq)
    await flushAsync()
    expect(diffMock).toHaveBeenCalledTimes(5)

    // dispose() clears immutable LRU cache (revisiting non-open stash1Req refetches)
    session.dispose()
    session.start()
    await flushAsync()
    session.actions.openFileDiff(stash1Req)
    await flushAsync()
    expect(diffMock).toHaveBeenCalledTimes(6)

    session.dispose()
  })
})
