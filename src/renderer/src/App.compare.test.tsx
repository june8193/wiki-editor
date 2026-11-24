import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createEmptyGitStatus,
  type GitCompareRefList,
  type GitCompareSummary
} from '@shared/git'
import { App } from './App'
import { clickActivityBarButton, switchWorkspaceFromView } from './test/appTestHelpers'
import { createInMemoryWikiApi } from './test/inMemoryWikiHarness'

vi.mock('mermaid', async () => (await import('./test/appTestHelpers')).createMermaidMockState().module)

function matchDiffLineText(expected: string) {
  return (_: string, el: Element | null) =>
    Boolean(el?.classList.contains('git-diff-line-text') && el.textContent === expected)
}

describe('Compare view shell, ref picker, and single-file diff navigation', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
    vi.useRealTimers()
  })

  it('shows Compare view in Activity Bar, toggles sidebar collapse, and renders empty states for no-workspace and non-git workspace', async () => {
    const user = userEvent.setup()
    const { api } = createInMemoryWikiApi(
      { recentWorkspaces: [] },
      {
        workspaces: {
          'C:/non-git': {
            'README.md': '# Non Git\n'
          }
        },
        selectedFolder: 'C:/non-git',
        git: {
          status: vi.fn(async (ws) => createEmptyGitStatus(false, ws))
        }
      }
    )
    window.wikiApi = api

    render(<App />)

    await clickActivityBarButton(user, 'Compare')
    expect(screen.getByRole('region', { name: '브랜치 비교' })).toBeInTheDocument()
    expect(screen.getByText(/열린 워크스페이스가 없습니다/)).toBeInTheDocument()

    // Clicking active Compare button again collapses left sidebar
    await clickActivityBarButton(user, 'Compare')
    expect(screen.queryByRole('complementary', { name: '왼쪽 사이드바' })).not.toBeInTheDocument()

    // Clicking again re-expands Compare panel
    await clickActivityBarButton(user, 'Compare')
    expect(screen.getByRole('region', { name: '브랜치 비교' })).toBeInTheDocument()

    // Open a non-Git workspace via Workspace view
    await clickActivityBarButton(user, '워크스페이스')
    await user.click(screen.getByRole('button', { name: '폴더 열기...' }))
    await waitFor(() => {
      expect(screen.getByText('non-git')).toBeInTheDocument()
    })

    await clickActivityBarButton(user, 'Compare')
    await waitFor(() => {
      expect(screen.getByText(/현재 워크스페이스는 Git 저장소가 아닙니다/)).toBeInTheDocument()
    })
  })

  it('auto-selects Base/Compare refs, filters grouped Ref picker popovers, swaps refs, and refreshes', async () => {
    const user = userEvent.setup()
    const refList: GitCompareRefList = {
      defaultBaseRef: 'main',
      currentRef: 'feat/compare',
      worktrees: [
        {
          id: 'wt:hotfix',
          kind: 'worktree',
          ref: 'abc1234',
          displayName: 'wt-hotfix (detached @ abc1234)',
          worktreeName: 'wt-hotfix',
          branchName: null,
          shortHash: 'abc1234',
          isDetached: true
        }
      ],
      localBranches: [
        {
          id: 'local:main',
          kind: 'local-branch',
          ref: 'main',
          displayName: 'main',
          branchName: 'main',
          shortHash: '1111111'
        },
        {
          id: 'local:feat/compare',
          kind: 'local-branch',
          ref: 'feat/compare',
          displayName: 'feat/compare',
          branchName: 'feat/compare',
          shortHash: '2222222',
          isCurrent: true
        }
      ],
      remoteBranches: [
        {
          id: 'remote:origin/main',
          kind: 'remote-branch',
          ref: 'origin/main',
          displayName: 'origin/main',
          branchName: 'origin/main',
          shortHash: '3333333'
        }
      ]
    }

    const compareRefsMock = vi.fn(async () => refList)
    const compareSummaryMock = vi.fn(
      async (_ws: string, req: { baseRef: string; compareRef: string; mode: 'three-dot' | 'two-dot' }): Promise<GitCompareSummary> => ({
        baseRef: req.baseRef,
        compareRef: req.compareRef,
        mode: req.mode,
        mergeBaseHash: '0000000',
        totalAdditions: 5,
        totalDeletions: 2,
        files: [],
        commits: []
      })
    )

    const { api } = createInMemoryWikiApi(
      {
        recentWorkspaces: ['C:/repo']
      },
      {
        workspaces: {
          'C:/repo': {
            'README.md': '# Repo\n'
          }
        },
        git: {
          status: vi.fn(async (ws) => ({
            ...createEmptyGitStatus(true, ws),
            branch: 'feat/compare'
          })),
          compareRefs: compareRefsMock,
          compareSummary: compareSummaryMock
        }
      }
    )
    window.wikiApi = api

    render(<App />)

    await waitFor(() => {
      expect(screen.getByText('repo')).toBeInTheDocument()
    })
    await clickActivityBarButton(user, 'Compare')

    await waitFor(() => {
      expect(compareSummaryMock).toHaveBeenCalledWith('C:/repo', {
        baseRef: 'main',
        compareRef: 'feat/compare',
        mode: 'three-dot'
      })
    })

    const baseTrigger = screen.getByRole('button', { name: /Base 기준 Ref 선택/ })
    const compareTrigger = screen.getByRole('button', { name: /Compare 대상 Ref 선택/ })
    expect(baseTrigger).toHaveTextContent('main')
    expect(compareTrigger).toHaveTextContent('feat/compare')

    // Open Base picker, verify groups, search, and select origin/main
    await user.click(baseTrigger)
    const popover = screen.getByRole('dialog', { name: 'Base Ref 선택' })
    expect(within(popover).getByText('Worktrees')).toBeInTheDocument()
    expect(within(popover).getByText('Local Branches')).toBeInTheDocument()
    expect(within(popover).getByText('Remote Branches')).toBeInTheDocument()

    const searchInput = within(popover).getByPlaceholderText('브랜치 또는 워크트리 검색...')
    await user.type(searchInput, 'origin')
    expect(within(popover).queryByText('wt-hotfix (detached @ abc1234)')).not.toBeInTheDocument()
    await user.click(within(popover).getByRole('button', { name: /origin\/main/ }))

    await waitFor(() => {
      expect(compareSummaryMock).toHaveBeenCalledWith('C:/repo', {
        baseRef: 'origin/main',
        compareRef: 'feat/compare',
        mode: 'three-dot'
      })
    })

    // Open Compare picker and select worktree
    await user.click(compareTrigger)
    const comparePopover = screen.getByRole('dialog', { name: 'Compare Ref 선택' })
    await user.click(within(comparePopover).getByRole('button', { name: /wt-hotfix/ }))

    await waitFor(() => {
      expect(compareSummaryMock).toHaveBeenCalledWith('C:/repo', {
        baseRef: 'origin/main',
        compareRef: 'abc1234',
        mode: 'three-dot'
      })
    })

    // Swap Base and Compare
    await user.click(screen.getByRole('button', { name: 'Base와 Compare 맞바꾸기' }))
    await waitFor(() => {
      expect(compareSummaryMock).toHaveBeenCalledWith('C:/repo', {
        baseRef: 'abc1234',
        compareRef: 'origin/main',
        mode: 'three-dot'
      })
    })

    // Refresh
    const refsCountBefore = compareRefsMock.mock.calls.length
    const summaryCountBefore = compareSummaryMock.mock.calls.length
    await user.click(screen.getByRole('button', { name: '비교 새로고침' }))
    await waitFor(() => {
      expect(compareRefsMock.mock.calls.length).toBeGreaterThan(refsCountBefore)
      expect(compareSummaryMock.mock.calls.length).toBeGreaterThan(summaryCountBefore)
    })
  })

  it('switches between 3-dot and 2-dot modes and updates the compare summary bar', async () => {
    const user = userEvent.setup()
    const compareSummaryMock = vi.fn(
      async (_ws: string, req: { baseRef: string; compareRef: string; mode: 'three-dot' | 'two-dot' }): Promise<GitCompareSummary> =>
        req.mode === 'three-dot'
          ? {
              baseRef: req.baseRef,
              compareRef: req.compareRef,
              mode: 'three-dot',
              mergeBaseHash: '0000000',
              totalAdditions: 10,
              totalDeletions: 3,
              files: [
                { path: 'docs/guide.md', status: 'M', additions: 10, deletions: 3, isBinary: false },
                { path: 'docs/extra.md', status: 'A', additions: 0, deletions: 0, isBinary: false }
              ],
              commits: []
            }
          : {
              baseRef: req.baseRef,
              compareRef: req.compareRef,
              mode: 'two-dot',
              mergeBaseHash: null,
              totalAdditions: 4,
              totalDeletions: 1,
              files: [{ path: 'docs/guide.md', status: 'M', additions: 4, deletions: 1, isBinary: false }],
              commits: []
            }
    )

    const { api } = createInMemoryWikiApi(
      { recentWorkspaces: ['C:/repo'] },
      {
        workspaces: { 'C:/repo': { 'docs/guide.md': '# Guide\n' } },
        git: {
          status: vi.fn(async (ws) => ({
            ...createEmptyGitStatus(true, ws),
            branch: 'feat/compare'
          })),
          compareRefs: vi.fn(async (): Promise<GitCompareRefList> => ({
            defaultBaseRef: 'main',
            currentRef: 'feat/compare',
            worktrees: [],
            localBranches: [
              { id: 'local:main', kind: 'local-branch', ref: 'main', displayName: 'main' },
              {
                id: 'local:feat/compare',
                kind: 'local-branch',
                ref: 'feat/compare',
                displayName: 'feat/compare',
                isCurrent: true
              }
            ],
            remoteBranches: []
          })),
          compareSummary: compareSummaryMock
        }
      }
    )
    window.wikiApi = api

    render(<App />)

    await waitFor(() => {
      expect(screen.getByText('repo')).toBeInTheDocument()
    })
    await clickActivityBarButton(user, 'Compare')

    await waitFor(() => {
      expect(screen.getByText('2 files changed')).toBeInTheDocument()
    })
    const summaryBar = screen.getByRole('status', { name: '비교 요약' })
    expect(summaryBar).toHaveTextContent('+10')
    expect(summaryBar).toHaveTextContent('-3')

    const twoDotBtn = screen.getByRole('button', { name: '2-dot (직접 비교)' })
    const threeDotBtn = screen.getByRole('button', { name: '3-dot (PR 방식)' })
    expect(threeDotBtn).toHaveAttribute('aria-pressed', 'true')
    expect(twoDotBtn).toHaveAttribute('aria-pressed', 'false')

    await user.click(twoDotBtn)
    await waitFor(() => {
      expect(screen.getByText('1 file changed')).toBeInTheDocument()
    })
    expect(twoDotBtn).toHaveAttribute('aria-pressed', 'true')
    expect(summaryBar).toHaveTextContent('+4')
    expect(summaryBar).toHaveTextContent('-1')
  })

  it('renders compressed Files tree with stats, filters files, preserves session state across view switches, and updates open branch-compare Diff tabs on mode change', async () => {
    const user = userEvent.setup()
    const diffMock = vi.fn(async (_ws: string, req: { kind: string; path: string; mode?: string; status: string }) => ({
      path: req.path,
      status: req.status as 'M' | 'A' | 'D',
      isBinary: false,
      isTruncated: false,
      existsInWorkspace: req.status !== 'D',
      rawPatch:
        req.mode === 'two-dot'
          ? '@@ -1,1 +1,1 @@\n-old two-dot\n+new two-dot\n'
          : '@@ -1,1 +1,1 @@\n-old three-dot\n+new three-dot\n'
    }))

    const { api } = createInMemoryWikiApi(
      { recentWorkspaces: ['C:/repo'] },
      {
        workspaces: {
          'C:/repo': {
            'src/features/auth/login.ts': 'export const login = true\n',
            'src/features/auth/session.ts': 'export const session = true\n'
          }
        },
        git: {
          status: vi.fn(async (ws) => ({
            ...createEmptyGitStatus(true, ws),
            branch: 'feat/compare'
          })),
          compareRefs: vi.fn(async (): Promise<GitCompareRefList> => ({
            defaultBaseRef: 'main',
            currentRef: 'feat/compare',
            worktrees: [],
            localBranches: [
              { id: 'local:main', kind: 'local-branch', ref: 'main', displayName: 'main' },
              {
                id: 'local:feat/compare',
                kind: 'local-branch',
                ref: 'feat/compare',
                displayName: 'feat/compare',
                isCurrent: true
              }
            ],
            remoteBranches: []
          })),
          compareSummary: vi.fn(
            async (_ws: string, req: { baseRef: string; compareRef: string; mode: 'three-dot' | 'two-dot' }): Promise<GitCompareSummary> => ({
              baseRef: req.baseRef,
              compareRef: req.compareRef,
              mode: req.mode,
              mergeBaseHash: req.mode === 'three-dot' ? '0000000' : null,
              totalAdditions: 20,
              totalDeletions: 9,
              files:
                req.mode === 'three-dot'
                  ? [
                      {
                        path: 'src/features/auth/login.ts',
                        status: 'M',
                        additions: 12,
                        deletions: 4,
                        isBinary: false
                      },
                      {
                        path: 'src/features/auth/session.ts',
                        status: 'A',
                        additions: 8,
                        deletions: 0,
                        isBinary: false
                      },
                      {
                        path: 'assets/logo.png',
                        status: 'M',
                        additions: null,
                        deletions: null,
                        isBinary: true
                      },
                      {
                        path: 'old/removed.md',
                        status: 'D',
                        additions: 0,
                        deletions: 5,
                        isBinary: false
                      }
                    ]
                  : [
                      {
                        path: 'src/features/auth/login.ts',
                        status: 'M',
                        additions: 12,
                        deletions: 4,
                        isBinary: false
                      }
                    ],
              commits: []
            })
          ),
          diff: diffMock
        }
      }
    )
    window.wikiApi = api

    render(<App />)

    await waitFor(() => {
      expect(screen.getByText('repo')).toBeInTheDocument()
    })
    await clickActivityBarButton(user, 'Compare')

    const comparePanel = screen.getByRole('region', { name: '브랜치 비교' })
    await waitFor(() => {
      expect(within(comparePanel).getByText('src/features/auth')).toBeInTheDocument()
    })
    expect(within(comparePanel).getByText('login.ts')).toBeInTheDocument()
    expect(within(comparePanel).getByText('session.ts')).toBeInTheDocument()
    expect(within(comparePanel).getByText('Binary')).toBeInTheDocument()

    // Filter files
    const filterInput = within(comparePanel).getByRole('textbox', { name: '변경 파일 필터' })
    await user.type(filterInput, 'auth')
    expect(within(comparePanel).getByText('login.ts')).toBeInTheDocument()
    expect(within(comparePanel).queryByText('logo.png')).not.toBeInTheDocument()
    expect(within(comparePanel).queryByText('removed.md')).not.toBeInTheDocument()

    // Preserve session state across Activity Bar view switch
    await clickActivityBarButton(user, '탐색기')
    await clickActivityBarButton(user, 'Compare')
    const comparePanelReopened = screen.getByRole('region', { name: '브랜치 비교' })
    expect(within(comparePanelReopened).getByRole('textbox', { name: '변경 파일 필터' })).toHaveValue('auth')

    // Click login.ts to open branch-compare Diff tab
    await user.click(within(comparePanelReopened).getByRole('button', { name: /login\.ts/ }))

    const primaryPane = screen.getByTestId('pane-primary')
    await waitFor(() => {
      expect(within(primaryPane).getByText('main...feat/compare')).toBeInTheDocument()
      expect(within(primaryPane).getByText(matchDiffLineText('new three-dot'))).toBeInTheDocument()
    })

    // Switch to 2-dot and verify open Diff tab updates immediately
    await user.click(within(comparePanelReopened).getByRole('button', { name: '2-dot (직접 비교)' }))
    await waitFor(() => {
      expect(within(primaryPane).getByText('main..feat/compare')).toBeInTheDocument()
      expect(within(primaryPane).getByText(matchDiffLineText('new two-dot'))).toBeInTheDocument()
    })
  })

  it('navigates between filtered compare files via ↑/↓ in Diff viewer, opens editable files, and resets Compare session state on workspace switch', async () => {
    const user = userEvent.setup()

    const { api } = createInMemoryWikiApi(
      {
        recentWorkspaces: ['C:/repo-a', 'C:/repo-b']
      },
      {
        workspaces: {
          'C:/repo-a': {
            'docs/a.md': '# A\n',
            'z.md': '# Z\n'
          },
          'C:/repo-b': {
            'other.md': '# Other\n'
          }
        },
        git: {
          status: vi.fn(async (ws) => ({
            ...createEmptyGitStatus(true, ws),
            branch: ws === 'C:/repo-a' ? 'feat/a' : 'feat/b'
          })),
          compareRefs: vi.fn(async (ws): Promise<GitCompareRefList> =>
            ws === 'C:/repo-a'
              ? {
                  defaultBaseRef: 'main',
                  currentRef: 'feat/a',
                  worktrees: [],
                  localBranches: [
                    { id: 'local:main', kind: 'local-branch', ref: 'main', displayName: 'main' },
                    {
                      id: 'local:feat/a',
                      kind: 'local-branch',
                      ref: 'feat/a',
                      displayName: 'feat/a',
                      isCurrent: true
                    }
                  ],
                  remoteBranches: []
                }
              : {
                  defaultBaseRef: 'develop',
                  currentRef: 'feat/b',
                  worktrees: [],
                  localBranches: [
                    {
                      id: 'local:develop',
                      kind: 'local-branch',
                      ref: 'develop',
                      displayName: 'develop'
                    },
                    {
                      id: 'local:feat/b',
                      kind: 'local-branch',
                      ref: 'feat/b',
                      displayName: 'feat/b',
                      isCurrent: true
                    }
                  ],
                  remoteBranches: []
                }
          ),
          compareSummary: vi.fn(
            async (ws, req): Promise<GitCompareSummary> =>
              ws === 'C:/repo-a'
                ? {
                    baseRef: req.baseRef,
                    compareRef: req.compareRef,
                    mode: req.mode,
                    mergeBaseHash: '0000000',
                    totalAdditions: 3,
                    totalDeletions: 1,
                    files: [
                      { path: 'z.md', status: 'A', additions: 1, deletions: 0, isBinary: false },
                      { path: 'docs/a.md', status: 'M', additions: 2, deletions: 0, isBinary: false },
                      { path: 'docs/b.md', status: 'D', additions: 0, deletions: 1, isBinary: false }
                    ],
                    commits: []
                  }
                : {
                    baseRef: req.baseRef,
                    compareRef: req.compareRef,
                    mode: req.mode,
                    mergeBaseHash: '1111111',
                    totalAdditions: 1,
                    totalDeletions: 0,
                    files: [
                      { path: 'other.md', status: 'M', additions: 1, deletions: 0, isBinary: false }
                    ],
                    commits: []
                  }
          ),
          diff: vi.fn(async (_ws, req) => ({
            path: req.path,
            status: req.status,
            isBinary: false,
            isTruncated: false,
            existsInWorkspace: req.status !== 'D',
            rawPatch: `@@ -1,1 +1,1 @@\n-old ${req.path}\n+new ${req.path}\n`
          }))
        }
      }
    )
    window.wikiApi = api

    render(<App />)

    await waitFor(() => {
      expect(screen.getByText('repo-a')).toBeInTheDocument()
    })
    await clickActivityBarButton(user, 'Compare')

    const comparePanel = screen.getByRole('region', { name: '브랜치 비교' })
    await waitFor(() => {
      expect(within(comparePanel).getByText('a.md')).toBeInTheDocument()
    })

    // Click docs/a.md (first in tree order: docs/a.md, docs/b.md, z.md)
    await user.click(within(comparePanel).getByRole('button', { name: /a\.md/ }))

    const primaryPane = screen.getByTestId('pane-primary')
    await waitFor(() => {
      expect(within(primaryPane).getByText('1 / 3')).toBeInTheDocument()
    })

    const prevBtn = within(primaryPane).getByRole('button', { name: '이전 파일' })
    const nextBtn = within(primaryPane).getByRole('button', { name: '다음 파일' })
    expect(prevBtn).toBeDisabled()
    expect(nextBtn).toBeEnabled()
    expect(within(primaryPane).getByRole('button', { name: '파일 열기' })).toBeEnabled()

    // Navigate to docs/b.md (deleted)
    await user.click(nextBtn)
    await waitFor(() => {
      expect(within(primaryPane).getByText('2 / 3')).toBeInTheDocument()
      expect(
        within(primaryPane).getByRole('region', { name: 'docs/b.md Diff 뷰어' })
      ).toBeInTheDocument()
    })
    expect(within(primaryPane).getByRole('button', { name: '파일 열기' })).toBeDisabled()

    // Navigate to z.md (last)
    await user.click(within(primaryPane).getByRole('button', { name: '다음 파일' }))
    await waitFor(() => {
      expect(within(primaryPane).getByText('3 / 3')).toBeInTheDocument()
      expect(
        within(primaryPane).getByRole('region', { name: 'z.md Diff 뷰어' })
      ).toBeInTheDocument()
    })
    expect(within(primaryPane).getByRole('button', { name: '다음 파일' })).toBeDisabled()

    // Navigate back to docs/a.md and click 파일 열기
    await user.click(within(primaryPane).getByRole('button', { name: '이전 파일' }))
    await user.click(within(primaryPane).getByRole('button', { name: '이전 파일' }))
    await waitFor(() => {
      expect(within(primaryPane).getByText('1 / 3')).toBeInTheDocument()
    })
    await user.click(within(primaryPane).getByRole('button', { name: '파일 열기' }))
    await waitFor(() => {
      expect(within(primaryPane).getByRole('tab', { name: 'a.md' })).toBeInTheDocument()
    })

    // Type filter & switch mode, then switch workspace to repo-b and verify session reset
    await user.type(within(comparePanel).getByRole('textbox', { name: '변경 파일 필터' }), 'a.md')
    await user.click(within(comparePanel).getByRole('button', { name: '2-dot (직접 비교)' }))

    await switchWorkspaceFromView(user, /^repo-b$/)
    await clickActivityBarButton(user, 'Compare')

    const comparePanelB = screen.getByRole('region', { name: '브랜치 비교' })
    await waitFor(() => {
      expect(within(comparePanelB).getByText('other.md')).toBeInTheDocument()
    })
    expect(within(comparePanelB).getByRole('textbox', { name: '변경 파일 필터' })).toHaveValue('')
    expect(within(comparePanelB).getByRole('button', { name: '3-dot (PR 방식)' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(
      within(comparePanelB).getByRole('button', { name: /Base 기준 Ref 선택/ })
    ).toHaveTextContent('develop')
  })
})
