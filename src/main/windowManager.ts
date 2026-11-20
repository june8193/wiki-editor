import type { BrowserWindowConstructorOptions } from 'electron'
import type { AutoSaveConfig } from '@shared/bufferAutoSaveScheduler'
import type { SharedBufferHubEvent } from '@shared/documentBuffer'
import { WINDOW_IPC_CHANNELS } from '@shared/ipc'
import type { SharedDocumentBufferHub } from '@shared/sharedDocumentBufferHub'
import {
  TabDragCoordinator,
  type BeforeInputKeyEventLike
} from '@shared/tabDragSession'
import {
  canDetachTabFromWindow,
  cloneTabTransferPayloads,
  computeOffsetAuxiliaryBounds,
  computeOffsetMainBounds,
  formatWindowTitle,
  WINDOW_ROLE_QUERY_PARAM,
  type AcceptTabDragDropInput,
  type AcceptTabDragDropResult,
  type ActiveTabDragSession,
  type DetachTabToNewWindowResult,
  type ScreenLike,
  type TabDragEndInput,
  type TabDragEndResult,
  type TabDragResolution,
  type TabDragStartInput,
  type TabTransferPayload,
  type WindowBounds,
  type WindowInitContext,
  type WindowRole
} from '@shared/window'
import {
  isSameWorkspacePath,
  type ActivateOrOpenWorkspaceResult,
  type FocusOpenWorkspaceResult,
  type OpenWorkspaceInNewWindowResult,
  type WorkspaceInfo
} from '@shared/workspace'
import type { ConfigService } from './config/ConfigService'
import type { WebContentsLike } from './ipc/ipcHelpers'
import {
  createSharedDocumentBufferHub,
  trackHubWindowWebContents,
  type BufferIpcSession,
  type BufferIpcSessionSource,
  type BufferWebContentsLike
} from './ipc/registerBufferIpc'
import type {
  FrontmatterIpcSession,
  FrontmatterIpcSessionSource
} from './ipc/registerFrontmatterIpc'
import type {
  WorkspaceIpcCoordinator,
  WorkspaceIpcSession
} from './ipc/registerWorkspaceIpc'
import type { LogService } from './logging/LogService'
import { createAuxiliaryWindowOptions, createMainWindowOptions } from './window'
import { FrontmatterSchemaService } from './workspace/FrontmatterSchemaService'
import {
  resolveValidWorkspaceDirectory,
  tryResolveRealWorkspacePath,
  WorkspaceFsService
} from './workspace/WorkspaceFsService'
import { WorkspaceSearchService } from './workspace/WorkspaceSearchService'

export interface WindowWebContentsLike extends BufferWebContentsLike {
  on?: (
    eventName: 'before-input-event',
    listener: (event: unknown, input: BeforeInputKeyEventLike) => void
  ) => void
  removeListener?: (
    eventName: 'before-input-event',
    listener: (event: unknown, input: BeforeInputKeyEventLike) => void
  ) => void
}

export interface WindowCloseEventLike {
  preventDefault(): void
}

export interface BrowserWindowLike {
  id: number
  webContents: WindowWebContentsLike
  getBounds(): WindowBounds
  isMinimized?(): boolean
  isFocused?(): boolean
  restore?(): void
  focus?(): void
  removeMenu(): void
  show(): void
  close(): void
  isDestroyed(): boolean
  on?(eventName: 'close', listener: (event: WindowCloseEventLike) => void): void
  on?(eventName: 'focus', listener: () => void): void
  removeListener?(eventName: 'close', listener: (event: WindowCloseEventLike) => void): void
  removeListener?(eventName: 'focus', listener: () => void): void
  once(eventName: 'ready-to-show' | 'closed', listener: () => void): void
  loadURL(url: string): Promise<void> | void
  loadFile(filePath: string, options?: { query?: Record<string, string> }): Promise<void> | void
}

export interface WindowManagerDependencies {
  preloadPath: string
  rendererUrl?: string
  rendererFilePath: string
  configService?: ConfigService
  logService?: LogService
  trashItem?: (targetPath: string) => Promise<void>
  watchDebounceMs?: number
  initialAutoSaveConfig?: AutoSaveConfig
  bufferHub?: SharedDocumentBufferHub
  createWindow: (options: BrowserWindowConstructorOptions) => BrowserWindowLike
  screen?: ScreenLike
  getFocusedWindow?: () => BrowserWindowLike | undefined
}

export interface CreateMainWindowOptions {
  bounds?: Partial<WindowBounds>
  initialWorkspacePath?: string | null
}

export interface WorkspaceSessionHandle
  extends BufferIpcSession,
    WorkspaceIpcSession,
    FrontmatterIpcSession {
  readonly workspaceService: WorkspaceFsService
  readonly searchService: WorkspaceSearchService
  readonly frontmatterSchemaService: FrontmatterSchemaService
  getTargets: () => WindowWebContentsLike[]
}

interface WindowRecord {
  sessionId: number
  webContentsId: number
  role: WindowRole
  window: BrowserWindowLike
  initialTabs: TabTransferPayload[]
  initialWorkspacePath?: string | null
  hasSyncedNonEmptyTabs: boolean
  closing: boolean
  closePromptPending: boolean
  closeFlushEnabled: boolean
  cleanCloseFlushTimer?: ReturnType<typeof setTimeout>
  cleanupListeners?: () => void
}

interface WorkspaceSession {
  sessionId: number
  mainWebContentsId: number
  workspaceService: WorkspaceFsService
  searchService: WorkspaceSearchService
  frontmatterSchemaService: FrontmatterSchemaService
  bufferHub: SharedDocumentBufferHub
  dragCoordinator: TabDragCoordinator
  ownsBufferHub: boolean
  pendingInitialWorkspacePath: string | null
  pendingOpenWorkspacePath: string | null
  pendingOpenToken: number
  openWorkspaceQueue: Promise<unknown>
  windowIds: Set<number>
  disposed: boolean
  unsubscribeHub: () => void
  unsubscribeDrag: () => void
  disposeCleanups: Array<() => void>
  handle: WorkspaceSessionHandle
}

const CLEAN_CLOSE_FLUSH_TIMEOUT_MS = 1000

function getNumericSenderId(sender: unknown): number | undefined {
  if (!sender || typeof sender !== 'object') return undefined
  const candidate = (sender as { id?: unknown }).id
  return typeof candidate === 'number' ? candidate : undefined
}

function matchesTargetWindow(record: WindowRecord, targetWindow: unknown): boolean {
  if (record.window === targetWindow) return true
  if (!targetWindow || typeof targetWindow !== 'object') return false
  const candidate = targetWindow as { id?: unknown; webContents?: unknown }
  if (typeof candidate.id === 'number' && candidate.id === record.window.id) {
    return true
  }
  return candidate.webContents !== undefined && candidate.webContents === record.window.webContents
}

/**
 * Coordinates multiple main-window workspace sessions, their owned auxiliary editor windows,
 * window initialization contexts, session-scoped buffer/workspace/drag isolation, and menu routing.
 */
export class WindowManager
  implements BufferIpcSessionSource, WorkspaceIpcCoordinator, FrontmatterIpcSessionSource
{
  private readonly preloadPath: string
  private readonly rendererUrl?: string
  private readonly rendererFilePath: string
  private readonly configService?: ConfigService
  private readonly logService?: LogService
  private readonly trashItem?: (targetPath: string) => Promise<void>
  private readonly watchDebounceMs?: number
  private readonly injectedBufferHub?: SharedDocumentBufferHub
  private readonly createBrowserWindow: (options: BrowserWindowConstructorOptions) => BrowserWindowLike
  private readonly screen?: ScreenLike
  private readonly getFocusedWindow?: () => BrowserWindowLike | undefined

  private readonly sessions = new Map<number, WorkspaceSession>()
  private readonly windowsByWebContentsId = new Map<number, WindowRecord>()
  private readonly recordsByWebContents = new WeakMap<object, WindowRecord>()
  private readonly dragStateListeners = new Set<
    (session: ActiveTabDragSession | null, targets?: WindowWebContentsLike[]) => void
  >()
  private readonly sessionCreatedListeners = new Set<
    (session: WorkspaceSessionHandle) => (() => void) | void
  >()
  private readonly sessionDisposedListeners = new Set<(session: WorkspaceSessionHandle) => void>()

  private nextSessionId = 1
  private dragSessionCounter = 0
  private lastActiveSessionId: number | null = null
  private usedInjectedHub = false
  private latestAutoSaveConfig?: AutoSaveConfig
  private readonly unsubscribeConfig?: () => void
  private disposed = false

  constructor({
    preloadPath,
    rendererUrl,
    rendererFilePath,
    configService,
    logService,
    trashItem,
    watchDebounceMs,
    initialAutoSaveConfig,
    bufferHub,
    createWindow,
    screen,
    getFocusedWindow
  }: WindowManagerDependencies) {
    this.preloadPath = preloadPath
    this.rendererUrl = rendererUrl
    this.rendererFilePath = rendererFilePath
    this.configService = configService
    this.logService = logService
    this.trashItem = trashItem
    this.watchDebounceMs = watchDebounceMs
    this.latestAutoSaveConfig = initialAutoSaveConfig
    this.injectedBufferHub = bufferHub
    this.createBrowserWindow = createWindow
    this.screen = screen
    this.getFocusedWindow = getFocusedWindow

    if (this.configService) {
      this.unsubscribeConfig = this.configService.onChanged((config) => {
        this.latestAutoSaveConfig = {
          autoSave: config.autoSave,
          autoSaveDelayMs: config.autoSaveDelayMs
        }
      })
      if (!this.latestAutoSaveConfig) {
        void this.configService
          .get()
          .then((config) => {
            if (!this.disposed && !this.latestAutoSaveConfig) {
              this.latestAutoSaveConfig = {
                autoSave: config.autoSave,
                autoSaveDelayMs: config.autoSaveDelayMs
              }
            }
          })
          .catch(() => undefined)
      }
    }
  }

  private loadRendererContent(win: BrowserWindowLike, role: WindowRole): void {
    if (this.rendererUrl) {
      const url = new URL(this.rendererUrl)
      if (role === 'auxiliary') {
        url.searchParams.set(WINDOW_ROLE_QUERY_PARAM, role)
      }
      void win.loadURL(url.toString())
      return
    }

    void win.loadFile(
      this.rendererFilePath,
      role === 'auxiliary' ? { query: { [WINDOW_ROLE_QUERY_PARAM]: role } } : undefined
    )
  }

  private createSessionServices(): {
    workspaceService: WorkspaceFsService
    bufferHub: SharedDocumentBufferHub
    ownsBufferHub: boolean
  } {
    if (this.injectedBufferHub && !this.usedInjectedHub) {
      this.usedInjectedHub = true
      return {
        workspaceService: new WorkspaceFsService({
          trashItem: this.trashItem,
          watchDebounceMs: this.watchDebounceMs
        }),
        bufferHub: this.injectedBufferHub,
        ownsBufferHub: false
      }
    }

    if (!this.configService) {
      throw new Error('WindowManager requires configService to create main window sessions')
    }

    const workspaceService = new WorkspaceFsService({
      trashItem: this.trashItem,
      watchDebounceMs: this.watchDebounceMs
    })
    const bufferHub = createSharedDocumentBufferHub({
      workspaceService,
      configService: this.configService,
      logService: this.logService,
      initialAutoSaveConfig: this.latestAutoSaveConfig
    })
    return {
      workspaceService,
      bufferHub,
      ownsBufferHub: true
    }
  }

  private createWorkspaceSession(
    initialWorkspacePath: string | null
  ): WorkspaceSession {
    const sessionId = this.nextSessionId++
    const { workspaceService, bufferHub, ownsBufferHub } = this.createSessionServices()
    const searchService = new WorkspaceSearchService({
      workspaceService,
      getOpenBuffers: () => Object.values(bufferHub.getSnapshot().buffers)
    })
    const frontmatterSchemaService = new FrontmatterSchemaService({
      workspaceService,
      watchDebounceMs: this.watchDebounceMs,
      logService: this.logService
    })
    const dragCoordinator = new TabDragCoordinator({
      nextDragSessionId: () => `drag-${++this.dragSessionCounter}`
    })

    const getTargets = (): WindowWebContentsLike[] => this.getSessionWebContentsTargets(sessionId)

    const session: WorkspaceSession = {
      sessionId,
      mainWebContentsId: 0,
      workspaceService,
      searchService,
      frontmatterSchemaService,
      bufferHub,
      dragCoordinator,
      ownsBufferHub,
      pendingInitialWorkspacePath: initialWorkspacePath,
      pendingOpenWorkspacePath: null,
      pendingOpenToken: 0,
      openWorkspaceQueue: Promise.resolve(),
      windowIds: new Set<number>(),
      disposed: false,
      unsubscribeHub: () => undefined,
      unsubscribeDrag: () => undefined,
      disposeCleanups: [],
      handle: {
        hub: bufferHub,
        workspaceService,
        searchService,
        frontmatterSchemaService,
        getTargets,
        resolveWindowId: (sender) => {
          const live = this.resolveLiveWindowSession(sender)
          return live && live.session.sessionId === sessionId ? live.record.webContentsId : undefined
        },
        isMainWindow: (sender) => {
          const live = this.resolveLiveWindowSession(sender)
          return (
            live !== undefined &&
            live.session.sessionId === sessionId &&
            live.record.role === 'main'
          )
        }
      }
    }

    session.unsubscribeHub = bufferHub.subscribe((event) => {
      this.handleHubEvent(session, event)
    })
    session.disposeCleanups.push(
      frontmatterSchemaService.onSchemaChanged(() => {
        const schemaPath = frontmatterSchemaService.getSchemaPath()
        if (!schemaPath || !bufferHub.hasBuffer(schemaPath)) {
          return
        }
        void bufferHub.reconcileWorkspaceBuffersWithDisk().catch(() => undefined)
      })
    )
    session.unsubscribeDrag = dragCoordinator.onStateChanged((dragSession) => {
      if (this.disposed || session.disposed) return
      const targets = getTargets()
      for (const listener of this.dragStateListeners) {
        listener(dragSession, targets)
      }
    })

    this.sessions.set(sessionId, session)
    return session
  }

  private notifySessionCreated(session: WorkspaceSession): void {
    for (const listener of this.sessionCreatedListeners) {
      const cleanup = listener(session.handle)
      if (typeof cleanup === 'function') {
        session.disposeCleanups.push(cleanup)
      }
    }
  }

  private registerWindow(
    session: WorkspaceSession,
    win: BrowserWindowLike,
    role: WindowRole,
    initialTabs: readonly TabTransferPayload[],
    initialWorkspacePath?: string | null
  ): WindowRecord {
    const webContentsId = trackHubWindowWebContents(session.bufferHub, win.webContents, win.id)
    const clonedTabs = cloneTabTransferPayloads(initialTabs)

    const record: WindowRecord = {
      sessionId: session.sessionId,
      webContentsId,
      role,
      window: win,
      initialTabs: clonedTabs,
      ...(initialWorkspacePath !== undefined ? { initialWorkspacePath } : {}),
      hasSyncedNonEmptyTabs: false,
      closing: false,
      closePromptPending: false,
      closeFlushEnabled: false
    }

    this.windowsByWebContentsId.set(webContentsId, record)
    this.recordsByWebContents.set(win.webContents, record)
    session.windowIds.add(webContentsId)

    if (role === 'main') {
      session.mainWebContentsId = webContentsId
      this.lastActiveSessionId = session.sessionId
    } else {
      win.removeMenu()
      for (const tab of clonedTabs) {
        session.bufferHub.registerPendingTransfer(webContentsId, tab.bufferKey)
      }
    }

    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) {
        win.show()
      }
    })

    const handleBeforeInput = (_event: unknown, input: BeforeInputKeyEventLike): void => {
      for (const candidateSession of this.sessions.values()) {
        if (!candidateSession.disposed) {
          candidateSession.dragCoordinator.handleBeforeInput(input)
        }
      }
    }
    const handleWindowClose = (event: WindowCloseEventLike): void => {
      this.handleWindowClose(record, event)
    }
    const handleWindowFocus = (): void => {
      if (!this.disposed && !session.disposed) {
        this.lastActiveSessionId = session.sessionId
      }
    }
    win.webContents.on?.('before-input-event', handleBeforeInput)
    win.on?.('close', handleWindowClose)
    win.on?.('focus', handleWindowFocus)
    record.cleanupListeners = () => {
      win.webContents.removeListener?.('before-input-event', handleBeforeInput)
      win.removeListener?.('close', handleWindowClose)
      win.removeListener?.('focus', handleWindowFocus)
      record.cleanupListeners = undefined
    }

    win.once('closed', () => {
      this.clearCleanCloseFlushTimer(record)
      record.cleanupListeners?.()
      if (!session.disposed) {
        session.dragCoordinator.clearForWindow(webContentsId)
      }
      this.recordsByWebContents.delete(win.webContents)
      this.windowsByWebContentsId.delete(webContentsId)
      session.windowIds.delete(webContentsId)
      if (role === 'main') {
        this.closeSessionAuxiliaryWindows(session)
        this.disposeSession(session)
      }
    })

    return record
  }

  private disposeSession(session: WorkspaceSession): void {
    if (session.disposed) return
    session.disposed = true

    for (const listener of this.sessionDisposedListeners) {
      listener(session.handle)
    }
    for (const cleanup of session.disposeCleanups.splice(0)) {
      cleanup()
    }

    session.unsubscribeHub()
    session.unsubscribeDrag()
    session.dragCoordinator.dispose()
    if (session.ownsBufferHub) {
      session.bufferHub.dispose()
    }
    session.frontmatterSchemaService.dispose()
    session.searchService.dispose()
    session.workspaceService.dispose()

    this.sessions.delete(session.sessionId)
    if (this.lastActiveSessionId === session.sessionId) {
      this.lastActiveSessionId = this.findFallbackActiveSessionId()
    }
  }

  private getLiveMainRecord(session: WorkspaceSession | undefined): WindowRecord | undefined {
    if (this.disposed || !session || session.disposed) return undefined
    const mainRecord = this.windowsByWebContentsId.get(session.mainWebContentsId)
    return mainRecord && !mainRecord.window.isDestroyed() ? mainRecord : undefined
  }

  private findFallbackActiveSessionId(): number | null {
    for (const session of this.sessions.values()) {
      if (this.getLiveMainRecord(session)) {
        return session.sessionId
      }
    }
    return null
  }

  private getSessionEffectiveWorkspaceRoot(session: WorkspaceSession): string | null {
    return (
      session.pendingOpenWorkspacePath ??
      session.workspaceService.getWorkspaceRoot() ??
      session.pendingInitialWorkspacePath
    )
  }

  private getSessionCandidateWorkspacePaths(session: WorkspaceSession): string[] {
    const candidates: string[] = []
    for (const candidate of [
      session.pendingOpenWorkspacePath,
      session.workspaceService.getWorkspaceRoot(),
      session.pendingInitialWorkspacePath
    ]) {
      if (candidate && !candidates.includes(candidate)) {
        candidates.push(candidate)
      }
    }
    return candidates
  }

  private findSessionByWorkspacePath(
    targetPath: string,
    excludeSessionId?: number
  ): WorkspaceSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.sessionId === excludeSessionId || !this.getLiveMainRecord(session)) continue
      for (const candidate of this.getSessionCandidateWorkspacePaths(session)) {
        if (isSameWorkspacePath(candidate, targetPath)) {
          return session
        }
      }
    }
    return undefined
  }

  private focusSessionMainWindow(session: WorkspaceSession): void {
    const mainRecord = this.getLiveMainRecord(session)
    if (!mainRecord) return
    const win = mainRecord.window
    if (win.isMinimized?.()) {
      win.restore?.()
    }
    if (typeof win.focus === 'function') {
      win.focus()
    } else {
      win.show()
    }
    this.lastActiveSessionId = session.sessionId
  }

  private focusExistingSessionTarget(
    session: WorkspaceSession,
    fallbackRoot: string
  ): { windowId: number; rootPath: string } {
    this.focusSessionMainWindow(session)
    return {
      windowId: session.mainWebContentsId,
      rootPath: this.getSessionEffectiveWorkspaceRoot(session) ?? fallbackRoot
    }
  }

  createMainWindow(options?: CreateMainWindowOptions): BrowserWindowLike {
    const win = this.createBrowserWindow(
      createMainWindowOptions(this.preloadPath, { bounds: options?.bounds })
    )
    const initialWorkspacePath = options?.initialWorkspacePath ?? null
    const session = this.createWorkspaceSession(initialWorkspacePath)
    this.registerWindow(session, win, 'main', [], options?.initialWorkspacePath)
    this.notifySessionCreated(session)
    this.loadRendererContent(win, 'main')
    return win
  }

  createAuxiliaryWindow(
    initialTabs: readonly TabTransferPayload[],
    sourceBounds?: WindowBounds,
    sourceSender?: unknown
  ): BrowserWindowLike {
    const session = this.resolveTargetSessionForAuxCreation(sourceSender)
    const bounds = sourceBounds ? computeOffsetAuxiliaryBounds(sourceBounds, this.screen) : undefined
    return this.openAuxiliaryWindowWithBounds(session, initialTabs, bounds).window
  }

  private resolveTargetSessionForAuxCreation(sourceSender?: unknown): WorkspaceSession {
    if (sourceSender !== undefined) {
      const live = this.resolveLiveWindowSession(sourceSender)
      if (live) {
        return live.session
      }
    }
    const activeSession = this.getActiveSession()
    if (!activeSession) {
      throw new Error('Cannot create auxiliary window without an active main window session')
    }
    return activeSession
  }

  private openAuxiliaryWindowWithBounds(
    session: WorkspaceSession,
    initialTabs: readonly TabTransferPayload[],
    bounds?: WindowBounds
  ): WindowRecord {
    if (initialTabs.length === 0) {
      throw new Error('Auxiliary window requires at least one initial tab')
    }
    const firstKey = initialTabs[0].bufferKey
    const firstName = session.bufferHub.getBufferName(firstKey)
    const options = createAuxiliaryWindowOptions(this.preloadPath, {
      bounds,
      title: formatWindowTitle(firstName)
    })

    const win = this.createBrowserWindow(options)
    const record = this.registerWindow(session, win, 'auxiliary', initialTabs)
    this.loadRendererContent(win, 'auxiliary')
    return record
  }

  private createDetachedAuxiliaryWindow(
    session: WorkspaceSession,
    payload: TabTransferPayload,
    bounds?: WindowBounds
  ): DetachTabToNewWindowResult {
    const record = this.openAuxiliaryWindowWithBounds(session, [payload], bounds)
    return {
      windowId: record.webContentsId
    }
  }

  private resolveRecordFromSender(sender: unknown): WindowRecord | undefined {
    if (!sender || typeof sender !== 'object') return undefined
    const direct = this.recordsByWebContents.get(sender)
    if (direct) return direct

    const numericId = getNumericSenderId(sender)
    return numericId !== undefined ? this.windowsByWebContentsId.get(numericId) : undefined
  }

  private resolveLiveWindowSession(
    sender: unknown
  ): { record: WindowRecord; session: WorkspaceSession } | undefined {
    if (this.disposed) return undefined
    const record = this.resolveRecordFromSender(sender)
    if (!record || record.window.isDestroyed()) return undefined
    const session = this.sessions.get(record.sessionId)
    if (!session || session.disposed) return undefined
    return { record, session }
  }

  private requireSourceWindow(
    sender: unknown,
    action: string
  ): { record: WindowRecord; session: WorkspaceSession } {
    const live = this.resolveLiveWindowSession(sender)
    if (!live) {
      throw new Error(`Cannot ${action} from an unknown source window`)
    }
    return live
  }

  private assertKnownBuffer(
    session: WorkspaceSession,
    payload: TabTransferPayload | undefined,
    action: string
  ): void {
    if (
      !payload ||
      typeof payload.bufferKey !== 'string' ||
      !session.bufferHub.hasBuffer(payload.bufferKey)
    ) {
      throw new Error(`Cannot ${action} unknown document buffer`)
    }
  }

  private getOpenWindowBounds(): WindowBounds[] {
    const bounds: WindowBounds[] = []
    for (const record of this.windowsByWebContentsId.values()) {
      if (!record.window.isDestroyed() && !record.window.isMinimized?.()) {
        bounds.push(record.window.getBounds())
      }
    }
    return bounds
  }

  private getActiveSession(): WorkspaceSession | undefined {
    if (this.lastActiveSessionId !== null) {
      const candidate = this.sessions.get(this.lastActiveSessionId)
      if (this.getLiveMainRecord(candidate)) {
        return candidate
      }
    }
    const fallbackId = this.findFallbackActiveSessionId()
    return fallbackId !== null ? this.sessions.get(fallbackId) : undefined
  }

  private requireMainSenderSession(sender: unknown): WorkspaceSession {
    const live = this.resolveLiveWindowSession(sender)
    if (!live || live.record.role !== 'main') {
      throw new Error('Only the main window can open a workspace')
    }
    return live.session
  }

  private clearMatchingPendingInitialWorkspace(
    session: WorkspaceSession,
    requestedPath: string
  ): void {
    if (this.disposed || session.disposed || session.workspaceService.getWorkspaceRoot()) {
      return
    }
    if (
      session.pendingInitialWorkspacePath &&
      isSameWorkspacePath(session.pendingInitialWorkspacePath, requestedPath)
    ) {
      session.pendingInitialWorkspacePath = null
    }
  }

  private openValidatedDirectoryInSession(
    session: WorkspaceSession,
    realRoot: string
  ): Promise<WorkspaceInfo> {
    const openToken = ++session.pendingOpenToken
    session.pendingOpenWorkspacePath = realRoot

    const run = session.openWorkspaceQueue.then(async () => {
      if (!this.getLiveMainRecord(session)) {
        throw new Error('Only the main window can open a workspace')
      }
      try {
        session.searchService.cancelActiveSearch()
        const info = await session.workspaceService.openWorkspace(realRoot)
        session.pendingInitialWorkspacePath = null
        if (!this.getLiveMainRecord(session)) {
          throw new Error('Only the main window can open a workspace')
        }
        return info
      } catch (error) {
        if (!session.workspaceService.getWorkspaceRoot() && session.pendingOpenToken === openToken) {
          session.pendingInitialWorkspacePath = null
        }
        throw error
      } finally {
        if (session.pendingOpenToken === openToken) {
          session.pendingOpenWorkspacePath = null
        }
      }
    })

    session.openWorkspaceQueue = run.catch(() => undefined)
    return run
  }

  /**
   * Opens a workspace in a new offset main window after validating the target directory,
   * or restores and focuses the existing main window if that workspace is already open.
   */
  async openWorkspaceInNewWindow(
    sender: unknown,
    rootPath: string
  ): Promise<OpenWorkspaceInNewWindowResult> {
    if (this.disposed) {
      throw new Error('WindowManager is disposed')
    }

    const realRoot = await resolveValidWorkspaceDirectory(rootPath)
    if (this.disposed) {
      throw new Error('WindowManager is disposed')
    }

    const existingSession = this.findSessionByWorkspacePath(realRoot)
    if (existingSession) {
      return {
        status: 'focused-existing',
        ...this.focusExistingSessionTarget(existingSession, realRoot)
      }
    }

    const sourceRecord =
      this.resolveLiveWindowSession(sender)?.record ?? this.getLiveMainRecord(this.getActiveSession())
    const bounds = sourceRecord
      ? computeOffsetMainBounds(sourceRecord.window.getBounds(), this.screen)
      : undefined

    const newWin = this.createMainWindow({
      bounds,
      initialWorkspacePath: realRoot
    })
    const newRecord = this.resolveRecordFromSender(newWin.webContents)
    if (!newRecord) {
      throw new Error('Failed to register newly created main window')
    }
    return {
      status: 'opened',
      windowId: newRecord.webContentsId,
      rootPath: realRoot
    }
  }

  private async prepareMainWorkspaceOpen(
    sender: WebContentsLike | undefined,
    rootPath: string
  ): Promise<{
    senderSession: WorkspaceSession
    realRoot: string
    existingSession: WorkspaceSession | undefined
  }> {
    const senderSession = this.requireMainSenderSession(sender)
    let realRoot: string
    try {
      realRoot = await resolveValidWorkspaceDirectory(rootPath)
    } catch (error) {
      this.clearMatchingPendingInitialWorkspace(senderSession, rootPath)
      throw error
    }
    if (!this.getLiveMainRecord(senderSession)) {
      throw new Error('Only the main window can open a workspace')
    }
    const existingSession = this.findSessionByWorkspacePath(realRoot, senderSession.sessionId)
    return { senderSession, realRoot, existingSession }
  }

  /**
   * Opens a workspace inside the sender main window's session, or restores and focuses another
   * main window if that workspace is already open elsewhere.
   */
  async activateOrOpenWorkspace(
    sender: WebContentsLike | undefined,
    rootPath: string
  ): Promise<ActivateOrOpenWorkspaceResult> {
    const { senderSession, realRoot, existingSession } = await this.prepareMainWorkspaceOpen(
      sender,
      rootPath
    )
    if (existingSession) {
      return {
        status: 'focused-existing',
        ...this.focusExistingSessionTarget(existingSession, realRoot)
      }
    }

    const info = await this.openValidatedDirectoryInSession(senderSession, realRoot)
    return { status: 'opened', info }
  }

  /**
   * Opens a workspace inside the sender main window's session while rejecting duplicate opens
   * across other live main windows by focusing the existing main window first.
   */
  async openWorkspaceInSession(
    sender: WebContentsLike | undefined,
    rootPath: string
  ): Promise<WorkspaceInfo> {
    const { senderSession, realRoot, existingSession } = await this.prepareMainWorkspaceOpen(
      sender,
      rootPath
    )
    if (existingSession) {
      this.focusSessionMainWindow(existingSession)
      throw new Error('이미 다른 창에 열려 있는 워크스페이스입니다.')
    }

    return this.openValidatedDirectoryInSession(senderSession, realRoot)
  }

  /**
   * Checks whether `rootPath` is already open in another main window and focuses it if found.
   */
  async focusWorkspaceIfOpen(
    sender: WebContentsLike | undefined,
    rootPath: string
  ): Promise<FocusOpenWorkspaceResult> {
    const senderSession = this.requireMainSenderSession(sender)
    const resolvedCandidate = await tryResolveRealWorkspacePath(rootPath)
    if (!resolvedCandidate || !this.getLiveMainRecord(senderSession)) {
      return { focused: false }
    }

    const existingSession = this.findSessionByWorkspacePath(
      resolvedCandidate,
      senderSession.sessionId
    )
    if (!existingSession) {
      return { focused: false }
    }

    return {
      focused: true,
      ...this.focusExistingSessionTarget(existingSession, resolvedCandidate)
    }
  }

  detachTabToNewWindow(
    sender: unknown,
    payload: TabTransferPayload
  ): DetachTabToNewWindowResult {
    const { record: sourceRecord, session } = this.requireSourceWindow(sender, 'detach tab')
    this.assertKnownBuffer(session, payload, 'detach')

    if (
      !canDetachTabFromWindow(
        sourceRecord.role,
        session.bufferHub.getWindowTabCount(sourceRecord.webContentsId)
      )
    ) {
      throw new Error('Cannot detach the last tab from an auxiliary window')
    }

    return this.createDetachedAuxiliaryWindow(
      session,
      payload,
      computeOffsetAuxiliaryBounds(sourceRecord.window.getBounds(), this.screen)
    )
  }

  onTabDragStateChanged(
    listener: (session: ActiveTabDragSession | null, targets?: WindowWebContentsLike[]) => void
  ): () => void {
    this.dragStateListeners.add(listener)
    return () => {
      this.dragStateListeners.delete(listener)
    }
  }

  startTabDrag(sender: unknown, input: TabDragStartInput): ActiveTabDragSession {
    const { record: sourceRecord, session } = this.requireSourceWindow(sender, 'start tab drag')
    this.assertKnownBuffer(session, input?.payload, 'drag')
    return session.dragCoordinator.start(sourceRecord.webContentsId, input)
  }

  updateTabDragOutcome(
    sender: unknown,
    dragSessionId: string,
    outcome: TabDragResolution
  ): ActiveTabDragSession | null {
    const live = this.resolveLiveWindowSession(sender)
    if (!live) {
      return null
    }
    return live.session.dragCoordinator.updateOutcome(
      live.record.webContentsId,
      dragSessionId,
      outcome
    )
  }

  /**
   * Accepts an active external tab drag drop onto the sender window only when the drag originated
   * in the same main-window workspace session, reserving shared buffer ownership before broadcast.
   */
  acceptTabDragDrop(sender: unknown, input?: AcceptTabDragDropInput): AcceptTabDragDropResult {
    const live = this.resolveLiveWindowSession(sender)
    if (!live) {
      return { accepted: false, reason: 'invalid-target-window' }
    }
    const { record: targetRecord, session: targetSession } = live

    const result = targetSession.dragCoordinator.acceptCrossWindowDrop({
      targetWindowId: targetRecord.webContentsId,
      dragSessionId: input?.dragSessionId,
      bufferHub: targetSession.bufferHub
    })

    if (
      !result.accepted &&
      (result.reason === 'no-active-drag' || result.reason === 'session-mismatch') &&
      this.hasOtherSessionPendingDrag(targetSession.sessionId)
    ) {
      return { accepted: false, reason: 'different-workspace-session' }
    }

    return result
  }

  private hasOtherSessionPendingDrag(excludeSessionId: number): boolean {
    for (const session of this.sessions.values()) {
      if (session.sessionId !== excludeSessionId && !session.disposed) {
        if (session.dragCoordinator.hasPendingDrag()) {
          return true
        }
      }
    }
    return false
  }

  endTabDrag(sender: unknown, input: TabDragEndInput): TabDragEndResult {
    const live = this.resolveLiveWindowSession(sender)
    if (!live) {
      return { detached: false, outcome: 'cancelled' }
    }
    const { record: sourceRecord, session } = live

    const canDetach = canDetachTabFromWindow(
      sourceRecord.role,
      session.bufferHub.getWindowTabCount(sourceRecord.webContentsId)
    )
    const plan = session.dragCoordinator.finish({
      sourceWindowId: sourceRecord.webContentsId,
      input,
      openWindowBounds: this.getOpenWindowBounds(),
      canDetach,
      hasBuffer: (key) => session.bufferHub.hasBuffer(key),
      screen: this.screen
    })

    if (!plan.detach) {
      return plan.result
    }

    const { windowId } = this.createDetachedAuxiliaryWindow(session, plan.payload, plan.targetBounds)
    return { detached: true, windowId }
  }

  getWindowInitContext(sender: unknown): WindowInitContext {
    const live = this.resolveLiveWindowSession(sender)
    if (!live) {
      return { role: 'main', initialTabs: [] }
    }
    const { record } = live
    return {
      role: record.role,
      initialTabs: cloneTabTransferPayloads(record.initialTabs),
      ...(record.initialWorkspacePath !== undefined
        ? { initialWorkspacePath: record.initialWorkspacePath }
        : {})
    }
  }

  private clearCleanCloseFlushTimer(record: WindowRecord): void {
    if (record.cleanCloseFlushTimer !== undefined) {
      clearTimeout(record.cleanCloseFlushTimer)
      record.cleanCloseFlushTimer = undefined
    }
  }

  setCloseFlushEnabled(sender: unknown, enabled: boolean): void {
    const live = this.resolveLiveWindowSession(sender)
    if (!live || live.record.role !== 'main') return
    live.record.closeFlushEnabled = Boolean(enabled)
  }

  private handleWindowClose(record: WindowRecord, event: WindowCloseEventLike): void {
    if (this.disposed || record.closing) return
    if (record.closePromptPending) {
      event.preventDefault()
      return
    }
    const session = this.sessions.get(record.sessionId)
    if (!session || session.disposed) return

    const hasDirty = session.bufferHub.hasDirtyBuffersForWindowClose(
      record.role,
      record.webContentsId
    )
    const needsCloseFlush = record.role === 'main' && record.closeFlushEnabled
    if (!hasDirty && !needsCloseFlush) {
      if (record.role === 'main') {
        record.closing = true
        this.closeSessionAuxiliaryWindows(session)
      }
      return
    }

    event.preventDefault()
    record.closePromptPending = true
    if (!hasDirty && needsCloseFlush) {
      this.clearCleanCloseFlushTimer(record)
      record.cleanCloseFlushTimer = setTimeout(() => {
        record.cleanCloseFlushTimer = undefined
        if (record.closePromptPending && !record.window.isDestroyed()) {
          record.closePromptPending = false
          this.closeSessionAuxiliaryWindows(session)
          this.closeRecord(record)
        }
      }, CLEAN_CLOSE_FLUSH_TIMEOUT_MS)
    }
    if (!record.window.webContents.isDestroyed()) {
      record.window.webContents.send(WINDOW_IPC_CHANNELS.closeRequested, undefined)
    }
  }

  private closeSessionAuxiliaryWindows(session: WorkspaceSession): void {
    for (const windowId of [...session.windowIds]) {
      const candidate = this.windowsByWebContentsId.get(windowId)
      if (candidate && candidate.role === 'auxiliary') {
        this.closeRecord(candidate)
      }
    }
  }

  private closeRecord(record: WindowRecord): void {
    this.clearCleanCloseFlushTimer(record)
    if (record.closing || record.window.isDestroyed()) return
    record.closePromptPending = false
    record.closing = true
    record.window.close()
  }

  closeCurrentWindow(sender: unknown): void {
    const live = this.resolveLiveWindowSession(sender)
    if (!live || live.record.role !== 'auxiliary') return
    this.closeRecord(live.record)
  }

  resolveCloseRequest(sender: unknown, approved: boolean): void {
    const live = this.resolveLiveWindowSession(sender)
    if (!live || !live.record.closePromptPending) return
    const { record, session } = live
    this.clearCleanCloseFlushTimer(record)
    record.closePromptPending = false
    if (!approved) return
    if (record.role === 'main') {
      this.closeSessionAuxiliaryWindows(session)
    }
    this.closeRecord(record)
  }

  private handleHubEvent(session: WorkspaceSession, event: SharedBufferHubEvent): void {
    if (this.disposed || session.disposed) return

    if (event.type === 'paths-remapped') {
      session.dragCoordinator.remapPayloadKeys(event.remappings)
      const remappings = new Map(event.remappings.map((item) => [item.oldKey, item.newKey]))
      for (const windowId of session.windowIds) {
        const record = this.windowsByWebContentsId.get(windowId)
        if (!record || record.role !== 'auxiliary') continue
        for (const tab of record.initialTabs) {
          const nextKey = remappings.get(tab.bufferKey)
          if (nextKey) {
            tab.bufferKey = nextKey
          }
        }
      }
      return
    }

    if (event.type === 'buffers-closed') {
      const closedKeys = new Set(event.closedKeys)
      for (const windowId of session.windowIds) {
        const record = this.windowsByWebContentsId.get(windowId)
        if (!record || record.role !== 'auxiliary') continue
        record.initialTabs = record.initialTabs.filter((tab) => !closedKeys.has(tab.bufferKey))
      }
      this.reconcileAuxiliaryAutoClose(session)
      return
    }

    if (event.type === 'state-changed') {
      this.reconcileAuxiliaryAutoClose(session)
      return
    }

    if (
      event.type === 'workspace-saved' &&
      session.frontmatterSchemaService.isSchemaFilePath(event.path)
    ) {
      void session.frontmatterSchemaService.reloadIfChanged()
    }
  }

  private reconcileAuxiliaryAutoClose(session: WorkspaceSession): void {
    for (const windowId of [...session.windowIds]) {
      const record = this.windowsByWebContentsId.get(windowId)
      if (!record || record.role !== 'auxiliary' || record.closing || record.window.isDestroyed()) {
        continue
      }

      const tabCount = session.bufferHub.getWindowTabCount(record.webContentsId)
      if (tabCount > 0) {
        record.hasSyncedNonEmptyTabs = true
        continue
      }

      if (record.hasSyncedNonEmptyTabs || record.initialTabs.length === 0) {
        this.closeRecord(record)
      }
    }
  }

  resolveSession(sender: WebContentsLike | undefined): WorkspaceSessionHandle | undefined {
    return this.resolveLiveWindowSession(sender)?.session.handle
  }

  forEachSession(visitor: (session: WorkspaceSessionHandle) => void): void {
    for (const session of this.sessions.values()) {
      if (!session.disposed) {
        visitor(session.handle)
      }
    }
  }

  onSessionCreated(
    listener: (session: WorkspaceSessionHandle) => (() => void) | void
  ): () => void {
    this.sessionCreatedListeners.add(listener)
    const attachedCleanups: Array<() => void> = []
    for (const session of this.sessions.values()) {
      if (session.disposed) continue
      const cleanup = listener(session.handle)
      if (typeof cleanup === 'function') {
        session.disposeCleanups.push(cleanup)
        attachedCleanups.push(cleanup)
      }
    }
    return () => {
      this.sessionCreatedListeners.delete(listener)
      for (const cleanup of attachedCleanups.splice(0)) {
        cleanup()
      }
    }
  }

  onSessionDisposed(listener: (session: WorkspaceIpcSession) => void): () => void {
    const wrapped = (session: WorkspaceSessionHandle): void => listener(session)
    this.sessionDisposedListeners.add(wrapped)
    return () => {
      this.sessionDisposedListeners.delete(wrapped)
    }
  }

  getWorkspaceServiceForSender(sender: unknown): WorkspaceFsService | undefined {
    return this.resolveSession(sender as WebContentsLike | undefined)?.workspaceService
  }

  getWorkspaceServices(): WorkspaceFsService[] {
    const services: WorkspaceFsService[] = []
    for (const session of this.sessions.values()) {
      if (this.getLiveMainRecord(session)) {
        services.push(session.workspaceService)
      }
    }
    return services
  }

  getWindowForSender(sender: unknown): BrowserWindowLike | undefined {
    return this.resolveLiveWindowSession(sender)?.record.window
  }

  isMainWebContents(sender: unknown): boolean {
    return this.resolveLiveWindowSession(sender)?.record.role === 'main'
  }

  private getSessionMainWebContentsIfLive(session: WorkspaceSession | undefined): BufferWebContentsLike | undefined {
    const mainRecord = this.getLiveMainRecord(session)
    if (!mainRecord || mainRecord.window.webContents.isDestroyed()) {
      return undefined
    }
    return mainRecord.window.webContents
  }

  private resolveRecordForTargetWindow(targetWindow: unknown): WindowRecord | undefined {
    if (this.disposed || targetWindow === undefined) return undefined
    for (const record of this.windowsByWebContentsId.values()) {
      if (!record.window.isDestroyed() && matchesTargetWindow(record, targetWindow)) {
        return record
      }
    }
    return undefined
  }

  /**
   * Resolves the target main window's webContents for application menu bar commands, mapping an
   * invoked or focused auxiliary window back to its owning main window.
   */
  getMenuTargetWebContents(targetWindow?: unknown): BufferWebContentsLike | undefined {
    const targetRecord =
      this.resolveRecordForTargetWindow(targetWindow) ??
      this.resolveRecordForTargetWindow(this.getFocusedWindow?.()) ??
      this.findFocusedWindowRecord()

    if (targetRecord) {
      return this.getSessionMainWebContentsIfLive(this.sessions.get(targetRecord.sessionId))
    }

    return this.getSessionMainWebContentsIfLive(this.getActiveSession())
  }

  private findFocusedWindowRecord(): WindowRecord | undefined {
    for (const record of this.windowsByWebContentsId.values()) {
      if (!record.window.isDestroyed() && record.window.isFocused?.()) {
        return record
      }
    }
    return undefined
  }

  private getSessionWebContentsTargets(sessionId: number): WindowWebContentsLike[] {
    const session = this.sessions.get(sessionId)
    if (!session || session.disposed) return []
    const targets: WindowWebContentsLike[] = []
    for (const windowId of session.windowIds) {
      const record = this.windowsByWebContentsId.get(windowId)
      if (record && !record.window.isDestroyed() && !record.window.webContents.isDestroyed()) {
        targets.push(record.window.webContents)
      }
    }
    return targets
  }

  getWebContentsTargets(): BufferWebContentsLike[] {
    const targets: BufferWebContentsLike[] = []
    for (const record of this.windowsByWebContentsId.values()) {
      if (!record.window.isDestroyed() && !record.window.webContents.isDestroyed()) {
        targets.push(record.window.webContents)
      }
    }
    return targets
  }

  dispose(): void {
    this.disposed = true
    this.unsubscribeConfig?.()
    for (const record of this.windowsByWebContentsId.values()) {
      this.clearCleanCloseFlushTimer(record)
      record.cleanupListeners?.()
      this.recordsByWebContents.delete(record.window.webContents)
    }
    for (const session of [...this.sessions.values()]) {
      this.disposeSession(session)
    }
    this.dragStateListeners.clear()
    this.sessionCreatedListeners.clear()
    this.sessionDisposedListeners.clear()
    this.windowsByWebContentsId.clear()
    this.sessions.clear()
    this.lastActiveSessionId = null
  }
}
