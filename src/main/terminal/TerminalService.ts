import { spawn as spawnNodePty } from 'node-pty'
import {
  TERMINAL_DEFAULT_COLS,
  TERMINAL_DEFAULT_ROWS,
  TERMINAL_MAX_COLS,
  TERMINAL_MAX_ROWS,
  TERMINAL_MIN_COLS,
  TERMINAL_MIN_ROWS,
  type TerminalCreateRequest,
  type TerminalDataEvent,
  type TerminalExitEvent,
  type TerminalSessionInfo,
  type TerminalShellProfile
} from '@shared/terminal'
import type { LogService } from '../logging/LogService'
import { detectWindowsShellProfiles } from './shellProfiles'

export interface PtyDisposableLike {
  dispose(): void
}

export interface PtyProcessLike {
  readonly pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
  onData(listener: (data: string) => void): PtyDisposableLike | void
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): PtyDisposableLike | void
}

export interface PtySpawnOptions {
  name: string
  cols: number
  rows: number
  cwd: string
  env?: Record<string, string | undefined>
}

export type PtyFactory = (
  executable: string,
  args: string[],
  options: PtySpawnOptions
) => PtyProcessLike

export interface TerminalServiceOptions {
  getWorkspaceRoot: () => string | null
  listProfiles?: () => TerminalShellProfile[]
  ptyFactory?: PtyFactory
  logService?: LogService
}

interface ActivePtySession {
  info: TerminalSessionInfo
  pty: PtyProcessLike
  dataDisposable?: PtyDisposableLike | void
  exitDisposable?: PtyDisposableLike | void
}

function clampTerminalDimension(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }
  return Math.max(min, Math.min(max, Math.floor(value)))
}

function defaultPtyFactory(
  executable: string,
  args: string[],
  options: PtySpawnOptions
): PtyProcessLike {
  return spawnNodePty(executable, args, {
    name: options.name,
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env: options.env as Record<string, string> | undefined,
    useConpty: process.platform === 'win32'
  })
}

/**
 * Manages lazy ConPTY/node-pty terminal sessions scoped to a single workspace session.
 */
export class TerminalService {
  private readonly getWorkspaceRoot: () => string | null
  private readonly listProfilesImpl: () => TerminalShellProfile[]
  private readonly ptyFactory: PtyFactory
  private readonly logService?: LogService

  private readonly sessions = new Map<string, ActivePtySession>()
  private readonly dataListeners = new Set<(event: TerminalDataEvent) => void>()
  private readonly exitListeners = new Set<(event: TerminalExitEvent) => void>()
  private nextSessionSeq = 1
  private disposed = false

  constructor(options: TerminalServiceOptions) {
    this.getWorkspaceRoot = options.getWorkspaceRoot
    this.listProfilesImpl = options.listProfiles ?? (() => detectWindowsShellProfiles())
    this.ptyFactory = options.ptyFactory ?? defaultPtyFactory
    this.logService = options.logService
  }

  listProfiles(): TerminalShellProfile[] {
    return this.listProfilesImpl()
  }

  createSession(request: TerminalCreateRequest): TerminalSessionInfo {
    if (this.disposed) {
      throw new Error('TerminalService is disposed')
    }
    const workspaceRoot = this.getWorkspaceRoot()
    if (!workspaceRoot) {
      throw new Error('열린 워크스페이스가 없습니다.')
    }

    const profiles = this.listProfiles()
    const profile = this.resolveAllowedProfile(profiles, request.profileId)
    const cols = clampTerminalDimension(
      request.cols,
      TERMINAL_DEFAULT_COLS,
      TERMINAL_MIN_COLS,
      TERMINAL_MAX_COLS
    )
    const rows = clampTerminalDimension(
      request.rows,
      TERMINAL_DEFAULT_ROWS,
      TERMINAL_MIN_ROWS,
      TERMINAL_MAX_ROWS
    )

    const sessionId = `term-${this.nextSessionSeq++}`
    const pty = this.ptyFactory(profile.executable, [...profile.args], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: workspaceRoot,
      env: process.env
    })

    const info: TerminalSessionInfo = {
      id: sessionId,
      profileId: profile.id,
      title: profile.label,
      cwd: workspaceRoot,
      pid: pty.pid,
      isRunning: true
    }

    const record: ActivePtySession = { info, pty }
    this.sessions.set(sessionId, record)

    record.dataDisposable = pty.onData((data) => {
      if (this.disposed || !this.sessions.has(sessionId)) return
      const event: TerminalDataEvent = { sessionId, data }
      for (const listener of this.dataListeners) {
        listener(event)
      }
    })

    record.exitDisposable = pty.onExit(({ exitCode, signal }) => {
      const current = this.sessions.get(sessionId)
      if (!current) return
      this.cleanupSessionRecord(sessionId, current, false)
      const event: TerminalExitEvent = {
        sessionId,
        exitCode: typeof exitCode === 'number' ? exitCode : null,
        ...(typeof signal === 'number' ? { signal } : {})
      }
      for (const listener of this.exitListeners) {
        listener(event)
      }
    })

    void this.logService?.info('app', 'Created terminal PTY session', {
      data: {
        sessionId,
        profileId: profile.id,
        pid: pty.pid,
        cols,
        rows
      }
    })

    return { ...info }
  }

  write(sessionId: string, data: string): void {
    const record = this.requireActiveSession(sessionId)
    record.pty.write(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const record = this.requireActiveSession(sessionId)
    const safeCols = clampTerminalDimension(
      cols,
      TERMINAL_DEFAULT_COLS,
      TERMINAL_MIN_COLS,
      TERMINAL_MAX_COLS
    )
    const safeRows = clampTerminalDimension(
      rows,
      TERMINAL_DEFAULT_ROWS,
      TERMINAL_MIN_ROWS,
      TERMINAL_MAX_ROWS
    )
    record.pty.resize(safeCols, safeRows)
  }

  closeSession(sessionId: string): void {
    const record = this.sessions.get(sessionId)
    if (!record) return
    this.cleanupSessionRecord(sessionId, record, true)
  }

  closeAllSessions(): void {
    for (const [sessionId, record] of Array.from(this.sessions.entries())) {
      this.cleanupSessionRecord(sessionId, record, true)
    }
  }

  getSessionCount(): number {
    return this.sessions.size
  }

  onData(listener: (event: TerminalDataEvent) => void): () => void {
    this.dataListeners.add(listener)
    return () => {
      this.dataListeners.delete(listener)
    }
  }

  onExit(listener: (event: TerminalExitEvent) => void): () => void {
    this.exitListeners.add(listener)
    return () => {
      this.exitListeners.delete(listener)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.closeAllSessions()
    this.dataListeners.clear()
    this.exitListeners.clear()
  }

  private resolveAllowedProfile(
    profiles: TerminalShellProfile[],
    requestedProfileId?: string
  ): TerminalShellProfile {
    if (profiles.length === 0) {
      throw new Error('No available terminal shell profiles')
    }
    if (requestedProfileId === undefined) {
      return profiles.find((profile) => profile.isDefault) ?? profiles[0]
    }
    const matched = profiles.find((profile) => profile.id === requestedProfileId)
    if (!matched) {
      throw new Error(`Unsupported terminal profile: ${requestedProfileId}`)
    }
    return matched
  }

  private requireActiveSession(sessionId: string): ActivePtySession {
    if (this.disposed) {
      throw new Error('TerminalService is disposed')
    }
    const record = this.sessions.get(sessionId)
    if (!record || !record.info.isRunning) {
      throw new Error(`Unknown or closed terminal session: ${sessionId}`)
    }
    return record
  }

  private cleanupSessionRecord(
    sessionId: string,
    record: ActivePtySession,
    killProcess: boolean
  ): void {
    record.info.isRunning = false
    this.sessions.delete(sessionId)
    record.dataDisposable?.dispose()
    record.exitDisposable?.dispose()
    if (killProcess) {
      try {
        record.pty.kill()
      } catch {
        // Process may already have exited
      }
    }
  }
}
