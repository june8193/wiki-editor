import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { createEmptyGitStatus, type GitBranchList, type GitStatus } from '@shared/git'
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
    onCommit: vi.fn(),
    onCheckoutBranch: vi.fn(),
    onPull: vi.fn(),
    onPush: vi.fn(),
    onSync: vi.fn(),
    ...overrides
  }
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
    expect(within(region).getByLabelText('현재 브랜치 main')).toHaveTextContent('main')
    expect(within(region).getByLabelText('Ahead 2 Behind 1')).toBeInTheDocument()

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

  it('validates non-empty commit message, triggers commit, remote pull/push/sync, branch checkout, loading state, and error dismissal', async () => {
    const user = userEvent.setup()
    const onCommit = vi.fn().mockResolvedValue(true)
    const onPull = vi.fn()
    const onPush = vi.fn()
    const onSync = vi.fn()
    const onCheckoutBranch = vi.fn()
    const onDismissError = vi.fn()

    const { rerender } = render(
      <GitSidebarPanel
        {...buildProps({
          onCommit,
          onPull,
          onPush,
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

    // Branch selection & checkout
    const branchSelect = within(region).getByLabelText('브랜치 선택')
    await user.selectOptions(branchSelect, 'feature/git')
    await user.click(within(region).getByRole('button', { name: '브랜치 전환' }))
    expect(onCheckoutBranch).toHaveBeenCalledWith('feature/git')

    // Pull / Push / Sync
    await user.click(within(region).getByRole('button', { name: 'Pull' }))
    await user.click(within(region).getByRole('button', { name: 'Push' }))
    await user.click(within(region).getByRole('button', { name: 'Sync' }))
    expect(onPull).toHaveBeenCalledTimes(1)
    expect(onPush).toHaveBeenCalledTimes(1)
    expect(onSync).toHaveBeenCalledTimes(1)

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
    expect(within(region).getByRole('button', { name: 'Sync' })).toBeDisabled()
    expect(within(region).getByRole('button', { name: 'Pull' })).toBeDisabled()

    const alert = within(region).getByRole('alert')
    expect(alert).toHaveTextContent('원격 저장소 인증에 실패했습니다.')
    await user.click(within(alert).getByRole('button', { name: 'Git 오류 닫기' }))
    expect(onDismissError).toHaveBeenCalledTimes(1)
  })

  it('renders Git panel with a fixed non-collapsible header and always keeps the body visible', async () => {
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
    for (const button of within(region).getAllByRole('button')) {
      expect(button).not.toHaveAttribute('aria-expanded')
    }
    expect(within(region).queryByText('▾')).not.toBeInTheDocument()
    expect(within(region).queryByText('▸')).not.toBeInTheDocument()

    const title = within(region).getByText('Git')
    const branchBadge = within(region).getByLabelText('현재 브랜치 main')
    const syncBadge = within(region).getByLabelText('Ahead 2 Behind 1')
    expect(title.closest('button')).toBeNull()
    expect(branchBadge.closest('button')).toBeNull()
    expect(syncBadge.closest('button')).toBeNull()

    await user.click(title)
    await user.click(branchBadge)
    expect(within(region).getByLabelText('브랜치 선택')).toBeInTheDocument()
    expect(within(region).getByLabelText('커밋 메시지')).toBeInTheDocument()
    expect(within(region).getByText('스테이지됨 (1)')).toBeInTheDocument()
    expect(within(region).getByText('변경 사항 (2)')).toBeInTheDocument()

    await user.click(within(region).getByRole('button', { name: 'Git 상태 새로고침' }))
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
    expect(within(region).getByText('Git')).toBeInTheDocument()
    expect(within(region).getByText(/워크스페이스를 먼저 열어주세요/)).toBeInTheDocument()
    for (const button of within(region).getAllByRole('button')) {
      expect(button).not.toHaveAttribute('aria-expanded')
    }
  })
})
