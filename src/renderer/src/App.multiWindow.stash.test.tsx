import { fireEvent, render, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { GitDiffRequest, GitStashCreateOptions, GitStashEntry, GitStatus } from '@shared/git'
import { App } from './App'
import {
  getRawEditorText,
  type InMemoryWindowHandle,
  type MultiWindowWikiHarness,
  setRawEditorText
} from './test/inMemoryWikiHarness'
import {
  detachTabViaContextMenu,
  openFolderAndNoteInWindow,
  registerMultiWindowLifecycle
} from './test/multiWindowTestHelpers'

vi.mock('mermaid', async () => (await import('./test/appTestHelpers')).createMermaidMockState().module)

describe('Multi-window Git Stash integration (<App />)', () => {
  const { createHarness, trackDisposer } = registerMultiWindowLifecycle()

  /**
   * Opens shared buffers across Main + 2 Auxiliary windows, seeds non-target dirty edits,
   * and opens Staged (`secondaryPane`) + Working Tree (`primaryPane`) Diff tabs for stash tests.
   */
  async function setupMultiWindowGitStashScenario(
    user: ReturnType<typeof userEvent.setup>,
    harness: MultiWindowWikiHarness,
    mainWin: InMemoryWindowHandle
  ) {
    const mainRendered = render(<App wikiApi={mainWin.api} />)
    trackDisposer(() => mainRendered.unmount())

    // Open notes.md -> detach to Aux1; open draft.md -> detach to Aux2; keep staged.md & other.md dirty in Main
    await openFolderAndNoteInWindow(
      user,
      mainRendered.container,
      mainWin.emitMenuCommand,
      'notes.md'
    )
    await detachTabViaContextMenu(user, mainRendered.container, /notes\.md/)
    const explorer = within(mainRendered.container).getByLabelText('워크스페이스 탐색기')
    await user.click(await within(explorer).findByText('notes.md'))
    await user.click(await within(explorer).findByText('draft.md'))
    await detachTabViaContextMenu(user, mainRendered.container, /draft\.md/)
    await user.click(await within(explorer).findByText('draft.md'))

    for (const [fileName, dirtyText] of [
      ['staged.md', '# Dirty Staged NonTarget'],
      ['other.md', '# Dirty Other NonTarget']
    ] as const) {
      await user.click(await within(explorer).findByText(fileName))
      await waitFor(() => {
        expect(
          within(mainRendered.container).getByRole('tab', { name: new RegExp(fileName) })
        ).toHaveAttribute('aria-selected', 'true')
      })
      setRawEditorText(within(mainRendered.container).getByTestId('document-editor'), dirtyText)
    }

    await waitFor(() => {
      expect(harness.getAuxiliaryWindows()).toHaveLength(2)
    })
    const [auxNotes, auxDraft] = harness.getAuxiliaryWindows()
    const auxNotesRendered = render(<App wikiApi={auxNotes.api} />)
    const auxDraftRendered = render(<App wikiApi={auxDraft.api} />)
    trackDisposer(
      () => auxNotesRendered.unmount(),
      () => auxDraftRendered.unmount()
    )

    setRawEditorText(
      await within(auxNotesRendered.container).findByTestId('document-editor'),
      '# Aux Dirty Notes'
    )
    setRawEditorText(
      await within(auxDraftRendered.container).findByTestId('document-editor'),
      '# Aux Dirty Draft'
    )

    // Switch to Git View -> open staged Diff in secondary & unstaged notes Diff in primary
    await user.click(within(mainRendered.container).getByRole('button', { name: 'Git' }))
    const gitPanel = await within(mainRendered.container).findByLabelText('Git 소스 제어')
    const stashesSection = within(gitPanel).getByRole('region', { name: 'Stashes' })
    const stagedSection = within(gitPanel).getByRole('group', { name: 'Staged Changes' })
    const changesSection = within(gitPanel).getByRole('group', { name: 'Changes' })

    await user.click(within(stagedSection).getByText('staged.md'))
    const primaryPane = within(mainRendered.container).getByTestId('pane-primary')
    await within(primaryPane).findByText('Staged')
    fireEvent.contextMenu(within(primaryPane).getByRole('tab', { selected: true }))
    await user.click(
      within(
        await within(mainRendered.container).findByRole('menu', { name: '탭 작업 메뉴' })
      ).getByRole('menuitem', { name: '분할 영역으로 이동' })
    )
    const secondaryPane = await within(mainRendered.container).findByTestId('pane-secondary')
    fireEvent.mouseDown(primaryPane)
    await user.click(within(changesSection).getByText('notes.md'))
    await within(primaryPane).findByText('Working Tree')

    return {
      mainRendered,
      auxDraft,
      auxNotesRendered,
      gitPanel,
      stashesSection,
      stagedSection,
      changesSection,
      primaryPane,
      secondaryPane
    }
  }

  it('runs one-click Changes stash (keeping Staged Changes, auto-expanding Stashes, syncing Main/Aux buffers & tabs) and Apply/Pop restore (including conflict preservation and workspace-switch collapse reset)', async () => {
    const user = userEvent.setup()
    const repoRoot = 'C:/repo'
    const workspaceRoot = 'C:/repo/wiki'
    const otherWorkspaceRoot = 'C:/repo-other'
    let mainWorkspaceApi: InMemoryWindowHandle['api']['workspace'] | null = null

    let gitState: GitStatus = {
      isRepo: true,
      repoRoot,
      branch: 'main',
      isDetached: false,
      isUnborn: false,
      ahead: 0,
      behind: 0,
      hasUpstream: true,
      hasConflicts: false,
      staged: [{ path: 'wiki/staged.md', status: 'A' }],
      unstaged: [{ path: 'wiki/notes.md', status: 'M' }],
      untracked: [{ path: 'wiki/draft.md', status: '?' }]
    }

    let stashes: GitStashEntry[] = []
    let popCalls = 0
    let stashCreateDelayMs = 0
    let stashApplyDiffText = 'diff --git a/wiki/notes.md b/wiki/notes.md\n@@ -1 +1 @@\n-# Head Notes\n+# Stashed Notes'
    const stashEntry0: GitStashEntry = {
      ref: 'stash@{0}',
      hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      branch: 'main',
      message: 'WIP on main: seed',
      createdAt: '2026-11-20T10:15:00+09:00'
    }

    const stashCreateSpy = vi.fn(async (_wsPath: string, options: GitStashCreateOptions) => {
      expect(options).toEqual({ scope: 'unstaged', includeUntracked: true })
      if (stashCreateDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, stashCreateDelayMs))
      }
      await mainWorkspaceApi?.writeFile(`${workspaceRoot}/notes.md`, '# Head Notes')
      await mainWorkspaceApi?.deleteEntry(`${workspaceRoot}/draft.md`).catch(() => undefined)
      stashes = [stashEntry0]
      gitState = {
        ...gitState,
        unstaged: [],
        untracked: []
      }
      return gitState
    })

    const writeOrCreateDraft = async (content: string): Promise<void> => {
      if (!mainWorkspaceApi) return
      try {
        await mainWorkspaceApi.writeFile(`${workspaceRoot}/draft.md`, content)
      } catch {
        await mainWorkspaceApi.createEntry(workspaceRoot, 'draft.md', 'file', content)
      }
    }

    const stashApplySpy = vi.fn(async () => {
      await mainWorkspaceApi?.writeFile(`${workspaceRoot}/notes.md`, '# Stashed Notes')
      await writeOrCreateDraft('# Stashed Draft')
      gitState = {
        ...gitState,
        unstaged: [{ path: 'wiki/notes.md', status: 'M' }],
        untracked: [{ path: 'wiki/draft.md', status: '?' }]
      }
      return gitState
    })

    const stashPopSpy = vi.fn(async () => {
      popCalls += 1
      if (popCalls === 1) {
        await mainWorkspaceApi?.writeFile(
          `${workspaceRoot}/notes.md`,
          '<<<<<<< HEAD\n# Head Notes\n=======\n# Stashed Notes\n>>>>>>> Stashed changes'
        )
        stashApplyDiffText =
          'diff --git a/wiki/notes.md b/wiki/notes.md\n@@ -1 +1,5 @@\n+<<<<<<< HEAD\n+# Head Notes'
        gitState = {
          ...gitState,
          hasConflicts: true,
          unstaged: [{ path: 'wiki/notes.md', status: 'U' }]
        }
        throw new Error('병합 충돌(Conflict)이 발생했습니다. 충돌 파일을 해결한 뒤 다시 시도하세요.')
      }
      await mainWorkspaceApi?.writeFile(`${workspaceRoot}/notes.md`, '# Popped Notes')
      await writeOrCreateDraft('# Popped Draft')
      stashApplyDiffText = 'diff --git a/wiki/notes.md b/wiki/notes.md\n@@ -1 +1 @@\n-# Head Notes\n+# Popped Notes'
      stashes = []
      gitState = {
        ...gitState,
        hasConflicts: false,
        unstaged: [{ path: 'wiki/notes.md', status: 'M' }],
        untracked: [{ path: 'wiki/draft.md', status: '?' }]
      }
      return gitState
    })

    const harness = createHarness(
      { autoSave: false, theme: 'light' },
      {
        selectedFolder: 'C:\\repo\\wiki',
        workspaces: {
          'C:\\repo\\wiki': {
            'staged.md': '# Staged Content',
            'notes.md': '# Worktree Notes',
            'draft.md': '# Untracked Draft',
            'other.md': '# Other Content'
          },
          'C:\\repo-other': {
            'alpha.md': '# Alpha'
          }
        },
        git: {
          status: async (wsPath) =>
            wsPath.includes('repo-other')
              ? {
                  isRepo: true,
                  repoRoot: otherWorkspaceRoot,
                  branch: 'main',
                  isDetached: false,
                  isUnborn: false,
                  ahead: 0,
                  behind: 0,
                  hasUpstream: false,
                  hasConflicts: false,
                  staged: [],
                  unstaged: [],
                  untracked: []
                }
              : gitState,
          stashList: async (wsPath) => (wsPath.includes('repo-other') ? [] : stashes),
          stashCreate: stashCreateSpy,
          stashApply: stashApplySpy,
          stashPop: stashPopSpy,
          commit: async () => {
            gitState = { ...gitState, staged: [] }
            return gitState
          },
          diff: async (_wsPath, request: GitDiffRequest) => ({
            path: request.path,
            status: request.status,
            isBinary: false,
            isTruncated: false,
            existsInWorkspace: true,
            rawPatch:
              request.kind === 'unstaged' && request.path === 'wiki/notes.md'
                ? stashApplyDiffText
                : `diff --git a/${request.path} b/${request.path}\n@@ -1 +1 @@\n-old\n+new`
          })
        }
      }
    )

    const mainWin = harness.createWindow({ role: 'main' })
    mainWorkspaceApi = mainWin.api.workspace
    const {
      mainRendered,
      auxDraft,
      auxNotesRendered,
      gitPanel,
      stashesSection,
      changesSection,
      primaryPane,
      secondaryPane
    } = await setupMultiWindowGitStashScenario(user, harness, mainWin)

    expect(within(stashesSection).getByRole('button', { name: /^Stashes/i })).toHaveAttribute(
      'aria-expanded',
      'false'
    )

    // 1. Click Changes만 Stash -> prompt shows ONLY target notes.md / draft.md (excludes staged.md & other.md)
    await user.click(within(changesSection).getByRole('button', { name: 'Changes만 Stash' }))
    const cancelPrompt = await within(mainRendered.container).findByRole('alertdialog')
    expect(cancelPrompt).toHaveTextContent(/notes\.md/)
    expect(cancelPrompt).not.toHaveTextContent(/staged\.md/)
    expect(cancelPrompt).not.toHaveTextContent(/other\.md/)
    await user.click(within(cancelPrompt).getByRole('button', { name: '취소' }))
    expect(stashCreateSpy).not.toHaveBeenCalled()

    // 2. Confirm 저장 없이 진행 -> keeps staged.md, syncs Aux1/Main notes.md, closes Aux2 draft.md, closes unstaged diff, keeps staged diff, preserves non-target dirty buffers, auto-expands Stashes
    await user.click(within(changesSection).getByRole('button', { name: 'Changes만 Stash' }))
    const proceedPrompt = await within(mainRendered.container).findByRole('alertdialog')
    await user.click(within(proceedPrompt).getByRole('button', { name: '저장 없이 진행' }))

    await waitFor(() => {
      expect(stashCreateSpy).toHaveBeenCalledTimes(1)
      expect(auxDraft.isClosed()).toBe(true)
      expect(within(mainRendered.container).queryByRole('tab', { name: /draft\.md/ })).toBeNull()
      expect(within(auxNotesRendered.container).queryByTestId('tab-dirty-indicator')).toBeNull()
    })
    expect(harness.getFilesSnapshot().get('C:/repo/wiki/notes.md')).toBe('# Head Notes')
    expect(harness.getFilesSnapshot().get('C:/repo/wiki/other.md')).toBe('# Other Content')
    expect(getRawEditorText(within(auxNotesRendered.container).getByTestId('document-editor'))).toBe(
      '# Head Notes'
    )
    expect(within(auxNotesRendered.container).queryByText(/외부에서 변경/)).not.toBeInTheDocument()

    // Primary unstaged diff for notes.md closed; Secondary staged diff for staged.md preserved
    expect(within(primaryPane).queryByText('Working Tree')).toBeNull()
    expect(within(secondaryPane).getByText('Staged')).toBeInTheDocument()
    expect(within(stashesSection).getByRole('button', { name: /^Stashes/i })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(within(stashesSection).getByText('WIP on main: seed')).toBeInTheDocument()
    expect(within(mainRendered.container).getByRole('button', { name: 'Git' })).toHaveTextContent(
      '1'
    )

    // 3. Commit staged.md cleanly, then Apply stash@{0} (checks full workspace because other.md & staged.md are dirty)
    await user.type(within(gitPanel).getByLabelText('커밋 메시지'), 'commit staged')
    await user.click(within(gitPanel).getByRole('button', { name: 'Commit' }))
    await waitFor(() => {
      expect(within(mainRendered.container).getByRole('button', { name: 'Git' })).toHaveTextContent(
        ''
      )
    })

    await user.click(within(stashesSection).getByRole('button', { name: 'stash@{0} Apply' }))
    const applyConfirm = await within(mainRendered.container).findByRole('alertdialog')
    expect(applyConfirm).toHaveTextContent(/staged\.md 외 1개/)
    await user.click(within(applyConfirm).getByRole('button', { name: '저장 후 진행' }))

    await waitFor(() => {
      expect(stashApplySpy).toHaveBeenCalledWith(workspaceRoot, 'stash@{0}')
      expect(within(mainRendered.container).getByRole('button', { name: 'Git' })).toHaveTextContent(
        '2'
      )
    })
    expect(harness.getFilesSnapshot().get('C:/repo/wiki/staged.md')).toBe(
      '# Dirty Staged NonTarget'
    )
    expect(harness.getFilesSnapshot().get('C:/repo/wiki/other.md')).toBe('# Dirty Other NonTarget')
    expect(within(stashesSection).getByText('WIP on main: seed')).toBeInTheDocument()
    expect(getRawEditorText(within(auxNotesRendered.container).getByTestId('document-editor'))).toBe(
      '# Stashed Notes'
    )

    // Open unstaged diff tab for notes.md before Pop conflict check
    fireEvent.mouseDown(primaryPane)
    await user.click(within(changesSection).getByText('notes.md'))
    await waitFor(() => {
      expect(primaryPane).toHaveTextContent('# Stashed Notes')
    })

    // 4. First Pop hits conflict -> preserves stash@{0}, shows error alert, syncs Aux1 buffer & open unstaged diff tab
    await user.click(within(stashesSection).getByRole('button', { name: 'stash@{0} Pop' }))
    await waitFor(() => {
      expect(stashPopSpy).toHaveBeenCalledTimes(1)
      expect(within(gitPanel).getByRole('alert')).toHaveTextContent(/충돌/)
    })
    expect(within(stashesSection).getByText('WIP on main: seed')).toBeInTheDocument()
    expect(getRawEditorText(within(auxNotesRendered.container).getByTestId('document-editor'))).toContain(
      '<<<<<<< HEAD'
    )
    await waitFor(() => {
      expect(primaryPane).toHaveTextContent('<<<<<<< HEAD')
    })

    // 5. Second Pop succeeds -> removes stash@{0}, updates Aux1/Main/Diff/Tree
    await user.click(within(stashesSection).getByRole('button', { name: 'stash@{0} Pop' }))
    await waitFor(() => {
      expect(stashPopSpy).toHaveBeenCalledTimes(2)
      expect(within(stashesSection).getByRole('button', { name: /^Stashes/i })).toHaveTextContent(
        '0'
      )
    })
    expect(getRawEditorText(within(auxNotesRendered.container).getByTestId('document-editor'))).toBe(
      '# Popped Notes'
    )
    await waitFor(() => {
      expect(primaryPane).toHaveTextContent('# Popped Notes')
    })
    await user.click(within(mainRendered.container).getByRole('button', { name: '탐색기' }))
    expect(
      await within(within(mainRendered.container).getByLabelText('워크스페이스 탐색기')).findByText(
        'draft.md'
      )
    ).toBeInTheDocument()
    await user.click(within(mainRendered.container).getByRole('button', { name: 'Git' }))

    // 5b. Slow stashCreate (650ms > 500ms autoSave) with 저장 없이 진행 must suppress late auto-save overwrite across Aux1
    await mainWin.api.config.update({ autoSave: true, autoSaveDelayMs: 500 })
    stashCreateDelayMs = 650
    setRawEditorText(
      within(auxNotesRendered.container).getByTestId('document-editor'),
      '# Aux Dirty Before AutoSave Suppression'
    )
    const refreshedChangesSection = within(
      await within(mainRendered.container).findByLabelText('Git 소스 제어')
    ).getByRole('group', { name: 'Changes' })
    await user.click(
      within(refreshedChangesSection).getByRole('button', { name: 'Changes만 Stash' })
    )
    const autoSavePrompt = await within(mainRendered.container).findByRole('alertdialog')
    await user.click(within(autoSavePrompt).getByRole('button', { name: '저장 없이 진행' }))
    await waitFor(() => {
      expect(stashCreateSpy).toHaveBeenCalledTimes(2)
      expect(within(auxNotesRendered.container).queryByTestId('tab-dirty-indicator')).toBeNull()
    })
    await new Promise((resolve) => setTimeout(resolve, 550))
    expect(harness.getFilesSnapshot().get('C:/repo/wiki/notes.md')).toBe('# Head Notes')
    expect(getRawEditorText(within(auxNotesRendered.container).getByTestId('document-editor'))).toBe(
      '# Head Notes'
    )
    expect(within(auxNotesRendered.container).queryByText(/외부에서 변경/)).not.toBeInTheDocument()
    await mainWin.api.config.update({ autoSave: false })
    stashCreateDelayMs = 0

    // 5c. Failed stashApply after '저장 없이 진행' must reconcile safely and preserve unsaved dirty edits across open tabs
    await user.click(within(primaryPane).getByRole('tab', { name: /other\.md/ }))
    setRawEditorText(
      within(primaryPane).getByTestId('document-editor'),
      '# Keep Dirty On Failed Apply'
    )
    stashApplySpy.mockRejectedValueOnce(
      new Error('로컬 변경 사항을 먼저 커밋하거나 Stash로 임시 보관한 뒤 다시 시도하세요.')
    )
    const refreshedGitPanel = within(mainRendered.container).getByLabelText('Git 소스 제어')
    const refreshedStashesSection = within(refreshedGitPanel).getByRole('region', {
      name: 'Stashes'
    })
    await user.click(
      within(refreshedStashesSection).getByRole('button', { name: 'stash@{0} Apply' })
    )
    const failedApplyPrompt = await within(mainRendered.container).findByRole('alertdialog')
    await user.click(within(failedApplyPrompt).getByRole('button', { name: '저장 없이 진행' }))
    await waitFor(() => {
      expect(within(refreshedGitPanel).getByRole('alert')).toHaveTextContent(/Stash로 임시 보관/)
    })
    expect(getRawEditorText(within(primaryPane).getByTestId('document-editor'))).toBe(
      '# Keep Dirty On Failed Apply'
    )
    fireEvent.keyDown(within(primaryPane).getByTestId('document-editor'), { key: 's', ctrlKey: true })
    await waitFor(() => {
      expect(
        within(within(primaryPane).getByRole('tab', { name: /other\.md/ })).queryByTestId(
          'tab-dirty-indicator'
        )
      ).toBeNull()
    })

    // 6. Switching workspace resets Stashes section collapsed state back to default (aria-expanded="false")
    mainWin.api.workspace.selectFolder = async () => 'C:\\repo-other'
    await user.click(within(mainRendered.container).getByRole('button', { name: '워크스페이스' }))
    const wsView = await within(mainRendered.container).findByRole('region', {
      name: '워크스페이스 뷰'
    })
    await user.click(within(wsView).getByRole('button', { name: '폴더 열기...' }))
    await within(mainRendered.container).findByLabelText('워크스페이스 탐색기')
    await user.click(within(mainRendered.container).getByRole('button', { name: 'Git' }))
    const switchedGitPanel = await within(mainRendered.container).findByLabelText('Git 소스 제어')
    expect(
      within(within(switchedGitPanel).getByRole('region', { name: 'Stashes' })).getByRole(
        'button',
        { name: /^Stashes/i }
      )
    ).toHaveAttribute('aria-expanded', 'false')
  }, 30_000)

  it('supports single-file stash, Stash input dialog (Enter/Esc/scope/untracked), and danger-confirmed Drop and Clear All across windows', async () => {
    const user = userEvent.setup()
    const workspaceRoot = 'C:/repo/wiki'
    const repoRoot = 'C:/repo'

    let stashes: GitStashEntry[] = []
    let gitState: GitStatus = {
      isRepo: true,
      repoRoot,
      branch: 'main',
      isDetached: false,
      isUnborn: false,
      ahead: 0,
      behind: 0,
      hasUpstream: false,
      hasConflicts: false,
      staged: [{ path: 'wiki/staged.md', status: 'M' }],
      unstaged: [
        { path: 'wiki/notes.md', status: 'M' },
        { path: 'wiki/other.md', status: 'M' }
      ],
      untracked: [{ path: 'wiki/draft.md', status: '?' }]
    }

    let mainWorkspaceApi: InMemoryWindowHandle['api']['workspace'] | undefined

    const removeOrIgnoreMissing = async (filePath: string): Promise<void> => {
      if (!mainWorkspaceApi) return
      try {
        await mainWorkspaceApi.deleteEntry(filePath)
      } catch {
        // already removed
      }
    }

    const stashCreateSpy = vi.fn(
      async (_wsPath: string, options: GitStashCreateOptions) => {
        const message =
          options.message && options.message.trim()
            ? options.message.trim()
            : `WIP on main: seed (${options.scope})`
        const nextEntry: GitStashEntry = {
          ref: 'stash@{0}',
          hash: `${stashes.length + 1}`.repeat(40),
          branch: 'main',
          message,
          createdAt: '2026-11-20T12:10:00+09:00'
        }
        stashes = [
          nextEntry,
          ...stashes.map((item, idx) => ({ ...item, ref: `stash@{${idx + 1}}` }))
        ]

        if (options.scope === 'paths' && options.paths?.includes('wiki/notes.md')) {
          await mainWorkspaceApi?.writeFile(`${workspaceRoot}/notes.md`, '# Head Notes')
          gitState = {
            ...gitState,
            unstaged: gitState.unstaged.filter((item) => item.path !== 'wiki/notes.md')
          }
        } else if (options.scope === 'paths' && options.paths?.includes('wiki/draft.md')) {
          await removeOrIgnoreMissing(`${workspaceRoot}/draft.md`)
          gitState = {
            ...gitState,
            untracked: gitState.untracked.filter((item) => item.path !== 'wiki/draft.md')
          }
        } else if (options.scope === 'all') {
          await mainWorkspaceApi?.writeFile(`${workspaceRoot}/staged.md`, '# Head Staged')
          await mainWorkspaceApi?.writeFile(`${workspaceRoot}/other.md`, '# Head Other')
          if (options.includeUntracked !== false) {
            await removeOrIgnoreMissing(`${workspaceRoot}/draft.md`)
          }
          gitState = {
            ...gitState,
            staged: [],
            unstaged: [],
            untracked: options.includeUntracked === false ? gitState.untracked : []
          }
        } else {
          await mainWorkspaceApi?.writeFile(`${workspaceRoot}/other.md`, '# Head Other')
          if (options.includeUntracked !== false) {
            await removeOrIgnoreMissing(`${workspaceRoot}/draft.md`)
          }
          gitState = {
            ...gitState,
            unstaged: [],
            untracked: options.includeUntracked === false ? gitState.untracked : []
          }
        }
        return gitState
      }
    )

    const stashDropSpy = vi.fn(async (_wsPath: string, stashRef: string) => {
      stashes = stashes
        .filter((item) => item.ref !== stashRef)
        .map((item, idx) => ({ ...item, ref: `stash@{${idx}}` }))
      return stashes
    })

    const stashClearSpy = vi.fn(async () => {
      stashes = []
      return stashes
    })

    const harness = createHarness(
      { autoSave: false, theme: 'light' },
      {
        selectedFolder: 'C:\\repo\\wiki',
        workspaces: {
          'C:\\repo\\wiki': {
            'staged.md': '# Staged Content',
            'notes.md': '# Worktree Notes',
            'other.md': '# Worktree Other',
            'draft.md': '# Untracked Draft'
          }
        },
        git: {
          status: async () => gitState,
          stashList: async () => stashes,
          stashCreate: stashCreateSpy,
          stashDrop: stashDropSpy,
          stashClear: stashClearSpy,
          diff: async (_wsPath, request: GitDiffRequest) => ({
            path: request.path,
            status: request.status,
            isBinary: false,
            isTruncated: false,
            existsInWorkspace: true,
            rawPatch: `diff --git a/${request.path} b/${request.path}\n@@ -1 +1 @@\n-old\n+new`
          })
        }
      }
    )

    const mainWin = harness.createWindow({ role: 'main' })
    mainWorkspaceApi = mainWin.api.workspace
    const {
      mainRendered,
      auxDraft,
      auxNotesRendered,
      gitPanel,
      stashesSection,
      stagedSection: stagedGroup,
      changesSection: changesGroup,
      primaryPane,
      secondaryPane
    } = await setupMultiWindowGitStashScenario(user, harness, mainWin)

    // Staged Changes rows must NOT have single-file Stash icon
    expect(within(stagedGroup).queryByRole('button', { name: 'wiki/staged.md Stash' })).toBeNull()

    // 1. Stash notes.md to verify target-only dirty buffer prompt and auto-closing notes.md unstaged diff
    await user.click(within(changesGroup).getByRole('button', { name: 'wiki/notes.md Stash' }))
    const singleFilePrompt = await within(mainRendered.container).findByRole('alertdialog')
    expect(singleFilePrompt).toHaveTextContent(/notes\.md/)
    expect(singleFilePrompt).not.toHaveTextContent(/draft\.md|staged\.md|other\.md/)
    await user.click(within(singleFilePrompt).getByRole('button', { name: '저장 후 진행' }))

    await waitFor(() => {
      expect(stashCreateSpy).toHaveBeenCalledWith(workspaceRoot, {
        scope: 'paths',
        includeUntracked: true,
        paths: ['wiki/notes.md']
      })
    })
    expect(within(primaryPane).queryByText('Working Tree')).toBeNull()
    expect(within(secondaryPane).getByText('Staged')).toBeInTheDocument()
    expect(getRawEditorText(within(auxNotesRendered.container).getByTestId('document-editor'))).toBe(
      '# Head Notes'
    )
    expect(within(stashesSection).getByRole('button', { name: /^Stashes/i })).toHaveAttribute(
      'aria-expanded',
      'true'
    )

    // 2. Single-file stash on untracked draft.md: must NOT open Diff tab, prompts only draft.md, closes Aux2 draft.md
    await user.click(within(changesGroup).getByRole('button', { name: 'wiki/draft.md Stash' }))
    const untrackedPrompt = await within(mainRendered.container).findByRole('alertdialog')
    expect(untrackedPrompt).toHaveTextContent(/draft\.md/)
    expect(untrackedPrompt).not.toHaveTextContent(/staged\.md|other\.md/)
    expect(within(primaryPane).queryByText('Working Tree')).toBeNull()
    await user.click(within(untrackedPrompt).getByRole('button', { name: '저장 없이 진행' }))

    await waitFor(() => {
      expect(stashCreateSpy).toHaveBeenCalledWith(workspaceRoot, {
        scope: 'paths',
        includeUntracked: true,
        paths: ['wiki/draft.md']
      })
      expect(auxDraft.isClosed()).toBe(true)
      expect(within(mainRendered.container).queryByRole('tab', { name: /draft\.md/ })).toBeNull()
    })
    expect(within(primaryPane).queryByText('Working Tree')).toBeNull()

    // Also open other.md unstaged diff tab so we verify scope='all' auto-closes BOTH staged & unstaged diff tabs
    fireEvent.mouseDown(primaryPane)
    await user.click(within(changesGroup).getByText('other.md'))
    await waitFor(() => {
      expect(primaryPane).toHaveTextContent('Working Tree')
    })

    // Collapse Stashes to verify Stash Input Dialog success re-expands Stashes
    await user.click(within(stashesSection).getByRole('button', { name: /^Stashes/i }))
    expect(within(stashesSection).getByRole('button', { name: /^Stashes/i })).toHaveAttribute(
      'aria-expanded',
      'false'
    )

    // 3. Open Stash Input Dialog from '+' -> Esc cancels without creating stash
    await user.click(within(stashesSection).getByRole('button', { name: '새 Stash 만들기' }))
    expect(await within(mainRendered.container).findByRole('dialog', { name: 'Stash 생성' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() => {
      expect(within(mainRendered.container).queryByRole('dialog', { name: 'Stash 생성' })).toBeNull()
    })
    expect(stashCreateSpy).toHaveBeenCalledTimes(2)

    // 4. Open via ... -> Stash Changes... with empty message & Enter -> stashes unstaged only, keeps Staged Diff tab, auto-expands Stashes
    await user.click(within(gitPanel).getByRole('button', { name: '더 보기' }))
    await user.click(within(gitPanel).getByRole('menuitem', { name: 'Stash Changes...' }))
    const changesDialog = await within(mainRendered.container).findByRole('dialog', {
      name: 'Stash 생성'
    })
    expect(within(changesDialog).getByRole('radio', { name: 'Changes만 보관 (Staged 유지)' })).toBeChecked()
    await user.keyboard('{Enter}')
    const changesConfirm = await within(mainRendered.container).findByRole('alertdialog')
    expect(changesConfirm).toHaveTextContent(/other\.md/)
    expect(changesConfirm).not.toHaveTextContent(/staged\.md/)
    await user.click(within(changesConfirm).getByRole('button', { name: '저장 후 진행' }))

    await waitFor(() => {
      expect(stashCreateSpy).toHaveBeenCalledWith(workspaceRoot, {
        scope: 'unstaged',
        includeUntracked: true
      })
      expect(within(mainRendered.container).queryByText('Working Tree')).toBeNull()
      expect(within(stashesSection).getByRole('button', { name: /^Stashes/i })).toHaveAttribute(
        'aria-expanded',
        'true'
      )
    })
    expect(within(mainRendered.container).getByText('Staged')).toBeInTheDocument()

    // 4b. Open Stash Input Dialog via ... -> Stash All Changes..., customize message, submit via Enter
    await user.click(within(gitPanel).getByRole('button', { name: '더 보기' }))
    await user.click(within(gitPanel).getByRole('menuitem', { name: 'Stash All Changes...' }))
    const allDialog = await within(mainRendered.container).findByRole('dialog', { name: 'Stash 생성' })
    expect(within(allDialog).getByRole('radio', { name: '전체 보관 (Staged 포함)' })).toBeChecked()
    await user.type(within(allDialog).getByLabelText('메시지 (선택)'), 'All changes checkpoint')
    await user.click(within(allDialog).getByRole('checkbox', { name: '미추적 파일(?) 포함' }))
    await user.keyboard('{Enter}')

    // scope: 'all' checks staged.md dirty buffer and closes Staged diff tab
    const allConfirm = await within(mainRendered.container).findByRole('alertdialog')
    expect(allConfirm).toHaveTextContent(/staged\.md/)
    await user.click(within(allConfirm).getByRole('button', { name: '저장 후 진행' }))

    await waitFor(() => {
      expect(stashCreateSpy).toHaveBeenCalledWith(workspaceRoot, {
        scope: 'all',
        message: 'All changes checkpoint',
        includeUntracked: false
      })
      expect(within(mainRendered.container).queryByText('Working Tree')).toBeNull()
      expect(within(mainRendered.container).queryByText('Staged')).toBeNull()
      expect(within(stashesSection).getByText('All changes checkpoint')).toBeInTheDocument()
    })
    expect(within(stashesSection).getByRole('button', { name: /^Stashes/i })).toHaveAttribute(
      'aria-expanded',
      'true'
    )

    // 5. Dirty editor buffer must NOT be prompted during Drop or Clear All
    await user.click(within(mainRendered.container).getByRole('button', { name: '탐색기' }))
    await user.click(
      await within(within(mainRendered.container).getByLabelText('워크스페이스 탐색기')).findByText(
        'other.md'
      )
    )
    setRawEditorText(
      await within(mainRendered.container).findByTestId('document-editor'),
      '# Dirty Before Drop'
    )
    await user.click(within(mainRendered.container).getByRole('button', { name: 'Git' }))
    const liveGitPanel = await within(mainRendered.container).findByLabelText('Git 소스 제어')
    const liveStashesSection = within(liveGitPanel).getByRole('region', { name: 'Stashes' })

    // 6. Drop stash@{0}: Cancel keeps list, Confirm deletes & renumbers remaining stash
    await user.click(within(liveStashesSection).getByRole('button', { name: 'stash@{0} Drop' }))
    const dropCancelDialog = await within(mainRendered.container).findByRole('alertdialog')
    expect(dropCancelDialog).toHaveTextContent('stash@{0}')
    expect(dropCancelDialog).toHaveTextContent('All changes checkpoint')
    expect(dropCancelDialog).toHaveTextContent(/영구|복구할 수 없습니다/)
    expect(within(dropCancelDialog).getByRole('button', { name: 'Drop' })).toHaveClass('btn-danger')
    await user.click(within(dropCancelDialog).getByRole('button', { name: '취소' }))
    expect(stashDropSpy).not.toHaveBeenCalled()
    expect(within(liveStashesSection).getByText('All changes checkpoint')).toBeInTheDocument()

    await user.click(within(liveStashesSection).getByRole('button', { name: 'stash@{0} Drop' }))
    const dropConfirmDialog = await within(mainRendered.container).findByRole('alertdialog')
    await user.click(within(dropConfirmDialog).getByRole('button', { name: 'Drop' }))
    await waitFor(() => {
      expect(stashDropSpy).toHaveBeenCalledWith(workspaceRoot, 'stash@{0}')
      expect(within(liveStashesSection).queryByText('All changes checkpoint')).toBeNull()
    })
    expect(within(liveStashesSection).getByRole('button', { name: /^Stashes/i })).toHaveTextContent(
      '3'
    )
    expect(within(liveStashesSection).getByText('WIP on main: seed (unstaged)')).toBeInTheDocument()

    // 7. Clear All from ... menu cancel keeps stashes; Clear All from Stashes header confirm empties stashes
    await user.click(within(liveGitPanel).getByRole('button', { name: '더 보기' }))
    await user.click(within(liveGitPanel).getByRole('menuitem', { name: 'Clear All Stashes' }))
    const clearCancelDialog = await within(mainRendered.container).findByRole('alertdialog')
    expect(clearCancelDialog).toHaveTextContent(/3개/)
    expect(clearCancelDialog).toHaveTextContent(/영구|복구할 수 없습니다/)
    expect(within(clearCancelDialog).getByRole('button', { name: 'Clear All' })).toHaveClass(
      'btn-danger'
    )
    await user.click(within(clearCancelDialog).getByRole('button', { name: '취소' }))
    expect(stashClearSpy).not.toHaveBeenCalled()

    await user.click(within(liveStashesSection).getByRole('button', { name: 'Clear All' }))
    const clearConfirmDialog = await within(mainRendered.container).findByRole('alertdialog')
    await user.click(within(clearConfirmDialog).getByRole('button', { name: 'Clear All' }))
    await waitFor(() => {
      expect(stashClearSpy).toHaveBeenCalledWith(workspaceRoot)
      expect(within(liveStashesSection).getByText('보관된 Stash가 없습니다.')).toBeInTheDocument()
    })
    expect(within(liveStashesSection).getByRole('button', { name: 'Clear All' })).toBeDisabled()
  }, 30_000)
})
