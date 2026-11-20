import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyGitStatus } from '@shared/git'
import { addFavoriteWorkspace } from '@shared/workspace'
import { App } from './App'
import themeCss from './styles/theme.css?raw'
import {
  clickActivityBarButton,
  switchPaneEditorMode,
  switchWorkspaceFromView
} from './test/appTestHelpers'
import {
  appendRawEditorText,
  createInMemoryWikiApi,
  getRawEditorScroller,
  getRawEditorSelection,
  getRawEditorText,
  setRawEditorSelection,
  setRawEditorText,
  triggerMenuCommand
} from './test/inMemoryWikiHarness'

vi.mock('mermaid', async () => (await import('./test/appTestHelpers')).createMermaidMockState().module)

describe('Workspace folder tree, favorites, editing, and saving', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
    vi.useRealTimers()
  })

  it('opens a workspace folder via dialog, lazily loads 1-depth subfolders on click, and collapses cleanly', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand, readDirCalls } = createInMemoryWikiApi(
      {},
      {
        selectedFolder: 'C:\\wiki\\project',
        workspaces: {
          'C:\\wiki\\project': {
            'docs/intro.md': '# Intro',
            'readme.md': '# Root Readme'
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)

    await triggerMenuCommand(emitMenuCommand, 'open-folder')

    const sidebar = screen.getByLabelText('워크스페이스 탐색기')
    expect(await within(sidebar).findByText('docs')).toBeInTheDocument()
    expect(within(sidebar).getByText('readme.md')).toBeInTheDocument()
    // Subfolder children must NOT be loaded until clicked
    expect(within(sidebar).queryByText('intro.md')).not.toBeInTheDocument()
    expect(readDirCalls).toEqual(['C:/wiki/project'])

    // Expanding folder triggers 1-depth lazy load
    await user.click(within(sidebar).getByText('docs'))
    expect(await within(sidebar).findByText('intro.md')).toBeInTheDocument()
    expect(readDirCalls).toEqual(['C:/wiki/project', 'C:/wiki/project/docs'])

    // Collapsing hides child without re-fetching
    await user.click(within(sidebar).getByText('docs'))
    expect(within(sidebar).queryByText('intro.md')).not.toBeInTheDocument()
  })

  it('creates files/folders, renames via F2 and context menu, and deletes after confirmation', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand, getFilesSnapshot } = createInMemoryWikiApi(
      {},
      {
        selectedFolder: 'C:\\wiki\\notes',
        workspaces: {
          'C:\\wiki\\notes': {
            'existing.md': '# Existing'
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')

    const sidebar = screen.getByLabelText('워크스페이스 탐색기')
    await within(sidebar).findByText('existing.md')

    // Create folder
    await user.click(within(sidebar).getByRole('button', { name: /새 폴더/i }))
    const folderInput = await within(sidebar).findByLabelText('새 폴더 이름')
    await user.type(folderInput, 'guides{Enter}')
    expect(await within(sidebar).findByText('guides')).toBeInTheDocument()

    // Create file via context menu on folder
    fireEvent.contextMenu(within(sidebar).getByText('guides'))
    const menu = await screen.findByRole('menu')
    await user.click(within(menu).getByRole('menuitem', { name: /새 파일/i }))
    const fileInput = await within(sidebar).findByLabelText('새 파일 이름')
    await user.type(fileInput, 'setup.md{Enter}')

    expect(await within(sidebar).findByText('setup.md')).toBeInTheDocument()
    expect(getFilesSnapshot().has('C:/wiki/notes/guides/setup.md')).toBe(true)

    // Rename file via F2 shortcut
    const setupItem = within(sidebar).getByRole('treeitem', { name: 'setup.md' })
    setupItem.focus()
    fireEvent.keyDown(setupItem, { key: 'F2' })
    const renameInput = await within(sidebar).findByLabelText('새 이름 입력')
    await user.clear(renameInput)
    await user.type(renameInput, 'getting-started.md{Enter}')

    expect(await within(sidebar).findByText('getting-started.md')).toBeInTheDocument()
    expect(getFilesSnapshot().has('C:/wiki/notes/guides/getting-started.md')).toBe(true)

    // Delete via context menu + confirmation dialog
    fireEvent.contextMenu(within(sidebar).getByText('getting-started.md'))
    const deleteMenu = await screen.findByRole('menu')
    await user.click(within(deleteMenu).getByRole('menuitem', { name: /삭제/i }))

    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: /삭제 확인/i }))

    await waitFor(() => {
      expect(within(sidebar).queryByText('getting-started.md')).not.toBeInTheDocument()
    })
    expect(getFilesSnapshot().has('C:/wiki/notes/guides/getting-started.md')).toBe(false)
  })

  it('renders workspace view inside the left sidebar when no workspace is open, supports open-folder button, opens recent workspace directly, and simplifies explorer header', async () => {
    const user = userEvent.setup()
    const favoriteAlpha = addFavoriteWorkspace(
      [],
      'C:/wiki/alpha',
      'alpha',
      '2026-11-14T00:00:00.000Z'
    )
    const { api } = createInMemoryWikiApi(
      {
        favoriteWorkspaces: favoriteAlpha,
        recentWorkspaces: ['C:/wiki/deleted-ws', 'C:/wiki/gamma']
      },
      {
        selectedFolder: 'C:\\wiki\\alpha',
        workspaces: {
          'C:\\wiki\\alpha': { 'alpha.md': '# Alpha' },
          'C:\\wiki\\gamma': { 'gamma.md': '# Gamma' }
        }
      }
    )
    const selectFolderSpy = vi.fn(api.workspace.selectFolder)
    api.workspace.selectFolder = selectFolderSpy
    window.wikiApi = api

    render(<App />)
    await screen.findByText('열린 워크스페이스 없음')
    await waitFor(async () => {
      const cfg = await api.config.get()
      expect(cfg.recentWorkspaces).toEqual(['C:/wiki/gamma'])
    })

    expect(screen.queryByRole('banner')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    const workspaceView = screen.getByRole('region', { name: '워크스페이스 뷰' })
    expect(within(workspaceView).getByText('열린 워크스페이스 없음')).toBeInTheDocument()
    expect(
      within(workspaceView).getByText(/폴더를 열거나.*선택하세요/i)
    ).toBeInTheDocument()
    expect(
      within(workspaceView).queryByRole('button', { name: /^(?:즐겨찾기 추가|즐겨찾기 해제)$/ })
    ).not.toBeInTheDocument()
    expect(within(workspaceView).getByRole('button', { name: /★\s*alpha/i })).toBeInTheDocument()
    expect(within(workspaceView).getByRole('button', { name: /^gamma$/i })).toBeInTheDocument()
    expect(within(workspaceView).queryByRole('button', { name: /deleted-ws/i })).not.toBeInTheDocument()

    // Clicking '폴더 열기...' triggers the same folder selection handler as File > Open Folder
    await user.click(within(workspaceView).getByRole('button', { name: '폴더 열기...' }))
    expect(selectFolderSpy).toHaveBeenCalledTimes(1)
    const explorerAfterOpen = await screen.findByLabelText('워크스페이스 탐색기')
    expect(await within(explorerAfterOpen).findByText('alpha.md')).toBeInTheDocument()

    // Return to Workspace View and click recent workspace directly -> opens gamma and transitions to Explorer
    await clickActivityBarButton(user, '워크스페이스')
    const reopenedWorkspaceView = screen.getByRole('region', { name: '워크스페이스 뷰' })
    await user.click(within(reopenedWorkspaceView).getByRole('button', { name: /^gamma$/i }))

    const sidebar = await screen.findByLabelText('워크스페이스 탐색기')
    expect(await within(sidebar).findByText('gamma.md')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '워크스페이스 뷰' })).not.toBeInTheDocument()

    // Explorer header only displays workspace name (with path tooltip) and create/refresh actions
    const titleEl = within(sidebar).getByText('gamma')
    expect(titleEl).toHaveAttribute('title', 'C:/wiki/gamma')
    expect(
      within(sidebar).queryByRole('button', { name: /워크스페이스 전환/i })
    ).not.toBeInTheDocument()
    expect(
      within(sidebar).queryByRole('button', { name: /즐겨찾기 추가|즐겨찾기 해제/i })
    ).not.toBeInTheDocument()
    expect(within(sidebar).getByRole('button', { name: /새 파일/i })).toBeInTheDocument()
    expect(within(sidebar).getByRole('button', { name: /새 폴더/i })).toBeInTheDocument()
    expect(within(sidebar).getByRole('button', { name: /새로고침/i })).toBeInTheDocument()
  })

  it('displays current workspace card with favorite toggle in workspace view, highlights active item, confirms unsaved edits, and keeps workspace view on cancel or error', async () => {
    const user = userEvent.setup()
    const favoriteAlpha = addFavoriteWorkspace(
      [],
      'C:/wiki/alpha',
      'alpha',
      '2026-11-14T00:00:00.000Z'
    )
    const { api } = createInMemoryWikiApi(
      {
        autoSave: false,
        favoriteWorkspaces: favoriteAlpha,
        recentWorkspaces: ['C:/wiki/recent-ws', 'C:/wiki/broken-ws']
      },
      {
        workspaces: {
          'C:\\wiki\\alpha': { 'alpha.md': '# Alpha' },
          'C:\\wiki\\recent-ws': { 'recent.md': '# Recent' }
        }
      }
    )
    const defaultOpen = api.workspace.open
    api.workspace.open = async (rootPath) => {
      if (rootPath.replace(/\\/g, '/') === 'C:/wiki/broken-ws') {
        throw new Error('Workspace open failed')
      }
      return defaultOpen(rootPath)
    }
    window.wikiApi = api

    render(<App />)

    // Startup restore opens recent-ws automatically into Explorer View; switch to Workspace View to verify switcher flows
    const initialExplorer = await screen.findByLabelText('워크스페이스 탐색기')
    expect(await within(initialExplorer).findByText('recent.md')).toBeInTheDocument()
    await clickActivityBarButton(user, '워크스페이스')

    // Switch failure keeps Workspace View active and displays error banner
    const initialWorkspaceView = screen.getByRole('region', { name: '워크스페이스 뷰' })
    await user.click(within(initialWorkspaceView).getByRole('button', { name: /^broken-ws$/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Workspace open failed')
    expect(screen.getByRole('region', { name: '워크스페이스 뷰' })).toBeInTheDocument()

    // Open favorite workspace from Workspace View -> switches to Explorer
    await user.click(within(initialWorkspaceView).getByRole('button', { name: /★\s*alpha/i }))
    const explorer = await screen.findByLabelText('워크스페이스 탐색기')
    expect(await within(explorer).findByText('alpha.md')).toBeInTheDocument()

    // Edit alpha.md so workspace has unsaved changes
    await user.click(within(explorer).getByText('alpha.md'))
    appendRawEditorText(await screen.findByTestId('document-editor'), ' unsaved')
    expect(screen.getByTestId('dirty-indicator')).toBeInTheDocument()

    // Open Workspace View -> shows current workspace name/path, favorite toggle (pressed), open folder, and active highlight
    await clickActivityBarButton(user, '워크스페이스')
    const workspaceView = screen.getByRole('region', { name: '워크스페이스 뷰' })
    expect(within(workspaceView).getByText('C:/wiki/alpha')).toBeInTheDocument()
    expect(within(workspaceView).getByRole('button', { name: '폴더 열기...' })).toBeInTheDocument()
    const activeFavoriteBtn = within(workspaceView).getByRole('button', { name: '즐겨찾기 해제' })
    expect(activeFavoriteBtn).toHaveAttribute('aria-pressed', 'true')
    expect(activeFavoriteBtn).toHaveAttribute('title', '즐겨찾기 해제')
    const activeAlphaBtn = within(workspaceView).getByRole('button', { name: /★\s*alpha/i })
    expect(activeAlphaBtn).toHaveAttribute('aria-current', 'true')
    expect(activeAlphaBtn).toHaveClass('is-active')

    // Switch to recent workspace -> triggers unsaved confirmation dialog; cancel keeps Workspace View & current workspace
    await user.click(within(workspaceView).getByRole('button', { name: /^recent-ws$/i }))
    const cancelDialog = await screen.findByRole('alertdialog')
    await user.click(within(cancelDialog).getByRole('button', { name: '취소' }))
    expect(screen.getByRole('region', { name: '워크스페이스 뷰' })).toBeInTheDocument()
    expect(getRawEditorText(screen.getByTestId('document-editor'))).toBe('# Alpha unsaved')

    // Retry switching to recent workspace and discard unsaved changes -> transitions to Explorer
    await user.click(within(workspaceView).getByRole('button', { name: /^recent-ws$/i }))
    const discardDialog = await screen.findByRole('alertdialog')
    await user.click(within(discardDialog).getByRole('button', { name: /버리고 이동/i }))

    const nextExplorer = await screen.findByLabelText('워크스페이스 탐색기')
    expect(await within(nextExplorer).findByText('recent.md')).toBeInTheDocument()

    // Return to Workspace View -> shows recent-ws current card, unpressed favorite toggle, and highlighted recent item
    await clickActivityBarButton(user, '워크스페이스')
    const nextWorkspaceView = screen.getByRole('region', { name: '워크스페이스 뷰' })
    expect(within(nextWorkspaceView).getByText('C:/wiki/recent-ws')).toBeInTheDocument()
    const nextFavoriteBtn = within(nextWorkspaceView).getByRole('button', { name: '즐겨찾기 추가' })
    expect(nextFavoriteBtn).toHaveAttribute('aria-pressed', 'false')
    expect(nextFavoriteBtn).toHaveAttribute('title', '즐겨찾기 추가')
    expect(within(nextWorkspaceView).getByRole('button', { name: /^recent-ws$/i })).toHaveAttribute(
      'aria-current',
      'true'
    )
  })

  it('toggles current workspace in favorites and switches or removes favorites directly from workspace view', async () => {
    const user = userEvent.setup()
    const favoriteBeta = addFavoriteWorkspace([], 'C:/wiki/beta', 'beta', '2026-11-14T00:00:00.000Z')
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { favoriteWorkspaces: favoriteBeta },
      {
        selectedFolder: 'C:\\wiki\\alpha',
        workspaces: {
          'C:\\wiki\\alpha': { 'alpha.md': '# Alpha' },
          'C:\\wiki\\beta': { 'beta.md': '# Beta' }
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')

    const sidebar = screen.getByLabelText('워크스페이스 탐색기')
    expect(await within(sidebar).findByText('alpha.md')).toBeInTheDocument()

    // Switch to Workspace View and add alpha to favorites
    await clickActivityBarButton(user, '워크스페이스')
    const workspaceView = screen.getByRole('region', { name: '워크스페이스 뷰' })
    await user.click(within(workspaceView).getByRole('button', { name: '즐겨찾기 추가' }))
    await waitFor(() => {
      expect(within(workspaceView).getByRole('button', { name: '즐겨찾기 해제' })).toHaveAttribute(
        'aria-pressed',
        'true'
      )
    })
    expect(within(workspaceView).getByRole('button', { name: /★\s*alpha/i })).toHaveAttribute(
      'aria-current',
      'true'
    )

    // Click ★ beta in Workspace View to switch workspaces and transition to Explorer
    await user.click(within(workspaceView).getByRole('button', { name: /★\s*beta/i }))

    const betaExplorer = await screen.findByLabelText('워크스페이스 탐색기')
    expect(await within(betaExplorer).findByText('beta.md')).toBeInTheDocument()
    expect(within(betaExplorer).queryByText('alpha.md')).not.toBeInTheDocument()

    // Return to Workspace View and remove beta from favorites via × button
    await clickActivityBarButton(user, '워크스페이스')
    const updatedWorkspaceView = screen.getByRole('region', { name: '워크스페이스 뷰' })
    const removeBetaBtn = within(updatedWorkspaceView).getByRole('button', {
      name: 'beta 즐겨찾기 해제'
    })
    expect(removeBetaBtn).toHaveAttribute('title', 'beta 즐겨찾기 해제')
    await user.click(removeBetaBtn)

    await waitFor(() => {
      expect(
        within(updatedWorkspaceView).getByRole('button', { name: '즐겨찾기 추가' })
      ).toHaveAttribute('aria-pressed', 'false')
    })
    expect(
      within(updatedWorkspaceView).queryByRole('button', { name: /★\s*beta/i })
    ).not.toBeInTheDocument()
  })

  it('does not overwrite user-selected activity bar view when async config resolves or workspace opens from another view', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { recentWorkspaces: ['C:/wiki/alpha'] },
      {
        selectedFolder: 'C:\\wiki\\beta',
        workspaces: {
          'C:\\wiki\\alpha': { 'alpha.md': '# Alpha' },
          'C:\\wiki\\beta': { 'beta.md': '# Beta' }
        }
      }
    )
    let resolveConfigGet!: (value: Awaited<ReturnType<typeof api.config.get>>) => void
    const defaultConfigGet = api.config.get
    api.config.get = async () => {
      const resolved = await defaultConfigGet()
      return await new Promise((resolve) => {
        resolveConfigGet = () => resolve(resolved)
      })
    }
    const openSpy = vi.spyOn(api.workspace, 'open')
    window.wikiApi = api

    render(<App />)
    const activityBar = screen.getByRole('navigation', { name: '액티비티 바' })
    expect(within(activityBar).getByRole('button', { name: '워크스페이스' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )

    // User switches to Git view before config.get() resolves
    await clickActivityBarButton(user, 'Git')
    expect(screen.getByRole('region', { name: 'Git 소스 제어' })).toBeInTheDocument()

    // Resolving config.get() triggers startup restore, which must NOT overwrite the user's Git view selection
    await act(async () => {
      resolveConfigGet(undefined as never)
    })
    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledWith('C:/wiki/alpha')
    })
    expect(within(activityBar).getByRole('button', { name: 'Git' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByRole('region', { name: 'Git 소스 제어' })).toBeInTheDocument()

    // Opening another folder while user is in Git view preserves Git view instead of forcing Explorer
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    expect(within(activityBar).getByRole('button', { name: 'Git' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByRole('region', { name: 'Git 소스 제어' })).toBeInTheDocument()
  })

  it('tracks dirty ● indicator, saves manually with Ctrl+S, and auto-saves when autoSave is enabled', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand, getFilesSnapshot } = createInMemoryWikiApi(
      { autoSave: false, autoSaveDelayMs: 120 },
      {
        selectedFolder: 'C:\\wiki\\docs',
        workspaces: {
          'C:\\wiki\\docs': {
            'note.md': '# Initial'
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    const sidebar = screen.getByLabelText('워크스페이스 탐색기')
    await user.click(await within(sidebar).findByText('note.md'))

    const editor = await screen.findByTestId('document-editor')
    expect(getRawEditorText(editor)).toBe('# Initial')
    expect(screen.queryByTestId('dirty-indicator')).not.toBeInTheDocument()

    // Edit content -> dirty ● appears
    appendRawEditorText(editor, '\nUpdated line')
    expect(screen.getByTestId('dirty-indicator')).toHaveTextContent('●')

    // Ctrl+S saves and clears dirty ●
    fireEvent.keyDown(editor, { key: 's', ctrlKey: true })
    await waitFor(() => {
      expect(screen.queryByTestId('dirty-indicator')).not.toBeInTheDocument()
    })
    expect(getFilesSnapshot().get('C:/wiki/docs/note.md')).toBe('# Initial\nUpdated line')

    // Enable auto-save in settings panel
    await triggerMenuCommand(emitMenuCommand, 'toggle-settings')
    const autoSaveToggle = await screen.findByRole('checkbox', { name: /자동 저장/i })
    await user.click(autoSaveToggle)
    await waitFor(() => {
      expect(autoSaveToggle).toBeChecked()
    })

    // Type again and wait for debounced auto-save
    appendRawEditorText(editor, '\nAuto saved')
    expect(screen.getByTestId('dirty-indicator')).toBeInTheDocument()

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250))
    })

    await waitFor(() => {
      expect(screen.queryByTestId('dirty-indicator')).not.toBeInTheDocument()
    })
    expect(getFilesSnapshot().get('C:/wiki/docs/note.md')).toBe(
      '# Initial\nUpdated line\nAuto saved'
    )
  })

  it('validates config.json when editing and saving directly, applying valid changes immediately and rejecting invalid JSON without corrupting config', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand } = createInMemoryWikiApi({ theme: 'light', autoSave: false })
    window.wikiApi = api

    render(<App />)

    await triggerMenuCommand(emitMenuCommand, 'toggle-settings')
    await user.click(screen.getByRole('button', { name: /설정 파일 직접 열기/i }))

    const editor = await screen.findByTestId('document-editor')
    expect(getRawEditorText(editor)).toContain('"theme": "light"')

    // Invalid JSON must be rejected and keep dirty indicator
    setRawEditorText(editor, '{ broken json')
    fireEvent.keyDown(editor, { key: 's', ctrlKey: true })

    expect(await screen.findByRole('alert')).toHaveTextContent(/JSON/i)
    expect(screen.getByTestId('dirty-indicator')).toBeInTheDocument()
    expect((await api.config.get()).theme).toBe('light')

    // Valid updated config.json applies immediately to the running app
    const nextConfigJson = JSON.stringify(
      {
        version: 1,
        theme: 'dark',
        autoSave: true,
        autoSaveDelayMs: 500,
        showHeadingNumbers: true,
        favoriteWorkspaces: [],
        recentWorkspaces: []
      },
      null,
      2
    )
    setRawEditorText(editor, nextConfigJson)
    fireEvent.keyDown(editor, { key: 's', ctrlKey: true })

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
      expect(screen.queryByTestId('dirty-indicator')).not.toBeInTheDocument()
    })
    expect((await api.config.get()).autoSave).toBe(true)
  })

  it('prompts before leaving unsaved edits, syncs active document path on rename, and refreshes on workspace watch events', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand, emitWorkspaceChange, getFilesSnapshot } = createInMemoryWikiApi(
      {},
      {
        selectedFolder: 'C:\\wiki\\sync',
        workspaces: {
          'C:\\wiki\\sync': {
            'first.md': '# First',
            'second.md': '# Second'
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    const sidebar = screen.getByLabelText('워크스페이스 탐색기')

    await user.click(await within(sidebar).findByText('first.md'))
    const editor = await screen.findByTestId('document-editor')
    appendRawEditorText(editor, ' edited')
    expect(screen.getByTestId('dirty-indicator')).toBeInTheDocument()

    // Clicking second.md opens a second tab while first.md stays open and dirty; closing first.md prompts -> 저장 후 닫기
    await user.click(within(sidebar).getByText('second.md'))
    expect(getRawEditorText(screen.getByTestId('document-editor'))).toBe('# Second')
    await user.click(screen.getByRole('button', { name: 'first.md 탭 닫기' }))
    const dirtyDialog = await screen.findByRole('alertdialog')
    await user.click(within(dirtyDialog).getByRole('button', { name: /저장 후 닫기/i }))

    await waitFor(() => {
      expect(getRawEditorText(screen.getByTestId('document-editor'))).toBe('# Second')
      expect(screen.queryByRole('tab', { name: /first\.md/i })).not.toBeInTheDocument()
    })
    expect(getFilesSnapshot().get('C:/wiki/sync/first.md')).toBe('# First edited')

    // Renaming active file updates its path so saving writes to the renamed file
    const secondItem = within(sidebar).getByRole('treeitem', { name: 'second.md' })
    secondItem.focus()
    fireEvent.keyDown(secondItem, { key: 'F2' })
    const renameInput = await within(sidebar).findByLabelText('새 이름 입력')
    await user.clear(renameInput)
    await user.type(renameInput, 'renamed-second.md{Enter}')

    await waitFor(() => {
      expect(screen.getByText('renamed-second.md', { selector: '.editor-doc-title' })).toBeInTheDocument()
    })
    appendRawEditorText(screen.getByTestId('document-editor'), '!')
    fireEvent.keyDown(screen.getByTestId('document-editor'), { key: 's', ctrlKey: true })
    await waitFor(() => {
      expect(getFilesSnapshot().get('C:/wiki/sync/renamed-second.md')).toBe('# Second!')
    })

    // External filesystem creation triggers tree refresh via workspace:changed
    await api.workspace.createEntry('.', 'external-added.md', 'file', '# External')
    emitWorkspaceChange({
      rootPath: 'C:/wiki/sync',
      eventType: 'rename',
      relativePath: 'external-added.md'
    })
    expect(await within(sidebar).findByText('external-added.md')).toBeInTheDocument()
  })

  it('allows returning selection to workspace root, disables auto-save on config.json and paused dirty dialogs, and blocks concurrent Ctrl+S saves', async () => {
    const user = userEvent.setup()
    let writeCount = 0
    let resolveWrite!: () => void
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { autoSave: true, autoSaveDelayMs: 60 },
      {
        selectedFolder: 'C:\\wiki\\edge',
        workspaces: {
          'C:\\wiki\\edge': {
            'nested/inner.md': '# Inner',
            'other.md': '# Other'
          }
        }
      }
    )
    const origWriteFile = api.workspace.writeFile
    api.workspace.writeFile = async (filePath, content) => {
      writeCount += 1
      if (writeCount === 1) {
        return new Promise<void>((resolve) => {
          resolveWrite = () => {
            void origWriteFile(filePath, content).then(resolve)
          }
        })
      }
      return origWriteFile(filePath, content)
    }
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    const sidebar = screen.getByLabelText('워크스페이스 탐색기')

    // Select nested item, then click empty tree area to clear selection and create at workspace root
    await user.click(await within(sidebar).findByText('nested'))
    expect(await within(sidebar).findByText('inner.md')).toBeInTheDocument()
    await user.click(within(sidebar).getByText('inner.md'))
    await user.click(within(sidebar).getByRole('tree'))
    await user.click(within(sidebar).getByRole('button', { name: /새 파일/i }))
    await user.type(await within(sidebar).findByLabelText('새 파일 이름'), 'top-level.md{Enter}')
    expect(await within(sidebar).findByText('top-level.md')).toBeInTheDocument()

    // Rapid Ctrl+S while save is in flight must NOT fire overlapping writeFile calls
    const editor = await screen.findByTestId('document-editor')
    appendRawEditorText(editor, 'hello')
    fireEvent.keyDown(editor, { key: 's', ctrlKey: true })
    fireEvent.keyDown(editor, { key: 's', ctrlKey: true })
    expect(writeCount).toBe(1)
    resolveWrite()
    await waitFor(() => {
      expect(screen.queryByTestId('dirty-indicator')).not.toBeInTheDocument()
    })

    // While dirty-confirmation dialog is open, auto-save is paused and must not auto-write before choice
    const closeTopLevelBtn = screen.getByRole('button', { name: 'top-level.md 탭 닫기' })
    appendRawEditorText(editor, ' unsaved')
    fireEvent.click(closeTopLevelBtn)
    const dirtyDialog = await screen.findByRole('alertdialog')
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120))
    })
    expect(writeCount).toBe(1)
    await user.click(within(dirtyDialog).getByRole('button', { name: /버리고 닫기/i }))
    await user.click(within(sidebar).getByText('other.md'))
    await waitFor(() => {
      expect(getRawEditorText(screen.getByTestId('document-editor'))).toBe('# Other')
    })

    // Auto-save must NOT fire on invalid mid-edit config.json
    await triggerMenuCommand(emitMenuCommand, 'toggle-settings')
    await user.click(screen.getByRole('button', { name: /설정 파일 직접 열기/i }))
    const configEditor = await screen.findByTestId('document-editor')
    setRawEditorText(configEditor, '{ invalid json')
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120))
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('waits for an in-flight save before completing 저장 후 이동 without dropping navigation', async () => {
    const user = userEvent.setup()
    let releaseFirstSave!: () => void
    let callNum = 0
    const nextFav = addFavoriteWorkspace(
      [],
      'C:/wiki/inflight-next',
      'inflight-next',
      '2026-11-14T00:00:00.000Z'
    )
    const { api, emitMenuCommand, getFilesSnapshot } = createInMemoryWikiApi(
      { autoSave: true, autoSaveDelayMs: 60, favoriteWorkspaces: nextFav },
      {
        selectedFolder: 'C:\\wiki\\inflight',
        workspaces: {
          'C:\\wiki\\inflight': {
            'a.md': '# A',
            'b.md': '# B'
          },
          'C:\\wiki\\inflight-next': {
            'next.md': '# Next'
          }
        }
      }
    )
    const origWrite = api.workspace.writeFile
    api.workspace.writeFile = async (filePath, content) => {
      callNum += 1
      if (callNum === 1) {
        return new Promise<void>((resolve) => {
          releaseFirstSave = () => {
            void origWrite(filePath, content).then(resolve)
          }
        })
      }
      return origWrite(filePath, content)
    }
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    const sidebar = screen.getByLabelText('워크스페이스 탐색기')

    await user.click(await within(sidebar).findByText('a.md'))
    const editor = await screen.findByTestId('document-editor')
    appendRawEditorText(editor, ' v1')

    // Wait for auto-save to enter in-flight state
    await waitFor(() => expect(callNum).toBe(1))
    // Type more while first save is still in flight, then switch workspace via Workspace View and choose 저장 후 이동
    appendRawEditorText(editor, ' v2')
    await clickActivityBarButton(user, '워크스페이스')
    const workspaceView = screen.getByRole('region', { name: '워크스페이스 뷰' })
    await user.click(within(workspaceView).getByRole('button', { name: /★\s*inflight-next/i }))
    const dirtyDialog = await screen.findByRole('alertdialog')
    await user.click(within(dirtyDialog).getByRole('button', { name: /저장 후 이동/i }))

    releaseFirstSave()
    const updatedSidebar = await screen.findByLabelText('워크스페이스 탐색기')
    expect(await within(updatedSidebar).findByText('next.md')).toBeInTheDocument()
    expect(getFilesSnapshot().get('C:/wiki/inflight/a.md')).toBe('# A v1 v2')
  })
})

describe('Folder tree context menu path copy', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
    vi.useRealTimers()
  })

  it('shows separated relative and absolute path copy items in folder tree context menu and copies formatted paths', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand, copiedTexts } = createInMemoryWikiApi(
      {},
      {
        selectedFolder: 'C:/wiki/notes',
        workspaces: {
          'C:/wiki/notes': {
            'guides/setup.md': '# Setup'
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')

    const sidebar = await screen.findByLabelText('워크스페이스 탐색기')
    const guidesNode = await within(sidebar).findByText('guides')

    fireEvent.contextMenu(guidesNode)
    const dirMenu = await screen.findByRole('menu')
    expect(
      within(dirMenu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent?.trim())
    ).toEqual(['새 파일', '새 폴더', '상대 경로 복사', '절대 경로 복사', '이름 변경 (F2)', '삭제'])
    expect(within(dirMenu).getAllByRole('separator')).toHaveLength(2)

    await user.click(within(dirMenu).getByRole('menuitem', { name: '상대 경로 복사' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(copiedTexts.at(-1)).toBe('guides')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    fireEvent.contextMenu(guidesNode)
    const dirMenu2 = await screen.findByRole('menu')
    await user.click(within(dirMenu2).getByRole('menuitem', { name: '절대 경로 복사' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(copiedTexts.at(-1)).toBe('C:\\wiki\\notes\\guides')

    await user.click(guidesNode)
    const setupFileNode = await within(sidebar).findByText('setup.md')

    fireEvent.contextMenu(setupFileNode)
    const fileMenu = await screen.findByRole('menu')
    expect(
      within(fileMenu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent?.trim())
    ).toEqual(['열기', '상대 경로 복사', '절대 경로 복사', '이름 변경 (F2)', '삭제'])
    expect(within(fileMenu).getAllByRole('separator')).toHaveLength(2)

    await user.click(within(fileMenu).getByRole('menuitem', { name: '상대 경로 복사' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(copiedTexts.at(-1)).toBe('guides/setup.md')

    fireEvent.contextMenu(setupFileNode)
    const fileMenu2 = await screen.findByRole('menu')
    await user.click(within(fileMenu2).getByRole('menuitem', { name: '절대 경로 복사' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(copiedTexts.at(-1)).toBe('C:\\wiki\\notes\\guides\\setup.md')
  })

  it('copies updated relative and absolute paths for nested entries immediately after renaming an expanded parent folder', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand, copiedTexts } = createInMemoryWikiApi(
      {},
      {
        selectedFolder: 'C:/wiki/notes',
        workspaces: {
          'C:/wiki/notes': {
            'guides/setup.md': '# Setup'
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')

    const sidebar = await screen.findByLabelText('워크스페이스 탐색기')
    const guidesNode = await within(sidebar).findByText('guides')
    await user.click(guidesNode)
    expect(await within(sidebar).findByText('setup.md')).toBeInTheDocument()

    const guidesTreeItem = within(sidebar).getByRole('treeitem', { name: 'guides' })
    guidesTreeItem.focus()
    fireEvent.keyDown(guidesTreeItem, { key: 'F2' })
    const renameInput = await within(sidebar).findByLabelText('새 이름 입력')
    await user.clear(renameInput)
    await user.type(renameInput, 'handbook{Enter}')

    expect(await within(sidebar).findByText('handbook')).toBeInTheDocument()
    const nestedSetup = within(sidebar).getByText('setup.md')

    fireEvent.contextMenu(nestedSetup)
    const menu1 = await screen.findByRole('menu')
    await user.click(within(menu1).getByRole('menuitem', { name: '상대 경로 복사' }))
    expect(copiedTexts.at(-1)).toBe('handbook/setup.md')

    fireEvent.contextMenu(nestedSetup)
    const menu2 = await screen.findByRole('menu')
    await user.click(within(menu2).getByRole('menuitem', { name: '절대 경로 복사' }))
    expect(copiedTexts.at(-1)).toBe('C:\\wiki\\notes\\handbook\\setup.md')
  })

  it('closes context menu and displays error banner when clipboard path copy fails', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      {},
      {
        selectedFolder: 'C:/wiki/notes',
        workspaces: {
          'C:/wiki/notes': {
            'guides/setup.md': '# Setup'
          }
        },
        clipboard: {
          async writeText() {
            throw new Error('클립보드 접근이 거부되었습니다.')
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')

    const sidebar = await screen.findByLabelText('워크스페이스 탐색기')
    const guidesNode = await within(sidebar).findByText('guides')

    fireEvent.contextMenu(guidesNode)
    const menu = await screen.findByRole('menu')
    await user.click(within(menu).getByRole('menuitem', { name: '상대 경로 복사' }))

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('클립보드 접근이 거부되었습니다.')
  })
})

describe('Folder tree multi-select and drag-and-drop move', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
    vi.useRealTimers()
  })

  function createTreeDataTransfer() {
    const store = new Map<string, string>()
    let dropEffect = 'none'
    let effectAllowed = 'none'
    return {
      get effectAllowed() {
        return effectAllowed
      },
      set effectAllowed(val: string) {
        effectAllowed = val
      },
      get dropEffect() {
        return dropEffect
      },
      set dropEffect(val: string) {
        dropEffect = val
      },
      get types() {
        return [...store.keys()]
      },
      files: [] as unknown as FileList,
      setData(type: string, value: string) {
        store.set(type, value)
      },
      getData(type: string) {
        return store.get(type) ?? ''
      }
    }
  }

  it('supports Ctrl/Cmd+click toggle, Shift+click visible range selection, multi-select context menu, F2 guard, and batch Delete', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand, copiedTexts, getFilesSnapshot } = createInMemoryWikiApi(
      {},
      {
        selectedFolder: 'C:/wiki/multi',
        workspaces: {
          'C:/wiki/multi': {
            'alpha/a1.md': '# A1',
            'alpha/a2.md': '# A2',
            'beta/b1.md': '# B1',
            'note-1.md': '# Note 1',
            'note-2.md': '# Note 2',
            'note-3.md': '# Note 3'
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')

    const explorer = await screen.findByLabelText('워크스페이스 탐색기')
    const alphaItem = await within(explorer).findByRole('treeitem', { name: 'alpha' })
    const betaItem = within(explorer).getByRole('treeitem', { name: 'beta' })
    const note1Item = within(explorer).getByRole('treeitem', { name: 'note-1.md' })
    const note2Item = within(explorer).getByRole('treeitem', { name: 'note-2.md' })
    const note3Item = within(explorer).getByRole('treeitem', { name: 'note-3.md' })

    // Normal click expands 'alpha' and selects only 'alpha'
    await user.click(within(alphaItem).getByText('alpha'))
    const a1Item = await within(explorer).findByRole('treeitem', { name: 'a1.md' })
    const a2Item = await within(explorer).findByRole('treeitem', { name: 'a2.md' })
    expect(alphaItem).toHaveAttribute('aria-selected', 'true')

    // Ctrl+click on collapsed 'beta' and 'note-2.md' toggles selection WITHOUT expanding beta or opening note-2.md
    fireEvent.click(within(betaItem).getByText('beta'), { ctrlKey: true })
    expect(betaItem).toHaveAttribute('aria-expanded', 'false')
    expect(alphaItem).toHaveAttribute('aria-selected', 'true')
    expect(betaItem).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()

    // Meta+click (macOS Cmd) also toggles selection
    fireEvent.click(within(note2Item).getByText('note-2.md'), { metaKey: true })
    expect(note2Item).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()

    // Ctrl+click again on 'alpha' deselects it
    fireEvent.click(within(alphaItem).getByText('alpha'), { ctrlKey: true })
    expect(alphaItem).toHaveAttribute('aria-selected', 'false')
    expect(alphaItem).toHaveAttribute('aria-expanded', 'true')

    // Normal click on 'a2.md' selects only 'a2.md' and opens tab
    await user.click(within(a2Item).getByText('a2.md'))
    expect(await screen.findByRole('tab', { name: /a2\.md/i })).toBeInTheDocument()
    expect(a2Item).toHaveAttribute('aria-selected', 'true')
    expect(betaItem).toHaveAttribute('aria-selected', 'false')
    expect(note2Item).toHaveAttribute('aria-selected', 'false')

    // Shift+click on 'note-2.md' selects visible range: a2.md, beta (collapsed, so b1.md skipped), note-1.md, note-2.md
    fireEvent.click(within(note2Item).getByText('note-2.md'), { shiftKey: true })
    expect(a1Item).toHaveAttribute('aria-selected', 'false')
    expect(a2Item).toHaveAttribute('aria-selected', 'true')
    expect(betaItem).toHaveAttribute('aria-selected', 'true')
    expect(note1Item).toHaveAttribute('aria-selected', 'true')
    expect(note2Item).toHaveAttribute('aria-selected', 'true')
    expect(note3Item).toHaveAttribute('aria-selected', 'false')
    expect(betaItem).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('tab', { name: /note-2\.md/i })).not.toBeInTheDocument()

    // F2 is ignored while 2+ entries are selected
    note2Item.focus()
    fireEvent.keyDown(note2Item, { key: 'F2' })
    expect(within(explorer).queryByLabelText('새 이름 입력')).not.toBeInTheDocument()

    // Right-click on already-selected item preserves multi-selection and disables single-only items
    fireEvent.contextMenu(within(note1Item).getByText('note-1.md'))
    const multiMenu = await screen.findByRole('menu')
    expect(within(multiMenu).getByRole('menuitem', { name: '열기' })).toBeDisabled()
    expect(within(multiMenu).getByRole('menuitem', { name: '이름 변경 (F2)' })).toBeDisabled()
    expect(within(multiMenu).getByRole('menuitem', { name: '상대 경로 복사' })).toBeEnabled()
    expect(within(multiMenu).getByRole('menuitem', { name: '절대 경로 복사' })).toBeEnabled()
    expect(within(multiMenu).getByRole('menuitem', { name: '삭제' })).toBeEnabled()

    // Multi-copy relative paths joins visible selected paths with newline
    await user.click(within(multiMenu).getByRole('menuitem', { name: '상대 경로 복사' }))
    expect(copiedTexts.at(-1)).toBe('alpha/a2.md\nbeta\nnote-1.md\nnote-2.md')

    // Multi-copy absolute paths joins formatted absolute paths with newline
    fireEvent.contextMenu(within(betaItem).getByText('beta'))
    const multiDirMenu = await screen.findByRole('menu')
    expect(within(multiDirMenu).getByRole('menuitem', { name: '새 파일' })).toBeDisabled()
    expect(within(multiDirMenu).getByRole('menuitem', { name: '새 폴더' })).toBeDisabled()
    expect(within(multiDirMenu).getByRole('menuitem', { name: '이름 변경 (F2)' })).toBeDisabled()
    await user.click(within(multiDirMenu).getByRole('menuitem', { name: '절대 경로 복사' }))
    expect(copiedTexts.at(-1)).toBe(
      [
        'C:\\wiki\\multi\\alpha\\a2.md',
        'C:\\wiki\\multi\\beta',
        'C:\\wiki\\multi\\note-1.md',
        'C:\\wiki\\multi\\note-2.md'
      ].join('\n')
    )

    // Right-click on unselected 'note-3.md' switches to single selection
    fireEvent.contextMenu(within(note3Item).getByText('note-3.md'))
    const singleMenu = await screen.findByRole('menu')
    expect(note3Item).toHaveAttribute('aria-selected', 'true')
    expect(note1Item).toHaveAttribute('aria-selected', 'false')
    expect(within(singleMenu).getByRole('menuitem', { name: '열기' })).toBeEnabled()
    expect(within(singleMenu).getByRole('menuitem', { name: '이름 변경 (F2)' })).toBeEnabled()
    fireEvent.keyDown(document, { key: 'Escape' })

    // Empty tree background click clears selection
    const treeEl = within(explorer).getByRole('tree')
    await user.click(treeEl)
    expect(note3Item).toHaveAttribute('aria-selected', 'false')

    // Multi-select a2.md, note-1.md, note-2.md, then Ctrl+click note-2.md to deselect it (focus moves to deselected note-2.md),
    // and press Delete -> deletes active selection [a2.md, note-1.md] and keeps deselected note-2.md
    await user.click(within(a2Item).getByText('a2.md'))
    fireEvent.click(within(note1Item).getByText('note-1.md'), { ctrlKey: true })
    fireEvent.click(within(note2Item).getByText('note-2.md'), { ctrlKey: true })
    fireEvent.click(within(note2Item).getByText('note-2.md'), { ctrlKey: true })
    expect(note2Item).toHaveAttribute('aria-selected', 'false')
    note2Item.focus()
    fireEvent.keyDown(note2Item, { key: 'Delete' })

    const deleteDialog = await screen.findByRole('alertdialog')
    expect(deleteDialog).toHaveTextContent('선택한 2개 항목을 삭제하시겠습니까?')
    await user.click(within(deleteDialog).getByRole('button', { name: /삭제 확인/i }))

    await waitFor(() => {
      expect(within(explorer).queryByRole('treeitem', { name: 'a2.md' })).not.toBeInTheDocument()
      expect(within(explorer).queryByRole('treeitem', { name: 'note-1.md' })).not.toBeInTheDocument()
    })
    expect(within(explorer).getByRole('treeitem', { name: 'note-2.md' })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /a2\.md/i })).not.toBeInTheDocument()
    expect(getFilesSnapshot().has('C:/wiki/multi/alpha/a2.md')).toBe(false)
    expect(getFilesSnapshot().has('C:/wiki/multi/note-1.md')).toBe(false)
    expect(getFilesSnapshot().has('C:/wiki/multi/note-2.md')).toBe(true)
  })

  it('moves single/multi entries via drag-and-drop onto folder rows, file parent folders, and tree root, updates open tabs, auto-expands after 500ms, handles conflicts all-or-nothing, and drops multiple images into editor', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand, getFilesSnapshot } = createInMemoryWikiApi(
      {},
      {
        selectedFolder: 'C:/wiki/dnd',
        workspaces: {
          'C:/wiki/dnd': {
            'dest/existing.md': '# Existing in dest',
            'dest/nested/deep.md': '# Deep',
            'src/doc.md': '# Doc',
            'src/pic1.png': '<png1>',
            'src/pic2.webp': '<webp2>',
            'conflict/existing.md': '# Conflicting',
            'conflict/clean.md': '# Clean',
            'root-note.md': '# Root Note'
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')

    const explorer = await screen.findByLabelText('워크스페이스 탐색기')
    const treeEl = within(explorer).getByRole('tree')
    const srcFolder = await within(explorer).findByRole('treeitem', { name: 'src' })
    const destFolder = within(explorer).getByRole('treeitem', { name: 'dest' })
    const conflictFolder = within(explorer).getByRole('treeitem', { name: 'conflict' })
    const rootNoteItem = within(explorer).getByRole('treeitem', { name: 'root-note.md' })

    // Open src/doc.md in editor before moving it
    await user.click(within(srcFolder).getByText('src'))
    const docItem = await within(explorer).findByRole('treeitem', { name: 'doc.md' })
    const pic1Item = within(explorer).getByRole('treeitem', { name: 'pic1.png' })
    const pic2Item = within(explorer).getByRole('treeitem', { name: 'pic2.webp' })
    await user.click(within(docItem).getByText('doc.md'))
    const rawEditor = await screen.findByTestId('document-editor')

    // Dragging 'src' folder over itself must NOT highlight as a valid target
    const dtSelfFolder = createTreeDataTransfer()
    fireEvent.dragStart(srcFolder, { dataTransfer: dtSelfFolder })
    fireEvent.dragOver(srcFolder, { dataTransfer: dtSelfFolder })
    expect(srcFolder.querySelector('.tree-row')).not.toHaveClass('is-drop-target')
    fireEvent.dragEnd(srcFolder, { dataTransfer: dtSelfFolder })

    // Dragging only 'src/doc.md' over its own parent 'src' must NOT highlight (no-op)
    await user.click(within(docItem).getByText('doc.md'))
    const dtSameParent = createTreeDataTransfer()
    fireEvent.dragStart(docItem, { dataTransfer: dtSameParent })
    fireEvent.dragOver(srcFolder, { dataTransfer: dtSameParent })
    expect(srcFolder.querySelector('.tree-row')).not.toHaveClass('is-drop-target')
    fireEvent.dragEnd(docItem, { dataTransfer: dtSameParent })

    // 1. Multi-select doc.md + root-note.md and drag onto collapsed dest folder -> highlight & move
    await user.click(within(docItem).getByText('doc.md'))
    fireEvent.click(within(rootNoteItem).getByText('root-note.md'), { ctrlKey: true })
    const dtMove = createTreeDataTransfer()
    fireEvent.dragStart(docItem, { dataTransfer: dtMove })
    fireEvent.dragOver(destFolder, { dataTransfer: dtMove })
    expect(destFolder.querySelector('.tree-row')).toHaveClass('is-drop-target')
    expect(destFolder.querySelector('.tree-row')).toHaveAttribute('data-drop-target', 'true')
    expect(dtMove.dropEffect).toBe('move')
    fireEvent.drop(destFolder, { dataTransfer: dtMove })
    fireEvent.dragEnd(docItem, { dataTransfer: dtMove })

    await waitFor(() => {
      expect(getFilesSnapshot().has('C:/wiki/dnd/dest/doc.md')).toBe(true)
      expect(getFilesSnapshot().has('C:/wiki/dnd/dest/root-note.md')).toBe(true)
    })
    expect(getFilesSnapshot().has('C:/wiki/dnd/src/doc.md')).toBe(false)
    expect(getFilesSnapshot().has('C:/wiki/dnd/root-note.md')).toBe(false)

    // Verify open doc.md buffer/tab path synced to new location
    expect(screen.getByText('C:/wiki/dnd/dest/doc.md')).toBeInTheDocument()

    // 2. Hovering collapsed 'dest' folder with dragged 'pic1.png' auto-expands after 500ms
    fireEvent.click(within(pic1Item).getByText('pic1.png'), { ctrlKey: true })
    // Select pic1.png alone via Ctrl+click toggle or drag directly without opening image preview tab
    await user.click(treeEl)
    fireEvent.click(within(pic1Item).getByText('pic1.png'), { ctrlKey: true })
    vi.useFakeTimers()
    try {
      const dtAutoExpand = createTreeDataTransfer()
      fireEvent.dragStart(pic1Item, { dataTransfer: dtAutoExpand })
      fireEvent.dragOver(destFolder, { dataTransfer: dtAutoExpand })
      expect(destFolder).toHaveAttribute('aria-expanded', 'false')

      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })
      expect(destFolder).toHaveAttribute('aria-expanded', 'true')
      fireEvent.dragEnd(pic1Item, { dataTransfer: dtAutoExpand })
    } finally {
      vi.useRealTimers()
    }

    // 3. Dropping onto a file row inside 'dest' ('dest/existing.md') moves into 'dest',
    // and dropping onto empty tree area moves back to workspace root
    const movedDocItem = await within(destFolder).findByRole('treeitem', { name: 'doc.md' })
    const destExistingItem = within(destFolder).getByRole('treeitem', { name: 'existing.md' })

    const dtToFileParent = createTreeDataTransfer()
    fireEvent.dragStart(pic1Item, { dataTransfer: dtToFileParent })
    fireEvent.dragOver(destExistingItem, { dataTransfer: dtToFileParent })
    expect(destFolder.querySelector('.tree-row')).toHaveClass('is-drop-target')
    fireEvent.drop(destExistingItem, { dataTransfer: dtToFileParent })
    fireEvent.dragEnd(pic1Item, { dataTransfer: dtToFileParent })
    await waitFor(() => {
      expect(getFilesSnapshot().has('C:/wiki/dnd/dest/pic1.png')).toBe(true)
    })

    // Move movedDocItem back to workspace root by dropping on ul.folder-tree
    const dtToRoot = createTreeDataTransfer()
    fireEvent.dragStart(movedDocItem, { dataTransfer: dtToRoot })
    fireEvent.dragOver(treeEl, { dataTransfer: dtToRoot })
    expect(treeEl).toHaveClass('is-root-drop-target')
    expect(treeEl).toHaveAttribute('data-drop-target', 'root')
    fireEvent.drop(treeEl, { dataTransfer: dtToRoot })
    fireEvent.dragEnd(movedDocItem, { dataTransfer: dtToRoot })
    await waitFor(() => {
      expect(getFilesSnapshot().has('C:/wiki/dnd/doc.md')).toBe(true)
    })
    expect(screen.getByText('C:/wiki/dnd/doc.md')).toBeInTheDocument()

    // 4. All-or-Nothing conflict check when moving multiple items into 'dest' where 'existing.md' collides
    await user.click(within(conflictFolder).getByText('conflict'))
    const conflictExistingInConflict = await within(conflictFolder).findByRole('treeitem', {
      name: 'existing.md'
    })
    const conflictClean = within(conflictFolder).getByRole('treeitem', { name: 'clean.md' })
    await user.click(treeEl)
    fireEvent.click(within(conflictExistingInConflict).getByText('existing.md'), { ctrlKey: true })
    fireEvent.click(within(conflictClean).getByText('clean.md'), { ctrlKey: true })

    const dtConflict = createTreeDataTransfer()
    fireEvent.dragStart(conflictExistingInConflict, { dataTransfer: dtConflict })
    fireEvent.dragOver(destFolder, { dataTransfer: dtConflict })
    fireEvent.drop(destFolder, { dataTransfer: dtConflict })
    fireEvent.dragEnd(conflictExistingInConflict, { dataTransfer: dtConflict })

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/이미 존재/)
    expect(getFilesSnapshot().has('C:/wiki/dnd/conflict/clean.md')).toBe(true)
    expect(getFilesSnapshot().has('C:/wiki/dnd/dest/clean.md')).toBe(false)
    expect(conflictExistingInConflict).toBeInTheDocument()

    // 5. Multi-selecting multiple images (pic1.png in dest + pic2.webp in src) and dropping into Raw editor inserts all images
    const movedPic1 = within(destFolder).getByRole('treeitem', { name: 'pic1.png' })
    await user.click(treeEl)
    fireEvent.click(within(movedPic1).getByText('pic1.png'), { ctrlKey: true })
    fireEvent.click(within(pic2Item).getByText('pic2.webp'), { ctrlKey: true })

    const dtImages = createTreeDataTransfer()
    fireEvent.dragStart(movedPic1, { dataTransfer: dtImages })
    fireEvent.drop(rawEditor, { dataTransfer: dtImages })
    fireEvent.dragEnd(movedPic1, { dataTransfer: dtImages })

    await waitFor(() => {
      const text = getRawEditorText(rawEditor)
      expect(text).toContain('![pic1](./dest/pic1.png)')
      expect(text).toContain('![pic2](./src/pic2.webp)')
    })
  })

  it('includes drop target highlight styles in theme.css', () => {
    expect(themeCss).toContain('.tree-row.is-drop-target')
    expect(themeCss).toContain('.folder-tree.is-root-drop-target')
  })
})

describe('Workspace state persistence, folder tree restore, and same-workspace reselection', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
    vi.useRealTimers()
  })

  it('keeps open tabs, unsaved buffers, and expanded folder tree intact when reselecting the active workspace from Workspace View or open-folder', async () => {
    const user = userEvent.setup()
    const favoriteAlpha = addFavoriteWorkspace(
      [],
      'C:/wiki/alpha',
      'alpha',
      '2026-11-14T00:00:00.000Z'
    )
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      {
        autoSave: false,
        favoriteWorkspaces: favoriteAlpha,
        recentWorkspaces: ['C:/wiki/alpha']
      },
      {
        selectedFolder: 'c:\\wiki\\alpha\\',
        workspaces: {
          'C:\\wiki\\alpha': {
            'alpha.md': '# Alpha',
            'docs/sub.md': '# Sub'
          }
        }
      }
    )
    const openSpy = vi.spyOn(api.workspace, 'open')
    const clearSpy = vi.spyOn(api.buffer, 'clearWorkspaceBuffers')
    window.wikiApi = api

    render(<App />)

    const explorer = await screen.findByLabelText('워크스페이스 탐색기')
    expect(await within(explorer).findByText('alpha.md')).toBeInTheDocument()
    expect(openSpy).toHaveBeenCalledTimes(1)

    // Expand docs folder, open both files, and make a dirty edit in alpha.md
    await user.click(within(explorer).getByText('docs'))
    expect(await within(explorer).findByText('sub.md')).toBeInTheDocument()
    await user.click(within(explorer).getByText('sub.md'))
    await user.click(within(explorer).getByText('alpha.md'))
    appendRawEditorText(await screen.findByTestId('document-editor'), ' unsaved')
    expect(screen.getByTestId('dirty-indicator')).toBeInTheDocument()

    // 1. Reselect active workspace from Recent list in Workspace View
    await clickActivityBarButton(user, '워크스페이스')
    const workspaceView1 = screen.getByRole('region', { name: '워크스페이스 뷰' })
    await user.click(within(workspaceView1).getByRole('button', { name: /^alpha$/i }))

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    const explorerAfterRecent = await screen.findByLabelText('워크스페이스 탐색기')
    expect(within(explorerAfterRecent).getByText('sub.md')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /alpha\.md/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /sub\.md/ })).toBeInTheDocument()
    expect(getRawEditorText(screen.getByTestId('document-editor'))).toBe('# Alpha unsaved')
    expect(openSpy).toHaveBeenCalledTimes(1)
    expect(clearSpy).not.toHaveBeenCalled()

    // 2. Reselect active workspace from Favorites list in Workspace View
    await clickActivityBarButton(user, '워크스페이스')
    const workspaceView2 = screen.getByRole('region', { name: '워크스페이스 뷰' })
    await user.click(within(workspaceView2).getByRole('button', { name: /★\s*alpha/i }))

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    const explorerAfterFav = await screen.findByLabelText('워크스페이스 탐색기')
    expect(within(explorerAfterFav).getByText('sub.md')).toBeInTheDocument()
    expect(getRawEditorText(screen.getByTestId('document-editor'))).toBe('# Alpha unsaved')
    expect(openSpy).toHaveBeenCalledTimes(1)
    expect(clearSpy).not.toHaveBeenCalled()

    // 3. Reselect active workspace via '폴더 열기...' button in Workspace View (case/slash variant)
    await clickActivityBarButton(user, '워크스페이스')
    const workspaceView3 = screen.getByRole('region', { name: '워크스페이스 뷰' })
    await user.click(within(workspaceView3).getByRole('button', { name: '폴더 열기...' }))

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    const explorerAfterOpenBtn = await screen.findByLabelText('워크스페이스 탐색기')
    expect(within(explorerAfterOpenBtn).getByText('sub.md')).toBeInTheDocument()
    expect(getRawEditorText(screen.getByTestId('document-editor'))).toBe('# Alpha unsaved')
    expect(openSpy).toHaveBeenCalledTimes(1)
    expect(clearSpy).not.toHaveBeenCalled()

    // 4. Reselect active workspace via menu 'open-folder' while in Git View -> stays in Git View without prompt or reset
    await clickActivityBarButton(user, 'Git')
    expect(screen.getByRole('region', { name: 'Git 소스 제어' })).toBeInTheDocument()
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Git 소스 제어' })).toBeInTheDocument()
    expect(getRawEditorText(screen.getByTestId('document-editor'))).toBe('# Alpha unsaved')
    expect(openSpy).toHaveBeenCalledTimes(1)
    expect(clearSpy).not.toHaveBeenCalled()
  })

  it('restores persisted expandedDirs with nested children on startup and across workspace switches', async () => {
    const user = userEvent.setup()
    const { api } = createInMemoryWikiApi(
      {
        recentWorkspaces: ['C:/wiki/alpha', 'C:/wiki/beta']
      },
      {
        workspaces: {
          'C:\\wiki\\alpha': {
            'docs/sub/deep.md': '# Deep',
            'collapsed/hidden.md': '# Hidden',
            'alpha.md': '# Alpha'
          },
          'C:\\wiki\\beta': {
            'guides/guide.md': '# Guide',
            'beta.md': '# Beta'
          }
        },
        workspaceStates: {
          'C:\\wiki\\alpha': {
            expandedDirs: ['C:\\wiki\\alpha\\docs', 'C:\\wiki\\alpha\\docs\\sub']
          },
          'C:\\wiki\\beta': {
            expandedDirs: ['C:\\wiki\\beta\\guides']
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)

    const explorer = await screen.findByLabelText('워크스페이스 탐색기')
    expect(await within(explorer).findByText('deep.md')).toBeInTheDocument()
    expect(within(explorer).getByRole('treeitem', { name: 'docs' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(within(explorer).getByRole('treeitem', { name: 'sub' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(within(explorer).getByRole('treeitem', { name: 'collapsed' })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    expect(within(explorer).queryByText('hidden.md')).not.toBeInTheDocument()

    // Switch to beta -> beta's expandedDirs restore independently
    await clickActivityBarButton(user, '워크스페이스')
    await user.click(
      within(screen.getByRole('region', { name: '워크스페이스 뷰' })).getByRole('button', {
        name: /^beta$/i
      })
    )

    const betaExplorer = await screen.findByLabelText('워크스페이스 탐색기')
    expect(await within(betaExplorer).findByText('guide.md')).toBeInTheDocument()
    expect(within(betaExplorer).getByRole('treeitem', { name: 'guides' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(within(betaExplorer).queryByText('deep.md')).not.toBeInTheDocument()

    // Switch back to alpha -> alpha's expandedDirs restore again
    await clickActivityBarButton(user, '워크스페이스')
    await user.click(
      within(screen.getByRole('region', { name: '워크스페이스 뷰' })).getByRole('button', {
        name: /^alpha$/i
      })
    )

    const alphaExplorerAgain = await screen.findByLabelText('워크스페이스 탐색기')
    expect(await within(alphaExplorerAgain).findByText('deep.md')).toBeInTheDocument()
  })

  it('silently skips missing or outside-root expandedDirs without error banner and ignores stale restore on rapid switch', async () => {
    const user = userEvent.setup()
    const { api, readDirCalls } = createInMemoryWikiApi(
      {
        recentWorkspaces: ['C:/wiki/alpha', 'C:/wiki/beta', 'C:/wiki/gamma']
      },
      {
        workspaces: {
          'C:\\wiki\\alpha': {
            'docs/intro.md': '# Intro',
            'alpha.md': '# Alpha'
          },
          'C:\\wiki\\beta': {
            'beta-dir/beta.md': '# Beta'
          },
          'C:\\wiki\\gamma': {
            'gamma-dir/gamma.md': '# Gamma'
          }
        },
        workspaceStates: {
          'C:\\wiki\\beta': {
            expandedDirs: ['C:\\wiki\\beta\\beta-dir']
          },
          'C:\\wiki\\gamma': {
            expandedDirs: ['C:\\wiki\\gamma\\gamma-dir']
          }
        }
      }
    )
    const defaultGetState = api.workspaceState!.get.bind(api.workspaceState)
    let resolveDelayedBetaState!: (
      value: Awaited<ReturnType<NonNullable<typeof api.workspaceState>['get']>>
    ) => void
    const delayedBetaStatePromise = new Promise<
      Awaited<ReturnType<NonNullable<typeof api.workspaceState>['get']>>
    >((resolve) => {
      resolveDelayedBetaState = resolve
    })
    let getStateCallCount = 0
    vi.spyOn(api.workspaceState!, 'get').mockImplementation(async (rootPath) => {
      getStateCallCount += 1
      if (rootPath.toLowerCase().includes('alpha')) {
        return {
          rootPath: 'C:\\wiki\\alpha',
          updatedAt: '2026-11-18T00:00:00.000Z',
          expandedDirs: [
            'C:\\wiki\\alpha\\docs',
            'C:\\wiki\\alpha\\deleted-dir',
            'C:\\outside-secret',
            'C:\\wiki\\alpha\\..\\escape-dir'
          ],
          layout: {
            splitMode: 'single',
            splitRatio: 0.5,
            activePaneId: 'primary',
            panes: {
              primary: { tabs: [], activeTabPath: null },
              secondary: { tabs: [], activeTabPath: null }
            }
          }
        }
      }
      if (rootPath.toLowerCase().includes('beta') && getStateCallCount === 2) {
        return await delayedBetaStatePromise
      }
      return await defaultGetState(rootPath)
    })
    window.wikiApi = api

    render(<App />)

    const explorer = await screen.findByLabelText('워크스페이스 탐색기')
    expect(await within(explorer).findByText('intro.md')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(readDirCalls.some((path) => path.toLowerCase().includes('outside-secret'))).toBe(false)
    expect(readDirCalls.some((path) => path.toLowerCase().includes('escape-dir'))).toBe(false)

    // Rapid switch: start switching to beta (deferred state lookup), immediately switch to gamma
    await clickActivityBarButton(user, '워크스페이스')
    const wsView = screen.getByRole('region', { name: '워크스페이스 뷰' })
    await user.click(within(wsView).getByRole('button', { name: /^beta$/i }))
    await waitFor(() => {
      expect(getStateCallCount).toBe(2)
    })

    await user.click(within(wsView).getByRole('button', { name: /^gamma$/i }))

    const gammaExplorer = await screen.findByLabelText('워크스페이스 탐색기')
    expect(await within(gammaExplorer).findByText('gamma.md')).toBeInTheDocument()

    // Resolving stale beta restore afterwards must not overwrite gamma
    const realBetaState = await defaultGetState('C:/wiki/beta')
    await act(async () => {
      resolveDelayedBetaState(realBetaState)
    })

    expect(within(gammaExplorer).getByText('gamma.md')).toBeInTheDocument()
    expect(within(gammaExplorer).queryByText('beta.md')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('persists expandedDirs on expand, collapse, rename, drag-and-drop move, delete, immediate workspace switch, and app restart', async () => {
    const user = userEvent.setup()
    const createDnDTransfer = () => {
      const store = new Map<string, string>()
      return {
        effectAllowed: 'none',
        dropEffect: 'none',
        get types() {
          return [...store.keys()]
        },
        files: [] as unknown as FileList,
        setData(type: string, value: string) {
          store.set(type, value)
        },
        getData(type: string) {
          return store.get(type) ?? ''
        }
      }
    }

    const { api } = createInMemoryWikiApi(
      {
        recentWorkspaces: ['C:/wiki/alpha', 'C:/wiki/beta']
      },
      {
        workspaces: {
          'C:\\wiki\\alpha': {
            'docs/sub/leaf.md': '# Leaf',
            'archive/keep.md': '# Keep',
            'temp/gone.md': '# Gone',
            'extra/note.md': '# Note',
            'alpha.md': '# Alpha'
          },
          'C:\\wiki\\beta': {
            'beta.md': '# Beta'
          }
        }
      }
    )
    window.wikiApi = api

    const firstMount = render(<App />)
    const explorer = await screen.findByLabelText('워크스페이스 탐색기')
    expect(await within(explorer).findByText('alpha.md')).toBeInTheDocument()

    // Expand docs -> docs/sub -> temp -> archive, then collapse archive
    await user.click(within(explorer).getByText('docs'))
    expect(await within(explorer).findByText('sub')).toBeInTheDocument()
    await user.click(within(explorer).getByText('sub'))
    expect(await within(explorer).findByText('leaf.md')).toBeInTheDocument()
    await user.click(within(explorer).getByText('temp'))
    expect(await within(explorer).findByText('gone.md')).toBeInTheDocument()
    await user.click(within(explorer).getByText('archive'))
    expect(await within(explorer).findByText('keep.md')).toBeInTheDocument()
    await user.click(within(explorer).getByText('archive'))
    expect(within(explorer).queryByText('keep.md')).not.toBeInTheDocument()

    // Rename docs -> guides via F2
    const docsItem = within(explorer).getByRole('treeitem', { name: 'docs' })
    docsItem.focus()
    fireEvent.keyDown(docsItem, { key: 'F2' })
    const renameInput = await within(explorer).findByLabelText('새 이름 입력')
    await user.clear(renameInput)
    await user.type(renameInput, 'guides{Enter}')
    const guidesItem = await within(explorer).findByRole('treeitem', { name: 'guides' })
    expect(within(explorer).getByText('leaf.md')).toBeInTheDocument()

    // Move guides into archive via drag-and-drop and expand archive
    const archiveItem = within(explorer).getByRole('treeitem', { name: 'archive' })
    const dtMove = createDnDTransfer()
    fireEvent.dragStart(guidesItem, { dataTransfer: dtMove })
    fireEvent.dragOver(archiveItem, { dataTransfer: dtMove })
    fireEvent.drop(archiveItem, { dataTransfer: dtMove })
    fireEvent.dragEnd(guidesItem, { dataTransfer: dtMove })

    await waitFor(() => {
      expect(within(archiveItem).queryByText('guides')).toBeNull()
    })
    await user.click(within(explorer).getByText('archive'))
    expect(await within(explorer).findByText('leaf.md')).toBeInTheDocument()

    // Delete temp folder via context menu -> confirm
    fireEvent.contextMenu(within(explorer).getByText('temp'))
    const menu = await screen.findByRole('menu')
    await user.click(within(menu).getByRole('menuitem', { name: /삭제/i }))
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: /삭제 확인/i }))
    await waitFor(() => {
      expect(within(explorer).queryByText('temp')).not.toBeInTheDocument()
    })

    // Immediately switch to beta before 250ms debounce fires -> alpha's state flushes immediately
    await clickActivityBarButton(user, '워크스페이스')
    await user.click(
      within(screen.getByRole('region', { name: '워크스페이스 뷰' })).getByRole('button', {
        name: /^beta$/i
      })
    )
    const betaExplorer = await screen.findByLabelText('워크스페이스 탐색기')
    expect(await within(betaExplorer).findByText('beta.md')).toBeInTheDocument()

    const savedAlpha = await api.workspaceState!.get('C:/wiki/alpha')
    expect(savedAlpha?.expandedDirs).toEqual([
      'C:\\wiki\\alpha\\archive\\guides',
      'C:\\wiki\\alpha\\archive\\guides\\sub',
      'C:\\wiki\\alpha\\archive'
    ])

    // Switch back to alpha -> archive/guides/sub restored expanded
    await clickActivityBarButton(user, '워크스페이스')
    await user.click(
      within(screen.getByRole('region', { name: '워크스페이스 뷰' })).getByRole('button', {
        name: /^alpha$/i
      })
    )
    const alphaRestored = await screen.findByLabelText('워크스페이스 탐색기')
    expect(await within(alphaRestored).findByText('leaf.md')).toBeInTheDocument()

    // Expand extra and unmount immediately -> flushed on unmount and restored on next mount
    await user.click(within(alphaRestored).getByText('extra'))
    expect(await within(alphaRestored).findByText('note.md')).toBeInTheDocument()
    firstMount.unmount()

    render(<App />)
    const restartedExplorer = await screen.findByLabelText('워크스페이스 탐색기')
    expect(await within(restartedExplorer).findByText('leaf.md')).toBeInTheDocument()
    expect(within(restartedExplorer).getByText('note.md')).toBeInTheDocument()
  })

  it('debounces expandedDirs persistence and resumes tracking when switching to a failing workspace', async () => {
    const user = userEvent.setup()
    const { api } = createInMemoryWikiApi(
      {
        recentWorkspaces: ['C:/wiki/alpha', 'C:/wiki/beta', 'C:/wiki/broken-ws']
      },
      {
        workspaces: {
          'C:\\wiki\\alpha': {
            'docs/sub/leaf.md': '# Leaf',
            'alpha.md': '# Alpha'
          },
          'C:\\wiki\\beta': {
            'beta.md': '# Beta'
          }
        }
      }
    )
    const defaultOpen = api.workspace.open.bind(api.workspace)
    api.workspace.open = async (rootPath) => {
      if (rootPath.replace(/\\/g, '/') === 'C:/wiki/broken-ws') {
        throw new Error('Workspace open failed')
      }
      return defaultOpen(rootPath)
    }
    const saveSpy = vi.spyOn(api.workspaceState!, 'save')
    window.wikiApi = api

    render(<App />)
    const explorer = await screen.findByLabelText('워크스페이스 탐색기')
    expect(await within(explorer).findByText('alpha.md')).toBeInTheDocument()

    await user.click(within(explorer).getByText('docs'))
    expect(await within(explorer).findByText('sub')).toBeInTheDocument()
    // Debounced: not saved immediately upon click, saved after debounce delay
    expect(saveSpy).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(saveSpy).toHaveBeenCalledTimes(1)
    })

    // Attempt switching to failing workspace -> error banner shown, alpha stays active
    await clickActivityBarButton(user, '워크스페이스')
    await user.click(
      within(screen.getByRole('region', { name: '워크스페이스 뷰' })).getByRole('button', {
        name: /^broken-ws$/i
      })
    )
    expect(await screen.findByRole('alert')).toHaveTextContent('Workspace open failed')

    // Return to Explorer, expand sub, switch to beta -> sub expansion is still tracked & persisted
    await clickActivityBarButton(user, '탐색기')
    const resumedExplorer = await screen.findByLabelText('워크스페이스 탐색기')
    await user.click(within(resumedExplorer).getByText('sub'))
    expect(await within(resumedExplorer).findByText('leaf.md')).toBeInTheDocument()

    await clickActivityBarButton(user, '워크스페이스')
    await user.click(
      within(screen.getByRole('region', { name: '워크스페이스 뷰' })).getByRole('button', {
        name: /^beta$/i
      })
    )
    expect(await within(await screen.findByLabelText('워크스페이스 탐색기')).findByText('beta.md')).toBeInTheDocument()

    const savedAlpha = await api.workspaceState!.get('C:/wiki/alpha')
    expect(savedAlpha?.expandedDirs).toEqual([
      'C:\\wiki\\alpha\\docs',
      'C:\\wiki\\alpha\\docs\\sub'
    ])
  })

  it('persists and restores pane layout, tab order, active tabs, split mode, splitRatio, and activePaneId across workspace switches and app restart', async () => {
    const user = userEvent.setup()
    const { api } = createInMemoryWikiApi(
      {
        recentWorkspaces: ['C:/wiki/alpha', 'C:/wiki/beta']
      },
      {
        workspaces: {
          'C:\\wiki\\alpha': {
            'one.md': '# One',
            'two.md': '# Two',
            'three.md': '# Three',
            'four.md': '# Four'
          },
          'C:\\wiki\\beta': {
            'b1.md': '# Beta 1',
            'b2.md': '# Beta 2'
          }
        }
      }
    )
    window.wikiApi = api

    const firstMount = render(<App />)
    const explorer = await screen.findByLabelText('워크스페이스 탐색기')
    await user.click(await within(explorer).findByText('one.md'))
    await user.click(within(explorer).getByText('two.md'))
    await user.click(within(explorer).getByText('three.md'))
    await user.click(within(explorer).getByText('four.md'))

    const primaryPane = screen.getByTestId('pane-primary')
    // Close four.md, reorder three.md before two.md, and split vertically with two.md into secondary
    await user.click(within(primaryPane).getByRole('button', { name: 'four.md 탭 닫기' }))
    const threeTabItem = within(primaryPane).getByRole('tab', { name: /three\.md/ }).closest('.tab-item')!
    const twoTabItem = within(primaryPane).getByRole('tab', { name: /two\.md/ }).closest('.tab-item')!
    fireEvent.dragStart(threeTabItem)
    fireEvent.drop(twoTabItem)
    fireEvent.dragEnd(threeTabItem)

    expect(
      within(primaryPane)
        .getAllByRole('tab')
        .map((tab) => tab.textContent?.trim())
    ).toEqual(['one.md', 'three.md', 'two.md'])

    const twoTabTrigger = within(primaryPane).getByRole('tab', { name: /two\.md/ })
    fireEvent.dragStart(twoTabTrigger)
    fireEvent.drop(screen.getByTestId('split-drop-zone-vertical'))

    const secondaryPane = await screen.findByTestId('pane-secondary')
    expect(screen.getByTestId('pane-workspace')).toHaveAttribute('data-split-mode', 'vertical')

    // Adjust splitter ratio via keyboard (ArrowDown 3x from 50% -> 65%)
    const splitter = screen.getByRole('separator', { name: '화면 분할 크기 조절' })
    fireEvent.keyDown(splitter, { key: 'ArrowDown' })
    fireEvent.keyDown(splitter, { key: 'ArrowDown' })
    fireEvent.keyDown(splitter, { key: 'ArrowDown' })
    expect(splitter).toHaveAttribute('aria-valuenow', '65')

    // Activate three.md in primary, then activate secondary pane and open two.md there
    await user.click(within(primaryPane).getByRole('tab', { name: /three\.md/ }))
    fireEvent.mouseDown(secondaryPane)
    expect(secondaryPane).toHaveClass('is-active-pane')

    // Immediately switch to beta before debounce -> alpha layout must be preserved intact (not overwritten with empty)
    await switchWorkspaceFromView(user, /^beta$/i)

    const betaExplorer = await screen.findByLabelText('워크스페이스 탐색기')
    expect(await within(betaExplorer).findByText('b1.md')).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /one\.md/ })).not.toBeInTheDocument()
    expect(screen.queryByTestId('pane-secondary')).not.toBeInTheDocument()

    // Open b1.md and b2.md in horizontal split in beta
    await user.click(within(betaExplorer).getByText('b1.md'))
    await user.click(within(betaExplorer).getByText('b2.md'))
    fireEvent.contextMenu(within(screen.getByTestId('pane-primary')).getByRole('tab', { name: /b2\.md/ }))
    await user.click(
      within(await screen.findByRole('menu', { name: '탭 작업 메뉴' })).getByRole('menuitem', {
        name: '분할 영역으로 이동'
      })
    )
    expect(screen.getByTestId('pane-workspace')).toHaveAttribute('data-split-mode', 'horizontal')

    // Switch back to alpha -> alpha's vertical split, 65% ratio, tab order, active tabs, and activePaneId restore!
    await switchWorkspaceFromView(user, /^alpha$/i)

    await waitFor(() => {
      expect(screen.getByTestId('pane-workspace')).toHaveAttribute('data-split-mode', 'vertical')
    })
    const restoredPrimary = screen.getByTestId('pane-primary')
    const restoredSecondary = screen.getByTestId('pane-secondary')
    expect(
      within(restoredPrimary)
        .getAllByRole('tab')
        .map((tab) => tab.textContent?.trim())
    ).toEqual(['one.md', 'three.md'])
    expect(within(restoredPrimary).getByRole('tab', { name: /three\.md/ })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(
      within(restoredSecondary)
        .getAllByRole('tab')
        .map((tab) => tab.textContent?.trim())
    ).toEqual(['two.md'])
    expect(restoredSecondary).toHaveClass('is-active-pane')
    expect(screen.getByRole('separator', { name: '화면 분할 크기 조절' })).toHaveAttribute(
      'aria-valuenow',
      '65'
    )

    // Unmount and remount <App /> (app restart) -> alpha layout restores again, and switching to beta restores beta's horizontal layout
    firstMount.unmount()
    render(<App />)

    await waitFor(() => {
      expect(screen.getByTestId('pane-workspace')).toHaveAttribute('data-split-mode', 'vertical')
      expect(
        within(screen.getByTestId('pane-primary'))
          .getAllByRole('tab')
          .map((tab) => tab.textContent?.trim())
      ).toEqual(['one.md', 'three.md'])
    })
    expect(screen.getByTestId('pane-secondary')).toHaveClass('is-active-pane')
    expect(screen.getByRole('separator', { name: '화면 분할 크기 조절' })).toHaveAttribute(
      'aria-valuenow',
      '65'
    )

    await switchWorkspaceFromView(user, /^beta$/i)
    await waitFor(() => {
      expect(screen.getByTestId('pane-workspace')).toHaveAttribute('data-split-mode', 'horizontal')
      expect(
        within(screen.getByTestId('pane-primary'))
          .getAllByRole('tab')
          .map((tab) => tab.textContent?.trim())
      ).toEqual(['b1.md'])
      expect(
        within(screen.getByTestId('pane-secondary'))
          .getAllByRole('tab')
          .map((tab) => tab.textContent?.trim())
      ).toEqual(['b2.md'])
    })
  }, 15_000)

  it('persists and restores per-tab mode, cursor, scrollTop, splitPreviewRatio, image preview tabs, duplicated split tabs, and rename/move/delete path updates', async () => {
    const user = userEvent.setup()
    const createDnDTransfer = () => {
      const store = new Map<string, string>()
      return {
        effectAllowed: 'none',
        dropEffect: 'none',
        get types() {
          return [...store.keys()]
        },
        files: [] as unknown as FileList,
        setData(type: string, value: string) {
          store.set(type, value)
        },
        getData(type: string) {
          return store.get(type) ?? ''
        }
      }
    }

    const { api } = createInMemoryWikiApi(
      {
        recentWorkspaces: ['C:/wiki/alpha', 'C:/wiki/beta']
      },
      {
        workspaces: {
          'C:\\wiki\\alpha': {
            'raw-doc.md': '# Raw Doc\n\nLine 2\n\nLine 3',
            'split-doc.md': '# Split Doc\n\nBody text here',
            'wysiwyg-doc.md': '# Wysiwyg Doc\n\nParagraph',
            'docs/preview-doc.md': '# Preview Doc\n\nSection body',
            'assets/banner.png': '<png-bytes>',
            'temp.md': '# Temp',
            'archive/.keep': ''
          },
          'C:\\wiki\\beta': {
            'beta.md': '# Beta'
          }
        }
      }
    )
    window.wikiApi = api

    const firstMount = render(<App />)
    const explorer = await screen.findByLabelText('워크스페이스 탐색기')

    // 1. Open raw-doc.md -> set cursor & scrollTop, then duplicate to secondary pane in preview mode with different scrollTop
    await user.click(await within(explorer).findByText('raw-doc.md'))
    const primaryPane = screen.getByTestId('pane-primary')
    const rawEditor = await within(primaryPane).findByTestId('document-editor')
    setRawEditorSelection(rawEditor, 4, 9)
    const rawScroller = getRawEditorScroller(rawEditor)
    rawScroller.scrollTop = 145
    fireEvent.scroll(rawScroller)

    fireEvent.contextMenu(within(primaryPane).getByRole('tab', { name: /raw-doc\.md/ }))
    await user.click(
      within(await screen.findByRole('menu', { name: '탭 작업 메뉴' })).getByRole('menuitem', {
        name: '분할 영역에 복제 열기'
      })
    )
    const secondaryPane = await screen.findByTestId('pane-secondary')
    await switchPaneEditorMode(user, secondaryPane, 'Preview')
    const secPreviewEl = await within(secondaryPane).findByTestId('document-editor')
    secPreviewEl.scrollTop = 260
    fireEvent.scroll(secPreviewEl)

    // 2. Focus primary pane, open split-doc.md -> switch to Split mode, adjust splitPreviewRatio to 35%, cursor & scrollTop
    fireEvent.mouseDown(primaryPane)
    await user.click(within(explorer).getByText('split-doc.md'))
    await switchPaneEditorMode(user, primaryPane, 'Split')
    const splitEditorSplitter = within(primaryPane).getByRole('separator', {
      name: '에디터 분할 크기 조절'
    })
    fireEvent.keyDown(splitEditorSplitter, { key: 'ArrowLeft' })
    fireEvent.keyDown(splitEditorSplitter, { key: 'ArrowLeft' })
    fireEvent.keyDown(splitEditorSplitter, { key: 'ArrowLeft' })
    expect(splitEditorSplitter).toHaveAttribute('aria-valuenow', '35')

    const splitRawEditor = within(primaryPane).getAllByTestId('document-editor')[0]
    setRawEditorSelection(splitRawEditor, 2, 7)
    const splitRawScroller = getRawEditorScroller(splitRawEditor)
    splitRawScroller.scrollTop = 190
    fireEvent.scroll(splitRawScroller)

    // 3. Open wysiwyg-doc.md in primary -> switch to 위지윅 mode and scroll
    await user.click(within(explorer).getByText('wysiwyg-doc.md'))
    await switchPaneEditorMode(user, primaryPane, '위지윅')
    const wysiwygScrollContainer = primaryPane.querySelector('.wysiwyg-scroll-container') as HTMLElement
    wysiwygScrollContainer.scrollTop = 175
    fireEvent.scroll(wysiwygScrollContainer)

    // 4. Open docs/preview-doc.md in primary -> Preview mode, assets/banner.png -> image preview, temp.md -> delete
    await user.click(within(explorer).getByText('docs'))
    await user.click(await within(explorer).findByText('preview-doc.md'))
    await switchPaneEditorMode(user, primaryPane, 'Preview')
    const previewDocEl = await within(primaryPane).findByTestId('document-editor')
    previewDocEl.scrollTop = 310
    fireEvent.scroll(previewDocEl)

    await user.click(within(explorer).getByText('assets'))
    await user.click(await within(explorer).findByText('banner.png'))
    expect(await within(primaryPane).findByTestId('image-preview')).toBeInTheDocument()

    await user.click(within(explorer).getByText('temp.md'))

    // Rename raw-doc.md -> raw-renamed.md via F2
    const rawDocTreeItem = within(explorer).getByRole('treeitem', { name: 'raw-doc.md' })
    rawDocTreeItem.focus()
    fireEvent.keyDown(rawDocTreeItem, { key: 'F2' })
    const renameInput = await within(explorer).findByLabelText('새 이름 입력')
    await user.clear(renameInput)
    await user.type(renameInput, 'raw-renamed.md{Enter}')
    expect(await within(primaryPane).findByRole('tab', { name: /raw-renamed\.md/ })).toBeInTheDocument()

    // Move docs folder into archive via drag-and-drop -> docs/preview-doc.md updates to archive/docs/preview-doc.md
    const docsTreeItem = within(explorer).getByRole('treeitem', { name: 'docs' })
    const archiveTreeItem = within(explorer).getByRole('treeitem', { name: 'archive' })
    const dtMove = createDnDTransfer()
    fireEvent.dragStart(docsTreeItem, { dataTransfer: dtMove })
    fireEvent.dragOver(archiveTreeItem, { dataTransfer: dtMove })
    fireEvent.drop(archiveTreeItem, { dataTransfer: dtMove })
    fireEvent.dragEnd(docsTreeItem, { dataTransfer: dtMove })
    await waitFor(() => {
      expect(within(primaryPane).getByRole('tab', { name: /preview-doc\.md/ })).toHaveAttribute(
        'title',
        'C:/wiki/alpha/archive/docs/preview-doc.md'
      )
    })

    // Delete temp.md via context menu
    fireEvent.contextMenu(within(explorer).getByText('temp.md'))
    await user.click(
      within(await screen.findByRole('menu')).getByRole('menuitem', { name: /삭제/i })
    )
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: /삭제 확인/i })
    )
    await waitFor(() => {
      expect(within(primaryPane).queryByRole('tab', { name: /temp\.md/ })).not.toBeInTheDocument()
    })
    await user.click(within(primaryPane).getByRole('tab', { name: /banner\.png/ }))
    expect(await within(primaryPane).findByTestId('image-preview')).toBeInTheDocument()

    // Switch immediately to beta, then restart app
    await switchWorkspaceFromView(user, /^beta$/i)
    expect(await within(await screen.findByLabelText('워크스페이스 탐색기')).findByText('beta.md')).toBeInTheDocument()

    // Switch back to alpha and also verify full restart preserves all view states
    await switchWorkspaceFromView(user, /^alpha$/i)
    await waitFor(() => {
      expect(screen.getByTestId('pane-workspace')).toHaveAttribute('data-split-mode', 'horizontal')
    })

    firstMount.unmount()
    render(<App />)

    await waitFor(() => {
      expect(screen.getByTestId('pane-workspace')).toHaveAttribute('data-split-mode', 'horizontal')
      expect(within(screen.getByTestId('pane-primary')).getByTestId('image-preview')).toBeInTheDocument()
    })

    const restartedPrimary = screen.getByTestId('pane-primary')
    const restartedSecondary = screen.getByTestId('pane-secondary')

    // Secondary holds raw-renamed.md in Preview mode at scrollTop 260
    expect(
      within(restartedSecondary).getByRole('heading', { name: /Raw Doc/ })
    ).toBeInTheDocument()
    expect(within(restartedSecondary).getByTestId('document-editor').scrollTop).toBe(260)

    // Primary tabs: raw-renamed.md (raw), split-doc.md (split), wysiwyg-doc.md (wysiwyg), preview-doc.md (preview), banner.png (active image)
    await user.click(within(restartedPrimary).getByRole('tab', { name: /raw-renamed\.md/ }))
    const restoredRaw = await within(restartedPrimary).findByTestId('document-editor')
    expect(getRawEditorSelection(restoredRaw)).toEqual({ start: 4, end: 9 })
    expect(getRawEditorScroller(restoredRaw).scrollTop).toBe(145)

    await user.click(within(restartedPrimary).getByRole('tab', { name: /split-doc\.md/ }))
    const restoredSplitSplitter = await within(restartedPrimary).findByRole('separator', {
      name: '에디터 분할 크기 조절'
    })
    expect(restoredSplitSplitter).toHaveAttribute('aria-valuenow', '35')
    const restoredSplitRaw = within(restartedPrimary).getAllByTestId('document-editor')[0]
    expect(getRawEditorSelection(restoredSplitRaw)).toEqual({ start: 2, end: 7 })
    expect(getRawEditorScroller(restoredSplitRaw).scrollTop).toBe(190)

    await user.click(within(restartedPrimary).getByRole('tab', { name: /wysiwyg-doc\.md/ }))
    expect(await within(restartedPrimary).findByLabelText('위지윅 문서 에디터')).toBeInTheDocument()
    expect(
      (restartedPrimary.querySelector('.wysiwyg-scroll-container') as HTMLElement).scrollTop
    ).toBe(175)

    await user.click(within(restartedPrimary).getByRole('tab', { name: /preview-doc\.md/ }))
    expect(
      await within(restartedPrimary).findByRole('heading', { name: /Preview Doc/ })
    ).toBeInTheDocument()
    expect(within(restartedPrimary).getByRole('tab', { name: /preview-doc\.md/ })).toHaveAttribute(
      'title',
      'C:/wiki/alpha/archive/docs/preview-doc.md'
    )
    expect(within(restartedPrimary).getByTestId('document-editor').scrollTop).toBe(310)
  }, 15_000)

  it('skips missing text/image tabs without error banner, collapses empty secondary, promotes secondary when primary empties, falls back active tab, and cancels stale tab restore on rapid switch', async () => {
    const user = userEvent.setup()
    const { api } = createInMemoryWikiApi(
      {
        recentWorkspaces: ['C:/wiki/alpha', 'C:/wiki/beta', 'C:/wiki/gamma']
      },
      {
        workspaces: {
          'C:\\wiki\\alpha': {
            'keep-primary.md': '# Keep Primary'
          },
          'C:\\wiki\\beta': {
            'only-sec.md': '# Promoted Secondary'
          },
          'C:\\wiki\\gamma': {
            'gamma.md': '# Gamma'
          }
        },
        workspaceStates: {
          'C:\\wiki\\alpha': {
            layout: {
              splitMode: 'vertical',
              splitRatio: 0.65,
              activePaneId: 'secondary',
              panes: {
                primary: {
                  tabs: [
                    {
                      path: 'C:\\wiki\\alpha\\deleted-active.md',
                      mode: 'raw',
                      cursor: { selectionStart: 0, selectionEnd: 0 },
                      scrollTop: 0,
                      splitPreviewRatio: 0.5
                    },
                    {
                      path: 'C:\\wiki\\alpha\\keep-primary.md',
                      mode: 'preview',
                      cursor: { selectionStart: 0, selectionEnd: 0 },
                      scrollTop: 120,
                      splitPreviewRatio: 0.5
                    }
                  ],
                  activeTabPath: 'C:\\wiki\\alpha\\deleted-active.md'
                },
                secondary: {
                  tabs: [
                    {
                      path: 'C:\\wiki\\alpha\\assets\\deleted.png',
                      mode: 'raw',
                      cursor: { selectionStart: 0, selectionEnd: 0 },
                      scrollTop: 0,
                      splitPreviewRatio: 0.5
                    }
                  ],
                  activeTabPath: 'C:\\wiki\\alpha\\assets\\deleted.png'
                }
              }
            }
          },
          'C:\\wiki\\beta': {
            layout: {
              splitMode: 'horizontal',
              splitRatio: 0.4,
              activePaneId: 'secondary',
              panes: {
                primary: {
                  tabs: [
                    {
                      path: 'C:\\wiki\\beta\\deleted-pri.md',
                      mode: 'raw',
                      cursor: { selectionStart: 0, selectionEnd: 0 },
                      scrollTop: 0,
                      splitPreviewRatio: 0.5
                    }
                  ],
                  activeTabPath: 'C:\\wiki\\beta\\deleted-pri.md'
                },
                secondary: {
                  tabs: [
                    {
                      path: 'C:\\wiki\\beta\\only-sec.md',
                      mode: 'preview',
                      cursor: { selectionStart: 0, selectionEnd: 0 },
                      scrollTop: 95,
                      splitPreviewRatio: 0.5
                    }
                  ],
                  activeTabPath: 'C:\\wiki\\beta\\only-sec.md'
                }
              }
            }
          },
          'C:\\wiki\\gamma': {
            layout: {
              splitMode: 'single',
              splitRatio: 0.5,
              activePaneId: 'primary',
              panes: {
                primary: {
                  tabs: [
                    {
                      path: 'C:\\wiki\\gamma\\gamma.md',
                      mode: 'raw',
                      cursor: { selectionStart: 0, selectionEnd: 0 },
                      scrollTop: 0,
                      splitPreviewRatio: 0.5
                    }
                  ],
                  activeTabPath: 'C:\\wiki\\gamma\\gamma.md'
                },
                secondary: { tabs: [], activeTabPath: null }
              }
            }
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)

    // 1. Alpha restores: deleted-active.md and deleted.png skipped without error banner, collapses to single, keep-primary.md active in preview
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /keep-primary\.md/ })).toHaveAttribute(
        'aria-selected',
        'true'
      )
    })
    expect(screen.getByTestId('pane-workspace')).toHaveAttribute('data-split-mode', 'single')
    expect(screen.queryByTestId('pane-secondary')).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /deleted-active\.md/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /deleted\.png/ })).not.toBeInTheDocument()
    expect(screen.getByTestId('document-editor').scrollTop).toBe(120)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    // 2. Switch to Beta -> primary deleted, secondary only-sec.md promoted to primary in single mode without error banner
    await switchWorkspaceFromView(user, /^beta$/i)
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /only-sec\.md/ })).toHaveAttribute(
        'aria-selected',
        'true'
      )
    })
    expect(screen.getByTestId('pane-workspace')).toHaveAttribute('data-split-mode', 'single')
    expect(screen.queryByTestId('pane-secondary')).not.toBeInTheDocument()
    expect(screen.getByTestId('document-editor').scrollTop).toBe(95)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    // 3. Rapid switch: start switching to beta with deferred openWorkspaceFile, immediately switch to gamma -> stale beta tab must not overwrite gamma
    const origOpenBuffer = api.buffer.openWorkspaceFile.bind(api.buffer)
    let resolveDelayedBetaTab!: (value: Awaited<ReturnType<typeof origOpenBuffer>>) => void
    const delayedBetaTab = new Promise<Awaited<ReturnType<typeof origOpenBuffer>>>((resolve) => {
      resolveDelayedBetaTab = resolve
    })
    let betaOpenCount = 0
    vi.spyOn(api.buffer, 'openWorkspaceFile').mockImplementation(async (filePath, name, initialContent) => {
      if (filePath.toLowerCase().includes('only-sec.md') && betaOpenCount === 0) {
        betaOpenCount += 1
        return await delayedBetaTab
      }
      return await origOpenBuffer(filePath, name, initialContent)
    })

    // First switch back to alpha, then rapid switch to beta -> gamma
    await switchWorkspaceFromView(user, /^alpha$/i)
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /keep-primary\.md/ })).toBeInTheDocument()
    })

    await switchWorkspaceFromView(user, /^beta$/i)
    await waitFor(() => {
      expect(betaOpenCount).toBe(1)
    })
    await switchWorkspaceFromView(user, /^gamma$/i)
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /gamma\.md/ })).toBeInTheDocument()
    })

    const realBetaBuf = await origOpenBuffer('C:/wiki/beta/only-sec.md', 'only-sec.md')
    await act(async () => {
      resolveDelayedBetaTab(realBetaBuf)
    })
    expect(screen.getByRole('tab', { name: /gamma\.md/ })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /only-sec\.md/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('excludes Git Diff tabs and config.json from workspace state while preserving open config.json across workspace switches that restore saved tabs', async () => {
    const user = userEvent.setup()
    const cleanStatus = {
      ...createEmptyGitStatus(true, 'C:/wiki/alpha'),
      branch: 'main',
      unstaged: [{ path: 'alpha.md', status: 'M' as const }]
    }
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      {
        autoSave: false,
        recentWorkspaces: ['C:/wiki/alpha', 'C:/wiki/beta']
      },
      {
        workspaces: {
          'C:\\wiki\\alpha': {
            'alpha.md': '# Alpha'
          },
          'C:\\wiki\\beta': {
            'beta.md': '# Beta',
            'side.md': '# Side'
          }
        },
        workspaceStates: {
          'C:\\wiki\\beta': {
            layout: {
              splitMode: 'horizontal',
              splitRatio: 0.6,
              activePaneId: 'primary',
              panes: {
                primary: {
                  tabs: [
                    {
                      path: 'C:\\wiki\\beta\\beta.md',
                      mode: 'preview',
                      cursor: { selectionStart: 0, selectionEnd: 0 },
                      scrollTop: 50,
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
        },
        git: {
          status: vi.fn(async () => cleanStatus),
          branches: vi.fn(async () => ({
            current: 'main',
            isDetached: false,
            branches: [{ name: 'main', current: true, upstream: null }]
          })),
          diff: vi.fn(async () => ({
            path: 'alpha.md',
            status: 'M' as const,
            isBinary: false,
            isTruncated: false,
            existsInWorkspace: true,
            rawPatch: '@@ -1 +1 @@\n-# Alpha\n+# Alpha changed'
          }))
        }
      }
    )
    window.wikiApi = api

    const firstMount = render(<App />)
    const explorer = await screen.findByLabelText('워크스페이스 탐색기')
    await user.click(await within(explorer).findByText('alpha.md'))

    // Open config.json tab and a Git Diff tab moved to secondary pane
    await triggerMenuCommand(emitMenuCommand, 'toggle-settings')
    await user.click(
      within(screen.getByLabelText('전역 설정 패널')).getByRole('button', {
        name: /설정 파일 직접 열기/i
      })
    )
    const primaryPane = screen.getByTestId('pane-primary')
    expect(within(primaryPane).getByRole('tab', { name: /config\.json/i })).toBeInTheDocument()

    await clickActivityBarButton(user, 'Git')
    const gitRegion = screen.getByRole('region', { name: 'Git 소스 제어' })
    await user.click(await within(gitRegion).findByText('alpha.md'))
    expect(await within(primaryPane).findByText('Working Tree')).toBeInTheDocument()
    // Move diff tab to secondary pane so secondary holds ONLY a Diff tab
    const diffTabs = within(primaryPane).getAllByRole('tab', { name: /alpha\.md/i })
    const actualDiffTab = diffTabs[diffTabs.length - 1]
    fireEvent.contextMenu(actualDiffTab)
    await user.click(
      within(await screen.findByRole('menu', { name: '탭 작업 메뉴' })).getByRole('menuitem', {
        name: '분할 영역으로 이동'
      })
    )
    expect(screen.getByTestId('pane-workspace')).toHaveAttribute('data-split-mode', 'horizontal')

    // Switch to beta -> alpha's persisted state excludes Diff tab & config.json and collapses to single; beta restores its split tabs AND keeps config.json tab open!
    await switchWorkspaceFromView(user, /^beta$/i)

    await waitFor(() => {
      expect(screen.getByTestId('pane-workspace')).toHaveAttribute('data-split-mode', 'horizontal')
      expect(within(screen.getByTestId('pane-primary')).getByRole('tab', { name: /beta\.md/ })).toBeInTheDocument()
      expect(within(screen.getByTestId('pane-secondary')).getByRole('tab', { name: /side\.md/ })).toBeInTheDocument()
    })
    expect(within(screen.getByTestId('pane-primary')).getByRole('tab', { name: /config\.json/i })).toBeInTheDocument()
    expect(screen.queryByText('Working Tree')).not.toBeInTheDocument()

    const savedAlpha = await api.workspaceState!.get('C:/wiki/alpha')
    expect(savedAlpha?.layout).toEqual({
      splitMode: 'single',
      splitRatio: 0.5,
      activePaneId: 'primary',
      panes: {
        primary: {
          tabs: [
            {
              path: 'C:\\wiki\\alpha\\alpha.md',
              mode: 'raw',
              cursor: { selectionStart: 0, selectionEnd: 0 },
              scrollTop: 0,
              splitPreviewRatio: 0.5
            }
          ],
          activeTabPath: 'C:\\wiki\\alpha\\alpha.md'
        },
        secondary: { tabs: [], activeTabPath: null }
      }
    })

    // Restart app on beta (recentWorkspaces[0] is beta now) -> only beta.md and side.md restore, NOT config.json or Diff tab
    firstMount.unmount()
    render(<App />)
    await waitFor(() => {
      expect(within(screen.getByTestId('pane-primary')).getByRole('tab', { name: /beta\.md/ })).toBeInTheDocument()
      expect(within(screen.getByTestId('pane-secondary')).getByRole('tab', { name: /side\.md/ })).toBeInTheDocument()
    })
    expect(screen.queryByRole('tab', { name: /config\.json/i })).not.toBeInTheDocument()
  })
})
