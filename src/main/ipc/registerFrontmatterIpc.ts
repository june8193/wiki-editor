import { FRONTMATTER_IPC_CHANNELS } from '@shared/ipc'
import type { WorkspaceQueryAndSchemaHub } from '@shared/workspaceQueryAndSchema'
import type { LogService } from '../logging/LogService'
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
  queryAndSchemaHub: WorkspaceQueryAndSchemaHub
  getTargets: () => WebContentsLike[]
}

export type FrontmatterIpcSessionSource = IpcSessionSource<FrontmatterIpcSession>

export interface RegisterFrontmatterIpcOptions {
  ipcMain: IpcMainLike
  sessionSource?: FrontmatterIpcSessionSource
  queryAndSchemaHub?: WorkspaceQueryAndSchemaHub
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
  queryAndSchemaHub,
  getTargets,
  logService
}: RegisterFrontmatterIpcOptions): () => void {
  const source = resolveIpcSessionSource(
    sessionSource,
    queryAndSchemaHub && getTargets ? { queryAndSchemaHub, getTargets } : undefined,
    'registerFrontmatterIpc requires either sessionSource or queryAndSchemaHub and getTargets'
  )

  const unsubscribeSessions = subscribeIpcSessions(
    source,
    (session) => session.queryAndSchemaHub,
    (session) =>
      session.queryAndSchemaHub.onSchemaChanged((result) => {
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
      (event) => requireSession(event).queryAndSchemaHub.getSchema()
    ],
    [
      FRONTMATTER_IPC_CHANNELS.createDefaultSchema,
      (event) => requireSession(event).queryAndSchemaHub.createDefaultSchema()
    ],
    [
      FRONTMATTER_IPC_CHANNELS.saveSchema,
      (event, schema) => requireSession(event).queryAndSchemaHub.saveSchema(schema)
    ],
    [
      FRONTMATTER_IPC_CHANNELS.getFieldValues,
      (event, fieldKeys) => {
        const session = requireSession(event)
        const normalizedKeys = Array.isArray(fieldKeys)
          ? fieldKeys.filter((item): item is string => typeof item === 'string')
          : undefined
        return session.queryAndSchemaHub.collectFieldValues(normalizedKeys)
      }
    ]
  ]

  const removeHandlers = registerIpcHandlers(ipcMain, handlers, { logService })

  return () => {
    unsubscribeSessions()
    removeHandlers()
  }
}
