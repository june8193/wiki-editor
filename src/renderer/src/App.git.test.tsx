import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createEmptyGitStatus,
  type GitDiffRequest,
  type GitFileStatusCode,
  type GitGraphCommit,
  type GitLogResult
} from '@shared/git'
import type { WikiGitApi } from '@shared/ipc'
import { App } from './App'
import { clickActivityBarButton, switchWorkspaceFromView } from './test/appTestHelpers'
import {
  appendRawEditorText,
  createInMemoryWikiApi,
  getRawEditorText,
  triggerMenuCommand
} from './test/inMemoryWikiHarness'

vi.mock('mermaid', async () => (await import('./test/appTestHelpers')).createMermaidMockState().module)

function matchDiffLineText(expected: string) {
  return (_: string, el: Element | null) =>
    Boolean(el?.classList.contains('git-diff-line-text') && el.textContent === expected)
}

describe('Workspace Git sidebar integration & safe buffer/tree refresh', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
    vi.useRealTimers()
  })

  it('supports git init on non-git workspace, staging/committing, pull refreshing clean buffer & tree, dirty confirm, and conflict warning', async () => {
    const user = userEvent.setup()
    let isRepo = false
    let currentBranch = 'main'
    let staged: Array<{ path: string; status: 'A' | 'M' }> = []
    let unstaged: Array<{ path: string; status: 'M' }> = [{ path: 'guide.md', status: 'M' }]
    let currentStatus = () => ({
      ...createEmptyGitStatus(isRepo, 'C:/wiki'),
      branch: isRepo ? currentBranch : null,
      hasUpstream: isRepo,
      ahead: isRepo ? 1 : 0,
      behind: isRepo ? 1 : 0,
      staged: isRepo ? staged : [],
      unstaged: isRepo ? unstaged : [],
      untracked: []
    })

    let pullFailure: Error | null = null
    let pullMutation: (() => Promise<void>) | null = null
    let checkoutMutation: (() => Promise<void>) | null = null

    const gitMocks: Partial<WikiGitApi> = {
      status: vi.fn(async () => currentStatus()),
      init: vi.fn(async () => {
        isRepo = true
        return currentStatus()
      }),
      branches: vi.fn(async () => ({
        current: currentBranch,
        isDetached: false,
        branches: [
          { name: 'main', current: currentBranch === 'main', upstream: null },
          { name: 'docs-v2', current: currentBranch === 'docs-v2', upstream: null }
        ]
      })),
      stage: vi.fn(async (_ws, paths) => {
        for (const p of paths) {
          unstaged = unstaged.filter((item) => item.path !== p)
          staged = [...staged, { path: p, status: 'M' }]
        }
        return currentStatus()
      }),
      commit: vi.fn(async () => {
        staged = []
        return currentStatus()
      }),
      pull: vi.fn(async () => {
        if (pullFailure) throw pullFailure
        if (pullMutation) await pullMutation()
        unstaged = []
        return currentStatus()
      }),
      checkout: vi.fn(async (_ws, branchName) => {
        currentBranch = branchName
        if (checkoutMutation) await checkoutMutation()
        return currentStatus()
      })
    }

    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { autoSave: false },
      {
        selectedFolder: 'C:/wiki',
        workspaces: {
          'C:/wiki': {
            'guide.md': '# Initial Guide'
          }
        },
        git: gitMocks
      }
    )

    // Wire pull/checkout mutations directly onto the virtual workspace files
    pullMutation = async () => {
      await api.workspace.writeFile('C:/wiki/guide.md', '# Pulled From Remote')
      await api.workspace.createEntry('C:/wiki', 'pulled.md', 'file', '# Pulled File')
    }
    checkoutMutation = async () => {
      await api.workspace.writeFile('C:/wiki/guide.md', '# Docs V2 Branch')
    }

    window.wikiApi = api
    render(<App />)

    await clickActivityBarButton(user, 'Git')
    const gitRegionInitial = screen.getByRole('region', { name: 'Git 소스 제어' })
    expect(
      within(gitRegionInitial).getByText(/워크스페이스를 먼저 열어주세요/)
    ).toBeInTheDocument()

    await clickActivityBarButton(user, '탐색기')
    const explorer = screen.getByLabelText('워크스페이스 탐색기')

    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    await within(explorer).findByText('guide.md')

    await clickActivityBarButton(user, 'Git')
    const gitRegion = screen.getByRole('region', { name: 'Git 소스 제어' })
    expect(within(gitRegion).getByRole('button', { name: /Git 저장소 초기화/i })).toBeInTheDocument()
    await user.click(within(gitRegion).getByRole('button', { name: /Git 저장소 초기화/i }))

    expect(await within(gitRegion).findByLabelText('현재 브랜치 main')).toBeInTheDocument()
    await user.click(within(gitRegion).getByRole('button', { name: 'guide.md Stage' }))
    await user.type(within(gitRegion).getByLabelText('커밋 메시지'), 'feat: stage guide')
    await user.click(within(gitRegion).getByRole('button', { name: 'Commit' }))
    expect(gitMocks.commit).toHaveBeenCalledWith('C:/wiki', 'feat: stage guide')

    // Open guide.md cleanly in editor, then trigger Pull -> clean buffer & tree refresh automatically
    await clickActivityBarButton(user, '탐색기')
    await user.click(within(screen.getByLabelText('워크스페이스 탐색기')).getByText('guide.md'))
    const editorEl = await screen.findByTestId('document-editor')
    expect(getRawEditorText(editorEl)).toBe('# Initial Guide')

    await clickActivityBarButton(user, 'Git')
    const gitRegionAfterOpen = screen.getByRole('region', { name: 'Git 소스 제어' })
    await user.click(within(gitRegionAfterOpen).getByRole('button', { name: '더 보기' }))
    await user.click(within(gitRegionAfterOpen).getByRole('menuitem', { name: 'Pull' }))

    await waitFor(() => {
      expect(getRawEditorText(screen.getByTestId('document-editor'))).toBe('# Pulled From Remote')
    })
    await clickActivityBarButton(user, '탐색기')
    expect(
      await within(screen.getByLabelText('워크스페이스 탐색기')).findByText('pulled.md')
    ).toBeInTheDocument()

    // Edit guide.md without saving -> Checkout via branch picker prompts confirmation
    appendRawEditorText(screen.getByTestId('document-editor'), '\nUnsaved draft line')
    await clickActivityBarButton(user, 'Git')
    const gitRegionForBranch = screen.getByRole('region', { name: 'Git 소스 제어' })
    await user.click(within(gitRegionForBranch).getByRole('button', { name: '현재 브랜치 main' }))
    await user.click(within(gitRegionForBranch).getByRole('menuitem', { name: 'docs-v2' }))

    const confirmDialog = await screen.findByRole('alertdialog')
    expect(within(confirmDialog).getByText(/guide.md/)).toBeInTheDocument()

    // Canceling aborts checkout cleanly
    await user.click(within(confirmDialog).getByRole('button', { name: '취소' }))
    expect(gitMocks.checkout).not.toHaveBeenCalled()

    // Trigger checkout again and proceed without saving -> dirty edit is preserved & conflict warning appears
    await user.click(within(gitRegionForBranch).getByRole('button', { name: '현재 브랜치 main' }))
    await user.click(within(gitRegionForBranch).getByRole('menuitem', { name: 'docs-v2' }))
    const secondDialog = await screen.findByRole('alertdialog')
    await user.click(within(secondDialog).getByRole('button', { name: '저장 없이 진행' }))

    await waitFor(() => {
      expect(gitMocks.checkout).toHaveBeenCalledWith('C:/wiki', 'docs-v2')
    })
    expect(getRawEditorText(screen.getByTestId('document-editor'))).toContain('Unsaved draft line')
    expect(await within(gitRegionForBranch).findByRole('alert')).toHaveTextContent(
      /충돌할 수 있습니다 \(guide\.md\)/
    )

    // Dismiss Git error and trigger real Git error -> displayed safely inside Git panel
    await user.click(within(gitRegionForBranch).getByRole('button', { name: 'Git 오류 닫기' }))
    expect(within(gitRegionForBranch).queryByRole('alert')).not.toBeInTheDocument()

    // Save dirty edits via saving dialog path, then test Git pull failure
    pullFailure = new Error('원격 저장소 인증에 실패했습니다.')
    await user.click(within(gitRegionForBranch).getByRole('button', { name: '더 보기' }))
    await user.click(within(gitRegionForBranch).getByRole('menuitem', { name: 'Pull' }))
    const saveDialog = await screen.findByRole('alertdialog')
    await user.click(within(saveDialog).getByRole('button', { name: '저장 후 진행' }))

    expect(await within(gitRegionForBranch).findByRole('alert')).toHaveTextContent(
      '원격 저장소 인증에 실패했습니다.'
    )
  }, 15_000)

  it('closes deleted clean tabs and preserves deleted dirty tabs with warning after Sync', async () => {
    const user = userEvent.setup()
    const cleanStatus = {
      ...createEmptyGitStatus(true, 'C:/wiki'),
      branch: 'main',
      hasUpstream: true
    }

    let syncMutation: (() => Promise<void>) | null = null
    const gitMocks: Partial<WikiGitApi> = {
      status: vi.fn(async () => cleanStatus),
      branches: vi.fn(async () => ({
        current: 'main',
        isDetached: false,
        branches: [{ name: 'main', current: true, upstream: 'origin/main' }]
      })),
      sync: vi.fn(async () => {
        if (syncMutation) await syncMutation()
        return { status: cleanStatus, pulled: true, pushed: true, summary: '동기화 완료' }
      })
    }

    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { autoSave: false },
      {
        selectedFolder: 'C:/wiki',
        workspaces: {
          'C:/wiki': {
            'obsolete.md': '# Obsolete',
            'keep-dirty.md': '# Local Original'
          }
        },
        git: gitMocks
      }
    )

    syncMutation = async () => {
      await api.workspace.deleteEntry('C:/wiki/obsolete.md')
      await api.workspace.deleteEntry('C:/wiki/keep-dirty.md')
    }

    window.wikiApi = api
    render(<App />)

    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    const explorer = screen.getByLabelText('워크스페이스 탐색기')

    // Open both files: leave obsolete.md clean and make keep-dirty.md dirty
    await user.click(await within(explorer).findByText('obsolete.md'))
    expect(await screen.findByRole('tab', { name: 'obsolete.md' })).toBeInTheDocument()

    await user.click(within(explorer).getByText('keep-dirty.md'))
    appendRawEditorText(await screen.findByTestId('document-editor'), '\nImportant local edit')

    // Switch to Git view and click Sync in 26px branch subrow -> proceed without saving -> obsolete.md clean tab closes, dirty keep-dirty.md stays open with warning
    await clickActivityBarButton(user, 'Git')
    const gitRegion = screen.getByRole('region', { name: 'Git 소스 제어' })
    await user.click(within(gitRegion).getByRole('button', { name: /Sync/ }))
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: '저장 없이 진행' }))

    await waitFor(() => {
      expect(screen.queryByRole('tab', { name: 'obsolete.md' })).not.toBeInTheDocument()
    })
    expect(screen.getByRole('tab', { name: /keep-dirty\.md/ })).toBeInTheDocument()
    expect(getRawEditorText(screen.getByTestId('document-editor'))).toContain('Important local edit')
    expect(await within(gitRegion).findByRole('alert')).toHaveTextContent(
      /삭제되었으나 미저장 편집 내용이 남아 있습니다 \(keep-dirty\.md\)/
    )
  })

  it('supports Git panel ... menu (Fetch without dirty prompt, Stage/Unstage/Discard All with danger dialog) and 26px branch subrow publish/sync transitions', async () => {
    const user = userEvent.setup()
    let hasUpstream = false
    let ahead = 0
    let behind = 0
    let staged: Array<{ path: string; status: GitFileStatusCode }> = []
    let unstaged: Array<{ path: string; status: GitFileStatusCode }> = [{ path: 'note.md', status: 'M' }]
    let untracked: Array<{ path: string; status: GitFileStatusCode }> = [{ path: 'draft.md', status: '?' }]
    let commits: GitGraphCommit[] = [
      {
        hash: '1111111111111111111111111111111111111111',
        shortHash: '1111111',
        parents: [],
        subject: 'Local commit',
        authorName: 'Alice',
        committedAt: '2026-11-18T10:00:00+09:00',
        refs: [{ name: 'main', kind: 'local-branch', isCurrentHead: true }]
      }
    ]

    const buildStatus = () => ({
      ...createEmptyGitStatus(true, 'C:/wiki/subrow-app'),
      branch: 'main',
      hasUpstream,
      ahead,
      behind,
      staged,
      unstaged,
      untracked
    })

    const fetchSpy = vi.fn(async () => {
      behind = 2
      commits = [
        {
          hash: '2222222222222222222222222222222222222222',
          shortHash: '2222222',
          parents: ['1111111111111111111111111111111111111111'],
          subject: 'Fetched remote commit',
          authorName: 'Bob',
          committedAt: '2026-11-18T11:00:00+09:00',
          refs: [{ name: 'origin/main', kind: 'remote-branch' }]
        },
        ...commits
      ]
      return buildStatus()
    })
    const pushSpy = vi.fn(async () => {
      hasUpstream = true
      ahead = 0
      return buildStatus()
    })
    const syncSpy = vi.fn(async () => {
      behind = 0
      ahead = 0
      return { status: buildStatus(), pulled: true, pushed: true, summary: '동기화 완료' }
    })
    const stageAllSpy = vi.fn(async () => {
      staged = [...unstaged, ...untracked].map((f) => ({
        path: f.path,
        status: (f.status === '?' ? 'A' : f.status) as GitFileStatusCode
      }))
      unstaged = []
      untracked = []
      return buildStatus()
    })
    const unstageAllSpy = vi.fn(async () => {
      unstaged = [{ path: 'note.md', status: 'M' }]
      untracked = [{ path: 'draft.md', status: '?' }]
      staged = []
      return buildStatus()
    })
    const discardAllSpy = vi.fn(async () => {
      unstaged = []
      untracked = []
      return buildStatus()
    })

    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { autoSave: false },
      {
        selectedFolder: 'C:/wiki/subrow-app',
        workspaces: {
          'C:/wiki/subrow-app': {
            'note.md': '# Note',
            'draft.md': '# Draft'
          }
        },
        git: {
          status: vi.fn(async () => buildStatus()),
          branches: vi.fn(async () => ({
            current: 'main',
            isDetached: false,
            branches: [
              { name: 'main', current: true, upstream: hasUpstream ? 'origin/main' : null },
              { name: 'topic', current: false, upstream: null }
            ]
          })),
          fetch: fetchSpy,
          push: pushSpy,
          sync: syncSpy,
          stageAll: stageAllSpy,
          unstageAll: unstageAllSpy,
          discardAll: discardAllSpy,
          log: vi.fn(async () => ({ commits, hasMore: false }))
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')

    // Dirty buffer in editor before switching to Git view
    await user.click(await within(screen.getByLabelText('워크스페이스 탐색기')).findByText('note.md'))
    appendRawEditorText(await screen.findByTestId('document-editor'), '\nUnsaved draft')

    await clickActivityBarButton(user, 'Git')
    const gitRegion = screen.getByRole('region', { name: 'Git 소스 제어' })

    // 1. Unpublished branch shows 미게시 trigger; clicking executes Push/Publish without upstream
    const publishBtn = within(gitRegion).getByRole('button', { name: /미게시/ })
    await user.click(publishBtn)
    await waitFor(() => {
      expect(pushSpy).toHaveBeenCalledWith('C:/wiki/subrow-app')
    })
    expect(await within(gitRegion).findByRole('button', { name: /Sync.*↓0 ↑0/ })).toBeInTheDocument()

    // 2. Fetch via ... menu runs WITHOUT prompting dirty buffer ConfirmDialog and updates behind + Graph
    await user.click(within(gitRegion).getByRole('button', { name: '더 보기' }))
    await user.click(within(gitRegion).getByRole('menuitem', { name: 'Fetch' }))
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith('C:/wiki/subrow-app')
    })
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(await within(gitRegion).findByRole('button', { name: /Sync.*↓2 ↑0/ })).toBeInTheDocument()
    expect(await within(gitRegion).findByText('Fetched remote commit')).toBeInTheDocument()

    // 3. Clicking ↓2 ↑0 triggers Sync with dirty buffer ConfirmDialog
    await user.click(within(gitRegion).getByRole('button', { name: /Sync.*↓2 ↑0/ }))
    const syncConfirm = await screen.findByRole('alertdialog')
    await user.click(within(syncConfirm).getByRole('button', { name: '저장 없이 진행' }))
    await waitFor(() => {
      expect(syncSpy).toHaveBeenCalledWith('C:/wiki/subrow-app')
    })
    expect(await within(gitRegion).findByRole('button', { name: /Sync.*↓0 ↑0/ })).toBeInTheDocument()

    // 4. Stage All Changes & Unstage All Changes via ... menu
    await user.click(within(gitRegion).getByRole('button', { name: '더 보기' }))
    await user.click(within(gitRegion).getByRole('menuitem', { name: 'Stage All Changes' }))
    await waitFor(() => {
      expect(stageAllSpy).toHaveBeenCalledWith('C:/wiki/subrow-app')
    })

    await user.click(within(gitRegion).getByRole('button', { name: '더 보기' }))
    await user.click(within(gitRegion).getByRole('menuitem', { name: 'Unstage All Changes' }))
    await waitFor(() => {
      expect(unstageAllSpy).toHaveBeenCalledWith('C:/wiki/subrow-app')
    })

    // 5. Discard All Changes via ... menu opens danger ConfirmDialog distinguishing tracked & untracked counts
    await user.click(within(gitRegion).getByRole('button', { name: '더 보기' }))
    await user.click(within(gitRegion).getByRole('menuitem', { name: 'Discard All Changes' }))
    const dangerDialog = await screen.findByRole('alertdialog')
    expect(dangerDialog).toHaveTextContent('2')
    expect(dangerDialog).toHaveTextContent(/복구/)
    expect(dangerDialog).toHaveTextContent(/휴지통/)
    expect(within(dangerDialog).getByRole('button', { name: '전체 롤백' })).toHaveClass('btn-danger')
    await user.click(within(dangerDialog).getByRole('button', { name: '전체 롤백' }))

    const dirtyDiscardDialog = await screen.findByRole('alertdialog')
    await user.click(within(dirtyDiscardDialog).getByRole('button', { name: '저장 없이 진행' }))
    await waitFor(() => {
      expect(discardAllSpy).toHaveBeenCalledWith('C:/wiki/subrow-app')
    })
  })

  it('supports fixed common branch/sync controls while Changes is collapsed, Changes/Graph accordion transitions, section resizer keyboard/double-click, and session-only preservation across view switches', async () => {
    const user = userEvent.setup()
    let currentBranch = 'main'
    const buildStatus = () => ({
      ...createEmptyGitStatus(true, 'C:/wiki/split-git'),
      branch: currentBranch,
      hasUpstream: true,
      staged: [{ path: 'staged.md', status: 'A' as const }],
      unstaged: [{ path: 'changed.md', status: 'M' as const }],
      untracked: [{ path: 'draft.md', status: '?' as const }]
    })

    const checkoutSpy = vi.fn(async (_ws: string, branchName: string) => {
      currentBranch = branchName
      return buildStatus()
    })
    const syncSpy = vi.fn(async () => ({
      status: buildStatus(),
      pulled: true,
      pushed: true,
      summary: '동기화 완료'
    }))

    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { autoSave: false },
      {
        selectedFolder: 'C:/wiki/split-git',
        workspaces: {
          'C:/wiki/split-git': {
            'changed.md': '# Changed'
          }
        },
        git: {
          status: vi.fn(async () => buildStatus()),
          branches: vi.fn(async () => ({
            current: currentBranch,
            isDetached: false,
            branches: [
              { name: 'main', current: currentBranch === 'main', upstream: 'origin/main' },
              { name: 'docs-v2', current: currentBranch === 'docs-v2', upstream: null }
            ]
          })),
          checkout: checkoutSpy,
          sync: syncSpy
        }
      }
    )
    const configUpdateSpy = vi.spyOn(api.config, 'update')
    window.wikiApi = api

    const view = render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    await clickActivityBarButton(user, 'Git')

    const gitRegion = screen.getByRole('region', { name: 'Git 소스 제어' })
    expect(within(gitRegion).getByText('Source Control').closest('button')).toBeNull()

    const changesSection = within(gitRegion).getByRole('region', { name: 'Changes' })
    const changesToggle = within(changesSection).getAllByRole('button', { name: /^Changes/i })[0]
    const graphToggle = within(gitRegion).getByRole('button', { name: /Graph/i })
    expect(changesToggle).toHaveAttribute('aria-expanded', 'true')
    expect(changesToggle).toHaveTextContent('3')
    expect(graphToggle).toHaveAttribute('aria-expanded', 'true')

    const resizer = within(gitRegion).getByRole('separator', { name: 'Git 섹션 높이 조절' })
    expect(resizer).toHaveAttribute('aria-orientation', 'horizontal')
    expect(resizer).toHaveAttribute('aria-valuemin', '20')
    expect(resizer).toHaveAttribute('aria-valuemax', '80')
    expect(resizer).toHaveAttribute('aria-valuenow', '50')

    // Collapse Changes -> separator hides, Graph fills height, branch switch & Sync in 26px branch subrow still work
    await user.click(changesToggle)
    expect(changesToggle).toHaveAttribute('aria-expanded', 'false')
    expect(
      within(gitRegion).queryByRole('separator', { name: 'Git 섹션 높이 조절' })
    ).not.toBeInTheDocument()
    expect(within(gitRegion).queryByLabelText('커밋 메시지')).not.toBeInTheDocument()
    expect(within(gitRegion).getByRole('region', { name: 'Graph' })).toHaveStyle({
      flex: '1 1 0%'
    })

    await user.click(within(gitRegion).getByRole('button', { name: '현재 브랜치 main' }))
    await user.click(within(gitRegion).getByRole('menuitem', { name: 'docs-v2' }))
    await waitFor(() => {
      expect(checkoutSpy).toHaveBeenCalledWith('C:/wiki/split-git', 'docs-v2')
      expect(within(gitRegion).getByLabelText('현재 브랜치 docs-v2')).toBeInTheDocument()
    })

    await user.click(within(gitRegion).getByRole('button', { name: /Sync/ }))
    await waitFor(() => {
      expect(syncSpy).toHaveBeenCalledTimes(1)
    })

    // Collapse Graph too -> both sections collapsed
    await user.click(graphToggle)
    expect(graphToggle).toHaveAttribute('aria-expanded', 'false')
    expect(
      within(gitRegion).queryByRole('separator', { name: 'Git 섹션 높이 조절' })
    ).not.toBeInTheDocument()

    // Re-expand both -> resizer returns
    await user.click(changesToggle)
    await user.click(graphToggle)
    const activeResizer = within(gitRegion).getByRole('separator', { name: 'Git 섹션 높이 조절' })
    expect(activeResizer).toHaveAttribute('aria-valuenow', '50')

    // Keyboard resize & clamping [20, 80] + double-click restore 50%
    fireEvent.keyDown(activeResizer, { key: 'ArrowDown' })
    expect(activeResizer).toHaveAttribute('aria-valuenow', '55')
    for (let i = 0; i < 10; i += 1) {
      fireEvent.keyDown(activeResizer, { key: 'ArrowDown' })
    }
    expect(activeResizer).toHaveAttribute('aria-valuenow', '80')
    for (let i = 0; i < 15; i += 1) {
      fireEvent.keyDown(activeResizer, { key: 'ArrowUp' })
    }
    expect(activeResizer).toHaveAttribute('aria-valuenow', '20')

    fireEvent.doubleClick(activeResizer)
    expect(activeResizer).toHaveAttribute('aria-valuenow', '50')

    fireEvent.keyDown(activeResizer, { key: 'ArrowDown' })
    fireEvent.keyDown(activeResizer, { key: 'ArrowDown' })
    expect(activeResizer).toHaveAttribute('aria-valuenow', '60')

    // Collapse Graph, switch away to Explorer and back to Git -> collapsed state & 60% ratio preserved
    await user.click(graphToggle)
    await clickActivityBarButton(user, '탐색기')
    await clickActivityBarButton(user, 'Git')

    const reopenedGit = screen.getByRole('region', { name: 'Git 소스 제어' })
    const reopenedGraphToggle = within(reopenedGit).getByRole('button', { name: /Graph/i })
    expect(reopenedGraphToggle).toHaveAttribute('aria-expanded', 'false')
    await user.click(reopenedGraphToggle)
    expect(
      within(reopenedGit).getByRole('separator', { name: 'Git 섹션 높이 조절' })
    ).toHaveAttribute('aria-valuenow', '60')

    // Session-only: config.json untouched, remount resets to expanded 50%
    expect(configUpdateSpy).not.toHaveBeenCalled()
    view.unmount()

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    await clickActivityBarButton(user, 'Git')

    const remountedGit = screen.getByRole('region', { name: 'Git 소스 제어' })
    const remountedChangesSection = within(remountedGit).getByRole('region', { name: 'Changes' })
    expect(
      within(remountedChangesSection).getAllByRole('button', { name: /^Changes/i })[0]
    ).toHaveAttribute('aria-expanded', 'true')
    expect(within(remountedGit).getByRole('button', { name: /Graph/i })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(
      within(remountedGit).getByRole('separator', { name: 'Git 섹션 높이 조절' })
    ).toHaveAttribute('aria-valuenow', '50')
  })

  it('shows unborn commit history empty message in Graph section when repository has no commits', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { autoSave: false },
      {
        selectedFolder: 'C:/wiki/unborn-repo',
        workspaces: {
          'C:/wiki/unborn-repo': {
            'README.md': '# Hello'
          }
        },
        git: {
          status: vi.fn(async () => ({
            ...createEmptyGitStatus(true, 'C:/wiki/unborn-repo'),
            branch: 'main',
            isUnborn: true
          })),
          branches: vi.fn(async () => ({ current: 'main', isDetached: false, branches: [] })),
          log: vi.fn(async () => ({ commits: [], hasMore: false }))
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    await clickActivityBarButton(user, 'Git')

    const graphRegion = screen.getByRole('region', { name: 'Graph' })
    expect(within(graphRegion).getByText('아직 커밋된 내역이 없습니다.')).toBeInTheDocument()
  })

  it('renders Graph commit lanes and badges, filters 전체/현재 브랜치 without collapsing, paginates with 더 보기, and refreshes on commit and workspace changes', async () => {
    const user = userEvent.setup()

    const makeCommit = (
      hash: string,
      parents: string[],
      subject: string,
      authorName: string,
      refs: GitGraphCommit['refs'] = []
    ): GitGraphCommit => ({
      hash,
      shortHash: hash.slice(0, 7),
      parents,
      subject,
      authorName,
      committedAt: '2026-11-15T06:30:00Z',
      refs
    })

    const allCommits: GitGraphCommit[] = [
      makeCommit(
        'aaaa111111111111111111111111111111111111',
        ['bbbb222222222222222222222222222222222222', 'cccc333333333333333333333333333333333333'],
        'Merge feature-x',
        'Alice',
        [
          { name: 'HEAD', kind: 'head', isCurrentHead: true },
          { name: 'main', kind: 'local-branch', isCurrentHead: true },
          { name: 'origin/main', kind: 'remote-branch' },
          { name: 'v1.0.0', kind: 'tag' }
        ]
      ),
      makeCommit(
        'cccc333333333333333333333333333333333333',
        ['bbbb222222222222222222222222222222222222'],
        'Side branch work',
        'Bob',
        [{ name: 'feature-x', kind: 'local-branch' }]
      )
    ]

    const currentPage1: GitGraphCommit[] = [
      makeCommit(
        'aaaa111111111111111111111111111111111111',
        ['bbbb222222222222222222222222222222222222'],
        'Merge feature-x',
        'Alice',
        [
          { name: 'HEAD', kind: 'head', isCurrentHead: true },
          { name: 'main', kind: 'local-branch', isCurrentHead: true }
        ]
      )
    ]

    const currentPage2: GitGraphCommit[] = [
      makeCommit(
        'bbbb222222222222222222222222222222222222',
        [],
        'Older mainline commit',
        'Carol'
      )
    ]

    const committedHead = makeCommit(
      'dddd444444444444444444444444444444444444',
      ['aaaa111111111111111111111111111111111111'],
      'Add sidebar graph test',
      'Alice',
      [
        { name: 'HEAD', kind: 'head', isCurrentHead: true },
        { name: 'main', kind: 'local-branch', isCurrentHead: true }
      ]
    )

    const externalCommit = makeCommit(
      'eeee555555555555555555555555555555555555',
      ['dddd444444444444444444444444444444444444'],
      'External CLI commit',
      'Dana',
      [
        { name: 'HEAD', kind: 'head', isCurrentHead: true },
        { name: 'main', kind: 'local-branch', isCurrentHead: true }
      ]
    )

    let hasCommitted = false
    let hasExternalCommit = false
    let delayNextAllScope = false
    let resolveDelayedAll!: (result: GitLogResult) => void

    const logSpy = vi.fn(
      (_ws: string, options?: { scope?: 'all' | 'current'; limit?: number; skip?: number }) => {
        if (options?.scope === 'current') {
          if (hasExternalCommit) {
            return Promise.resolve({ commits: [externalCommit, committedHead], hasMore: false })
          }
          if (hasCommitted) {
            return Promise.resolve({ commits: [committedHead, ...currentPage1], hasMore: false })
          }
          if ((options.skip ?? 0) > 0) {
            return Promise.resolve({ commits: currentPage2, hasMore: false })
          }
          return Promise.resolve({ commits: currentPage1, hasMore: true })
        }

        if (delayNextAllScope) {
          delayNextAllScope = false
          return new Promise<GitLogResult>((resolve) => {
            resolveDelayedAll = resolve
          })
        }

        return Promise.resolve({ commits: allCommits, hasMore: false })
      }
    )

    const { api, emitMenuCommand, emitWorkspaceChange } = createInMemoryWikiApi(
      { autoSave: false },
      {
        selectedFolder: 'C:/wiki/graph-app',
        workspaces: {
          'C:/wiki/graph-app': {
            'notes.md': '# Notes'
          }
        },
        git: {
          status: vi.fn(async () => ({
            ...createEmptyGitStatus(true, 'C:/wiki/graph-app'),
            branch: 'main',
            staged: hasCommitted ? [] : [{ path: 'notes.md', status: 'M' as GitFileStatusCode }]
          })),
          branches: vi.fn(async () => ({
            current: 'main',
            isDetached: false,
            branches: [
              { name: 'main', current: true, upstream: 'origin/main' },
              { name: 'feature-x', current: false, upstream: null }
            ]
          })),
          commit: vi.fn(async () => {
            hasCommitted = true
            return {
              ...createEmptyGitStatus(true, 'C:/wiki/graph-app'),
              branch: 'main'
            }
          }),
          log: logSpy
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    await clickActivityBarButton(user, 'Git')

    const gitRegion = screen.getByRole('region', { name: 'Git 소스 제어' })
    const graphRegion = within(gitRegion).getByRole('region', { name: 'Graph' })
    const graphAccordionBtn = within(graphRegion).getByRole('button', { name: /Graph/i })

    await waitFor(() => {
      expect(within(graphRegion).getByText('Merge feature-x')).toBeInTheDocument()
    })
    expect(within(graphRegion).getByText('Side branch work')).toBeInTheDocument()
    expect(within(graphRegion).queryByText('HEAD')).toBeNull()
    expect(within(graphRegion).queryByText('origin/main')).toBeNull()
    expect(within(graphRegion).getByText('main').closest('.git-ref-badge')).toHaveClass(
      'is-local-branch',
      'is-current-head'
    )
    expect(within(graphRegion).getByTitle('origin')).toHaveClass('is-synced-remote')
    expect(within(graphRegion).getByText('v1.0.0').closest('.git-ref-badge')).toHaveClass('is-tag')
    expect(graphRegion.querySelectorAll('svg.git-graph-svg').length).toBe(2)

    const items = within(within(graphRegion).getByRole('list', { name: '커밋 그래프' })).getAllByRole(
      'listitem'
    )
    expect(items[0].getAttribute('title')).toMatch(
      /^aaaa111 · Alice · \d{4}-\d{2}-\d{2} \d{2}:\d{2} · Merge feature-x$/
    )

    // Switch Auto -> 현재 브랜치 without toggling Graph accordion collapse
    const autoBtn = within(graphRegion).getByRole('button', { name: 'Auto' })
    await user.click(autoBtn)
    await waitFor(() => {
      expect(within(graphRegion).queryByText('Side branch work')).not.toBeInTheDocument()
    })
    expect(graphAccordionBtn).toHaveAttribute('aria-expanded', 'true')
    const currentBtn = within(graphRegion).getByRole('button', { name: '현재 브랜치' })

    // Click 더 보기 to paginate current branch commits
    await user.click(within(graphRegion).getByRole('button', { name: '더 보기' }))
    await waitFor(() => {
      expect(within(graphRegion).getByText('Older mainline commit')).toBeInTheDocument()
    })
    expect(logSpy).toHaveBeenCalledWith('C:/wiki/graph-app', {
      scope: 'current',
      limit: 100,
      skip: 1
    })

    // Trigger delayed Auto ('all') request, then immediately toggle back to 현재 브랜치 -> stale response ignored
    delayNextAllScope = true
    await user.click(currentBtn)
    await user.click(within(graphRegion).getByRole('button', { name: 'Auto' }))
    await waitFor(() => {
      expect(within(graphRegion).getByText('Merge feature-x')).toBeInTheDocument()
    })
    await act(async () => {
      resolveDelayedAll({
        commits: [makeCommit('stale99999999999999999999999999999999999', [], 'Stale commit', 'Ghost')],
        hasMore: false
      })
    })
    expect(within(graphRegion).queryByText('Stale commit')).not.toBeInTheDocument()

    // Commit refreshes Graph to latest page 1
    await user.type(within(gitRegion).getByLabelText('커밋 메시지'), 'Add sidebar graph test')
    await user.click(within(gitRegion).getByRole('button', { name: 'Commit' }))
    await waitFor(() => {
      expect(within(graphRegion).getByText('Add sidebar graph test')).toBeInTheDocument()
    })

    // Workspace change event also refreshes Graph automatically
    hasExternalCommit = true
    await act(async () => {
      emitWorkspaceChange({
        rootPath: 'C:/wiki/graph-app',
        eventType: 'change',
        relativePath: 'notes.md'
      })
    })
    await waitFor(() => {
      expect(within(graphRegion).getByText('External CLI commit')).toBeInTheDocument()
    })
  })

  it('expands inline commit detail with files, switches/collapses commits, copies full hash, and clears on scope switch', async () => {
    const user = userEvent.setup()
    const firstHash = '1111111111111111111111111111111111111111'
    const emptyHash = '2222222222222222222222222222222222222222'

    const commitDetailSpy = vi.fn(async (_rootPath: string, commitHash: string) => {
      if (commitHash === firstHash) {
        return {
          hash: firstHash,
          shortHash: '1111111',
          parents: [emptyHash],
          subject: 'feat: graph detail commit',
          body: 'Detailed body line 1\nDetailed body line 2',
          authorName: 'Alice',
          authorEmail: 'alice@example.com',
          committedAt: '2026-11-15T10:00:00+09:00',
          files: [
            { status: 'A' as GitFileStatusCode, path: 'docs/added.md' },
            { status: 'M' as GitFileStatusCode, path: 'notes.md' },
            { status: 'R' as GitFileStatusCode, origPath: 'old.md', path: 'renamed.md' }
          ]
        }
      }

      return {
        hash: emptyHash,
        shortHash: '2222222',
        parents: [],
        subject: 'chore: empty root commit',
        body: '',
        authorName: 'Bob',
        authorEmail: 'bob@example.com',
        committedAt: '2026-11-14T10:00:00+09:00',
        files: []
      }
    })

    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { autoSave: false },
      {
        selectedFolder: 'C:/wiki/graph-detail-app',
        workspaces: {
          'C:/wiki/graph-detail-app': {
            'notes.md': '# Notes'
          }
        },
        git: {
          status: vi.fn(async () => ({
            ...createEmptyGitStatus(true, 'C:/wiki/graph-detail-app'),
            branch: 'main'
          })),
          branches: vi.fn(async () => ({
            current: 'main',
            isDetached: false,
            branches: [{ name: 'main', current: true, upstream: null }]
          })),
          log: vi.fn(async (_rootPath: string, options?: { scope?: 'all' | 'current' }) => ({
            commits:
              options?.scope === 'current'
                ? [
                    {
                      hash: emptyHash,
                      shortHash: '2222222',
                      parents: [],
                      subject: 'chore: empty root commit',
                      authorName: 'Bob',
                      committedAt: '2026-11-14T10:00:00+09:00',
                      refs: [{ name: 'HEAD', kind: 'head' as const }]
                    }
                  ]
                : [
                    {
                      hash: firstHash,
                      shortHash: '1111111',
                      parents: [emptyHash],
                      subject: 'feat: graph detail commit',
                      authorName: 'Alice',
                      committedAt: '2026-11-15T10:00:00+09:00',
                      refs: [{ name: 'main', kind: 'local-branch' as const }]
                    },
                    {
                      hash: emptyHash,
                      shortHash: '2222222',
                      parents: [],
                      subject: 'chore: empty root commit',
                      authorName: 'Bob',
                      committedAt: '2026-11-14T10:00:00+09:00',
                      refs: [{ name: 'HEAD', kind: 'head' as const }]
                    }
                  ],
            hasMore: false
          })),
          commitDetail: commitDetailSpy
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    await clickActivityBarButton(user, 'Git')

    const gitRegion = screen.getByRole('region', { name: 'Git 소스 제어' })
    const graphRegion = within(gitRegion).getByRole('region', { name: 'Graph' })

    const firstRowBtn = await within(graphRegion).findByRole('button', {
      name: /feat: graph detail commit/
    })
    expect(firstRowBtn).toHaveAttribute('aria-expanded', 'false')

    // Click commit row -> expands inline detail directly inside the same commit item
    await user.click(firstRowBtn)
    expect(commitDetailSpy).toHaveBeenCalledWith('C:/wiki/graph-detail-app', firstHash)

    const firstDetailRegion = await within(graphRegion).findByRole('region', {
      name: '1111111 커밋 상세'
    })
    expect(firstRowBtn).toHaveAttribute('aria-expanded', 'true')
    const firstListItem = firstRowBtn.closest('li')
    expect(firstListItem).not.toBeNull()
    expect(firstListItem?.contains(firstDetailRegion)).toBe(true)

    expect(firstDetailRegion).toHaveTextContent('Detailed body line 1')
    expect(firstDetailRegion).toHaveTextContent('Detailed body line 2')
    expect(firstDetailRegion).toHaveTextContent('alice@example.com')
    expect(within(firstDetailRegion).getByText('added.md')).toBeInTheDocument()
    expect(within(firstDetailRegion).getByText('docs')).toBeInTheDocument()
    expect(within(firstDetailRegion).getByText('notes.md')).toBeInTheDocument()
    expect(within(firstDetailRegion).getByText('old.md → renamed.md')).toBeInTheDocument()
    expect(within(firstDetailRegion).getByText('A')).toHaveClass('git-status-letter', 'is-green')
    expect(within(firstDetailRegion).getByText('M')).toHaveClass('git-status-letter', 'is-amber')
    expect(within(firstDetailRegion).getByText('R')).toHaveClass('git-status-letter', 'is-accent')

    // Copy full commit hash
    const writeTextSpy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
    try {
      const copyBtn = within(firstDetailRegion).getByRole('button', { name: '해시 복사' })
      expect(copyBtn.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
      await user.click(copyBtn)
      expect(writeTextSpy).toHaveBeenCalledWith(firstHash)
    } finally {
      writeTextSpy.mockRestore()
    }

    // Click another commit -> replaces inline detail and collapses previous row
    const secondRowBtn = within(graphRegion).getByRole('button', {
      name: /chore: empty root commit/
    })
    await user.click(secondRowBtn)
    expect(commitDetailSpy).toHaveBeenCalledWith('C:/wiki/graph-detail-app', emptyHash)

    const emptyDetailRegion = await within(graphRegion).findByRole('region', {
      name: '2222222 커밋 상세'
    })
    expect(firstRowBtn).toHaveAttribute('aria-expanded', 'false')
    expect(secondRowBtn).toHaveAttribute('aria-expanded', 'true')
    expect(emptyDetailRegion).toHaveTextContent('변경된 파일이 없습니다.')
    expect(within(graphRegion).queryByRole('region', { name: '1111111 커밋 상세' })).toBeNull()

    // Scope toggle clears expanded detail cleanly
    await user.click(within(graphRegion).getByRole('button', { name: 'Auto' }))
    await waitFor(() => {
      expect(within(graphRegion).queryByRole('region', { name: '2222222 커밋 상세' })).toBeNull()
    })

    // Re-expand and click same commit row again to collapse
    const currentRowBtn = await within(graphRegion).findByRole('button', {
      name: /chore: empty root commit/
    })
    await user.click(currentRowBtn)
    await within(graphRegion).findByRole('region', { name: '2222222 커밋 상세' })
    await user.click(currentRowBtn)
    expect(currentRowBtn).toHaveAttribute('aria-expanded', 'false')
    expect(within(graphRegion).queryByRole('region', { name: '2222222 커밋 상세' })).toBeNull()
  })

  it('supports smart commit CTA transitions (auto-stage ConfirmDialog, Publish Branch, Sync Changes) and compound Commit & Push / Commit & Sync error and dirty-buffer flows', async () => {
    const user = userEvent.setup()
    let hasUpstream = false
    let ahead = 0
    let behind = 0
    let hasConflicts = false
    let staged: Array<{ path: string; status: GitFileStatusCode }> = []
    let unstaged: Array<{ path: string; status: GitFileStatusCode }> = [
      { path: 'note.md', status: 'M' }
    ]
    let untracked: Array<{ path: string; status: GitFileStatusCode }> = [
      { path: 'draft.md', status: '?' }
    ]
    let commits: GitGraphCommit[] = []
    const callOrder: string[] = []
    let pushShouldFail = false

    const buildStatus = () => ({
      ...createEmptyGitStatus(true, 'C:/wiki/smart-cta'),
      branch: 'feature/smart',
      hasUpstream,
      ahead,
      behind,
      hasConflicts,
      staged,
      unstaged,
      untracked
    })

    const stageAllSpy = vi.fn(async () => {
      callOrder.push('stageAll')
      staged = [...unstaged, ...untracked].map((file) => ({
        path: file.path,
        status: (file.status === '?' ? 'A' : file.status) as GitFileStatusCode
      }))
      unstaged = []
      untracked = []
      return buildStatus()
    })

    const commitSpy = vi.fn(async (_ws: string, message: string) => {
      callOrder.push(`commit:${message}`)
      staged = []
      ahead += 1
      commits = [
        {
          hash: `${commits.length + 1}`.repeat(40),
          shortHash: `${commits.length + 1}`.repeat(7),
          parents: commits[0] ? [commits[0].hash] : [],
          subject: message,
          authorName: 'Alice',
          committedAt: '2026-11-19T10:00:00+09:00',
          refs: [{ name: 'feature/smart', kind: 'local-branch', isCurrentHead: true }]
        },
        ...commits
      ]
      return buildStatus()
    })

    const pushSpy = vi.fn(async () => {
      callOrder.push('push')
      if (pushShouldFail) {
        throw new Error('원격 저장소 Push 권한이 없습니다.')
      }
      hasUpstream = true
      ahead = 0
      return buildStatus()
    })

    const syncSpy = vi.fn(async () => {
      callOrder.push('sync')
      ahead = 0
      behind = 0
      return { status: buildStatus(), pulled: true, pushed: true, summary: '동기화 완료' }
    })

    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { autoSave: false },
      {
        selectedFolder: 'C:/wiki/smart-cta',
        workspaces: {
          'C:/wiki/smart-cta': {
            'note.md': '# Note',
            'draft.md': '# Draft'
          }
        },
        git: {
          status: vi.fn(async () => buildStatus()),
          branches: vi.fn(async () => ({
            current: 'feature/smart',
            isDetached: false,
            branches: [
              {
                name: 'feature/smart',
                current: true,
                upstream: hasUpstream ? 'origin/feature/smart' : null
              }
            ]
          })),
          stageAll: stageAllSpy,
          commit: commitSpy,
          push: pushSpy,
          sync: syncSpy,
          log: vi.fn(async () => ({ commits, hasMore: false }))
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')

    // Dirty note.md in editor for later Commit & Sync buffer protection verification
    await user.click(await within(screen.getByLabelText('워크스페이스 탐색기')).findByText('note.md'))
    appendRawEditorText(await screen.findByTestId('document-editor'), '\nUnsaved buffer edit')

    await clickActivityBarButton(user, 'Git')
    const gitRegion = screen.getByRole('region', { name: 'Git 소스 제어' })
    const input = within(gitRegion).getByPlaceholderText(
      '메시지 (Ctrl+Enter로 "feature/smart"에 커밋)'
    ) as HTMLTextAreaElement

    // 1. Blank message inline validation runs BEFORE auto-stage ConfirmDialog
    await user.click(within(gitRegion).getByRole('button', { name: 'Commit' }))
    expect(within(gitRegion).getByText('커밋 메시지를 입력하세요.')).toBeInTheDocument()
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()

    // 2. Staged=0 + valid message -> ConfirmDialog -> cancel aborts cleanly
    await user.type(input, 'feat: initial smart commit')
    await user.click(within(gitRegion).getByRole('button', { name: 'Commit' }))
    const cancelAutoDialog = await screen.findByRole('alertdialog')
    expect(cancelAutoDialog).toHaveTextContent(
      '스테이지된 변경 사항이 없습니다. 모든 변경 사항을 자동으로 Stage하고 커밋할까요?'
    )
    await user.click(within(cancelAutoDialog).getByRole('button', { name: '취소' }))
    expect(stageAllSpy).not.toHaveBeenCalled()
    expect(commitSpy).not.toHaveBeenCalled()
    expect(input.value).toBe('feat: initial smart commit')

    // 3. Ctrl+Enter with Staged=0 -> approve auto-stage -> stageAll -> commit -> transitions to Publish Branch
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
    const approveAutoDialog = await screen.findByRole('alertdialog')
    await user.click(within(approveAutoDialog).getByRole('button', { name: 'Stage 후 커밋' }))

    await waitFor(() => {
      expect(input.value).toBe('')
    })
    expect(callOrder).toEqual(['stageAll', 'commit:feat: initial smart commit'])
    expect(await within(gitRegion).findByText('feat: initial smart commit')).toBeInTheDocument()

    // Clean unpublished state renders Publish Branch -> clicking executes Push -> synced disabled Commit
    const publishBtn = await within(gitRegion).findByRole('button', { name: 'Publish Branch' })
    await user.click(publishBtn)
    await waitFor(() => {
      expect(pushSpy).toHaveBeenCalledTimes(1)
    })
    expect(await within(gitRegion).findByRole('button', { name: 'Commit' })).toBeDisabled()
    expect(within(gitRegion).getByRole('button', { name: '커밋 작업 더 보기' })).toBeDisabled()

    // 4. Clean + ahead/behind renders Sync Changes N↓ M↑ -> clicking triggers Sync (with dirty buffer prompt)
    ahead = 2
    behind = 1
    await user.click(within(gitRegion).getByRole('button', { name: 'Git 상태 새로고침' }))
    const syncChangesBtn = await within(gitRegion).findByRole('button', {
      name: 'Sync Changes 1↓ 2↑'
    })
    await user.click(syncChangesBtn)
    const dirtySyncDialog1 = await screen.findByRole('alertdialog')
    await user.click(within(dirtySyncDialog1).getByRole('button', { name: '저장 없이 진행' }))
    await waitFor(() => {
      expect(syncSpy).toHaveBeenCalledTimes(1)
    })

    // 5. Commit & Push where commit succeeds and push fails -> input clears and only push error banner is shown
    staged = [{ path: 'note.md', status: 'M' }]
    pushShouldFail = true
    await user.click(within(gitRegion).getByRole('button', { name: 'Git 상태 새로고침' }))

    const commitInput = within(gitRegion).getByLabelText('커밋 메시지') as HTMLTextAreaElement
    await user.type(commitInput, 'feat: push fails after commit')
    await user.click(within(gitRegion).getByRole('button', { name: '커밋 작업 더 보기' }))
    await user.click(within(gitRegion).getByRole('menuitem', { name: 'Commit & Push' }))

    await waitFor(() => {
      expect(commitInput.value).toBe('')
    })
    expect(await within(gitRegion).findByRole('alert')).toHaveTextContent(
      '원격 저장소 Push 권한이 없습니다.'
    )
    expect(within(gitRegion).getByText('feat: push fails after commit')).toBeInTheDocument()

    // 6. Commit & Sync with Staged=0 + dirty buffer: cancel Sync prompt preserves commit & dirty buffer, clears input, shows Sync banner
    staged = []
    unstaged = [{ path: 'note.md', status: 'M' }]
    await user.click(within(gitRegion).getByRole('button', { name: 'Git 상태 새로고침' }))

    await user.type(commitInput, 'feat: commit then cancel sync')
    await user.click(within(gitRegion).getByRole('button', { name: '커밋 작업 더 보기' }))
    await user.click(within(gitRegion).getByRole('menuitem', { name: 'Commit & Sync' }))

    const autoStageForSync = await screen.findByRole('alertdialog')
    await user.click(within(autoStageForSync).getByRole('button', { name: 'Stage 후 커밋' }))

    const dirtySyncPrompt = await screen.findByRole('alertdialog')
    expect(dirtySyncPrompt).toHaveTextContent(/note\.md/)
    await user.click(within(dirtySyncPrompt).getByRole('button', { name: '취소' }))

    await waitFor(() => {
      expect(commitInput.value).toBe('')
    })
    expect(syncSpy).toHaveBeenCalledTimes(1)
    expect(await within(gitRegion).findByRole('alert')).toHaveTextContent(/Sync/)
    expect(getRawEditorText(screen.getByTestId('document-editor'))).toContain('Unsaved buffer edit')

    // 7. Commit & Sync approved -> sync runs after commit
    staged = [{ path: 'note.md', status: 'M' }]
    await user.click(within(gitRegion).getByRole('button', { name: 'Git 상태 새로고침' }))
    await user.type(commitInput, 'feat: commit and sync ok')
    await user.click(within(gitRegion).getByRole('button', { name: '커밋 작업 더 보기' }))
    await user.click(within(gitRegion).getByRole('menuitem', { name: 'Commit & Sync' }))

    const dirtySyncApprove = await screen.findByRole('alertdialog')
    await user.click(within(dirtySyncApprove).getByRole('button', { name: '저장 없이 진행' }))
    await waitFor(() => {
      expect(syncSpy).toHaveBeenCalledTimes(2)
    })

    // 8. Merge conflicts disable Commit split CTA & dropdown and preserve conflict guidance
    hasConflicts = true
    unstaged = [{ path: 'note.md', status: 'U' }]
    await user.click(within(gitRegion).getByRole('button', { name: 'Git 상태 새로고침' }))

    expect(await within(gitRegion).findByRole('button', { name: 'Commit' })).toBeDisabled()
    expect(within(gitRegion).getByRole('button', { name: '커밋 작업 더 보기' })).toBeDisabled()
    expect(
      within(gitRegion).getByText('병합 충돌 파일을 해결하고 Stage(+)한 후 커밋하세요.')
    ).toBeInTheDocument()
  }, 15_000)

  it('supports Changes header toolbar (tree view toggle, Commit ✓ auto-stage flow, refresh), hover open-file vs row Diff tab, and session-only compressed tree folder collapse reset on workspace switch', async () => {
    const user = userEvent.setup()
    let staged: Array<{ path: string; status: GitFileStatusCode }> = []
    let unstaged: Array<{ path: string; status: GitFileStatusCode }> = [
      { path: 'wiki/a/b/c/note.md', status: 'M' },
      { path: 'wiki/gone.md', status: 'D' },
      { path: 'outside/ext.md', status: 'M' }
    ]
    let untracked: Array<{ path: string; status: GitFileStatusCode }> = [
      { path: 'wiki/new.md', status: '?' }
    ]
    const diffSpy = vi.fn(async (_ws: string, request: GitDiffRequest) => ({
      path: request.path,
      status: request.status,
      isBinary: false,
      isTruncated: false,
      existsInWorkspace: request.status !== 'D',
      rawPatch: `diff --git a/${request.path} b/${request.path}\n@@ -1 +1 @@\n-old\n+new`
    }))
    const stageAllSpy = vi.fn(async (ws: string) => {
      staged = [...unstaged, ...untracked].map((f) => ({
        path: f.path,
        status: (f.status === '?' ? 'A' : f.status) as GitFileStatusCode
      }))
      unstaged = []
      untracked = []
      return {
        ...createEmptyGitStatus(true, 'C:/repo'),
        repoRoot: 'C:/repo',
        branch: 'main',
        staged,
        unstaged,
        untracked
      }
    })
    const commitSpy = vi.fn(async () => {
      staged = []
      return {
        ...createEmptyGitStatus(true, 'C:/repo'),
        repoRoot: 'C:/repo',
        branch: 'main',
        staged: [],
        unstaged: [],
        untracked: []
      }
    })
    const statusSpy = vi.fn(async (wsPath: string) => {
      if (wsPath.toLowerCase().includes('beta')) {
        return {
          ...createEmptyGitStatus(true, 'C:/repo'),
          repoRoot: 'C:/repo',
          branch: 'main',
          staged: [],
          unstaged: [{ path: 'wiki/a/b/c/note.md', status: 'M' as GitFileStatusCode }],
          untracked: []
        }
      }
      return {
        ...createEmptyGitStatus(true, 'C:/repo'),
        repoRoot: 'C:/repo',
        branch: 'main',
        staged,
        unstaged,
        untracked
      }
    })

    const { api } = createInMemoryWikiApi(
      {
        autoSave: false,
        recentWorkspaces: ['C:/repo/wiki', 'C:/repo/beta']
      },
      {
        workspaces: {
          'C:/repo/wiki': {
            'a/b/c/note.md': '# Compressed Note Body',
            'new.md': '# Untracked Note'
          },
          'C:/repo/beta': {
            'beta.md': '# Beta Doc'
          }
        },
        git: {
          status: statusSpy,
          stageAll: stageAllSpy,
          commit: commitSpy,
          diff: diffSpy
        }
      }
    )
    const configUpdateSpy = vi.spyOn(api.config, 'update')
    window.wikiApi = api

    render(<App />)
    await screen.findByLabelText('워크스페이스 탐색기')
    await clickActivityBarButton(user, 'Git')

    const gitRegion = screen.getByRole('region', { name: 'Git 소스 제어' })
    const changesSection = within(gitRegion).getByRole('region', { name: 'Changes' })

    // 1. Staged Changes hidden when 0; list mode displays filename + dimmed relative dir + VS Code status chars
    expect(within(changesSection).queryByRole('group', { name: 'Staged Changes' })).toBeNull()
    expect(within(changesSection).getByText('note.md')).toBeInTheDocument()
    expect(within(changesSection).getByText('wiki/a/b/c')).toBeInTheDocument()
    expect(within(changesSection).getByText('gone.md')).toHaveClass('is-deleted')
    expect(within(changesSection).getByText('U')).toBeInTheDocument()

    // 2. Open-file hover icon excluded on D and outside-workspace files; clicking open-file on workspace file opens normal editor tab (no Diff tab)
    expect(
      within(changesSection).queryByRole('button', { name: 'wiki/gone.md 파일 열기' })
    ).toBeNull()
    expect(
      within(changesSection).queryByRole('button', { name: 'outside/ext.md 파일 열기' })
    ).toBeNull()

    await user.click(within(changesSection).getByRole('button', { name: 'wiki/a/b/c/note.md 파일 열기' }))
    const primaryPane = screen.getByTestId('pane-primary')
    const docEditor = await within(primaryPane).findByTestId('document-editor')
    expect(getRawEditorText(docEditor)).toContain('# Compressed Note Body')
    expect(diffSpy).not.toHaveBeenCalled()
    expect(within(primaryPane).getByRole('tab', { name: 'note.md' })).toBeInTheDocument()

    // Clicking file row body opens Diff tab preserving internal '?' status
    await user.click(within(changesSection).getByText('new.md'))
    expect(diffSpy).toHaveBeenCalledWith('C:/repo/wiki', {
      kind: 'unstaged',
      path: 'wiki/new.md',
      status: '?'
    })
    expect(await within(primaryPane).findByText('Working Tree')).toBeInTheDocument()

    // 3. Switch to compressed tree view, collapse folder a/b/c, verify preserved across Activity Bar view switches (without config.json writes)
    await user.click(within(changesSection).getByRole('button', { name: '트리 보기로 전환' }))
    const folderBtn = within(changesSection).getByRole('button', { name: 'a/b/c' })
    expect(folderBtn).toHaveAttribute('aria-expanded', 'true')
    await user.click(folderBtn)
    expect(folderBtn).toHaveAttribute('aria-expanded', 'false')
    expect(within(changesSection).queryByText('note.md')).not.toBeInTheDocument()

    await clickActivityBarButton(user, '탐색기')
    await clickActivityBarButton(user, 'Git')
    const reopenedChanges = within(screen.getByRole('region', { name: 'Git 소스 제어' })).getByRole(
      'region',
      { name: 'Changes' }
    )
    expect(within(reopenedChanges).getByRole('button', { name: '리스트 보기로 전환' })).toBeInTheDocument()
    expect(within(reopenedChanges).getByRole('button', { name: 'a/b/c' })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    expect(configUpdateSpy).not.toHaveBeenCalled()

    // 4. Switching workspace resets collapsed tree folder set (keeping session tree mode)
    await switchWorkspaceFromView(user, /^beta$/i)
    await clickActivityBarButton(user, 'Git')
    const betaChanges = within(screen.getByRole('region', { name: 'Git 소스 제어' })).getByRole(
      'region',
      { name: 'Changes' }
    )
    expect(within(betaChanges).getByRole('button', { name: 'wiki/a/b/c' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(within(betaChanges).getByText('note.md')).toBeInTheDocument()

    // 5. Switch back to wiki, test Changes header refresh ↻ and Commit ✓ (with Staged=0 auto-stage ConfirmDialog)
    await switchWorkspaceFromView(user, /^wiki$/i)
    await clickActivityBarButton(user, 'Git')
    const wikiChanges = within(screen.getByRole('region', { name: 'Git 소스 제어' })).getByRole(
      'region',
      { name: 'Changes' }
    )
    const callsBeforeRefresh = statusSpy.mock.calls.length
    await user.click(within(wikiChanges).getByRole('button', { name: '변경 사항 새로고침' }))
    await waitFor(() => {
      expect(statusSpy.mock.calls.length).toBeGreaterThan(callsBeforeRefresh)
    })

    const commitInput = within(wikiChanges).getByLabelText('커밋 메시지') as HTMLTextAreaElement
    await user.type(commitInput, 'feat: commit via changes header check')
    await user.click(within(wikiChanges).getByRole('button', { name: '변경 사항 커밋' }))
    const autoStageDialog = await screen.findByRole('alertdialog')
    await user.click(within(autoStageDialog).getByRole('button', { name: 'Stage 후 커밋' }))

    await waitFor(() => {
      expect(stageAllSpy).toHaveBeenCalledTimes(1)
      expect(commitSpy).toHaveBeenCalledWith('C:/repo/wiki', 'feat: commit via changes header check')
      expect(commitInput.value).toBe('')
    })
  }, 15_000)

  it('supports Graph header toolbar (Fetch, Pull, Push, refresh, disabled while running), merged vs standalone remote badges, and detached HEAD badge end-to-end', async () => {
    const user = userEvent.setup()
    let behind = 0
    let ahead = 1
    let isDetached = false
    let commits: GitGraphCommit[] = [
      {
        hash: '1111111111111111111111111111111111111111',
        shortHash: '1111111',
        parents: [],
        subject: 'Local main commit',
        authorName: 'Alice',
        committedAt: '2026-11-19T09:00:00+09:00',
        refs: [
          { name: 'HEAD', kind: 'head', isCurrentHead: true },
          { name: 'main', kind: 'local-branch', isCurrentHead: true },
          { name: 'origin/main', kind: 'remote-branch' }
        ]
      }
    ]

    let resolvePendingFetch!: (status: ReturnType<typeof createEmptyGitStatus>) => void
    const buildStatus = () => ({
      ...createEmptyGitStatus(true, 'C:/repo/graph-toolbar'),
      branch: isDetached ? null : 'main',
      isDetached,
      hasUpstream: !isDetached,
      ahead,
      behind
    })

    const fetchSpy = vi.fn(
      () =>
        new Promise<ReturnType<typeof createEmptyGitStatus>>((resolve) => {
          resolvePendingFetch = resolve
        })
    )
    const pullSpy = vi.fn(async () => {
      behind = 0
      commits = [
        {
          hash: '3333333333333333333333333333333333333333',
          shortHash: '3333333',
          parents: ['2222222222222222222222222222222222222222'],
          subject: 'Pulled remote commit',
          authorName: 'Bob',
          committedAt: '2026-11-19T11:00:00+09:00',
          refs: [
            { name: 'HEAD', kind: 'head', isCurrentHead: true },
            { name: 'main', kind: 'local-branch', isCurrentHead: true },
            { name: 'origin/main', kind: 'remote-branch' }
          ]
        },
        ...commits.slice(1)
      ]
      return buildStatus()
    })
    const pushSpy = vi.fn(async () => {
      ahead = 0
      return buildStatus()
    })
    const logSpy = vi.fn(async () => ({ commits, hasMore: false }))

    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { autoSave: false },
      {
        selectedFolder: 'C:/repo/graph-toolbar',
        workspaces: {
          'C:/repo/graph-toolbar': {
            'notes.md': '# Notes'
          }
        },
        git: {
          status: vi.fn(async () => buildStatus()),
          branches: vi.fn(async () => ({
            current: isDetached ? null : 'main',
            isDetached,
            branches: [{ name: 'main', current: !isDetached, upstream: 'origin/main' }]
          })),
          fetch: fetchSpy,
          pull: pullSpy,
          push: pushSpy,
          log: logSpy
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')

    // Create dirty buffer to confirm Fetch runs without dirty-buffer prompt while Pull enforces it
    await user.click(await within(screen.getByLabelText('워크스페이스 탐색기')).findByText('notes.md'))
    appendRawEditorText(await screen.findByTestId('document-editor'), '\nUnsaved draft')

    await clickActivityBarButton(user, 'Git')
    const gitRegion = screen.getByRole('region', { name: 'Git 소스 제어' })
    const graphRegion = within(gitRegion).getByRole('region', { name: 'Graph' })
    const graphAccordionBtn = within(graphRegion).getByRole('button', { name: /^Graph$/i })

    await waitFor(() => {
      expect(within(graphRegion).getByText('Local main commit')).toBeInTheDocument()
    })
    expect(within(graphRegion).queryByText('HEAD')).toBeNull()
    expect(within(graphRegion).getByText('main').closest('.git-ref-badge')).toHaveClass(
      'is-local-branch',
      'is-current-head'
    )
    expect(within(graphRegion).getByTitle('origin')).toHaveClass('is-synced-remote')

    // 1. Click Graph Fetch -> disables Graph toolbar buttons while pending, no dirty prompt
    const fetchBtn = within(graphRegion).getByRole('button', { name: 'Fetch' })
    const pullBtn = within(graphRegion).getByRole('button', { name: 'Pull' })
    const pushBtn = within(graphRegion).getByRole('button', { name: 'Push' })
    const refreshBtn = within(graphRegion).getByRole('button', { name: '그래프 새로고침' })

    await user.click(fetchBtn)
    expect(fetchSpy).toHaveBeenCalledWith('C:/repo/graph-toolbar')
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(fetchBtn).toBeDisabled()
    expect(pullBtn).toBeDisabled()
    expect(pushBtn).toBeDisabled()
    expect(refreshBtn).toBeDisabled()
    expect(graphAccordionBtn).toHaveAttribute('aria-expanded', 'true')

    behind = 1
    commits = [
      {
        hash: '2222222222222222222222222222222222222222',
        shortHash: '2222222',
        parents: ['1111111111111111111111111111111111111111'],
        subject: 'Fetched remote tip',
        authorName: 'Bob',
        committedAt: '2026-11-19T10:00:00+09:00',
        refs: [{ name: 'origin/main', kind: 'remote-branch' }]
      },
      ...commits
    ]
    await act(async () => {
      resolvePendingFetch(buildStatus())
    })

    await waitFor(() => {
      expect(within(gitRegion).getByRole('button', { name: /Sync.*↓1 ↑1/ })).toBeInTheDocument()
      expect(within(graphRegion).getByText('Fetched remote tip')).toBeInTheDocument()
    })
    expect(within(graphRegion).getByText('origin/main').closest('.git-ref-badge')).toHaveClass(
      'is-remote-branch'
    )
    expect(fetchBtn).toBeEnabled()

    // 2. Click Graph Pull -> enforces dirty buffer ConfirmDialog and updates graph
    await user.click(pullBtn)
    const pullConfirm = await screen.findByRole('alertdialog')
    await user.click(within(pullConfirm).getByRole('button', { name: '저장 없이 진행' }))
    await waitFor(() => {
      expect(pullSpy).toHaveBeenCalledWith('C:/repo/graph-toolbar')
      expect(within(graphRegion).getByText('Pulled remote commit')).toBeInTheDocument()
    })

    // 3. Click Graph Push -> clears ahead count
    await user.click(pushBtn)
    await waitFor(() => {
      expect(pushSpy).toHaveBeenCalledWith('C:/repo/graph-toolbar')
      expect(within(gitRegion).getByRole('button', { name: /Sync.*↓0 ↑0/ })).toBeInTheDocument()
    })

    // 4. Detached HEAD + Graph Refresh -> exposes HEAD badge cleanly without collapsing Graph
    isDetached = true
    commits = [
      {
        hash: '4444444444444444444444444444444444444444',
        shortHash: '4444444',
        parents: [],
        subject: 'Detached tip commit',
        authorName: 'Carol',
        committedAt: '2026-11-19T12:00:00+09:00',
        refs: [{ name: 'HEAD', kind: 'head', isCurrentHead: true }]
      }
    ]
    const logCallsBeforeRefresh = logSpy.mock.calls.length
    await user.click(refreshBtn)
    await waitFor(() => {
      expect(logSpy.mock.calls.length).toBeGreaterThan(logCallsBeforeRefresh)
      expect(within(graphRegion).getByText('Detached tip commit')).toBeInTheDocument()
    })
    expect(within(graphRegion).getByText('HEAD').closest('.git-ref-badge')).toHaveClass('is-head')
    expect(graphAccordionBtn).toHaveAttribute('aria-expanded', 'true')
  })
})

describe('Git Diff viewer tab and Changes section integration', () => {
  it('opens read-only diff tabs on Changes clicks, toggles inline/side-by-side, ignores +/- buttons, and opens editable files', async () => {
    const user = userEvent.setup()
    let revision = 1
    const diffSpy = vi.fn(async (_workspacePath: string, request: GitDiffRequest) => ({
      path: request.path,
      ...(request.origPath ? { origPath: request.origPath } : {}),
      status: request.status,
      isBinary: false,
      isTruncated: false,
      existsInWorkspace: request.path !== 'deleted.md',
      rawPatch:
        request.path === 'deleted.md'
          ? ['diff --git a/deleted.md b/deleted.md', '@@ -1 +0,0 @@', '-gone'].join('\n')
          : [
              `diff --git a/${request.path} b/${request.path}`,
              `--- a/${request.path}`,
              `+++ b/${request.path}`,
              '@@ -1 +1 @@',
              `-old ${request.path} r${revision}`,
              `+new ${request.path} r${revision}`
            ].join('\n')
    }))
    const stageSpy = vi.fn(async (workspacePath: string) => ({
      ...createEmptyGitStatus(true, workspacePath),
      branch: 'main',
      staged: [{ path: 'guide.md', status: 'M' as const }],
      unstaged: [{ path: 'deleted.md', status: 'D' as const }]
    }))

    const { api, emitMenuCommand } = createInMemoryWikiApi(
      {
        version: 1,
        theme: 'light',
        autoSave: false,
        autoSaveDelayMs: 1000,
        showHeadingNumbers: true,
        recentWorkspaces: [],
        favoriteWorkspaces: []
      },
      {
        workspaces: {
          'C:/wiki/diff-app': {
            'guide.md': '# Guide\n## Sub\nUpdated body',
            'notes.md': '# Notes'
          }
        },
        selectedFolder: 'C:/wiki/diff-app',
        git: {
          status: async (workspacePath) => ({
            ...createEmptyGitStatus(true, workspacePath),
            branch: 'main',
            staged: [{ path: 'guide.md', status: 'M' }],
            unstaged: [{ path: 'deleted.md', status: 'D' }],
            untracked: [{ path: 'notes.md', status: '?' }]
          }),
          stage: stageSpy,
          diff: diffSpy
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    await clickActivityBarButton(user, 'Git')

    const gitPanel = await screen.findByLabelText('Git 소스 제어')

    // 1. Clicking + Stage button must NOT open a diff tab
    await user.click(await within(gitPanel).findByRole('button', { name: 'notes.md Stage' }))
    expect(stageSpy).toHaveBeenCalledWith('C:/wiki/diff-app', ['notes.md'])
    expect(screen.queryByRole('tab')).toBeNull()

    // 2. Clicking staged file opens Diff tab defaulting to side-by-side
    const stagedList = within(gitPanel).getByRole('group', { name: 'Staged Changes' })
    await user.click(within(stagedList).getByText('guide.md'))

    const primaryPane = screen.getByTestId('pane-primary')
    expect(within(primaryPane).getAllByRole('tab')).toHaveLength(1)
    expect(within(primaryPane).getByRole('tab', { name: /guide\.md/ })).toBeInTheDocument()
    expect(within(primaryPane).getByText('Staged')).toBeInTheDocument()
    expect(within(primaryPane).getByTestId('diff-side-by-side')).toBeInTheDocument()
    expect(within(primaryPane).getByText(matchDiffLineText('old guide.md r1'))).toBeInTheDocument()

    // Switch to inline view
    await user.click(within(primaryPane).getByRole('button', { name: '인라인' }))
    expect(within(primaryPane).getByTestId('diff-inline')).toBeInTheDocument()

    // 3. Clicking another file in Changes reuses the existing Diff tab in primary pane
    const changesList = within(gitPanel).getByRole('group', { name: 'Changes' })
    await user.click(within(changesList).getByText('deleted.md'))

    await waitFor(() => {
      expect(within(primaryPane).getByText('Working Tree')).toBeInTheDocument()
    })
    expect(within(primaryPane).getAllByRole('tab')).toHaveLength(1)
    expect(within(primaryPane).getByRole('tab', { name: /deleted\.md/ })).toBeInTheDocument()
    expect(within(primaryPane).getByRole('button', { name: '파일 열기' })).toBeDisabled()

    // 4. Switch back to guide.md and click 파일 열기 to open editable workspace tab
    revision = 2
    await user.click(within(stagedList).getByText('guide.md'))
    const openFileBtn = await within(primaryPane).findByRole('button', { name: '파일 열기' })
    await waitFor(() => expect(openFileBtn).toBeEnabled())
    await user.click(openFileBtn)

    await waitFor(() => {
      expect(within(primaryPane).getAllByRole('tab')).toHaveLength(2)
    })
    const docEditor = await within(primaryPane).findByTestId('document-editor')
    expect(getRawEditorText(docEditor)).toContain('Updated body')
  })

  it('preserves split diff tabs, excludes diffs from autoSave/dirty/shortcuts/outline, refreshes on Git changes, and clears on workspace switch', async () => {
    const user = userEvent.setup()
    let patchCounter = 1
    let currentStaged: Array<{ path: string; status: 'M' | 'A' }> = [{ path: 'doc.md', status: 'M' }]
    let currentUnstaged: Array<{ path: string; status: 'M' | 'D' }> = [{ path: 'other.md', status: 'M' }]
    const writeFileSpy = vi.fn(async () => {})
    const diffSpy = vi.fn(async (_workspacePath: string, request: GitDiffRequest) => ({
      path: request.path,
      status: request.status,
      isBinary: false,
      isTruncated: false,
      existsInWorkspace: true,
      rawPatch:
        currentStaged.length === 0 && request.kind === 'staged'
          ? ''
          : [
              `diff --git a/${request.path} b/${request.path}`,
              `--- a/${request.path}`,
              `+++ b/${request.path}`,
              '@@ -1 +1 @@',
              `-before v${patchCounter}`,
              `+after v${patchCounter}`
            ].join('\n')
    }))

    const folders = {
      selected: 'C:/wiki/diff-one'
    }
    const { api, emitMenuCommand, emitWorkspaceChange } = createInMemoryWikiApi(
      {
        version: 1,
        theme: 'light',
        autoSave: true,
        autoSaveDelayMs: 60,
        showHeadingNumbers: true,
        recentWorkspaces: [],
        favoriteWorkspaces: []
      },
      {
        workspaces: {
          'C:/wiki/diff-one': {
            'doc.md': '# Heading\nbody',
            'other.md': '# Other'
          },
          'C:/wiki/diff-two': {
            'two.md': '# Two'
          }
        },
        git: {
          status: async (workspacePath) => ({
            ...createEmptyGitStatus(true, workspacePath),
            branch: 'main',
            staged: currentStaged,
            unstaged: currentUnstaged
          }),
          stage: async (workspacePath) => {
            patchCounter += 1
            return {
              ...createEmptyGitStatus(true, workspacePath),
              branch: 'main',
              staged: currentStaged,
              unstaged: currentUnstaged
            }
          },
          commit: async (workspacePath) => {
            currentStaged = []
            patchCounter += 1
            return {
              ...createEmptyGitStatus(true, workspacePath),
              branch: 'main',
              staged: [],
              unstaged: currentUnstaged
            }
          },
          diff: diffSpy
        }
      }
    )
    api.workspace.selectFolder = async () => folders.selected
    api.workspace.writeFile = writeFileSpy
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')

    // Open a regular document tab and config.json first so secondary pane move is enabled
    await user.click(await within(screen.getByLabelText('워크스페이스 탐색기')).findByText('doc.md'))
    await screen.findByTestId('document-editor')

    await clickActivityBarButton(user, 'Git')
    const gitPanel = await screen.findByLabelText('Git 소스 제어')

    // Open Staged diff for doc.md in primary pane -> move it to secondary pane
    const stagedList = within(gitPanel).getByRole('group', { name: 'Staged Changes' })
    await user.click(within(stagedList).getByText('doc.md'))

    const primaryPane = screen.getByTestId('pane-primary')
    await within(primaryPane).findByText(matchDiffLineText('after v1'))

    // Document Outline must exclude active Diff tab even when target is .md
    const outlinePanel = screen.getByLabelText('문서 목차 (Outline)')
    expect(within(outlinePanel).getByText('마크다운 문서에서만 목차를 지원합니다.')).toBeInTheDocument()

    // Ctrl+S and Ctrl+Shift+M must NOT save or change editor mode on Diff tab
    fireEvent.keyDown(window, { key: 's', ctrlKey: true })
    fireEvent.keyDown(window, { key: 'M', ctrlKey: true, shiftKey: true })
    expect(writeFileSpy).not.toHaveBeenCalled()

    // Move Diff tab to secondary pane via tab context menu
    const diffTabInPrimary = within(primaryPane).getByRole('tab', { name: /Diff\s*doc\.md/ })
    fireEvent.contextMenu(diffTabInPrimary)
    await user.click(await screen.findByRole('menuitem', { name: '분할 영역으로 이동' }))

    const secondaryPane = screen.getByTestId('pane-secondary')
    expect(within(secondaryPane).getByRole('tab', { name: /Diff\s*doc\.md/ })).toBeInTheDocument()

    // Focus primary pane and open another Diff tab -> secondary Diff tab stays preserved
    fireEvent.mouseDown(primaryPane)
    const changesList = within(gitPanel).getByRole('group', { name: 'Changes' })
    await user.click(within(changesList).getByText('other.md'))
    await within(primaryPane).findByText(matchDiffLineText('after v1'))
    expect(within(secondaryPane).getByRole('tab', { name: /Diff\s*doc\.md/ })).toBeInTheDocument()

    // Wait longer than autoSaveDelayMs (60ms) -> Diff tab never triggers writeFile
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(writeFileSpy).not.toHaveBeenCalled()

    // Saving a regular document tab refreshes Git status -> open Diff tab auto-refreshes (after v2)
    await user.click(within(primaryPane).getByRole('tab', { name: 'doc.md' }))
    const docEditor = await within(primaryPane).findByTestId('document-editor')
    patchCounter = 2
    appendRawEditorText(docEditor, ' updated')
    fireEvent.keyDown(window, { key: 's', ctrlKey: true })
    await waitFor(() => {
      expect(writeFileSpy).toHaveBeenCalled()
    })
    await user.click(within(primaryPane).getByRole('tab', { name: /Diff\s*other\.md/ }))
    await waitFor(() => {
      expect(within(primaryPane).getByText(matchDiffLineText('after v2'))).toBeInTheDocument()
    })

    // Stage action refreshes Git status -> open Diff tab auto-refreshes (after v3)
    await user.click(within(gitPanel).getByRole('button', { name: 'other.md Stage' }))
    await waitFor(() => {
      expect(within(primaryPane).getByText(matchDiffLineText('after v3'))).toBeInTheDocument()
    })

    // Commit -> triggers Git refresh -> open Diff tabs auto-refresh (staged doc.md empties, unstaged other.md gets v4)
    await user.type(within(gitPanel).getByLabelText('커밋 메시지'), 'commit staged')
    await user.click(within(gitPanel).getByRole('button', { name: 'Commit' }))

    await waitFor(() => {
      expect(within(primaryPane).getByText(matchDiffLineText('after v4'))).toBeInTheDocument()
      expect(within(secondaryPane).getByText('표시할 텍스트 변경 사항이 없습니다.')).toBeInTheDocument()
    })

    // External FS change event triggers Git refresh -> open unstaged Diff tab refreshes automatically
    patchCounter = 5
    act(() => {
      emitWorkspaceChange({ rootPath: 'C:/wiki/diff-one', eventType: 'change', relativePath: 'other.md' })
    })
    await waitFor(() => {
      expect(within(primaryPane).getByText(matchDiffLineText('after v5'))).toBeInTheDocument()
    })

    // Closing Diff tab never shows unsaved alertdialog
    await user.click(within(primaryPane).getByRole('button', { name: 'other.md 탭 닫기' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()

    // Switching workspace closes remaining Diff tab automatically
    folders.selected = 'C:/wiki/diff-two'
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    await waitFor(() => {
      expect(screen.queryByRole('tab', { name: /Diff\s*doc\.md/ })).not.toBeInTheDocument()
    })
  })
})

describe('Git Graph commit file diff integration', () => {
  it('opens read-only commit Diff tabs from Graph commit files, reuses active pane tabs while preserving split pane, toggles diff view mode, and gates 파일 열기 by workspace existence', async () => {
    const user = userEvent.setup()
    const commitHash = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'
    const shortHash = 'a1b2c3d'
    const buildDiffResponse = (
      request: GitDiffRequest,
      rawPatch: string,
      existsInWorkspace = true
    ) => ({
      path: request.path,
      ...(request.origPath ? { origPath: request.origPath } : {}),
      status: request.status,
      isBinary: false,
      isTruncated: false,
      existsInWorkspace,
      rawPatch
    })

    const diffSpy = vi.fn(async (_workspacePath: string, request: GitDiffRequest) => {
      if (request.kind === 'commit' && request.path === 'docs/removed-old.md') {
        return buildDiffResponse(
          request,
          [
            'diff --git a/docs/removed-old.md b/docs/removed-old.md',
            '--- a/docs/removed-old.md',
            '+++ /dev/null',
            '@@ -1 +0,0 @@',
            '-removed historical line'
          ].join('\n'),
          false
        )
      }
      if (request.kind === 'commit' && request.path === 'docs/renamed.md') {
        return buildDiffResponse(
          request,
          [
            'diff --git a/docs/legacy.md b/docs/renamed.md',
            'similarity index 90%',
            'rename from docs/legacy.md',
            'rename to docs/renamed.md',
            '@@ -1 +1 @@',
            '-legacy title',
            '+renamed title'
          ].join('\n')
        )
      }
      const prefix = request.kind === 'commit' ? 'commit' : 'working'
      return buildDiffResponse(
        request,
        [
          `diff --git a/${request.path} b/${request.path}`,
          `--- a/${request.path}`,
          `+++ b/${request.path}`,
          '@@ -1 +1 @@',
          `-${prefix} before`,
          `+${prefix} after`
        ].join('\n')
      )
    })

    const { api, emitMenuCommand } = createInMemoryWikiApi(
      {
        version: 1,
        theme: 'light',
        autoSave: false,
        autoSaveDelayMs: 1000,
        showHeadingNumbers: true,
        recentWorkspaces: [],
        favoriteWorkspaces: []
      },
      {
        workspaces: {
          'C:/wiki/graph-diff-app': {
            'docs/guide.md': '# Guide Current\nLatest workspace text',
            'docs/renamed.md': '# Renamed Current',
            'notes.md': '# Notes'
          }
        },
        selectedFolder: 'C:/wiki/graph-diff-app',
        git: {
          status: async (workspacePath) => ({
            ...createEmptyGitStatus(true, workspacePath),
            branch: 'main',
            unstaged: [{ path: 'notes.md', status: 'M' }]
          }),
          log: async () => ({
            commits: [
              {
                hash: commitHash,
                shortHash,
                parents: [],
                subject: 'feat: commit with changed files',
                authorName: 'Alice',
                committedAt: '2026-11-15T10:00:00+09:00',
                refs: [{ name: 'main', kind: 'local-branch' }]
              }
            ],
            hasMore: false
          }),
          commitDetail: async () => ({
            hash: commitHash,
            shortHash,
            parents: [],
            subject: 'feat: commit with changed files',
            body: 'Commit body context',
            authorName: 'Alice',
            authorEmail: 'alice@example.com',
            committedAt: '2026-11-15T10:00:00+09:00',
            files: [
              { status: 'M', path: 'docs/guide.md' },
              { status: 'D', path: 'docs/removed-old.md' },
              { status: 'R', origPath: 'docs/legacy.md', path: 'docs/renamed.md' }
            ]
          }),
          diff: diffSpy
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')

    // Open a regular document tab first so moving a Diff tab to secondary pane is enabled
    await user.click(await within(screen.getByLabelText('워크스페이스 탐색기')).findByText('notes.md'))
    await screen.findByTestId('document-editor')

    await clickActivityBarButton(user, 'Git')

    const gitPanel = await screen.findByLabelText('Git 소스 제어')
    const graphRegion = within(gitPanel).getByRole('region', { name: 'Graph' })

    // 1. Expand commit in Graph section and click an existing changed file
    await user.click(within(graphRegion).getByRole('button', { name: /feat: commit with changed files/ }))
    const detailRegion = await within(graphRegion).findByRole('region', {
      name: `${shortHash} 커밋 상세`
    })

    await user.click(within(detailRegion).getByTitle('docs/guide.md'))
    expect(diffSpy).toHaveBeenCalledWith('C:/wiki/graph-diff-app', {
      kind: 'commit',
      commitHash,
      shortHash,
      path: 'docs/guide.md',
      status: 'M'
    })

    const primaryPane = screen.getByTestId('pane-primary')
    const guideCommitTab = await within(primaryPane).findByRole('tab', {
      name: /Diff\s*guide\.md \(a1b2c3d\)/
    })
    expect(guideCommitTab).toHaveAttribute('title', 'docs/guide.md · Commit a1b2c3d')
    expect(within(primaryPane).getByText(`Commit ${shortHash}`)).toBeInTheDocument()
    expect(within(primaryPane).getByTestId('diff-side-by-side')).toBeInTheDocument()
    expect(within(primaryPane).getByText(matchDiffLineText('commit after'))).toBeInTheDocument()

    // Toggle Side-by-Side -> Inline on commit Diff tab
    await user.click(within(primaryPane).getByRole('button', { name: '인라인' }))
    expect(within(primaryPane).getByTestId('diff-inline')).toBeInTheDocument()

    const openFileBtn = within(primaryPane).getByRole('button', { name: '파일 열기' })
    expect(openFileBtn).toBeEnabled()

    // 2. Click historically deleted file in the same commit -> replaces active Diff tab and disables 파일 열기
    await user.click(within(detailRegion).getByTitle('docs/removed-old.md'))
    await waitFor(() => {
      expect(within(primaryPane).getByText('removed historical line')).toBeInTheDocument()
    })
    expect(within(primaryPane).getAllByRole('tab')).toHaveLength(2)
    expect(
      within(primaryPane).getByRole('tab', { name: /Diff\s*removed-old\.md \(a1b2c3d\)/ })
    ).toBeInTheDocument()
    expect(within(primaryPane).getByRole('button', { name: '파일 열기' })).toBeDisabled()

    // 3. Click renamed commit file -> passes origPath and replaces active Diff tab
    await user.click(within(detailRegion).getByTitle('docs/legacy.md → docs/renamed.md'))
    expect(diffSpy).toHaveBeenLastCalledWith('C:/wiki/graph-diff-app', {
      kind: 'commit',
      commitHash,
      shortHash,
      path: 'docs/renamed.md',
      origPath: 'docs/legacy.md',
      status: 'R'
    })
    await waitFor(() => {
      expect(within(primaryPane).getByText(matchDiffLineText('renamed title'))).toBeInTheDocument()
    })

    // 4. Open Working Tree Diff tab from Changes -> replaces commit Diff tab in active pane
    const changesList = within(gitPanel).getByRole('group', { name: 'Changes' })
    await user.click(within(changesList).getByText('notes.md'))
    await waitFor(() => {
      expect(within(primaryPane).getByText(matchDiffLineText('working after'))).toBeInTheDocument()
    })
    expect(within(primaryPane).getAllByRole('tab')).toHaveLength(2)

    // Move Working Tree Diff tab to secondary pane, focus primary pane, and open commit Diff tab in primary
    const workingTab = within(primaryPane).getByRole('tab', { name: /Diff\s*notes\.md/ })
    fireEvent.contextMenu(workingTab)
    await user.click(await screen.findByRole('menuitem', { name: '분할 영역으로 이동' }))

    const secondaryPane = screen.getByTestId('pane-secondary')
    expect(within(secondaryPane).getByRole('tab', { name: /Diff\s*notes\.md/ })).toBeInTheDocument()

    fireEvent.mouseDown(primaryPane)
    await user.click(within(detailRegion).getByTitle('docs/guide.md'))
    await within(primaryPane).findByText(matchDiffLineText('commit after'))
    expect(
      within(primaryPane).getByRole('tab', { name: /Diff\s*guide\.md \(a1b2c3d\)/ })
    ).toBeInTheDocument()
    expect(within(secondaryPane).getByRole('tab', { name: /Diff\s*notes\.md/ })).toBeInTheDocument()

    // 5. Click 파일 열기 from commit Diff tab -> opens editable workspace document, close Diff tab cleanly
    await user.click(within(primaryPane).getByRole('button', { name: '파일 열기' }))
    const docEditor = await within(primaryPane).findByTestId('document-editor')
    expect(getRawEditorText(docEditor)).toContain('Latest workspace text')

    await user.click(within(primaryPane).getByRole('button', { name: 'guide.md (a1b2c3d) 탭 닫기' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })
})
