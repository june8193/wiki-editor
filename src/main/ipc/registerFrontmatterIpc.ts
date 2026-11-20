import { FRONTMATTER_IPC_CHANNELS } from '@shared/ipc'
import type { LogService } from '../logging/LogService'
import type { FrontmatterSchemaService } from '../workspace/FrontmatterSchemaService'
import {
  broadcastIpcEvent,
  type IpcHandlerTuple,
  type IpcMainLike,
  type IpcSessionSource,
  registerIpcHandlers,
  resolveIpcSessionSource,
  resolveSenderWebContents,
  subscribeIpcSessions,
  type WebContentsLike
} from './ipcHelpers'

export interface FrontmatterIpcSession {
  frontmatterSchemaService: FrontmatterSchemaService
  getTargets: () => WebContentsLike[]
}

export type FrontmatterIpcSessionSource = IpcSessionSource<FrontmatterIpcSession>

export interface RegisterFrontmatterIpcOptions {
  ipcMain: IpcMainLike
  sessionSource?: FrontmatterIpcSessionSource
  frontmatterSchemaService?: FrontmatterSchemaService
  getTargets?: () => WebContentsLike[]
  logService?: LogService
}

/**
 * Registers frontmatter:* IPC handlers scoped strictly to the caller's workspace session
 * and broadcasts schema change events to all live renderer windows in that session.
 */
export function registerFrontmatterIpc({
  ipcMain,
  sessionSource,
  frontmatterSchemaService,
  getTargets,
  logService
}: RegisterFrontmatterIpcOptions): () => void {
  const source = resolveIpcSessionSource(
    sessionSource,
    frontmatterSchemaService && getTargets
      ? { frontmatterSchemaService, getTargets }
      : undefined,
    'registerFrontmatterIpc requires either sessionSource or frontmatterSchemaService and getTargets'
  )

  const unsubscribeSessions = subscribeIpcSessions(
    source,
    (session) => session.frontmatterSchemaService,
    (session) =>
      session.frontmatterSchemaService.onSchemaChanged((result) => {
        broadcastIpcEvent(session.getTargets, FRONTMATTER_IPC_CHANNELS.schemaChanged, result)
      })
  )

  const requireSession = (event: unknown): FrontmatterIpcSession => {
    const sender = resolveSenderWebContents(event)
    const session = source.resolveSession(sender)
    if (!session) {
      throw new Error('열린 워크스페이스가 없습니다.')
    }
    return session
  }

  const handlers: readonly IpcHandlerTuple[] = [
    [
      FRONTMATTER_IPC_CHANNELS.getSchema,
      (event) => requireSession(event).frontmatterSchemaService.getSchema()
    ],
    [
      FRONTMATTER_IPC_CHANNELS.createDefaultSchema,
      (event) => requireSession(event).frontmatterSchemaService.createDefaultSchema()
    ],
    [
      FRONTMATTER_IPC_CHANNELS.saveSchema,
      (event, schema) => requireSession(event).frontmatterSchemaService.saveSchema(schema)
    ]
  ]

  const removeHandlers = registerIpcHandlers(ipcMain, handlers, { logService })

  return () => {
    unsubscribeSessions()
    removeHandlers()
  }
}
