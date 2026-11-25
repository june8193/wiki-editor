import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { XtermInstance, XtermInstanceFactory } from '../terminal/xtermAdapter'
import { getTerminalXtermTheme } from '../terminal/terminalTheme'
import { TerminalPanel, type TerminalTabState } from './TerminalPanel'

interface MockXtermRecord {
  sessionId: string
  theme: unknown
  writes: string[]
  pastes: string[]
  selection: string
  fitCalls: number
  focusCalls: number
  disposed: boolean
  emitData: (data: string) => void
  emitResize: (cols: number, rows: number) => void
  emitKeyEvent?: (event: KeyboardEvent) => boolean
  emitActivateLink?: (text: string, event: MouseEvent) => void
}

function createMockXtermFactory() {
  const records = new Map<string, MockXtermRecord>()

  const factory: XtermInstanceFactory = ({
    sessionId,
    theme,
    onData,
    onResize,
    onKeyEvent,
    onActivateLink
  }) => {
    const record: MockXtermRecord = {
      sessionId,
      theme,
      writes: [],
      pastes: [],
      selection: '',
      fitCalls: 0,
      focusCalls: 0,
      disposed: false,
      emitData: onData,
      emitResize: onResize,
      emitKeyEvent: onKeyEvent,
      emitActivateLink: onActivateLink
    }
    records.set(sessionId, record)

    const instance: XtermInstance = {
      open: vi.fn(),
      write: (data: string) => {
        record.writes.push(data)
      },
      fit: () => {
        record.fitCalls += 1
        return { cols: 100, rows: 28 }
      },
      focus: () => {
        record.focusCalls += 1
      },
      setTheme: (nextTheme) => {
        record.theme = nextTheme
      },
      hasSelection: () => record.selection.length > 0,
      getSelection: () => record.selection,
      clearSelection: () => {
        record.selection = ''
      },
      paste: (data: string) => {
        record.pastes.push(data)
        record.emitData(data)
      },
      dispose: () => {
        record.disposed = true
      }
    }
    return instance
  }

  return { factory, records }
}

const SAMPLE_TABS: TerminalTabState[] = [
  { id: 'term-1', profileId: 'pwsh', title: 'pwsh', isRunning: true, exitCode: null },
  { id: 'term-2', profileId: 'cmd', title: 'cmd', isRunning: false, exitCode: 0 }
]

describe('TerminalPanel', () => {
  it('supports resizer pointer drag, ArrowUp/ArrowDown keyboard adjustment, double-click reset, and fit/resize sync', () => {
    const { factory, records } = createMockXtermFactory()
    const onResizeHeight = vi.fn()
    const onResizeSession = vi.fn()

    render(
      <TerminalPanel
        isOpen
        height={240}
        heightBounds={{ min: 120, max: 500, defaultHeight: 240 }}
        theme="dark"
        tabs={[SAMPLE_TABS[0]]}
        activeTabId="term-1"
        errorMessage={null}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onNewTerminal={vi.fn()}
        onCollapse={vi.fn()}
        onResizeHeight={onResizeHeight}
        onWriteSession={vi.fn()}
        onResizeSession={onResizeSession}
        subscribeSessionData={() => () => undefined}
        createXtermInstance={factory}
      />
    )

    const separator = screen.getByRole('separator', { name: '터미널 패널 높이 조절' })
    expect(separator).toHaveAttribute('aria-orientation', 'horizontal')
    expect(separator).toHaveAttribute('aria-valuenow', '240')

    // Pointer drag upward by 60px increases height to 300
    fireEvent.pointerDown(separator, { clientY: 500 })
    fireEvent.pointerMove(window, { clientY: 440 })
    fireEvent.pointerUp(window)
    expect(onResizeHeight).toHaveBeenCalledWith(300)

    // Keyboard ArrowUp / ArrowDown
    fireEvent.keyDown(separator, { key: 'ArrowUp' })
    expect(onResizeHeight).toHaveBeenCalledWith(260)
    fireEvent.keyDown(separator, { key: 'ArrowDown' })
    expect(onResizeHeight).toHaveBeenCalledWith(220)

    // Double click resets to default height
    fireEvent.doubleClick(separator)
    expect(onResizeHeight).toHaveBeenCalledWith(240)

    // Initial mount fits active xterm and notifies PTY resize
    expect(records.get('term-1')?.fitCalls).toBeGreaterThanOrEqual(1)
    expect(onResizeSession).toHaveBeenCalledWith('term-1', 100, 28)
  })

  it('renders multiple tabs with running/exited status, switches active tab, and forwards close/new actions', () => {
    const { factory } = createMockXtermFactory()
    const onSelectTab = vi.fn()
    const onCloseTab = vi.fn()
    const onNewTerminal = vi.fn()

    render(
      <TerminalPanel
        isOpen
        height={240}
        heightBounds={{ min: 120, max: 500, defaultHeight: 240 }}
        theme="light"
        tabs={SAMPLE_TABS}
        activeTabId="term-1"
        errorMessage={null}
        onSelectTab={onSelectTab}
        onCloseTab={onCloseTab}
        onNewTerminal={onNewTerminal}
        onCollapse={vi.fn()}
        onResizeHeight={vi.fn()}
        onWriteSession={vi.fn()}
        onResizeSession={vi.fn()}
        subscribeSessionData={() => () => undefined}
        createXtermInstance={factory}
      />
    )

    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(2)
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
    expect(tabs[1]).toHaveAttribute('aria-selected', 'false')
    expect(tabs[1]).toHaveTextContent('종료 (0)')

    fireEvent.click(tabs[1])
    expect(onSelectTab).toHaveBeenCalledWith('term-2')

    fireEvent.click(screen.getByRole('button', { name: 'cmd 터미널 닫기' }))
    expect(onCloseTab).toHaveBeenCalledWith('term-2')
    expect(onSelectTab).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: '새 터미널' }))
    expect(onNewTerminal).toHaveBeenCalledTimes(1)
    expect(onNewTerminal).toHaveBeenCalledWith()
  })

  it('opens the + dropdown with detected shell profiles, creates a terminal for the selected profile, and closes on Escape or outside click', () => {
    const { factory } = createMockXtermFactory()
    const onNewTerminal = vi.fn()
    const profiles = [
      { id: 'pwsh', label: 'PowerShell', executable: 'pwsh.exe', args: ['-NoLogo'], isDefault: true },
      { id: 'cmd', label: 'Command Prompt', executable: 'cmd.exe', args: [], isDefault: false }
    ]

    render(
      <TerminalPanel
        isOpen
        height={240}
        heightBounds={{ min: 120, max: 500, defaultHeight: 240 }}
        theme="light"
        tabs={SAMPLE_TABS}
        activeTabId="term-1"
        profiles={profiles}
        errorMessage={null}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onNewTerminal={onNewTerminal}
        onCollapse={vi.fn()}
        onResizeHeight={vi.fn()}
        onWriteSession={vi.fn()}
        onResizeSession={vi.fn()}
        subscribeSessionData={() => () => undefined}
        createXtermInstance={factory}
      />
    )

    const trigger = screen.getByRole('button', { name: '셸 프로필 선택' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    const menu = screen.getByRole('menu', { name: '셸 프로필 목록' })
    expect(menu).toBeInTheDocument()

    fireEvent.click(screen.getByRole('menuitem', { name: /Command Prompt/ }))
    expect(onNewTerminal).toHaveBeenCalledWith('cmd')
    expect(screen.queryByRole('menu', { name: '셸 프로필 목록' })).not.toBeInTheDocument()

    // Reopen and close via Escape
    fireEvent.click(trigger)
    expect(screen.getByRole('menu', { name: '셸 프로필 목록' })).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu', { name: '셸 프로필 목록' })).not.toBeInTheDocument()

    // Reopen and close via outside pointerDown
    fireEvent.click(trigger)
    expect(screen.getByRole('menu', { name: '셸 프로필 목록' })).toBeInTheDocument()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu', { name: '셸 프로필 목록' })).not.toBeInTheDocument()
  })

  it('synchronizes xterm palette when theme changes between light and dark', () => {
    const { factory, records } = createMockXtermFactory()

    const { rerender } = render(
      <TerminalPanel
        isOpen
        height={240}
        heightBounds={{ min: 120, max: 500, defaultHeight: 240 }}
        theme="light"
        tabs={[SAMPLE_TABS[0]]}
        activeTabId="term-1"
        errorMessage={null}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onNewTerminal={vi.fn()}
        onCollapse={vi.fn()}
        onResizeHeight={vi.fn()}
        onWriteSession={vi.fn()}
        onResizeSession={vi.fn()}
        subscribeSessionData={() => () => undefined}
        createXtermInstance={factory}
      />
    )

    expect(records.get('term-1')?.theme).toEqual(getTerminalXtermTheme('light'))

    rerender(
      <TerminalPanel
        isOpen
        height={240}
        heightBounds={{ min: 120, max: 500, defaultHeight: 240 }}
        theme="dark"
        tabs={[SAMPLE_TABS[0]]}
        activeTabId="term-1"
        errorMessage={null}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onNewTerminal={vi.fn()}
        onCollapse={vi.fn()}
        onResizeHeight={vi.fn()}
        onWriteSession={vi.fn()}
        onResizeSession={vi.fn()}
        subscribeSessionData={() => () => undefined}
        createXtermInstance={factory}
      />
    )

    expect(records.get('term-1')?.theme).toEqual(getTerminalXtermTheme('dark'))
  })

  it('keeps xterm instances alive when collapsed and flushes buffered session data', () => {
    const { factory, records } = createMockXtermFactory()
    const dataListeners = new Set<(sessionId: string, data: string) => void>()
    const subscribeSessionData = (listener: (sessionId: string, data: string) => void) => {
      dataListeners.add(listener)
      return () => {
        dataListeners.delete(listener)
      }
    }
    const emitData = (sessionId: string, data: string) => {
      for (const listener of dataListeners) {
        listener(sessionId, data)
      }
    }

    const { rerender } = render(
      <TerminalPanel
        isOpen
        height={240}
        heightBounds={{ min: 120, max: 500, defaultHeight: 240 }}
        theme="dark"
        tabs={[SAMPLE_TABS[0]]}
        activeTabId="term-1"
        errorMessage={null}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onNewTerminal={vi.fn()}
        onCollapse={vi.fn()}
        onResizeHeight={vi.fn()}
        onWriteSession={vi.fn()}
        onResizeSession={vi.fn()}
        subscribeSessionData={subscribeSessionData}
        createXtermInstance={factory}
      />
    )

    emitData('term-1', 'hello ')

    rerender(
      <TerminalPanel
        isOpen={false}
        height={240}
        heightBounds={{ min: 120, max: 500, defaultHeight: 240 }}
        theme="dark"
        tabs={[SAMPLE_TABS[0]]}
        activeTabId="term-1"
        errorMessage={null}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onNewTerminal={vi.fn()}
        onCollapse={vi.fn()}
        onResizeHeight={vi.fn()}
        onWriteSession={vi.fn()}
        onResizeSession={vi.fn()}
        subscribeSessionData={subscribeSessionData}
        createXtermInstance={factory}
      />
    )

    expect(records.get('term-1')?.disposed).toBe(false)
    emitData('term-1', 'world')

    rerender(
      <TerminalPanel
        isOpen
        height={240}
        heightBounds={{ min: 120, max: 500, defaultHeight: 240 }}
        theme="dark"
        tabs={[SAMPLE_TABS[0]]}
        activeTabId="term-1"
        errorMessage={null}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onNewTerminal={vi.fn()}
        onCollapse={vi.fn()}
        onResizeHeight={vi.fn()}
        onWriteSession={vi.fn()}
        onResizeSession={vi.fn()}
        subscribeSessionData={subscribeSessionData}
        createXtermInstance={factory}
      />
    )

    expect(records.get('term-1')?.writes).toEqual(['hello ', 'world'])
  })

  it('supports VS Code style smart copy (Ctrl+C with/without selection) and paste (Ctrl+V and right-click)', async () => {
    const { factory, records } = createMockXtermFactory()
    const onWriteSession = vi.fn()
    const writeClipboardText = vi.fn().mockResolvedValue(undefined)
    const readClipboardText = vi.fn().mockResolvedValue('echo pasted')

    render(
      <TerminalPanel
        isOpen
        height={240}
        heightBounds={{ min: 120, max: 500, defaultHeight: 240 }}
        theme="dark"
        tabs={[SAMPLE_TABS[0]]}
        activeTabId="term-1"
        errorMessage={null}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onNewTerminal={vi.fn()}
        onCollapse={vi.fn()}
        onResizeHeight={vi.fn()}
        onWriteSession={onWriteSession}
        onResizeSession={vi.fn()}
        subscribeSessionData={() => () => undefined}
        writeClipboardText={writeClipboardText}
        readClipboardText={readClipboardText}
        createXtermInstance={factory}
      />
    )

    const record = records.get('term-1')!

    // 1. Ctrl+C with selection copies text and blocks SIGINT (returns false)
    record.selection = 'copied output'
    const copyEvent = new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, cancelable: true })
    expect(record.emitKeyEvent?.(copyEvent)).toBe(false)
    expect(writeClipboardText).toHaveBeenCalledWith('copied output')
    expect(onWriteSession).not.toHaveBeenCalled()

    // 2. Ctrl+C without selection passes through to xterm (returns true -> SIGINT)
    record.selection = ''
    const sigintEvent = new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, cancelable: true })
    expect(record.emitKeyEvent?.(sigintEvent)).toBe(true)

    // 3. Ctrl+V reads clipboard and pastes into active session
    const pasteEvent = new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, cancelable: true })
    expect(record.emitKeyEvent?.(pasteEvent)).toBe(false)
    await vi.waitFor(() => {
      expect(onWriteSession).toHaveBeenCalledWith('term-1', 'echo pasted')
    })

    // 4. Right-click on terminal container prevents default and pastes clipboard text
    readClipboardText.mockResolvedValueOnce('echo right-click')
    const instanceEl = screen.getByTestId('terminal-instance-term-1')
    const contextMenuEvent = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    instanceEl.dispatchEvent(contextMenuEvent)
    expect(contextMenuEvent.defaultPrevented).toBe(true)
    await vi.waitFor(() => {
      expect(onWriteSession).toHaveBeenCalledWith('term-1', 'echo right-click')
    })
  })

  it('activates http/https URLs and workspace-scoped file:line:col links only on Ctrl+click, blocking unsafe schemes and outside paths', () => {
    const { factory, records } = createMockXtermFactory()
    const onOpenExternalUrl = vi.fn()
    const onOpenWorkspaceFile = vi.fn()

    render(
      <TerminalPanel
        isOpen
        height={240}
        heightBounds={{ min: 120, max: 500, defaultHeight: 240 }}
        theme="dark"
        tabs={[SAMPLE_TABS[0]]}
        activeTabId="term-1"
        workspaceRootPath="C:\\wiki-a"
        errorMessage={null}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onNewTerminal={vi.fn()}
        onCollapse={vi.fn()}
        onResizeHeight={vi.fn()}
        onWriteSession={vi.fn()}
        onResizeSession={vi.fn()}
        subscribeSessionData={() => () => undefined}
        onOpenExternalUrl={onOpenExternalUrl}
        onOpenWorkspaceFile={onOpenWorkspaceFile}
        createXtermInstance={factory}
      />
    )

    const record = records.get('term-1')!
    const plainClick = new MouseEvent('click', { ctrlKey: false, metaKey: false })
    const ctrlClick = new MouseEvent('click', { ctrlKey: true })

    // Plain click without Ctrl/Cmd does not activate links
    record.emitActivateLink?.('https://example.com', plainClick)
    record.emitActivateLink?.('docs/guide.md:12', plainClick)
    expect(onOpenExternalUrl).not.toHaveBeenCalled()
    expect(onOpenWorkspaceFile).not.toHaveBeenCalled()

    // Ctrl+click on http/https URLs opens external browser
    record.emitActivateLink?.('https://example.com/docs?q=1', ctrlClick)
    expect(onOpenExternalUrl).toHaveBeenCalledWith('https://example.com/docs?q=1')

    // Unsafe schemes are blocked
    record.emitActivateLink?.('javascript:alert(1)', ctrlClick)
    record.emitActivateLink?.('file:///C:/Windows/win.ini', ctrlClick)
    record.emitActivateLink?.('cmd:calc', ctrlClick)
    expect(onOpenExternalUrl).toHaveBeenCalledTimes(1)

    // Ctrl+click on workspace-relative and workspace-absolute file links with :line and :line:col
    record.emitActivateLink?.('docs/guide.md:12:4', ctrlClick)
    expect(onOpenWorkspaceFile).toHaveBeenCalledWith('C:\\wiki-a\\docs\\guide.md', 12, 4)

    record.emitActivateLink?.('C:\\wiki-a\\note.md:5', ctrlClick)
    expect(onOpenWorkspaceFile).toHaveBeenCalledWith('C:\\wiki-a\\note.md', 5, undefined)

    // Outside workspace paths are ignored
    record.emitActivateLink?.('../outside.md:3', ctrlClick)
    record.emitActivateLink?.('C:\\other\\secret.md:10', ctrlClick)
    expect(onOpenWorkspaceFile).toHaveBeenCalledTimes(2)
  })
})
