import type { BrowserWindowConstructorOptions } from 'electron'
import { WINDOW_IPC_CHANNELS, type WindowCloseResponse } from '@shared/ipc'

const DEFAULT_CLOSE_ACK_TIMEOUT_MS = 1500

export interface NavigationGuardedWebContents {
  on(event: 'will-navigate', listener: (event: { preventDefault: () => void }, url: string) => void): unknown
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'allow' | 'deny' }): void
}

export interface ClosableWebContentsLike {
  isDestroyed(): boolean
  isLoadingMainFrame?: () => boolean
  send(channel: string, ...args: unknown[]): void
  on(event: 'render-process-gone', listener: (...args: unknown[]) => void): unknown
  removeListener(event: 'render-process-gone', listener: (...args: unknown[]) => void): unknown
}

export interface ClosableWindowLike {
  readonly webContents: ClosableWebContentsLike
  isDestroyed(): boolean
  close(): void
  destroy?: () => void
  on(event: 'close', listener: (event: { preventDefault: () => void }) => void): unknown
  on(event: 'closed', listener: () => void): unknown
  removeListener(event: 'close', listener: (event: { preventDefault: () => void }) => void): unknown
  removeListener(event: 'closed', listener: () => void): unknown
}

export interface CreateWindowCloseCoordinatorOptions {
  ackTimeoutMs?: number
}

export interface WindowCloseCoordinator {
  guardWindow(win: ClosableWindowLike): () => void
  handleCloseResponse(sender: unknown, response: WindowCloseResponse): void
  dispose(): void
}

export interface NavigationWebContentsLike {
  getURL(): string
  on(
    event: 'will-navigate',
    listener: (event: { preventDefault: () => void }, url: string) => void
  ): void
}

function isAllowedWindowNavigation(currentUrl: string, targetUrl: string): boolean {
  let target: URL
  try {
    target = new URL(targetUrl)
  } catch {
    return false
  }

  if (!currentUrl) {
    return target.protocol === 'file:' || target.protocol === 'http:' || target.protocol === 'https:'
  }

  let current: URL
  try {
    current = new URL(currentUrl)
  } catch {
    return false
  }

  if (current.protocol === 'file:' && target.protocol === 'file:') {
    return target.pathname.toLowerCase() === current.pathname.toLowerCase()
  }

  if (
    (current.protocol === 'http:' || current.protocol === 'https:') &&
    current.protocol === target.protocol
  ) {
    return target.origin === current.origin
  }

  return false
}

/**
 * Blocks accidental file drops or external URL navigations inside the application window.
 */
export function hardenWindowNavigation(webContents: NavigationWebContentsLike): void {
  webContents.on('will-navigate', (event, url) => {
    if (!isAllowedWindowNavigation(webContents.getURL(), url)) {
      event.preventDefault()
    }
  })
}

/**
 * Creates secure BrowserWindow options enforcing context isolation and disabled Node integration.
 */
export function createMainWindowOptions(preloadPath: string): BrowserWindowConstructorOptions {
  return {
    width: 1280,
    height: 820,
    minWidth: 800,
    minHeight: 560,
    show: false,
    title: 'Wiki Editor',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  }
}

/**
 * Blocks renderer-initiated document navigations and popups at the Electron BrowserWindow layer.
 */
export function registerWindowNavigationGuard(webContents: NavigationGuardedWebContents): void {
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })
}

type ClosePhase = 'idle' | 'awaiting-ack' | 'confirming'

interface WindowCloseEntry {
  win: ClosableWindowLike
  phase: ClosePhase
  isCloseApproved: boolean
  ackTimer: ReturnType<typeof setTimeout> | null
  cleanup: () => void
}

function clearEntryAckTimer(entry: WindowCloseEntry): void {
  if (entry.ackTimer !== null) {
    clearTimeout(entry.ackTimer)
    entry.ackTimer = null
  }
}

/**
 * Coordinates graceful window close confirmation with the renderer process while preserving
 * non-blocking fallbacks if the renderer is loading, unresponsive, or gone.
 */
export function createWindowCloseCoordinator(
  options: CreateWindowCloseCoordinatorOptions = {}
): WindowCloseCoordinator {
  const ackTimeoutMs = options.ackTimeoutMs ?? DEFAULT_CLOSE_ACK_TIMEOUT_MS
  const entriesBySender = new Map<unknown, WindowCloseEntry>()

  const approveAndClose = (entry: WindowCloseEntry, preferDestroy = false): void => {
    clearEntryAckTimer(entry)
    entry.phase = 'idle'
    entry.isCloseApproved = true
    if (entry.win.isDestroyed()) {
      return
    }
    if (preferDestroy && typeof entry.win.destroy === 'function') {
      entry.win.destroy()
      return
    }
    entry.win.close()
  }

  const guardWindow = (win: ClosableWindowLike): (() => void) => {
    const sender = win.webContents
    const existing = entriesBySender.get(sender)
    if (existing) {
      existing.cleanup()
    }

    const entry: WindowCloseEntry = {
      win,
      phase: 'idle',
      isCloseApproved: false,
      ackTimer: null,
      cleanup: () => undefined
    }

    const handleClose = (event: { preventDefault: () => void }): void => {
      if (entry.isCloseApproved) {
        return
      }
      if (
        win.isDestroyed() ||
        win.webContents.isDestroyed() ||
        win.webContents.isLoadingMainFrame?.() === true
      ) {
        return
      }

      event.preventDefault()
      if (entry.phase !== 'idle') {
        return
      }

      entry.phase = 'awaiting-ack'
      entry.ackTimer = setTimeout(() => {
        if (entry.phase === 'awaiting-ack') {
          approveAndClose(entry)
        }
      }, ackTimeoutMs)
      win.webContents.send(WINDOW_IPC_CHANNELS.closeRequested)
    }

    const handleRenderProcessGone = (): void => {
      if (entry.phase !== 'idle') {
        approveAndClose(entry, true)
      }
    }

    const handleClosed = (): void => {
      entry.cleanup()
    }

    const cleanup = (): void => {
      clearEntryAckTimer(entry)
      entry.phase = 'idle'
      entriesBySender.delete(sender)
      win.removeListener('close', handleClose)
      win.removeListener('closed', handleClosed)
      win.webContents.removeListener('render-process-gone', handleRenderProcessGone)
    }

    entry.cleanup = cleanup
    entriesBySender.set(sender, entry)
    win.on('close', handleClose)
    win.on('closed', handleClosed)
    win.webContents.on('render-process-gone', handleRenderProcessGone)

    return cleanup
  }

  const handleCloseResponse = (sender: unknown, response: WindowCloseResponse): void => {
    const entry = entriesBySender.get(sender)
    if (!entry) {
      return
    }

    if (response === 'confirming') {
      if (entry.phase === 'awaiting-ack') {
        clearEntryAckTimer(entry)
        entry.phase = 'confirming'
      }
      return
    }

    if (response === 'close') {
      if (entry.phase !== 'idle') {
        approveAndClose(entry)
      }
      return
    }

    if (entry.phase !== 'idle') {
      clearEntryAckTimer(entry)
      entry.phase = 'idle'
      entry.isCloseApproved = false
    }
  }

  const dispose = (): void => {
    for (const entry of [...entriesBySender.values()]) {
      entry.cleanup()
    }
  }

  return {
    guardWindow,
    handleCloseResponse,
    dispose
  }
}
