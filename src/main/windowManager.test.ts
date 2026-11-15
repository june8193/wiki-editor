import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindowConstructorOptions } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocumentBuffer, SharedBufferStateSnapshot } from '@shared/documentBuffer'
import { BUFFER_IPC_CHANNELS, WINDOW_IPC_CHANNELS, WORKSPACE_IPC_CHANNELS } from '@shared/ipc'
import type { SharedDocumentBufferHub } from '@shared/sharedDocumentBufferHub'
import {
  WINDOW_BASE_TITLE,
  type AcceptTabDragDropResult,
  type ActiveTabDragSession,
  type DetachTabToNewWindowResult,
  type ScreenLike,
  type TabDragEndResult,
  type TabTransferPayload,
  type WindowBounds,
  type WindowInitContext
} from '@shared/window'
import { ConfigService } from './config/ConfigService'
import { createFakeIpcMain, type FakeIpcMain } from './ipc/ipcTestHelpers'
import { createSharedDocumentBufferHub, registerBufferIpc, type BufferWebContentsLike } from './ipc/registerBufferIpc'
import { registerWindowIpc } from './ipc/registerWindowIpc'
import { registerWorkspaceIpc } from './ipc/registerWorkspaceIpc'
import { WindowManager, type BrowserWindowLike } from './windowManager'
import { WorkspaceFsService } from './workspace/WorkspaceFsService'
import { TabDragCoordinator } from '@shared/tabDragSession'

interface FakeWindowInstance extends BrowserWindowLike {
  options: BrowserWindowConstructorOptions
  loadedUrls: string[]
  loadedFiles: Array<{ filePath: string; query?: Record<string, string> }>
  removedMenu: boolean
  shown: boolean
  closedCount: number
  sentMessages: Array<{ channel: string; payload: unknown }>
  emitReadyToShow: () => void
  emitBeforeInput: (input: { type?: string; key?: string; code?: string }) => void
  getBeforeInputListenerCount: () => number
  simulateUserClose: () => void
}

function createFakeBrowserWindowFactory(defaultBounds: WindowBounds = { x: 100, y: 120, width: 1280, height: 820 }) {
  let nextWinId = 10
  let nextWebContentsId = 100
  const createdWindows: FakeWindowInstance[] = []

  const createWindow = (options: BrowserWindowConstructorOptions): FakeWindowInstance => {
    const winId = nextWinId++
    const webContentsId = nextWebContentsId++
    let destroyed = false
    let closedCount = 0
    const windowListeners = {
      'ready-to-show': [] as Array<() => void>,
      closed: [] as Array<() => void>,
      close: new Set<(event: { preventDefault: () => void }) => void>()
    }
    const webContentsDestroyedListeners: Array<() => void> = []
    const beforeInputListeners = new Set<
      (event: unknown, input: { type?: string; key?: string; code?: string }) => void
    >()
    const sentMessages: Array<{ channel: string; payload: unknown }> = []
    const loadedUrls: string[] = []
    const loadedFiles: Array<{ filePath: string; query?: Record<string, string> }> = []
    const bounds: WindowBounds = {
      x: options.x ?? defaultBounds.x,
      y: options.y ?? defaultBounds.y,
      width: options.width ?? defaultBounds.width,
      height: options.height ?? defaultBounds.height
    }

    const destroyWindow = () => {
      if (destroyed) return
      destroyed = true
      for (const listener of webContentsDestroyedListeners.splice(0)) {
        listener()
      }
      for (const listener of windowListeners.closed.splice(0)) {
        listener()
      }
    }

    const fireCloseAndDestroyIfAllowed = () => {
      if (destroyed) return
      let prevented = false
      const event = {
        preventDefault: () => {
          prevented = true
        }
      }
      for (const listener of [...windowListeners.close]) {
        listener(event)
      }
      if (!prevented) {
        destroyWindow()
      }
    }

    const fakeWin: FakeWindowInstance = {
      id: winId,
      options,
      loadedUrls,
      loadedFiles,
      removedMenu: false,
      shown: false,
      get closedCount() {
        return closedCount
      },
      sentMessages,
      webContents: {
        id: webContentsId,
        isDestroyed: () => destroyed,
        send: (channel: string, payload: unknown) => {
          if (!destroyed) {
            sentMessages.push({ channel, payload })
          }
        },
        once: (eventName: 'destroyed', listener: () => void) => {
          if (eventName === 'destroyed') {
            webContentsDestroyedListeners.push(listener)
          }
        },
        on: (
          eventName: 'before-input-event',
          listener: (event: unknown, input: { type?: string; key?: string; code?: string }) => void
        ) => {
          if (eventName === 'before-input-event') {
            beforeInputListeners.add(listener)
          }
        },
        removeListener: (
          eventName: 'before-input-event',
          listener: (event: unknown, input: { type?: string; key?: string; code?: string }) => void
        ) => {
          if (eventName === 'before-input-event') {
            beforeInputListeners.delete(listener)
          }
        }
      },
      getBounds: () => ({ ...bounds }),
      removeMenu: () => {
        fakeWin.removedMenu = true
      },
      show: () => {
        fakeWin.shown = true
      },
      close: () => {
        closedCount += 1
        fireCloseAndDestroyIfAllowed()
      },
      isDestroyed: () => destroyed,
      on: (eventName: 'close', listener: (event: { preventDefault: () => void }) => void) => {
        if (eventName === 'close') {
          windowListeners.close.add(listener)
        }
      },
      removeListener: (
        eventName: 'close',
        listener: (event: { preventDefault: () => void }) => void
      ) => {
        if (eventName === 'close') {
          windowListeners.close.delete(listener)
        }
      },
      once: (eventName: 'ready-to-show' | 'closed', listener: () => void) => {
        windowListeners[eventName].push(listener)
      },
      loadURL: (url: string) => {
        loadedUrls.push(url)
      },
      loadFile: (filePath: string, loadOptions?: { query?: Record<string, string> }) => {
        loadedFiles.push({ filePath, query: loadOptions?.query })
      },
      emitReadyToShow: () => {
        for (const listener of windowListeners['ready-to-show'].splice(0)) {
          listener()
        }
      },
      emitBeforeInput: (input) => {
        for (const listener of beforeInputListeners) {
          listener({ preventDefault: vi.fn() }, input)
        }
      },
      getBeforeInputListenerCount: () => beforeInputListeners.size,
      simulateUserClose: () => {
        fireCloseAndDestroyIfAllowed()
      }
    }

    createdWindows.push(fakeWin)
    return fakeWin
  }

  return { createWindow, createdWindows }
}

describe('WindowManager + Multi-window Main Process IPC', () => {
  let tempDir: string
  let workspaceDir: string
  let configPath: string
  let workspaceService: WorkspaceFsService
  let configService: ConfigService
  let bufferHub: SharedDocumentBufferHub
  let windowManager: WindowManager
  let ipcHarness: FakeIpcMain
  let createdWindows: FakeWindowInstance[]
  let disposeFns: Array<() => void>
  let fakeScreen: ScreenLike

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'wiki-editor-winmgr-'))
    workspaceDir = join(tempDir, 'docs')
    configPath = join(tempDir, 'config.json')
    await mkdir(workspaceDir, { recursive: true })
    await writeFile(join(workspaceDir, 'alpha.md'), '# Alpha\nInitial body', 'utf8')
    await writeFile(join(workspaceDir, 'beta.md'), '# Beta\nSecond doc', 'utf8')

    workspaceService = new WorkspaceFsService({ watchDebounceMs: 30 })
    configService = new ConfigService(configPath)
    ipcHarness = createFakeIpcMain()

    const factory = createFakeBrowserWindowFactory()
    createdWindows = factory.createdWindows
    fakeScreen = {
      getDisplayNearestPoint: () => ({
        workArea: { x: 0, y: 0, width: 1400, height: 900 }
      })
    }

    bufferHub = createSharedDocumentBufferHub({
      workspaceService,
      configService,
      initialAutoSaveConfig: { autoSave: false, autoSaveDelayMs: 1000 }
    })

    windowManager = new WindowManager({
      preloadPath: 'C:\\app\\out\\preload\\index.js',
      rendererFilePath: 'C:\\app\\out\\renderer\\index.html',
      bufferHub,
      createWindow: factory.createWindow,
      screen: fakeScreen
    })

    disposeFns = [
      registerBufferIpc({
        ipcMain: ipcHarness,
        configService,
        hub: bufferHub,
        getTargets: () => windowManager.getWebContentsTargets()
      }),
      registerWorkspaceIpc({
        ipcMain: ipcHarness,
        workspaceService,
        configService,
        selectDirectory: async () => workspaceDir,
        getTargets: () => windowManager.getWebContentsTargets(),
        isMainWindowSender: (sender) => windowManager.isMainWebContents(sender)
      }),
      registerWindowIpc({
        ipcMain: ipcHarness,
        windowManager
      })
    ]
  })

  afterEach(async () => {
    for (const dispose of disposeFns.reverse()) {
      dispose()
    }
    windowManager.dispose()
    workspaceService.dispose()
    await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
  })

  it('creates main window with menu preserved and detaches tab into clamped offset auxiliary window without menu', async () => {
    const mainWin = windowManager.createMainWindow() as FakeWindowInstance
    expect(mainWin.removedMenu).toBe(false)
    expect(mainWin.loadedFiles).toEqual([{ filePath: 'C:\\app\\out\\renderer\\index.html', query: undefined }])
    expect(windowManager.isMainWebContents(mainWin.webContents)).toBe(true)

    await ipcHarness.invokeFrom(mainWin.webContents, WORKSPACE_IPC_CHANNELS.open, workspaceDir)
    const alphaPath = join(workspaceDir, 'alpha.md')
    const buffer = (await ipcHarness.invokeFrom(
      mainWin.webContents,
      BUFFER_IPC_CHANNELS.openWorkspaceFile,
      alphaPath,
      'alpha.md'
    )) as DocumentBuffer
    await ipcHarness.invokeFrom(mainWin.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [buffer.key])
    await ipcHarness.invokeFrom(
      mainWin.webContents,
      BUFFER_IPC_CHANNELS.updateContent,
      buffer.key,
      '# Alpha\nUnsaved detached edit'
    )

    const payload: TabTransferPayload = {
      bufferKey: buffer.key,
      mode: 'wysiwyg',
      cursor: { selectionStart: 4, selectionEnd: 9 },
      scrollTop: 185
    }
    const result = await ipcHarness.invokeFrom<DetachTabToNewWindowResult>(
      mainWin.webContents,
      WINDOW_IPC_CHANNELS.detachTabToNewWindow,
      payload
    )

    const auxWin = createdWindows[1]
    expect(auxWin).toBeDefined()
    expect(result.windowId).toBe(auxWin.webContents.id)
    expect(auxWin.removedMenu).toBe(true)
    expect(auxWin.options).toMatchObject({
      width: 960,
      height: 760,
      minWidth: 520,
      minHeight: 420,
      title: 'alpha.md - Wiki Editor',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    // Main window bounds {100,120,1280,820} + (40,40) -> (140,160) with 960x760 -> clamped inside 1400x900 workArea (max y = 140)
    expect(auxWin.getBounds()).toEqual({ x: 140, y: 140, width: 960, height: 760 })
    expect(auxWin.loadedFiles).toEqual([
      {
        filePath: 'C:\\app\\out\\renderer\\index.html',
        query: { windowRole: 'auxiliary' }
      }
    ])
    expect(windowManager.isMainWebContents(auxWin.webContents)).toBe(false)
    expect(windowManager.getMenuTargetWebContents()).toBe(mainWin.webContents)

    // Source window drops its only tab (including StrictMode cleanup releasePending: true) BEFORE aux syncs:
    // the shared dirty buffer MUST remain preserved for the pending auxiliary window transfer!
    const afterMainClear = await ipcHarness.invokeFrom<SharedBufferStateSnapshot>(
      mainWin.webContents,
      BUFFER_IPC_CHANNELS.syncWindowTabs,
      [],
      { releasePending: true }
    )
    expect(afterMainClear.buffers[buffer.key]?.content).toBe('# Alpha\nUnsaved detached edit')
    expect(afterMainClear.buffers[buffer.key]?.isDirty).toBe(true)

    // Auxiliary window reads its init context (even repeatedly across StrictMode) and syncs its tab
    const initCtx1 = await ipcHarness.invokeFrom<WindowInitContext>(
      auxWin.webContents,
      WINDOW_IPC_CHANNELS.getInitContext
    )
    const initCtx2 = await ipcHarness.invokeFrom<WindowInitContext>(
      auxWin.webContents,
      WINDOW_IPC_CHANNELS.getInitContext
    )
    expect(initCtx1).toEqual({ role: 'auxiliary', initialTabs: [payload] })
    expect(initCtx2).toEqual({ role: 'auxiliary', initialTabs: [payload] })

    await ipcHarness.invokeFrom(auxWin.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [buffer.key])
    expect(auxWin.isDestroyed()).toBe(false)
    expect(bufferHub.getSnapshot().buffers[buffer.key]?.content).toBe('# Alpha\nUnsaved detached edit')
  })

  it('enforces single-tab guard on auxiliary detach while allowing multi-tab auxiliary detach', async () => {
    const mainWin = windowManager.createMainWindow() as FakeWindowInstance
    await ipcHarness.invokeFrom(mainWin.webContents, WORKSPACE_IPC_CHANNELS.open, workspaceDir)
    const alphaBuf = (await ipcHarness.invokeFrom(
      mainWin.webContents,
      BUFFER_IPC_CHANNELS.openWorkspaceFile,
      join(workspaceDir, 'alpha.md')
    )) as DocumentBuffer
    const betaBuf = (await ipcHarness.invokeFrom(
      mainWin.webContents,
      BUFFER_IPC_CHANNELS.openWorkspaceFile,
      join(workspaceDir, 'beta.md')
    )) as DocumentBuffer

    await ipcHarness.invokeFrom(mainWin.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [alphaBuf.key])
    await ipcHarness.invokeFrom(mainWin.webContents, WINDOW_IPC_CHANNELS.detachTabToNewWindow, {
      bufferKey: alphaBuf.key,
      mode: 'raw',
      cursor: { selectionStart: 0, selectionEnd: 0 },
      scrollTop: 0
    })
    const aux1 = createdWindows[1]
    await ipcHarness.invokeFrom(aux1.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [alphaBuf.key])

    // Single tab on auxiliary -> detach rejected
    await expect(
      ipcHarness.invokeFrom(aux1.webContents, WINDOW_IPC_CHANNELS.detachTabToNewWindow, {
        bufferKey: alphaBuf.key,
        mode: 'raw',
        cursor: { selectionStart: 0, selectionEnd: 0 },
        scrollTop: 0
      })
    ).rejects.toThrow()

    // Two tabs on auxiliary -> detach allowed
    await ipcHarness.invokeFrom(aux1.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [
      alphaBuf.key,
      betaBuf.key
    ])
    const result2 = await ipcHarness.invokeFrom<DetachTabToNewWindowResult>(
      aux1.webContents,
      WINDOW_IPC_CHANNELS.detachTabToNewWindow,
      {
        bufferKey: betaBuf.key,
        mode: 'preview',
        cursor: { selectionStart: 1, selectionEnd: 1 },
        scrollTop: 50
      }
    )
    expect(createdWindows[2].webContents.id).toBe(result2.windowId)
    expect(createdWindows[2].options.title).toBe('beta.md - Wiki Editor')
  })

  it('keeps booting auxiliary window open before initial tab hydration and auto-closes once synced tabs drop to zero', async () => {
    const mainWin = windowManager.createMainWindow() as FakeWindowInstance
    await ipcHarness.invokeFrom(mainWin.webContents, WORKSPACE_IPC_CHANNELS.open, workspaceDir)
    const alphaBuf = (await ipcHarness.invokeFrom(
      mainWin.webContents,
      BUFFER_IPC_CHANNELS.openWorkspaceFile,
      join(workspaceDir, 'alpha.md')
    )) as DocumentBuffer
    await ipcHarness.invokeFrom(mainWin.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [alphaBuf.key])
    await ipcHarness.invokeFrom(mainWin.webContents, WINDOW_IPC_CHANNELS.detachTabToNewWindow, {
      bufferKey: alphaBuf.key,
      mode: 'raw',
      cursor: { selectionStart: 0, selectionEnd: 0 },
      scrollTop: 0
    })
    const auxWin = createdWindows[1]

    // Pre-hydration mount sends syncWindowTabs([]) before getInitContext resolves -> must stay open
    await ipcHarness.invokeFrom(auxWin.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [])
    expect(auxWin.isDestroyed()).toBe(false)

    // Hydrates [alpha] then closes last tab -> auto-closes
    await ipcHarness.invokeFrom(auxWin.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [alphaBuf.key])
    expect(auxWin.isDestroyed()).toBe(false)

    await ipcHarness.invokeFrom(auxWin.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [])
    expect(auxWin.closedCount).toBe(1)
    expect(auxWin.isDestroyed()).toBe(true)
    expect(mainWin.isDestroyed()).toBe(false)
  })

  it('passes windowRole=auxiliary query string and fallback base title when buffer name is absent', () => {
    const devFactory = createFakeBrowserWindowFactory()
    const devWinMgr = new WindowManager({
      preloadPath: 'C:\\app\\out\\preload\\index.js',
      rendererUrl: 'http://localhost:5173/app?foo=bar',
      rendererFilePath: 'C:\\app\\out\\renderer\\index.html',
      bufferHub,
      createWindow: devFactory.createWindow
    })

    const mainWin = devWinMgr.createMainWindow() as FakeWindowInstance
    const auxWin = devWinMgr.createAuxiliaryWindow([
      {
        bufferKey: 'c:/wiki/unloaded.md',
        mode: 'raw',
        cursor: { selectionStart: 0, selectionEnd: 0 },
        scrollTop: 0
      }
    ]) as FakeWindowInstance

    expect(auxWin.options.title).toBe(WINDOW_BASE_TITLE)
    expect(mainWin.loadedUrls).toEqual(['http://localhost:5173/app?foo=bar'])
    expect(auxWin.loadedUrls).toEqual(['http://localhost:5173/app?foo=bar&windowRole=auxiliary'])
    devWinMgr.dispose()
  })

  it('keeps workspace watch owned solely by main window across auxiliary mount/unmount and broadcasts to all', async () => {
    const mainWin = windowManager.createMainWindow() as FakeWindowInstance
    const auxWin = windowManager.createAuxiliaryWindow([
      {
        bufferKey: 'c:/wiki/alpha.md',
        mode: 'raw',
        cursor: { selectionStart: 0, selectionEnd: 0 },
        scrollTop: 0
      }
    ]) as FakeWindowInstance

    await ipcHarness.invokeFrom(auxWin.webContents, WORKSPACE_IPC_CHANNELS.watch)
    await ipcHarness.invokeFrom(mainWin.webContents, WORKSPACE_IPC_CHANNELS.open, workspaceDir)
    await ipcHarness.invokeFrom(mainWin.webContents, WORKSPACE_IPC_CHANNELS.watch)

    // Unwatching from auxiliary window MUST NOT stop main window watch
    await ipcHarness.invokeFrom(auxWin.webContents, WORKSPACE_IPC_CHANNELS.unwatch)
    await writeFile(join(workspaceDir, 'external-update.md'), '# Ext', 'utf8')

    await vi.waitFor(() => {
      expect(mainWin.sentMessages.some((msg) => msg.channel === WORKSPACE_IPC_CHANNELS.changed)).toBe(true)
      expect(auxWin.sentMessages.some((msg) => msg.channel === WORKSPACE_IPC_CHANNELS.changed)).toBe(true)
    })

    // Aux calling window:close-current closes only auxiliary
    await ipcHarness.invokeFrom(auxWin.webContents, WINDOW_IPC_CHANNELS.closeCurrent)
    expect(auxWin.isDestroyed()).toBe(true)
    expect(mainWin.isDestroyed()).toBe(false)

    // Main calling window:close-current is a no-op (only auxiliary auto-close uses it)
    await ipcHarness.invokeFrom(mainWin.webContents, WINDOW_IPC_CHANNELS.closeCurrent)
    expect(mainWin.isDestroyed()).toBe(false)
  })

  it('clears pending transfer ownership on auxiliary close even if no buffer IPC ran yet', async () => {
    const mainWin = windowManager.createMainWindow() as FakeWindowInstance
    await ipcHarness.invokeFrom(mainWin.webContents, WORKSPACE_IPC_CHANNELS.open, workspaceDir)
    const alphaBuf = (await ipcHarness.invokeFrom(
      mainWin.webContents,
      BUFFER_IPC_CHANNELS.openWorkspaceFile,
      join(workspaceDir, 'alpha.md')
    )) as DocumentBuffer
    await ipcHarness.invokeFrom(mainWin.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [alphaBuf.key])
    await ipcHarness.invokeFrom(
      mainWin.webContents,
      BUFFER_IPC_CHANNELS.updateContent,
      alphaBuf.key,
      '# Alpha\nUnsaved transfer'
    )

    await ipcHarness.invokeFrom(mainWin.webContents, WINDOW_IPC_CHANNELS.detachTabToNewWindow, {
      bufferKey: alphaBuf.key,
      mode: 'raw',
      cursor: { selectionStart: 0, selectionEnd: 0 },
      scrollTop: 0
    })
    const auxWin = createdWindows[1]
    await ipcHarness.invokeFrom(mainWin.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [])
    expect(bufferHub.hasBuffer(alphaBuf.key)).toBe(true)

    // Aux closes before sending any buffer:* IPC
    auxWin.simulateUserClose()
    expect(bufferHub.hasBuffer(alphaBuf.key)).toBe(false)
  })

  function setupScopedDragHarness(
    screen: ScreenLike,
    mainBounds = { x: 100, y: 120, width: 1280, height: 820 }
  ) {
    const factory = createFakeBrowserWindowFactory(mainBounds)
    const manager = new WindowManager({
      preloadPath: 'C:\\app\\out\\preload\\index.js',
      rendererFilePath: 'C:\\app\\out\\renderer\\index.html',
      bufferHub,
      createWindow: factory.createWindow,
      screen
    })
    const scopedIpc = createFakeIpcMain()
    const disposers = [
      registerBufferIpc({
        ipcMain: scopedIpc,
        configService,
        hub: bufferHub,
        getTargets: () => manager.getWebContentsTargets()
      }),
      registerWorkspaceIpc({
        ipcMain: scopedIpc,
        workspaceService,
        configService,
        selectDirectory: async () => workspaceDir,
        getTargets: () => manager.getWebContentsTargets(),
        isMainWindowSender: (sender) => manager.isMainWebContents(sender)
      }),
      registerWindowIpc({
        ipcMain: scopedIpc,
        windowManager: manager
      })
    ]
    return {
      factory,
      manager,
      scopedIpc,
      dispose: () => {
        for (const dispose of disposers.reverse()) {
          dispose()
        }
        manager.dispose()
      }
    }
  }

  it('detaches dirty 1-tab from main into clamped cursor auxiliary window on outside dragend and ignores drops inside any open window bounds', async () => {
    const {
      factory: wideFactory,
      manager: wideManager,
      scopedIpc: wideIpc,
      dispose: disposeScoped
    } = setupScopedDragHarness({
      getDisplayNearestPoint: ({ x }) =>
        x < 0
          ? { workArea: { x: -1920, y: 0, width: 1920, height: 1040 } }
          : { workArea: { x: 0, y: 0, width: 2560, height: 1440 } }
    })

    try {
      const mainWin = wideManager.createMainWindow() as FakeWindowInstance
      await wideIpc.invokeFrom(mainWin.webContents, WORKSPACE_IPC_CHANNELS.open, workspaceDir)
      const alphaBuf = (await wideIpc.invokeFrom(
        mainWin.webContents,
        BUFFER_IPC_CHANNELS.openWorkspaceFile,
        join(workspaceDir, 'alpha.md'),
        'alpha.md'
      )) as DocumentBuffer
      await wideIpc.invokeFrom(mainWin.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [
        alphaBuf.key
      ])
      await wideIpc.invokeFrom(
        mainWin.webContents,
        BUFFER_IPC_CHANNELS.updateContent,
        alphaBuf.key,
        '# Dirty drag content'
      )

      const payload: TabTransferPayload = {
        bufferKey: alphaBuf.key,
        mode: 'preview',
        cursor: { selectionStart: 2, selectionEnd: 7 },
        scrollTop: 220
      }

      // Drop inside main window bounds -> does NOT detach
      const insideSession = await wideIpc.invokeFrom<ActiveTabDragSession>(
        mainWin.webContents,
        WINDOW_IPC_CHANNELS.startTabDrag,
        { paneId: 'primary', tabId: 'tab-1', payload }
      )
      expect(insideSession).toMatchObject({
        sourceWindowId: mainWin.webContents.id,
        paneId: 'primary',
        tabId: 'tab-1',
        outcome: 'pending'
      })
      const insideEnd = await wideIpc.invokeFrom<TabDragEndResult>(
        mainWin.webContents,
        WINDOW_IPC_CHANNELS.endTabDrag,
        { dragSessionId: insideSession.dragSessionId, screenPoint: { x: 600, y: 400 }, payload }
      )
      expect(insideEnd).toEqual({ detached: false, outcome: 'cancelled' })
      expect(wideFactory.createdWindows).toHaveLength(1)

      // Drop outside main window (right edge x=1380 is half-open outside) near workArea bottom-right -> detaches at clamped cursor bounds
      const outsideSession = await wideIpc.invokeFrom<ActiveTabDragSession>(
        mainWin.webContents,
        WINDOW_IPC_CHANNELS.startTabDrag,
        { paneId: 'primary', tabId: 'tab-1', payload }
      )
      expect(
        mainWin.sentMessages.some(
          (m) =>
            m.channel === WINDOW_IPC_CHANNELS.dragStateChanged &&
            (m.payload as ActiveTabDragSession | null)?.dragSessionId ===
              outsideSession.dragSessionId &&
            (m.payload as ActiveTabDragSession | null)?.outcome === 'pending'
        )
      ).toBe(true)

      const outsideEnd = await wideIpc.invokeFrom<TabDragEndResult>(
        mainWin.webContents,
        WINDOW_IPC_CHANNELS.endTabDrag,
        { dragSessionId: outsideSession.dragSessionId, screenPoint: { x: 1800, y: 800 }, payload }
      )
      expect(wideFactory.createdWindows).toHaveLength(2)

      const aux1 = wideFactory.createdWindows[1]
      expect(outsideEnd).toEqual({ detached: true, windowId: aux1.webContents.id })
      expect(aux1.removedMenu).toBe(true)
      // (1800, 800) with 960x760 inside 2560x1440 workArea -> maxX=1600, maxY=680
      expect(aux1.getBounds()).toEqual({ x: 1600, y: 680, width: 960, height: 760 })

      // Main clears its sole tab after detach while shared dirty buffer remains alive for aux1
      const afterClear = await wideIpc.invokeFrom<SharedBufferStateSnapshot>(
        mainWin.webContents,
        BUFFER_IPC_CHANNELS.syncWindowTabs,
        []
      )
      expect(afterClear.buffers[alphaBuf.key]?.content).toBe('# Dirty drag content')
      expect(afterClear.buffers[alphaBuf.key]?.isDirty).toBe(true)
      expect(
        await wideIpc.invokeFrom<WindowInitContext>(
          aux1.webContents,
          WINDOW_IPC_CHANNELS.getInitContext
        )
      ).toEqual({ role: 'auxiliary', initialTabs: [payload] })

      // Dropping inside ANY open auxiliary window's bounds also suppresses detach
      const betaBuf = (await wideIpc.invokeFrom(
        mainWin.webContents,
        BUFFER_IPC_CHANNELS.openWorkspaceFile,
        join(workspaceDir, 'beta.md'),
        'beta.md'
      )) as DocumentBuffer
      await wideIpc.invokeFrom(mainWin.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [
        betaBuf.key
      ])
      const overAuxSession = await wideIpc.invokeFrom<ActiveTabDragSession>(
        mainWin.webContents,
        WINDOW_IPC_CHANNELS.startTabDrag,
        {
          paneId: 'primary',
          tabId: 'tab-2',
          payload: {
            bufferKey: betaBuf.key,
            mode: 'raw',
            cursor: { selectionStart: 0, selectionEnd: 0 },
            scrollTop: 0
          }
        }
      )
      const overAuxEnd = await wideIpc.invokeFrom<TabDragEndResult>(
        mainWin.webContents,
        WINDOW_IPC_CHANNELS.endTabDrag,
        {
          dragSessionId: overAuxSession.dragSessionId,
          screenPoint: { x: 1700, y: 800 }
        }
      )
      expect(overAuxEnd).toEqual({ detached: false, outcome: 'cancelled' })
      expect(wideFactory.createdWindows).toHaveLength(2)
    } finally {
      disposeScoped()
    }
  })

  it('cancels drag via before-input-event Escape or dropped-in-window outcome, uses screen cursor point, and enforces auxiliary single-tab drag guard', async () => {
    let screenCursor = { x: 1500, y: 200 }
    const {
      factory: cursorFactory,
      manager: cursorManager,
      scopedIpc: cursorIpc,
      dispose: disposeScoped
    } = setupScopedDragHarness({
      getDisplayNearestPoint: () => ({
        workArea: { x: 0, y: 0, width: 2560, height: 1440 }
      }),
      getCursorScreenPoint: () => ({ ...screenCursor })
    })

    try {
      const mainWin = cursorManager.createMainWindow() as FakeWindowInstance
      await cursorIpc.invokeFrom(mainWin.webContents, WORKSPACE_IPC_CHANNELS.open, workspaceDir)
      const alphaBuf = (await cursorIpc.invokeFrom(
        mainWin.webContents,
        BUFFER_IPC_CHANNELS.openWorkspaceFile,
        join(workspaceDir, 'alpha.md')
      )) as DocumentBuffer
      const betaBuf = (await cursorIpc.invokeFrom(
        mainWin.webContents,
        BUFFER_IPC_CHANNELS.openWorkspaceFile,
        join(workspaceDir, 'beta.md')
      )) as DocumentBuffer
      await cursorIpc.invokeFrom(mainWin.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [
        alphaBuf.key,
        betaBuf.key
      ])

      const alphaPayload: TabTransferPayload = {
        bufferKey: alphaBuf.key,
        mode: 'raw',
        cursor: { selectionStart: 0, selectionEnd: 0 },
        scrollTop: 0
      }

      // Esc during drag (via Electron before-input-event) marks session 'cancelled' and blocks outside detach
      const escSession = await cursorIpc.invokeFrom<ActiveTabDragSession>(
        mainWin.webContents,
        WINDOW_IPC_CHANNELS.startTabDrag,
        { paneId: 'primary', tabId: 'tab-1', payload: alphaPayload }
      )
      mainWin.emitBeforeInput({ type: 'keyDown', key: 'Escape' })
      expect(
        mainWin.sentMessages.some(
          (m) =>
            m.channel === WINDOW_IPC_CHANNELS.dragStateChanged &&
            (m.payload as ActiveTabDragSession | null)?.dragSessionId === escSession.dragSessionId &&
            (m.payload as ActiveTabDragSession | null)?.outcome === 'cancelled'
        )
      ).toBe(true)

      screenCursor = { x: 1500, y: 200 }
      const escEnd = await cursorIpc.invokeFrom<TabDragEndResult>(
        mainWin.webContents,
        WINDOW_IPC_CHANNELS.endTabDrag,
        { dragSessionId: escSession.dragSessionId, screenPoint: { x: 1500, y: 200 } }
      )
      expect(escEnd).toEqual({ detached: false, outcome: 'cancelled' })
      expect(cursorFactory.createdWindows).toHaveLength(1)

      // In-window drop transition prevents detach and is not overwritten by a subsequent Escape event
      const inWinSession = await cursorIpc.invokeFrom<ActiveTabDragSession>(
        mainWin.webContents,
        WINDOW_IPC_CHANNELS.startTabDrag,
        { paneId: 'primary', tabId: 'tab-1', payload: alphaPayload }
      )
      await cursorIpc.invokeFrom(
        mainWin.webContents,
        WINDOW_IPC_CHANNELS.updateTabDragOutcome,
        inWinSession.dragSessionId,
        'dropped-in-window'
      )
      mainWin.emitBeforeInput({ type: 'keyDown', key: 'Escape' })
      const inWinEnd = await cursorIpc.invokeFrom<TabDragEndResult>(
        mainWin.webContents,
        WINDOW_IPC_CHANNELS.endTabDrag,
        { dragSessionId: inWinSession.dragSessionId, screenPoint: { x: 1500, y: 200 } }
      )
      expect(inWinEnd).toEqual({ detached: false, outcome: 'dropped-in-window' })
      expect(cursorFactory.createdWindows).toHaveLength(1)

      // Successful drag-out uses authoritative screen.getCursorScreenPoint() even if renderer sent stale (200,200)
      const validSession = await cursorIpc.invokeFrom<ActiveTabDragSession>(
        mainWin.webContents,
        WINDOW_IPC_CHANNELS.startTabDrag,
        { paneId: 'primary', tabId: 'tab-1', payload: alphaPayload }
      )
      screenCursor = { x: 1520, y: 210 }
      const validEnd = await cursorIpc.invokeFrom<TabDragEndResult>(
        mainWin.webContents,
        WINDOW_IPC_CHANNELS.endTabDrag,
        { dragSessionId: validSession.dragSessionId, screenPoint: { x: 200, y: 200 } }
      )
      expect(validEnd.detached).toBe(true)
      const aux1 = cursorFactory.createdWindows[1]
      expect(aux1.getBounds()).toEqual({ x: 1520, y: 210, width: 960, height: 760 })
      await cursorIpc.invokeFrom(aux1.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [alphaBuf.key])

      // Single-tab auxiliary window outside drop is silently ignored (no new window, no throw)
      screenCursor = { x: 20, y: 30 }
      const soloAuxDrag = await cursorIpc.invokeFrom<ActiveTabDragSession>(
        aux1.webContents,
        WINDOW_IPC_CHANNELS.startTabDrag,
        { paneId: 'primary', tabId: 'tab-1', payload: alphaPayload }
      )
      const soloAuxEnd = await cursorIpc.invokeFrom<TabDragEndResult>(
        aux1.webContents,
        WINDOW_IPC_CHANNELS.endTabDrag,
        { dragSessionId: soloAuxDrag.dragSessionId, screenPoint: { x: 20, y: 30 } }
      )
      expect(soloAuxEnd).toEqual({ detached: false, outcome: 'cancelled' })
      expect(cursorFactory.createdWindows).toHaveLength(2)

      // Auxiliary window with 2 tabs CAN detach via drag-out, and closing mid-drag cleans listeners
      await cursorIpc.invokeFrom(aux1.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [
        alphaBuf.key,
        betaBuf.key
      ])
      const multiAuxDrag = await cursorIpc.invokeFrom<ActiveTabDragSession>(
        aux1.webContents,
        WINDOW_IPC_CHANNELS.startTabDrag,
        {
          paneId: 'primary',
          tabId: 'tab-2',
          payload: {
            bufferKey: betaBuf.key,
            mode: 'wysiwyg',
            cursor: { selectionStart: 1, selectionEnd: 1 },
            scrollTop: 50
          }
        }
      )
      const multiAuxEnd = await cursorIpc.invokeFrom<TabDragEndResult>(
        aux1.webContents,
        WINDOW_IPC_CHANNELS.endTabDrag,
        { dragSessionId: multiAuxDrag.dragSessionId, screenPoint: { x: 20, y: 30 } }
      )
      expect(multiAuxEnd.detached).toBe(true)
      expect(cursorFactory.createdWindows).toHaveLength(3)

      // Mid-drag close clears active drag session and detaches before-input-event listener
      expect(aux1.getBeforeInputListenerCount()).toBe(1)
      await cursorIpc.invokeFrom(aux1.webContents, WINDOW_IPC_CHANNELS.startTabDrag, {
        paneId: 'primary',
        tabId: 'tab-1',
        payload: alphaPayload
      })
      aux1.simulateUserClose()
      expect(aux1.getBeforeInputListenerCount()).toBe(0)
      expect(mainWin.sentMessages[mainWin.sentMessages.length - 1]).toEqual({
        channel: WINDOW_IPC_CHANNELS.dragStateChanged,
        payload: null
      })
    } finally {
      disposeScoped()
    }
  })

  it('accepts cross-window tab drops across main and auxiliary windows, preserves dirty buffers, suppresses duplicate spawn, and auto-closes empty source auxiliary window', async () => {
    await writeFile(join(workspaceDir, 'alpha.md'), '# Alpha disk', 'utf-8')
    await writeFile(join(workspaceDir, 'beta.md'), '# Beta disk', 'utf-8')
    await writeFile(join(workspaceDir, 'gamma.md'), '# Gamma disk', 'utf-8')

    let screenCursor = { x: 1600, y: 200 }
    const {
      factory,
      manager,
      scopedIpc: ipc,
      dispose: disposeScoped
    } = setupScopedDragHarness(
      {
        getDisplayNearestPoint: () => ({
          workArea: { x: 0, y: 0, width: 1920, height: 1080 }
        }),
        getCursorScreenPoint: () => ({ ...screenCursor })
      },
      { x: 0, y: 0, width: 1200, height: 800 }
    )

    try {
      const mainWin = manager.createMainWindow() as FakeWindowInstance
      await ipc.invokeFrom(mainWin.webContents, WORKSPACE_IPC_CHANNELS.open, workspaceDir)
      const alphaBuf = await ipc.invokeFrom<DocumentBuffer>(
        mainWin.webContents,
        BUFFER_IPC_CHANNELS.openWorkspaceFile,
        join(workspaceDir, 'alpha.md')
      )
      const betaBuf = await ipc.invokeFrom<DocumentBuffer>(
        mainWin.webContents,
        BUFFER_IPC_CHANNELS.openWorkspaceFile,
        join(workspaceDir, 'beta.md')
      )
      const gammaBuf = await ipc.invokeFrom<DocumentBuffer>(
        mainWin.webContents,
        BUFFER_IPC_CHANNELS.openWorkspaceFile,
        join(workspaceDir, 'gamma.md')
      )
      await ipc.invokeFrom(mainWin.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [
        alphaBuf.key,
        betaBuf.key,
        gammaBuf.key
      ])

      const betaPayload: TabTransferPayload = {
        bufferKey: betaBuf.key,
        mode: 'wysiwyg',
        cursor: { selectionStart: 3, selectionEnd: 9 },
        scrollTop: 84
      }
      const gammaPayload: TabTransferPayload = {
        bufferKey: gammaBuf.key,
        mode: 'raw',
        cursor: { selectionStart: 2, selectionEnd: 5 },
        scrollTop: 12
      }

      // 1. Detach beta and gamma into two auxiliary windows (aux1, aux2)
      await ipc.invokeFrom(mainWin.webContents, WINDOW_IPC_CHANNELS.detachTabToNewWindow, betaPayload)
      const aux1 = factory.createdWindows[1]
      await ipc.invokeFrom(aux1.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [betaBuf.key])

      await ipc.invokeFrom(mainWin.webContents, WINDOW_IPC_CHANNELS.detachTabToNewWindow, gammaPayload)
      const aux2 = factory.createdWindows[2]
      await ipc.invokeFrom(aux2.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [gammaBuf.key])
      await ipc.invokeFrom(mainWin.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [alphaBuf.key])

      // Make beta dirty in aux1 before dragging across windows
      await ipc.invokeFrom(
        aux1.webContents,
        BUFFER_IPC_CHANNELS.updateContent,
        betaBuf.key,
        '# Beta unsaved edit',
        1
      )

      const invalidTargetResult = await ipc.invokeFrom<AcceptTabDragDropResult>(
        { id: 999999 } as never,
        WINDOW_IPC_CHANNELS.acceptTabDragDrop,
        {}
      )
      expect(invalidTargetResult).toEqual({ accepted: false, reason: 'invalid-target-window' })

      // 2. Aux1 -> Main drop acceptance + rejection guards
      const noActiveResult = await ipc.invokeFrom<AcceptTabDragDropResult>(
        mainWin.webContents,
        WINDOW_IPC_CHANNELS.acceptTabDragDrop,
        {}
      )
      expect(noActiveResult).toEqual({ accepted: false, reason: 'no-active-drag' })

      const aux1Drag = await ipc.invokeFrom<ActiveTabDragSession>(
        aux1.webContents,
        WINDOW_IPC_CHANNELS.startTabDrag,
        {
          paneId: 'primary',
          tabId: 'tab-beta',
          payload: betaPayload
        }
      )

      // Same-window drop is rejected without mutating the pending session
      const sameWindowResult = await ipc.invokeFrom<AcceptTabDragDropResult>(
        aux1.webContents,
        WINDOW_IPC_CHANNELS.acceptTabDragDrop,
        { dragSessionId: aux1Drag.dragSessionId }
      )
      expect(sameWindowResult).toEqual({ accepted: false, reason: 'same-window' })

      // Mismatched session id is rejected
      const mismatchResult = await ipc.invokeFrom<AcceptTabDragDropResult>(
        mainWin.webContents,
        WINDOW_IPC_CHANNELS.acceptTabDragDrop,
        { dragSessionId: 'wrong-session' }
      )
      expect(mismatchResult).toEqual({ accepted: false, reason: 'session-mismatch' })

      // Valid drop onto main window (even without passing dragSessionId explicitly)
      const acceptedOnMain = await ipc.invokeFrom<AcceptTabDragDropResult>(
        mainWin.webContents,
        WINDOW_IPC_CHANNELS.acceptTabDragDrop,
        {}
      )
      expect(acceptedOnMain).toMatchObject({
        accepted: true,
        dragSessionId: aux1Drag.dragSessionId,
        sourceWindowId: aux1.webContents.id,
        targetWindowId: mainWin.webContents.id,
        payload: betaPayload,
        buffer: {
          key: betaBuf.key,
          content: '# Beta unsaved edit',
          isDirty: true
        }
      })

      // Broadcast informs source window with dropped-in-window + targetWindowId
      expect(aux1.sentMessages[aux1.sentMessages.length - 1]).toEqual({
        channel: WINDOW_IPC_CHANNELS.dragStateChanged,
        payload: {
          ...aux1Drag,
          targetWindowId: mainWin.webContents.id,
          outcome: 'dropped-in-window'
        }
      })

      // Second drop attempt on the same resolved session fails with drag-not-pending
      const duplicateAccept = await ipc.invokeFrom<AcceptTabDragDropResult>(
        aux2.webContents,
        WINDOW_IPC_CHANNELS.acceptTabDragDrop,
        { dragSessionId: aux1Drag.dragSessionId }
      )
      expect(duplicateAccept).toEqual({ accepted: false, reason: 'drag-not-pending' })

      // Even if source syncs empty tabs BEFORE main syncs beta, dirty buffer stays alive via pending transfer
      await ipc.invokeFrom(aux1.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [])
      expect(aux1.closedCount).toBe(1)
      expect(bufferHub.hasBuffer(betaBuf.key)).toBe(true)
      expect(bufferHub.getBuffer(betaBuf.key)?.content).toBe('# Beta unsaved edit')

      // Source endTabDrag does NOT spawn an extra auxiliary window even if cursor is outside all bounds
      screenCursor = { x: 1850, y: 950 }
      const aux1End = await ipc.invokeFrom<TabDragEndResult>(
        aux1.webContents,
        WINDOW_IPC_CHANNELS.endTabDrag,
        { dragSessionId: aux1Drag.dragSessionId, screenPoint: screenCursor }
      )
      expect(aux1End).toEqual({ detached: false, outcome: 'cancelled' })
      expect(factory.createdWindows).toHaveLength(3)

      // Target main commits tab ownership
      await ipc.invokeFrom(mainWin.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [
        alphaBuf.key,
        betaBuf.key
      ])

      // 3. Main -> Aux2 drop acceptance
      const mainToAuxDrag = await ipc.invokeFrom<ActiveTabDragSession>(
        mainWin.webContents,
        WINDOW_IPC_CHANNELS.startTabDrag,
        {
          paneId: 'primary',
          tabId: 'tab-beta',
          payload: betaPayload
        }
      )
      const acceptedOnAux2 = await ipc.invokeFrom<AcceptTabDragDropResult>(
        aux2.webContents,
        WINDOW_IPC_CHANNELS.acceptTabDragDrop,
        { dragSessionId: mainToAuxDrag.dragSessionId }
      )
      expect(acceptedOnAux2).toMatchObject({
        accepted: true,
        sourceWindowId: mainWin.webContents.id,
        targetWindowId: aux2.webContents.id,
        buffer: { key: betaBuf.key, content: '# Beta unsaved edit', isDirty: true }
      })
      const mainEnd = await ipc.invokeFrom<TabDragEndResult>(
        mainWin.webContents,
        WINDOW_IPC_CHANNELS.endTabDrag,
        { dragSessionId: mainToAuxDrag.dragSessionId, screenPoint: { x: 1850, y: 950 } }
      )
      expect(mainEnd).toEqual({ detached: false, outcome: 'dropped-in-window' })
      expect(factory.createdWindows).toHaveLength(3)

      // 4. Aux2 -> Main drop closes aux2 only when its tab count becomes 0, and endTabDrag ignores cancelled sessions
      await ipc.invokeFrom(aux2.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [
        gammaBuf.key,
        betaBuf.key
      ])
      const aux2ToMain = await ipc.invokeFrom<ActiveTabDragSession>(
        aux2.webContents,
        WINDOW_IPC_CHANNELS.startTabDrag,
        { paneId: 'primary', tabId: 'tab-gamma', payload: gammaPayload }
      )
      const acceptedGamma = await ipc.invokeFrom<AcceptTabDragDropResult>(
        mainWin.webContents,
        WINDOW_IPC_CHANNELS.acceptTabDragDrop,
        { dragSessionId: aux2ToMain.dragSessionId }
      )
      expect(acceptedGamma.accepted).toBe(true)
      await ipc.invokeFrom(aux2.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [betaBuf.key])
      expect(aux2.closedCount).toBe(0)

      // Cancelled drag session rejects acceptTabDragDrop
      const aux2BetaDrag = await ipc.invokeFrom<ActiveTabDragSession>(
        aux2.webContents,
        WINDOW_IPC_CHANNELS.startTabDrag,
        { paneId: 'primary', tabId: 'tab-beta', payload: betaPayload }
      )
      await ipc.invokeFrom(
        aux2.webContents,
        WINDOW_IPC_CHANNELS.updateTabDragOutcome,
        aux2BetaDrag.dragSessionId,
        'cancelled'
      )
      const cancelledAccept = await ipc.invokeFrom<AcceptTabDragDropResult>(
        mainWin.webContents,
        WINDOW_IPC_CHANNELS.acceptTabDragDrop,
        {}
      )
      expect(cancelledAccept).toEqual({ accepted: false, reason: 'drag-not-pending' })
    } finally {
      disposeScoped()
    }
  })

  it('reclaims a recently ended pending drag session when endTabDrag beats acceptTabDragDrop, while blocking reclaimed drops after Escape or expiry', async () => {
    let nowMs = 1_000
    const coordinator = new TabDragCoordinator({ now: () => nowMs, crossWindowReclaimGraceMs: 500 })
    const betaPayload: TabTransferPayload = {
      bufferKey: 'c:/wiki/beta.md',
      mode: 'wysiwyg',
      cursor: { selectionStart: 1, selectionEnd: 4 },
      scrollTop: 55
    }
    const betaBuffer: DocumentBuffer = {
      key: 'c:/wiki/beta.md',
      path: 'C:/wiki/beta.md',
      name: 'beta.md',
      kind: 'workspace',
      contentKind: 'text',
      content: '# Beta dirty',
      savedContent: '# Beta disk',
      isDirty: true,
      version: 2,
      isSaving: false
    }
    const reservedTransfers: Array<{ windowId: number; bufferKey: string }> = []
    const emitted: Array<ActiveTabDragSession | null> = []
    coordinator.onStateChanged((session) => emitted.push(session))

    const bufferHubPort = {
      getBuffer: (key: string) => (key === betaBuffer.key ? betaBuffer : undefined),
      registerPendingTransfer: (windowId: number, bufferKey: string) => {
        reservedTransfers.push({ windowId, bufferKey })
      }
    }

    // 1. Cross-process race: source 1-tab auxiliary finishes endTabDrag BEFORE target acceptTabDragDrop arrives
    const drag1 = coordinator.start(2, { paneId: 'primary', tabId: 'tab-beta', payload: betaPayload })
    const updatedPayload: TabTransferPayload = { ...betaPayload, scrollTop: 120 }
    const finishPlan = coordinator.finish({
      sourceWindowId: 2,
      input: { dragSessionId: drag1.dragSessionId, screenPoint: { x: 250, y: 250 }, payload: updatedPayload },
      openWindowBounds: [{ x: 0, y: 0, width: 1200, height: 800 }],
      canDetach: false,
      hasBuffer: () => true
    })
    expect(finishPlan).toEqual({ detach: false, result: { detached: false, outcome: 'cancelled' } })

    nowMs += 50
    const reclaimed = coordinator.acceptCrossWindowDrop({
      targetWindowId: 1,
      bufferHub: bufferHubPort
    })
    expect(reclaimed).toEqual({
      accepted: true,
      dragSessionId: drag1.dragSessionId,
      sourceWindowId: 2,
      targetWindowId: 1,
      payload: updatedPayload,
      buffer: betaBuffer
    })
    expect(reservedTransfers).toEqual([{ windowId: 1, bufferKey: betaBuffer.key }])
    expect(emitted[emitted.length - 1]).toEqual({
      ...drag1,
      payload: updatedPayload,
      targetWindowId: 1,
      outcome: 'dropped-in-window'
    })

    // Consumed reclaimed session cannot be accepted a second time
    expect(coordinator.acceptCrossWindowDrop({ targetWindowId: 3, bufferHub: bufferHubPort })).toEqual({
      accepted: false,
      reason: 'no-active-drag'
    })

    // 2. Escape cancellation before finish must NOT become reclaimable
    const dragEsc = coordinator.start(2, { paneId: 'primary', tabId: 'tab-beta', payload: betaPayload })
    coordinator.handleBeforeInput({ type: 'keyDown', key: 'Escape' })
    coordinator.finish({
      sourceWindowId: 2,
      input: { dragSessionId: dragEsc.dragSessionId, screenPoint: { x: 250, y: 250 } },
      openWindowBounds: [{ x: 0, y: 0, width: 1200, height: 800 }],
      canDetach: false,
      hasBuffer: () => true
    })
    expect(coordinator.acceptCrossWindowDrop({ targetWindowId: 1, bufferHub: bufferHubPort })).toEqual({
      accepted: false,
      reason: 'no-active-drag'
    })

    // 3. Reclaim grace expires cleanly after TTL
    const dragExpired = coordinator.start(2, { paneId: 'primary', tabId: 'tab-beta', payload: betaPayload })
    coordinator.finish({
      sourceWindowId: 2,
      input: { dragSessionId: dragExpired.dragSessionId, screenPoint: { x: 250, y: 250 } },
      openWindowBounds: [{ x: 0, y: 0, width: 1200, height: 800 }],
      canDetach: true,
      hasBuffer: () => true
    })
    nowMs += 501
    expect(coordinator.acceptCrossWindowDrop({ targetWindowId: 1, bufferHub: bufferHubPort })).toEqual({
      accepted: false,
      reason: 'no-active-drag'
    })
  })

  it('guards auxiliary X close only when closing drops last tab reference to a dirty workspace/config buffer, while bypassing guard on programmatic auto-close', async () => {
    await writeFile(join(workspaceDir, 'shared.md'), '# Shared', 'utf-8')
    await writeFile(join(workspaceDir, 'exclusive.md'), '# Exclusive', 'utf-8')

    const mainWin = windowManager.createMainWindow() as FakeWindowInstance
    await ipcHarness.invokeFrom(mainWin.webContents, WORKSPACE_IPC_CHANNELS.open, workspaceDir)

    const sharedBuf = (await ipcHarness.invokeFrom(
      mainWin.webContents,
      BUFFER_IPC_CHANNELS.openWorkspaceFile,
      join(workspaceDir, 'shared.md')
    )) as DocumentBuffer
    const exclusiveBuf = (await ipcHarness.invokeFrom(
      mainWin.webContents,
      BUFFER_IPC_CHANNELS.openWorkspaceFile,
      join(workspaceDir, 'exclusive.md')
    )) as DocumentBuffer
    const configBuf = (await ipcHarness.invokeFrom(
      mainWin.webContents,
      BUFFER_IPC_CHANNELS.openConfigDocument
    )) as DocumentBuffer

    await ipcHarness.invokeFrom(mainWin.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [
      sharedBuf.key,
      exclusiveBuf.key,
      configBuf.key
    ])

    // Detach sharedBuf to aux1 while keeping a second tab of sharedBuf open in Main
    await ipcHarness.invokeFrom(mainWin.webContents, WINDOW_IPC_CHANNELS.detachTabToNewWindow, {
      bufferKey: sharedBuf.key,
      mode: 'raw',
      cursor: { selectionStart: 0, selectionEnd: 0 },
      scrollTop: 0
    })
    const auxShared = createdWindows[1]
    await ipcHarness.invokeFrom(auxShared.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [
      sharedBuf.key
    ])
    await ipcHarness.invokeFrom(
      auxShared.webContents,
      BUFFER_IPC_CHANNELS.updateContent,
      sharedBuf.key,
      '# Shared dirty'
    )

    // auxShared shares dirty sharedBuf with Main -> X closes immediately without prompt
    auxShared.sentMessages.length = 0
    auxShared.simulateUserClose()
    expect(auxShared.isDestroyed()).toBe(true)
    expect(
      auxShared.sentMessages.some((msg) => msg.channel === WINDOW_IPC_CHANNELS.closeRequested)
    ).toBe(false)

    // Detach exclusive workspace file + config.json to auxExclusive (now sole reference)
    await ipcHarness.invokeFrom(mainWin.webContents, WINDOW_IPC_CHANNELS.detachTabToNewWindow, {
      bufferKey: exclusiveBuf.key,
      mode: 'raw',
      cursor: { selectionStart: 0, selectionEnd: 0 },
      scrollTop: 0
    })
    const auxExclusive = createdWindows[2]
    await ipcHarness.invokeFrom(auxExclusive.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [
      exclusiveBuf.key,
      configBuf.key
    ])
    await ipcHarness.invokeFrom(mainWin.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [
      sharedBuf.key
    ])
    await ipcHarness.invokeFrom(
      auxExclusive.webContents,
      BUFFER_IPC_CHANNELS.updateContent,
      configBuf.key,
      '{"autoSave":false,"theme":"dark"}'
    )

    // Aux holding sole dirty config.json reference intercepts X and prompts
    auxExclusive.sentMessages.length = 0
    mainWin.sentMessages.length = 0
    auxExclusive.simulateUserClose()
    expect(auxExclusive.isDestroyed()).toBe(false)
    expect(
      auxExclusive.sentMessages.filter((msg) => msg.channel === WINDOW_IPC_CHANNELS.closeRequested)
    ).toHaveLength(1)
    expect(
      mainWin.sentMessages.some((msg) => msg.channel === WINDOW_IPC_CHANNELS.closeRequested)
    ).toBe(false)

    // Duplicate X click while prompt pending does not emit duplicate prompt
    auxExclusive.simulateUserClose()
    expect(
      auxExclusive.sentMessages.filter((msg) => msg.channel === WINDOW_IPC_CHANNELS.closeRequested)
    ).toHaveLength(1)

    // Cancelling keeps aux open, and subsequent X re-prompts
    await ipcHarness.invokeFrom(
      auxExclusive.webContents,
      WINDOW_IPC_CHANNELS.resolveCloseRequest,
      false
    )
    expect(auxExclusive.isDestroyed()).toBe(false)
    auxExclusive.simulateUserClose()
    expect(
      auxExclusive.sentMessages.filter((msg) => msg.channel === WINDOW_IPC_CHANNELS.closeRequested)
    ).toHaveLength(2)

    // Approving closes aux
    await ipcHarness.invokeFrom(
      auxExclusive.webContents,
      WINDOW_IPC_CHANNELS.resolveCloseRequest,
      true
    )
    expect(auxExclusive.isDestroyed()).toBe(true)

    // Programmatic empty-tab auto-close bypasses close guard
    await ipcHarness.invokeFrom(
      mainWin.webContents,
      BUFFER_IPC_CHANNELS.openWorkspaceFile,
      join(workspaceDir, 'exclusive.md')
    )
    await ipcHarness.invokeFrom(mainWin.webContents, WINDOW_IPC_CHANNELS.detachTabToNewWindow, {
      bufferKey: exclusiveBuf.key,
      mode: 'raw',
      cursor: { selectionStart: 0, selectionEnd: 0 },
      scrollTop: 0
    })
    const auxProgrammatic = createdWindows[3]
    await ipcHarness.invokeFrom(auxProgrammatic.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [
      exclusiveBuf.key
    ])
    await ipcHarness.invokeFrom(
      auxProgrammatic.webContents,
      BUFFER_IPC_CHANNELS.updateContent,
      exclusiveBuf.key,
      '# Dirty before programmatic auto-close'
    )
    await ipcHarness.invokeFrom(auxProgrammatic.webContents, WINDOW_IPC_CHANNELS.closeCurrent)
    expect(auxProgrammatic.isDestroyed()).toBe(true)
    expect(
      auxProgrammatic.sentMessages.some((msg) => msg.channel === WINDOW_IPC_CHANNELS.closeRequested)
    ).toBe(false)
  })

  it('guards main window X close across main and all auxiliary buffers and closes all auxiliary windows together without per-auxiliary prompts', async () => {
    await writeFile(join(workspaceDir, 'note-a.md'), '# Note A', 'utf-8')
    await writeFile(join(workspaceDir, 'note-b.md'), '# Note B', 'utf-8')

    const mainWin = windowManager.createMainWindow() as FakeWindowInstance
    await ipcHarness.invokeFrom(mainWin.webContents, WORKSPACE_IPC_CHANNELS.open, workspaceDir)

    const bufA = (await ipcHarness.invokeFrom(
      mainWin.webContents,
      BUFFER_IPC_CHANNELS.openWorkspaceFile,
      join(workspaceDir, 'note-a.md')
    )) as DocumentBuffer
    const bufB = (await ipcHarness.invokeFrom(
      mainWin.webContents,
      BUFFER_IPC_CHANNELS.openWorkspaceFile,
      join(workspaceDir, 'note-b.md')
    )) as DocumentBuffer
    const configBuf = (await ipcHarness.invokeFrom(
      mainWin.webContents,
      BUFFER_IPC_CHANNELS.openConfigDocument
    )) as DocumentBuffer

    await ipcHarness.invokeFrom(mainWin.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [
      bufA.key,
      bufB.key,
      configBuf.key
    ])

    await ipcHarness.invokeFrom(mainWin.webContents, WINDOW_IPC_CHANNELS.detachTabToNewWindow, {
      bufferKey: bufB.key,
      mode: 'raw',
      cursor: { selectionStart: 0, selectionEnd: 0 },
      scrollTop: 0
    })
    await ipcHarness.invokeFrom(mainWin.webContents, WINDOW_IPC_CHANNELS.detachTabToNewWindow, {
      bufferKey: configBuf.key,
      mode: 'raw',
      cursor: { selectionStart: 0, selectionEnd: 0 },
      scrollTop: 0
    })
    const aux1 = createdWindows[1]
    const aux2 = createdWindows[2]

    await ipcHarness.invokeFrom(mainWin.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [bufA.key])
    await ipcHarness.invokeFrom(aux1.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [bufB.key])
    await ipcHarness.invokeFrom(aux2.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [configBuf.key])

    // Dirty only in aux2 (config.json) -> Main X prompts ONLY in Main, never in Aux windows
    await ipcHarness.invokeFrom(
      aux2.webContents,
      BUFFER_IPC_CHANNELS.updateContent,
      configBuf.key,
      '{"autoSave":false,"theme":"dark"}'
    )
    mainWin.sentMessages.length = 0
    aux1.sentMessages.length = 0
    aux2.sentMessages.length = 0

    mainWin.simulateUserClose()
    expect(mainWin.isDestroyed()).toBe(false)
    expect(aux1.isDestroyed()).toBe(false)
    expect(aux2.isDestroyed()).toBe(false)
    expect(
      mainWin.sentMessages.filter((msg) => msg.channel === WINDOW_IPC_CHANNELS.closeRequested)
    ).toHaveLength(1)
    expect(
      aux1.sentMessages.some((msg) => msg.channel === WINDOW_IPC_CHANNELS.closeRequested)
    ).toBe(false)
    expect(
      aux2.sentMessages.some((msg) => msg.channel === WINDOW_IPC_CHANNELS.closeRequested)
    ).toBe(false)

    // Cancel keeps every window alive
    await ipcHarness.invokeFrom(mainWin.webContents, WINDOW_IPC_CHANNELS.resolveCloseRequest, false)
    expect(mainWin.isDestroyed()).toBe(false)
    expect(aux1.isDestroyed()).toBe(false)
    expect(aux2.isDestroyed()).toBe(false)

    // Approve closes all auxiliary windows immediately WITHOUT aux prompts, then closes main
    mainWin.simulateUserClose()
    await ipcHarness.invokeFrom(mainWin.webContents, WINDOW_IPC_CHANNELS.resolveCloseRequest, true)
    expect(aux1.isDestroyed()).toBe(true)
    expect(aux2.isDestroyed()).toBe(true)
    expect(mainWin.isDestroyed()).toBe(true)
    expect(
      aux1.sentMessages.some((msg) => msg.channel === WINDOW_IPC_CHANNELS.closeRequested)
    ).toBe(false)
    expect(
      aux2.sentMessages.some((msg) => msg.channel === WINDOW_IPC_CHANNELS.closeRequested)
    ).toBe(false)
  })

  it('closes all auxiliary windows together immediately when main window closes in clean state', async () => {
    await writeFile(join(workspaceDir, 'clean.md'), '# Clean', 'utf-8')
    const mainWin = windowManager.createMainWindow() as FakeWindowInstance
    await ipcHarness.invokeFrom(mainWin.webContents, WORKSPACE_IPC_CHANNELS.open, workspaceDir)
    const cleanBuf = (await ipcHarness.invokeFrom(
      mainWin.webContents,
      BUFFER_IPC_CHANNELS.openWorkspaceFile,
      join(workspaceDir, 'clean.md')
    )) as DocumentBuffer
    await ipcHarness.invokeFrom(mainWin.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [
      cleanBuf.key
    ])
    await ipcHarness.invokeFrom(mainWin.webContents, WINDOW_IPC_CHANNELS.detachTabToNewWindow, {
      bufferKey: cleanBuf.key,
      mode: 'raw',
      cursor: { selectionStart: 0, selectionEnd: 0 },
      scrollTop: 0
    })
    const auxWin = createdWindows[1]
    await ipcHarness.invokeFrom(auxWin.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [
      cleanBuf.key
    ])

    mainWin.simulateUserClose()
    expect(auxWin.isDestroyed()).toBe(true)
    expect(mainWin.isDestroyed()).toBe(true)
    expect(
      mainWin.sentMessages.some((msg) => msg.channel === WINDOW_IPC_CHANNELS.closeRequested)
    ).toBe(false)
  })
})
