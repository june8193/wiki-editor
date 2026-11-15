import type { BrowserWindowConstructorOptions } from 'electron'
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
import { trackHubWindowWebContents, type BufferWebContentsLike } from './ipc/registerBufferIpc'
import { createAuxiliaryWindowOptions, createMainWindowOptions } from './window'

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
  removeMenu(): void
  show(): void
  close(): void
  isDestroyed(): boolean
  on?(eventName: 'close', listener: (event: WindowCloseEventLike) => void): void
  removeListener?(eventName: 'close', listener: (event: WindowCloseEventLike) => void): void
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
  closePromptPending: boolean
  cleanupListeners?: () => void
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
  private readonly dragCoordinator = new TabDragCoordinator()
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
      closing: false,
      closePromptPending: false
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

    const handleBeforeInput = (_event: unknown, input: BeforeInputKeyEventLike): void => {
      this.dragCoordinator.handleBeforeInput(input)
    }
    const handleWindowClose = (event: WindowCloseEventLike): void => {
      this.handleWindowClose(record, event)
    }
    win.webContents.on?.('before-input-event', handleBeforeInput)
    win.on?.('close', handleWindowClose)
    record.cleanupListeners = () => {
      win.webContents.removeListener?.('before-input-event', handleBeforeInput)
      win.removeListener?.('close', handleWindowClose)
      record.cleanupListeners = undefined
    }

    win.once('closed', () => {
      record.cleanupListeners?.()
      this.dragCoordinator.clearForWindow(webContentsId)
      this.windowsByWebContentsId.delete(webContentsId)
      if (this.mainWebContentsId === webContentsId) {
        this.mainWebContentsId = null
        this.closeAllAuxiliaryWindows()
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
    const bounds = sourceBounds ? computeOffsetAuxiliaryBounds(sourceBounds, this.screen) : undefined
    return this.openAuxiliaryWindowWithBounds(initialTabs, bounds)
  }

  private openAuxiliaryWindowWithBounds(
    initialTabs: readonly TabTransferPayload[],
    bounds?: WindowBounds
  ): BrowserWindowLike {
    if (initialTabs.length === 0) {
      throw new Error('Auxiliary window requires at least one initial tab')
    }
    const firstKey = initialTabs[0].bufferKey
    const firstName = this.bufferHub.getBufferName(firstKey)
    const options = createAuxiliaryWindowOptions(this.preloadPath, {
      bounds,
      title: formatWindowTitle(firstName)
    })

    const win = this.createBrowserWindow(options)
    this.registerWindow(win, 'auxiliary', initialTabs)
    this.loadRendererContent(win, 'auxiliary')
    return win
  }

  private createDetachedAuxiliaryWindow(
    payload: TabTransferPayload,
    bounds?: WindowBounds
  ): DetachTabToNewWindowResult {
    const auxWindow = this.openAuxiliaryWindowWithBounds([payload], bounds)
    return {
      windowId: trackHubWindowWebContents(this.bufferHub, auxWindow.webContents, auxWindow.id)
    }
  }

  private resolveRecordFromSender(sender: unknown): WindowRecord | undefined {
    if (!sender || typeof sender !== 'object') return undefined
    const direct = this.recordsByWebContents.get(sender)
    if (direct) return direct

    const numericId = getNumericSenderId(sender)
    return numericId !== undefined ? this.windowsByWebContentsId.get(numericId) : undefined
  }

  private requireSourceWindow(sender: unknown, action: string): WindowRecord {
    const sourceRecord = this.resolveRecordFromSender(sender)
    if (!sourceRecord || sourceRecord.window.isDestroyed()) {
      throw new Error(`Cannot ${action} from an unknown source window`)
    }
    return sourceRecord
  }

  private assertKnownBuffer(payload: TabTransferPayload | undefined, action: string): void {
    if (!payload || typeof payload.bufferKey !== 'string' || !this.bufferHub.hasBuffer(payload.bufferKey)) {
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

  detachTabToNewWindow(
    sender: unknown,
    payload: TabTransferPayload
  ): DetachTabToNewWindowResult {
    const sourceRecord = this.requireSourceWindow(sender, 'detach tab')
    this.assertKnownBuffer(payload, 'detach')

    if (
      !canDetachTabFromWindow(
        sourceRecord.role,
        this.bufferHub.getWindowTabCount(sourceRecord.webContentsId)
      )
    ) {
      throw new Error('Cannot detach the last tab from an auxiliary window')
    }

    return this.createDetachedAuxiliaryWindow(
      payload,
      computeOffsetAuxiliaryBounds(sourceRecord.window.getBounds(), this.screen)
    )
  }

  onTabDragStateChanged(listener: (session: ActiveTabDragSession | null) => void): () => void {
    return this.dragCoordinator.onStateChanged(listener)
  }

  startTabDrag(sender: unknown, input: TabDragStartInput): ActiveTabDragSession {
    const sourceRecord = this.requireSourceWindow(sender, 'start tab drag')
    this.assertKnownBuffer(input?.payload, 'drag')
    return this.dragCoordinator.start(sourceRecord.webContentsId, input)
  }

  updateTabDragOutcome(
    sender: unknown,
    dragSessionId: string,
    outcome: TabDragResolution
  ): ActiveTabDragSession | null {
    const sourceRecord = this.resolveRecordFromSender(sender)
    if (!sourceRecord || sourceRecord.window.isDestroyed()) {
      return null
    }
    return this.dragCoordinator.updateOutcome(sourceRecord.webContentsId, dragSessionId, outcome)
  }

  /**
   * Accepts an active external tab drag drop onto the sender window, reserving shared buffer
   * ownership for the target window before broadcasting `'dropped-in-window'`.
   */
  acceptTabDragDrop(sender: unknown, input?: AcceptTabDragDropInput): AcceptTabDragDropResult {
    const targetRecord = this.resolveRecordFromSender(sender)
    if (!targetRecord || targetRecord.window.isDestroyed()) {
      return { accepted: false, reason: 'invalid-target-window' }
    }
    return this.dragCoordinator.acceptCrossWindowDrop({
      targetWindowId: targetRecord.webContentsId,
      dragSessionId: input?.dragSessionId,
      bufferHub: this.bufferHub
    })
  }

  endTabDrag(sender: unknown, input: TabDragEndInput): TabDragEndResult {
    const sourceRecord = this.resolveRecordFromSender(sender)
    if (!sourceRecord || sourceRecord.window.isDestroyed()) {
      return { detached: false, outcome: 'cancelled' }
    }

    const canDetach = canDetachTabFromWindow(
      sourceRecord.role,
      this.bufferHub.getWindowTabCount(sourceRecord.webContentsId)
    )
    const plan = this.dragCoordinator.finish({
      sourceWindowId: sourceRecord.webContentsId,
      input,
      openWindowBounds: this.getOpenWindowBounds(),
      canDetach,
      hasBuffer: (key) => this.bufferHub.hasBuffer(key),
      screen: this.screen
    })

    if (!plan.detach) {
      return plan.result
    }

    const { windowId } = this.createDetachedAuxiliaryWindow(plan.payload, plan.targetBounds)
    return { detached: true, windowId }
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

  private handleWindowClose(record: WindowRecord, event: WindowCloseEventLike): void {
    if (this.disposed || record.closing) return
    if (record.closePromptPending) {
      event.preventDefault()
      return
    }
    if (!this.bufferHub.hasDirtyBuffersForWindowClose(record.role, record.webContentsId)) {
      if (record.role === 'main') {
        record.closing = true
        this.closeAllAuxiliaryWindows()
      }
      return
    }

    event.preventDefault()
    record.closePromptPending = true
    if (!record.window.webContents.isDestroyed()) {
      record.window.webContents.send(WINDOW_IPC_CHANNELS.closeRequested, undefined)
    }
  }

  private closeAllAuxiliaryWindows(): void {
    for (const candidate of [...this.windowsByWebContentsId.values()]) {
      if (candidate.role === 'auxiliary') {
        this.closeRecord(candidate)
      }
    }
  }

  private closeRecord(record: WindowRecord): void {
    if (record.closing || record.window.isDestroyed()) return
    record.closePromptPending = false
    record.closing = true
    record.window.close()
  }

  closeCurrentWindow(sender: unknown): void {
    const record = this.resolveRecordFromSender(sender)
    if (!record || record.role !== 'auxiliary') return
    this.closeRecord(record)
  }

  resolveCloseRequest(sender: unknown, approved: boolean): void {
    const record = this.resolveRecordFromSender(sender)
    if (!record || record.window.isDestroyed() || !record.closePromptPending) return
    record.closePromptPending = false
    if (!approved) return
    if (record.role === 'main') {
      this.closeAllAuxiliaryWindows()
    }
    this.closeRecord(record)
  }

  private handleHubEvent(event: SharedBufferHubEvent): void {
    if (this.disposed) return

    if (event.type === 'paths-remapped') {
      this.dragCoordinator.remapPayloadKeys(event.remappings)
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
    for (const record of this.windowsByWebContentsId.values()) {
      record.cleanupListeners?.()
    }
    this.dragCoordinator.dispose()
    this.windowsByWebContentsId.clear()
    this.mainWebContentsId = null
  }
}
