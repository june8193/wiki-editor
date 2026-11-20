import { types } from 'node:util'
import type {
  FrontmatterSchemaLoadResult,
  WorkspaceFrontmatterFieldValuesResponse,
  WorkspaceFrontmatterSchema
} from '@shared/frontmatter'
import type { GitDiffRequest } from '@shared/git'
import {
  BUFFER_IPC_CHANNELS,
  CLIPBOARD_IPC_CHANNELS,
  CONFIG_IPC_CHANNELS,
  DIAGRAM_IPC_CHANNELS,
  type DiagramSaveRequest,
  type DiagramSaveResult,
  FRONTMATTER_IPC_CHANNELS,
  GIT_IPC_CHANNELS,
  LOG_IPC_CHANNELS,
  WORKSPACE_IPC_CHANNELS,
  WORKSPACE_STATE_IPC_CHANNELS
} from '@shared/ipc'
import type { WorkspaceSearchRequest, WorkspaceSearchResponse } from '@shared/search'
import type { LogService } from '../logging/LogService'

export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void
  removeHandler(channel: string): void
}

export interface WebContentsLike {
  isDestroyed(): boolean
  send(channel: string, ...args: unknown[]): void
}

export type IpcHandlerTuple = readonly [
  string,
  (event: unknown, ...args: unknown[]) => unknown
]

export interface RegisterIpcHandlersOptions {
  logService?: LogService
}

const CHANNEL_METADATA_EXTRACTORS: Record<string, (args: unknown[]) => Record<string, unknown>> = {
  [WORKSPACE_IPC_CHANNELS.writeFile]: ([filePath, content]) => ({
    filePath,
    contentLength: typeof content === 'string' ? content.length : 0
  }),
  [WORKSPACE_IPC_CHANNELS.search]: ([request]) => {
    const req =
      request && typeof request === 'object' ? (request as Partial<WorkspaceSearchRequest>) : {}
    const opts = req.options && typeof req.options === 'object' ? req.options : undefined
    const fm = req.frontmatter && typeof req.frontmatter === 'object' ? req.frontmatter : undefined
    return {
      queryLength: typeof req.query === 'string' ? req.query.length : 0,
      caseSensitive: Boolean(opts?.caseSensitive),
      wholeWord: Boolean(opts?.wholeWord),
      useRegex: Boolean(opts?.useRegex),
      frontmatterConditionCount: Array.isArray(fm?.conditions) ? fm.conditions.length : 0,
      sortBy: fm?.sort?.by === 'frontmatter' ? 'frontmatter' : 'path'
    }
  },
  [WORKSPACE_IPC_CHANNELS.createEntry]: ([parentDirPath, name, kind, initialContent]) => ({
    parentDirPath,
    name,
    kind,
    contentLength: typeof initialContent === 'string' ? initialContent.length : 0
  }),
  [CONFIG_IPC_CHANNELS.saveRaw]: ([raw]) => ({
    contentLength: typeof raw === 'string' ? raw.length : 0
  }),
  [CLIPBOARD_IPC_CHANNELS.writeText]: ([text]) => ({
    textLength: typeof text === 'string' ? text.length : 0
  }),
  [GIT_IPC_CHANNELS.diff]: (args) => extractGitDiffMetadata(args),
  [DIAGRAM_IPC_CHANNELS.copyText]: ([text]) => ({
    textLength: typeof text === 'string' ? text.length : 0
  }),
  [DIAGRAM_IPC_CHANNELS.copyImage]: ([pngBytes]) => ({
    byteLength: types.isUint8Array(pngBytes) ? pngBytes.byteLength : 0
  }),
  [DIAGRAM_IPC_CHANNELS.saveFile]: ([request]) => {
    const req = request as Partial<DiagramSaveRequest> | undefined
    const format = req?.format === 'png' || req?.format === 'svg' ? req.format : 'unknown'
    if (types.isUint8Array(req?.data)) {
      return { format, byteLength: req.data.byteLength }
    }
    if (typeof req?.data === 'string') {
      return { format, textLength: req.data.length }
    }
    return format === 'svg' ? { format, textLength: 0 } : { format, byteLength: 0 }
  },
  [WORKSPACE_IPC_CHANNELS.ingestImage]: ([input]) => {
    const payload =
      input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
    const source =
      payload.source && typeof payload.source === 'object'
        ? (payload.source as Record<string, unknown>)
        : {}
    const bytes = source.bytes
    const byteLength =
      bytes instanceof Uint8Array || ArrayBuffer.isView(bytes) ? bytes.byteLength : undefined
    return {
      documentPath: payload.documentPath,
      sourceKind: source.kind,
      ...(typeof source.mimeType === 'string' ? { mimeType: source.mimeType } : {}),
      ...(typeof source.fileName === 'string' ? { fileName: source.fileName } : {}),
      ...(typeof source.filePath === 'string' ? { filePath: source.filePath } : {}),
      ...(byteLength !== undefined ? { byteLength } : {})
    }
  },
  [BUFFER_IPC_CHANNELS.openWorkspaceFile]: ([filePath, name, initialContent]) => ({
    filePath,
    name,
    hasInitialContent: typeof initialContent === 'string',
    contentLength: typeof initialContent === 'string' ? initialContent.length : 0
  }),
  [BUFFER_IPC_CHANNELS.updateContent]: ([key, nextContent]) => ({
    key,
    contentLength: typeof nextContent === 'string' ? nextContent.length : 0
  }),
  [BUFFER_IPC_CHANNELS.syncWindowTabs]: ([bufferKeys]) => ({
    tabCount: Array.isArray(bufferKeys) ? bufferKeys.length : 0
  }),
  [WORKSPACE_STATE_IPC_CHANNELS.get]: ([rootPath]) => ({
    rootPath
  }),
  [WORKSPACE_STATE_IPC_CHANNELS.save]: ([rootPath, update]) => {
    const payload =
      update && typeof update === 'object' ? (update as Record<string, unknown>) : {}
    const layout =
      payload.layout && typeof payload.layout === 'object'
        ? (payload.layout as Record<string, unknown>)
        : null
    const panes =
      layout?.panes && typeof layout.panes === 'object'
        ? (layout.panes as Record<string, unknown>)
        : null
    const countPaneTabs = (pane: unknown): number =>
      pane && typeof pane === 'object' && Array.isArray((pane as { tabs?: unknown }).tabs)
        ? ((pane as { tabs: unknown[] }).tabs).length
        : 0
    return {
      rootPath,
      ...(Array.isArray(payload.expandedDirs)
        ? { expandedDirCount: payload.expandedDirs.length }
        : {}),
      hasLayout: layout !== null,
      ...(panes ? { tabCount: countPaneTabs(panes.primary) + countPaneTabs(panes.secondary) } : {})
    }
  },
  [FRONTMATTER_IPC_CHANNELS.saveSchema]: ([schema]) => {
    const candidate =
      schema && typeof schema === 'object'
        ? (schema as Partial<WorkspaceFrontmatterSchema>)
        : undefined
    return {
      fieldCount: Array.isArray(candidate?.fields) ? candidate.fields.length : 0
    }
  },
  [FRONTMATTER_IPC_CHANNELS.getFieldValues]: ([fieldKeys]) => ({
    fieldKeyCount: Array.isArray(fieldKeys) ? fieldKeys.length : 0
  })
}

function extractFrontmatterResultMetadata(result: unknown): Record<string, unknown> {
  const res =
    result && typeof result === 'object' ? (result as Partial<FrontmatterSchemaLoadResult>) : {}
  return {
    exists: Boolean(res.exists),
    hasSchema: Boolean(res.schema),
    hasError: typeof res.error === 'string' && res.error.length > 0
  }
}

const CHANNEL_RESULT_METADATA_EXTRACTORS: Record<
  string,
  (result: unknown) => Record<string, unknown>
> = {
  [FRONTMATTER_IPC_CHANNELS.getSchema]: extractFrontmatterResultMetadata,
  [FRONTMATTER_IPC_CHANNELS.createDefaultSchema]: extractFrontmatterResultMetadata,
  [FRONTMATTER_IPC_CHANNELS.saveSchema]: extractFrontmatterResultMetadata,
  [FRONTMATTER_IPC_CHANNELS.getFieldValues]: (result) => {
    const res =
      result && typeof result === 'object'
        ? (result as Partial<WorkspaceFrontmatterFieldValuesResponse>)
        : {}
    const valuesByField =
      res.valuesByField && typeof res.valuesByField === 'object' ? res.valuesByField : {}
    return {
      fieldCount: Object.keys(valuesByField).length
    }
  },
  [DIAGRAM_IPC_CHANNELS.saveFile]: (result) => {
    const res = result as Partial<DiagramSaveResult> | undefined
    return typeof res?.canceled === 'boolean' ? { canceled: res.canceled } : {}
  },
  [WORKSPACE_IPC_CHANNELS.search]: (result) => {
    const res =
      result && typeof result === 'object' ? (result as Partial<WorkspaceSearchResponse>) : {}
    return {
      totalFileCount: typeof res.totalFileCount === 'number' ? res.totalFileCount : 0,
      totalMatchCount: typeof res.totalMatchCount === 'number' ? res.totalMatchCount : 0,
      truncated: Boolean(res.truncated),
      hasError: typeof res.error === 'string' && res.error.length > 0
    }
  }
}

function extractIpcMetadata(channel: string, args: unknown[]): Record<string, unknown> {
  const extractor = CHANNEL_METADATA_EXTRACTORS[channel]
  if (extractor) {
    return extractor(args)
  }
  return args.length > 0 ? { args } : {}
}

function wrapIpcHandler(
  channel: string,
  handler: (event: unknown, ...args: unknown[]) => unknown,
  logService?: LogService
): (event: unknown, ...args: unknown[]) => unknown {
  if (!logService || channel === LOG_IPC_CHANNELS.write) {
    return handler
  }

  return async (event: unknown, ...args: unknown[]) => {
    const startedAt = performance.now()
    const metadata = extractIpcMetadata(channel, args)
    const logOutcome = (success: boolean, error?: unknown, result?: unknown): Promise<void> => {
      const resultMetadata = success
        ? (CHANNEL_RESULT_METADATA_EXTRACTORS[channel]?.(result) ?? {})
        : {}
      const data = {
        channel,
        success,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        ...metadata,
        ...resultMetadata
      }
      return success
        ? logService.info('ipc', `IPC ${channel}`, { data })
        : logService.error('ipc', `IPC ${channel} failed`, { data, error })
    }

    try {
      const result = await handler(event, ...args)
      await logOutcome(true, undefined, result)
      return result
    } catch (error) {
      await logOutcome(false, error)
      throw error
    }
  }
}

export function registerIpcHandlers(
  ipcMain: IpcMainLike,
  handlers: readonly IpcHandlerTuple[],
  options: RegisterIpcHandlersOptions = {}
): () => void {
  for (const [channel, handler] of handlers) {
    ipcMain.handle(channel, wrapIpcHandler(channel, handler, options.logService))
  }

  return () => {
    for (const [channel] of handlers) {
      ipcMain.removeHandler(channel)
    }
  }
}

export function resolveSenderWebContents<T extends WebContentsLike = WebContentsLike>(
  event: unknown
): T | undefined {
  if (!event || typeof event !== 'object') return undefined
  const sender = (event as { sender?: unknown }).sender
  if (!sender || typeof sender !== 'object') return undefined
  return sender as T
}

export function broadcastIpcEvent(
  getTargets: () => WebContentsLike[],
  channel: string,
  payload: unknown
): void {
  for (const target of getTargets()) {
    if (!target.isDestroyed()) {
      target.send(channel, payload)
    }
  }
}

function extractGitDiffMetadata([workspacePath, request]: unknown[]): Record<string, unknown> {
  const req = request as Partial<GitDiffRequest> | undefined
  return {
    workspacePath,
    ...(req?.kind ? { kind: req.kind } : {}),
    ...(req?.path ? { path: req.path } : {}),
    ...(req?.kind === 'commit' && req.commitHash ? { commitHash: req.commitHash } : {}),
    ...(req?.kind === 'stash' && req.stashRef ? { stashRef: req.stashRef } : {}),
    ...(req?.kind === 'stash' && req.stashHash ? { stashHash: req.stashHash } : {})
  }
}

export interface IpcSessionSource<
  TSession,
  TWebContents extends WebContentsLike = WebContentsLike
> {
  resolveSession: (sender: TWebContents | undefined) => TSession | undefined
  forEachSession: (visitor: (session: TSession) => void) => void
  onSessionCreated?: (listener: (session: TSession) => (() => void) | void) => () => void
}

/**
 * Uses sessionSource when provided, or wraps a single-session fallback adapter.
 */
export function resolveIpcSessionSource<
  TSession,
  TWebContents extends WebContentsLike = WebContentsLike
>(
  sessionSource: IpcSessionSource<TSession, TWebContents> | undefined,
  fallbackSession: TSession | undefined,
  missingError: string
): IpcSessionSource<TSession, TWebContents> {
  if (sessionSource) {
    return sessionSource
  }
  if (!fallbackSession) {
    throw new Error(missingError)
  }
  return {
    resolveSession: () => fallbackSession,
    forEachSession: (visitor) => visitor(fallbackSession)
  }
}

/**
 * Attaches an event subscription to all existing and future sessions without duplicate bindings.
 */
export function subscribeIpcSessions<
  TSession,
  TKey,
  TWebContents extends WebContentsLike = WebContentsLike
>(
  source: IpcSessionSource<TSession, TWebContents>,
  getKey: (session: TSession) => TKey,
  subscribe: (session: TSession) => () => void
): () => void {
  const unsubscribers = new Map<TKey, () => void>()
  const attachSession = (session: TSession): (() => void) | undefined => {
    const key = getKey(session)
    if (unsubscribers.has(key)) {
      return undefined
    }
    const unsubscribe = subscribe(session)
    unsubscribers.set(key, unsubscribe)
    return () => {
      unsubscribers.get(key)?.()
      unsubscribers.delete(key)
    }
  }

  const unsubscribeSessionCreated = source.onSessionCreated?.((session) => attachSession(session))
  source.forEachSession((session) => {
    attachSession(session)
  })

  return () => {
    unsubscribeSessionCreated?.()
    for (const unsubscribe of unsubscribers.values()) {
      unsubscribe()
    }
    unsubscribers.clear()
  }
}
