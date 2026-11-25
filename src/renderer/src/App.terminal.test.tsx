import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import { getTerminalXtermTheme } from './terminal/terminalTheme'
import {
  createInMemoryWikiApi,
  createMultiWindowWikiHarness,
  triggerMenuCommand
} from './test/inMemoryWikiHarness'

interface MockXtermTracker {
  sessionId: string
  theme: unknown
  writes: string[]
  disposed: boolean
}

const mockXtermRecords = new Map<string, MockXtermTracker>()

vi.mock('./terminal/xtermAdapter', () => ({
  createXtermInstance: ({
    sessionId,
    theme
  }: {
    sessionId: string
    theme: unknown
  }) => {
    const record: MockXtermTracker = {
      sessionId,
      theme,
      writes: [],
      disposed: false
    }
    mockXtermRecords.set(sessionId, record)
    return {
      open: vi.fn(),
      write: (data: string) => {
        record.writes.push(data)
      },
      fit: () => ({ cols: 90, rows: 25 }),
      focus: vi.fn(),
      setTheme: (nextTheme: unknown) => {
        record.theme = nextTheme
      },
      dispose: () => {
        record.disposed = true
      }
    }
  }
}))

describe('App integrated terminal integration', () => {
  beforeEach(() => {
    mockXtermRecords.clear()
  })

  it('lazy-creates terminal only on toggle/shortcut, places it inside main center column, and hides it in auxiliary windows', async () => {
    const harness = createMultiWindowWikiHarness(
      {
        theme: 'light',
        recentWorkspaces: ['C:\\wiki-a']
      },
      {
        workspaces: {
          'C:\\wiki-a': {
            'note.md': '# Note\n'
          }
        }
      }
    )

    const mainWindow = harness.createWindow({ role: 'main' })
    const auxWindow = harness.createWindow({ role: 'auxiliary' })

    const mainRender = render(<App wikiApi={mainWindow.api} />)
    await waitFor(() => {
      expect(mainRender.container.querySelector('.pane-workspace')).toBeInTheDocument()
    })

    // Lazy creation: no terminal panel or PTY session before opening
    expect(screen.queryByLabelText('터미널 패널')).not.toBeInTheDocument()
    expect(harness.getTerminalSessions()).toHaveLength(0)

    // Open terminal via Ctrl+`
    fireEvent.keyDown(window, { key: '`', code: 'Backquote', ctrlKey: true })
    await waitFor(() => {
      expect(screen.getByLabelText('터미널 패널')).toBeInTheDocument()
      expect(harness.getTerminalSessions()).toHaveLength(1)
    })

    // Placed inside .center-workspace-column alongside .pane-workspace
    const centerColumn = mainRender.container.querySelector('.center-workspace-column')
    expect(centerColumn).toContainElement(mainRender.container.querySelector('.pane-workspace'))
    expect(centerColumn).toContainElement(screen.getByLabelText('터미널 패널'))

    // Auxiliary window must never expose terminal panel
    mainRender.unmount()
    const auxRender = render(<App wikiApi={auxWindow.api} />)
    fireEvent.keyDown(window, { key: '`', code: 'Backquote', ctrlKey: true })
    expect(auxRender.queryByLabelText('터미널 패널')).not.toBeInTheDocument()

    harness.dispose()
  })

  it('supports menu commands, Ctrl+Shift+` new terminal, multi-tab switching/exit/close, collapse preservation, theme sync, and workspace switch reset', async () => {
    const {
      api,
      emitMenuCommand,
      emitTerminalData,
      emitTerminalExit,
      getTerminalSessions,
      getTerminalClosedIds,
      dispose
    } = createInMemoryWikiApi(
      {
        theme: 'light',
        recentWorkspaces: ['C:\\wiki-a', 'C:\\wiki-b']
      },
      {
        workspaces: {
          'C:\\wiki-a': {
            'a.md': '# A\n'
          },
          'C:\\wiki-b': {
            'b.md': '# B\n'
          }
        }
      }
    )

    render(<App wikiApi={api} />)
    await waitFor(() => {
      expect(screen.getByText('a.md')).toBeInTheDocument()
    })

    // Open first terminal via application menu command
    await triggerMenuCommand(emitMenuCommand, 'toggle-terminal')
    await waitFor(() => {
      expect(getTerminalSessions()).toHaveLength(1)
    })
    const firstId = getTerminalSessions()[0].id
    expect(mockXtermRecords.get(firstId)?.theme).toEqual(getTerminalXtermTheme('light'))

    // Create second terminal via Ctrl+Shift+`
    fireEvent.keyDown(window, { key: '`', code: 'Backquote', ctrlKey: true, shiftKey: true })
    await waitFor(() => {
      expect(getTerminalSessions()).toHaveLength(2)
    })
    const secondId = getTerminalSessions()[1].id
    expect(screen.getAllByRole('tab')).toHaveLength(2)

    // Collapse panel via menu toggle-terminal; sessions & output stay alive
    await triggerMenuCommand(emitMenuCommand, 'toggle-terminal')
    const panel = screen.getByLabelText('터미널 패널')
    expect(panel).toHaveClass('is-collapsed')
    expect(mockXtermRecords.get(firstId)?.disposed).toBe(false)

    act(() => {
      emitTerminalData(firstId, 'background output\r\n')
    })

    // Reopen panel via toggle-terminal
    await triggerMenuCommand(emitMenuCommand, 'toggle-terminal')
    expect(panel).not.toHaveClass('is-collapsed')
    expect(mockXtermRecords.get(firstId)?.writes).toContain('background output\r\n')

    // Theme switch updates xterm palette
    await triggerMenuCommand(emitMenuCommand, 'toggle-theme')
    await waitFor(() => {
      expect(mockXtermRecords.get(firstId)?.theme).toEqual(getTerminalXtermTheme('dark'))
    })

    // Exit event updates tab status
    act(() => {
      emitTerminalExit(secondId, 2)
    })
    expect(screen.getAllByRole('tab')[1]).toHaveTextContent('종료 (2)')

    // Close second tab calls closeSession
    fireEvent.click(screen.getAllByRole('button', { name: 'PowerShell 터미널 닫기' })[1])
    expect(getTerminalClosedIds()).toContain(secondId)
    expect(screen.getAllByRole('tab')).toHaveLength(1)

    // Switch workspace resets remaining terminal tabs and closes PTY
    fireEvent.click(screen.getByRole('button', { name: '워크스페이스' }))
    fireEvent.click(screen.getByRole('button', { name: 'wiki-b' }))
    await waitFor(() => {
      expect(getTerminalClosedIds()).toContain(firstId)
      expect(screen.queryByLabelText('터미널 패널')).not.toBeInTheDocument()
    })

    dispose()
  })

  it('configures defaultTerminalProfile in SettingsPanel, uses it for + / Ctrl+Shift+`, supports + dropdown selection, and falls back when missing', async () => {
    const {
      api,
      emitMenuCommand,
      getTerminalSessions,
      dispose
    } = createInMemoryWikiApi(
      {
        theme: 'light',
        defaultTerminalProfile: 'missing-shell',
        recentWorkspaces: ['C:\\wiki-a']
      },
      {
        workspaces: {
          'C:\\wiki-a': {
            'a.md': '# A\n'
          }
        }
      }
    )

    render(<App wikiApi={api} />)
    await waitFor(() => {
      expect(screen.getByText('a.md')).toBeInTheDocument()
    })

    // Missing defaultTerminalProfile falls back safely to auto-detected default ('pwsh')
    fireEvent.keyDown(window, { key: '`', code: 'Backquote', ctrlKey: true })
    await waitFor(() => {
      expect(getTerminalSessions()).toHaveLength(1)
    })
    expect(getTerminalSessions()[0].profileId).toBe('pwsh')

    // Open SettingsPanel and change defaultTerminalProfile to 'cmd'
    await triggerMenuCommand(emitMenuCommand, 'toggle-settings')
    const settingsDialog = await screen.findByRole('dialog', { name: '전역 설정 패널' })
    const profileSelect = within(settingsDialog).getByLabelText('기본 터미널 프로필')
    expect(profileSelect).toHaveValue('')

    fireEvent.change(profileSelect, { target: { value: 'cmd' } })
    await waitFor(async () => {
      const savedConfig = await api.config.get()
      expect(savedConfig.defaultTerminalProfile).toBe('cmd')
    })

    await userEventCloseSettings(settingsDialog)

    // + button and Ctrl+Shift+` now use 'cmd'
    fireEvent.click(screen.getByRole('button', { name: '새 터미널' }))
    await waitFor(() => {
      expect(getTerminalSessions()).toHaveLength(2)
    })
    expect(getTerminalSessions()[1].profileId).toBe('cmd')

    fireEvent.keyDown(window, { key: '`', code: 'Backquote', ctrlKey: true, shiftKey: true })
    await waitFor(() => {
      expect(getTerminalSessions()).toHaveLength(3)
    })
    expect(getTerminalSessions()[2].profileId).toBe('cmd')

    // Reset defaultTerminalProfile to auto-detect (null)
    await triggerMenuCommand(emitMenuCommand, 'toggle-settings')
    const reopenedSettings = await screen.findByRole('dialog', { name: '전역 설정 패널' })
    fireEvent.change(within(reopenedSettings).getByLabelText('기본 터미널 프로필'), {
      target: { value: '' }
    })
    await waitFor(async () => {
      const savedConfig = await api.config.get()
      expect(savedConfig.defaultTerminalProfile).toBeNull()
    })
    await userEventCloseSettings(reopenedSettings)

    // + dropdown still allows explicitly picking 'cmd'
    fireEvent.click(screen.getByRole('button', { name: '셸 프로필 선택' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Command Prompt/ }))
    await waitFor(() => {
      expect(getTerminalSessions()).toHaveLength(4)
    })
    expect(getTerminalSessions()[3].profileId).toBe('cmd')

    dispose()
  })
})

async function userEventCloseSettings(dialog: HTMLElement): Promise<void> {
  fireEvent.click(within(dialog).getByRole('button', { name: '닫기' }))
  await waitFor(() => {
    expect(screen.queryByRole('dialog', { name: '전역 설정 패널' })).not.toBeInTheDocument()
  })
}
