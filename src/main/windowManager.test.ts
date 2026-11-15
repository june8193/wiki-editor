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
  type DetachTabToNewWindowResult,
  type TabTransferPayload,
  type WindowInitContext
} from '@shared/window'
import { ConfigService } from './config/ConfigService'
import { createFakeIpcMain, type FakeIpcMain } from './ipc/ipcTestHelpers'
import { createSharedDocumentBufferHub, registerBufferIpc, type BufferWebContentsLike } from './ipc/registerBufferIpc'
import { registerWindowIpc } from './ipc/registerWindowIpc'
import { registerWorkspaceIpc } from './ipc/registerWorkspaceIpc'
import type { ScreenLike, WindowBounds } from './window'
import { WindowManager, type BrowserWindowLike } from './windowManager'
import { WorkspaceFsService } from './workspace/WorkspaceFsService'

interface FakeWindowInstance extends BrowserWindowLike {
  options: BrowserWindowConstructorOptions
  loadedUrls: string[]
  loadedFiles: Array<{ filePath: string; query?: Record<string, string> }>
  removedMenu: boolean
  shown: boolean
  closedCount: number
  sentMessages: Array<{ channel: string; payload: unknown }>
  emitReadyToShow: () => void
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
      closed: [] as Array<() => void>
    }
    const webContentsDestroyedListeners: Array<() => void> = []
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
        destroyWindow()
      },
      isDestroyed: () => destroyed,
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
      simulateUserClose: () => {
        destroyWindow()
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
})
