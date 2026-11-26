import { render, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  createEmptyGitStatus,
  type GitCompareRefList,
  type GitCompareSummary,
  type GitFileDiff
} from '@shared/git'
import { App } from './App'
import { clickActivityBarButton } from './test/appTestHelpers'
import { detachTabViaContextMenu, registerMultiWindowLifecycle } from './test/multiWindowTestHelpers'

vi.mock('mermaid', async () => (await import('./test/appTestHelpers')).createMermaidMockState().module)

const SAMPLE_PATCH = [
  'diff --git a/src/login.ts b/src/login.ts',
  'index 1111111..2222222 100644',
  '--- a/src/login.ts',
  '+++ b/src/login.ts',
  '@@ -1,2 +1,2 @@',
  '-export const status = "old"',
  '+export const status = "new"'
].join('\n')

function createCompareGitOverrides(workspaceRoot: string) {
  const refList: GitCompareRefList = {
    defaultBaseRef: 'main',
    currentRef: 'feat/auth',
    worktrees: [],
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
        id: 'local:feat/auth',
        kind: 'local-branch',
        ref: 'feat/auth',
        displayName: 'feat/auth',
        branchName: 'feat/auth',
        shortHash: '2222222',
        isCurrent: true
      }
    ],
    remoteBranches: []
  }

  const summary: GitCompareSummary = {
    baseRef: 'main',
    compareRef: 'feat/auth',
    mode: 'three-dot',
    mergeBaseHash: '1111111',
    totalAdditions: 1,
    totalDeletions: 1,
    files: [
      {
        path: 'src/login.ts',
        status: 'M',
        additions: 1,
        deletions: 1,
        isBinary: false
      }
    ],
    commits: []
  }

  const diffResult: GitFileDiff = {
    path: 'src/login.ts',
    status: 'M',
    isBinary: false,
    isTruncated: false,
    existsInWorkspace: true,
    rawPatch: SAMPLE_PATCH
  }

  return {
    status: vi.fn(async (ws: string) => ({
      ...createEmptyGitStatus(true, ws),
      repoRoot: workspaceRoot,
      branch: 'feat/auth',
      headHash: '2222222'
    })),
    compareRefs: vi.fn(async () => refList),
    compareSummary: vi.fn(async () => summary),
    diff: vi.fn(async () => diffResult)
  }
}

async function expectDiffHighlights(pane: HTMLElement): Promise<void> {
  await waitFor(() => {
    const wordHighlights = Array.from(pane.querySelectorAll('.git-diff-word-highlight')).map(
      (el) => el.textContent
    )
    expect(wordHighlights).toEqual(['old', 'new'])
    expect(pane.querySelector('[class*="tok-"]')).not.toBeNull()
  })
}

describe('Compare Diff tab split/duplicate and auxiliary window compatibility (<App />)', () => {
  const { createHarness } = registerMultiWindowLifecycle()

  it('duplicates branch-compare Diff tab to secondary pane and detaches to auxiliary window with word highlight, syntax highlight, mode toggle, and open file', async () => {
    const user = userEvent.setup()
    const workspaceRoot = 'C:\\wiki\\repo'
    const gitOverrides = createCompareGitOverrides(workspaceRoot)
    const harness = createHarness(
      { autoSave: false, theme: 'light' },
      {
        selectedFolder: workspaceRoot,
        workspaces: {
          [workspaceRoot]: {
            'src/login.ts': 'export const status = "new"\n'
          }
        },
        git: gitOverrides
      }
    )

    const mainWin = harness.createWindow({ role: 'main' })
    const mainRendered = render(<App wikiApi={mainWin.api} />)

    await user.click(within(mainRendered.container).getByRole('button', { name: '폴더 열기...' }))
    await within(mainRendered.container).findByText('repo')

    // Open Compare view and click src/login.ts to open branch-compare Diff tab
    await clickActivityBarButton(user, 'Compare')
    const comparePanel = await within(mainRendered.container).findByRole('region', {
      name: '브랜치 비교'
    })
    await user.click(await within(comparePanel).findByRole('button', { name: /login\.ts/ }))

    const primaryPane = within(mainRendered.container).getByTestId('pane-primary')
    const diffTabTrigger = await within(primaryPane).findByRole('tab', { name: /login\.ts/ })

    // 1. Duplicate branch-compare Diff tab to secondary pane
    await user.pointer({ target: diffTabTrigger, keys: '[MouseRight]' })
    const tabMenu = await within(mainRendered.container).findByRole('menu', {
      name: '탭 작업 메뉴'
    })
    await user.click(within(tabMenu).getByRole('menuitem', { name: '분할 영역에 복제 열기' }))

    const secondaryPane = await within(mainRendered.container).findByTestId('pane-secondary')
    expect(within(secondaryPane).getByRole('tab', { name: /login\.ts/ })).toBeInTheDocument()
    await expectDiffHighlights(secondaryPane)

    await user.click(within(secondaryPane).getByRole('button', { name: '인라인' }))
    expect(within(secondaryPane).getByRole('button', { name: '인라인' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )

    // 2. Detach branch-compare Diff tab from secondary pane to an auxiliary window
    await detachTabViaContextMenu(user, secondaryPane, /login\.ts/)
    await waitFor(() => {
      expect(harness.getAuxiliaryWindows(mainWin.windowId)).toHaveLength(1)
    })

    const auxWin = harness.getAuxiliaryWindows(mainWin.windowId)[0]
    const auxRendered = render(<App wikiApi={auxWin.api} />)

    const auxPrimaryPane = await within(auxRendered.container).findByTestId('pane-primary')
    await expectDiffHighlights(auxPrimaryPane)
    expect(gitOverrides.diff).toHaveBeenLastCalledWith(
      'C:/wiki/repo',
      expect.objectContaining({
        kind: 'branch-compare',
        mode: 'three-dot',
        mergeBaseHash: '1111111'
      })
    )

    // Duplicate in auxiliary window and close primary -> keeps cached diff without extra git.diff IPC calls
    const auxDiffCallsAfterOpen = gitOverrides.diff.mock.calls.length
    const auxTabTrigger = within(auxPrimaryPane).getByRole('tab', { name: /login\.ts/ })
    await user.pointer({ target: auxTabTrigger, keys: '[MouseRight]' })
    const auxMenu = await within(auxRendered.container).findByRole('menu', {
      name: '탭 작업 메뉴'
    })
    await user.click(within(auxMenu).getByRole('menuitem', { name: '분할 영역에 복제 열기' }))
    const auxSecondaryPane = await within(auxRendered.container).findByTestId('pane-secondary')
    await expectDiffHighlights(auxSecondaryPane)
    expect(gitOverrides.diff).toHaveBeenCalledTimes(auxDiffCallsAfterOpen)

    // Toggle 좌우 비교 <-> 인라인 in auxiliary window
    await user.click(within(auxPrimaryPane).getByRole('button', { name: '인라인' }))
    expect(within(auxPrimaryPane).getByRole('button', { name: '인라인' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await user.click(within(auxPrimaryPane).getByRole('button', { name: '좌우 비교' }))
    expect(within(auxPrimaryPane).getByRole('button', { name: '좌우 비교' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )

    // Click 파일 열기 in auxiliary window -> opens editable document tab in auxiliary window
    await user.click(within(auxPrimaryPane).getByRole('button', { name: '파일 열기' }))
    const auxEditor = await within(auxRendered.container).findByTestId('document-editor')
    expect(auxEditor).toBeInTheDocument()
  })
})
