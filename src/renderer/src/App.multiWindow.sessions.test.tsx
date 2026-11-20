import { act, fireEvent, render, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { createEmptyGitStatus, type GitStatus } from '@shared/git'
import { addFavoriteWorkspace } from '@shared/workspace'
import { App } from './App'
import { mockPrototypeScrollIntoView } from './test/appTestHelpers'
import {
  getRawEditorScroller,
  getRawEditorSelection,
  getRawEditorText,
  type InMemoryWindowHandle,
  type MultiWindowWikiHarness,
  setRawEditorSelection,
  setRawEditorText,
  triggerMenuCommand
} from './test/inMemoryWikiHarness'
import {
  createCrossWindowDataTransfer,
  detachTabViaContextMenu,
  dispatchDragEndAtScreenPoint,
  openConfigFromSettings,
  registerMultiWindowLifecycle
} from './test/multiWindowTestHelpers'

vi.mock('mermaid', async () => (await import('./test/appTestHelpers')).createMermaidMockState().module)

describe('Multi-main-window workspace opening (<App />)', () => {
  const { createHarness, trackDisposer } = registerMultiWindowLifecycle()

  async function openBetaMainWindowFrom(
    user: ReturnType<typeof userEvent.setup>,
    harness: MultiWindowWikiHarness,
    sourceContainer: HTMLElement
  ): Promise<{
    workspaceView1: HTMLElement
    main2: InMemoryWindowHandle
    rendered2: ReturnType<typeof render>
  }> {
    const activityBar1 = within(sourceContainer).getByRole('navigation', { name: '액티비티 바' })
    await user.click(within(activityBar1).getByRole('button', { name: '워크스페이스' }))
    const workspaceView1 = within(sourceContainer).getByRole('region', {
      name: '워크스페이스 뷰'
    })
    await user.click(
      within(workspaceView1).getAllByRole('button', { name: 'beta 새 창에서 열기' })[0]
    )

    await waitFor(() => {
      expect(harness.getMainWindows()).toHaveLength(2)
    })
    const main2 = harness.getMainWindows()[1]
    const rendered2 = render(<App wikiApi={main2.api} />)
    trackDisposer(() => rendered2.unmount())
    const explorer2 = await within(rendered2.container).findByLabelText('워크스페이스 탐색기')
    await within(explorer2).findByTitle('C:/wiki/beta')
    return { workspaceView1, main2, rendered2 }
  }

  async function expectExistingWindowFocusedPreservingAlpha(
    main2: InMemoryWindowHandle,
    rendered1Container: HTMLElement,
    expectedCount: number,
    expectedDraftText: string
  ): Promise<void> {
    await waitFor(() => {
      expect(main2.getRestoreCount()).toBe(expectedCount)
      expect(main2.getFocusCount()).toBe(expectedCount)
    })
    expect(main2.isMinimized()).toBe(false)
    expect(within(rendered1Container).queryByRole('alertdialog')).toBeNull()
    expect(within(rendered1Container).queryByRole('alert')).toBeNull()
    expect(getRawEditorText(within(rendered1Container).getByTestId('document-editor'))).toBe(
      expectedDraftText
    )
  }

  async function openConfigEditorInWindow(
    user: ReturnType<typeof userEvent.setup>,
    win: InMemoryWindowHandle,
    container: HTMLElement
  ): Promise<HTMLElement> {
    await openConfigFromSettings(user, container, win.emitMenuCommand)
    await waitFor(() => {
      expect(within(container).getByRole('tab', { name: /config\.json/ })).toHaveAttribute(
        'aria-selected',
        'true'
      )
    })
    const editors = within(container).getAllByTestId('document-editor')
    return editors[editors.length - 1]
  }

  it('renders open-in-new-window icon buttons on favorite and recent rows with disabled state on the active workspace and preserves the single open-folder button in the top card', async () => {
    const user = userEvent.setup()
    const favorites = addFavoriteWorkspace(
      addFavoriteWorkspace([], 'C:\\wiki\\alpha\\', 'alpha', '2026-11-14T00:00:00.000Z'),
      'C:/wiki/beta',
      'beta',
      '2026-11-14T00:00:01.000Z'
    )
    const harness = createHarness(
      {
        autoSave: false,
        theme: 'light',
        favoriteWorkspaces: favorites,
        recentWorkspaces: ['C:/wiki/alpha', 'C:/wiki/gamma']
      },
      {
        workspaces: {
          'C:\\wiki\\alpha': { 'alpha.md': '# Alpha' },
          'C:\\wiki\\beta': { 'beta.md': '# Beta' },
          'C:\\wiki\\gamma': { 'gamma.md': '# Gamma' }
        }
      }
    )

    const mainWin = harness.createWindow({ role: 'main' })
    const rendered = render(<App wikiApi={mainWin.api} />)
    trackDisposer(() => rendered.unmount())

    await within(rendered.container).findByLabelText('워크스페이스 탐색기')
    const activityBar = within(rendered.container).getByRole('navigation', { name: '액티비티 바' })
    await user.click(within(activityBar).getByRole('button', { name: '워크스페이스' }))

    const workspaceView = within(rendered.container).getByRole('region', { name: '워크스페이스 뷰' })
    const currentCard = workspaceView.querySelector('.workspace-view-current') as HTMLElement
    expect(currentCard).not.toBeNull()
    expect(within(currentCard).getByRole('button', { name: '폴더 열기...' })).toBeInTheDocument()
    expect(within(currentCard).queryByRole('button', { name: /새 창에서 열기/ })).toBeNull()

    const favSection = within(workspaceView)
      .getByText('즐겨찾기 워크스페이스')
      .closest('.workspace-view-section') as HTMLElement
    const recentSection = within(workspaceView)
      .getByText('최근 워크스페이스')
      .closest('.workspace-view-section') as HTMLElement

    // Active workspace row in Favorites renders disabled open-in-new-window before remove button
    const alphaFavItem = within(favSection).getByRole('button', { name: /★\s*alpha/i })
    const alphaFavRow = alphaFavItem.closest('li') as HTMLElement
    const alphaFavButtons = within(alphaFavRow).getAllByRole('button')
    expect(alphaFavButtons.map((btn) => btn.getAttribute('aria-label'))).toEqual([
      null,
      'alpha 새 창에서 열기',
      'alpha 즐겨찾기 해제'
    ])
    const alphaFavNewWinBtn = within(alphaFavRow).getByRole('button', { name: 'alpha 새 창에서 열기' })
    expect(alphaFavNewWinBtn).toHaveAttribute('title', 'alpha 새 창에서 열기')
    expect(alphaFavNewWinBtn).toBeDisabled()

    // Inactive workspace row in Favorites renders enabled open-in-new-window before remove button
    const betaFavItem = within(favSection).getByRole('button', { name: /★\s*beta/i })
    const betaFavRow = betaFavItem.closest('li') as HTMLElement
    const betaFavButtons = within(betaFavRow).getAllByRole('button')
    expect(betaFavButtons.map((btn) => btn.getAttribute('aria-label'))).toEqual([
      null,
      'beta 새 창에서 열기',
      'beta 즐겨찾기 해제'
    ])
    const betaFavNewWinBtn = within(betaFavRow).getByRole('button', { name: 'beta 새 창에서 열기' })
    expect(betaFavNewWinBtn).toHaveAttribute('title', 'beta 새 창에서 열기')
    expect(betaFavNewWinBtn).toBeEnabled()

    // Recent rows: active alpha is disabled, inactive gamma is enabled
    const alphaRecentNewWinBtn = within(recentSection).getByRole('button', {
      name: 'alpha 새 창에서 열기'
    })
    expect(alphaRecentNewWinBtn).toHaveAttribute('title', 'alpha 새 창에서 열기')
    expect(alphaRecentNewWinBtn).toBeDisabled()

    const gammaRecentNewWinBtn = within(recentSection).getByRole('button', {
      name: 'gamma 새 창에서 열기'
    })
    expect(gammaRecentNewWinBtn).toHaveAttribute('title', 'gamma 새 창에서 열기')
    expect(gammaRecentNewWinBtn).toBeEnabled()
  })

  it('opens a new main window via open-in-new-window without altering the original window workspace, unsaved buffer, or Workspace View', async () => {
    const user = userEvent.setup()
    const favorites = addFavoriteWorkspace([], 'C:/wiki/beta', 'beta', '2026-11-14T00:00:00.000Z')
    const harness = createHarness(
      {
        autoSave: false,
        theme: 'light',
        favoriteWorkspaces: favorites,
        recentWorkspaces: ['C:/wiki/alpha', 'C:/wiki/gamma']
      },
      {
        mainBounds: { x: 100, y: 80, width: 1280, height: 820 },
        workspaces: {
          'C:\\wiki\\alpha': { 'alpha.md': '# Alpha' },
          'C:\\wiki\\beta': { 'beta.md': '# Beta' },
          'C:\\wiki\\gamma': { 'gamma.md': '# Gamma' }
        }
      }
    )

    const main1 = harness.createWindow({ role: 'main' })
    const rendered1 = render(<App wikiApi={main1.api} />)
    trackDisposer(() => rendered1.unmount())

    const explorer1 = await within(rendered1.container).findByLabelText('워크스페이스 탐색기')
    await user.click(await within(explorer1).findByText('alpha.md'))
    const editor1 = await within(rendered1.container).findByTestId('document-editor')
    setRawEditorText(editor1, '# Alpha unsaved draft')
    await waitFor(() => {
      expect(within(rendered1.container).getByTestId('dirty-indicator')).toBeInTheDocument()
    })

    const activityBar1 = within(rendered1.container).getByRole('navigation', { name: '액티비티 바' })
    await user.click(within(activityBar1).getByRole('button', { name: '워크스페이스' }))

    const workspaceView1 = within(rendered1.container).getByRole('region', {
      name: '워크스페이스 뷰'
    })
    await user.click(within(workspaceView1).getByRole('button', { name: 'beta 새 창에서 열기' }))

    await waitFor(() => {
      expect(harness.getMainWindows()).toHaveLength(2)
    })

    // Original window stays on Workspace View with alpha open and dirty draft intact without confirm dialog
    expect(within(rendered1.container).queryByRole('alertdialog')).toBeNull()
    expect(
      within(rendered1.container).getByRole('region', { name: '워크스페이스 뷰' })
    ).toBeInTheDocument()
    expect(within(workspaceView1).getByText('C:/wiki/alpha')).toBeInTheDocument()
    expect(within(rendered1.container).getByTestId('dirty-indicator')).toBeInTheDocument()
    expect(getRawEditorText(within(rendered1.container).getByTestId('document-editor'))).toBe(
      '# Alpha unsaved draft'
    )

    const main2 = harness.getMainWindows()[1]
    expect(main2.getInitContext()).toEqual({
      role: 'main',
      initialTabs: [],
      initialWorkspacePath: 'C:/wiki/beta'
    })
    expect(main2.getBounds()).toEqual({ x: 140, y: 120, width: 1280, height: 820 })

    // Also works from Recent Workspaces section
    await user.click(within(workspaceView1).getByRole('button', { name: 'gamma 새 창에서 열기' }))
    await waitFor(() => {
      expect(harness.getMainWindows()).toHaveLength(3)
    })
    expect(harness.getMainWindows()[2].getInitContext().initialWorkspacePath).toBe('C:/wiki/gamma')
    expect(within(rendered1.container).queryByRole('alertdialog')).toBeNull()
    expect(getRawEditorText(within(rendered1.container).getByTestId('document-editor'))).toBe(
      '# Alpha unsaved draft'
    )
  })

  it('displays an error banner in the requesting window without creating a new window when open-in-new-window targets a missing or non-directory path', async () => {
    const user = userEvent.setup()
    const favorites = addFavoriteWorkspace(
      [],
      'C:/wiki/missing-fav',
      'missing-fav',
      '2026-11-14T00:00:00.000Z'
    )
    const harness = createHarness(
      {
        autoSave: false,
        theme: 'light',
        favoriteWorkspaces: favorites,
        recentWorkspaces: ['C:/wiki/alpha', 'C:/wiki/alpha/alpha.md']
      },
      {
        workspaces: {
          'C:\\wiki\\alpha': { 'alpha.md': '# Alpha' }
        }
      }
    )

    const main1 = harness.createWindow({ role: 'main' })
    const rendered1 = render(<App wikiApi={main1.api} />)
    trackDisposer(() => rendered1.unmount())

    await within(rendered1.container).findByLabelText('워크스페이스 탐색기')
    const activityBar1 = within(rendered1.container).getByRole('navigation', { name: '액티비티 바' })
    await user.click(within(activityBar1).getByRole('button', { name: '워크스페이스' }))

    const workspaceView1 = within(rendered1.container).getByRole('region', {
      name: '워크스페이스 뷰'
    })

    // Missing directory path -> error banner displayed in requesting window, no 2nd window created
    await user.click(
      within(workspaceView1).getByRole('button', { name: 'missing-fav 새 창에서 열기' })
    )
    await waitFor(() => {
      expect(within(rendered1.container).getByRole('alert')).toHaveTextContent(
        /워크스페이스 폴더를 찾을 수 없습니다/
      )
    })
    expect(harness.getMainWindows()).toHaveLength(1)
    expect(
      within(rendered1.container).getByRole('region', { name: '워크스페이스 뷰' })
    ).toBeInTheDocument()

    // Non-directory (file) path -> updates error banner in requesting window, still no 2nd window
    await user.click(
      within(workspaceView1).getByRole('button', { name: 'alpha.md 새 창에서 열기' })
    )
    await waitFor(() => {
      expect(within(rendered1.container).getByRole('alert')).toHaveTextContent(
        /선택한 경로는 폴더가 아닙니다/
      )
    })
    expect(harness.getMainWindows()).toHaveLength(1)
  })

  it('initializes a newly opened main window with initialWorkspacePath instead of recentWorkspaces[0], restores saved tree/pane state, enters Explorer view, and updates recentWorkspaces', async () => {
    const user = userEvent.setup()
    const favorites = addFavoriteWorkspace([], 'C:/wiki/beta', 'beta', '2026-11-14T00:00:00.000Z')
    const harness = createHarness(
      {
        autoSave: false,
        theme: 'light',
        favoriteWorkspaces: favorites,
        recentWorkspaces: ['C:/wiki/alpha']
      },
      {
        workspaces: {
          'C:\\wiki\\alpha': { 'alpha.md': '# Alpha' },
          'C:\\wiki\\beta': {
            'beta.md': '# Beta Title\n\nParagraph content for scroll restore',
            'side.md': '# Side Note',
            'sub/deep.md': '# Deep File'
          }
        },
        workspaceStates: {
          'C:\\wiki\\beta': {
            expandedDirs: ['C:\\wiki\\beta\\sub'],
            layout: {
              splitMode: 'horizontal',
              splitRatio: 0.6,
              activePaneId: 'secondary',
              panes: {
                primary: {
                  tabs: [
                    {
                      path: 'C:\\wiki\\beta\\beta.md',
                      mode: 'split',
                      cursor: { selectionStart: 2, selectionEnd: 6 },
                      scrollTop: 48,
                      splitPreviewRatio: 0.5
                    }
                  ],
                  activeTabPath: 'C:\\wiki\\beta\\beta.md'
                },
                secondary: {
                  tabs: [
                    {
                      path: 'C:\\wiki\\beta\\side.md',
                      mode: 'raw',
                      cursor: { selectionStart: 0, selectionEnd: 0 },
                      scrollTop: 0,
                      splitPreviewRatio: 0.5
                    }
                  ],
                  activeTabPath: 'C:\\wiki\\beta\\side.md'
                }
              }
            }
          }
        }
      }
    )

    const main1 = harness.createWindow({ role: 'main' })
    const rendered1 = render(<App wikiApi={main1.api} />)
    trackDisposer(() => rendered1.unmount())

    const explorer1 = await within(rendered1.container).findByLabelText('워크스페이스 탐색기')
    expect(await within(explorer1).findByText('alpha.md')).toBeInTheDocument()

    const activityBar1 = within(rendered1.container).getByRole('navigation', { name: '액티비티 바' })
    await user.click(within(activityBar1).getByRole('button', { name: '워크스페이스' }))
    const workspaceView1 = within(rendered1.container).getByRole('region', {
      name: '워크스페이스 뷰'
    })
    await user.click(within(workspaceView1).getByRole('button', { name: 'beta 새 창에서 열기' }))

    await waitFor(() => {
      expect(harness.getMainWindows()).toHaveLength(2)
    })
    const main2 = harness.getMainWindows()[1]

    // Simulate config.get() resolving BEFORE window.getInitContext() resolves on the new window
    let configResolved = false
    const origConfigGet = main2.api.config.get.bind(main2.api.config)
    main2.api.config.get = async () => {
      const cfg = await origConfigGet()
      configResolved = true
      return cfg
    }
    const origGetInitContext = main2.api.window!.getInitContext.bind(main2.api.window!)
    let releaseInitContext!: () => void
    const initContextGate = new Promise<void>((resolve) => {
      releaseInitContext = resolve
    })
    main2.api.window!.getInitContext = async () => {
      await initContextGate
      return origGetInitContext()
    }
    const main2OpenSpy = vi.spyOn(main2.api.workspace, 'open')

    const rendered2 = render(<App wikiApi={main2.api} />)
    trackDisposer(() => rendered2.unmount())

    await waitFor(() => {
      expect(configResolved).toBe(true)
    })
    // Must wait for initContext rather than auto-restoring recentWorkspaces[0] ('C:/wiki/alpha')
    expect(main2OpenSpy).not.toHaveBeenCalled()

    releaseInitContext()

    const explorer2 = await within(rendered2.container).findByLabelText('워크스페이스 탐색기')
    expect(await within(explorer2).findByText('deep.md')).toBeInTheDocument()
    expect(within(explorer2).getByText('beta')).toHaveAttribute('title', 'C:/wiki/beta')
    expect(main2OpenSpy).toHaveBeenCalledTimes(1)
    expect(main2OpenSpy).toHaveBeenCalledWith('C:/wiki/beta')

    // Restores split layout, active pane, and tab view state
    await waitFor(() => {
      expect(within(rendered2.container).getByTestId('pane-workspace')).toHaveAttribute(
        'data-split-mode',
        'horizontal'
      )
    })
    expect(
      within(rendered2.container).getByRole('separator', { name: '화면 분할 크기 조절' })
    ).toHaveAttribute('aria-valuenow', '60')
    const primaryPane2 = within(rendered2.container).getByTestId('pane-primary')
    const secondaryPane2 = within(rendered2.container).getByTestId('pane-secondary')
    expect(within(primaryPane2).getByRole('tab', { name: /beta\.md/ })).toBeInTheDocument()
    expect(within(secondaryPane2).getByRole('tab', { name: /side\.md/ })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    const primaryRaw2 = within(primaryPane2).getAllByTestId('document-editor')[0]
    expect(getRawEditorSelection(primaryRaw2)).toEqual({ start: 2, end: 6 })
    expect(getRawEditorScroller(primaryRaw2).scrollTop).toBe(48)

    // recentWorkspaces updated with beta first
    const updatedCfg = await main2.api.config.get()
    expect(updatedCfg.recentWorkspaces).toEqual(['C:\\wiki\\beta', 'C:\\wiki\\alpha'])
  })

  it('isolates document buffers, auxiliary windows, folder trees, workspace watch events, Git panel state, and close lifecycle across two main-window workspace sessions', async () => {
    const user = userEvent.setup()
    const favorites = addFavoriteWorkspace([], 'C:/wiki/beta', 'beta', '2026-11-14T00:00:00.000Z')

    let alphaGitStatus: GitStatus = {
      ...createEmptyGitStatus(true, 'C:/wiki/alpha'),
      branch: 'alpha-main',
      unstaged: [
        { path: 'a1.md', status: 'M' },
        { path: 'a2.md', status: 'M' }
      ]
    }
    let betaGitStatus: GitStatus = {
      ...createEmptyGitStatus(true, 'C:/wiki/beta'),
      branch: 'beta-dev',
      staged: [{ path: 'b1.md', status: 'M' }]
    }
    const statusFor = (workspacePath: string): GitStatus =>
      workspacePath.toLowerCase().includes('alpha') ? alphaGitStatus : betaGitStatus

    const harness = createHarness(
      {
        autoSave: false,
        theme: 'light',
        favoriteWorkspaces: favorites,
        recentWorkspaces: ['C:/wiki/alpha']
      },
      {
        workspaces: {
          'C:\\wiki\\alpha': {
            'a1.md': '# Alpha 1',
            'a2.md': '# Alpha 2'
          },
          'C:\\wiki\\beta': {
            'b1.md': '# Beta 1',
            'b2.md': '# Beta 2'
          }
        },
        git: {
          status: async (workspacePath) => statusFor(workspacePath),
          branches: async (workspacePath) => {
            const st = statusFor(workspacePath)
            return {
              current: st.branch,
              isDetached: false,
              branches: [{ name: st.branch ?? 'main', current: true, upstream: null }]
            }
          },
          commit: async (workspacePath) => {
            if (workspacePath.toLowerCase().includes('beta')) {
              betaGitStatus = { ...betaGitStatus, staged: [] }
              return betaGitStatus
            }
            alphaGitStatus = { ...alphaGitStatus, staged: [] }
            return alphaGitStatus
          }
        }
      }
    )

    // Main Window 1 opens Alpha
    const main1 = harness.createWindow({ role: 'main' })
    const rendered1 = render(<App wikiApi={main1.api} />)
    trackDisposer(() => rendered1.unmount())

    const explorer1 = await within(rendered1.container).findByLabelText('워크스페이스 탐색기')
    expect(await within(explorer1).findByText('a1.md')).toBeInTheDocument()

    // Open Beta in Main Window 2 via Workspace View button
    const activityBar1 = within(rendered1.container).getByRole('navigation', { name: '액티비티 바' })
    await user.click(within(activityBar1).getByRole('button', { name: '워크스페이스' }))
    await user.click(
      within(rendered1.container).getByRole('button', { name: 'beta 새 창에서 열기' })
    )
    await waitFor(() => {
      expect(harness.getMainWindows()).toHaveLength(2)
    })

    const main2 = harness.getMainWindows()[1]
    const rendered2 = render(<App wikiApi={main2.api} />)
    trackDisposer(() => rendered2.unmount())

    const explorer2 = await within(rendered2.container).findByLabelText('워크스페이스 탐색기')
    expect(await within(explorer2).findByText('b1.md')).toBeInTheDocument()
    expect(within(explorer2).queryByText('a1.md')).toBeNull()

    // Switch Main Window 1 back to Explorer and open tabs + detach auxiliary windows in both sessions
    await user.click(within(activityBar1).getByRole('button', { name: '탐색기' }))
    const resumedExplorer1 = await within(rendered1.container).findByLabelText('워크스페이스 탐색기')
    await user.click(await within(resumedExplorer1).findByText('a1.md'))
    await user.click(within(resumedExplorer1).getByText('a2.md'))
    await detachTabViaContextMenu(user, rendered1.container, /a1\.md/)

    await user.click(within(explorer2).getByText('b1.md'))
    await user.click(within(explorer2).getByText('b2.md'))
    await detachTabViaContextMenu(user, rendered2.container, /b1\.md/)

    await waitFor(() => {
      expect(harness.getAuxiliaryWindows(main1.windowId)).toHaveLength(1)
      expect(harness.getAuxiliaryWindows(main2.windowId)).toHaveLength(1)
    })

    const aux1 = harness.getAuxiliaryWindows(main1.windowId)[0]
    const aux2 = harness.getAuxiliaryWindows(main2.windowId)[0]
    const auxRendered1 = render(<App wikiApi={aux1.api} />)
    const auxRendered2 = render(<App wikiApi={aux2.api} />)
    trackDisposer(() => auxRendered1.unmount(), () => auxRendered2.unmount())

    const auxEditor1 = await within(auxRendered1.container).findByTestId('document-editor')
    const auxEditor2 = await within(auxRendered2.container).findByTestId('document-editor')
    expect(getRawEditorText(auxEditor1)).toBe('# Alpha 1')
    expect(getRawEditorText(auxEditor2)).toBe('# Beta 1')

    // Re-open a1.md in Main 1 and b1.md in Main 2 to verify per-session buffer sync isolation
    await user.click(within(resumedExplorer1).getByText('a1.md'))
    await user.click(within(explorer2).getByText('b1.md'))

    setRawEditorText(auxEditor1, '# Alpha 1 edited')
    setRawEditorText(auxEditor2, '# Beta 1 edited')

    await waitFor(() => {
      expect(getRawEditorText(within(rendered1.container).getByTestId('document-editor'))).toBe(
        '# Alpha 1 edited'
      )
      expect(getRawEditorText(within(rendered2.container).getByTestId('document-editor'))).toBe(
        '# Beta 1 edited'
      )
    })

    // Save Alpha in Main 1 -> Alpha becomes clean and writes disk, Beta stays dirty in Main 2 & Aux 2
    fireEvent.keyDown(within(rendered1.container).getByTestId('document-editor'), {
      key: 's',
      ctrlKey: true
    })
    await waitFor(() => {
      expect(harness.getFilesSnapshot().get('C:/wiki/alpha/a1.md')).toBe('# Alpha 1 edited')
      expect(within(rendered1.container).queryByTestId('dirty-indicator')).toBeNull()
      expect(within(auxRendered1.container).queryByTestId('dirty-indicator')).toBeNull()
    })
    expect(within(rendered2.container).getByTestId('dirty-indicator')).toBeInTheDocument()
    expect(within(auxRendered2.container).getByTestId('dirty-indicator')).toBeInTheDocument()
    expect(harness.getFilesSnapshot().get('C:/wiki/beta/b1.md')).toBe('# Beta 1')

    // Cross-session tab drag drop from Aux 1 (Alpha) onto Main 2 (Beta) is rejected
    const aux1Tab = within(auxRendered1.container).getByRole('tab', { name: /a1\.md/ })
    const aux1DragTransfer = createCrossWindowDataTransfer({ allowGetData: false })
    fireEvent.dragStart(aux1Tab, { dataTransfer: aux1DragTransfer })
    await waitFor(() => {
      expect(main1.hub.getSnapshot().buffers['c:/wiki/alpha/a1.md']).toBeDefined()
    })
    const dropResult = await main2.api.window!.acceptTabDragDrop({})
    expect(dropResult).toEqual({ accepted: false, reason: 'different-workspace-session' })
    dispatchDragEndAtScreenPoint(aux1Tab, 50, 50)
    expect(within(rendered2.container).queryByRole('tab', { name: /a1\.md/ })).toBeNull()

    // Folder tree creation and workspace:changed watch events remain isolated per session
    await user.click(within(resumedExplorer1).getByRole('button', { name: /새 파일/i }))
    await user.type(await within(resumedExplorer1).findByLabelText('새 파일 이름'), 'a-only.md{Enter}')
    expect(await within(resumedExplorer1).findByText('a-only.md')).toBeInTheDocument()
    expect(within(explorer2).queryByText('a-only.md')).toBeNull()

    const readDirSpy1 = vi.spyOn(main1.api.workspace, 'readDir')
    const readDirSpy2 = vi.spyOn(main2.api.workspace, 'readDir')
    act(() => {
      harness.emitWorkspaceChange({
        rootPath: 'C:/wiki/alpha',
        eventType: 'change',
        relativePath: 'a2.md'
      })
    })
    await waitFor(() => {
      expect(readDirSpy1).toHaveBeenCalled()
    })
    expect(readDirSpy2).not.toHaveBeenCalled()

    // Git panel status, badges, and commits operate independently per session
    const gitBtn1 = within(activityBar1).getByRole('button', { name: 'Git' })
    const activityBar2 = within(rendered2.container).getByRole('navigation', { name: '액티비티 바' })
    const gitBtn2 = within(activityBar2).getByRole('button', { name: 'Git' })
    expect(gitBtn1).toHaveTextContent('2')
    expect(gitBtn2).toHaveTextContent('1')

    await user.click(gitBtn1)
    await user.click(gitBtn2)
    const gitPanel1 = await within(rendered1.container).findByLabelText('Git 소스 제어')
    const gitPanel2 = await within(rendered2.container).findByLabelText('Git 소스 제어')

    expect(within(gitPanel1).getByLabelText('현재 브랜치 alpha-main')).toBeInTheDocument()
    expect(within(gitPanel1).getByText('a1.md')).toBeInTheDocument()
    expect(within(gitPanel1).queryByText('b1.md')).toBeNull()
    expect(within(gitPanel2).getByLabelText('현재 브랜치 beta-dev')).toBeInTheDocument()
    expect(within(gitPanel2).getByText('b1.md')).toBeInTheDocument()
    expect(within(gitPanel2).queryByText('a1.md')).toBeNull()

    // Commit in Main 2 clears Beta's staged item & badge while Alpha's Git panel stays untouched
    await user.type(within(gitPanel2).getByLabelText('커밋 메시지'), 'Commit beta')
    await user.click(within(gitPanel2).getByRole('button', { name: 'Commit' }))
    await waitFor(() => {
      expect(gitBtn2).toHaveTextContent('')
    })
    expect(gitBtn1).toHaveTextContent('2')
    expect(within(gitPanel1).getByText('a1.md')).toBeInTheDocument()

    // Closing Main 1 closes Main 1 and Aux 1 only; Main 2 and Aux 2 remain open
    act(() => {
      main1.requestClose()
    })
    await waitFor(() => {
      expect(main1.isClosed()).toBe(true)
      expect(aux1.isClosed()).toBe(true)
    })
    expect(main2.isClosed()).toBe(false)
    expect(aux2.isClosed()).toBe(false)
  })

  it('restores and focuses the existing main window without creating a duplicate when open-in-new-window targets an already-open workspace', async () => {
    const user = userEvent.setup()
    const favorites = addFavoriteWorkspace([], 'C:/wiki/beta', 'beta', '2026-11-14T00:00:00.000Z')
    const harness = createHarness(
      {
        autoSave: false,
        theme: 'light',
        favoriteWorkspaces: favorites,
        recentWorkspaces: ['C:/wiki/alpha', 'C:\\wiki\\beta\\']
      },
      {
        workspaces: {
          'C:\\wiki\\alpha': { 'alpha.md': '# Alpha' },
          'C:\\wiki\\beta': { 'beta.md': '# Beta' }
        }
      }
    )

    const main1 = harness.createWindow({ role: 'main' })
    const rendered1 = render(<App wikiApi={main1.api} />)
    trackDisposer(() => rendered1.unmount())

    const explorer1 = await within(rendered1.container).findByLabelText('워크스페이스 탐색기')
    await user.click(await within(explorer1).findByText('alpha.md'))
    setRawEditorText(
      await within(rendered1.container).findByTestId('document-editor'),
      '# Alpha unsaved draft'
    )

    const { workspaceView1, main2 } = await openBetaMainWindowFrom(
      user,
      harness,
      rendered1.container
    )

    // Minimize Main 2, then click open-in-new-window for Beta again (Recent slash-variant) -> focuses/restores Main 2 without creating a 3rd window
    main2.setMinimized(true)
    const betaNewWinBtn = within(workspaceView1).getAllByRole('button', {
      name: 'beta 새 창에서 열기'
    })[1]
    await user.click(betaNewWinBtn)

    await expectExistingWindowFocusedPreservingAlpha(
      main2,
      rendered1.container,
      1,
      '# Alpha unsaved draft'
    )
    expect(harness.getMainWindows()).toHaveLength(2)
    expect(within(workspaceView1).getByText('C:/wiki/alpha')).toBeInTheDocument()
  })

  it('restores and focuses the existing main window without showing ConfirmDialog or replacing the current workspace when switching via row click, 폴더 열기..., or menu open-folder while dirty', async () => {
    const user = userEvent.setup()
    const favorites = addFavoriteWorkspace([], 'C:/wiki/beta', 'beta', '2026-11-14T00:00:00.000Z')
    const harness = createHarness(
      {
        autoSave: false,
        theme: 'light',
        favoriteWorkspaces: favorites,
        recentWorkspaces: ['C:/wiki/alpha', 'C:/wiki/gamma']
      },
      {
        workspaces: {
          'C:\\wiki\\alpha': { 'alpha.md': '# Alpha' },
          'C:\\wiki\\beta': { 'beta.md': '# Beta' },
          'C:\\wiki\\gamma': { 'gamma.md': '# Gamma' }
        }
      }
    )

    const main1 = harness.createWindow({ role: 'main' })
    const rendered1 = render(<App wikiApi={main1.api} />)
    trackDisposer(() => rendered1.unmount())

    const explorer1 = await within(rendered1.container).findByLabelText('워크스페이스 탐색기')
    await user.click(await within(explorer1).findByText('alpha.md'))
    setRawEditorText(
      await within(rendered1.container).findByTestId('document-editor'),
      '# Alpha unsaved'
    )
    await waitFor(() => {
      expect(within(rendered1.container).getByTestId('dirty-indicator')).toBeInTheDocument()
    })

    const { workspaceView1, main2 } = await openBetaMainWindowFrom(
      user,
      harness,
      rendered1.container
    )
    const activityBar1 = within(rendered1.container).getByRole('navigation', { name: '액티비티 바' })

    // 1. Clicking Beta row body in Main 1 while Alpha is dirty -> focuses/restores Main 2 without ConfirmDialog or workspace replacement
    main2.setMinimized(true)
    await user.click(within(workspaceView1).getByRole('button', { name: /★\s*beta/i }))

    await expectExistingWindowFocusedPreservingAlpha(
      main2,
      rendered1.container,
      1,
      '# Alpha unsaved'
    )
    expect(within(workspaceView1).getByText('C:/wiki/alpha')).toBeInTheDocument()

    // 2. Clicking '폴더 열기...' and choosing Beta (case + backslash + trailing slash) -> focuses/restores Main 2 without ConfirmDialog
    main2.setMinimized(true)
    main1.api.workspace.selectFolder = async () => 'C:\\wiki\\BETA\\'
    await user.click(within(workspaceView1).getByRole('button', { name: '폴더 열기...' }))

    await expectExistingWindowFocusedPreservingAlpha(
      main2,
      rendered1.container,
      2,
      '# Alpha unsaved'
    )
    expect(within(workspaceView1).getByText('C:/wiki/alpha')).toBeInTheDocument()

    // 3. Triggering Application Menu 'open-folder' -> focuses/restores Main 2 without ConfirmDialog
    await user.click(within(activityBar1).getByRole('button', { name: '탐색기' }))
    main2.setMinimized(true)
    main1.api.workspace.selectFolder = async () => 'C:/wiki/beta'
    await triggerMenuCommand(main1.emitMenuCommand, 'open-folder')

    await expectExistingWindowFocusedPreservingAlpha(
      main2,
      rendered1.container,
      3,
      '# Alpha unsaved'
    )
    const resumedExplorer1 = await within(rendered1.container).findByLabelText('워크스페이스 탐색기')
    expect(within(resumedExplorer1).getByText('alpha.md')).toBeInTheDocument()

    // 4. Selecting an unopened workspace (Gamma) still triggers unsaved ConfirmDialog, and if Gamma opens in Main 2 while dialog is open, confirming focuses Main 2 without replacing Alpha
    await user.click(within(activityBar1).getByRole('button', { name: '워크스페이스' }))
    await user.click(
      within(within(rendered1.container).getByRole('region', { name: '워크스페이스 뷰' })).getByRole(
        'button',
        { name: /^gamma$/i }
      )
    )
    const confirmDialog = await within(rendered1.container).findByRole('alertdialog')
    await main2.api.workspace.open('C:/wiki/gamma')
    main2.setMinimized(true)
    await user.click(within(confirmDialog).getByRole('button', { name: '저장 후 이동' }))

    await expectExistingWindowFocusedPreservingAlpha(
      main2,
      rendered1.container,
      4,
      '# Alpha unsaved'
    )
    expect(
      within(within(rendered1.container).getByRole('region', { name: '워크스페이스 뷰' })).getByText(
        'C:/wiki/alpha'
      )
    ).toBeInTheDocument()
    expect(harness.getFilesSnapshot().get('C:/wiki/alpha/alpha.md')).toBe('# Alpha unsaved')
    expect(harness.getMainWindows()).toHaveLength(2)
  })

  it('syncs global config mutations (theme, autoSave, favorites, recent workspaces, direct config.json edits) across all main and auxiliary windows while keeping each main window Workspace View active state independent', async () => {
    const user = userEvent.setup()
    const favorites = addFavoriteWorkspace([], 'C:/wiki/beta', 'beta', '2026-11-14T00:00:00.000Z')
    const harness = createHarness(
      {
        autoSave: false,
        autoSaveDelayMs: 50,
        theme: 'light',
        favoriteWorkspaces: favorites,
        recentWorkspaces: ['C:/wiki/alpha', 'C:/wiki/beta']
      },
      {
        workspaces: {
          'C:\\wiki\\alpha': { 'a1.md': '# Alpha 1', 'a2.md': '# Alpha 2' },
          'C:\\wiki\\beta': { 'b1.md': '# Beta 1', 'b2.md': '# Beta 2' },
          'C:\\wiki\\gamma': { 'g1.md': '# Gamma 1' }
        }
      }
    )

    const main1 = harness.createWindow({ role: 'main' })
    const rendered1 = render(<App wikiApi={main1.api} />)
    trackDisposer(() => rendered1.unmount())

    const explorer1 = await within(rendered1.container).findByLabelText('워크스페이스 탐색기')
    await user.click(await within(explorer1).findByText('a1.md'))
    await user.click(within(explorer1).getByText('a2.md'))
    await detachTabViaContextMenu(user, rendered1.container, /a1\.md/)

    const { workspaceView1, main2, rendered2 } = await openBetaMainWindowFrom(
      user,
      harness,
      rendered1.container
    )

    const explorer2 = within(rendered2.container).getByLabelText('워크스페이스 탐색기')
    await user.click(await within(explorer2).findByText('b1.md'))
    await user.click(within(explorer2).getByText('b2.md'))
    await detachTabViaContextMenu(user, rendered2.container, /b1\.md/)

    await waitFor(() => {
      expect(harness.getAuxiliaryWindows(main1.windowId)).toHaveLength(1)
      expect(harness.getAuxiliaryWindows(main2.windowId)).toHaveLength(1)
    })
    const aux1 = harness.getAuxiliaryWindows(main1.windowId)[0]
    const aux2 = harness.getAuxiliaryWindows(main2.windowId)[0]
    const auxRendered1 = render(<App wikiApi={aux1.api} />)
    const auxRendered2 = render(<App wikiApi={aux2.api} />)
    trackDisposer(() => auxRendered1.unmount(), () => auxRendered2.unmount())

    const auxEditor2 = await within(auxRendered2.container).findByTestId('document-editor')
    await within(auxRendered1.container).findByTestId('document-editor')

    // Switch Main 2 to Workspace View and verify independent active row & open-in-new-window disabled state
    const activityBar2 = within(rendered2.container).getByRole('navigation', { name: '액티비티 바' })
    await user.click(within(activityBar2).getByRole('button', { name: '워크스페이스' }))
    const workspaceView2 = within(rendered2.container).getByRole('region', {
      name: '워크스페이스 뷰'
    })

    expect(within(workspaceView1).getByRole('button', { name: /^alpha$/i })).toHaveAttribute(
      'aria-current',
      'true'
    )
    expect(within(workspaceView1).getByRole('button', { name: 'alpha 새 창에서 열기' })).toBeDisabled()
    expect(
      within(workspaceView1).getAllByRole('button', { name: 'beta 새 창에서 열기' })[0]
    ).toBeEnabled()

    expect(within(workspaceView2).getByRole('button', { name: /★\s*beta/i })).toHaveAttribute(
      'aria-current',
      'true'
    )
    for (const btn of within(workspaceView2).getAllByRole('button', { name: 'beta 새 창에서 열기' })) {
      expect(btn).toBeDisabled()
    }
    expect(within(workspaceView2).getByRole('button', { name: 'alpha 새 창에서 열기' })).toBeEnabled()

    // 1. Theme toggle in Main 1 propagates in real time to Main 1, Main 2, Aux 1, Aux 2
    await triggerMenuCommand(main1.emitMenuCommand, 'toggle-theme')
    await waitFor(() => {
      for (const viewContainer of [
        rendered1.container,
        rendered2.container,
        auxRendered1.container,
        auxRendered2.container
      ]) {
        expect(viewContainer.querySelector('.app-shell')).toHaveAttribute('data-theme', 'dark')
      }
    })

    // 2. Auto-save toggle in Main 1 Settings Panel propagates to Main 2 and triggers auto-save in Aux 2
    await triggerMenuCommand(main1.emitMenuCommand, 'toggle-settings')
    await triggerMenuCommand(main2.emitMenuCommand, 'toggle-settings')
    const settings1 = await within(rendered1.container).findByRole('dialog', {
      name: '전역 설정 패널'
    })
    const settings2 = await within(rendered2.container).findByRole('dialog', {
      name: '전역 설정 패널'
    })
    const autoSaveCheck1 = within(settings1).getByRole('checkbox', { name: /자동 저장/i })
    const autoSaveCheck2 = within(settings2).getByRole('checkbox', { name: /자동 저장/i })
    expect(autoSaveCheck1).not.toBeChecked()
    expect(autoSaveCheck2).not.toBeChecked()

    await user.click(autoSaveCheck1)
    await waitFor(() => {
      expect(autoSaveCheck2).toBeChecked()
    })

    setRawEditorText(auxEditor2, '# Beta 1 synced autoSave')
    await waitFor(
      () => {
        expect(harness.getFilesSnapshot().get('C:/wiki/beta/b1.md')).toBe(
          '# Beta 1 synced autoSave'
        )
        expect(within(auxRendered2.container).getByText('저장됨')).toBeInTheDocument()
      },
      { timeout: 2000 }
    )

    // Close settings panels before testing Workspace View favorites
    await user.click(within(settings1).getByRole('button', { name: '닫기' }))
    await user.click(within(settings2).getByRole('button', { name: '닫기' }))

    // 3. Favorite add in Main 1 and favorite remove in Main 2 sync across both windows while keeping active/disabled per window
    await user.click(within(workspaceView1).getByRole('button', { name: '즐겨찾기 추가' }))
    await waitFor(() => {
      expect(within(workspaceView2).getByRole('button', { name: /★\s*alpha/i })).toBeInTheDocument()
    })
    expect(within(workspaceView1).getAllByRole('button', { name: 'alpha 새 창에서 열기' })).toSatisfy(
      (btns: HTMLElement[]) => btns.length === 2 && btns.every((btn) => btn.hasAttribute('disabled'))
    )
    expect(within(workspaceView2).getAllByRole('button', { name: 'alpha 새 창에서 열기' })).toSatisfy(
      (btns: HTMLElement[]) =>
        btns.length === 2 && btns.every((btn) => !btn.hasAttribute('disabled'))
    )

    await user.click(within(workspaceView2).getByRole('button', { name: 'alpha 즐겨찾기 해제' }))
    await waitFor(() => {
      expect(within(workspaceView1).queryByRole('button', { name: /★\s*alpha/i })).toBeNull()
      expect(within(workspaceView1).getByRole('button', { name: '즐겨찾기 추가' })).toHaveAttribute(
        'aria-pressed',
        'false'
      )
    })

    // 4. Direct config.json edit & save in Main 1 updates clean config.json buffer and theme/autoSave in Main 1, Main 2, Aux 1, Aux 2
    const configEditor1 = await openConfigEditorInWindow(user, main1, rendered1.container)
    const configEditor2 = await openConfigEditorInWindow(user, main2, rendered2.container)
    await waitFor(() => {
      expect(getRawEditorText(configEditor1)).toContain('"theme": "dark"')
      expect(getRawEditorText(configEditor2)).toContain('"theme": "dark"')
    })

    const editedRaw = JSON.stringify(
      {
        ...(await main1.api.config.get()),
        theme: 'light',
        autoSave: false
      },
      null,
      2
    )
    setRawEditorText(configEditor1, editedRaw)
    fireEvent.keyDown(configEditor1, { key: 's', ctrlKey: true })

    await waitFor(() => {
      for (const viewContainer of [
        rendered1.container,
        rendered2.container,
        auxRendered1.container,
        auxRendered2.container
      ]) {
        expect(viewContainer.querySelector('.app-shell')).toHaveAttribute('data-theme', 'light')
      }
      expect(getRawEditorText(configEditor2)).toContain('"theme": "light"')
      expect(getRawEditorText(configEditor2)).toContain('"autoSave": false')
    })

    // 5. Opening Gamma in Main 2 via '폴더 열기...' updates recentWorkspaces in Main 1 and shifts Main 2's active/disabled row independently
    main2.api.workspace.selectFolder = async () => 'C:/wiki/gamma'
    await user.click(within(workspaceView2).getByRole('button', { name: '폴더 열기...' }))
    await within(rendered2.container).findByLabelText('워크스페이스 탐색기')

    await waitFor(() => {
      expect(within(workspaceView1).getByRole('button', { name: /^gamma$/i })).toBeInTheDocument()
    })
    expect(within(workspaceView1).getByRole('button', { name: 'alpha 새 창에서 열기' })).toBeDisabled()
    expect(within(workspaceView1).getByRole('button', { name: 'gamma 새 창에서 열기' })).toBeEnabled()

    await user.click(within(activityBar2).getByRole('button', { name: '워크스페이스' }))
    const updatedWorkspaceView2 = within(rendered2.container).getByRole('region', {
      name: '워크스페이스 뷰'
    })
    expect(within(updatedWorkspaceView2).getByRole('button', { name: /^gamma$/i })).toHaveAttribute(
      'aria-current',
      'true'
    )
    expect(
      within(updatedWorkspaceView2).getByRole('button', { name: 'gamma 새 창에서 열기' })
    ).toBeDisabled()
    expect(
      within(updatedWorkspaceView2).getAllByRole('button', { name: 'beta 새 창에서 열기' })[0]
    ).toBeEnabled()
  }, 15_000)

  it('ignores Ctrl+Shift+F inside an auxiliary window without rendering Activity Bar or Search View', async () => {
    const harness = createHarness(
      { autoSave: false, theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\docs',
        workspaces: {
          'C:\\wiki\\docs': {
            'intro.md': '# Intro'
          }
        }
      }
    )

    const mainWin = harness.createWindow({ role: 'main' })
    render(<App wikiApi={mainWin.api} />)

    const auxWin = harness.createWindow({ role: 'auxiliary', initialTabs: [] })
    const auxRendered = render(<App wikiApi={auxWin.api} />)

    await waitFor(() => {
      expect(within(auxRendered.container).getByTestId('pane-workspace')).toBeInTheDocument()
    })

    // Focus auxiliary container and dispatch Ctrl+Shift+F -> auxiliary window ignores it
    const paneWorkspace = within(auxRendered.container).getByTestId('pane-workspace')
    fireEvent.keyDown(paneWorkspace, { key: 'F', ctrlKey: true, shiftKey: true })

    expect(within(auxRendered.container).queryByLabelText('액티비티 바')).toBeNull()
    expect(within(auxRendered.container).queryByLabelText('검색 뷰')).toBeNull()
    expect(within(auxRendered.container).queryByLabelText('검색어 입력')).toBeNull()
  })

  it('jumps to preserved Editor Mode and auxiliary unsaved edits inside Main Window while isolating Auxiliary Window and second Main Window', async () => {
    const user = userEvent.setup()
    const { mock: scrollIntoViewSpy, restore: restoreScrollIntoView } = mockPrototypeScrollIntoView()

    try {
      const harness = createHarness(
        {
          autoSave: false,
          theme: 'light',
          recentWorkspaces: ['C:/wiki/alpha', 'C:/wiki/beta']
        },
        {
          workspaces: {
            'C:\\wiki\\alpha': {
              'alpha-doc.md': '# Alpha\nInitial alpha content',
              'alpha-second.md': '# Second\nAlphaSecondToken body line',
              'alpha-plain.md': '# Plain\nPlain text'
            },
            'C:\\wiki\\beta': {
              'beta-doc.md': '# Beta\nSharedBeta content'
            }
          }
        }
      )

      const mainAlpha = harness.createWindow({ role: 'main' })
      const renderedAlpha = render(<App wikiApi={mainAlpha.api} />)
      trackDisposer(() => renderedAlpha.unmount())
      await within(renderedAlpha.container).findByLabelText('워크스페이스 탐색기')

      // Open second main window on beta
      await user.click(
        within(
          within(renderedAlpha.container).getByRole('navigation', { name: '액티비티 바' })
        ).getByRole('button', { name: '워크스페이스' })
      )
      await user.click(
        within(
          within(renderedAlpha.container).getByRole('region', { name: '워크스페이스 뷰' })
        ).getByRole('button', { name: 'beta 새 창에서 열기' })
      )
      await waitFor(() => {
        expect(harness.getMainWindows()).toHaveLength(2)
      })
      const mainBeta = harness.getMainWindows()[1]
      const renderedBeta = render(<App wikiApi={mainBeta.api} />)
      trackDisposer(() => renderedBeta.unmount())
      await within(renderedBeta.container).findByLabelText('워크스페이스 탐색기')

      // Back to Explorer in mainAlpha: set alpha-second.md to Preview, switch to alpha-plain.md, and detach alpha-doc.md to Auxiliary Window
      await user.click(
        within(
          within(renderedAlpha.container).getByRole('navigation', { name: '액티비티 바' })
        ).getByRole('button', { name: '탐색기' })
      )
      const refreshedAlphaExplorer = await within(renderedAlpha.container).findByLabelText(
        '워크스페이스 탐색기'
      )
      await user.click(await within(refreshedAlphaExplorer).findByText('alpha-second.md'))
      const modeGroup = await within(renderedAlpha.container).findByRole('group', {
        name: '에디터 모드 전환'
      })
      await user.click(within(modeGroup).getByRole('button', { name: 'Preview' }))
      expect(within(renderedAlpha.container).getByLabelText('마크다운 미리보기')).toBeInTheDocument()

      await user.click(within(refreshedAlphaExplorer).getByText('alpha-plain.md'))
      await waitFor(() => {
        expect(
          within(renderedAlpha.container).getByRole('tab', { name: 'alpha-plain.md' })
        ).toBeInTheDocument()
      })
      await user.click(within(refreshedAlphaExplorer).getByText('alpha-doc.md'))
      await waitFor(() => {
        expect(
          within(renderedAlpha.container).getByRole('tab', { name: 'alpha-doc.md' })
        ).toBeInTheDocument()
      })
      await detachTabViaContextMenu(user, renderedAlpha.container, /alpha-doc\.md/)
      await waitFor(() => {
        expect(harness.getAuxiliaryWindows(mainAlpha.windowId)).toHaveLength(1)
      })
      const auxWin = harness.getAuxiliaryWindows(mainAlpha.windowId)[0]
      const auxRendered = render(<App wikiApi={auxWin.api} />)
      trackDisposer(() => auxRendered.unmount())
      const auxEditor = await within(auxRendered.container).findByTestId('document-editor')

      // Unsaved edit inside Auxiliary Window
      const updatedAuxText = '# Alpha\nLine two\nAuxUnsavedJumpToken line'
      setRawEditorText(auxEditor, updatedAuxText)
      await waitFor(() => {
        expect(mainAlpha.hub.getSnapshot().buffers['c:/wiki/alpha/alpha-doc.md']?.content).toContain(
          'AuxUnsavedJumpToken'
        )
      })

      // Open Search View in mainAlpha
      await user.click(
        within(
          within(renderedAlpha.container).getByRole('navigation', { name: '액티비티 바' })
        ).getByRole('button', { name: '검색' })
      )
      const alphaSearchView = within(renderedAlpha.container).getByRole('region', {
        name: '검색 뷰'
      })
      const alphaSearchInput = within(alphaSearchView).getByRole('textbox', { name: '검색어 입력' })

      // 1. Jump to alpha-second.md -> preserves Preview mode, highlights without opening Find Bar
      fireEvent.change(alphaSearchInput, { target: { value: 'AlphaSecondToken' } })
      fireEvent.keyDown(alphaSearchInput, { key: 'Enter' })
      scrollIntoViewSpy.mockClear()
      fireEvent.click(
        await within(alphaSearchView).findByRole('button', { name: /AlphaSecondToken/ })
      )

      await waitFor(() => {
        expect(
          within(renderedAlpha.container).getByRole('tab', { name: 'alpha-second.md' })
        ).toHaveAttribute('aria-selected', 'true')
      })
      expect(within(renderedAlpha.container).queryByRole('region', { name: '문서 내 찾기 바' })).toBeNull()
      expect(
        within(
          within(renderedAlpha.container).getByRole('group', { name: '에디터 모드 전환' })
        ).getByRole('button', { name: 'Preview' })
      ).toHaveAttribute('aria-pressed', 'true')
      const previewEl = within(renderedAlpha.container).getByLabelText('마크다운 미리보기')
      expect(previewEl.querySelectorAll('.preview-search-jump-highlight')).toHaveLength(1)
      expect(previewEl.querySelector('.preview-search-jump-highlight')?.textContent).toBe(
        'AlphaSecondToken'
      )
      expect(scrollIntoViewSpy).toHaveBeenCalled()
      expect(auxRendered.container.querySelectorAll('.cm-search-jump-highlight')).toHaveLength(0)
      expect(renderedBeta.container.querySelectorAll('.cm-search-jump-highlight')).toHaveLength(0)

      // 2. Jump to unsaved edit from Auxiliary Window buffer -> opens alpha-doc.md in mainAlpha, jumps accurately without touching auxRendered or mainBeta
      fireEvent.change(alphaSearchInput, { target: { value: 'AuxUnsavedJumpToken' } })
      fireEvent.keyDown(alphaSearchInput, { key: 'Enter' })
      fireEvent.click(
        await within(alphaSearchView).findByRole('button', { name: /AuxUnsavedJumpToken/ })
      )

      await waitFor(() => {
        expect(
          within(renderedAlpha.container).getByRole('tab', { name: /alpha-doc\.md/ })
        ).toHaveAttribute('aria-selected', 'true')
      })
      const mainAlphaEditor = await within(renderedAlpha.container).findByTestId('document-editor')
      const expectedStart = updatedAuxText.indexOf('AuxUnsavedJumpToken')
      await waitFor(() => {
        expect(Number(mainAlphaEditor.getAttribute('data-selection-start'))).toBe(expectedStart)
      })
      expect(renderedAlpha.container.querySelectorAll('.cm-search-jump-highlight')).toHaveLength(1)
      expect(within(renderedAlpha.container).queryByRole('region', { name: '문서 내 찾기 바' })).toBeNull()
      expect(auxRendered.container.querySelectorAll('.cm-search-jump-highlight')).toHaveLength(0)
      expect(within(auxRendered.container).queryByRole('region', { name: '문서 내 찾기 바' })).toBeNull()
      expect(renderedBeta.container.querySelectorAll('.cm-search-jump-highlight')).toHaveLength(0)
    } finally {
      restoreScrollIntoView()
    }
  })

  it('isolates workspace search across main windows, picks up auxiliary unsaved buffer edits, and preserves search state on focusIfOpen', async () => {
    const user = userEvent.setup()
    const harness = createHarness(
      {
        autoSave: false,
        theme: 'light',
        recentWorkspaces: ['C:/wiki/alpha', 'C:/wiki/beta']
      },
      {
        workspaces: {
          'C:\\wiki\\alpha': {
            'alpha-doc.md': '# Alpha\nInitial alpha content'
          },
          'C:\\wiki\\beta': {
            'beta-doc.md': '# Beta\nSharedToken in beta'
          }
        }
      }
    )

    const mainAlpha = harness.createWindow({ role: 'main' })
    const renderedAlpha = render(<App wikiApi={mainAlpha.api} />)
    trackDisposer(() => renderedAlpha.unmount())
    await within(renderedAlpha.container).findByLabelText('워크스페이스 탐색기')

    // Open second main window on beta via Workspace View '새 창에서 열기'
    await user.click(
      within(within(renderedAlpha.container).getByRole('navigation', { name: '액티비티 바' })).getByRole(
        'button',
        { name: '워크스페이스' }
      )
    )
    const alphaWorkspaceView = within(renderedAlpha.container).getByRole('region', {
      name: '워크스페이스 뷰'
    })
    await user.click(within(alphaWorkspaceView).getByRole('button', { name: 'beta 새 창에서 열기' }))
    await waitFor(() => {
      expect(harness.getMainWindows()).toHaveLength(2)
    })
    const mainBeta = harness.getMainWindows()[1]
    const renderedBeta = render(<App wikiApi={mainBeta.api} />)
    trackDisposer(() => renderedBeta.unmount())
    await within(renderedBeta.container).findByLabelText('워크스페이스 탐색기')

    // Open alpha-doc.md in mainAlpha and detach it to an auxiliary window
    await user.click(
      within(within(renderedAlpha.container).getByRole('navigation', { name: '액티비티 바' })).getByRole(
        'button',
        { name: '탐색기' }
      )
    )
    const alphaExplorer = within(renderedAlpha.container).getByLabelText('워크스페이스 탐색기')
    await user.click(await within(alphaExplorer).findByText('alpha-doc.md'))
    await waitFor(() => {
      expect(within(renderedAlpha.container).getByRole('tab', { name: 'alpha-doc.md' })).toBeInTheDocument()
    })
    await detachTabViaContextMenu(user, renderedAlpha.container, /alpha-doc\.md/)
    await waitFor(() => {
      expect(harness.getAuxiliaryWindows(mainAlpha.windowId)).toHaveLength(1)
    })
    const auxWin = harness.getAuxiliaryWindows(mainAlpha.windowId)[0]
    const auxRendered = render(<App wikiApi={auxWin.api} />)
    trackDisposer(() => auxRendered.unmount())
    const auxEditor = await within(auxRendered.container).findByTestId('document-editor')

    // Edit alpha-doc.md inside auxiliary window without saving -> mainAlpha search picks up aux unsaved text, mainBeta does NOT
    setRawEditorText(auxEditor, '# Alpha\nAuxUnsavedSharedToken here')
    await waitFor(() => {
      expect(mainAlpha.hub.getSnapshot().buffers['c:/wiki/alpha/alpha-doc.md']?.content).toContain(
        'AuxUnsavedSharedToken'
      )
    })

    // Ctrl+Shift+F inside auxRendered must NOT open Search View in mainAlpha or auxRendered
    fireEvent.keyDown(auxEditor, { key: 'F', ctrlKey: true, shiftKey: true })
    expect(within(auxRendered.container).queryByLabelText('검색 뷰')).toBeNull()
    expect(within(renderedAlpha.container).queryByLabelText('검색 뷰')).toBeNull()

    // Search in mainAlpha via Ctrl+Shift+F -> finds AuxUnsavedSharedToken in alpha-doc.md only
    fireEvent.keyDown(within(renderedAlpha.container).getByTestId('pane-workspace'), {
      key: 'F',
      ctrlKey: true,
      shiftKey: true
    })
    const alphaSearchView = await within(renderedAlpha.container).findByRole('region', {
      name: '검색 뷰'
    })
    const alphaSearchInput = within(alphaSearchView).getByRole('textbox', { name: '검색어 입력' })
    await user.type(alphaSearchInput, 'SharedToken')
    fireEvent.keyDown(alphaSearchInput, { key: 'Enter' })

    expect(await within(alphaSearchView).findByText(/alpha-doc\.md/)).toBeInTheDocument()
    expect(within(alphaSearchView).queryByText(/beta-doc\.md/)).not.toBeInTheDocument()

    // Search in mainBeta -> finds SharedToken in beta-doc.md only (isolated from alpha's auxiliary buffer)
    fireEvent.keyDown(within(renderedBeta.container).getByTestId('pane-workspace'), {
      key: 'F',
      ctrlKey: true,
      shiftKey: true
    })
    const betaSearchView = await within(renderedBeta.container).findByRole('region', {
      name: '검색 뷰'
    })
    const betaSearchInput = within(betaSearchView).getByRole('textbox', { name: '검색어 입력' })
    await user.type(betaSearchInput, 'SharedToken')
    fireEvent.keyDown(betaSearchInput, { key: 'Enter' })

    expect(await within(betaSearchView).findByText(/beta-doc\.md/)).toBeInTheDocument()
    expect(within(betaSearchView).queryByText(/alpha-doc\.md/)).not.toBeInTheDocument()

    // Clicking beta inside mainAlpha's Workspace View focuses mainBeta instead of switching mainAlpha, keeping mainAlpha's search state intact
    await user.click(
      within(within(renderedAlpha.container).getByRole('navigation', { name: '액티비티 바' })).getByRole(
        'button',
        { name: '워크스페이스' }
      )
    )
    const alphaWsView = within(renderedAlpha.container).getByRole('region', {
      name: '워크스페이스 뷰'
    })
    await user.click(within(alphaWsView).getByRole('button', { name: /^beta$/i }))
    await waitFor(() => {
      expect(mainBeta.getFocusCount()).toBeGreaterThanOrEqual(1)
    })

    await user.click(
      within(within(renderedAlpha.container).getByRole('navigation', { name: '액티비티 바' })).getByRole(
        'button',
        { name: '검색' }
      )
    )
    const alphaSearchAfterFocus = within(renderedAlpha.container).getByRole('region', {
      name: '검색 뷰'
    })
    expect(
      (within(alphaSearchAfterFocus).getByRole('textbox', { name: '검색어 입력' }) as HTMLInputElement).value
    ).toBe('SharedToken')
    expect(within(alphaSearchAfterFocus).getByText(/alpha-doc\.md/)).toBeInTheDocument()
  })

  it('supports in-document Find Bar, Ctrl+F selection auto-fill, Split/Raw navigation, and window isolation across main and auxiliary windows with live shared-buffer sync', async () => {
    const user = userEvent.setup()
    const harness = createHarness(
      { autoSave: false, theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\docs',
        workspaces: {
          'C:\\wiki\\docs': {
            'shared.md': '# Shared Doc\nAuxTarget one\nAuxTarget two',
            'other.md': '# Other\nMainTarget only'
          }
        }
      }
    )

    const mainWin = harness.createWindow({ role: 'main' })
    const mainRendered = render(<App wikiApi={mainWin.api} />)
    trackDisposer(() => mainRendered.unmount())

    await triggerMenuCommand(mainWin.emitMenuCommand, 'open-folder')
    const mainExplorer = await within(mainRendered.container).findByLabelText('워크스페이스 탐색기')
    await user.click(await within(mainExplorer).findByText('shared.md'))
    await user.click(within(mainExplorer).getByText('other.md'))
    await waitFor(() => {
      expect(within(mainRendered.container).getByRole('tab', { name: 'shared.md' })).toBeInTheDocument()
    })

    // Detach shared.md into an auxiliary window
    await detachTabViaContextMenu(user, mainRendered.container, /shared\.md/)
    await waitFor(() => {
      expect(harness.getAuxiliaryWindows(mainWin.windowId)).toHaveLength(1)
    })
    const auxWin = harness.getAuxiliaryWindows(mainWin.windowId)[0]
    const auxRendered = render(<App wikiApi={auxWin.api} />)
    trackDisposer(() => auxRendered.unmount())

    const auxEditor = await within(auxRendered.container).findByTestId('document-editor')

    // Aux window still ignores Ctrl+Shift+F
    fireEvent.keyDown(auxEditor, { key: 'F', ctrlKey: true, shiftKey: true })
    expect(within(auxRendered.container).queryByRole('region', { name: '검색 뷰' })).toBeNull()

    // Select 'AuxTarget' in auxEditor and press Ctrl+F -> opens Find Bar ONLY in auxWin, NOT in mainWin
    const sharedText = '# Shared Doc\nAuxTarget one\nAuxTarget two'
    const targetStart = sharedText.indexOf('AuxTarget')
    setRawEditorSelection(auxEditor, targetStart, targetStart + 'AuxTarget'.length)
    fireEvent.keyDown(auxEditor, { key: 'f', ctrlKey: true })

    const auxFindBar = await within(auxRendered.container).findByRole('region', {
      name: '문서 내 찾기 바'
    })
    expect(
      (within(auxFindBar).getByRole('textbox', { name: '문서 내 검색어 입력' }) as HTMLInputElement).value
    ).toBe('AuxTarget')
    expect(within(auxFindBar).getByText('1 / 2')).toBeInTheDocument()
    expect(auxRendered.container.querySelectorAll('.cm-search-match')).toHaveLength(2)
    expect(
      within(mainRendered.container).queryByRole('region', { name: '문서 내 찾기 바' })
    ).not.toBeInTheDocument()

    // Main window opens shared.md and edits it -> auxWin Find Bar match count & highlights update in real time
    await user.click(await within(mainExplorer).findByText('shared.md'))
    const mainSharedEditor = await within(mainRendered.container).findByTestId('document-editor')
    setRawEditorText(
      mainSharedEditor,
      '# Shared Doc\nAuxTarget one\nAuxTarget two\nAuxTarget three'
    )
    await waitFor(() => {
      expect(within(auxFindBar).getByText('1 / 3')).toBeInTheDocument()
    })
    expect(auxRendered.container.querySelectorAll('.cm-search-match')).toHaveLength(3)

    // Aux window switches to Split mode -> Find Bar persists, Raw drives count, right Preview simultaneously highlights
    await user.click(
      within(within(auxRendered.container).getByRole('group', { name: '에디터 모드 전환' })).getByRole(
        'button',
        { name: 'Split' }
      )
    )
    const auxSplitBar = within(auxRendered.container).getByRole('region', {
      name: '문서 내 찾기 바'
    })
    expect(within(auxSplitBar).getByText('1 / 3')).toBeInTheDocument()
    expect(
      within(auxRendered.container)
        .getByTestId('split-markdown-preview')
        .querySelectorAll('.preview-search-match')
    ).toHaveLength(3)
    await user.click(within(auxSplitBar).getByRole('button', { name: '다음 일치' }))
    expect(within(auxSplitBar).getByText('2 / 3')).toBeInTheDocument()

    // Aux window switches to 위지윅 and Preview -> Find Bar persists and highlights matches live
    await user.click(
      within(within(auxRendered.container).getByRole('group', { name: '에디터 모드 전환' })).getByRole(
        'button',
        { name: '위지윅' }
      )
    )
    expect(within(auxSplitBar).getByText('2 / 3')).toBeInTheDocument()
    expect(auxRendered.container.querySelectorAll('.pm-search-match')).toHaveLength(3)

    await user.click(
      within(within(auxRendered.container).getByRole('group', { name: '에디터 모드 전환' })).getByRole(
        'button',
        { name: 'Preview' }
      )
    )
    expect(within(auxSplitBar).getByText('2 / 3')).toBeInTheDocument()
    expect(auxRendered.container.querySelectorAll('.preview-search-match')).toHaveLength(3)

    // Main window edits shared.md while Aux window is in Preview -> Aux Preview highlights & count sync live
    setRawEditorText(
      mainSharedEditor,
      '# Shared Doc\nAuxTarget one\nAuxTarget two\nAuxTarget three\nAuxTarget four'
    )
    await waitFor(() => {
      expect(within(auxSplitBar).getByText('2 / 4')).toBeInTheDocument()
    })
    expect(auxRendered.container.querySelectorAll('.preview-search-match')).toHaveLength(4)

    await user.click(
      within(within(auxRendered.container).getByRole('group', { name: '에디터 모드 전환' })).getByRole(
        'button',
        { name: 'Split' }
      )
    )

    // Main window Ctrl+F opens independent Find Bar in mainWin without affecting auxWin
    fireEvent.keyDown(mainSharedEditor, { key: 'f', ctrlKey: true })
    const mainFindBar = await within(mainRendered.container).findByRole('region', {
      name: '문서 내 찾기 바'
    })
    await user.type(
      within(mainFindBar).getByRole('textbox', { name: '문서 내 검색어 입력' }),
      'Shared'
    )
    expect(within(mainFindBar).getByText('1 / 1')).toBeInTheDocument()
    expect(
      (within(auxSplitBar).getByRole('textbox', { name: '문서 내 검색어 입력' }) as HTMLInputElement).value
    ).toBe('AuxTarget')

    // Aux window header button closes Find Bar; Ctrl+F from aux pane-workspace reopens with preserved query, and dirty tab close dialog suppresses Ctrl+F in auxWin
    await user.click(within(auxRendered.container).getByRole('button', { name: '문서 내 찾기' }))
    expect(
      within(auxRendered.container).queryByRole('region', { name: '문서 내 찾기 바' })
    ).not.toBeInTheDocument()

    fireEvent.keyDown(within(auxRendered.container).getByTestId('pane-workspace'), {
      key: 'f',
      ctrlKey: true
    })
    expect(
      within(auxRendered.container).getByRole('region', { name: '문서 내 찾기 바' })
    ).toBeInTheDocument()
    expect(
      within(mainRendered.container).getByRole('region', { name: '문서 내 찾기 바' })
    ).toBeInTheDocument()
    await user.click(within(auxRendered.container).getByRole('button', { name: '문서 내 찾기' }))

    // Close shared.md in mainWin first so auxWin holds the sole remaining dirty tab -> ConfirmDialog opens
    await user.click(within(mainRendered.container).getByRole('button', { name: 'shared.md 탭 닫기' }))
    await waitFor(() => {
      expect(mainWin.hub.getSnapshot().tabCounts['c:/wiki/docs/shared.md']).toBe(1)
    })
    await user.click(within(auxRendered.container).getByRole('button', { name: 'shared.md 탭 닫기' }))
    const auxConfirm = await within(auxRendered.container).findByRole('alertdialog')
    fireEvent.keyDown(within(auxRendered.container).getByTestId('pane-workspace'), {
      key: 'f',
      ctrlKey: true
    })
    expect(
      within(auxRendered.container).queryByRole('region', { name: '문서 내 찾기 바' })
    ).not.toBeInTheDocument()
    await user.click(within(auxConfirm).getByRole('button', { name: '취소' }))
  })
})
