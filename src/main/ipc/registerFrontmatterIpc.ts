import { FRONTMATTER_IPC_CHANNELS } from '@shared/ipc'
import type { LogService } from '../logging/LogService'
import type { FrontmatterSchemaService } from '../workspace/FrontmatterSchemaService'
import {
  broadcastIpcEvent,
  type IpcHandlerTuple,
  type IpcMainLike,
  registerIpcHandlers,
  resolveSenderWebContents,
  type WebContentsLike
} from './ipcHelpers'

export interface FrontmatterIpcSession {
  frontmatterSchemaService: FrontmatterSchemaService
  getTargets: () => WebContentsLike[]
}

export interface FrontmatterIpcSessionSource {
  resolveSession: (sender: WebContentsLike | undefined) => FrontmatterIpcSession | undefined
  forEachSession: (visitor: (session: FrontmatterIpcSession) => void) => void
  onSessionCreated?: (
    listener: (session: FrontmatterIpcSession) => (() => void) | void
  ) => () => void
}

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
  let source: FrontmatterIpcSessionSource
  if (sessionSource) {
    source = sessionSource
  } else {
    if (!frontmatterSchemaService || !getTargets) {
      throw new Error(
        'registerFrontmatterIpc requires either sessionSource or frontmatterSchemaService and getTargets'
      )
    }
    const singleSession: FrontmatterIpcSession = {
      frontmatterSchemaService,
      getTargets
    }
    source = {
      resolveSession: () => singleSession,
      forEachSession: (visitor) => visitor(singleSession)
    }
  }

  const schemaUnsubscribers = new Map<FrontmatterSchemaService, () => void>()
  const attachSession = (session: FrontmatterIpcSession): (() => void) | undefined => {
    if (schemaUnsubscribers.has(session.frontmatterSchemaService)) {
      return undefined
    }
    const unsubscribe = session.frontmatterSchemaService.onSchemaChanged((result) => {
      broadcastIpcEvent(session.getTargets, FRONTMATTER_IPC_CHANNELS.schemaChanged, result)
    })
    schemaUnsubscribers.set(session.frontmatterSchemaService, unsubscribe)
    return () => {
      schemaUnsubscribers.get(session.frontmatterSchemaService)?.()
      schemaUnsubscribers.delete(session.frontmatterSchemaService)
    }
  }

  const unsubscribeSessionCreated = source.onSessionCreated?.((session) => attachSession(session))
  source.forEachSession((session) => {
    attachSession(session)
  })

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
    unsubscribeSessionCreated?.()
    for (const unsubscribe of schemaUnsubscribers.values()) {
      unsubscribe()
    }
    schemaUnsubscribers.clear()
    removeHandlers()
  }
}
