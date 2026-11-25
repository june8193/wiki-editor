import { describe, expect, it, vi } from 'vitest'
import { TERMINAL_IPC_CHANNELS } from '@shared/ipc'
import type { TerminalShellProfile } from '@shared/terminal'
import type { PtyFactory, PtyProcessLike } from '../terminal/TerminalService'
import { TerminalService } from '../terminal/TerminalService'
import type { WebContentsLike } from './ipcHelpers'
import { createFakeIpcMain } from './ipcTestHelpers'
import { registerTerminalIpc, type TerminalIpcSession } from './registerTerminalIpc'

interface FakePtyEntry {
  pty: PtyProcessLike
  written: string[]
  resizes: Array<{ cols: number; rows: number }>
  killed: boolean
  emitData: (data: string) => void
  emitExit: (exitCode: number) => void
}

function createTestPtyFactory(): { factory: PtyFactory; entries: FakePtyEntry[] } {
  const entries: FakePtyEntry[] = []
  let nextPid = 5000

  const factory: PtyFactory = () => {
    const dataListeners = new Set<(data: string) => void>()
    const exitListeners = new Set<(event: { exitCode: number }) => void>()
    const entry: FakePtyEntry = {
      written: [],
      resizes: [],
      killed: false,
      emitData: (data) => {
        for (const listener of dataListeners) listener(data)
      },
      emitExit: (exitCode) => {
        for (const listener of exitListeners) listener({ exitCode })
      },
      pty: {
        pid: nextPid++,
        write: (data) => entry.written.push(data),
        resize: (cols, rows) => entry.resizes.push({ cols, rows }),
        kill: () => {
          entry.killed = true
        },
        onData: (listener) => {
          dataListeners.add(listener)
          return { dispose: () => dataListeners.delete(listener) }
        },
        onExit: (listener) => {
          exitListeners.add(listener)
          return { dispose: () => exitListeners.delete(listener) }
        }
      }
    }
    entries.push(entry)
    return entry.pty
  }

  return { factory, entries }
}

const TEST_PROFILES: TerminalShellProfile[] = [
  {
    id: 'pwsh',
    label: 'PowerShell',
    executable: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    args: ['-NoLogo'],
    isDefault: true
  }
]

describe('registerTerminalIpc', () => {
  it('routes terminal lifecycle IPC for main window, isolates events from auxiliary/other windows, and cleans up on workspace switch & dispose', async () => {
    const ipcMain = createFakeIpcMain()
    const { factory, entries } = createTestPtyFactory()
    let workspaceRoot: string | null = 'C:\\wiki-a'
    const rootListeners = new Set<(rootPath: string | null) => void>()

    const terminalService = new TerminalService({
      getWorkspaceRoot: () => workspaceRoot,
      listProfiles: () => TEST_PROFILES,
      ptyFactory: factory
    })

    const mainMessages: Array<{ channel: string; payload: unknown }> = []
    const auxMessages: Array<{ channel: string; payload: unknown }> = []
    const otherMainMessages: Array<{ channel: string; payload: unknown }> = []

    const mainTarget: WebContentsLike = {
      isDestroyed: () => false,
      send: (channel, payload) => mainMessages.push({ channel, payload })
    }
    const auxTarget: WebContentsLike = {
      isDestroyed: () => false,
      send: (channel, payload) => auxMessages.push({ channel, payload })
    }
    const otherMainTarget: WebContentsLike = {
      isDestroyed: () => false,
      send: (channel, payload) => otherMainMessages.push({ channel, payload })
    }

    const session: TerminalIpcSession = {
      terminalService,
      getWorkspaceRoot: () => workspaceRoot,
      onWorkspaceRootChanged: (listener) => {
        rootListeners.add(listener)
        return () => rootListeners.delete(listener)
      },
      isMainWindow: (sender) => sender === mainTarget,
      getMainWindowTarget: () => mainTarget
    }

    const openExternal = vi.fn(async () => undefined)
    const dispose = registerTerminalIpc({
      ipcMain,
      sessionSource: {
        resolveSession: (sender) => (sender === mainTarget || sender === auxTarget ? session : undefined),
        forEachSession: (visitor) => visitor(session)
      },
      openExternal
    })

    // Auxiliary window is blocked from all terminal IPC calls
    await expect(
      ipcMain.invokeFrom(auxTarget, TERMINAL_IPC_CHANNELS.listProfiles)
    ).rejects.toThrow(/main window/i)
    await expect(
      ipcMain.invokeFrom(auxTarget, TERMINAL_IPC_CHANNELS.createSession, { cols: 80, rows: 24 })
    ).rejects.toThrow(/main window/i)
    await expect(
      ipcMain.invokeFrom(auxTarget, TERMINAL_IPC_CHANNELS.openExternalUrl, 'https://example.com')
    ).rejects.toThrow(/main window/i)

    // Unknown window is blocked
    await expect(
      ipcMain.invokeFrom(otherMainTarget, TERMINAL_IPC_CHANNELS.createSession, { cols: 80, rows: 24 })
    ).rejects.toThrow(/main window/i)

    // Main window can list profiles and create a session
    expect(await ipcMain.invokeFrom(mainTarget, TERMINAL_IPC_CHANNELS.listProfiles)).toEqual(
      TEST_PROFILES
    )
    const created = (await ipcMain.invokeFrom(mainTarget, TERMINAL_IPC_CHANNELS.createSession, {
      cols: 100,
      rows: 30
    })) as { id: string }

    await ipcMain.invokeFrom(mainTarget, TERMINAL_IPC_CHANNELS.write, created.id, 'dir\r')
    await ipcMain.invokeFrom(mainTarget, TERMINAL_IPC_CHANNELS.resize, created.id, 120, 40)
    expect(entries[0].written).toEqual(['dir\r'])
    expect(entries[0].resizes).toEqual([{ cols: 120, rows: 40 }])

    // Data and exit events only go to owning mainTarget
    entries[0].emitData('hello\r\n')
    expect(mainMessages).toEqual([
      { channel: TERMINAL_IPC_CHANNELS.data, payload: { sessionId: created.id, data: 'hello\r\n' } }
    ])
    expect(auxMessages).toEqual([])
    expect(otherMainMessages).toEqual([])

    // Workspace switch closes all active PTY sessions without confirmation
    workspaceRoot = 'C:\\wiki-b'
    for (const listener of rootListeners) listener(workspaceRoot)
    expect(entries[0].killed).toBe(true)
    expect(terminalService.getSessionCount()).toBe(0)

    // Workspace closed (null) rejects createSession
    workspaceRoot = null
    for (const listener of rootListeners) listener(null)
    await expect(
      ipcMain.invokeFrom(mainTarget, TERMINAL_IPC_CHANNELS.createSession, { cols: 80, rows: 24 })
    ).rejects.toThrow(/워크스페이스|workspace/i)

    // openExternalUrl allows http/https and blocks unsafe schemes or control characters
    expect(
      await ipcMain.invokeFrom(
        mainTarget,
        TERMINAL_IPC_CHANNELS.openExternalUrl,
        'https://example.com/docs?q=1'
      )
    ).toBe(true)
    expect(openExternal).toHaveBeenCalledWith('https://example.com/docs?q=1')

    expect(
      await ipcMain.invokeFrom(
        mainTarget,
        TERMINAL_IPC_CHANNELS.openExternalUrl,
        'file:///C:/Windows/System32/calc.exe'
      )
    ).toBe(false)
    expect(
      await ipcMain.invokeFrom(
        mainTarget,
        TERMINAL_IPC_CHANNELS.openExternalUrl,
        'javascript:alert(1)'
      )
    ).toBe(false)
    expect(
      await ipcMain.invokeFrom(
        mainTarget,
        TERMINAL_IPC_CHANNELS.openExternalUrl,
        'https://example.com\n--evil'
      )
    ).toBe(false)
    expect(openExternal).toHaveBeenCalledTimes(1)

    dispose()
    expect(ipcMain.hasHandler(TERMINAL_IPC_CHANNELS.createSession)).toBe(false)
  })
})
