import { describe, expect, it, vi } from 'vitest'
import type { TerminalDataEvent, TerminalExitEvent, TerminalShellProfile } from '@shared/terminal'
import { type PtyFactory, type PtyProcessLike, TerminalService } from './TerminalService'

interface FakePtyControl {
  pty: PtyProcessLike
  written: string[]
  resizes: Array<{ cols: number; rows: number }>
  killed: boolean
  emitData: (data: string) => void
  emitExit: (exitCode: number, signal?: number) => void
}

function createFakePtyFactory(): {
  factory: PtyFactory
  spawnCalls: Array<{
    executable: string
    args: string[]
    options: { name: string; cols: number; rows: number; cwd: string }
  }>
  controls: FakePtyControl[]
} {
  const spawnCalls: Array<{
    executable: string
    args: string[]
    options: { name: string; cols: number; rows: number; cwd: string }
  }> = []
  const controls: FakePtyControl[] = []
  let nextPid = 4100

  const factory: PtyFactory = (executable, args, options) => {
    spawnCalls.push({ executable, args: [...args], options })
    const dataListeners = new Set<(data: string) => void>()
    const exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>()
    const written: string[] = []
    const resizes: Array<{ cols: number; rows: number }> = []
    const pid = nextPid++

    const control: FakePtyControl = {
      written,
      resizes,
      killed: false,
      emitData: (data) => {
        for (const listener of dataListeners) {
          listener(data)
        }
      },
      emitExit: (exitCode, signal) => {
        for (const listener of exitListeners) {
          listener({ exitCode, ...(signal !== undefined ? { signal } : {}) })
        }
      },
      pty: {
        pid,
        write: (data) => {
          written.push(data)
        },
        resize: (cols, rows) => {
          resizes.push({ cols, rows })
        },
        kill: () => {
          control.killed = true
        },
        onData: (listener) => {
          dataListeners.add(listener)
          return {
            dispose: () => {
              dataListeners.delete(listener)
            }
          }
        },
        onExit: (listener) => {
          exitListeners.add(listener)
          return {
            dispose: () => {
              exitListeners.delete(listener)
            }
          }
        }
      }
    }

    controls.push(control)
    return control.pty
  }

  return { factory, spawnCalls, controls }
}

const TEST_PROFILES: TerminalShellProfile[] = [
  {
    id: 'pwsh',
    label: 'PowerShell',
    executable: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    args: ['-NoLogo'],
    isDefault: true
  },
  {
    id: 'cmd',
    label: 'Command Prompt',
    executable: 'C:\\Windows\\System32\\cmd.exe',
    args: [],
    isDefault: false
  }
]

describe('TerminalService', () => {
  it('lazily creates PTY sessions only on createSession using active workspace root and allowlisted profile', () => {
    let workspaceRoot: string | null = 'C:\\wiki-workspace'
    const { factory, spawnCalls, controls } = createFakePtyFactory()
    const service = new TerminalService({
      getWorkspaceRoot: () => workspaceRoot,
      listProfiles: () => TEST_PROFILES,
      ptyFactory: factory
    })

    // Lazy creation: no PTY spawned on service construction or profile listing
    expect(service.listProfiles()).toEqual(TEST_PROFILES)
    expect(spawnCalls).toHaveLength(0)

    const session = service.createSession({ cols: 120, rows: 32 })
    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0]).toMatchObject({
      executable: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      args: ['-NoLogo'],
      options: {
        cols: 120,
        rows: 32,
        cwd: 'C:\\wiki-workspace'
      }
    })
    expect(session).toMatchObject({
      profileId: 'pwsh',
      title: 'PowerShell',
      cwd: 'C:\\wiki-workspace',
      isRunning: true
    })

    const cmdSession = service.createSession({ profileId: 'cmd', cols: 80, rows: 24 })
    expect(cmdSession.profileId).toBe('cmd')
    expect(spawnCalls[1].executable).toBe('C:\\Windows\\System32\\cmd.exe')

    // Rejects unknown profileId (prevents arbitrary executable path injection)
    expect(() =>
      service.createSession({ profileId: 'C:\\evil\\malware.exe', cols: 80, rows: 24 })
    ).toThrow(/profile/i)

    // Rejects when no workspace is open
    workspaceRoot = null
    expect(() => service.createSession({ cols: 80, rows: 24 })).toThrow(/워크스페이스|workspace/i)

    expect(controls).toHaveLength(2)
    service.dispose()
  })

  it('forwards write, resize, onData, onExit, and kills PTYs on closeSession or closeAllSessions', () => {
    const { factory, controls } = createFakePtyFactory()
    const service = new TerminalService({
      getWorkspaceRoot: () => 'C:\\wiki-workspace',
      listProfiles: () => TEST_PROFILES,
      ptyFactory: factory
    })

    const dataEvents: TerminalDataEvent[] = []
    const exitEvents: TerminalExitEvent[] = []
    service.onData((event) => dataEvents.push(event))
    service.onExit((event) => exitEvents.push(event))

    const s1 = service.createSession({ cols: 100, rows: 30 })
    const s2 = service.createSession({ profileId: 'cmd', cols: 80, rows: 24 })

    service.write(s1.id, 'npm test\r')
    service.resize(s1.id, 140, 40)
    expect(controls[0].written).toEqual(['npm test\r'])
    expect(controls[0].resizes).toEqual([{ cols: 140, rows: 40 }])

    controls[0].emitData('PASS src/example.test.ts\r\n')
    expect(dataEvents).toEqual([
      { sessionId: s1.id, data: 'PASS src/example.test.ts\r\n' }
    ])

    // Close single session
    service.closeSession(s1.id)
    expect(controls[0].killed).toBe(true)
    expect(controls[1].killed).toBe(false)
    expect(() => service.write(s1.id, 'after-close')).toThrow(/session/i)

    // Natural exit on s2 emits onExit and cleans up
    controls[1].emitExit(0)
    expect(exitEvents).toEqual([{ sessionId: s2.id, exitCode: 0 }])

    // Close all remaining sessions
    const s3 = service.createSession({ cols: 80, rows: 24 })
    expect(service.getSessionCount()).toBe(1)
    service.closeAllSessions()
    expect(controls[2].killed).toBe(true)
    expect(service.getSessionCount()).toBe(0)
    expect(() => service.resize(s3.id, 90, 25)).toThrow(/session/i)
  })
})
