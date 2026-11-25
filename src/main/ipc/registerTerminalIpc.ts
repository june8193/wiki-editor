import { TERMINAL_IPC_CHANNELS } from '@shared/ipc'
import type { TerminalCreateRequest } from '@shared/terminal'
import { inspectUriScheme } from '@shared/urlSecurity'
import type { LogService } from '../logging/LogService'
import type { TerminalService } from '../terminal/TerminalService'
import {
  type IpcHandlerTuple,
  type IpcMainLike,
  type IpcSessionSource,
  registerIpcHandlers,
  resolveSenderWebContents,
  subscribeIpcSessions,
  type WebContentsLike
} from './ipcHelpers'

export interface TerminalIpcSession {
  terminalService: TerminalService
  getWorkspaceRoot: () => string | null
  onWorkspaceRootChanged: (listener: (rootPath: string | null) => void) => () => void
  isMainWindow: (sender: WebContentsLike | undefined) => boolean
  getMainWindowTarget: () => WebContentsLike | undefined
}

export type TerminalIpcSessionSource = IpcSessionSource<TerminalIpcSession>

export interface RegisterTerminalIpcOptions {
  ipcMain: IpcMainLike
  sessionSource: TerminalIpcSessionSource
  openExternal: (url: string) => Promise<void>
  logService?: LogService
}

const ALLOWED_EXTERNAL_URL_SCHEMES = new Set(['http', 'https'])

function isAllowedExternalUrl(rawUrl: unknown): rawUrl is string {
  if (typeof rawUrl !== 'string') return false
  const trimmed = rawUrl.trim()
  if (!trimmed) return false
  const { valid, scheme } = inspectUriScheme(trimmed)
  if (!valid || !scheme || !ALLOWED_EXTERNAL_URL_SCHEMES.has(scheme)) {
    return false
  }
  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Registers terminal:* IPC handlers restricted to main windows with an open workspace,
 * forwarding PTY output/exit events exclusively to the owning main window.
 */
export function registerTerminalIpc({
  ipcMain,
  sessionSource,
  openExternal,
  logService
}: RegisterTerminalIpcOptions): () => void {
  const sendToMainTarget = (
    session: TerminalIpcSession,
    channel: string,
    payload: unknown
  ): void => {
    const target = session.getMainWindowTarget()
    if (target && !target.isDestroyed()) {
      target.send(channel, payload)
    }
  }

  const unsubscribeSessions = subscribeIpcSessions(
    sessionSource,
    (session) => session.terminalService,
    (session) => {
      const unsubData = session.terminalService.onData((event) => {
        sendToMainTarget(session, TERMINAL_IPC_CHANNELS.data, event)
      })
      const unsubExit = session.terminalService.onExit((event) => {
        sendToMainTarget(session, TERMINAL_IPC_CHANNELS.exit, event)
      })
      const unsubRootChanged = session.onWorkspaceRootChanged(() => {
        session.terminalService.closeAllSessions()
      })
      return () => {
        unsubData()
        unsubExit()
        unsubRootChanged()
      }
    }
  )

  const requireMainSession = (event: unknown): TerminalIpcSession => {
    const sender = resolveSenderWebContents(event)
    const session = sessionSource.resolveSession(sender)
    if (!session || !session.isMainWindow(sender)) {
      throw new Error('Only the main window can access the terminal')
    }
    return session
  }

  const requireMainWorkspaceSession = (event: unknown): TerminalIpcSession => {
    const session = requireMainSession(event)
    if (!session.getWorkspaceRoot()) {
      throw new Error('열린 워크스페이스가 없습니다.')
    }
    return session
  }

  const handlers: readonly IpcHandlerTuple[] = [
    [
      TERMINAL_IPC_CHANNELS.listProfiles,
      (event) => requireMainSession(event).terminalService.listProfiles()
    ],
    [
      TERMINAL_IPC_CHANNELS.createSession,
      (event, request) => {
        const session = requireMainWorkspaceSession(event)
        const payload =
          request && typeof request === 'object'
            ? (request as TerminalCreateRequest)
            : { cols: 80, rows: 24 }
        return session.terminalService.createSession(payload)
      }
    ],
    [
      TERMINAL_IPC_CHANNELS.write,
      (event, sessionId, data) => {
        const session = requireMainWorkspaceSession(event)
        if (typeof sessionId !== 'string' || typeof data !== 'string') {
          throw new Error('Invalid terminal write arguments')
        }
        session.terminalService.write(sessionId, data)
      }
    ],
    [
      TERMINAL_IPC_CHANNELS.resize,
      (event, sessionId, cols, rows) => {
        const session = requireMainWorkspaceSession(event)
        if (typeof sessionId !== 'string') {
          throw new Error('Invalid terminal resize arguments')
        }
        session.terminalService.resize(sessionId, Number(cols), Number(rows))
      }
    ],
    [
      TERMINAL_IPC_CHANNELS.closeSession,
      (event, sessionId) => {
        const session = requireMainWorkspaceSession(event)
        if (typeof sessionId !== 'string') {
          throw new Error('Invalid terminal sessionId')
        }
        session.terminalService.closeSession(sessionId)
      }
    ],
    [
      TERMINAL_IPC_CHANNELS.openExternalUrl,
      async (event, rawUrl) => {
        requireMainSession(event)
        if (!isAllowedExternalUrl(rawUrl)) {
          return false
        }
        await openExternal(rawUrl.trim())
        return true
      }
    ]
  ]

  const removeHandlers = registerIpcHandlers(ipcMain, handlers, { logService })

  return () => {
    unsubscribeSessions()
    removeHandlers()
  }
}
