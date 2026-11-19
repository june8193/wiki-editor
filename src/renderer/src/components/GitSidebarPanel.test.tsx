import { useState } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  createEmptyGitStatus,
  type GitBranchList,
  type GitGraphCommit,
  type GitStatus
} from '@shared/git'
import { createInitialGitGraphState } from '../hooks/useGitGraphLog'
import {
  createDefaultGitPanelSplitState,
  toggleGitChangesCollapsed,
  toggleGitGraphCollapsed,
  updateChangesHeightRatio,
  type GitPanelSplitState
} from '../utils/gitPanelSplit'
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

function buildProps(overrides: Partial<GitSidebarPanelProps> = {}): GitSidebarPanelProps {
  const branches: GitBranchList = {
    current: 'main',
    isDetached: false,
    branches: [
      { name: 'main', current: true, upstream: 'origin/main' },
      { name: 'feature/git', current: false, upstream: null }
    ]
  }

  return {
    workspaceRootPath: 'C:\\wiki',
    status: buildGitStatus(),
    branchList: branches,
    pendingAction: null,
    errorMessage: null,
    onDismissError: vi.fn(),
    onRefresh: vi.fn(),
    onInitRepo: vi.fn(),
    onStageFile: vi.fn(),
    onStageAll: vi.fn(),
    onUnstageFile: vi.fn(),
    onUnstageAll: vi.fn(),
    onDiscardFile: vi.fn(),
    onDiscardAll: vi.fn(),
    onCommit: vi.fn(),
    onCheckoutBranch: vi.fn(),
    onPull: vi.fn(),
    onPush: vi.fn(),
    onFetch: vi.fn(),
    onSync: vi.fn(),
    graphState: createInitialGitGraphState(),
    onChangeLogScope: vi.fn(),
    onLoadMoreCommits: vi.fn(),
    onToggleCommitDetail: vi.fn(),
    splitState: createDefaultGitPanelSplitState(),
    onOpenFileDiff: vi.fn(),
    onToggleChangesCollapsed: vi.fn(),
    onToggleGraphCollapsed: vi.fn(),
    onResizeChangesRatio: vi.fn(),
    ...overrides
  }
}

function StatefulGitSidebarPanel(props: GitSidebarPanelProps) {
  const [splitState, setSplitState] = useState<GitPanelSplitState>(() => props.splitState)

  return (
    <GitSidebarPanel
      {...props}
      splitState={splitState}
      onToggleChangesCollapsed={() => setSplitState(toggleGitChangesCollapsed)}
      onToggleGraphCollapsed={() => setSplitState(toggleGitGraphCollapsed)}
      onResizeChangesRatio={(nextRatio) =>
        setSplitState((prev) => updateChangesHeightRatio(prev, nextRatio))
      }
    />
  )
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

    // Status badges for staged and unstaged/untracked items
    expect(within(region).getByText('R')).toBeInTheDocument()
    expect(within(region).getByText('docs/old.md → docs/guide.md')).toBeInTheDocument()
    expect(within(region).getByText('A')).toBeInTheDocument()
    expect(within(region).getByText('M')).toBeInTheDocument()
    expect(within(region).getByText('D')).toBeInTheDocument()
    expect(within(region).getByText('?')).toBeInTheDocument()

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
    expect(onCommit).toHaveBeenCalledWith('docs: update handbook')
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

    const changesToggle = within(region).getByRole('button', { name: /Changes/i })
    const graphToggle = within(region).getByRole('button', { name: /Graph/i })
    expect(changesToggle).toHaveAttribute('aria-expanded', 'true')
    expect(changesToggle).toHaveTextContent('5')
    expect(graphToggle).toHaveAttribute('aria-expanded', 'true')

    // Ctrl+Enter submits commit inside Changes body
    const commitInput = within(region).getByLabelText('커밋 메시지')
    await user.type(commitInput, 'chore: ctrl enter commit')
    fireEvent.keyDown(commitInput, { key: 'Enter', ctrlKey: true })
    expect(onCommit).toHaveBeenCalledWith('chore: ctrl enter commit')

    // Collapse Changes -> commit form and file sections hide, but branch subrow & remote sync remain active
    await user.click(changesToggle)
    expect(changesToggle).toHaveAttribute('aria-expanded', 'false')
    expect(within(region).queryByLabelText('커밋 메시지')).not.toBeInTheDocument()
    expect(within(region).queryByText(/스테이지됨/)).not.toBeInTheDocument()
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

    // Clean repository shows 0 badge
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
    expect(within(region).getByRole('button', { name: /Changes/i })).toHaveTextContent('0')
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
    await user.click(within(region).getByRole('button', { name: /Changes/i }))
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
        refs: []
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
    const allBtn = within(graphRegion).getByRole('button', { name: '전체' })
    const currentBtn = within(graphRegion).getByRole('button', { name: '현재 브랜치' })
    expect(allBtn).toHaveAttribute('aria-pressed', 'true')
    expect(currentBtn).toHaveAttribute('aria-pressed', 'false')

    await user.click(currentBtn)
    expect(onChangeLogScope).toHaveBeenCalledWith('current')
    expect(onToggleGraphCollapsed).not.toHaveBeenCalled()

    // Commit rows, ref badges, SVG lanes, and tooltips
    const list = within(graphRegion).getByRole('list', { name: '커밋 그래프' })
    const items = within(list).getAllByRole('listitem')
    expect(items).toHaveLength(3)

    expect(within(items[0]).getByText('Merge feature branch into main')).toBeInTheDocument()
    expect(within(items[0]).getByText('Alice')).toBeInTheDocument()
    expect(within(items[0]).getByText('HEAD')).toHaveClass('is-head')
    expect(within(items[0]).getByText('main')).toHaveClass('is-local-branch')
    expect(within(items[0]).getByText('origin/main')).toHaveClass('is-remote-branch')
    expect(within(items[0]).getByText('v1.0.0')).toHaveClass('is-tag')
    expect(items[0].getAttribute('title')).toMatch(
      /^1111111 · Alice · \d{4}-\d{2}-\d{2} \d{2}:\d{2} · Merge feature branch into main$/
    )

    // HEAD emphasis ring + merge marker + SVG paths rendered across lanes
    expect(items[0].querySelector('svg.git-graph-svg')).not.toBeNull()
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
    expect(detailRegion).toHaveTextContent('notes/new.md')
    expect(detailRegion).toHaveTextContent('README.md')
    expect(detailRegion).toHaveTextContent('legacy.md')
    expect(detailRegion).toHaveTextContent('old/title.md → new/title.md')

    // Copy full hash button preserves accessible label while showing feedback
    const writeTextSpy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
    try {
      const copyBtn = within(detailRegion).getByRole('button', { name: '해시 복사' })
      await user.click(copyBtn)
      expect(writeTextSpy).toHaveBeenCalledWith(fullHash)
      expect(within(detailRegion).getByRole('button', { name: '해시 복사' })).toHaveTextContent('복사됨')
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

    await user.click(screen.getByText('docs/old.md → docs/renamed.md'))
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

    await user.click(within(detailRegion).getByRole('button', { name: /docs\/guide\.md/ }))
    expect(onOpenFileDiff).toHaveBeenCalledWith({
      kind: 'commit',
      commitHash: fullHash,
      shortHash: 'a1b2c3d',
      path: 'docs/guide.md',
      status: 'M'
    })

    await user.click(within(detailRegion).getByRole('button', { name: /docs\/deleted\.md/ }))
    expect(onOpenFileDiff).toHaveBeenCalledWith({
      kind: 'commit',
      commitHash: fullHash,
      shortHash: 'a1b2c3d',
      path: 'docs/deleted.md',
      status: 'D'
    })

    await user.click(
      within(detailRegion).getByRole('button', { name: /docs\/old\.md → docs\/renamed\.md/ })
    )
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
    expect(within(region).getByText('스테이지됨 (1)')).toBeInTheDocument()
    expect(within(region).getByText('변경 사항 (2)')).toBeInTheDocument()

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
          onPull,
          onPush,
          onFetch,
          onSync,
          onStageAll,
          onUnstageAll,
          onDiscardAll,
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

    // 2. ... menu lists all 7 items with separator, disables Unstage All Changes when staged=0, and dismisses on Escape / outside click
    const moreBtn = within(region).getByRole('button', { name: '더 보기' })
    await user.click(moreBtn)
    const moreMenu = within(region).getByRole('menu', { name: 'Git 패널 추가 작업' })
    expect(within(moreMenu).getByRole('separator')).toBeInTheDocument()
    expect(within(moreMenu).getByRole('menuitem', { name: 'Pull' })).toBeEnabled()
    expect(within(moreMenu).getByRole('menuitem', { name: 'Push' })).toBeEnabled()
    expect(within(moreMenu).getByRole('menuitem', { name: 'Fetch' })).toBeEnabled()
    expect(within(moreMenu).getByRole('menuitem', { name: 'Sync' })).toBeEnabled()
    expect(within(moreMenu).getByRole('menuitem', { name: 'Stage All Changes' })).toBeEnabled()
    expect(within(moreMenu).getByRole('menuitem', { name: 'Unstage All Changes' })).toBeDisabled()
    expect(within(moreMenu).getByRole('menuitem', { name: 'Discard All Changes' })).toBeEnabled()

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

    // 3. Staged-only repo enables Unstage All Changes and disables Stage/Discard All Changes
    rerender(
      <GitSidebarPanel
        {...buildProps({
          status: buildGitStatus({
            staged: [{ path: 'README.md', status: 'M' }],
            unstaged: [],
            untracked: []
          }),
          onStageAll,
          onUnstageAll,
          onDiscardAll,
          onCheckoutBranch
        })}
      />
    )
    await user.click(moreBtn)
    expect(within(region).getByRole('menuitem', { name: 'Stage All Changes' })).toBeDisabled()
    expect(within(region).getByRole('menuitem', { name: 'Discard All Changes' })).toBeDisabled()
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
      expect(discardBtn).toHaveTextContent('↶')
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
    const stagedSection = within(region).getByText('스테이지됨 (1)').closest('.git-section') as HTMLElement
    expect(
      within(stagedSection).queryByRole('button', { name: '전체 변경 사항 롤백' })
    ).not.toBeInTheDocument()

    expect(discardAllBtn).toHaveAttribute('title', '전체 변경 사항 롤백')
    expect(discardAllBtn).toHaveTextContent('전체 ↶')
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
})
