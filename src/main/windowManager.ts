import type { BrowserWindowConstructorOptions } from 'electron'
import type { SharedBufferHubEvent } from '@shared/documentBuffer'
import type { SharedDocumentBufferHub } from '@shared/sharedDocumentBufferHub'
import {
  cloneTabTransferPayloads,
  formatWindowTitle,
  WINDOW_ROLE_QUERY_PARAM,
  type DetachTabToNewWindowResult,
  type TabTransferPayload,
  type WindowInitContext,
  type WindowRole
} from '@shared/window'
import { trackHubWindowWebContents, type BufferWebContentsLike } from './ipc/registerBufferIpc'
import {
  computeOffsetAuxiliaryBounds,
  createAuxiliaryWindowOptions,
  createMainWindowOptions,
  type ScreenLike,
  type WindowBounds
} from './window'

export interface BrowserWindowLike {
  id: number
  webContents: BufferWebContentsLike
  getBounds(): WindowBounds
  removeMenu(): void
  show(): void
  close(): void
  isDestroyed(): boolean
  once(eventName: 'ready-to-show' | 'closed', listener: () => void): void
  loadURL(url: string): Promise<void> | void
  loadFile(filePath: string, options?: { query?: Record<string, string> }): Promise<void> | void
}

export interface WindowManagerDependencies {
  preloadPath: string
  rendererUrl?: string
  rendererFilePath: string
  bufferHub: SharedDocumentBufferHub
  createWindow: (options: BrowserWindowConstructorOptions) => BrowserWindowLike
  screen?: ScreenLike
}

interface WindowRecord {
  webContentsId: number
  role: WindowRole
  window: BrowserWindowLike
  initialTabs: TabTransferPayload[]
  hasSyncedNonEmptyTabs: boolean
  closing: boolean
}

function getNumericSenderId(sender: unknown): number | undefined {
  if (!sender || typeof sender !== 'object') return undefined
  const candidate = (sender as { id?: unknown }).id
  return typeof candidate === 'number' ? candidate : undefined
}

/**
 * Coordinates the single main window and detached auxiliary editor windows,
 * window initialization handshakes, transfer ownership claims, menu routing, and zero-tab auto-close.
 */
export class WindowManager {
  private readonly preloadPath: string
  private readonly rendererUrl?: string
  private readonly rendererFilePath: string
  private readonly bufferHub: SharedDocumentBufferHub
  private readonly createBrowserWindow: (options: BrowserWindowConstructorOptions) => BrowserWindowLike
  private readonly screen?: ScreenLike

  private readonly windowsByWebContentsId = new Map<number, WindowRecord>()
  private readonly recordsByWebContents = new WeakMap<object, WindowRecord>()
  private mainWebContentsId: number | null = null
  private readonly unsubscribeHub: () => void
  private disposed = false

  constructor({
    preloadPath,
    rendererUrl,
    rendererFilePath,
    bufferHub,
    createWindow,
    screen
  }: WindowManagerDependencies) {
    this.preloadPath = preloadPath
    this.rendererUrl = rendererUrl
    this.rendererFilePath = rendererFilePath
    this.bufferHub = bufferHub
    this.createBrowserWindow = createWindow
    this.screen = screen

    this.unsubscribeHub = this.bufferHub.subscribe((event) => {
      this.handleHubEvent(event)
    })
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

  private registerWindow(
    win: BrowserWindowLike,
    role: WindowRole,
    initialTabs: readonly TabTransferPayload[]
  ): WindowRecord {
    const webContentsId = trackHubWindowWebContents(this.bufferHub, win.webContents, win.id)
    const clonedTabs = cloneTabTransferPayloads(initialTabs)

    const record: WindowRecord = {
      webContentsId,
      role,
      window: win,
      initialTabs: clonedTabs,
      hasSyncedNonEmptyTabs: false,
      closing: false
    }

    this.windowsByWebContentsId.set(webContentsId, record)
    this.recordsByWebContents.set(win.webContents, record)
    if (role === 'main') {
      this.mainWebContentsId = webContentsId
    } else {
      win.removeMenu()
      for (const tab of clonedTabs) {
        this.bufferHub.registerPendingTransfer(webContentsId, tab.bufferKey)
      }
    }

    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) {
        win.show()
      }
    })

    win.once('closed', () => {
      this.windowsByWebContentsId.delete(webContentsId)
      if (this.mainWebContentsId === webContentsId) {
        this.mainWebContentsId = null
      }
    })

    return record
  }

  createMainWindow(): BrowserWindowLike {
    const win = this.createBrowserWindow(createMainWindowOptions(this.preloadPath))
    this.registerWindow(win, 'main', [])
    this.loadRendererContent(win, 'main')
    return win
  }

  createAuxiliaryWindow(
    initialTabs: readonly TabTransferPayload[],
    sourceBounds?: WindowBounds
  ): BrowserWindowLike {
    if (initialTabs.length === 0) {
      throw new Error('Auxiliary window requires at least one initial tab')
    }
    const firstKey = initialTabs[0].bufferKey
    const firstName = this.bufferHub.getBufferName(firstKey)
    const bounds = sourceBounds ? computeOffsetAuxiliaryBounds(sourceBounds, this.screen) : undefined
    const options = createAuxiliaryWindowOptions(this.preloadPath, {
      bounds,
      title: formatWindowTitle(firstName)
    })

    const win = this.createBrowserWindow(options)
    this.registerWindow(win, 'auxiliary', initialTabs)
    this.loadRendererContent(win, 'auxiliary')
    return win
  }

  private resolveRecordFromSender(sender: unknown): WindowRecord | undefined {
    if (!sender || typeof sender !== 'object') return undefined
    const direct = this.recordsByWebContents.get(sender)
    if (direct) return direct

    const numericId = getNumericSenderId(sender)
    return numericId !== undefined ? this.windowsByWebContentsId.get(numericId) : undefined
  }

  detachTabToNewWindow(
    sender: unknown,
    payload: TabTransferPayload
  ): DetachTabToNewWindowResult {
    const sourceRecord = this.resolveRecordFromSender(sender)
    if (!sourceRecord || sourceRecord.window.isDestroyed()) {
      throw new Error('Cannot detach tab from an unknown source window')
    }

    if (!payload || typeof payload.bufferKey !== 'string' || !this.bufferHub.hasBuffer(payload.bufferKey)) {
      throw new Error('Cannot detach unknown document buffer')
    }

    if (
      sourceRecord.role === 'auxiliary' &&
      this.bufferHub.getWindowTabCount(sourceRecord.webContentsId) <= 1
    ) {
      throw new Error('Cannot detach the last tab from an auxiliary window')
    }

    const auxWindow = this.createAuxiliaryWindow([payload], sourceRecord.window.getBounds())
    return {
      windowId: trackHubWindowWebContents(this.bufferHub, auxWindow.webContents, auxWindow.id)
    }
  }

  getWindowInitContext(sender: unknown): WindowInitContext {
    const record = this.resolveRecordFromSender(sender)
    if (!record) {
      return { role: 'main', initialTabs: [] }
    }
    return {
      role: record.role,
      initialTabs: cloneTabTransferPayloads(record.initialTabs)
    }
  }

  private closeRecord(record: WindowRecord): void {
    if (record.closing || record.window.isDestroyed()) return
    record.closing = true
    record.window.close()
  }

  closeCurrentWindow(sender: unknown): void {
    const record = this.resolveRecordFromSender(sender)
    if (!record || record.role !== 'auxiliary') return
    this.closeRecord(record)
  }

  private handleHubEvent(event: SharedBufferHubEvent): void {
    if (this.disposed) return

    if (event.type === 'paths-remapped') {
      const remappings = new Map(event.remappings.map((item) => [item.oldKey, item.newKey]))
      for (const record of this.windowsByWebContentsId.values()) {
        if (record.role !== 'auxiliary') continue
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
      for (const record of this.windowsByWebContentsId.values()) {
        if (record.role !== 'auxiliary') continue
        record.initialTabs = record.initialTabs.filter((tab) => !closedKeys.has(tab.bufferKey))
      }
      this.reconcileAuxiliaryAutoClose()
      return
    }

    if (event.type === 'state-changed') {
      this.reconcileAuxiliaryAutoClose()
    }
  }

  private reconcileAuxiliaryAutoClose(): void {
    for (const record of [...this.windowsByWebContentsId.values()]) {
      if (record.role !== 'auxiliary' || record.closing || record.window.isDestroyed()) {
        continue
      }

      const tabCount = this.bufferHub.getWindowTabCount(record.webContentsId)
      if (tabCount > 0) {
        record.hasSyncedNonEmptyTabs = true
        continue
      }

      if (record.hasSyncedNonEmptyTabs || record.initialTabs.length === 0) {
        this.closeRecord(record)
      }
    }
  }

  isMainWebContents(sender: unknown): boolean {
    const record = this.resolveRecordFromSender(sender)
    return record?.role === 'main' && !record.window.isDestroyed()
  }

  getMenuTargetWebContents(): BufferWebContentsLike | undefined {
    if (this.mainWebContentsId === null) return undefined
    const record = this.windowsByWebContentsId.get(this.mainWebContentsId)
    if (!record || record.window.isDestroyed() || record.window.webContents.isDestroyed()) {
      return undefined
    }
    return record.window.webContents
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
    this.unsubscribeHub()
    this.windowsByWebContentsId.clear()
    this.mainWebContentsId = null
  }
}
