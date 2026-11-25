import type { BrowserWindowConstructorOptions } from 'electron'
import type { AutoSaveConfig } from '@shared/bufferAutoSaveScheduler'
import { WINDOW_IPC_CHANNELS } from '@shared/ipc'
import type { SharedDocumentBufferHub } from '@shared/sharedDocumentBufferHub'
import type { BeforeInputKeyEventLike } from '@shared/tabDragSession'
import {
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
  WindowSessionCoordinator,
  type WindowSessionServices
} from '@shared/windowSessionCoordinator'
import type {
  FocusOpenWorkspaceResult,
  OpenWorkspaceInNewWindowResult,
  WorkspaceInfo
} from '@shared/workspace'
import type { WorkspaceQueryAndSchemaHub } from '@shared/workspaceQueryAndSchema'
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
import type { WindowIpcCoordinator } from './ipc/registerWindowIpc'
import type {
  WorkspaceIpcCoordinator,
  WorkspaceIpcSession
} from './ipc/registerWorkspaceIpc'
import type { LogService } from './logging/LogService'
import { createAuxiliaryWindowOptions, createMainWindowOptions } from './window'
import { createDiskWorkspaceQueryAndSchemaHub } from './workspace/diskWorkspaceQueryAndSchema'
import {
  resolveValidWorkspaceDirectory,
  tryResolveRealWorkspacePath,
  WorkspaceFsService
} from './workspace/WorkspaceFsService'

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
  windowIconPath?: string
  configService: ConfigService
  logService?: LogService
  trashItem?: (targetPath: string) => Promise<void>
  watchDebounceMs?: number
  initialAutoSaveConfig?: AutoSaveConfig
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
  readonly queryAndSchemaHub: WorkspaceQueryAndSchemaHub
  getTargets: () => WindowWebContentsLike[]
}

interface ElectronSessionServices extends WindowSessionServices {
  readonly workspaceService: WorkspaceFsService
  readonly queryAndSchemaHub: WorkspaceQueryAndSchemaHub
  readonly bufferHub: SharedDocumentBufferHub
  readonly handle: WorkspaceSessionHandle
}

function getNumericSenderId(sender: unknown): number | undefined {
  if (!sender || typeof sender !== 'object') return undefined
  const candidate = (sender as { id?: unknown }).id
  return typeof candidate === 'number' ? candidate : undefined
}

function matchesTargetWindow(win: BrowserWindowLike, targetWindow: unknown): boolean {
  if (win === targetWindow) return true
  if (!targetWindow || typeof targetWindow !== 'object') return false
  const candidate = targetWindow as { id?: unknown; webContents?: unknown }
  if (typeof candidate.id === 'number' && candidate.id === win.id) {
    return true
  }
  return candidate.webContents !== undefined && candidate.webContents === win.webContents
}

/**
 * Electron host adapter over the shared `WindowSessionCoordinator`, wiring BrowserWindow
 * creation, renderer loading, Electron lifecycle events, and session-scoped IPC ports.
 */
export class WindowManager
  implements
    BufferIpcSessionSource,
    WorkspaceIpcCoordinator,
    FrontmatterIpcSessionSource,
    WindowIpcCoordinator
{
  private readonly preloadPath: string
  private readonly rendererUrl?: string
  private readonly rendererFilePath: string
  private readonly windowIconPath?: string
  private readonly configService: ConfigService
  private readonly logService?: LogService
  private readonly trashItem?: (targetPath: string) => Promise<void>
  private readonly watchDebounceMs?: number
  private readonly createBrowserWindow: (options: BrowserWindowConstructorOptions) => BrowserWindowLike
  private readonly getFocusedWindow?: () => BrowserWindowLike | undefined

  private readonly windowsByWebContentsId = new Map<number, BrowserWindowLike>()
  private readonly windowIdByWebContents = new WeakMap<object, number>()
  private readonly coordinator: WindowSessionCoordinator<ElectronSessionServices>

  private latestAutoSaveConfig?: AutoSaveConfig
  private readonly unsubscribeConfig: () => void

  constructor({
    preloadPath,
    rendererUrl,
    rendererFilePath,
    windowIconPath,
    configService,
    logService,
    trashItem,
    watchDebounceMs,
    initialAutoSaveConfig,
    createWindow,
    screen,
    getFocusedWindow
  }: WindowManagerDependencies) {
    this.preloadPath = preloadPath
    this.rendererUrl = rendererUrl
    this.rendererFilePath = rendererFilePath
    this.windowIconPath = windowIconPath
    this.configService = configService
    this.logService = logService
    this.trashItem = trashItem
    this.watchDebounceMs = watchDebounceMs
    this.latestAutoSaveConfig = initialAutoSaveConfig
    this.createBrowserWindow = createWindow
    this.getFocusedWindow = getFocusedWindow

    this.coordinator = new WindowSessionCoordinator<ElectronSessionServices>({
      screen,
      createSessionServices: (sessionId) => this.createElectronSessionServices(sessionId),
      createWindow: ({ role, bounds, title, services, callbacks }) => {
        const options =
          role === 'auxiliary'
            ? createAuxiliaryWindowOptions(this.preloadPath, {
                bounds,
                title,
                icon: this.windowIconPath
              })
            : createMainWindowOptions(this.preloadPath, {
                bounds,
                icon: this.windowIconPath
              })
        const win = this.createBrowserWindow(options)
        if (role === 'auxiliary') {
          win.removeMenu()
        }

        const webContentsId = trackHubWindowWebContents(services.bufferHub, win.webContents, win.id)
        this.windowsByWebContentsId.set(webContentsId, win)
        this.windowIdByWebContents.set(win.webContents, webContentsId)

        win.once('ready-to-show', () => {
          if (!win.isDestroyed()) {
            win.show()
          }
        })

        const handleBeforeInput = (_event: unknown, input: BeforeInputKeyEventLike): void => {
          callbacks.onBeforeInput(input)
        }
        const handleWindowClose = (event: WindowCloseEventLike): void => {
          if (!callbacks.onCloseAttempt()) {
            event.preventDefault()
          }
        }
        const handleWindowFocus = (): void => {
          callbacks.onFocus()
        }

        win.webContents.on?.('before-input-event', handleBeforeInput)
        win.on?.('close', handleWindowClose)
        win.on?.('focus', handleWindowFocus)

        const detachWindow = (): void => {
          win.webContents.removeListener?.('before-input-event', handleBeforeInput)
          win.removeListener?.('close', handleWindowClose)
          win.removeListener?.('focus', handleWindowFocus)
          this.windowIdByWebContents.delete(win.webContents)
          this.windowsByWebContentsId.delete(webContentsId)
        }

        win.once('closed', () => {
          detachWindow()
          callbacks.onClosed()
        })

        return {
          windowId: webContentsId,
          getBounds: () => win.getBounds(),
          isDestroyed: () => win.isDestroyed(),
          isMinimized: () => Boolean(win.isMinimized?.()),
          isFocused: () => Boolean(win.isFocused?.()),
          restore: () => win.restore?.(),
          focus: () => {
            if (typeof win.focus === 'function') {
              win.focus()
            } else {
              win.show()
            }
          },
          close: () => win.close(),
          sendCloseRequested: () => {
            if (!win.webContents.isDestroyed()) {
              win.webContents.send(WINDOW_IPC_CHANNELS.closeRequested, undefined)
            }
          },
          dispose: detachWindow
        }
      },
      mountWindow: (hosted, role) => {
        const win = this.windowsByWebContentsId.get(hosted.windowId)
        if (win) {
          this.loadRendererContent(win, role)
        }
      },
      resolveValidWorkspacePath: resolveValidWorkspaceDirectory,
      tryResolveWorkspacePath: tryResolveRealWorkspacePath,
      getFocusedWindowId: () => this.resolveWindowIdForTarget(this.getFocusedWindow?.())
    })

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
          if (!this.latestAutoSaveConfig) {
            this.latestAutoSaveConfig = {
              autoSave: config.autoSave,
              autoSaveDelayMs: config.autoSaveDelayMs
            }
          }
        })
        .catch(() => undefined)
    }
  }

  private createElectronSessionServices(sessionId: number): ElectronSessionServices {
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
    const queryAndSchemaHub = createDiskWorkspaceQueryAndSchemaHub({
      workspaceService,
      bufferHub,
      watchDebounceMs: this.watchDebounceMs,
      logService: this.logService
    })

    const handle: WorkspaceSessionHandle = {
      hub: bufferHub,
      workspaceService,
      queryAndSchemaHub,
      getTargets: () => this.getSessionWebContentsTargets(sessionId),
      resolveWindowId: (sender) => {
        const windowId = this.resolveWindowIdFromSender(sender)
        if (windowId === undefined) return undefined
        return this.coordinator.resolveSessionForWindow(windowId)?.sessionId === sessionId
          ? windowId
          : undefined
      },
      syncWindowTabs: (windowId, bufferKeys, options) =>
        this.coordinator.syncWindowTabs(windowId, bufferKeys, options),
      isMainWindow: (sender) => {
        const windowId = this.resolveWindowIdFromSender(sender)
        if (windowId === undefined) return false
        const session = this.coordinator.resolveSessionForWindow(windowId)
        return session !== undefined && session.sessionId === sessionId && session.isMainWindow(windowId)
      }
    }

    return {
      workspaceService,
      queryAndSchemaHub,
      bufferHub,
      handle,
      getWorkspaceRoot: () => workspaceService.getWorkspaceRoot(),
      openWorkspace: (resolvedRootPath) => workspaceService.openWorkspace(resolvedRootPath),
      cancelActiveWorkspaceScans: () => queryAndSchemaHub.cancelActiveScans(),
      dispose: () => {
        queryAndSchemaHub.dispose()
        bufferHub.dispose()
        workspaceService.dispose()
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

  private resolveWindowIdFromSender(sender: unknown): number | undefined {
    if (!sender || typeof sender !== 'object') return undefined
    const direct = this.windowIdByWebContents.get(sender)
    if (direct !== undefined) return direct
    const numericId = getNumericSenderId(sender)
    return numericId !== undefined && this.windowsByWebContentsId.has(numericId) ? numericId : undefined
  }

  private resolveWindowIdForTarget(targetWindow: unknown): number | undefined {
    if (targetWindow === undefined) return undefined
    for (const [windowId, win] of this.windowsByWebContentsId) {
      if (!win.isDestroyed() && matchesTargetWindow(win, targetWindow)) {
        return windowId
      }
    }
    return undefined
  }

  private mapWindowIdsToWebContents(windowIds: readonly number[]): WindowWebContentsLike[] {
    const targets: WindowWebContentsLike[] = []
    for (const windowId of windowIds) {
      const win = this.windowsByWebContentsId.get(windowId)
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
        targets.push(win.webContents)
      }
    }
    return targets
  }

  private getSessionWebContentsTargets(sessionId: number): WindowWebContentsLike[] {
    return this.mapWindowIdsToWebContents(this.coordinator.getLiveWindowIds(sessionId))
  }

  createMainWindow(options?: CreateMainWindowOptions): BrowserWindowLike {
    const hosted = this.coordinator.createMainWindow(options)
    return this.windowsByWebContentsId.get(hosted.windowId)!
  }

  createAuxiliaryWindow(
    initialTabs: readonly TabTransferPayload[],
    sourceBounds?: WindowBounds,
    sourceSender?: unknown
  ): BrowserWindowLike {
    const hosted = this.coordinator.createAuxiliaryWindow(
      initialTabs,
      sourceBounds,
      this.resolveWindowIdFromSender(sourceSender)
    )
    return this.windowsByWebContentsId.get(hosted.windowId)!
  }

  openWorkspaceInNewWindow(
    sender: unknown,
    rootPath: string
  ): Promise<OpenWorkspaceInNewWindowResult> {
    return this.coordinator.openWorkspaceInNewWindow(
      this.resolveWindowIdFromSender(sender),
      rootPath
    )
  }

  openWorkspaceInSession(
    sender: WebContentsLike | undefined,
    rootPath: string
  ): Promise<WorkspaceInfo> {
    return this.coordinator.openWorkspaceInSession(
      this.resolveWindowIdFromSender(sender),
      rootPath
    )
  }

  focusWorkspaceIfOpen(
    sender: WebContentsLike | undefined,
    rootPath: string
  ): Promise<FocusOpenWorkspaceResult> {
    return this.coordinator.focusWorkspaceIfOpen(
      this.resolveWindowIdFromSender(sender),
      rootPath
    )
  }

  detachTabToNewWindow(sender: unknown, payload: TabTransferPayload): DetachTabToNewWindowResult {
    return this.coordinator.detachTabToNewWindow(this.resolveWindowIdFromSender(sender), payload)
  }

  onTabDragStateChanged(
    listener: (session: ActiveTabDragSession | null, targets?: WindowWebContentsLike[]) => void
  ): () => void {
    return this.coordinator.onTabDragStateChanged((dragSession, targetWindowIds) => {
      listener(dragSession, this.mapWindowIdsToWebContents(targetWindowIds))
    })
  }

  startTabDrag(sender: unknown, input: TabDragStartInput): ActiveTabDragSession {
    return this.coordinator.startTabDrag(this.resolveWindowIdFromSender(sender), input)
  }

  updateTabDragOutcome(
    sender: unknown,
    dragSessionId: string,
    outcome: TabDragResolution
  ): ActiveTabDragSession | null {
    return this.coordinator.updateTabDragOutcome(
      this.resolveWindowIdFromSender(sender),
      dragSessionId,
      outcome
    )
  }

  acceptTabDragDrop(sender: unknown, input?: AcceptTabDragDropInput): AcceptTabDragDropResult {
    return this.coordinator.acceptTabDragDrop(this.resolveWindowIdFromSender(sender), input)
  }

  endTabDrag(sender: unknown, input: TabDragEndInput): TabDragEndResult {
    return this.coordinator.endTabDrag(this.resolveWindowIdFromSender(sender), input)
  }

  getWindowInitContext(sender: unknown): WindowInitContext {
    return this.coordinator.getWindowInitContext(this.resolveWindowIdFromSender(sender))
  }

  setCloseFlushEnabled(sender: unknown, enabled: boolean): void {
    this.coordinator.setCloseFlushEnabled(this.resolveWindowIdFromSender(sender), enabled)
  }

  closeCurrentWindow(sender: unknown): void {
    this.coordinator.closeCurrentWindow(this.resolveWindowIdFromSender(sender))
  }

  resolveCloseRequest(sender: unknown, approved: boolean): void {
    this.coordinator.resolveCloseRequest(this.resolveWindowIdFromSender(sender), approved)
  }

  resolveSession(sender: WebContentsLike | undefined): WorkspaceSessionHandle | undefined {
    return this.coordinator.resolveSessionForWindow(this.resolveWindowIdFromSender(sender))?.services
      .handle
  }

  forEachSession(visitor: (session: WorkspaceSessionHandle) => void): void {
    this.coordinator.forEachSession((session) => visitor(session.services.handle))
  }

  onSessionCreated(
    listener: (session: WorkspaceSessionHandle) => (() => void) | void
  ): () => void {
    return this.coordinator.onSessionCreated((session) => listener(session.services.handle))
  }

  onSessionDisposed(listener: (session: WorkspaceIpcSession) => void): () => void {
    return this.coordinator.onSessionDisposed((session) => listener(session.services.handle))
  }

  getWorkspaceServiceForSender(sender: unknown): WorkspaceFsService | undefined {
    return this.resolveSession(sender as WebContentsLike | undefined)?.workspaceService
  }

  getWorkspaceServices(): WorkspaceFsService[] {
    return this.coordinator.getLiveSessionServices().map((services) => services.workspaceService)
  }

  getWindowForSender(sender: unknown): BrowserWindowLike | undefined {
    const windowId = this.resolveWindowIdFromSender(sender)
    if (windowId === undefined) return undefined
    const win = this.windowsByWebContentsId.get(windowId)
    return win && !win.isDestroyed() ? win : undefined
  }

  isMainWebContents(sender: unknown): boolean {
    return this.coordinator.isMainWindow(this.resolveWindowIdFromSender(sender))
  }

  getMenuTargetWebContents(targetWindow?: unknown): BufferWebContentsLike | undefined {
    const mainWindowId = this.coordinator.resolveMenuTargetMainWindowId(
      this.resolveWindowIdForTarget(targetWindow)
    )
    if (mainWindowId === undefined) return undefined
    const mainWin = this.windowsByWebContentsId.get(mainWindowId)
    if (!mainWin || mainWin.isDestroyed() || mainWin.webContents.isDestroyed()) {
      return undefined
    }
    return mainWin.webContents
  }

  getWebContentsTargets(): BufferWebContentsLike[] {
    return this.mapWindowIdsToWebContents(this.coordinator.getLiveWindowIds())
  }

  dispose(): void {
    this.unsubscribeConfig()
    this.coordinator.dispose()
    this.windowsByWebContentsId.clear()
  }
}
