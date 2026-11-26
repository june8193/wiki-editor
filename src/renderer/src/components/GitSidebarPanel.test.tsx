import { StrictMode, useEffect, useRef, useSyncExternalStore } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  createEmptyGitStatus,
  type GitBranchList,
  type GitGraphCommit,
  type GitLogScope,
  type GitStashEntry,
  type GitStatus
} from '@shared/git'
import type { WikiGitApi } from '@shared/ipc'
import {
  createDefaultGitChangesViewState,
  createDefaultGitPanelSplitState,
  createInitialGitDetailState,
  createInitialGitGraphState,
  GitSession,
  type GitPanelActions,
  type GitPanelState
} from '../stores/GitSession'
import themeCss from '../styles/theme.css?raw'
import type { GitCommitActionMode } from '../utils/gitPrimaryAction'
import { GitSidebarPanel, type GitSidebarPanelProps } from './GitSidebarPanel'

function buildGitStatus(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    ...createEmptyGitStatus(true, 'C:\\wiki'),
    branch: 'main',
    hasUpstream: true,
    ahead: 2,
    behind: 1,
    staged: [{ path: 'docs/intro.md', status: 'A' }],
    unstaged: [{ path: 'README.md', status: 'M' }],
    untracked: [{ path: 'notes.md', status: '?' }],
    ...overrides
  }
}

interface GitSidebarPanelTestOverrides extends Partial<GitPanelState> {
  onDismissError?: GitPanelActions['dismissError']
  onRefresh?: () => void
  onInitRepo?: () => void
  onStageFile?: (path: string) => void
  onStageAll?: () => void
  onUnstageFile?: (path: string, origPath?: string) => void
  onUnstageAll?: () => void
  onDiscardFile?: (path: string) => void
  onDiscardAll?: () => void
  onStashChanges?: () => void
  onStashFile?: (path: string) => void
  onOpenStashDialog?: GitPanelActions['openStashDialog']
  onPopStash?: (stashRef: string) => void
  onApplyStash?: (stashRef: string) => void
  onDropStash?: (stashRef: string) => void
  onClearStashes?: () => void
  onCommit?: (message: string, mode?: GitCommitActionMode) => Promise<boolean> | boolean | void
  onCheckoutBranch?: (branchName: string) => void
  onPull?: () => void
  onPush?: () => void
  onFetch?: () => void
  onSync?: () => void
  onChangeLogScope?: (nextScope: GitLogScope) => void
  onLoadMoreCommits?: () => void
  onToggleCommitDetail?: (commitHash: string) => void
  onToggleStashDetail?: (entry: GitStashEntry) => void
  onOpenFileDiff?: GitPanelActions['openFileDiff']
  onOpenWorkspaceFile?: GitPanelActions['openWorkspaceFile']
  onToggleChangesCollapsed?: GitPanelActions['toggleChangesCollapsed']
  onToggleStashesCollapsed?: GitPanelActions['toggleStashesCollapsed']
  onToggleGraphCollapsed?: GitPanelActions['toggleGraphCollapsed']
  onResizeChangesRatio?: GitPanelActions['resizeChangesRatio']
  onToggleChangesViewMode?: GitPanelActions['toggleChangesViewMode']
  onToggleChangesGroupCollapsed?: GitPanelActions['toggleChangesGroupCollapsed']
  onToggleChangesTreeDirCollapsed?: GitPanelActions['toggleChangesTreeDirCollapsed']
}

function buildProps(overrides: GitSidebarPanelTestOverrides = {}): GitSidebarPanelProps {
  const branches: GitBranchList = {
    current: 'main',
    isDetached: false,
    branches: [
      { name: 'main', current: true, upstream: 'origin/main' },
      { name: 'feature/git', current: false, upstream: null }
    ]
  }

  const state: GitPanelState = {
    workspaceRootPath:
      overrides.workspaceRootPath !== undefined ? overrides.workspaceRootPath : 'C:\\wiki',
    status: overrides.status !== undefined ? overrides.status : buildGitStatus(),
    branchList: overrides.branchList !== undefined ? overrides.branchList : branches,
    stashes: overrides.stashes ?? [],
    stashDetail: overrides.stashDetail ?? createInitialGitDetailState(),
    graphState: overrides.graphState ?? createInitialGitGraphState(),
    pendingAction: overrides.pendingAction ?? null,
    errorMessage: overrides.errorMessage ?? null,
    splitState: overrides.splitState ?? createDefaultGitPanelSplitState(),
    changesViewState: overrides.changesViewState ?? createDefaultGitChangesViewState(),
    stashDialogScope: overrides.stashDialogScope ?? null
  }

  const actions: GitPanelActions = {
    dismissError: overrides.onDismissError ?? vi.fn(),
    refreshStatus: (overrides.onRefresh ?? vi.fn()) as GitPanelActions['refreshStatus'],
    changeLogScope: (overrides.onChangeLogScope ?? vi.fn()) as GitPanelActions['changeLogScope'],
    loadMoreCommits: (overrides.onLoadMoreCommits ?? vi.fn()) as GitPanelActions['loadMoreCommits'],
    toggleCommitDetail: (overrides.onToggleCommitDetail ??
      vi.fn()) as GitPanelActions['toggleCommitDetail'],
    toggleStashDetail: (overrides.onToggleStashDetail ??
      vi.fn()) as GitPanelActions['toggleStashDetail'],
    initRepo: (overrides.onInitRepo ?? vi.fn()) as GitPanelActions['initRepo'],
    stageFile: (overrides.onStageFile ?? vi.fn()) as GitPanelActions['stageFile'],
    stageAll: (overrides.onStageAll ?? vi.fn()) as GitPanelActions['stageAll'],
    unstageFile: (overrides.onUnstageFile ?? vi.fn()) as GitPanelActions['unstageFile'],
    unstageAll: (overrides.onUnstageAll ?? vi.fn()) as GitPanelActions['unstageAll'],
    discardFile: (overrides.onDiscardFile ?? vi.fn()) as GitPanelActions['discardFile'],
    discardAll: (overrides.onDiscardAll ?? vi.fn()) as GitPanelActions['discardAll'],
    stashChanges: (overrides.onStashChanges ?? vi.fn()) as GitPanelActions['stashChanges'],
    stashFile: (overrides.onStashFile ?? vi.fn()) as GitPanelActions['stashFile'],
    stashApply: (overrides.onApplyStash ?? vi.fn()) as GitPanelActions['stashApply'],
    stashPop: (overrides.onPopStash ?? vi.fn()) as GitPanelActions['stashPop'],
    stashDrop: (overrides.onDropStash ?? vi.fn()) as GitPanelActions['stashDrop'],
    stashClear: (overrides.onClearStashes ?? vi.fn()) as GitPanelActions['stashClear'],
    commit: (overrides.onCommit ?? vi.fn(async () => true)) as GitPanelActions['commit'],
    checkoutBranch: (overrides.onCheckoutBranch ?? vi.fn()) as GitPanelActions['checkoutBranch'],
    pull: (overrides.onPull ?? vi.fn()) as GitPanelActions['pull'],
    push: (overrides.onPush ?? vi.fn()) as GitPanelActions['push'],
    fetch: (overrides.onFetch ?? vi.fn()) as GitPanelActions['fetch'],
    sync: (overrides.onSync ?? vi.fn()) as GitPanelActions['sync'],
    openStashDialog: overrides.onOpenStashDialog ?? vi.fn(),
    closeStashDialog: vi.fn(),
    submitStashDialog: vi.fn(async () => true),
    openFileDiff: overrides.onOpenFileDiff ?? vi.fn(),
    openWorkspaceFile: overrides.onOpenWorkspaceFile ?? vi.fn(),
    toggleChangesCollapsed: overrides.onToggleChangesCollapsed ?? vi.fn(),
    toggleStashesCollapsed: overrides.onToggleStashesCollapsed ?? vi.fn(),
    toggleGraphCollapsed: overrides.onToggleGraphCollapsed ?? vi.fn(),
    resizeChangesRatio: overrides.onResizeChangesRatio ?? vi.fn(),
    toggleChangesViewMode: overrides.onToggleChangesViewMode ?? vi.fn(),
    toggleChangesGroupCollapsed: overrides.onToggleChangesGroupCollapsed ?? vi.fn(),
    toggleChangesTreeDirCollapsed: overrides.onToggleChangesTreeDirCollapsed ?? vi.fn()
  }

  return { state, actions }
}

function createPendingWikiGitApi(): WikiGitApi {
  const never = <T,>() => new Promise<T>(() => undefined)
  return {
    status: () => never(),
    diff: () => never(),
    readBlobSnapshot: () => never(),
    compareRefs: () => never(),
    compareSummary: () => never(),
    branches: () => never(),
    log: () => never(),
    commitDetail: () => never(),
    stashList: () => never(),
    stashDetail: () => never(),
    init: () => never(),
    stage: () => never(),
    stageAll: () => never(),
    unstage: () => never(),
    unstageAll: () => never(),
    discard: () => never(),
    discardAll: () => never(),
    stashCreate: () => never(),
    stashApply: () => never(),
    stashPop: () => never(),
    stashDrop: () => never(),
    stashClear: () => never(),
    commit: () => never(),
    checkout: () => never(),
    pull: () => never(),
    push: () => never(),
    fetch: () => never(),
    sync: () => never()
  }
}

function StatefulGitSidebarPanel({ state, actions }: GitSidebarPanelProps) {
  const sessionRef = useRef<GitSession | null>(null)
  if (!sessionRef.current) {
    const session = new GitSession({
      gitApi: createPendingWikiGitApi(),
      buffers: {
        getDirtySummary: () => null,
        saveDirtyBuffers: async () => true,
        prepareDiscardPaths: async () => undefined,
        finishDiscardPaths: async () => undefined,
        reconcileWithDisk: async () => [],
        openWorkspaceFile: () => undefined
      },
      diffTabs: {
        listOpenRequests: () => [],
        subscribe: () => () => undefined,
        openDiffTab: () => undefined,
        closeAllUnstagedDiffTabs: () => undefined,
        closeUnstagedDiffTabsForPaths: () => undefined,
        closeUnstagedDiffTabsExcept: () => undefined,
        closeStagedDiffTabsExcept: () => undefined,
        reconcileStashDiffTabs: () => undefined
      },
      confirm: {
        confirmAction: async () => false,
        confirmUnsavedChanges: async () => false,
        isDialogOpen: () => false
      },
      refreshTree: async () => undefined,
      workspaceRootPath: state.workspaceRootPath
    })
    if (!state.splitState.isStashesCollapsed) {
      session.actions.toggleStashesCollapsed()
    }
    sessionRef.current = session
  }

  const session = sessionRef.current
  const sessionSnapshot = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot
  )

  useEffect(() => session.start(), [session])

  useEffect(() => {
    session.setWorkspaceRootPath(state.workspaceRootPath)
  }, [session, state.workspaceRootPath])

  return (
    <GitSidebarPanel
      state={{
        ...state,
        splitState: sessionSnapshot.panelState.splitState,
        changesViewState: sessionSnapshot.panelState.changesViewState
      }}
      actions={{
        ...actions,
        toggleChangesCollapsed: session.actions.toggleChangesCollapsed,
        toggleStashesCollapsed: session.actions.toggleStashesCollapsed,
        toggleGraphCollapsed: session.actions.toggleGraphCollapsed,
        resizeChangesRatio: session.actions.resizeChangesRatio,
        toggleChangesViewMode: session.actions.toggleChangesViewMode,
        toggleChangesGroupCollapsed: session.actions.toggleChangesGroupCollapsed,
        toggleChangesTreeDirCollapsed: session.actions.toggleChangesTreeDirCollapsed
      }}
    />
  )
}

function getChangesAccordionToggle(region: HTMLElement): HTMLElement {
  const changesSection = within(region).getByRole('region', { name: 'Changes' })
  return within(changesSection).getAllByRole('button', { name: /^Changes/i })[0]
}

describe('GitSidebarPanel', () => {
  it('shows empty guidance when no workspace is open and shows git init option for non-git folders', async () => {
    const user = userEvent.setup()
    const onInitRepo = vi.fn()

    const { rerender } = render(
      <GitSidebarPanel
        {...buildProps({
          workspaceRootPath: null,
          status: null,
          branchList: null,
          onInitRepo
        })}
      />
    )

    const region = screen.getByRole('region', { name: 'Git 소스 제어' })
    expect(within(region).getByText(/워크스페이스를 먼저 열어주세요/)).toBeInTheDocument()

    rerender(
      <GitSidebarPanel
        {...buildProps({
          status: createEmptyGitStatus(false, 'C:\\wiki'),
          branchList: null,
          onInitRepo
        })}
      />
    )

    expect(within(region).getByText(/Git 저장소가 아닙니다/)).toBeInTheDocument()
    await user.click(within(region).getByRole('button', { name: /Git 저장소 초기화/i }))
    expect(onInitRepo).toHaveBeenCalledTimes(1)
  })

  it('displays branch, ahead/behind counts, staged/unstaged/untracked badges, and triggers stage/unstage actions', async () => {
    const user = userEvent.setup()
    const onStageFile = vi.fn()
    const onStageAll = vi.fn()
    const onUnstageFile = vi.fn()
    const onUnstageAll = vi.fn()
    const onRefresh = vi.fn()

    render(
      <GitSidebarPanel
        {...buildProps({
          status: buildGitStatus({
            staged: [
              { path: 'docs/guide.md', origPath: 'docs/old.md', status: 'R' },
              { path: 'added.md', status: 'A' }
            ],
            unstaged: [
              { path: 'edited.md', status: 'M' },
              { path: 'removed.md', status: 'D' }
            ],
            untracked: [{ path: 'draft.md', status: '?' }]
          }),
          onStageFile,
          onStageAll,
          onUnstageFile,
          onUnstageAll,
          onRefresh
        })}
      />
    )

    const region = screen.getByRole('region', { name: 'Git 소스 제어' })
    expect(within(region).getByText('Source Control')).toBeInTheDocument()
    expect(within(region).getByLabelText('현재 브랜치 main')).toHaveTextContent('main')
    expect(within(region).getByRole('button', { name: /Sync.*↓1 ↑2/ })).toHaveTextContent('↓1 ↑2')
    expect(within(region).queryByLabelText('브랜치 선택')).not.toBeInTheDocument()
    expect(within(region).queryByRole('button', { name: '브랜치 전환' })).not.toBeInTheDocument()

    // Status badges for staged and unstaged/untracked items (VS Code UI chars)
    expect(within(region).getByText('R')).toBeInTheDocument()
    expect(within(region).getByText('old.md → guide.md')).toBeInTheDocument()
    expect(within(region).getByText('docs')).toBeInTheDocument()
    expect(within(region).getByText('A')).toBeInTheDocument()
    expect(within(region).getByText('M')).toBeInTheDocument()
    expect(within(region).getByText('D')).toBeInTheDocument()
    expect(within(region).getByText('U')).toBeInTheDocument()
    expect(within(region).queryByText('?')).not.toBeInTheDocument()

    await user.click(within(region).getByRole('button', { name: 'Git 상태 새로고침' }))
    expect(onRefresh).toHaveBeenCalledTimes(1)

    await user.click(within(region).getByRole('button', { name: 'docs/guide.md Unstage' }))
    expect(onUnstageFile).toHaveBeenCalledWith('docs/guide.md', 'docs/old.md')

    await user.click(within(region).getByRole('button', { name: 'added.md Unstage' }))
    expect(onUnstageFile).toHaveBeenCalledWith('added.md', undefined)

    await user.click(within(region).getByRole('button', { name: '전체 Unstage' }))
    expect(onUnstageAll).toHaveBeenCalledTimes(1)

    await user.click(within(region).getByRole('button', { name: 'draft.md Stage' }))
    expect(onStageFile).toHaveBeenCalledWith('draft.md')

    await user.click(within(region).getByRole('button', { name: '전체 Stage' }))
    expect(onStageAll).toHaveBeenCalledTimes(1)
  })

  it('validates non-empty commit message, triggers commit, remote pull/push/fetch/sync via more menu and subrow, immediate branch checkout, loading state, and error dismissal', async () => {
    const user = userEvent.setup()
    const onCommit = vi.fn().mockResolvedValue(true)
    const onPull = vi.fn()
    const onPush = vi.fn()
    const onFetch = vi.fn()
    const onSync = vi.fn()
    const onCheckoutBranch = vi.fn()
    const onDismissError = vi.fn()

    const { rerender } = render(
      <GitSidebarPanel
        {...buildProps({
          onCommit,
          onPull,
          onPush,
          onFetch,
          onSync,
          onCheckoutBranch,
          onDismissError
        })}
      />
    )

    const region = screen.getByRole('region', { name: 'Git 소스 제어' })
    const messageInput = within(region).getByLabelText('커밋 메시지')
    const commitBtn = within(region).getByRole('button', { name: 'Commit' })

    // Submitting blank message blocks commit and shows validation message
    await user.type(messageInput, '   ')
    await user.click(commitBtn)
    expect(onCommit).not.toHaveBeenCalled()
    expect(within(region).getByText(/커밋 메시지를 입력하세요/)).toBeInTheDocument()

    await user.clear(messageInput)
    await user.type(messageInput, 'docs: update handbook')
    await user.click(commitBtn)
    expect(onCommit).toHaveBeenCalledWith('docs: update handbook', 'commit')
    expect((messageInput as HTMLTextAreaElement).value).toBe('')

    // Immediate branch checkout from 26px branch picker overlay
    await user.click(within(region).getByRole('button', { name: '현재 브랜치 main' }))
    const branchMenu = within(region).getByRole('menu', { name: '브랜치 선택' })
    await user.click(within(branchMenu).getByRole('menuitem', { name: 'feature/git' }))
    expect(onCheckoutBranch).toHaveBeenCalledWith('feature/git')
    expect(within(region).queryByRole('menu', { name: '브랜치 선택' })).not.toBeInTheDocument()

    // Pull / Push / Fetch / Sync via ... more menu and subrow Sync trigger
    const moreBtn = within(region).getByRole('button', { name: '더 보기' })
    await user.click(moreBtn)
    await user.click(within(region).getByRole('menuitem', { name: 'Pull' }))
    await user.click(moreBtn)
    await user.click(within(region).getByRole('menuitem', { name: 'Push' }))
    await user.click(moreBtn)
    await user.click(within(region).getByRole('menuitem', { name: 'Fetch' }))
    await user.click(moreBtn)
    await user.click(within(region).getByRole('menuitem', { name: 'Sync' }))
    await user.click(within(region).getByRole('button', { name: /Sync.*↓1 ↑2/ }))
    expect(onPull).toHaveBeenCalledTimes(1)
    expect(onPush).toHaveBeenCalledTimes(1)
    expect(onFetch).toHaveBeenCalledTimes(1)
    expect(onSync).toHaveBeenCalledTimes(2)

    // Loading state and error banner
    rerender(
      <GitSidebarPanel
        {...buildProps({
          pendingAction: 'Sync',
          errorMessage: '원격 저장소 인증에 실패했습니다.',
          onDismissError
        })}
      />
    )

    expect(within(region).getByRole('status')).toHaveTextContent(/Sync/)
    expect(within(region).getByRole('button', { name: '더 보기' })).toBeDisabled()
    expect(within(region).getByRole('button', { name: 'Git 상태 새로고침' })).toBeDisabled()
    expect(within(region).getByRole('button', { name: '현재 브랜치 main' })).toBeDisabled()
    expect(within(region).getByRole('button', { name: /Sync.*↓1 ↑2/ })).toBeDisabled()

    const alert = within(region).getByRole('alert')
    expect(alert).toHaveTextContent('원격 저장소 인증에 실패했습니다.')
    await user.click(within(alert).getByRole('button', { name: 'Git 오류 닫기' }))
    expect(onDismissError).toHaveBeenCalledTimes(1)
  })

  it('removes whole-panel collapse toggle from header, hides accordions in non-repo states, and splits repo body into Changes and Graph accordions', async () => {
    const user = userEvent.setup()
    const onCheckoutBranch = vi.fn()
    const onSync = vi.fn()
    const onCommit = vi.fn().mockResolvedValue(true)

    const { rerender } = render(
      <StatefulGitSidebarPanel
        {...buildProps({
          workspaceRootPath: 'C:\\wiki',
          status: null,
          branchList: null
        })}
      />
    )

    const region = screen.getByRole('region', { name: 'Git 소스 제어' })
    expect(within(region).getByText('Source Control')).toBeInTheDocument()
    expect(within(region).getByText('Git 상태를 불러오는 중...')).toBeInTheDocument()
    expect(within(region).getByText('Source Control').closest('button')).toBeNull()
    expect(within(region).queryByRole('button', { name: /Changes/i })).not.toBeInTheDocument()
    expect(within(region).queryByRole('button', { name: /Graph/i })).not.toBeInTheDocument()

    rerender(
      <StatefulGitSidebarPanel
        {...buildProps({
          workspaceRootPath: 'C:\\wiki',
          status: createEmptyGitStatus(false, 'C:\\wiki'),
          branchList: null
        })}
      />
    )
    expect(within(region).queryByRole('button', { name: /Changes/i })).not.toBeInTheDocument()
    expect(within(region).queryByRole('button', { name: /Graph/i })).not.toBeInTheDocument()

    rerender(
      <StatefulGitSidebarPanel
        {...buildProps({
          status: buildGitStatus({
            staged: [
              { path: 'a.md', status: 'A' },
              { path: 'b.md', status: 'M' }
            ],
            unstaged: [{ path: 'c.md', status: 'M' }],
            untracked: [
              { path: 'd.md', status: '?' },
              { path: 'e.md', status: '?' }
            ]
          }),
          onCheckoutBranch,
          onSync,
          onCommit
        })}
      />
    )

    // Header has no collapse toggle (refresh and ... menu buttons in header)
    expect(within(region).getByText('Source Control').closest('button')).toBeNull()
    expect(within(region).getByRole('button', { name: 'Git 상태 새로고침' })).toBeInTheDocument()
    expect(within(region).getByRole('button', { name: '더 보기' })).toBeInTheDocument()

    const changesToggle = getChangesAccordionToggle(region)
    const graphToggle = within(region).getByRole('button', { name: /Graph/i })
    expect(changesToggle).toHaveAttribute('aria-expanded', 'true')
    expect(changesToggle).toHaveTextContent('5')
    expect(graphToggle).toHaveAttribute('aria-expanded', 'true')

    // Ctrl+Enter submits commit inside Changes body
    const commitInput = within(region).getByLabelText('커밋 메시지')
    await user.type(commitInput, 'chore: ctrl enter commit')
    fireEvent.keyDown(commitInput, { key: 'Enter', ctrlKey: true })
    expect(onCommit).toHaveBeenCalledWith('chore: ctrl enter commit', 'commit')

    // Collapse Changes -> commit form and file sections hide, but branch subrow & remote sync remain active
    await user.click(changesToggle)
    expect(changesToggle).toHaveAttribute('aria-expanded', 'false')
    expect(within(region).queryByLabelText('커밋 메시지')).not.toBeInTheDocument()
    expect(within(region).queryByRole('group', { name: 'Staged Changes' })).not.toBeInTheDocument()
    expect(graphToggle).toHaveAttribute('aria-expanded', 'true')

    await user.click(within(region).getByRole('button', { name: '현재 브랜치 main' }))
    await user.click(within(region).getByRole('menuitem', { name: 'feature/git' }))
    await user.click(within(region).getByRole('button', { name: /Sync.*↓1 ↑2/ }))
    expect(onCheckoutBranch).toHaveBeenCalledWith('feature/git')
    expect(onSync).toHaveBeenCalledTimes(1)

    // Collapse Graph too -> both bodies hidden
    await user.click(graphToggle)
    expect(graphToggle).toHaveAttribute('aria-expanded', 'false')
    expect(
      within(region).queryByText(/커밋 히스토리가 없습니다|아직 커밋된 내역이 없습니다/)
    ).not.toBeInTheDocument()

    // Re-expand Changes & Graph independently
    await user.click(changesToggle)
    expect(changesToggle).toHaveAttribute('aria-expanded', 'true')
    expect(within(region).getByLabelText('커밋 메시지')).toBeInTheDocument()
    expect(graphToggle).toHaveAttribute('aria-expanded', 'false')

    await user.click(graphToggle)
    expect(graphToggle).toHaveAttribute('aria-expanded', 'true')

    // Clean repository shows 0 badge and hides Staged Changes
    rerender(
      <StatefulGitSidebarPanel
        {...buildProps({
          status: buildGitStatus({
            staged: [],
            unstaged: [],
            untracked: []
          })
        })}
      />
    )
    expect(getChangesAccordionToggle(region)).toHaveTextContent('0')
    expect(within(region).queryByRole('group', { name: 'Staged Changes' })).not.toBeInTheDocument()
  })

  it('renders horizontal section resizer only when both sections are expanded and supports keyboard, pointer drag, double-click, and collapse ratio preservation', async () => {
    const user = userEvent.setup()
    render(<StatefulGitSidebarPanel {...buildProps()} />)

    const region = screen.getByRole('region', { name: 'Git 소스 제어' })
    const changesSection = within(region).getByRole('region', { name: 'Changes' })
    const graphSection = within(region).getByRole('region', { name: 'Graph' })
    const resizer = within(region).getByRole('separator', { name: 'Git 섹션 높이 조절' })

    expect(
      changesSection.compareDocumentPosition(resizer) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      resizer.compareDocumentPosition(graphSection) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()

    expect(resizer).toHaveAttribute('aria-orientation', 'horizontal')
    expect(resizer).toHaveAttribute('aria-valuemin', '20')
    expect(resizer).toHaveAttribute('aria-valuemax', '80')
    expect(resizer).toHaveAttribute('aria-valuenow', '50')
    expect(resizer).toHaveAttribute('tabindex', '0')
    expect(changesSection).toHaveStyle({ flex: '0.5 1 0%' })
    expect(graphSection).toHaveStyle({ flex: '0.5 1 0%' })

    // Keyboard resize: ArrowDown increases Changes ratio, ArrowUp decreases, clamped to [20, 80]
    fireEvent.keyDown(resizer, { key: 'ArrowDown' })
    expect(resizer).toHaveAttribute('aria-valuenow', '55')
    expect(changesSection).toHaveStyle({ flex: '0.55 1 0%' })
    expect(graphSection).toHaveStyle({ flex: '0.45 1 0%' })

    for (let i = 0; i < 10; i += 1) {
      fireEvent.keyDown(resizer, { key: 'ArrowDown' })
    }
    expect(resizer).toHaveAttribute('aria-valuenow', '80')

    for (let i = 0; i < 15; i += 1) {
      fireEvent.keyDown(resizer, { key: 'ArrowUp' })
    }
    expect(resizer).toHaveAttribute('aria-valuenow', '20')

    // Double-click restores default 50%
    fireEvent.doubleClick(resizer)
    expect(resizer).toHaveAttribute('aria-valuenow', '50')

    // Pointer drag with row-resize cursor & text-selection lock
    const splitContainer = changesSection.parentElement!
    vi.spyOn(splitContainer, 'getBoundingClientRect').mockReturnValue({
      top: 100,
      left: 0,
      right: 260,
      bottom: 600,
      width: 260,
      height: 500,
      x: 0,
      y: 100,
      toJSON: () => ({})
    })

    fireEvent.pointerDown(resizer, { button: 0, clientY: 350 })
    expect(document.body.style.cursor).toBe('row-resize')
    expect(document.body.style.userSelect).toBe('none')
    expect(document.body).toHaveClass('is-resizing-git-sections')

    fireEvent.pointerMove(window, { clientY: 450 }) // (450 - 100) / 500 = 0.7 -> 70%
    expect(resizer).toHaveAttribute('aria-valuenow', '70')
    expect(changesSection).toHaveStyle({ flex: '0.7 1 0%' })
    expect(graphSection).toHaveStyle({ flex: '0.3 1 0%' })

    fireEvent.pointerUp(window)
    expect(document.body.style.cursor).toBe('')
    expect(document.body.style.userSelect).toBe('')
    expect(document.body).not.toHaveClass('is-resizing-git-sections')

    // Mouse drag fallback
    fireEvent.mouseDown(resizer, { button: 0, clientY: 450 })
    expect(document.body.style.cursor).toBe('row-resize')
    fireEvent.mouseMove(window, { clientY: 425 }) // (425 - 100) / 500 = 0.65 -> 65%
    expect(resizer).toHaveAttribute('aria-valuenow', '65')
    fireEvent.mouseUp(window)
    expect(document.body.style.cursor).toBe('')

    // Collapsing Graph hides separator and lets Changes fill 100% of remaining height
    await user.click(within(region).getByRole('button', { name: /Graph/i }))
    expect(within(region).queryByRole('separator', { name: 'Git 섹션 높이 조절' })).not.toBeInTheDocument()
    expect(changesSection).toHaveStyle({ flex: '1 1 0%' })

    // Re-expanding Graph restores previous 65% ratio
    await user.click(within(region).getByRole('button', { name: /Graph/i }))
    const restoredResizer = within(region).getByRole('separator', { name: 'Git 섹션 높이 조절' })
    expect(restoredResizer).toHaveAttribute('aria-valuenow', '65')
    expect(changesSection).toHaveStyle({ flex: '0.65 1 0%' })
    expect(graphSection).toHaveStyle({ flex: '0.35 1 0%' })

    // Collapsing Changes hides separator and lets Graph fill 100% of remaining height
    await user.click(getChangesAccordionToggle(region))
    expect(within(region).queryByRole('separator', { name: 'Git 섹션 높이 조절' })).not.toBeInTheDocument()
    expect(graphSection).toHaveStyle({ flex: '1 1 0%' })
  })

  it('renders Graph scope toggle independently of accordion collapse and renders SVG lanes, ref badges, tooltips, and 더 보기 pagination', async () => {
    const user = userEvent.setup()
    const onChangeLogScope = vi.fn()
    const onLoadMoreCommits = vi.fn()
    const onToggleGraphCollapsed = vi.fn()

    const commits: GitGraphCommit[] = [
      {
        hash: '1111111222222233333334444444555555566666',
        shortHash: '1111111',
        parents: ['2222222000000000000000000000000000000000', '3333333000000000000000000000000000000000'],
        subject: 'Merge feature branch into main',
        authorName: 'Alice',
        committedAt: '2026-11-15T06:30:00Z',
        refs: [
          { name: 'HEAD', kind: 'head', isCurrentHead: true },
          { name: 'main', kind: 'local-branch', isCurrentHead: true },
          { name: 'origin/main', kind: 'remote-branch' },
          { name: 'v1.0.0', kind: 'tag' }
        ]
      },
      {
        hash: '2222222000000000000000000000000000000000',
        shortHash: '2222222',
        parents: ['3333333000000000000000000000000000000000'],
        subject: 'Update docs',
        authorName: 'Bob',
        committedAt: '2026-11-15T05:15:00Z',
        refs: [{ name: 'origin/unmerged', kind: 'remote-branch' }]
      },
      {
        hash: '3333333000000000000000000000000000000000',
        shortHash: '3333333',
        parents: [],
        subject: 'Initial wiki commit',
        authorName: 'Carol',
        committedAt: '2026-11-14T10:00:00Z',
        refs: [{ name: 'feature/side', kind: 'local-branch' }]
      }
    ]

    render(
      <GitSidebarPanel
        {...buildProps({
          graphState: {
            ...createInitialGitGraphState(),
            commits,
            hasMore: true,
            scope: 'all'
          },
          onChangeLogScope,
          onLoadMoreCommits,
          onToggleGraphCollapsed
        })}
      />
    )

    const graphRegion = screen.getByRole('region', { name: 'Graph' })
    const scopeBtn = within(graphRegion).getByRole('button', { name: 'Auto' })

    await user.click(scopeBtn)
    expect(onChangeLogScope).toHaveBeenCalledWith('current')
    expect(onToggleGraphCollapsed).not.toHaveBeenCalled()

    // Commit rows, right-aligned merged ref badges, 24px SVG lanes, and tooltips
    const list = within(graphRegion).getByRole('list', { name: '커밋 그래프' })
    const items = within(list).getAllByRole('listitem')
    expect(items).toHaveLength(3)

    const subjectEl = within(items[0]).getByText('Merge feature branch into main')
    const authorEl = within(items[0]).getByText('Alice')
    const mainBadge = within(items[0]).getByText('main').closest('.git-ref-badge') as HTMLElement
    const syncedCloud = within(items[0]).getByTitle('origin')
    const tagBadge = within(items[0]).getByText('v1.0.0').closest('.git-ref-badge') as HTMLElement

    expect(subjectEl).toBeInTheDocument()
    expect(authorEl).toBeInTheDocument()
    expect(within(items[0]).queryByText('HEAD')).toBeNull()
    expect(within(items[0]).queryByText('origin/main')).toBeNull()
    expect(mainBadge).toHaveClass('is-local-branch', 'is-current-head')
    expect(mainBadge.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    expect(syncedCloud).toHaveClass('is-synced-remote')
    expect(syncedCloud.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    expect(tagBadge).toHaveClass('is-tag')
    expect(tagBadge.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')

    // Subject -> author -> right-aligned ref badges order
    expect(subjectEl.compareDocumentPosition(authorEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(authorEl.compareDocumentPosition(mainBadge) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    // Standalone unmatched remote ref & non-checked-out local branch
    const standaloneRemoteBadge = within(items[1])
      .getByText('origin/unmerged')
      .closest('.git-ref-badge') as HTMLElement
    expect(standaloneRemoteBadge).toHaveClass('is-remote-branch')
    expect(standaloneRemoteBadge.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')

    const sideBranchBadge = within(items[2])
      .getByText('feature/side')
      .closest('.git-ref-badge') as HTMLElement
    expect(sideBranchBadge).toHaveClass('is-local-branch')
    expect(sideBranchBadge).not.toHaveClass('is-current-head')
    expect(sideBranchBadge.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')

    expect(items[0].getAttribute('title')).toMatch(
      /^1111111 · Alice · \d{4}-\d{2}-\d{2} \d{2}:\d{2} · Merge feature branch into main$/
    )

    // Compact 24px SVG lanes + HEAD emphasis ring + merge marker
    const firstSvg = items[0].querySelector('svg.git-graph-svg')
    expect(firstSvg).not.toBeNull()
    expect(firstSvg).toHaveAttribute('height', '24')
    expect(items[0].querySelector('circle.git-graph-head-ring')).not.toBeNull()
    expect(items[0].querySelector('circle.git-graph-merge-dot')).not.toBeNull()
    expect(items[1].querySelector('circle.git-graph-head-ring')).toBeNull()
    expect(items[1].querySelector('circle.git-graph-merge-dot')).toBeNull()

    // More pagination button
    const loadMoreBtn = within(graphRegion).getByRole('button', { name: '더 보기' })
    await user.click(loadMoreBtn)
    expect(onLoadMoreCommits).toHaveBeenCalledTimes(1)
  })

  it('toggles inline commit detail panel, displays metadata and changed files, and copies full hash', async () => {
    const user = userEvent.setup()
    const onToggleCommitDetail = vi.fn()
    const fullHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const baseGraph = createInitialGitGraphState()
    const commits = [
      {
        hash: fullHash,
        shortHash: 'aaaaaaa',
        parents: ['bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
        subject: 'feat: add inline detail',
        authorName: 'Alice',
        committedAt: '2026-11-15T09:00:00+09:00',
        refs: [{ name: 'main', kind: 'local-branch' as const }]
      },
      {
        hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        shortHash: 'bbbbbbb',
        parents: [],
        subject: 'chore: initial commit',
        authorName: 'Bob',
        committedAt: '2026-11-14T09:00:00+09:00',
        refs: []
      }
    ]

    const { rerender } = render(
      <GitSidebarPanel
        {...buildProps({
          onToggleCommitDetail,
          graphState: {
            ...baseGraph,
            commits
          }
        })}
      />
    )

    const graphRegion = screen.getByRole('region', { name: 'Graph' })
    const firstRowBtn = within(graphRegion).getByRole('button', { name: /feat: add inline detail/ })
    expect(firstRowBtn.getAttribute('aria-expanded')).toBe('false')
    await user.click(firstRowBtn)
    expect(onToggleCommitDetail).toHaveBeenCalledWith(fullHash)

    // Loading state
    rerender(
      <GitSidebarPanel
        {...buildProps({
          onToggleCommitDetail,
          graphState: {
            ...baseGraph,
            commits,
            commitDetail: {
              status: 'loading',
              selectedHash: fullHash
            }
          }
        })}
      />
    )
    expect(within(graphRegion).getByText('커밋 상세를 불러오는 중...')).toBeInTheDocument()

    // Error state
    rerender(
      <GitSidebarPanel
        {...buildProps({
          onToggleCommitDetail,
          graphState: {
            ...baseGraph,
            commits,
            commitDetail: {
              status: 'error',
              selectedHash: fullHash,
              errorMessage: '상세 조회 실패'
            }
          }
        })}
      />
    )
    expect(within(graphRegion).getByRole('alert')).toHaveTextContent('상세 조회 실패')

    // Loaded state with body and A/M/D/R files
    rerender(
      <GitSidebarPanel
        {...buildProps({
          onToggleCommitDetail,
          graphState: {
            ...baseGraph,
            commits,
            commitDetail: {
              status: 'loaded',
              selectedHash: fullHash,
              detail: {
                hash: fullHash,
                shortHash: 'aaaaaaa',
                parents: ['bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
                subject: 'feat: add inline detail',
                body: 'First detail line\nSecond detail line',
                authorName: 'Alice',
                authorEmail: 'alice@example.com',
                committedAt: '2026-11-15T09:00:00+09:00',
                files: [
                  { status: 'A', path: 'notes/new.md' },
                  { status: 'M', path: 'README.md' },
                  { status: 'D', path: 'legacy.md' },
                  { status: 'R', origPath: 'old/title.md', path: 'new/title.md' }
                ]
              }
            }
          }
        })}
      />
    )

    const expandedBtn = within(graphRegion).getByRole('button', { name: /feat: add inline detail/ })
    expect(expandedBtn.getAttribute('aria-expanded')).toBe('true')
    const detailRegion = within(graphRegion).getByRole('region', { name: 'aaaaaaa 커밋 상세' })
    expect(detailRegion).toHaveTextContent('aaaaaaa')
    expect(detailRegion).toHaveTextContent('First detail line')
    expect(detailRegion).toHaveTextContent('Second detail line')
    expect(detailRegion).toHaveTextContent('alice@example.com')
    expect(detailRegion).toHaveTextContent('변경된 파일 (4)')
    expect(within(detailRegion).getByText('new.md')).toBeInTheDocument()
    expect(within(detailRegion).getByText('notes')).toBeInTheDocument()
    expect(within(detailRegion).getByText('README.md')).toBeInTheDocument()
    const deletedDetailFile = within(detailRegion).getByText('legacy.md')
    expect(deletedDetailFile).toHaveClass('is-deleted')
    expect(within(detailRegion).getByText('old/title.md → title.md')).toBeInTheDocument()
    expect(within(detailRegion).getByText('new')).toBeInTheDocument()
    expect(within(detailRegion).getByTitle('old/title.md → new/title.md')).toBeInTheDocument()
    expect(within(detailRegion).getByText('A')).toHaveClass('git-status-letter', 'is-green')
    expect(within(detailRegion).getByText('M')).toHaveClass('git-status-letter', 'is-amber')
    expect(within(detailRegion).getByText('D')).toHaveClass('git-status-letter', 'is-red')
    expect(within(detailRegion).getByText('R')).toHaveClass('git-status-letter', 'is-accent')
    expect(within(detailRegion).queryByRole('button', { name: /파일 열기|롤백|Stage|Unstage/ })).toBeNull()

    // Copy full hash button uses lucide-react icon and preserves accessible label while showing feedback
    const writeTextSpy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
    try {
      const copyBtn = within(detailRegion).getByRole('button', { name: '해시 복사' })
      expect(copyBtn.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
      expect(copyBtn).not.toHaveTextContent('복사')
      await user.click(copyBtn)
      expect(writeTextSpy).toHaveBeenCalledWith(fullHash)
      const copiedBtn = within(detailRegion).getByRole('button', { name: '해시 복사' })
      expect(copiedBtn.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
      expect(copiedBtn).toHaveTextContent('복사됨')
    } finally {
      writeTextSpy.mockRestore()
    }

    // Read-only guarantee: no checkout/reset/branch creation actions inside detail panel
    expect(within(detailRegion).queryByRole('button', { name: /checkout|reset|revert|branch/i })).toBeNull()

    // Empty body and empty changed files state
    rerender(
      <GitSidebarPanel
        {...buildProps({
          onToggleCommitDetail,
          graphState: {
            ...baseGraph,
            commits,
            commitDetail: {
              status: 'loaded',
              selectedHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              detail: {
                hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                shortHash: 'bbbbbbb',
                parents: [],
                subject: 'chore: initial commit',
                body: '',
                authorName: 'Bob',
                authorEmail: 'bob@example.com',
                committedAt: '2026-11-14T09:00:00+09:00',
                files: []
              }
            }
          }
        })}
      />
    )
    const emptyDetailRegion = within(graphRegion).getByRole('region', { name: 'bbbbbbb 커밋 상세' })
    expect(emptyDetailRegion).toHaveTextContent('변경된 파일이 없습니다.')
    expect(emptyDetailRegion.querySelector('.git-commit-detail-body')).toBeNull()
  })

  it('opens staged/unstaged diffs on file item click without firing diff on +/- stage buttons', async () => {
    const user = userEvent.setup()
    const onOpenFileDiff = vi.fn()
    const onStageFile = vi.fn()
    const onUnstageFile = vi.fn()

    render(
      <GitSidebarPanel
        {...buildProps({
          status: buildGitStatus({
            staged: [{ path: 'docs/renamed.md', origPath: 'docs/old.md', status: 'R' }],
            unstaged: [{ path: 'README.md', status: 'M' }],
            untracked: [{ path: 'notes.md', status: '?' }]
          }),
          onOpenFileDiff,
          onStageFile,
          onUnstageFile
        })}
      />
    )

    await user.click(screen.getByText('old.md → renamed.md'))
    expect(onOpenFileDiff).toHaveBeenCalledWith({
      kind: 'staged',
      path: 'docs/renamed.md',
      origPath: 'docs/old.md',
      status: 'R'
    })

    await user.click(screen.getByText('README.md'))
    expect(onOpenFileDiff).toHaveBeenCalledWith({
      kind: 'unstaged',
      path: 'README.md',
      status: 'M'
    })

    await user.click(screen.getByText('notes.md'))
    expect(onOpenFileDiff).toHaveBeenCalledWith({
      kind: 'unstaged',
      path: 'notes.md',
      status: '?'
    })

    onOpenFileDiff.mockClear()

    await user.click(screen.getByRole('button', { name: 'docs/renamed.md Unstage' }))
    expect(onUnstageFile).toHaveBeenCalledWith('docs/renamed.md', 'docs/old.md')
    expect(onOpenFileDiff).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'README.md Stage' }))
    expect(onStageFile).toHaveBeenCalledWith('README.md')
    expect(onOpenFileDiff).not.toHaveBeenCalled()
  })

  it('opens commit diff requests when clicking changed files inside expanded graph commit detail', async () => {
    const user = userEvent.setup()
    const onOpenFileDiff = vi.fn()
    const onToggleCommitDetail = vi.fn()
    const fullHash = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'
    const baseGraph = createInitialGitGraphState()

    render(
      <GitSidebarPanel
        {...buildProps({
          onOpenFileDiff,
          onToggleCommitDetail,
          graphState: {
            ...baseGraph,
            commits: [
              {
                hash: fullHash,
                shortHash: 'a1b2c3d',
                parents: [],
                subject: 'feat: graph commit diff',
                authorName: 'Alice',
                committedAt: '2026-11-15T09:00:00+09:00',
                refs: [{ name: 'main', kind: 'local-branch' as const }]
              }
            ],
            commitDetail: {
              status: 'loaded',
              selectedHash: fullHash,
              detail: {
                hash: fullHash,
                shortHash: 'a1b2c3d',
                parents: [],
                subject: 'feat: graph commit diff',
                body: '',
                authorName: 'Alice',
                authorEmail: 'alice@example.com',
                committedAt: '2026-11-15T09:00:00+09:00',
                files: [
                  { status: 'M', path: 'docs/guide.md' },
                  { status: 'D', path: 'docs/deleted.md' },
                  { status: 'R', origPath: 'docs/old.md', path: 'docs/renamed.md' }
                ]
              }
            }
          }
        })}
      />
    )

    const detailRegion = screen.getByRole('region', { name: 'a1b2c3d 커밋 상세' })

    await user.click(within(detailRegion).getByTitle('docs/guide.md'))
    expect(onOpenFileDiff).toHaveBeenCalledWith({
      kind: 'commit',
      commitHash: fullHash,
      shortHash: 'a1b2c3d',
      path: 'docs/guide.md',
      status: 'M'
    })

    await user.click(within(detailRegion).getByTitle('docs/deleted.md'))
    expect(onOpenFileDiff).toHaveBeenCalledWith({
      kind: 'commit',
      commitHash: fullHash,
      shortHash: 'a1b2c3d',
      path: 'docs/deleted.md',
      status: 'D'
    })

    await user.click(within(detailRegion).getByTitle('docs/old.md → docs/renamed.md'))
    expect(onOpenFileDiff).toHaveBeenCalledWith({
      kind: 'commit',
      commitHash: fullHash,
      shortHash: 'a1b2c3d',
      path: 'docs/renamed.md',
      origPath: 'docs/old.md',
      status: 'R'
    })

    expect(onToggleCommitDetail).not.toHaveBeenCalled()
  })

  it('renders Git panel fixed non-collapsible header, 26px branch subrow, and always keeps the body visible', async () => {
    const user = userEvent.setup()
    const onRefresh = vi.fn()

    const { rerender } = render(
      <GitSidebarPanel
        {...buildProps({
          onRefresh
        })}
      />
    )

    const region = screen.getByRole('region', { name: 'Git 소스 제어' })
    const title = within(region).getByText('Source Control')
    const header = title.closest('.git-header') as HTMLElement
    const refreshBtn = within(header).getByRole('button', { name: 'Git 상태 새로고침' })
    const moreBtn = within(header).getByRole('button', { name: '더 보기' })

    expect(title.closest('button')).toBeNull()
    expect(refreshBtn).not.toHaveAttribute('aria-expanded')
    expect(refreshBtn.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    expect(moreBtn.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    expect(within(header).queryByText('▾')).not.toBeInTheDocument()
    expect(within(header).queryByText('▸')).not.toBeInTheDocument()

    await user.click(title)
    expect(within(region).getByRole('button', { name: '현재 브랜치 main' })).toBeInTheDocument()
    expect(within(region).getByRole('button', { name: /Sync.*↓1 ↑2/ })).toBeInTheDocument()
    expect(within(region).getByLabelText('커밋 메시지')).toBeInTheDocument()
    expect(within(region).getByRole('group', { name: 'Staged Changes' })).toBeInTheDocument()
    expect(within(region).getByRole('group', { name: 'Changes' })).toBeInTheDocument()

    await user.click(refreshBtn)
    expect(onRefresh).toHaveBeenCalledTimes(1)

    rerender(
      <GitSidebarPanel
        {...buildProps({
          workspaceRootPath: null,
          status: null,
          branchList: null
        })}
      />
    )
    expect(within(region).getByText('Source Control')).toBeInTheDocument()
    expect(within(region).getByText(/워크스페이스를 먼저 열어주세요/)).toBeInTheDocument()
    expect(within(region).queryByRole('button', { name: /현재 브랜치/ })).not.toBeInTheDocument()
    expect(within(region).getByRole('button', { name: 'Git 상태 새로고침' })).toBeDisabled()
    expect(within(region).getByRole('button', { name: '더 보기' })).toBeDisabled()
  })

  it('supports ... more menu items, separator, disabled guards, outside click / Escape dismissal, and branch subrow states (unpublished, unborn, detached)', async () => {
    const user = userEvent.setup()
    const onPull = vi.fn()
    const onPush = vi.fn()
    const onFetch = vi.fn()
    const onSync = vi.fn()
    const onStageAll = vi.fn()
    const onUnstageAll = vi.fn()
    const onDiscardAll = vi.fn()
    const onOpenStashDialog = vi.fn()
    const onClearStashes = vi.fn()
    const onCheckoutBranch = vi.fn()

    const { rerender } = render(
      <GitSidebarPanel
        {...buildProps({
          status: buildGitStatus({
            hasUpstream: false,
            ahead: 0,
            behind: 0,
            staged: [],
            unstaged: [{ path: 'README.md', status: 'M' }],
            untracked: []
          }),
          stashes: [
            {
              ref: 'stash@{0}',
              hash: '1111111111111111111111111111111111111111',
              branch: 'main',
              message: 'saved wip',
              createdAt: '2026-11-20T12:00:00Z'
            }
          ],
          onPull,
          onPush,
          onFetch,
          onSync,
          onStageAll,
          onUnstageAll,
          onDiscardAll,
          onOpenStashDialog,
          onClearStashes,
          onCheckoutBranch
        })}
      />
    )

    const region = screen.getByRole('region', { name: 'Git 소스 제어' })

    // 1. Unpublished local branch shows 미게시 and clicking executes Publish/Push
    const publishBtn = within(region).getByRole('button', { name: /미게시/ })
    expect(publishBtn).toBeEnabled()
    await user.click(publishBtn)
    expect(onPush).toHaveBeenCalledTimes(1)

    // 2. ... menu lists remote, bulk changes, and stash items with separators, and dismisses on Escape / outside click
    const moreBtn = within(region).getByRole('button', { name: '더 보기' })
    await user.click(moreBtn)
    const moreMenu = within(region).getByRole('menu', { name: 'Git 패널 추가 작업' })
    expect(within(moreMenu).getAllByRole('separator')).toHaveLength(2)
    expect(within(moreMenu).getByRole('menuitem', { name: 'Pull' })).toBeEnabled()
    expect(within(moreMenu).getByRole('menuitem', { name: 'Push' })).toBeEnabled()
    expect(within(moreMenu).getByRole('menuitem', { name: 'Fetch' })).toBeEnabled()
    expect(within(moreMenu).getByRole('menuitem', { name: 'Sync' })).toBeEnabled()
    expect(within(moreMenu).getByRole('menuitem', { name: 'Stage All Changes' })).toBeEnabled()
    expect(within(moreMenu).getByRole('menuitem', { name: 'Unstage All Changes' })).toBeDisabled()
    expect(within(moreMenu).getByRole('menuitem', { name: 'Discard All Changes' })).toBeEnabled()
    expect(within(moreMenu).getByRole('menuitem', { name: 'Stash Changes...' })).toBeEnabled()
    expect(within(moreMenu).getByRole('menuitem', { name: 'Stash All Changes...' })).toBeEnabled()
    const clearAllMenuItem = within(moreMenu).getByRole('menuitem', { name: 'Clear All Stashes' })
    expect(clearAllMenuItem).toBeEnabled()
    expect(clearAllMenuItem).toHaveClass('is-danger')

    await user.keyboard('{Escape}')
    expect(within(region).queryByRole('menu', { name: 'Git 패널 추가 작업' })).not.toBeInTheDocument()

    await user.click(moreBtn)
    expect(within(region).getByRole('menu', { name: 'Git 패널 추가 작업' })).toBeInTheDocument()
    fireEvent.mouseDown(document.body)
    expect(within(region).queryByRole('menu', { name: 'Git 패널 추가 작업' })).not.toBeInTheDocument()

    await user.click(moreBtn)
    await user.click(within(region).getByRole('menuitem', { name: 'Stage All Changes' }))
    expect(onStageAll).toHaveBeenCalledTimes(1)

    await user.click(moreBtn)
    await user.click(within(region).getByRole('menuitem', { name: 'Discard All Changes' }))
    expect(onDiscardAll).toHaveBeenCalledTimes(1)

    await user.click(moreBtn)
    await user.click(within(region).getByRole('menuitem', { name: 'Stash Changes...' }))
    expect(onOpenStashDialog).toHaveBeenCalledWith('unstaged')

    await user.click(moreBtn)
    await user.click(within(region).getByRole('menuitem', { name: 'Stash All Changes...' }))
    expect(onOpenStashDialog).toHaveBeenCalledWith('all')

    await user.click(moreBtn)
    await user.click(within(region).getByRole('menuitem', { name: 'Clear All Stashes' }))
    expect(onClearStashes).toHaveBeenCalledTimes(1)

    // 3. Staged-only repo with 0 stashes enables Unstage/Stash All Changes and disables Stage/Discard/Stash Changes.../Clear All Stashes
    rerender(
      <GitSidebarPanel
        {...buildProps({
          status: buildGitStatus({
            staged: [{ path: 'README.md', status: 'M' }],
            unstaged: [],
            untracked: []
          }),
          stashes: [],
          onStageAll,
          onUnstageAll,
          onDiscardAll,
          onOpenStashDialog,
          onClearStashes,
          onCheckoutBranch
        })}
      />
    )
    await user.click(moreBtn)
    expect(within(region).getByRole('menuitem', { name: 'Stage All Changes' })).toBeDisabled()
    expect(within(region).getByRole('menuitem', { name: 'Discard All Changes' })).toBeDisabled()
    expect(within(region).getByRole('menuitem', { name: 'Stash Changes...' })).toBeDisabled()
    expect(within(region).getByRole('menuitem', { name: 'Stash All Changes...' })).toBeEnabled()
    expect(within(region).getByRole('menuitem', { name: 'Clear All Stashes' })).toBeDisabled()
    await user.click(within(region).getByRole('menuitem', { name: 'Unstage All Changes' }))
    expect(onUnstageAll).toHaveBeenCalledTimes(1)

    // 4. Branch picker dismisses on Escape and outside click, and ignores clicking the active branch
    const branchBtn = within(region).getByRole('button', { name: '현재 브랜치 main' })
    await user.click(branchBtn)
    const branchMenu = within(region).getByRole('menu', { name: '브랜치 선택' })
    await user.click(within(branchMenu).getByRole('menuitem', { name: 'main' }))
    expect(onCheckoutBranch).not.toHaveBeenCalled()
    expect(within(region).queryByRole('menu', { name: '브랜치 선택' })).not.toBeInTheDocument()

    await user.click(branchBtn)
    expect(within(region).getByRole('menu', { name: '브랜치 선택' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(within(region).queryByRole('menu', { name: '브랜치 선택' })).not.toBeInTheDocument()

    await user.click(branchBtn)
    expect(within(region).getByRole('menu', { name: '브랜치 선택' })).toBeInTheDocument()
    fireEvent.mouseDown(document.body)
    expect(within(region).queryByRole('menu', { name: '브랜치 선택' })).not.toBeInTheDocument()

    // 5. Unborn repo disables remote trigger and empty branch picker
    rerender(
      <GitSidebarPanel
        {...buildProps({
          status: buildGitStatus({
            isUnborn: true,
            hasUpstream: false,
            ahead: 0,
            behind: 0,
            staged: [],
            unstaged: [],
            untracked: []
          }),
          branchList: { current: 'main', isDetached: false, branches: [] }
        })}
      />
    )
    expect(within(region).getByRole('button', { name: '현재 브랜치 main' })).toBeDisabled()
    expect(within(region).getByRole('button', { name: /미게시/ })).toBeDisabled()

    // 6. Detached HEAD displays (detached), disables remote trigger, and allows switching to local branch
    rerender(
      <GitSidebarPanel
        {...buildProps({
          status: buildGitStatus({
            branch: null,
            isDetached: true,
            hasUpstream: false,
            ahead: 0,
            behind: 0
          }),
          branchList: {
            current: null,
            isDetached: true,
            branches: [{ name: 'main', current: false, upstream: 'origin/main' }]
          },
          onCheckoutBranch
        })}
      />
    )
    const detachedPicker = within(region).getByRole('button', { name: '현재 브랜치 (detached)' })
    expect(detachedPicker).toHaveTextContent('(detached)')
    expect(detachedPicker).toBeEnabled()
    expect(within(region).getByRole('button', { name: /미게시/ })).toBeDisabled()

    await user.click(detachedPicker)
    await user.click(within(region).getByRole('menuitem', { name: 'main' }))
    expect(onCheckoutBranch).toHaveBeenCalledWith('main')
  })

  it('renders permanent ↶ button left of + only on 변경 사항 rows, disables it when busy, and does not open diff on click', async () => {
    const user = userEvent.setup()
    const onDiscardFile = vi.fn()
    const onOpenFileDiff = vi.fn()
    const onStageFile = vi.fn()

    const { rerender } = render(
      <GitSidebarPanel
        {...buildProps({
          status: buildGitStatus({
            staged: [{ path: 'staged-only.md', status: 'M' }],
            unstaged: [
              { path: 'modified.md', status: 'M' },
              { path: 'conflict.md', status: 'U' }
            ],
            untracked: [{ path: 'draft.md', status: '?' }]
          }),
          onDiscardFile,
          onOpenFileDiff,
          onStageFile
        })}
      />
    )

    const region = screen.getByRole('region', { name: 'Git 소스 제어' })
    expect(
      within(region).queryByRole('button', { name: 'staged-only.md 변경 사항 롤백' })
    ).not.toBeInTheDocument()

    for (const filePath of ['modified.md', 'conflict.md', 'draft.md']) {
      const discardBtn = within(region).getByRole('button', { name: `${filePath} 변경 사항 롤백` })
      const stageBtn = within(region).getByRole('button', { name: `${filePath} Stage` })
      expect(discardBtn).toHaveAttribute('title', '변경 사항 롤백')
      expect(discardBtn.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
      expect(discardBtn).toBeEnabled()
      expect(
        discardBtn.compareDocumentPosition(stageBtn) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy()
    }

    await user.click(within(region).getByRole('button', { name: 'modified.md 변경 사항 롤백' }))
    await user.click(within(region).getByRole('button', { name: 'conflict.md 변경 사항 롤백' }))
    await user.click(within(region).getByRole('button', { name: 'draft.md 변경 사항 롤백' }))
    expect(onDiscardFile.mock.calls).toEqual([['modified.md'], ['conflict.md'], ['draft.md']])
    expect(onOpenFileDiff).not.toHaveBeenCalled()
    expect(onStageFile).not.toHaveBeenCalled()

    rerender(
      <GitSidebarPanel
        {...buildProps({
          pendingAction: '변경 사항 롤백',
          onDiscardFile
        })}
      />
    )
    expect(
      within(region).getByRole('button', { name: 'README.md 변경 사항 롤백' })
    ).toBeDisabled()
    expect(
      within(region).getByRole('button', { name: 'notes.md 변경 사항 롤백' })
    ).toBeDisabled()
  })

  it('renders permanent 전체 ↶ button left of 전체 + only in 변경 사항 header, disables when empty or busy, and triggers onDiscardAll', async () => {
    const user = userEvent.setup()
    const onDiscardAll = vi.fn()

    const { rerender } = render(
      <GitSidebarPanel
        {...buildProps({
          status: buildGitStatus({
            staged: [{ path: 'staged.md', status: 'M' }],
            unstaged: [{ path: 'modified.md', status: 'M' }],
            untracked: [{ path: 'draft.md', status: '?' }]
          }),
          onDiscardAll
        })}
      />
    )

    const region = screen.getByRole('region', { name: 'Git 소스 제어' })
    const discardAllButtons = within(region).getAllByRole('button', {
      name: '전체 변경 사항 롤백'
    })
    expect(discardAllButtons).toHaveLength(1)

    const discardAllBtn = discardAllButtons[0]
    const stageAllBtn = within(region).getByRole('button', { name: '전체 Stage' })
    const stagedSection = within(region).getByRole('group', { name: 'Staged Changes' })
    expect(
      within(stagedSection).queryByRole('button', { name: '전체 변경 사항 롤백' })
    ).not.toBeInTheDocument()

    expect(discardAllBtn).toHaveAttribute('title', '전체 변경 사항 롤백')
    expect(discardAllBtn.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    expect(discardAllBtn).toBeEnabled()
    expect(
      discardAllBtn.compareDocumentPosition(stageAllBtn) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()

    await user.click(discardAllBtn)
    expect(onDiscardAll).toHaveBeenCalledTimes(1)

    // Disabled when 변경 사항 has 0 files even if 스테이지됨 is non-empty
    rerender(
      <GitSidebarPanel
        {...buildProps({
          status: buildGitStatus({
            staged: [{ path: 'staged.md', status: 'M' }],
            unstaged: [],
            untracked: []
          }),
          onDiscardAll
        })}
      />
    )
    expect(within(region).getByRole('button', { name: '전체 변경 사항 롤백' })).toBeDisabled()

    // Disabled when busy
    rerender(
      <GitSidebarPanel
        {...buildProps({
          pendingAction: '전체 변경 사항 롤백',
          onDiscardAll
        })}
      />
    )
    expect(within(region).getByRole('button', { name: '전체 변경 사항 롤백' })).toBeDisabled()
  })

  it('renders 1-line auto-resizing commit input with branch placeholder and Cmd+Enter shortcut', async () => {
    const user = userEvent.setup()
    const onCommit = vi.fn().mockResolvedValue(true)

    const { rerender } = render(
      <GitSidebarPanel
        {...buildProps({
          status: buildGitStatus({ branch: 'feature/cta' }),
          onCommit
        })}
      />
    )

    const region = screen.getByRole('region', { name: 'Git 소스 제어' })
    const input = within(region).getByPlaceholderText(
      '메시지 (Ctrl+Enter로 "feature/cta"에 커밋)'
    ) as HTMLTextAreaElement
    expect(input).toHaveAttribute('rows', '1')

    let measuredScrollHeight = 28
    Object.defineProperty(input, 'scrollHeight', {
      configurable: true,
      get: () => measuredScrollHeight
    })

    // Input expands up to max-height (120px) and shrinks back when cleared
    measuredScrollHeight = 76
    await user.type(input, 'line 1\nline 2')
    expect(input.style.height).toBe('76px')

    measuredScrollHeight = 220
    await user.type(input, '\nline 3\nline 4\nline 5')
    expect(input.style.height).toBe('120px')

    // Cmd+Enter triggers commit and resets input height on clear
    measuredScrollHeight = 28
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true })
    expect(onCommit).toHaveBeenCalledWith('line 1\nline 2\nline 3\nline 4\nline 5', 'commit')
    await vi.waitFor(() => {
      expect(input.value).toBe('')
    })
    expect(input.style.height).toBe('28px')

    // Detached HEAD placeholder updates dynamically
    rerender(
      <GitSidebarPanel
        {...buildProps({
          status: buildGitStatus({ branch: null, isDetached: true }),
          onCommit
        })}
      />
    )
    expect(
      within(region).getByPlaceholderText('메시지 (Ctrl+Enter로 "(detached)"에 커밋)')
    ).toBeInTheDocument()
  })

  it('renders Commit split dropdown (Commit / Commit & Push / Commit & Sync), validates empty message before commit, handles outside click / Escape, and switches CTA for Publish Branch / Sync Changes / conflicts', async () => {
    const user = userEvent.setup()
    const onCommit = vi.fn().mockResolvedValue(false)
    const onPush = vi.fn()
    const onSync = vi.fn()

    const { rerender } = render(
      <GitSidebarPanel
        {...buildProps({
          status: buildGitStatus({
            staged: [],
            unstaged: [{ path: 'README.md', status: 'M' }],
            untracked: []
          }),
          onCommit,
          onPush,
          onSync
        })}
      />
    )

    const region = screen.getByRole('region', { name: 'Git 소스 제어' })
    const input = within(region).getByLabelText('커밋 메시지') as HTMLTextAreaElement
    const commitMainBtn = within(region).getByRole('button', { name: 'Commit' })
    const commitDropdownBtn = within(region).getByRole('button', { name: '커밋 작업 더 보기' })

    expect(commitMainBtn).toBeEnabled()
    expect(commitDropdownBtn).toBeEnabled()

    // 1. Staged=0 + blank message via dropdown validates inline without invoking onCommit
    await user.click(commitDropdownBtn)
    const menu = within(region).getByRole('menu', { name: '커밋 옵션' })
    expect(within(menu).getByRole('menuitem', { name: 'Commit' })).toBeInTheDocument()
    expect(within(menu).getByRole('menuitem', { name: 'Commit & Push' })).toBeInTheDocument()
    expect(within(menu).getByRole('menuitem', { name: 'Commit & Sync' })).toBeInTheDocument()

    await user.click(within(menu).getByRole('menuitem', { name: 'Commit & Push' }))
    expect(onCommit).not.toHaveBeenCalled()
    expect(within(region).getByText('커밋 메시지를 입력하세요.')).toBeInTheDocument()
    expect(within(region).queryByRole('menu', { name: '커밋 옵션' })).not.toBeInTheDocument()

    // 2. Escape restores focus to toggle and outside click closes dropdown
    await user.click(commitDropdownBtn)
    expect(within(region).getByRole('menu', { name: '커밋 옵션' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(within(region).queryByRole('menu', { name: '커밋 옵션' })).not.toBeInTheDocument()
    expect(commitDropdownBtn).toHaveFocus()

    await user.click(commitDropdownBtn)
    fireEvent.mouseDown(document.body)
    expect(within(region).queryByRole('menu', { name: '커밋 옵션' })).not.toBeInTheDocument()

    // 3. Staged=0 + valid message preserves message when onCommit returns false (e.g. cancelled dialog)
    await user.type(input, 'feat: staged zero')
    await user.click(commitDropdownBtn)
    await user.click(within(region).getByRole('menuitem', { name: 'Commit & Sync' }))
    expect(onCommit).toHaveBeenCalledWith('feat: staged zero', 'commit-sync')
    expect(input.value).toBe('feat: staged zero')

    // When onCommit returns true, message clears
    onCommit.mockResolvedValueOnce(true)
    await user.click(commitDropdownBtn)
    await user.click(within(region).getByRole('menuitem', { name: 'Commit & Push' }))
    expect(onCommit).toHaveBeenLastCalledWith('feat: staged zero', 'commit-push')
    await vi.waitFor(() => {
      expect(input.value).toBe('')
    })

    // 4. Clean + no upstream -> Publish Branch calls onPush
    rerender(
      <GitSidebarPanel
        {...buildProps({
          status: buildGitStatus({
            hasUpstream: false,
            ahead: 0,
            behind: 0,
            staged: [],
            unstaged: [],
            untracked: []
          }),
          onCommit,
          onPush,
          onSync
        })}
      />
    )
    const publishCta = within(region).getByRole('button', { name: 'Publish Branch' })
    await user.click(publishCta)
    expect(onPush).toHaveBeenCalledTimes(1)
    expect(within(region).queryByRole('button', { name: 'Commit' })).not.toBeInTheDocument()

    // 5. Clean + ahead/behind -> Sync Changes N↓ M↑ calls onSync
    rerender(
      <GitSidebarPanel
        {...buildProps({
          status: buildGitStatus({
            hasUpstream: true,
            ahead: 2,
            behind: 3,
            staged: [],
            unstaged: [],
            untracked: []
          }),
          onCommit,
          onPush,
          onSync
        })}
      />
    )
    const syncCta = within(region).getByRole('button', { name: 'Sync Changes 3↓ 2↑' })
    await user.click(syncCta)
    expect(onSync).toHaveBeenCalledTimes(1)

    // 6. Clean + synced -> Commit split button & dropdown both disabled
    rerender(
      <GitSidebarPanel
        {...buildProps({
          status: buildGitStatus({
            hasUpstream: true,
            ahead: 0,
            behind: 0,
            staged: [],
            unstaged: [],
            untracked: []
          }),
          onCommit,
          onPush,
          onSync
        })}
      />
    )
    expect(within(region).getByRole('button', { name: 'Commit' })).toBeDisabled()
    expect(within(region).getByRole('button', { name: '커밋 작업 더 보기' })).toBeDisabled()

    // 7. Merge conflicts disable both Commit & dropdown and keep conflict guidance
    rerender(
      <GitSidebarPanel
        {...buildProps({
          status: buildGitStatus({
            hasConflicts: true,
            staged: [],
            unstaged: [{ path: 'conflict.md', status: 'U' }],
            untracked: []
          }),
          onCommit,
          onPush,
          onSync
        })}
      />
    )
    expect(within(region).getByRole('button', { name: 'Commit' })).toBeDisabled()
    expect(within(region).getByRole('button', { name: '커밋 작업 더 보기' })).toBeDisabled()
    expect(
      within(region).getByText('병합 충돌 파일을 해결하고 Stage(+)한 후 커밋하세요.')
    ).toBeInTheDocument()
  })

  it('renders Changes header icon toolbar (view toggle, Commit ✓, refresh ↻), hides empty Staged Changes, and supports subgroup collapse with bulk icons', async () => {
    const user = userEvent.setup()
    const onRefresh = vi.fn()
    const onCommit = vi.fn().mockResolvedValue(true)
    const onStageAll = vi.fn()
    const onUnstageAll = vi.fn()
    const onDiscardAll = vi.fn()

    const { rerender } = render(
      <StatefulGitSidebarPanel
        {...buildProps({
          status: buildGitStatus({
            staged: [],
            unstaged: [{ path: 'docs/guide.md', status: 'M' }],
            untracked: [{ path: 'draft.md', status: '?' }]
          }),
          onRefresh,
          onCommit,
          onStageAll,
          onUnstageAll,
          onDiscardAll
        })}
      />
    )

    const region = screen.getByRole('region', { name: 'Git 소스 제어' })
    const changesSection = within(region).getByRole('region', { name: 'Changes' })

    // 1. Staged Changes is hidden when staged=0; Changes subgroup renders with count 2
    expect(within(changesSection).queryByRole('group', { name: 'Staged Changes' })).toBeNull()
    const changesGroup = within(changesSection).getByRole('group', { name: 'Changes' })
    expect(within(changesGroup).getByRole('button', { name: 'Changes' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(within(changesGroup).getByText('2')).toBeInTheDocument()

    // 2. Changes header icon toolbar: view toggle, Commit ✓, Refresh ↻
    const viewToggleBtn = within(changesSection).getByRole('button', { name: '트리 보기로 전환' })
    const headerCommitBtn = within(changesSection).getByRole('button', { name: '변경 사항 커밋' })
    const headerRefreshBtn = within(changesSection).getByRole('button', {
      name: '변경 사항 새로고침'
    })
    expect(viewToggleBtn.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    expect(headerCommitBtn.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    expect(headerRefreshBtn.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')

    await user.click(headerRefreshBtn)
    expect(onRefresh).toHaveBeenCalledTimes(1)

    // Header Commit ✓ validates blank message first, then submits non-empty message through smart commit flow
    await user.click(headerCommitBtn)
    expect(onCommit).not.toHaveBeenCalled()
    expect(within(changesSection).getByText('커밋 메시지를 입력하세요.')).toBeInTheDocument()

    // Collapse Changes accordion, then click header Commit ✓ with blank message -> re-expands Changes to surface validation
    await user.click(getChangesAccordionToggle(region))
    expect(within(changesSection).queryByLabelText('커밋 메시지')).not.toBeInTheDocument()
    await user.click(headerCommitBtn)
    expect(await within(changesSection).findByLabelText('커밋 메시지')).toBeInTheDocument()

    const commitInput = within(changesSection).getByLabelText('커밋 메시지') as HTMLTextAreaElement
    await user.type(commitInput, 'feat: header check commit')
    await user.click(headerCommitBtn)
    expect(onCommit).toHaveBeenCalledWith('feat: header check commit', 'commit')
    await vi.waitFor(() => {
      expect(commitInput.value).toBe('')
    })

    // 3. With staged >= 1, Staged Changes renders with collapse toggle, count badge, and bulk Unstage (-)
    rerender(
      <StatefulGitSidebarPanel
        {...buildProps({
          status: buildGitStatus({
            staged: [{ path: 'docs/staged.md', status: 'A' }],
            unstaged: [{ path: 'docs/guide.md', status: 'M' }],
            untracked: []
          }),
          onRefresh,
          onCommit,
          onStageAll,
          onUnstageAll,
          onDiscardAll
        })}
      />
    )

    const stagedGroup = within(changesSection).getByRole('group', { name: 'Staged Changes' })
    const stagedToggle = within(stagedGroup).getByRole('button', { name: /Staged Changes/ })
    expect(stagedToggle).toHaveAttribute('aria-expanded', 'true')
    expect(within(stagedGroup).getByText('1')).toBeInTheDocument()

    await user.click(within(stagedGroup).getByRole('button', { name: '전체 Unstage' }))
    expect(onUnstageAll).toHaveBeenCalledTimes(1)

    await user.click(stagedToggle)
    expect(stagedToggle).toHaveAttribute('aria-expanded', 'false')
    expect(within(stagedGroup).queryByText('staged.md')).not.toBeInTheDocument()
    await user.click(stagedToggle)
    expect(within(stagedGroup).getByText('staged.md')).toBeInTheDocument()

    const updatedChangesGroup = within(changesSection).getByRole('group', { name: 'Changes' })
    await user.click(within(updatedChangesGroup).getByRole('button', { name: '전체 변경 사항 롤백' }))
    await user.click(within(updatedChangesGroup).getByRole('button', { name: '전체 Stage' }))
    expect(onDiscardAll).toHaveBeenCalledTimes(1)
    expect(onStageAll).toHaveBeenCalledTimes(1)

    const changesSubToggle = within(updatedChangesGroup).getByRole('button', { name: /^Changes$/ })
    await user.click(changesSubToggle)
    expect(changesSubToggle).toHaveAttribute('aria-expanded', 'false')
    expect(within(updatedChangesGroup).queryByText('guide.md')).not.toBeInTheDocument()
    await user.click(changesSubToggle)
    expect(within(updatedChangesGroup).getByText('guide.md')).toBeInTheDocument()

    // 4. Header Commit ✓ disables when clean or conflicted
    rerender(
      <StatefulGitSidebarPanel
        {...buildProps({
          status: buildGitStatus({
            staged: [],
            unstaged: [],
            untracked: []
          })
        })}
      />
    )
    expect(within(changesSection).getByRole('button', { name: '변경 사항 커밋' })).toBeDisabled()

    rerender(
      <StatefulGitSidebarPanel
        {...buildProps({
          status: buildGitStatus({
            hasConflicts: true,
            staged: [],
            unstaged: [{ path: 'conflict.md', status: 'U' }],
            untracked: []
          })
        })}
      />
    )
    expect(within(changesSection).getByRole('button', { name: '변경 사항 커밋' })).toBeDisabled()
  })

  it('renders compact file rows with VS Code status chars, deleted strikethrough, workspace-scoped open file action, and compressed tree view with workspace-reset collapse', async () => {
    const user = userEvent.setup()
    const onOpenFileDiff = vi.fn()
    const onOpenWorkspaceFile = vi.fn()

    const status = buildGitStatus({
      repoRoot: 'C:/repo',
      staged: [
        { path: 'wiki/docs/sub/staged-added.md', status: 'A' },
        { path: 'wiki/docs/gone-staged.md', status: 'D' },
        { path: 'wiki/docs/sub/renamed.md', origPath: 'legacy/old-doc.md', status: 'R' }
      ],
      unstaged: [
        { path: 'wiki/a/b/c/edited.md', status: 'M' },
        { path: 'wiki/removed.md', status: 'D' },
        { path: 'wiki/conflict.md', status: 'U' },
        { path: 'outside/external.md', status: 'M' }
      ],
      untracked: [
        { path: 'wiki/a/b/c/new-note.md', status: '?' },
        { path: 'root-note.md', status: '?' }
      ]
    })

    const { rerender } = render(
      <StatefulGitSidebarPanel
        {...buildProps({
          workspaceRootPath: 'C:/repo/wiki',
          status,
          onOpenFileDiff,
          onOpenWorkspaceFile
        })}
      />
    )

    const region = screen.getByRole('region', { name: 'Git 소스 제어' })
    const changesSection = within(region).getByRole('region', { name: 'Changes' })

    // 1. List mode shows filename + dimmed relative dir + VS Code status chars + deleted strikethrough
    expect(within(changesSection).getByText('edited.md')).toBeInTheDocument()
    expect(within(changesSection).getAllByText('wiki/a/b/c')).toHaveLength(2)
    expect(within(changesSection).getByText('removed.md')).toHaveClass('is-deleted')
    expect(within(changesSection).getByText('gone-staged.md')).toHaveClass('is-deleted')
    expect(within(changesSection).getAllByText('U')).toHaveLength(2)
    expect(within(changesSection).getByText('C')).toBeInTheDocument()

    // 2. Open file button excluded for 'D' files and files outside workspaceRootPath, included for valid workspace files
    expect(
      within(changesSection).queryByRole('button', { name: 'wiki/removed.md 파일 열기' })
    ).toBeNull()
    expect(
      within(changesSection).queryByRole('button', { name: 'wiki/docs/gone-staged.md 파일 열기' })
    ).toBeNull()
    expect(
      within(changesSection).queryByRole('button', { name: 'outside/external.md 파일 열기' })
    ).toBeNull()

    const openEditedBtn = within(changesSection).getByRole('button', {
      name: 'wiki/a/b/c/edited.md 파일 열기'
    })
    await user.click(openEditedBtn)
    expect(onOpenWorkspaceFile).toHaveBeenCalledWith('wiki/a/b/c/edited.md')
    expect(onOpenFileDiff).not.toHaveBeenCalled()

    // Row click opens Diff tab with original internal status preserved ('?' and 'U')
    await user.click(within(changesSection).getByText('new-note.md'))
    expect(onOpenFileDiff).toHaveBeenCalledWith({
      kind: 'unstaged',
      path: 'wiki/a/b/c/new-note.md',
      status: '?'
    })

    // 3. Toggle to tree view -> stops compression at wiki/ (has direct files), compresses child a/b/c, sorts folders before root files
    await user.click(within(changesSection).getByRole('button', { name: '트리 보기로 전환' }))
    expect(within(changesSection).getByRole('button', { name: '리스트 보기로 전환' })).toBeInTheDocument()

    const wikiFolderBtn = within(changesSection).getByRole('button', { name: 'wiki' })
    const treeFolderBtn = within(changesSection).getByRole('button', { name: 'a/b/c' })
    const rootNoteBtn = within(changesSection).getByRole('button', { name: 'root-note.md' })
    expect(wikiFolderBtn).toHaveAttribute('aria-expanded', 'true')
    expect(treeFolderBtn).toHaveAttribute('aria-expanded', 'true')
    expect(
      wikiFolderBtn.compareDocumentPosition(rootNoteBtn) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(within(changesSection).getByText('edited.md')).toBeInTheDocument()
    expect(within(changesSection).getByText('new-note.md')).toBeInTheDocument()
    const renamedTreeTrigger = within(changesSection).getByRole('button', { name: 'renamed.md' })
    expect(renamedTreeTrigger).toHaveAttribute('title', 'legacy/old-doc.md → wiki/docs/sub/renamed.md')

    // Collapse compressed folder -> hides nested files while keeping sibling files under wiki visible
    await user.click(treeFolderBtn)
    expect(treeFolderBtn).toHaveAttribute('aria-expanded', 'false')
    expect(within(changesSection).queryByText('edited.md')).not.toBeInTheDocument()
    expect(within(changesSection).queryByText('new-note.md')).not.toBeInTheDocument()
    expect(within(changesSection).getByText('removed.md')).toBeInTheDocument()

    // Workspace switch resets collapsed folder state so folders start expanded again
    rerender(
      <StatefulGitSidebarPanel
        {...buildProps({
          workspaceRootPath: 'C:/repo/other',
          status,
          onOpenFileDiff,
          onOpenWorkspaceFile
        })}
      />
    )
    expect(within(changesSection).getByRole('button', { name: 'a/b/c' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(within(changesSection).getByText('edited.md')).toBeInTheDocument()
  })

  it('reveals subgroup and file hover actions via keyboard :focus-within and defines light/dark VS Code status color tokens', async () => {
    const user = userEvent.setup()
    const styleEl = document.createElement('style')
    styleEl.textContent = themeCss
    document.head.appendChild(styleEl)

    try {
      const { container } = render(
        <div data-theme="light">
          <button type="button">Before Git Changes</button>
          <GitSidebarPanel
            {...buildProps({
              status: buildGitStatus({
                staged: [{ path: 'added.md', status: 'A' }],
                unstaged: [
                  { path: 'modified.md', status: 'M' },
                  { path: 'deleted.md', status: 'D' },
                  { path: 'conflict.md', status: 'U' }
                ],
                untracked: [{ path: 'untracked.md', status: '?' }]
              })
            })}
          />
        </div>
      )

      const themedRoot = container.firstElementChild as HTMLElement
      const lightVars = {
        added: getComputedStyle(themedRoot).getPropertyValue('--git-status-added').trim(),
        modified: getComputedStyle(themedRoot).getPropertyValue('--git-status-modified').trim(),
        deleted: getComputedStyle(themedRoot).getPropertyValue('--git-status-deleted').trim(),
        renamed: getComputedStyle(themedRoot).getPropertyValue('--git-status-renamed').trim()
      }
      expect(lightVars.added).not.toBe('')
      expect(lightVars.modified).not.toBe('')
      expect(lightVars.deleted).not.toBe('')
      expect(lightVars.renamed).not.toBe('')
      expect(new Set(Object.values(lightVars)).size).toBe(4)

      themedRoot.setAttribute('data-theme', 'dark')
      const darkVars = {
        added: getComputedStyle(themedRoot).getPropertyValue('--git-status-added').trim(),
        modified: getComputedStyle(themedRoot).getPropertyValue('--git-status-modified').trim(),
        deleted: getComputedStyle(themedRoot).getPropertyValue('--git-status-deleted').trim(),
        renamed: getComputedStyle(themedRoot).getPropertyValue('--git-status-renamed').trim()
      }
      expect(darkVars.added).not.toBe('')
      expect(darkVars.modified).not.toBe('')
      expect(darkVars.deleted).not.toBe('')
      expect(darkVars.renamed).not.toBe('')
      expect(darkVars).not.toEqual(lightVars)

      expect(getComputedStyle(screen.getByText('deleted.md')).textDecorationLine).toBe(
        'line-through'
      )

      const stagedGroup = screen.getByRole('group', { name: 'Staged Changes' })
      const unstageAllBtn = within(stagedGroup).getByRole('button', { name: '전체 Unstage' })
      const stagedActions = unstageAllBtn.parentElement as HTMLElement

      const openModifiedBtn = screen.getByRole('button', { name: 'modified.md 파일 열기' })
      const fileActions = openModifiedBtn.parentElement as HTMLElement

      // Idle state hides hover-only containers visually while keeping buttons keyboard-focusable
      expect(getComputedStyle(stagedActions).opacity).toBe('0')
      expect(getComputedStyle(fileActions).opacity).toBe('0')

      // Focusing action button activates CSS :focus-within on subgroup header and file row
      unstageAllBtn.focus()
      expect(unstageAllBtn).toHaveFocus()
      expect(getComputedStyle(stagedActions).opacity).toBe('1')

      openModifiedBtn.focus()
      expect(openModifiedBtn).toHaveFocus()
      expect(getComputedStyle(fileActions).opacity).toBe('1')

      await user.tab()
      expect(screen.getByRole('button', { name: 'modified.md 변경 사항 롤백' })).toHaveFocus()
      expect(getComputedStyle(fileActions).opacity).toBe('1')

      screen.getByRole('button', { name: 'Before Git Changes' }).focus()
      expect(getComputedStyle(fileActions).opacity).toBe('0')
    } finally {
      styleEl.remove()
    }
  })

  it('renders Graph header scope toggle (Auto / 현재 브랜치) and Lucide icon toolbar (Fetch, Pull, Push, 새로고침) separated from collapse toggle and disabled while busy', async () => {
    const user = userEvent.setup()
    const onChangeLogScope = vi.fn()
    const onFetch = vi.fn()
    const onPull = vi.fn()
    const onPush = vi.fn()
    const onRefresh = vi.fn()
    const onToggleGraphCollapsed = vi.fn()

    const { rerender } = render(
      <GitSidebarPanel
        {...buildProps({
          graphState: {
            ...createInitialGitGraphState(),
            scope: 'all'
          },
          onChangeLogScope,
          onFetch,
          onPull,
          onPush,
          onRefresh,
          onToggleGraphCollapsed
        })}
      />
    )

    const graphRegion = screen.getByRole('region', { name: 'Graph' })
    const collapseBtn = within(graphRegion).getByRole('button', { name: /^Graph$/i })
    const autoBtn = within(graphRegion).getByRole('button', { name: 'Auto' })
    const fetchBtn = within(graphRegion).getByRole('button', { name: 'Fetch' })
    const pullBtn = within(graphRegion).getByRole('button', { name: 'Pull' })
    const pushBtn = within(graphRegion).getByRole('button', { name: 'Push' })
    const refreshBtn = within(graphRegion).getByRole('button', { name: '그래프 새로고침' })

    expect(within(graphRegion).queryByRole('button', { name: '현재 브랜치' })).toBeNull()
    for (const btn of [autoBtn, fetchBtn, pullBtn, pushBtn, refreshBtn]) {
      expect(collapseBtn.contains(btn)).toBe(false)
      expect(btn).toBeEnabled()
    }
    for (const iconBtn of [fetchBtn, pullBtn, pushBtn, refreshBtn]) {
      expect(iconBtn.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    }

    await user.click(autoBtn)
    await user.click(fetchBtn)
    await user.click(pullBtn)
    await user.click(pushBtn)
    await user.click(refreshBtn)

    expect(onChangeLogScope).toHaveBeenCalledWith('current')
    expect(onFetch).toHaveBeenCalledTimes(1)
    expect(onPull).toHaveBeenCalledTimes(1)
    expect(onPush).toHaveBeenCalledTimes(1)
    expect(onRefresh).toHaveBeenCalledTimes(1)
    expect(onToggleGraphCollapsed).not.toHaveBeenCalled()

    // Scope = 'current' displays '현재 브랜치' and switches back to 'all' on click
    rerender(
      <GitSidebarPanel
        {...buildProps({
          graphState: {
            ...createInitialGitGraphState(),
            scope: 'current'
          },
          onChangeLogScope,
          onFetch,
          onPull,
          onPush,
          onRefresh,
          onToggleGraphCollapsed
        })}
      />
    )
    const currentScopeBtn = within(graphRegion).getByRole('button', { name: '현재 브랜치' })
    expect(within(graphRegion).queryByRole('button', { name: 'Auto' })).toBeNull()
    await user.click(currentScopeBtn)
    expect(onChangeLogScope).toHaveBeenLastCalledWith('all')

    // Pending action disables all 4 Graph action icons
    rerender(
      <GitSidebarPanel
        {...buildProps({
          pendingAction: 'Fetch',
          onChangeLogScope,
          onFetch,
          onPull,
          onPush,
          onRefresh
        })}
      />
    )
    expect(within(graphRegion).getByRole('button', { name: 'Fetch' })).toBeDisabled()
    expect(within(graphRegion).getByRole('button', { name: 'Pull' })).toBeDisabled()
    expect(within(graphRegion).getByRole('button', { name: 'Push' })).toBeDisabled()
    expect(within(graphRegion).getByRole('button', { name: '그래프 새로고침' })).toBeDisabled()

    // Graph log loading disables graph refresh button without disabling remote actions
    rerender(
      <GitSidebarPanel
        {...buildProps({
          graphState: {
            ...createInitialGitGraphState(),
            isLoading: true
          }
        })}
      />
    )
    expect(within(graphRegion).getByRole('button', { name: '그래프 새로고침' })).toBeDisabled()
  })

  it('renders detached HEAD badge, multi-remote cloud tooltip, and enforces 24px compact row and 260px truncation CSS rules', () => {
    const styleEl = document.createElement('style')
    styleEl.textContent = themeCss
    document.head.appendChild(styleEl)

    try {
      const commits: GitGraphCommit[] = [
        {
          hash: '1111111111111111111111111111111111111111',
          shortHash: '1111111',
          parents: ['2222222222222222222222222222222222222222'],
          subject: 'Detached commit with a very long commit subject that must truncate gracefully',
          authorName: 'VeryLongAuthorName',
          committedAt: '2026-11-15T06:30:00Z',
          refs: [
            { name: 'HEAD', kind: 'head', isCurrentHead: true },
            { name: 'master', kind: 'local-branch', isCurrentHead: false },
            { name: 'origin/master', kind: 'remote-branch' },
            { name: 'upstream/master', kind: 'remote-branch' }
          ]
        }
      ]

      render(
        <div style={{ width: '260px' }}>
          <GitSidebarPanel
            {...buildProps({
              status: buildGitStatus({ branch: null, isDetached: true }),
              graphState: {
                ...createInitialGitGraphState(),
                commits
              }
            })}
          />
        </div>
      )

      const graphRegion = screen.getByRole('region', { name: 'Graph' })
      const rowBtn = within(graphRegion).getByRole('button', { name: /Detached commit/ })
      const headBadge = within(rowBtn).getByText('HEAD').closest('.git-ref-badge') as HTMLElement
      const masterBadge = within(rowBtn).getByText('master').closest('.git-ref-badge') as HTMLElement
      const multiRemoteCloud = within(rowBtn).getByTitle('origin, upstream')
      const subjectEl = within(rowBtn).getByText(/Detached commit/)
      const authorEl = within(rowBtn).getByText('VeryLongAuthorName')
      const refsContainer = headBadge.parentElement as HTMLElement

      expect(headBadge).toHaveClass('is-head')
      expect(headBadge.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
      expect(masterBadge).toHaveClass('is-local-branch')
      expect(masterBadge).not.toHaveClass('is-current-head')
      expect(multiRemoteCloud).toHaveClass('is-synced-remote')

      expect(getComputedStyle(rowBtn).height).toBe('24px')
      expect(getComputedStyle(subjectEl).textOverflow).toBe('ellipsis')
      expect(getComputedStyle(subjectEl).overflow).toBe('hidden')
      expect(getComputedStyle(subjectEl).minWidth).toMatch(/^0(px)?$/)
      expect(getComputedStyle(authorEl).textOverflow).toBe('ellipsis')
      expect(getComputedStyle(refsContainer).minWidth).toMatch(/^0(px)?$/)
      expect(getComputedStyle(refsContainer).overflow).toBe('hidden')
      expect(getComputedStyle(masterBadge.querySelector('.git-ref-label')!).textOverflow).toBe(
        'ellipsis'
      )
    } finally {
      styleEl.remove()
    }
  })

  it('renders 3-tier Changes -> Stashes -> Graph accordions, quick Changes stash icon left of Discard All, Stashes compact/fill layout, and Pop/Apply row actions', async () => {
    const user = userEvent.setup()
    const onStashChanges = vi.fn()
    const onPopStash = vi.fn()
    const onApplyStash = vi.fn()

    const stashes: GitStashEntry[] = [
      {
        ref: 'stash@{0}',
        hash: '1111111111111111111111111111111111111111',
        branch: 'main',
        message: 'draft notes backup',
        createdAt: '2026-11-20T09:15:00+09:00'
      },
      {
        ref: 'stash@{1}',
        hash: '2222222222222222222222222222222222222222',
        branch: null,
        message: 'WIP on main: seed',
        createdAt: '2026-11-19T18:05:00+09:00'
      }
    ]

    const styleEl = document.createElement('style')
    styleEl.textContent = themeCss
    document.head.appendChild(styleEl)

    try {
      const { rerender } = render(
        <StatefulGitSidebarPanel
          {...buildProps({
            stashes: [],
            onStashChanges,
            onPopStash,
            onApplyStash
          })}
        />
      )

      const region = screen.getByRole('region', { name: 'Git 소스 제어' })
      const changesSection = within(region).getByRole('region', { name: 'Changes' })
      const stashesSection = within(region).getByRole('region', { name: 'Stashes' })
      const graphSection = within(region).getByRole('region', { name: 'Graph' })

      // 1. 3-tier order: Changes -> Stashes -> Graph; Stashes defaults collapsed with badge 0
      expect(
        changesSection.compareDocumentPosition(stashesSection) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy()
      expect(
        stashesSection.compareDocumentPosition(graphSection) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy()

      const stashesToggle = within(stashesSection).getByRole('button', { name: /^Stashes/i })
      expect(stashesToggle).toHaveAttribute('aria-expanded', 'false')
      expect(stashesToggle).toHaveTextContent('0')

      // 2. Changes subgroup quick stash button sits left of 전체 변경 사항 롤백 and is absent from Staged Changes
      const stagedGroup = within(changesSection).getByRole('group', { name: 'Staged Changes' })
      expect(within(stagedGroup).queryByRole('button', { name: 'Changes만 Stash' })).toBeNull()

      const changesGroup = within(changesSection).getByRole('group', { name: 'Changes' })
      const quickStashBtn = within(changesGroup).getByRole('button', { name: 'Changes만 Stash' })
      const discardAllBtn = within(changesGroup).getByRole('button', {
        name: '전체 변경 사항 롤백'
      })
      expect(
        quickStashBtn.compareDocumentPosition(discardAllBtn) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy()
      expect(quickStashBtn).toBeEnabled()
      await user.click(quickStashBtn)
      expect(onStashChanges).toHaveBeenCalledTimes(1)

      // 3. Expand empty Stashes -> shows empty text and compact style while Changes/Graph expanded
      await user.click(stashesToggle)
      expect(stashesToggle).toHaveAttribute('aria-expanded', 'true')
      expect(within(stashesSection).getByText('보관된 Stash가 없습니다.')).toBeInTheDocument()
      expect(stashesSection).toHaveClass('is-compact')
      expect(stashesSection.style.flex).toBe('')

      // 4. Render stashes -> displays badge 2, message, stash@{n}, formatted timestamp, and Pop/Apply actions
      rerender(
        <StatefulGitSidebarPanel
          {...buildProps({
            stashes,
            splitState: {
              ...createDefaultGitPanelSplitState(),
              isStashesCollapsed: false
            },
            onStashChanges,
            onPopStash,
            onApplyStash
          })}
        />
      )

      expect(within(stashesSection).getByRole('button', { name: /^Stashes/i })).toHaveTextContent(
        '2'
      )
      const stashList = within(stashesSection).getByRole('list', { name: 'Stash 목록' })
      const stashItems = within(stashList).getAllByRole('listitem')
      expect(stashItems).toHaveLength(2)

      expect(stashItems[0]).toHaveTextContent('draft notes backup')
      expect(stashItems[0]).toHaveTextContent('stash@{0}')
      expect(stashItems[0].textContent).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/)

      const popBtn0 = within(stashItems[0]).getByRole('button', { name: /Pop/ })
      const applyBtn0 = within(stashItems[0]).getByRole('button', { name: /Apply/ })
      const actionsContainer = popBtn0.parentElement as HTMLElement
      expect(getComputedStyle(actionsContainer).opacity).toBe('0')
      popBtn0.focus()
      expect(getComputedStyle(actionsContainer).opacity).toBe('1')

      await user.click(popBtn0)
      expect(onPopStash).toHaveBeenCalledWith('stash@{0}')
      await user.click(applyBtn0)
      expect(onApplyStash).toHaveBeenCalledWith('stash@{0}')

      // 5. Collapsing both Changes and Graph switches Stashes from compact to fill (flex: 1 1 0%)
      await user.click(getChangesAccordionToggle(region))
      await user.click(within(region).getByRole('button', { name: /^Graph/i }))
      expect(stashesSection).not.toHaveClass('is-compact')
      expect(stashesSection).toHaveStyle({ flex: '1 1 0%' })

      // Re-expand Changes so subgroup header is rendered, then verify disabled states on empty Changes & busy
      await user.click(getChangesAccordionToggle(region))
      rerender(
        <StatefulGitSidebarPanel
          {...buildProps({
            status: buildGitStatus({ unstaged: [], untracked: [] }),
            stashes,
            pendingAction: 'Stash Pop',
            onStashChanges,
            onPopStash,
            onApplyStash
          })}
        />
      )
      expect(within(region).getByRole('button', { name: 'Changes만 Stash' })).toBeDisabled()
      expect(within(region).getByRole('button', { name: 'stash@{0} Pop' })).toBeDisabled()
      expect(within(region).getByRole('button', { name: 'stash@{0} Apply' })).toBeDisabled()
    } finally {
      styleEl.remove()
    }
  })

  it('renders single-file Stash only on Changes rows without clipping and wires Stashes +, Clear All, and Drop actions', async () => {
    const user = userEvent.setup()
    const styleEl = document.createElement('style')
    styleEl.textContent = themeCss
    document.head.appendChild(styleEl)

    try {
      const onStashFile = vi.fn()
      const onOpenFileDiff = vi.fn()
      const onOpenStashDialog = vi.fn()
      const onDropStash = vi.fn()
      const onClearStashes = vi.fn()

      const stashes: GitStashEntry[] = [
        {
          ref: 'stash@{0}',
          hash: '1111111111111111111111111111111111111111',
          branch: 'main',
          message: 'single file wip',
          createdAt: '2026-11-20T12:00:00Z'
        }
      ]

      const { rerender } = render(
        <StatefulGitSidebarPanel
          {...buildProps({
            status: buildGitStatus({
              staged: [{ path: 'staged.md', status: 'M' }],
              unstaged: [{ path: 'docs/modified.md', status: 'M' }],
              untracked: [{ path: 'notes/new.md', status: '?' }]
            }),
            stashes,
            splitState: {
              ...createDefaultGitPanelSplitState(),
              isStashesCollapsed: false
            },
            onStashFile,
            onOpenFileDiff,
            onOpenStashDialog,
            onDropStash,
            onClearStashes
          })}
        />
      )

      const region = screen.getByRole('region', { name: 'Git 소스 제어' })

      // 1. Single-file Stash appears on Changes rows only (not on Staged Changes)
      const modifiedStashBtn = within(region).getByRole('button', { name: 'docs/modified.md Stash' })
      const untrackedStashBtn = within(region).getByRole('button', { name: 'notes/new.md Stash' })
      expect(within(region).queryByRole('button', { name: 'staged.md Stash' })).not.toBeInTheDocument()

      // Action strip stays hidden at idle (max-width: 0) and expands enough for 4 icons on focus-within
      const fileActions = modifiedStashBtn.parentElement as HTMLElement
      expect(getComputedStyle(fileActions).maxWidth).toBe('0px')
      modifiedStashBtn.focus()
      expect(getComputedStyle(fileActions).maxWidth).toBe('100px')

      // Clicking single-file Stash calls onStashFile without opening Diff tab
      await user.click(modifiedStashBtn)
      await user.click(untrackedStashBtn)
      expect(onStashFile).toHaveBeenNthCalledWith(1, 'docs/modified.md')
      expect(onStashFile).toHaveBeenNthCalledWith(2, 'notes/new.md')
      expect(onOpenFileDiff).not.toHaveBeenCalled()

      // 2. Stashes header '+' and 'Clear All' work without toggling section expansion, and row 'Drop' calls onDropStash
      const stashesSection = within(region).getByRole('region', { name: 'Stashes' })
      const stashesToggle = within(stashesSection).getByRole('button', { name: /^Stashes/i })
      const createStashBtn = within(stashesSection).getByRole('button', { name: '새 Stash 만들기' })
      const clearAllBtn = within(stashesSection).getByRole('button', { name: 'Clear All' })
      const dropBtn = within(stashesSection).getByRole('button', { name: 'stash@{0} Drop' })

      expect(createStashBtn).toBeEnabled()
      expect(clearAllBtn).toBeEnabled()
      expect(dropBtn).toBeEnabled()

      await user.click(createStashBtn)
      expect(onOpenStashDialog).toHaveBeenCalledTimes(1)
      expect(stashesToggle).toHaveAttribute('aria-expanded', 'true')

      await user.click(clearAllBtn)
      expect(onClearStashes).toHaveBeenCalledTimes(1)
      expect(stashesToggle).toHaveAttribute('aria-expanded', 'true')

      await user.click(dropBtn)
      expect(onDropStash).toHaveBeenCalledWith('stash@{0}')

      // 3. Staged-only repo still enables Stashes '+' while empty Changes/empty Stashes disables Clear All
      rerender(
        <StatefulGitSidebarPanel
          {...buildProps({
            status: buildGitStatus({
              staged: [{ path: 'staged.md', status: 'M' }],
              unstaged: [],
              untracked: []
            }),
            stashes: [],
            splitState: {
              ...createDefaultGitPanelSplitState(),
              isStashesCollapsed: false
            },
            onStashFile,
            onOpenStashDialog,
            onDropStash,
            onClearStashes
          })}
        />
      )
      expect(within(stashesSection).getByRole('button', { name: '새 Stash 만들기' })).toBeEnabled()
      expect(within(stashesSection).getByRole('button', { name: 'Clear All' })).toBeDisabled()

      // 4. Clean working tree (0 changes) and busy state disable header + file actions
      rerender(
        <StatefulGitSidebarPanel
          {...buildProps({
            status: buildGitStatus({ staged: [], unstaged: [], untracked: [] }),
            stashes,
            pendingAction: 'Stash Drop',
            splitState: {
              ...createDefaultGitPanelSplitState(),
              isStashesCollapsed: false
            },
            onStashFile,
            onOpenStashDialog,
            onDropStash,
            onClearStashes
          })}
        />
      )
      expect(within(stashesSection).getByRole('button', { name: '새 Stash 만들기' })).toBeDisabled()
      expect(within(stashesSection).getByRole('button', { name: 'Clear All' })).toBeDisabled()
      expect(within(stashesSection).getByRole('button', { name: 'stash@{0} Drop' })).toBeDisabled()
    } finally {
      styleEl.remove()
    }
  })

  it('toggles inline stash detail (loading/error/empty/loaded files including untracked ?), separates row click from Pop/Apply/Drop, and triggers kind=stash diff on file click', async () => {
    const user = userEvent.setup()
    const onToggleStashDetail = vi.fn()
    const onPopStash = vi.fn()
    const onApplyStash = vi.fn()
    const onDropStash = vi.fn()
    const onOpenFileDiff = vi.fn()

    const stash0: GitStashEntry = {
      ref: 'stash@{0}',
      hash: '1111111111111111111111111111111111111111',
      branch: 'main',
      message: 'first stash summary',
      createdAt: '2026-11-20T12:00:00Z'
    }
    const stash1: GitStashEntry = {
      ref: 'stash@{1}',
      hash: '2222222222222222222222222222222222222222',
      branch: 'main',
      message: 'second stash summary',
      createdAt: '2026-11-20T11:00:00Z'
    }
    const baseSplit = {
      ...createDefaultGitPanelSplitState(),
      isStashesCollapsed: false
    }

    const { rerender } = render(
      <GitSidebarPanel
        {...buildProps({
          stashes: [stash0, stash1],
          stashDetail: createInitialGitDetailState(),
          splitState: baseSplit,
          onToggleStashDetail,
          onPopStash,
          onApplyStash,
          onDropStash,
          onOpenFileDiff
        })}
      />
    )

    const stashesSection = screen.getByRole('region', { name: 'Stashes' })
    const rowTrigger0 = within(stashesSection).getByRole('button', { name: /first stash summary/ })
    const rowTrigger1 = within(stashesSection).getByRole('button', { name: /second stash summary/ })
    expect(rowTrigger0).toHaveAttribute('aria-expanded', 'false')
    expect(rowTrigger1).toHaveAttribute('aria-expanded', 'false')

    // Pop / Apply / Drop must NOT trigger onToggleStashDetail
    await user.click(within(stashesSection).getByRole('button', { name: 'stash@{0} Pop' }))
    await user.click(within(stashesSection).getByRole('button', { name: 'stash@{0} Apply' }))
    await user.click(within(stashesSection).getByRole('button', { name: 'stash@{0} Drop' }))
    expect(onPopStash).toHaveBeenCalledWith('stash@{0}')
    expect(onApplyStash).toHaveBeenCalledWith('stash@{0}')
    expect(onDropStash).toHaveBeenCalledWith('stash@{0}')
    expect(onToggleStashDetail).not.toHaveBeenCalled()

    // Clicking stash row itself triggers onToggleStashDetail(stash0)
    await user.click(rowTrigger0)
    expect(onToggleStashDetail).toHaveBeenCalledWith(stash0)

    // Loading state
    rerender(
      <GitSidebarPanel
        {...buildProps({
          stashes: [stash0, stash1],
          stashDetail: { status: 'loading', selectedHash: stash0.hash },
          splitState: baseSplit,
          onToggleStashDetail,
          onOpenFileDiff
        })}
      />
    )
    expect(rowTrigger0).toHaveAttribute('aria-expanded', 'true')
    expect(rowTrigger1).toHaveAttribute('aria-expanded', 'false')
    const loadingRegion = within(stashesSection).getByRole('region', { name: 'stash@{0} Stash 상세' })
    expect(loadingRegion).toHaveTextContent('Stash 상세를 불러오는 중...')

    // Error state
    rerender(
      <GitSidebarPanel
        {...buildProps({
          stashes: [stash0, stash1],
          stashDetail: {
            status: 'error',
            selectedHash: stash0.hash,
            errorMessage: 'Stash 상세 조회 실패'
          },
          splitState: baseSplit,
          onToggleStashDetail,
          onOpenFileDiff
        })}
      />
    )
    expect(within(stashesSection).getByRole('alert')).toHaveTextContent('Stash 상세 조회 실패')

    // Empty files state
    rerender(
      <GitSidebarPanel
        {...buildProps({
          stashes: [stash0, stash1],
          stashDetail: {
            status: 'loaded',
            selectedHash: stash0.hash,
            detail: { ...stash0, files: [] }
          },
          splitState: baseSplit,
          onToggleStashDetail,
          onOpenFileDiff
        })}
      />
    )
    expect(
      within(within(stashesSection).getByRole('region', { name: 'stash@{0} Stash 상세' })).getByText(
        '변경된 파일이 없습니다.'
      )
    ).toBeInTheDocument()

    // Loaded state with M, D, R, ? (switches to stash1 only -> single expansion)
    rerender(
      <GitSidebarPanel
        {...buildProps({
          stashes: [stash0, stash1],
          stashDetail: {
            status: 'loaded',
            selectedHash: stash1.hash,
            detail: {
              ...stash1,
              files: [
                { path: 'docs/edited.md', status: 'M' },
                { path: 'docs/removed.md', status: 'D' },
                { path: 'docs/new.md', origPath: 'docs/old.md', status: 'R' },
                { path: 'notes/untracked.md', status: '?' }
              ]
            }
          },
          splitState: baseSplit,
          onToggleStashDetail,
          onOpenFileDiff
        })}
      />
    )
    expect(rowTrigger0).toHaveAttribute('aria-expanded', 'false')
    expect(rowTrigger1).toHaveAttribute('aria-expanded', 'true')
    expect(within(stashesSection).queryByRole('region', { name: 'stash@{0} Stash 상세' })).toBeNull()

    const detailRegion1 = within(stashesSection).getByRole('region', {
      name: 'stash@{1} Stash 상세'
    })
    expect(detailRegion1).toHaveTextContent('변경된 파일 (4)')
    expect(within(detailRegion1).getByText('removed.md')).toHaveClass('is-deleted')
    expect(within(detailRegion1).getByText('old.md → new.md')).toBeInTheDocument()
    expect(within(detailRegion1).getByText('U')).toHaveClass('git-status-letter', 'is-green')

    await user.click(within(detailRegion1).getByTitle('notes/untracked.md'))
    expect(onOpenFileDiff).toHaveBeenCalledWith({
      kind: 'stash',
      stashRef: stash1.ref,
      stashHash: stash1.hash,
      path: 'notes/untracked.md',
      status: '?'
    })
  })

  it('renders GitStashDialog internally under StrictMode, submits stash options, and closes on cancel', async () => {
    const user = userEvent.setup()
    const submitStashDialog = vi.fn(async () => true)
    const closeStashDialog = vi.fn()
    const props = buildProps({ stashDialogScope: 'all' })
    render(
      <StrictMode>
        <GitSidebarPanel
          state={props.state}
          actions={{
            ...props.actions,
            submitStashDialog,
            closeStashDialog
          }}
        />
      </StrictMode>
    )

    expect(closeStashDialog).not.toHaveBeenCalled()
    const dialog = screen.getByRole('dialog', { name: 'Stash 생성' })
    expect(within(dialog).getByRole('radio', { name: '전체 보관 (Staged 포함)' })).toBeChecked()

    await user.click(within(dialog).getByRole('button', { name: '취소' }))
    expect(closeStashDialog).toHaveBeenCalledTimes(1)

    await user.click(within(dialog).getByRole('button', { name: 'Stash 생성' }))
    expect(submitStashDialog).toHaveBeenCalledWith({
      scope: 'all',
      includeUntracked: true
    })
  })

  it('shows right-click context menu on Changes file rows (list & tree) and compressed folder rows', async () => {
    const user = userEvent.setup()
    const onOpenFileDiff = vi.fn()
    const onCopyPath = vi.fn()
    const props = buildProps({
      status: {
        ...createEmptyGitStatus(true, 'C:/repo'),
        staged: [{ status: 'M', path: 'docs/staged.md' }],
        unstaged: [{ status: 'M', path: 'a/b/c/file.md' }],
        untracked: []
      },
      changesViewState: { ...createDefaultGitChangesViewState(), viewMode: 'list' }
    })

    const { rerender } = render(
      <GitSidebarPanel
        state={props.state}
        actions={{ ...props.actions, openFileDiff: onOpenFileDiff }}
        onCopyPath={onCopyPath}
      />
    )

    // List mode: right-click file row
    const stagedGroup = screen.getByRole('group', { name: 'Staged Changes' })
    fireEvent.contextMenu(within(stagedGroup).getByTitle('docs/staged.md'))
    const fileMenu = screen.getByRole('menu')
    expect(within(fileMenu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      '새 탭에서 Diff 열기',
      '상대 경로 복사',
      '절대 경로 복사'
    ])
    await user.click(within(fileMenu).getByRole('menuitem', { name: '새 탭에서 Diff 열기' }))
    expect(onOpenFileDiff).toHaveBeenCalledWith(
      { kind: 'staged', path: 'docs/staged.md', status: 'M' },
      { pinned: true }
    )

    // Tree mode: right-click compressed directory row `a/b/c`
    const treeProps = buildProps({
      status: {
        ...createEmptyGitStatus(true, 'C:/repo'),
        staged: [{ status: 'M', path: 'docs/staged.md' }],
        unstaged: [{ status: 'M', path: 'a/b/c/file.md' }],
        untracked: []
      },
      changesViewState: { ...createDefaultGitChangesViewState(), viewMode: 'tree' }
    })
    rerender(
      <GitSidebarPanel
        state={treeProps.state}
        actions={{ ...treeProps.actions, openFileDiff: onOpenFileDiff }}
        onCopyPath={onCopyPath}
      />
    )

    const changesGroup = screen.getByRole('group', { name: 'Changes' })
    fireEvent.contextMenu(within(changesGroup).getByTitle('a/b/c'))
    const dirMenu = screen.getByRole('menu')
    expect(within(dirMenu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      '상대 경로 복사',
      '절대 경로 복사'
    ])
    await user.click(within(dirMenu).getByRole('menuitem', { name: '상대 경로 복사' }))
    expect(onCopyPath).toHaveBeenCalledWith('a/b/c', 'relative')

    fireEvent.contextMenu(within(changesGroup).getByTitle('a/b/c'))
    await user.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: '절대 경로 복사' }))
    expect(onCopyPath).toHaveBeenCalledWith('a/b/c', 'absolute')
  })
})
