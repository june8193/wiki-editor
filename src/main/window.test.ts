import { afterEach, describe, expect, it, vi } from 'vitest'
import { WINDOW_IPC_CHANNELS } from '@shared/ipc'
import {
  type ClosableWebContentsLike,
  type ClosableWindowLike,
  createMainWindowOptions,
  createWindowCloseCoordinator,
  hardenWindowNavigation,
  registerWindowNavigationGuard
} from './window'

describe('createMainWindowOptions', () => {
  it('enforces contextIsolation: true, nodeIntegration: false, and sandbox: true with preload path', () => {
    const preloadPath = 'C:\\app\\out\\preload\\index.js'
    const options = createMainWindowOptions(preloadPath)

    expect(options.webPreferences).toMatchObject({
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    })
  })

  it('prevents accidental file drop and external URL navigation via will-navigate', () => {
    let listener: ((event: { preventDefault: () => void }, url: string) => void) | undefined
    const fakeWebContents = {
      getURL: () => 'file:///app/out/renderer/index.html',
      on: vi.fn((eventName: string, fn: typeof listener) => {
        if (eventName === 'will-navigate') {
          listener = fn
        }
      })
    }

    hardenWindowNavigation(fakeWebContents)
    expect(fakeWebContents.on).toHaveBeenCalledWith('will-navigate', expect.any(Function))

    const droppedFileEvent = { preventDefault: vi.fn() }
    listener?.(droppedFileEvent, 'file:///C:/Users/me/Desktop/photo.png')
    expect(droppedFileEvent.preventDefault).toHaveBeenCalledTimes(1)

    const externalUrlEvent = { preventDefault: vi.fn() }
    listener?.(externalUrlEvent, 'https://example.com')
    expect(externalUrlEvent.preventDefault).toHaveBeenCalledTimes(1)

    const sameRendererEvent = { preventDefault: vi.fn() }
    listener?.(sameRendererEvent, 'file:///app/out/renderer/index.html#section')
    expect(sameRendererEvent.preventDefault).not.toHaveBeenCalled()
  })
})

describe('registerWindowNavigationGuard', () => {
  it('blocks window navigation and denies new-window requests unconditionally', () => {
    let willNavigateHandler: ((event: { preventDefault: () => void }, url: string) => void) | undefined
    let windowOpenHandler: ((details: { url: string }) => { action: 'allow' | 'deny' }) | undefined

    const mockWebContents = {
      on(event: 'will-navigate', listener: (event: { preventDefault: () => void }, url: string) => void) {
        if (event === 'will-navigate') {
          willNavigateHandler = listener
        }
      },
      setWindowOpenHandler(handler: (details: { url: string }) => { action: 'allow' | 'deny' }) {
        windowOpenHandler = handler
      }
    }

    registerWindowNavigationGuard(mockWebContents)

    expect(willNavigateHandler).toBeDefined()
    expect(windowOpenHandler).toBeDefined()

    for (const targetUrl of [
      'https://example.com',
      'file:///C:/wiki/other.md',
      'http://localhost:5173/other.md'
    ]) {
      const preventDefault = vi.fn()
      willNavigateHandler!({ preventDefault }, targetUrl)
      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(windowOpenHandler!({ url: targetUrl })).toEqual({ action: 'deny' })
    }
  })
})

function createMockClosableWindow(options: {
  webContentsDestroyed?: boolean
  loadingMainFrame?: boolean
  windowDestroyed?: boolean
  withDestroyMethod?: boolean
} = {}) {
  const windowListeners = new Map<string, Set<(...args: never[]) => void>>()
  const webContentsListeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const sent: Array<{ channel: string; args: unknown[] }> = []
  let webContentsDestroyed = options.webContentsDestroyed ?? false
  let loadingMainFrame = options.loadingMainFrame ?? false
  let windowDestroyed = options.windowDestroyed ?? false

  const webContents: ClosableWebContentsLike & {
    emit(event: string, ...args: unknown[]): void
    setDestroyed(next: boolean): void
    setLoadingMainFrame(next: boolean): void
  } = {
    isDestroyed: () => webContentsDestroyed,
    isLoadingMainFrame: () => loadingMainFrame,
    send: vi.fn((channel: string, ...args: unknown[]) => {
      sent.push({ channel, args })
    }),
    on(event: string, listener: (...args: unknown[]) => void) {
      let set = webContentsListeners.get(event)
      if (!set) {
        set = new Set()
        webContentsListeners.set(event, set)
      }
      set.add(listener)
    },
    removeListener(event: string, listener: (...args: unknown[]) => void) {
      webContentsListeners.get(event)?.delete(listener)
    },
    emit(event: string, ...args: unknown[]) {
      for (const listener of [...(webContentsListeners.get(event) ?? [])]) {
        listener(...args)
      }
    },
    setDestroyed(next: boolean) {
      webContentsDestroyed = next
    },
    setLoadingMainFrame(next: boolean) {
      loadingMainFrame = next
    }
  }

  const win: ClosableWindowLike & {
    emitClose(): { preventDefault: ReturnType<typeof vi.fn> }
    emitClosed(): void
    setDestroyed(next: boolean): void
  } = {
    webContents,
    isDestroyed: () => windowDestroyed,
    close: vi.fn(() => {
      if (windowDestroyed) return
      const event = { preventDefault: vi.fn() }
      for (const listener of [...(windowListeners.get('close') ?? [])]) {
        ;(listener as (e: { preventDefault: () => void }) => void)(event)
      }
      if (!event.preventDefault.mock.calls.length) {
        windowDestroyed = true
        for (const listener of [...(windowListeners.get('closed') ?? [])]) {
          listener()
        }
      }
    }),
    ...(options.withDestroyMethod === false
      ? {}
      : {
          destroy: vi.fn(() => {
            windowDestroyed = true
            for (const listener of [...(windowListeners.get('closed') ?? [])]) {
              listener()
            }
          })
        }),
    on(event: string, listener: (...args: never[]) => void) {
      let set = windowListeners.get(event)
      if (!set) {
        set = new Set()
        windowListeners.set(event, set)
      }
      set.add(listener)
    },
    removeListener(event: string, listener: (...args: never[]) => void) {
      windowListeners.get(event)?.delete(listener)
    },
    emitClose() {
      const event = { preventDefault: vi.fn() }
      for (const listener of [...(windowListeners.get('close') ?? [])]) {
        ;(listener as (e: { preventDefault: () => void }) => void)(event)
      }
      return event
    },
    emitClosed() {
      windowDestroyed = true
      for (const listener of [...(windowListeners.get('closed') ?? [])]) {
        listener()
      }
    },
    setDestroyed(next: boolean) {
      windowDestroyed = next
    }
  }

  return { win, webContents, sent }
}

describe('createWindowCloseCoordinator', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('intercepts close, requests renderer confirmation, and closes without re-intercepting once approved', () => {
    const coordinator = createWindowCloseCoordinator()
    const { win, webContents, sent } = createMockClosableWindow()

    coordinator.guardWindow(win)

    const firstClose = win.emitClose()
    expect(firstClose.preventDefault).toHaveBeenCalledTimes(1)
    expect(sent).toEqual([{ channel: WINDOW_IPC_CHANNELS.closeRequested, args: [] }])

    coordinator.handleCloseResponse(webContents, 'close')
    expect(win.close).toHaveBeenCalledTimes(1)
    expect(win.isDestroyed()).toBe(true)

    coordinator.dispose()
  })

  it('clears ack timeout on confirming and allows re-prompting after cancel', () => {
    vi.useFakeTimers()
    const coordinator = createWindowCloseCoordinator({ ackTimeoutMs: 1000 })
    const { win, webContents, sent } = createMockClosableWindow()

    coordinator.guardWindow(win)

    const firstClose = win.emitClose()
    expect(firstClose.preventDefault).toHaveBeenCalledTimes(1)
    expect(sent).toHaveLength(1)

    coordinator.handleCloseResponse(webContents, 'confirming')
    vi.advanceTimersByTime(5000)
    expect(win.close).not.toHaveBeenCalled()

    coordinator.handleCloseResponse(webContents, 'cancel')
    expect(win.close).not.toHaveBeenCalled()

    const secondClose = win.emitClose()
    expect(secondClose.preventDefault).toHaveBeenCalledTimes(1)
    expect(sent).toHaveLength(2)

    coordinator.handleCloseResponse(webContents, 'close')
    expect(win.close).toHaveBeenCalledTimes(1)
  })

  it('deduplicates repeated close events while awaiting-ack or confirming', () => {
    const coordinator = createWindowCloseCoordinator()
    const { win, webContents, sent } = createMockClosableWindow()

    coordinator.guardWindow(win)

    expect(win.emitClose().preventDefault).toHaveBeenCalledTimes(1)
    expect(win.emitClose().preventDefault).toHaveBeenCalledTimes(1)
    expect(sent).toHaveLength(1)

    coordinator.handleCloseResponse(webContents, 'confirming')
    expect(win.emitClose().preventDefault).toHaveBeenCalledTimes(1)
    expect(sent).toHaveLength(1)

    coordinator.dispose()
  })

  it('does not prevent close when webContents is destroyed or still loading main frame', () => {
    const coordinator = createWindowCloseCoordinator()
    const destroyedCase = createMockClosableWindow({ webContentsDestroyed: true })
    const loadingCase = createMockClosableWindow({ loadingMainFrame: true })

    coordinator.guardWindow(destroyedCase.win)
    coordinator.guardWindow(loadingCase.win)

    expect(destroyedCase.win.emitClose().preventDefault).not.toHaveBeenCalled()
    expect(destroyedCase.sent).toHaveLength(0)

    expect(loadingCase.win.emitClose().preventDefault).not.toHaveBeenCalled()
    expect(loadingCase.sent).toHaveLength(0)

    coordinator.dispose()
  })

  it('falls back to closing the window if renderer does not acknowledge within ackTimeoutMs', () => {
    vi.useFakeTimers()
    const coordinator = createWindowCloseCoordinator({ ackTimeoutMs: 1500 })
    const { win } = createMockClosableWindow()

    coordinator.guardWindow(win)

    const closeEvent = win.emitClose()
    expect(closeEvent.preventDefault).toHaveBeenCalledTimes(1)
    expect(win.close).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1499)
    expect(win.close).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(win.close).toHaveBeenCalledTimes(1)
    expect(win.isDestroyed()).toBe(true)
  })

  it('destroys or closes the window if render-process-gone fires while awaiting close resolution', () => {
    const coordinator = createWindowCloseCoordinator()
    const withDestroy = createMockClosableWindow()
    const withoutDestroy = createMockClosableWindow({ withDestroyMethod: false })

    coordinator.guardWindow(withDestroy.win)
    coordinator.guardWindow(withoutDestroy.win)

    withDestroy.win.emitClose()
    withDestroy.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
    expect(withDestroy.win.destroy).toHaveBeenCalledTimes(1)
    expect(withDestroy.win.isDestroyed()).toBe(true)

    withoutDestroy.win.emitClose()
    withoutDestroy.webContents.emit('render-process-gone', {}, { reason: 'killed', exitCode: 9 })
    expect(withoutDestroy.win.close).toHaveBeenCalledTimes(1)
    expect(withoutDestroy.win.isDestroyed()).toBe(true)

    coordinator.dispose()
  })

  it('cleans up pending timers on window closed and ignores responses for unknown senders', () => {
    vi.useFakeTimers()
    const coordinator = createWindowCloseCoordinator({ ackTimeoutMs: 1000 })
    const { win } = createMockClosableWindow()
    const unknownSender = createMockClosableWindow().webContents

    coordinator.guardWindow(win)
    win.emitClose()
    win.emitClosed()

    vi.advanceTimersByTime(2000)
    expect(win.close).not.toHaveBeenCalled()
    expect(() => coordinator.handleCloseResponse(unknownSender, 'close')).not.toThrow()
  })
})
