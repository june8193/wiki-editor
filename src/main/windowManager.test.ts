import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindowConstructorOptions } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocumentBuffer, SharedBufferStateSnapshot } from '@shared/documentBuffer'
import {
  BUFFER_IPC_CHANNELS,
  CONFIG_IPC_CHANNELS,
  FRONTMATTER_IPC_CHANNELS,
  GIT_IPC_CHANNELS,
  MENU_IPC_CHANNELS,
  WINDOW_IPC_CHANNELS,
  WORKSPACE_IPC_CHANNELS,
  WORKSPACE_STATE_IPC_CHANNELS,
  type FocusOpenWorkspaceResult,
  type OpenWorkspaceInNewWindowResult
} from '@shared/ipc'
import type {
  FrontmatterSchemaLoadResult,
  WorkspaceFrontmatterFieldValuesResponse,
  WorkspaceFrontmatterSchema
} from '@shared/frontmatter'
import type { WorkspaceInfo } from '@shared/workspace'
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
import { GitService } from './git/GitService'
import { createFakeIpcMain, type FakeIpcMain } from './ipc/ipcTestHelpers'
import { registerBufferIpc, type BufferWebContentsLike } from './ipc/registerBufferIpc'
import { registerConfigIpc } from './ipc/registerConfigIpc'
import { registerFrontmatterIpc } from './ipc/registerFrontmatterIpc'
import { registerGitIpc } from './ipc/registerGitIpc'
import { registerWindowIpc } from './ipc/registerWindowIpc'
import { registerWorkspaceIpc } from './ipc/registerWorkspaceIpc'
import { registerWorkspaceStateIpc } from './ipc/registerWorkspaceStateIpc'
import { createApplicationMenuTemplate } from './menu'
import { WindowManager, type BrowserWindowLike } from './windowManager'
import { WorkspaceStateService } from './workspace/WorkspaceStateService'
import { TabDragCoordinator } from '@shared/tabDragSession'
import { DEFAULT_SEARCH_MATCH_OPTIONS, type WorkspaceSearchResponse } from '@shared/search'

interface FakeWindowInstance extends BrowserWindowLike {
  options: BrowserWindowConstructorOptions
  loadedUrls: string[]
  loadedFiles: Array<{ filePath: string; query?: Record<string, string> }>
  removedMenu: boolean
  shown: boolean
  closedCount: number
  restoreCount: number
  focusCount: number
  sentMessages: Array<{ channel: string; payload: unknown }>
  emitReadyToShow: () => void
  emitFocus: () => void
  setMinimized: (minimized: boolean) => void
  setFocused: (focused: boolean) => void
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
    let minimized = false
    let focused = false
    let restoreCount = 0
    let focusCount = 0
    const windowListeners = {
      'ready-to-show': [] as Array<() => void>,
      closed: [] as Array<() => void>,
      close: new Set<(event: { preventDefault: () => void }) => void>(),
      focus: new Set<() => void>()
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
      get restoreCount() {
        return restoreCount
      },
      get focusCount() {
        return focusCount
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
      isMinimized: () => minimized,
      isFocused: () => focused,
      restore: () => {
        restoreCount += 1
        minimized = false
      },
      focus: () => {
        focusCount += 1
        focused = true
        for (const listener of [...windowListeners.focus]) {
          listener()
        }
      },
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
      on: (
        eventName: 'close' | 'focus',
        listener: ((event: { preventDefault: () => void }) => void) | (() => void)
      ) => {
        if (eventName === 'close') {
          windowListeners.close.add(listener as (event: { preventDefault: () => void }) => void)
        } else if (eventName === 'focus') {
          windowListeners.focus.add(listener as () => void)
        }
      },
      removeListener: (
        eventName: 'close' | 'focus',
        listener: ((event: { preventDefault: () => void }) => void) | (() => void)
      ) => {
        if (eventName === 'close') {
          windowListeners.close.delete(listener as (event: { preventDefault: () => void }) => void)
        } else if (eventName === 'focus') {
          windowListeners.focus.delete(listener as () => void)
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
      emitFocus: () => {
        focused = true
        for (const listener of [...windowListeners.focus]) {
          listener()
        }
      },
      setMinimized: (next: boolean) => {
        minimized = next
      },
      setFocused: (next: boolean) => {
        focused = next
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
  let configService: ConfigService
  let windowManager: WindowManager
  let ipcHarness: FakeIpcMain
  let createdWindows: FakeWindowInstance[]
  let disposeFns: Array<() => void>
  let fakeScreen: ScreenLike

  beforeEach(async () => {
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'wiki-editor-winmgr-')))
    workspaceDir = join(tempDir, 'docs')
    configPath = join(tempDir, 'config.json')
    await mkdir(workspaceDir, { recursive: true })
    await writeFile(join(workspaceDir, 'alpha.md'), '# Alpha\nInitial body', 'utf8')
    await writeFile(join(workspaceDir, 'beta.md'), '# Beta\nSecond doc', 'utf8')

    configService = new ConfigService(configPath)
    await configService.update({ autoSave: false, autoSaveDelayMs: 1000 })
    ipcHarness = createFakeIpcMain()

    const factory = createFakeBrowserWindowFactory()
    createdWindows = factory.createdWindows
    fakeScreen = {
      getDisplayNearestPoint: () => ({
        workArea: { x: 0, y: 0, width: 1400, height: 900 }
      })
    }

    windowManager = new WindowManager({
      preloadPath: 'C:\\app\\out\\preload\\index.js',
      rendererFilePath: 'C:\\app\\out\\renderer\\index.html',
      configService,
      watchDebounceMs: 30,
      initialAutoSaveConfig: { autoSave: false, autoSaveDelayMs: 1000 },
      createWindow: factory.createWindow,
      screen: fakeScreen
    })

    disposeFns = [
      registerBufferIpc({
        ipcMain: ipcHarness,
        configService,
        sessionSource: windowManager
      }),
      registerWorkspaceIpc({
        ipcMain: ipcHarness,
        configService,
        selectDirectory: async () => workspaceDir,
        coordinator: windowManager
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
    await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
  })

  it('creates main window without native menu and detaches tab into clamped offset auxiliary window without menu', async () => {
    const mainWin = windowManager.createMainWindow() as FakeWindowInstance
    expect(mainWin.removedMenu).toBe(true)
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
    const mainSessionHub = windowManager.resolveSession(mainWin.webContents)!.hub
    expect(mainSessionHub.getSnapshot().buffers[buffer.key]?.content).toBe('# Alpha\nUnsaved detached edit')
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
      configService,
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

  it('forwards windowIconPath to both main and auxiliary BrowserWindow options', () => {
    const iconFactory = createFakeBrowserWindowFactory()
    const iconPath = 'C:\\app\\build\\icon.png'
    const iconWinMgr = new WindowManager({
      preloadPath: 'C:\\app\\out\\preload\\index.js',
      rendererFilePath: 'C:\\app\\out\\renderer\\index.html',
      windowIconPath: iconPath,
      configService,
      createWindow: iconFactory.createWindow
    })

    const mainWin = iconWinMgr.createMainWindow() as FakeWindowInstance
    const auxWin = iconWinMgr.createAuxiliaryWindow([
      {
        bufferKey: 'c:/wiki/alpha.md',
        mode: 'raw',
        cursor: { selectionStart: 0, selectionEnd: 0 },
        scrollTop: 0
      }
    ]) as FakeWindowInstance

    expect(mainWin.options.icon).toBe(iconPath)
    expect(auxWin.options.icon).toBe(iconPath)
    iconWinMgr.dispose()
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
    await new Promise((resolve) => setTimeout(resolve, 100))
    await writeFile(join(workspaceDir, 'external-update.md'), '# Ext', 'utf8')

    await vi.waitFor(
      () => {
        expect(mainWin.sentMessages.some((msg) => msg.channel === WORKSPACE_IPC_CHANNELS.changed)).toBe(true)
        expect(auxWin.sentMessages.some((msg) => msg.channel === WORKSPACE_IPC_CHANNELS.changed)).toBe(true)
      },
      { timeout: 3000 }
    )

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
    const mainSessionHub = windowManager.resolveSession(mainWin.webContents)!.hub
    expect(mainSessionHub.hasBuffer(alphaBuf.key)).toBe(true)

    // Aux closes before sending any buffer:* IPC
    auxWin.simulateUserClose()
    expect(mainSessionHub.hasBuffer(alphaBuf.key)).toBe(false)
  })

  function setupScopedDragHarness(
    screen: ScreenLike,
    mainBounds = { x: 100, y: 120, width: 1280, height: 820 }
  ) {
    const factory = createFakeBrowserWindowFactory(mainBounds)
    const manager = new WindowManager({
      preloadPath: 'C:\\app\\out\\preload\\index.js',
      rendererFilePath: 'C:\\app\\out\\renderer\\index.html',
      configService,
      initialAutoSaveConfig: { autoSave: false, autoSaveDelayMs: 1000 },
      createWindow: factory.createWindow,
      screen
    })
    const scopedIpc = createFakeIpcMain()
    const disposers = [
      registerBufferIpc({
        ipcMain: scopedIpc,
        configService,
        sessionSource: manager
      }),
      registerWorkspaceIpc({
        ipcMain: scopedIpc,
        configService,
        selectDirectory: async () => workspaceDir,
        coordinator: manager
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
      const scopedHub = manager.resolveSession(mainWin.webContents)!.hub
      expect(scopedHub.hasBuffer(betaBuf.key)).toBe(true)
      expect(scopedHub.getBuffer(betaBuf.key)?.content).toBe('# Beta unsaved edit')

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
      encoding: 'utf-8',
      savedEncoding: 'utf-8',
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

  it('waits for close flush handshake on clean main window close when close-flush is enabled', async () => {
    await writeFile(join(workspaceDir, 'clean.md'), '# Clean', 'utf-8')
    const mainWin = windowManager.createMainWindow() as FakeWindowInstance
    await ipcHarness.invokeFrom(mainWin.webContents, WORKSPACE_IPC_CHANNELS.open, workspaceDir)
    await ipcHarness.invokeFrom(
      mainWin.webContents,
      WINDOW_IPC_CHANNELS.setCloseFlushEnabled,
      true
    )

    mainWin.sentMessages.length = 0
    mainWin.simulateUserClose()

    expect(mainWin.isDestroyed()).toBe(false)
    expect(
      mainWin.sentMessages.filter((msg) => msg.channel === WINDOW_IPC_CHANNELS.closeRequested)
    ).toHaveLength(1)

    await ipcHarness.invokeFrom(mainWin.webContents, WINDOW_IPC_CHANNELS.resolveCloseRequest, true)
    expect(mainWin.isDestroyed()).toBe(true)
  })
})

describe('Multi-Main-Window Workspace Session Coordinator', () => {
  let tempDir: string
  let wsAlpha: string
  let wsBeta: string
  let wsGamma: string
  let configPath: string
  let statePath: string
  let configService: ConfigService
  let workspaceStateService: WorkspaceStateService
  let gitService: GitService
  let factory: ReturnType<typeof createFakeBrowserWindowFactory>
  let manager: WindowManager
  let ipc: FakeIpcMain
  let disposeFns: Array<() => void>

  beforeEach(async () => {
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'wiki-editor-multi-main-')))
    wsAlpha = join(tempDir, 'alpha')
    wsBeta = join(tempDir, 'beta')
    wsGamma = join(tempDir, 'gamma')
    configPath = join(tempDir, 'config.json')
    statePath = join(tempDir, 'workspace-state.json')
    await mkdir(wsAlpha, { recursive: true })
    await mkdir(wsBeta, { recursive: true })
    await mkdir(wsGamma, { recursive: true })
    await writeFile(join(wsAlpha, 'a.md'), '# Alpha', 'utf8')
    await writeFile(join(wsBeta, 'b.md'), '# Beta', 'utf8')
    await writeFile(join(wsGamma, 'c.md'), '# Gamma', 'utf8')

    configService = new ConfigService(configPath)
    await configService.get()
    workspaceStateService = new WorkspaceStateService(statePath)
    gitService = new GitService()
    factory = createFakeBrowserWindowFactory({ x: 100, y: 100, width: 1280, height: 820 })
    ipc = createFakeIpcMain()

    manager = new WindowManager({
      preloadPath: 'C:\\app\\out\\preload\\index.js',
      rendererFilePath: 'C:\\app\\out\\renderer\\index.html',
      configService,
      watchDebounceMs: 50,
      initialAutoSaveConfig: { autoSave: false, autoSaveDelayMs: 1000 },
      createWindow: factory.createWindow,
      screen: {
        getDisplayNearestPoint: () => ({
          workArea: { x: 0, y: 0, width: 1920, height: 1080 }
        })
      }
    })

    disposeFns = [
      registerConfigIpc(ipc, configService, () => manager.getWebContentsTargets()),
      registerBufferIpc({
        ipcMain: ipc,
        configService,
        sessionSource: manager
      }),
      registerFrontmatterIpc({
        ipcMain: ipc,
        sessionSource: manager
      }),
      registerWorkspaceIpc({
        ipcMain: ipc,
        configService,
        coordinator: manager,
        selectDirectory: async () => wsAlpha
      }),
      registerWorkspaceStateIpc({
        ipcMain: ipc,
        workspaceStateService,
        isMainWindowSender: (sender) => manager.isMainWebContents(sender)
      }),
      registerGitIpc({
        ipcMain: ipc,
        gitService,
        resolveWorkspaceService: (sender) => manager.getWorkspaceServiceForSender(sender)
      }),
      registerWindowIpc({
        ipcMain: ipc,
        windowManager: manager
      })
    ]
  })

  afterEach(async () => {
    for (const dispose of disposeFns.reverse()) {
      dispose()
    }
    manager.dispose()
    await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
  })

  it('validates target directory before creating a new main window, positions offset (+40,+40) clamped to workArea, and injects initialWorkspacePath', async () => {
    const main1 = manager.createMainWindow() as FakeWindowInstance
    await ipc.invokeFrom(main1.webContents, WORKSPACE_IPC_CHANNELS.open, wsAlpha)

    const main1InitCtx = await ipc.invokeFrom<WindowInitContext>(
      main1.webContents,
      WINDOW_IPC_CHANNELS.getInitContext
    )
    expect(main1InitCtx).toEqual({ role: 'main', initialTabs: [] })

    // Invalid paths must reject BEFORE creating a new BrowserWindow
    const filePath = join(wsAlpha, 'a.md')
    const missingPath = join(tempDir, 'missing-workspace')
    for (const invalidPath of ['', '   ', missingPath, filePath]) {
      await expect(
        ipc.invokeFrom(main1.webContents, WORKSPACE_IPC_CHANNELS.openInNewWindow, invalidPath)
      ).rejects.toThrow()
    }
    expect(factory.createdWindows).toHaveLength(1)

    // Valid unopened path creates a new main window with offset (+40, +40), 1280x820, min 900x600, and initialWorkspacePath
    const openNewRes = await ipc.invokeFrom<OpenWorkspaceInNewWindowResult>(
      main1.webContents,
      WORKSPACE_IPC_CHANNELS.openInNewWindow,
      wsBeta
    )
    const realBeta = await realpath(wsBeta)
    expect(factory.createdWindows).toHaveLength(2)

    const main2 = factory.createdWindows[1]
    expect(openNewRes).toEqual({
      status: 'opened',
      windowId: main2.webContents.id,
      rootPath: realBeta
    })
    expect(main2.removedMenu).toBe(true)
    expect(main2.options).toMatchObject({
      width: 1280,
      height: 820,
      minWidth: 900,
      minHeight: 600,
      x: 140,
      y: 140,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    expect(main2.getBounds()).toEqual({ x: 140, y: 140, width: 1280, height: 820 })

    // Repeatable init context reads return initialWorkspacePath
    expect(
      await ipc.invokeFrom<WindowInitContext>(main2.webContents, WINDOW_IPC_CHANNELS.getInitContext)
    ).toEqual({
      role: 'main',
      initialTabs: [],
      initialWorkspacePath: realBeta
    })
    expect(
      await ipc.invokeFrom<WindowInitContext>(main2.webContents, WINDOW_IPC_CHANNELS.getInitContext)
    ).toEqual({
      role: 'main',
      initialTabs: [],
      initialWorkspacePath: realBeta
    })

    // Clamping near workArea edge: source near bottom-right clamps inside 1920x1080
    const edgeFactory = createFakeBrowserWindowFactory({ x: 620, y: 240, width: 1280, height: 820 })
    const edgeManager = new WindowManager({
      preloadPath: 'C:\\app\\out\\preload\\index.js',
      rendererFilePath: 'C:\\app\\out\\renderer\\index.html',
      configService,
      createWindow: edgeFactory.createWindow,
      screen: {
        getDisplayNearestPoint: () => ({
          workArea: { x: 0, y: 0, width: 1920, height: 1080 }
        })
      }
    })
    try {
      const edgeSource = edgeManager.createMainWindow() as FakeWindowInstance
      await edgeManager.openWorkspaceInNewWindow(edgeSource.webContents, wsGamma)
      expect(edgeFactory.createdWindows[1].getBounds()).toEqual({
        x: 640,
        y: 260,
        width: 1280,
        height: 820
      })
    } finally {
      edgeManager.dispose()
    }
  })

  it('prevents duplicate main-window opening across openInNewWindow, focusIfOpen, and open (including symlinks and casing) and restores/focuses existing window', async () => {
    const main1 = manager.createMainWindow() as FakeWindowInstance
    await ipc.invokeFrom(main1.webContents, WORKSPACE_IPC_CHANNELS.open, wsAlpha)
    const realAlpha = await realpath(wsAlpha)

    const main2Res = await ipc.invokeFrom<OpenWorkspaceInNewWindowResult>(
      main1.webContents,
      WORKSPACE_IPC_CHANNELS.openInNewWindow,
      wsBeta
    )
    expect(main2Res.status).toBe('opened')
    const main2 = factory.createdWindows[1]
    const realBeta = await realpath(wsBeta)

    // Before main2 has finished calling workspace:open, openInNewWindow(wsBeta) must still focus main2 without creating a 3rd window
    main2.setMinimized(true)
    const duplicatePendingRes = await ipc.invokeFrom<OpenWorkspaceInNewWindowResult>(
      main1.webContents,
      WORKSPACE_IPC_CHANNELS.openInNewWindow,
      `${wsBeta}/`
    )
    expect(duplicatePendingRes).toEqual({
      status: 'focused-existing',
      windowId: main2.webContents.id,
      rootPath: realBeta
    })
    expect(factory.createdWindows).toHaveLength(2)
    expect(main2.restoreCount).toBe(1)
    expect(main2.focusCount).toBe(1)
    expect(main2.isMinimized?.()).toBe(false)

    // Now main2 opens Beta via workspace:open
    const openedBeta = await ipc.invokeFrom<{ rootPath: string }>(
      main2.webContents,
      WORKSPACE_IPC_CHANNELS.open,
      realBeta
    )
    expect(openedBeta.rootPath).toBe(realBeta)

    // Minimize main1 and test focusIfOpen + openInNewWindow + raw open from main2 targeting wsAlpha (including case/slash variant)
    main1.setMinimized(true)
    const alphaVariant =
      process.platform === 'win32' ? `${realAlpha.toUpperCase()}\\` : `${realAlpha}/`
    const dupNewWin = await ipc.invokeFrom<OpenWorkspaceInNewWindowResult>(
      main2.webContents,
      WORKSPACE_IPC_CHANNELS.openInNewWindow,
      alphaVariant
    )
    expect(dupNewWin).toEqual({
      status: 'focused-existing',
      windowId: main1.webContents.id,
      rootPath: realAlpha
    })
    expect(factory.createdWindows).toHaveLength(2)
    expect(main1.restoreCount).toBe(1)
    expect(main1.focusCount).toBe(1)

    // focusIfOpen returns focused: false for unopened workspace and restores+focuses for another open main window
    expect(
      await ipc.invokeFrom<FocusOpenWorkspaceResult>(
        main2.webContents,
        WORKSPACE_IPC_CHANNELS.focusIfOpen,
        wsGamma
      )
    ).toEqual({ focused: false })
    main1.setMinimized(true)
    expect(
      await ipc.invokeFrom<FocusOpenWorkspaceResult>(
        main2.webContents,
        WORKSPACE_IPC_CHANNELS.focusIfOpen,
        alphaVariant
      )
    ).toEqual({
      focused: true,
      windowId: main1.webContents.id,
      rootPath: realAlpha
    })
    expect(main1.restoreCount).toBe(2)
    expect(main1.focusCount).toBe(2)
    expect(main1.isMinimized?.()).toBe(false)

    // Raw workspace:open targeting Alpha from main2 ALSO focuses main1, preserves Beta on main2, and rejects duplicate open
    main1.setMinimized(true)
    await expect(
      ipc.invokeFrom(main2.webContents, WORKSPACE_IPC_CHANNELS.open, alphaVariant)
    ).rejects.toThrow(/이미 다른 창/)
    expect(main1.restoreCount).toBe(3)
    expect(main1.focusCount).toBe(3)
    expect(
      await ipc.invokeFrom<Array<{ name: string }>>(
        main2.webContents,
        WORKSPACE_IPC_CHANNELS.readDir
      )
    ).toEqual([expect.objectContaining({ name: 'b.md' })])

    // Symlink / junction pointing to Alpha also resolves to existing main1 across openInNewWindow and focusIfOpen
    const alphaLink = join(tempDir, 'alpha-link')
    let symlinkCreated = false
    try {
      await symlink(wsAlpha, alphaLink, process.platform === 'win32' ? 'junction' : 'dir')
      symlinkCreated = true
    } catch {
      symlinkCreated = false
    }
    if (symlinkCreated) {
      main1.setMinimized(true)
      const symlinkOpen = await ipc.invokeFrom<OpenWorkspaceInNewWindowResult>(
        main2.webContents,
        WORKSPACE_IPC_CHANNELS.openInNewWindow,
        alphaLink
      )
      expect(symlinkOpen).toEqual({
        status: 'focused-existing',
        windowId: main1.webContents.id,
        rootPath: realAlpha
      })
      expect(main1.restoreCount).toBe(4)
      expect(main1.focusCount).toBe(4)
      expect(factory.createdWindows).toHaveLength(2)

      main1.setMinimized(true)
      const symlinkFocus = await ipc.invokeFrom<FocusOpenWorkspaceResult>(
        main2.webContents,
        WORKSPACE_IPC_CHANNELS.focusIfOpen,
        alphaLink
      )
      expect(symlinkFocus).toEqual({
        focused: true,
        windowId: main1.webContents.id,
        rootPath: realAlpha
      })
      expect(main1.restoreCount).toBe(5)
      expect(main1.focusCount).toBe(5)
    }
  })

  it('isolates workspace watch, buffer hub, git IPC, workspace-state guard, and broadcasts config changes with clean config buffer sync across sessions', async () => {
    const main1 = manager.createMainWindow() as FakeWindowInstance
    await ipc.invokeFrom(main1.webContents, WORKSPACE_IPC_CHANNELS.open, wsAlpha)
    await ipc.invokeFrom(main1.webContents, WORKSPACE_IPC_CHANNELS.watch)

    await ipc.invokeFrom(main1.webContents, WORKSPACE_IPC_CHANNELS.openInNewWindow, wsBeta)
    const main2 = factory.createdWindows[1]
    await ipc.invokeFrom(main2.webContents, WORKSPACE_IPC_CHANNELS.open, wsBeta)
    await ipc.invokeFrom(main2.webContents, WORKSPACE_IPC_CHANNELS.watch)
    await new Promise((resolve) => setTimeout(resolve, 100))

    // Each session has its own workspace root & watch broadcasts
    await writeFile(join(wsAlpha, 'alpha-new.md'), '# Alpha New', 'utf8')
    await vi.waitFor(
      () => {
        expect(main1.sentMessages.some((m) => m.channel === WORKSPACE_IPC_CHANNELS.changed)).toBe(true)
      },
      { timeout: 3000 }
    )
    expect(main2.sentMessages.some((m) => m.channel === WORKSPACE_IPC_CHANNELS.changed)).toBe(false)

    main1.sentMessages.length = 0
    main2.sentMessages.length = 0

    // Unwatching session 1 does NOT stop session 2's watcher
    await ipc.invokeFrom(main1.webContents, WORKSPACE_IPC_CHANNELS.unwatch)
    await writeFile(join(wsBeta, 'beta-new.md'), '# Beta New', 'utf8')
    await vi.waitFor(
      () => {
        expect(main2.sentMessages.some((m) => m.channel === WORKSPACE_IPC_CHANNELS.changed)).toBe(true)
      },
      { timeout: 3000 }
    )
    expect(main1.sentMessages.some((m) => m.channel === WORKSPACE_IPC_CHANNELS.changed)).toBe(false)

    // Buffer isolation: opening/editing a.md in Session 1 does NOT leak into Session 2
    const bufA = (await ipc.invokeFrom(
      main1.webContents,
      BUFFER_IPC_CHANNELS.openWorkspaceFile,
      join(wsAlpha, 'a.md'),
      'a.md'
    )) as DocumentBuffer
    await ipc.invokeFrom(main1.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [bufA.key])
    await ipc.invokeFrom(main1.webContents, BUFFER_IPC_CHANNELS.updateContent, bufA.key, '# Dirty A')

    const bufB = (await ipc.invokeFrom(
      main2.webContents,
      BUFFER_IPC_CHANNELS.openWorkspaceFile,
      join(wsBeta, 'b.md'),
      'b.md'
    )) as DocumentBuffer
    await ipc.invokeFrom(main2.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [bufB.key])

    const snap1 = await ipc.invokeFrom<SharedBufferStateSnapshot>(
      main1.webContents,
      BUFFER_IPC_CHANNELS.getSnapshot
    )
    const snap2 = await ipc.invokeFrom<SharedBufferStateSnapshot>(
      main2.webContents,
      BUFFER_IPC_CHANNELS.getSnapshot
    )
    expect(Object.keys(snap1.buffers)).toEqual([bufA.key])
    expect(Object.keys(snap2.buffers)).toEqual([bufB.key])

    // Detach tab from main1 -> auxiliary belongs ONLY to Session 1 and receives Session 1 buffer & watch events
    await ipc.invokeFrom(main1.webContents, WINDOW_IPC_CHANNELS.detachTabToNewWindow, {
      bufferKey: bufA.key,
      mode: 'raw',
      cursor: { selectionStart: 0, selectionEnd: 0 },
      scrollTop: 0
    })
    const aux1 = factory.createdWindows[2]
    await ipc.invokeFrom(aux1.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [bufA.key])

    main2.sentMessages.length = 0
    aux1.sentMessages.length = 0
    await ipc.invokeFrom(aux1.webContents, BUFFER_IPC_CHANNELS.updateContent, bufA.key, '# Edited in Aux1')
    expect(aux1.sentMessages.some((m) => m.channel === BUFFER_IPC_CHANNELS.event)).toBe(true)
    expect(main2.sentMessages.some((m) => m.channel === BUFFER_IPC_CHANNELS.event)).toBe(false)

    // clearWorkspaceBuffers in Session 1 closes workspace buffers in Session 1 while keeping Session 2 buffers intact
    await ipc.invokeFrom(main1.webContents, BUFFER_IPC_CHANNELS.clearWorkspaceBuffers)
    expect(aux1.isDestroyed()).toBe(true)
    const snap2AfterClear1 = await ipc.invokeFrom<SharedBufferStateSnapshot>(
      main2.webContents,
      BUFFER_IPC_CHANNELS.getSnapshot
    )
    expect(snap2AfterClear1.buffers[bufB.key]).toBeDefined()

    // Git IPC routes per session and rejects cross-session workspace paths
    await ipc.invokeFrom(main1.webContents, GIT_IPC_CHANNELS.init, wsAlpha)
    const gitStatus1 = await ipc.invokeFrom<{ isRepo: boolean }>(
      main1.webContents,
      GIT_IPC_CHANNELS.status,
      wsAlpha
    )
    const gitStatus2 = await ipc.invokeFrom<{ isRepo: boolean }>(
      main2.webContents,
      GIT_IPC_CHANNELS.status,
      wsBeta
    )
    expect(gitStatus1.isRepo).toBe(true)
    expect(gitStatus2.isRepo).toBe(false)
    await expect(
      ipc.invokeFrom(main1.webContents, GIT_IPC_CHANNELS.status, wsBeta)
    ).rejects.toThrow(/일치하지 않습니다/)

    // WorkspaceState IPC succeeds from both main1 and main2, while auxiliary windows are rejected
    await ipc.invokeFrom(main1.webContents, WORKSPACE_STATE_IPC_CHANNELS.save, wsAlpha, {
      expandedDirs: [join(wsAlpha, 'sub')]
    })
    await ipc.invokeFrom(main2.webContents, WORKSPACE_STATE_IPC_CHANNELS.save, wsBeta, {
      expandedDirs: [join(wsBeta, 'docs')]
    })
    expect(
      await ipc.invokeFrom(main2.webContents, WORKSPACE_STATE_IPC_CHANNELS.get, wsBeta)
    ).toMatchObject({ expandedDirs: [join(wsBeta, 'docs')] })

    // Global config change broadcasts to ALL live windows (main1, main2, aux2) and refreshes clean config.json buffers
    const cfgBuf1 = (await ipc.invokeFrom(
      main1.webContents,
      BUFFER_IPC_CHANNELS.openConfigDocument
    )) as DocumentBuffer
    const cfgBuf2 = (await ipc.invokeFrom(
      main2.webContents,
      BUFFER_IPC_CHANNELS.openConfigDocument
    )) as DocumentBuffer
    await ipc.invokeFrom(main1.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [cfgBuf1.key])
    await ipc.invokeFrom(main2.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [bufB.key, cfgBuf2.key])

    await ipc.invokeFrom(main2.webContents, WINDOW_IPC_CHANNELS.detachTabToNewWindow, {
      bufferKey: bufB.key,
      mode: 'raw',
      cursor: { selectionStart: 0, selectionEnd: 0 },
      scrollTop: 0
    })
    const aux2 = factory.createdWindows[3]
    await ipc.invokeFrom(aux2.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [bufB.key])
    await expect(
      ipc.invokeFrom(aux2.webContents, WORKSPACE_STATE_IPC_CHANNELS.get, wsBeta)
    ).rejects.toThrow(/main window/i)

    main1.sentMessages.length = 0
    main2.sentMessages.length = 0
    aux2.sentMessages.length = 0
    await ipc.invokeFrom(main1.webContents, CONFIG_IPC_CHANNELS.update, { theme: 'dark' })

    expect(main1.sentMessages.some((m) => m.channel === CONFIG_IPC_CHANNELS.changed)).toBe(true)
    expect(main2.sentMessages.some((m) => m.channel === CONFIG_IPC_CHANNELS.changed)).toBe(true)
    expect(aux2.sentMessages.some((m) => m.channel === CONFIG_IPC_CHANNELS.changed)).toBe(true)

    const favoriteBroadcastCases = [
      {
        sender: main1.webContents,
        channel: CONFIG_IPC_CHANNELS.toggleFavoriteWorkspace,
        args: [wsAlpha, 'Alpha'],
        expectedCount: 1
      },
      {
        sender: main2.webContents,
        channel: CONFIG_IPC_CHANNELS.removeFavoriteWorkspace,
        args: [wsAlpha],
        expectedCount: 0
      }
    ]
    for (const testCase of favoriteBroadcastCases) {
      for (const targetWin of [main1, main2, aux2]) {
        targetWin.sentMessages.length = 0
      }
      await ipc.invokeFrom(testCase.sender, testCase.channel, ...testCase.args)
      for (const targetWin of [main1, main2, aux2]) {
        expect(
          targetWin.sentMessages.some(
            (m) =>
              m.channel === CONFIG_IPC_CHANNELS.changed &&
              (m.payload as { favoriteWorkspaces: Array<{ path: string }> }).favoriteWorkspaces
                .length === testCase.expectedCount
          )
        ).toBe(true)
      }
    }

    await vi.waitFor(async () => {
      const snapCfg2 = await ipc.invokeFrom<SharedBufferStateSnapshot>(
        main2.webContents,
        BUFFER_IPC_CHANNELS.getSnapshot
      )
      expect(JSON.parse(snapCfg2.buffers[cfgBuf2.key]!.content).theme).toBe('dark')
    })

    // Saving config.json document buffer in Session 1 updates clean config.json in Session 2 while preserving dirty edits if dirty
    const parsedCfg1 = JSON.parse(cfgBuf1.content)
    await ipc.invokeFrom(
      main1.webContents,
      BUFFER_IPC_CHANNELS.updateContent,
      cfgBuf1.key,
      JSON.stringify({ ...parsedCfg1, autoSave: true }, null, 2)
    )
    await ipc.invokeFrom(main1.webContents, BUFFER_IPC_CHANNELS.saveBuffer, cfgBuf1.key)
    await vi.waitFor(async () => {
      const snapCfg2 = await ipc.invokeFrom<SharedBufferStateSnapshot>(
        main2.webContents,
        BUFFER_IPC_CHANNELS.getSnapshot
      )
      expect(JSON.parse(snapCfg2.buffers[cfgBuf2.key]!.content).autoSave).toBe(true)
    })

    // Auxiliary windows cannot open or open-in-new-window workspaces directly
    await expect(
      ipc.invokeFrom(aux2.webContents, WORKSPACE_IPC_CHANNELS.openInNewWindow, wsGamma)
    ).rejects.toThrow(/main window/i)
    await expect(
      ipc.invokeFrom(aux2.webContents, WORKSPACE_IPC_CHANNELS.open, wsGamma)
    ).rejects.toThrow(/main window/i)
  })

  it('scopes drag-state-changed broadcasts to owning session and rejects cross-session acceptTabDragDrop while accepting same-session drops', async () => {
    const main1 = manager.createMainWindow() as FakeWindowInstance
    await ipc.invokeFrom(main1.webContents, WORKSPACE_IPC_CHANNELS.open, wsAlpha)
    await ipc.invokeFrom(main1.webContents, WORKSPACE_IPC_CHANNELS.openInNewWindow, wsBeta)
    const main2 = factory.createdWindows[1]
    await ipc.invokeFrom(main2.webContents, WORKSPACE_IPC_CHANNELS.open, wsBeta)

    const bufA = (await ipc.invokeFrom(
      main1.webContents,
      BUFFER_IPC_CHANNELS.openWorkspaceFile,
      join(wsAlpha, 'a.md'),
      'a.md'
    )) as DocumentBuffer
    await ipc.invokeFrom(main1.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [bufA.key])
    const payloadA: TabTransferPayload = {
      bufferKey: bufA.key,
      mode: 'raw',
      cursor: { selectionStart: 0, selectionEnd: 0 },
      scrollTop: 0
    }
    await ipc.invokeFrom(main1.webContents, WINDOW_IPC_CHANNELS.detachTabToNewWindow, payloadA)
    const aux1 = factory.createdWindows[2]
    await ipc.invokeFrom(aux1.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [bufA.key])

    const bufB = (await ipc.invokeFrom(
      main2.webContents,
      BUFFER_IPC_CHANNELS.openWorkspaceFile,
      join(wsBeta, 'b.md'),
      'b.md'
    )) as DocumentBuffer
    await ipc.invokeFrom(main2.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [bufB.key])
    await ipc.invokeFrom(main2.webContents, WINDOW_IPC_CHANNELS.detachTabToNewWindow, {
      bufferKey: bufB.key,
      mode: 'raw',
      cursor: { selectionStart: 0, selectionEnd: 0 },
      scrollTop: 0
    })
    const aux2 = factory.createdWindows[3]
    await ipc.invokeFrom(aux2.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [bufB.key])

    main1.sentMessages.length = 0
    aux1.sentMessages.length = 0
    main2.sentMessages.length = 0
    aux2.sentMessages.length = 0

    // Start drag in Session 1 (aux1) -> ONLY Session 1 windows (main1, aux1) receive drag-state-changed
    const drag1 = await ipc.invokeFrom<ActiveTabDragSession>(
      aux1.webContents,
      WINDOW_IPC_CHANNELS.startTabDrag,
      { paneId: 'primary', tabId: 'tab-a', payload: payloadA }
    )
    expect(main1.sentMessages.some((m) => m.channel === WINDOW_IPC_CHANNELS.dragStateChanged)).toBe(true)
    expect(aux1.sentMessages.some((m) => m.channel === WINDOW_IPC_CHANNELS.dragStateChanged)).toBe(true)
    expect(main2.sentMessages.some((m) => m.channel === WINDOW_IPC_CHANNELS.dragStateChanged)).toBe(false)
    expect(aux2.sentMessages.some((m) => m.channel === WINDOW_IPC_CHANNELS.dragStateChanged)).toBe(false)

    // Cross-session drop onto main2 or aux2 MUST be rejected without mutating Session 1 drag
    const rejectMain2 = await ipc.invokeFrom<AcceptTabDragDropResult>(
      main2.webContents,
      WINDOW_IPC_CHANNELS.acceptTabDragDrop,
      { dragSessionId: drag1.dragSessionId }
    )
    expect(rejectMain2).toEqual({ accepted: false, reason: 'different-workspace-session' })

    const rejectAux2NoId = await ipc.invokeFrom<AcceptTabDragDropResult>(
      aux2.webContents,
      WINDOW_IPC_CHANNELS.acceptTabDragDrop,
      {}
    )
    expect(rejectAux2NoId).toEqual({ accepted: false, reason: 'different-workspace-session' })

    // Dropping Session 1's tab over Session 2's window bounds does NOT spawn a new auxiliary window
    const crossBoundsEnd = await ipc.invokeFrom<TabDragEndResult>(
      aux1.webContents,
      WINDOW_IPC_CHANNELS.endTabDrag,
      {
        dragSessionId: drag1.dragSessionId,
        screenPoint: { x: main2.getBounds().x + 50, y: main2.getBounds().y + 50 }
      }
    )
    expect(crossBoundsEnd).toEqual({ detached: false, outcome: 'cancelled' })
    expect(factory.createdWindows).toHaveLength(4)

    // Re-start drag in Session 1 for same-session drop onto main1
    const drag1b = await ipc.invokeFrom<ActiveTabDragSession>(
      aux1.webContents,
      WINDOW_IPC_CHANNELS.startTabDrag,
      { paneId: 'primary', tabId: 'tab-a', payload: payloadA }
    )

    // Same-session drop onto main1 MUST still succeed
    const acceptMain1 = await ipc.invokeFrom<AcceptTabDragDropResult>(
      main1.webContents,
      WINDOW_IPC_CHANNELS.acceptTabDragDrop,
      { dragSessionId: drag1b.dragSessionId }
    )
    expect(acceptMain1).toMatchObject({
      accepted: true,
      dragSessionId: drag1b.dragSessionId,
      sourceWindowId: aux1.webContents.id,
      targetWindowId: main1.webContents.id
    })
  })

  it('closes only the target main window and its owned auxiliary windows after session-scoped unsaved/flush checks, leaving other sessions intact', async () => {
    await writeFile(join(wsAlpha, 'a2.md'), '# Alpha 2', 'utf8')
    await writeFile(join(wsBeta, 'b2.md'), '# Beta 2', 'utf8')

    const main1 = manager.createMainWindow() as FakeWindowInstance
    await ipc.invokeFrom(main1.webContents, WORKSPACE_IPC_CHANNELS.open, wsAlpha)
    await ipc.invokeFrom(main1.webContents, WORKSPACE_IPC_CHANNELS.watch)

    await ipc.invokeFrom(main1.webContents, WORKSPACE_IPC_CHANNELS.openInNewWindow, wsBeta)
    const main2 = factory.createdWindows[1]
    await ipc.invokeFrom(main2.webContents, WORKSPACE_IPC_CHANNELS.open, wsBeta)
    await ipc.invokeFrom(main2.webContents, WORKSPACE_IPC_CHANNELS.watch)

    const bufA1 = (await ipc.invokeFrom(
      main1.webContents,
      BUFFER_IPC_CHANNELS.openWorkspaceFile,
      join(wsAlpha, 'a.md'),
      'a.md'
    )) as DocumentBuffer
    const bufA2 = (await ipc.invokeFrom(
      main1.webContents,
      BUFFER_IPC_CHANNELS.openWorkspaceFile,
      join(wsAlpha, 'a2.md'),
      'a2.md'
    )) as DocumentBuffer
    await ipc.invokeFrom(main1.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [
      bufA1.key,
      bufA2.key
    ])
    await ipc.invokeFrom(main1.webContents, WINDOW_IPC_CHANNELS.detachTabToNewWindow, {
      bufferKey: bufA2.key,
      mode: 'raw',
      cursor: { selectionStart: 0, selectionEnd: 0 },
      scrollTop: 0
    })
    const aux1 = factory.createdWindows[2]
    await ipc.invokeFrom(aux1.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [bufA2.key])
    await ipc.invokeFrom(main1.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [bufA1.key])

    const bufB1 = (await ipc.invokeFrom(
      main2.webContents,
      BUFFER_IPC_CHANNELS.openWorkspaceFile,
      join(wsBeta, 'b.md'),
      'b.md'
    )) as DocumentBuffer
    const bufB2 = (await ipc.invokeFrom(
      main2.webContents,
      BUFFER_IPC_CHANNELS.openWorkspaceFile,
      join(wsBeta, 'b2.md'),
      'b2.md'
    )) as DocumentBuffer
    await ipc.invokeFrom(main2.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [
      bufB1.key,
      bufB2.key
    ])
    await ipc.invokeFrom(main2.webContents, WINDOW_IPC_CHANNELS.detachTabToNewWindow, {
      bufferKey: bufB2.key,
      mode: 'raw',
      cursor: { selectionStart: 0, selectionEnd: 0 },
      scrollTop: 0
    })
    const aux2 = factory.createdWindows[3]
    await ipc.invokeFrom(aux2.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [bufB2.key])
    await ipc.invokeFrom(main2.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [bufB1.key])

    // Make Session 2 (aux2) dirty while Session 1 is dirty in aux1 -> closing main1 prompts ONLY main1
    await ipc.invokeFrom(aux2.webContents, BUFFER_IPC_CHANNELS.updateContent, bufB2.key, '# Dirty B2')
    await ipc.invokeFrom(aux1.webContents, BUFFER_IPC_CHANNELS.updateContent, bufA2.key, '# Dirty A2')

    main1.sentMessages.length = 0
    aux1.sentMessages.length = 0
    main2.sentMessages.length = 0
    aux2.sentMessages.length = 0

    main1.simulateUserClose()
    expect(main1.isDestroyed()).toBe(false)
    expect(aux1.isDestroyed()).toBe(false)
    expect(main1.sentMessages.filter((m) => m.channel === WINDOW_IPC_CHANNELS.closeRequested)).toHaveLength(1)
    expect(aux1.sentMessages.some((m) => m.channel === WINDOW_IPC_CHANNELS.closeRequested)).toBe(false)
    expect(main2.sentMessages.some((m) => m.channel === WINDOW_IPC_CHANNELS.closeRequested)).toBe(false)
    expect(aux2.sentMessages.some((m) => m.channel === WINDOW_IPC_CHANNELS.closeRequested)).toBe(false)

    // Cancel main1 close -> all windows stay alive
    await ipc.invokeFrom(main1.webContents, WINDOW_IPC_CHANNELS.resolveCloseRequest, false)
    expect(main1.isDestroyed()).toBe(false)
    expect(aux1.isDestroyed()).toBe(false)

    // Save aux1 so Session 1 is clean, enable close-flush on main1, and confirm Session 2 dirty buffer does NOT block clean main1 flush/close
    await ipc.invokeFrom(aux1.webContents, BUFFER_IPC_CHANNELS.saveBuffer, bufA2.key)
    await ipc.invokeFrom(main1.webContents, WINDOW_IPC_CHANNELS.setCloseFlushEnabled, true)

    main1.sentMessages.length = 0
    main1.simulateUserClose()
    expect(main1.isDestroyed()).toBe(false)
    expect(main1.sentMessages.filter((m) => m.channel === WINDOW_IPC_CHANNELS.closeRequested)).toHaveLength(1)

    await ipc.invokeFrom(main1.webContents, WINDOW_IPC_CHANNELS.resolveCloseRequest, true)
    expect(aux1.isDestroyed()).toBe(true)
    expect(main1.isDestroyed()).toBe(true)

    // Session 2 (main2 + aux2) MUST remain completely intact and functional
    expect(main2.isDestroyed()).toBe(false)
    expect(aux2.isDestroyed()).toBe(false)
    const snap2 = await ipc.invokeFrom<SharedBufferStateSnapshot>(
      main2.webContents,
      BUFFER_IPC_CHANNELS.getSnapshot
    )
    expect(snap2.buffers[bufB2.key]?.content).toBe('# Dirty B2')

    // Since Session 1 closed, wsAlpha can now be opened again in a new window from main2
    const reopenAlpha = await ipc.invokeFrom<OpenWorkspaceInNewWindowResult>(
      main2.webContents,
      WORKSPACE_IPC_CHANNELS.openInNewWindow,
      wsAlpha
    )
    expect(reopenAlpha.status).toBe('opened')
    expect(factory.createdWindows).toHaveLength(5)

    // Clean close without closeFlushEnabled closes main3 and any aux immediately without prompting while main2 stays open
    const main3 = factory.createdWindows[4]
    main3.sentMessages.length = 0
    main3.simulateUserClose()
    expect(main3.isDestroyed()).toBe(true)
    expect(main3.sentMessages.some((m) => m.channel === WINDOW_IPC_CHANNELS.closeRequested)).toBe(false)
    expect(main2.isDestroyed()).toBe(false)
    expect(aux2.isDestroyed()).toBe(false)
  })

  it('routes application menu bar commands to target main window or auxiliary owning main window, and tracks workspace services for wiki-asset protocol', async () => {
    const main1 = manager.createMainWindow() as FakeWindowInstance
    await ipc.invokeFrom(main1.webContents, WORKSPACE_IPC_CHANNELS.open, wsAlpha)
    await ipc.invokeFrom(main1.webContents, WORKSPACE_IPC_CHANNELS.openInNewWindow, wsBeta)
    const main2 = factory.createdWindows[1]
    await ipc.invokeFrom(main2.webContents, WORKSPACE_IPC_CHANNELS.open, wsBeta)

    const bufA = (await ipc.invokeFrom(
      main1.webContents,
      BUFFER_IPC_CHANNELS.openWorkspaceFile,
      join(wsAlpha, 'a.md'),
      'a.md'
    )) as DocumentBuffer
    await ipc.invokeFrom(main1.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [bufA.key])
    await ipc.invokeFrom(main1.webContents, WINDOW_IPC_CHANNELS.detachTabToNewWindow, {
      bufferKey: bufA.key,
      mode: 'raw',
      cursor: { selectionStart: 0, selectionEnd: 0 },
      scrollTop: 0
    })
    const aux1 = factory.createdWindows[2]
    await ipc.invokeFrom(aux1.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [bufA.key])

    const menuTemplate = createApplicationMenuTemplate({
      getTargetWebContents: (targetWindow) => manager.getMenuTargetWebContents(targetWindow)
    })
    const fileSubmenu = menuTemplate.find((item) => item.label === 'File')?.submenu as Array<{
      click?: (item: unknown, win: unknown, event: unknown) => void
    }>
    const settingsSubmenu = menuTemplate.find((item) => item.label === 'Settings')?.submenu as Array<{
      click?: (item: unknown, win: unknown, event: unknown) => void
    }>

    main1.sentMessages.length = 0
    main2.sentMessages.length = 0
    aux1.sentMessages.length = 0

    // Menu command triggered with explicit targetWindow = aux1 routes to aux1's owning main1 (not aux1, not main2)
    fileSubmenu[0].click?.(undefined, aux1, undefined)
    expect(main1.sentMessages.filter((m) => m.channel === MENU_IPC_CHANNELS.command)).toEqual([
      { channel: MENU_IPC_CHANNELS.command, payload: 'open-folder' }
    ])
    expect(aux1.sentMessages.some((m) => m.channel === MENU_IPC_CHANNELS.command)).toBe(false)
    expect(main2.sentMessages.some((m) => m.channel === MENU_IPC_CHANNELS.command)).toBe(false)

    // Menu command triggered with explicit targetWindow = main2 routes to main2
    settingsSubmenu[0].click?.(undefined, main2, undefined)
    expect(main2.sentMessages.filter((m) => m.channel === MENU_IPC_CHANNELS.command)).toEqual([
      { channel: MENU_IPC_CHANNELS.command, payload: 'toggle-settings' }
    ])

    // Menu command with undefined targetWindow falls back to focused/last-active window's main window
    main1.emitFocus()
    settingsSubmenu[1].click?.(undefined, undefined, undefined)
    expect(main1.sentMessages.filter((m) => m.channel === MENU_IPC_CHANNELS.command)).toHaveLength(2)

    // getWorkspaceServices exposes all active sessions' workspace services and drops closed ones
    expect(manager.getWorkspaceServices()).toHaveLength(2)
    main1.simulateUserClose()
    expect(manager.getWorkspaceServices()).toHaveLength(1)
  })

  it('prevents duplicate open of both incoming and outgoing workspaces during concurrent switch, clears stale pendingInitialWorkspacePath on validation failure, and guards post-await disposal', async () => {
    const main1 = manager.createMainWindow() as FakeWindowInstance
    await ipc.invokeFrom(main1.webContents, WORKSPACE_IPC_CHANNELS.open, wsAlpha)
    await ipc.invokeFrom(main1.webContents, WORKSPACE_IPC_CHANNELS.openInNewWindow, wsGamma)
    const main2 = factory.createdWindows[1]
    await ipc.invokeFrom(main2.webContents, WORKSPACE_IPC_CHANNELS.open, wsGamma)

    // 1. Delay main1's workspaceService.openWorkspace to simulate in-flight A -> B switch
    const main1Service = manager.getWorkspaceServices()[0]
    const originalOpen = main1Service.openWorkspace.bind(main1Service)
    let releaseOpen!: () => void
    const openBarrier = new Promise<void>((resolve) => {
      releaseOpen = resolve
    })
    let openStarted!: () => void
    const openStartedPromise = new Promise<void>((resolve) => {
      openStarted = resolve
    })
    vi.spyOn(main1Service, 'openWorkspace').mockImplementationOnce(async (targetPath: string) => {
      openStarted()
      await openBarrier
      return originalOpen(targetPath)
    })

    const switchPromise = ipc.invokeFrom(
      main1.webContents,
      WORKSPACE_IPC_CHANNELS.open,
      wsBeta
    ) as Promise<WorkspaceInfo>
    await openStartedPromise

    // Both incoming wsBeta and outgoing wsAlpha should resolve to main1 while switch is in flight
    const dupBetaResult = (await ipc.invokeFrom(
      main2.webContents,
      WORKSPACE_IPC_CHANNELS.openInNewWindow,
      wsBeta
    )) as OpenWorkspaceInNewWindowResult
    expect(dupBetaResult).toMatchObject({
      status: 'focused-existing',
      windowId: main1.webContents.id
    })

    const dupAlphaResult = (await ipc.invokeFrom(
      main2.webContents,
      WORKSPACE_IPC_CHANNELS.openInNewWindow,
      wsAlpha
    )) as OpenWorkspaceInNewWindowResult
    expect(dupAlphaResult).toMatchObject({
      status: 'focused-existing',
      windowId: main1.webContents.id
    })
    expect(factory.createdWindows).toHaveLength(2)

    releaseOpen()
    const switchResult = await switchPromise
    expect(switchResult.name).toBe('beta')

    // 2. Deleted unmounted initialWorkspacePath clears stale reservation when open fails validation
    const wsDelta = join(tempDir, 'delta')
    await mkdir(wsDelta, { recursive: true })
    await writeFile(join(wsDelta, 'd.md'), '# Delta', 'utf8')
    const deltaWinRes = (await ipc.invokeFrom(
      main1.webContents,
      WORKSPACE_IPC_CHANNELS.openInNewWindow,
      wsDelta
    )) as OpenWorkspaceInNewWindowResult
    expect(deltaWinRes.status).toBe('opened')
    const main3 = factory.createdWindows[2]

    await rm(wsDelta, { recursive: true, force: true })
    await expect(
      ipc.invokeFrom(main3.webContents, WORKSPACE_IPC_CHANNELS.open, deltaWinRes.rootPath)
    ).rejects.toThrow()

    await mkdir(wsDelta, { recursive: true })
    const reopenDelta = (await ipc.invokeFrom(
      main1.webContents,
      WORKSPACE_IPC_CHANNELS.openInNewWindow,
      wsDelta
    )) as OpenWorkspaceInNewWindowResult
    expect(reopenDelta.status).toBe('opened')
    expect(factory.createdWindows).toHaveLength(4)

    // 2b. Overlapping workspace switches on the same main window preserve the newer pendingOpenWorkspacePath when the earlier open settles
    const wsZeta = join(tempDir, 'zeta')
    const wsEta = join(tempDir, 'eta')
    await mkdir(wsZeta, { recursive: true })
    await mkdir(wsEta, { recursive: true })
    await writeFile(join(wsZeta, 'z.md'), '# Zeta', 'utf8')
    await writeFile(join(wsEta, 'e.md'), '# Eta', 'utf8')

    let releaseZeta!: () => void
    const zetaBarrier = new Promise<void>((resolve) => {
      releaseZeta = resolve
    })
    let zetaStarted!: () => void
    const zetaStartedPromise = new Promise<void>((resolve) => {
      zetaStarted = resolve
    })
    let releaseEta!: () => void
    const etaBarrier = new Promise<void>((resolve) => {
      releaseEta = resolve
    })

    const openSpy = vi.spyOn(main1Service, 'openWorkspace').mockImplementation(async (targetPath: string) => {
      if (targetPath.endsWith('zeta')) {
        zetaStarted()
        await zetaBarrier
      } else if (targetPath.endsWith('eta')) {
        await etaBarrier
      }
      return originalOpen(targetPath)
    })

    const switchZetaPromise = ipc.invokeFrom(
      main1.webContents,
      WORKSPACE_IPC_CHANNELS.open,
      wsZeta
    ) as Promise<WorkspaceInfo>
    await zetaStartedPromise

    const switchEtaPromise = ipc.invokeFrom(
      main1.webContents,
      WORKSPACE_IPC_CHANNELS.open,
      wsEta
    ) as Promise<WorkspaceInfo>
    // Wait until open(wsEta) finishes directory validation and queues/registers wsEta
    await new Promise((resolve) => setTimeout(resolve, 15))

    // Earlier open settles while wsEta is still pending
    releaseZeta()
    expect((await switchZetaPromise).name).toBe('zeta')

    const dupEtaResult = (await ipc.invokeFrom(
      main2.webContents,
      WORKSPACE_IPC_CHANNELS.openInNewWindow,
      wsEta
    )) as OpenWorkspaceInNewWindowResult
    expect(dupEtaResult).toMatchObject({
      status: 'focused-existing',
      windowId: main1.webContents.id
    })
    expect(factory.createdWindows).toHaveLength(4)

    releaseEta()
    expect((await switchEtaPromise).name).toBe('eta')
    openSpy.mockRestore()

    // 3. Disposing WindowManager while openWorkspaceInNewWindow resolves does not spawn orphaned window, and clears sender lookup
    const wsEpsilon = join(tempDir, 'epsilon')
    await mkdir(wsEpsilon, { recursive: true })
    const windowsBeforeDispose = factory.createdWindows.length
    const pendingPostDispose = manager.openWorkspaceInNewWindow(main1.webContents, wsEpsilon)
    manager.dispose()
    await expect(pendingPostDispose).rejects.toThrow(/disposed/i)
    expect(factory.createdWindows).toHaveLength(windowsBeforeDispose)
    expect(manager.isMainWebContents(main1.webContents)).toBe(false)
    expect(manager.getWindowForSender(main1.webContents)).toBeUndefined()
    expect(manager.getWindowInitContext(main1.webContents)).toEqual({
      role: 'main',
      initialTabs: []
    })
  })

  it('isolates workspace:search IPC per main-window session, includes auxiliary dirty buffers, excludes config.json, and rejects unknown senders', async () => {
    const main1 = manager.createMainWindow() as FakeWindowInstance
    await ipc.invokeFrom(main1.webContents, WORKSPACE_IPC_CHANNELS.open, wsAlpha)
    await ipc.invokeFrom(main1.webContents, WORKSPACE_IPC_CHANNELS.openInNewWindow, wsBeta)
    const main2 = factory.createdWindows[1]
    await ipc.invokeFrom(main2.webContents, WORKSPACE_IPC_CHANNELS.open, wsBeta)

    const alphaDoc = join(wsAlpha, 'a.md')
    const betaDoc = join(wsBeta, 'b.md')
    await writeFile(alphaDoc, '# Alpha\nSHARED_DISK_TOKEN', 'utf8')
    await writeFile(betaDoc, '# Beta\nBETA_ONLY_TOKEN', 'utf8')

    // Open a.md in main1, detach to aux1, and make a dirty edit in aux1
    const bufA = (await ipc.invokeFrom(
      main1.webContents,
      BUFFER_IPC_CHANNELS.openWorkspaceFile,
      alphaDoc,
      'a.md'
    )) as DocumentBuffer
    await ipc.invokeFrom(main1.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [bufA.key])
    await ipc.invokeFrom(main1.webContents, WINDOW_IPC_CHANNELS.detachTabToNewWindow, {
      bufferKey: bufA.key,
      mode: 'raw',
      cursor: { selectionStart: 0, selectionEnd: 0 },
      scrollTop: 0
    })
    const aux1 = factory.createdWindows[2]
    await ipc.invokeFrom(aux1.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [bufA.key], {
      releasePending: true
    })
    await ipc.invokeFrom(
      aux1.webContents,
      BUFFER_IPC_CHANNELS.updateContent,
      bufA.key,
      '# Alpha\nAUX1_UNSAVED_TOKEN'
    )

    // Open dirty config.json in Session 1 -> must NOT appear in Session 1 or Session 2 search
    const configBuf1 = (await ipc.invokeFrom(
      main1.webContents,
      BUFFER_IPC_CHANNELS.openConfigDocument
    )) as DocumentBuffer
    await ipc.invokeFrom(main1.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [configBuf1.key])
    await ipc.invokeFrom(
      main1.webContents,
      BUFFER_IPC_CHANNELS.updateContent,
      configBuf1.key,
      '{"secret":"AUX1_UNSAVED_TOKEN BETA_ONLY_TOKEN"}'
    )

    // Session 1 (main1 and aux1) sees aux1's unsaved buffer, NOT disk token or Session 2 files
    const main1Search = await ipc.invokeFrom<WorkspaceSearchResponse>(
      main1.webContents,
      WORKSPACE_IPC_CHANNELS.search,
      { query: 'AUX1_UNSAVED_TOKEN', options: DEFAULT_SEARCH_MATCH_OPTIONS }
    )
    expect(main1Search.files.map((f) => f.relativePath)).toEqual(['a.md'])
    expect(main1Search.totalMatchCount).toBe(1)

    const aux1Search = await ipc.invokeFrom<WorkspaceSearchResponse>(
      aux1.webContents,
      WORKSPACE_IPC_CHANNELS.search,
      { query: 'SHARED_DISK_TOKEN', options: DEFAULT_SEARCH_MATCH_OPTIONS }
    )
    expect(aux1Search.files).toEqual([])

    // Session 2 (main2) is isolated from Session 1 dirty buffers and sees only wsBeta
    const main2CrossSearch = await ipc.invokeFrom<WorkspaceSearchResponse>(
      main2.webContents,
      WORKSPACE_IPC_CHANNELS.search,
      { query: 'AUX1_UNSAVED_TOKEN', options: DEFAULT_SEARCH_MATCH_OPTIONS }
    )
    expect(main2CrossSearch.files).toEqual([])

    const main2OwnSearch = await ipc.invokeFrom<WorkspaceSearchResponse>(
      main2.webContents,
      WORKSPACE_IPC_CHANNELS.search,
      { query: 'BETA_ONLY_TOKEN', options: DEFAULT_SEARCH_MATCH_OPTIONS }
    )
    expect(main2OwnSearch.files.map((f) => f.relativePath)).toEqual(['b.md'])

    // Unknown sender is rejected
    await expect(
      ipc.invokeFrom({ id: 99999, isDestroyed: () => false, send: () => undefined }, WORKSPACE_IPC_CHANNELS.search, {
        query: 'BETA_ONLY_TOKEN',
        options: DEFAULT_SEARCH_MATCH_OPTIONS
      })
    ).rejects.toThrow(/워크스페이스/)
  })

  it('isolates frontmatter schema IPC, buffer saves, and external watch reloads per main-window session while broadcasting to owned auxiliary windows', async () => {
    const main1 = manager.createMainWindow() as FakeWindowInstance
    await ipc.invokeFrom(main1.webContents, WORKSPACE_IPC_CHANNELS.open, wsAlpha)
    await ipc.invokeFrom(main1.webContents, WORKSPACE_IPC_CHANNELS.openInNewWindow, wsBeta)
    const main2 = factory.createdWindows[1]
    await ipc.invokeFrom(main2.webContents, WORKSPACE_IPC_CHANNELS.open, wsBeta)

    // Detach a.md into aux1 under Session 1
    const bufA = (await ipc.invokeFrom(
      main1.webContents,
      BUFFER_IPC_CHANNELS.openWorkspaceFile,
      join(wsAlpha, 'a.md'),
      'a.md'
    )) as DocumentBuffer
    await ipc.invokeFrom(main1.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [bufA.key])
    await ipc.invokeFrom(main1.webContents, WINDOW_IPC_CHANNELS.detachTabToNewWindow, {
      bufferKey: bufA.key,
      mode: 'raw',
      cursor: { selectionStart: 0, selectionEnd: 0 },
      scrollTop: 0
    })
    const aux1 = factory.createdWindows[2]
    await ipc.invokeFrom(aux1.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [bufA.key], {
      releasePending: true
    })

    // Initialize starter schema in Session 1 only -> main1 and aux1 receive broadcast, main2 does NOT
    const created1 = await ipc.invokeFrom<FrontmatterSchemaLoadResult>(
      main1.webContents,
      FRONTMATTER_IPC_CHANNELS.createDefaultSchema
    )
    expect(created1.exists).toBe(true)
    expect(created1.path).toBe(join(wsAlpha, '.wiki-editor', 'frontmatter.json'))
    expect(
      main1.sentMessages.filter((m) => m.channel === FRONTMATTER_IPC_CHANNELS.schemaChanged)
    ).toHaveLength(1)
    expect(
      aux1.sentMessages.filter((m) => m.channel === FRONTMATTER_IPC_CHANNELS.schemaChanged)
    ).toHaveLength(1)
    expect(
      main2.sentMessages.filter((m) => m.channel === FRONTMATTER_IPC_CHANNELS.schemaChanged)
    ).toHaveLength(0)

    // Session 2 still sees no schema
    const schema2Initial = await ipc.invokeFrom<FrontmatterSchemaLoadResult>(
      main2.webContents,
      FRONTMATTER_IPC_CHANNELS.getSchema
    )
    expect(schema2Initial).toEqual({
      exists: false,
      path: join(wsBeta, '.wiki-editor', 'frontmatter.json'),
      schema: null
    })

    // Saving .wiki-editor/frontmatter.json via Raw JSON bufferHub reloads & broadcasts to Session 1 only
    const schemaBuf = (await ipc.invokeFrom(
      main1.webContents,
      BUFFER_IPC_CHANNELS.openWorkspaceFile,
      join(wsAlpha, '.wiki-editor', 'frontmatter.json'),
      'frontmatter.json'
    )) as DocumentBuffer
    await ipc.invokeFrom(main1.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [bufA.key, schemaBuf.key])
    const rawSavedSchema: WorkspaceFrontmatterSchema = {
      version: 1,
      fields: [{ key: 'epic', label: '에픽', type: 'text' }]
    }
    await ipc.invokeFrom(
      main1.webContents,
      BUFFER_IPC_CHANNELS.updateContent,
      schemaBuf.key,
      JSON.stringify(rawSavedSchema, null, 2)
    )
    await ipc.invokeFrom(main1.webContents, BUFFER_IPC_CHANNELS.saveBuffer, schemaBuf.key)

    await vi.waitFor(() => {
      const main1Events = main1.sentMessages.filter(
        (m) => m.channel === FRONTMATTER_IPC_CHANNELS.schemaChanged
      )
      expect(main1Events).toHaveLength(2)
      expect((main1Events.at(-1)?.payload as FrontmatterSchemaLoadResult).schema).toEqual(
        rawSavedSchema
      )
    })
    expect(
      aux1.sentMessages.filter((m) => m.channel === FRONTMATTER_IPC_CHANNELS.schemaChanged)
    ).toHaveLength(2)
    expect(
      main2.sentMessages.filter((m) => m.channel === FRONTMATTER_IPC_CHANNELS.schemaChanged)
    ).toHaveLength(0)

    // External modification on Session 2 disk reloads ONLY for Session 2
    await mkdir(join(wsBeta, '.wiki-editor'), { recursive: true })
    await writeFile(
      join(wsBeta, '.wiki-editor', 'frontmatter.json'),
      JSON.stringify({
        version: 1,
        fields: [{ key: 'betaField', label: '베타', type: 'boolean' }]
      }),
      'utf8'
    )
    await vi.waitFor(() => {
      const main2Events = main2.sentMessages.filter(
        (m) => m.channel === FRONTMATTER_IPC_CHANNELS.schemaChanged
      )
      expect(main2Events).toHaveLength(1)
      expect(
        (main2Events[0].payload as FrontmatterSchemaLoadResult).schema?.fields[0]?.key
      ).toBe('betaField')
    })
    expect(
      main1.sentMessages.filter((m) => m.channel === FRONTMATTER_IPC_CHANNELS.schemaChanged)
    ).toHaveLength(2)

    // Unknown sender rejected
    await expect(
      ipc.invokeFrom(
        { id: 99999, isDestroyed: () => false, send: () => undefined },
        FRONTMATTER_IPC_CHANNELS.getSchema
      )
    ).rejects.toThrow(/워크스페이스/)
  })

  it('refreshes open clean frontmatter.json buffer on saveSchema and broadcasts error without corrupting markdown buffers on invalid Raw JSON save', async () => {
    const main1 = manager.createMainWindow() as FakeWindowInstance
    await ipc.invokeFrom(main1.webContents, WORKSPACE_IPC_CHANNELS.open, wsAlpha)

    await ipc.invokeFrom<FrontmatterSchemaLoadResult>(
      main1.webContents,
      FRONTMATTER_IPC_CHANNELS.createDefaultSchema
    )

    const schemaPath = join(wsAlpha, '.wiki-editor', 'frontmatter.json')
    const schemaBuf = (await ipc.invokeFrom(
      main1.webContents,
      BUFFER_IPC_CHANNELS.openWorkspaceFile,
      schemaPath,
      'frontmatter.json'
    )) as DocumentBuffer
    const mdBuf = (await ipc.invokeFrom(
      main1.webContents,
      BUFFER_IPC_CHANNELS.openWorkspaceFile,
      join(wsAlpha, 'a.md'),
      'a.md'
    )) as DocumentBuffer
    await ipc.invokeFrom(main1.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [
      schemaBuf.key,
      mdBuf.key
    ])

    // Saving via GUI modal IPC (saveSchema) updates open clean frontmatter.json buffer
    const nextSchema: WorkspaceFrontmatterSchema = {
      version: 1,
      fields: [{ key: 'reviewer', label: '리뷰어', type: 'text', required: true }]
    }
    await ipc.invokeFrom(main1.webContents, FRONTMATTER_IPC_CHANNELS.saveSchema, nextSchema)

    await vi.waitFor(async () => {
      const snapshot = (await ipc.invokeFrom(
        main1.webContents,
        BUFFER_IPC_CHANNELS.getSnapshot
      )) as { buffers: Record<string, DocumentBuffer> }
      expect(snapshot.buffers[schemaBuf.key]?.content).toContain('"reviewer"')
      expect(snapshot.buffers[schemaBuf.key]?.isDirty).toBe(false)
    })

    // Saving invalid JSON via frontmatter.json buffer broadcasts schema error while preserving a.md buffer
    await ipc.invokeFrom(
      main1.webContents,
      BUFFER_IPC_CHANNELS.updateContent,
      schemaBuf.key,
      '{ broken json'
    )
    await ipc.invokeFrom(main1.webContents, BUFFER_IPC_CHANNELS.saveBuffer, schemaBuf.key)

    await vi.waitFor(() => {
      const schemaEvents = main1.sentMessages.filter(
        (m) => m.channel === FRONTMATTER_IPC_CHANNELS.schemaChanged
      )
      const latest = schemaEvents.at(-1)?.payload as FrontmatterSchemaLoadResult | undefined
      expect(latest?.exists).toBe(true)
      expect(latest?.schema).toBeNull()
      expect(latest?.error).toBeTruthy()
    })

    const finalSnapshot = (await ipc.invokeFrom(
      main1.webContents,
      BUFFER_IPC_CHANNELS.getSnapshot
    )) as { buffers: Record<string, DocumentBuffer> }
    expect(finalSnapshot.buffers[mdBuf.key]?.content).toBe(mdBuf.content)
  })

  it('isolates frontmatter workspace:search and frontmatter:get-field-values per main-window session with aux dirty buffer priority and security exclusions', async () => {
    const main1 = manager.createMainWindow() as FakeWindowInstance
    await ipc.invokeFrom(main1.webContents, WORKSPACE_IPC_CHANNELS.open, wsAlpha)
    await ipc.invokeFrom(main1.webContents, WORKSPACE_IPC_CHANNELS.openInNewWindow, wsBeta)
    const main2 = factory.createdWindows[1]
    await ipc.invokeFrom(main2.webContents, WORKSPACE_IPC_CHANNELS.open, wsBeta)

    await ipc.invokeFrom(main1.webContents, FRONTMATTER_IPC_CHANNELS.createDefaultSchema)
    await ipc.invokeFrom(main2.webContents, FRONTMATTER_IPC_CHANNELS.createDefaultSchema)

    await writeFile(
      join(wsAlpha, 'a.md'),
      '---\nstatus: todo\npriority: low\nlabels: [backend]\n---\nAlpha body',
      'utf8'
    )
    await writeFile(
      join(wsAlpha, 'z.md'),
      '---\nstatus: in-progress\npriority: high\nlabels: [security, alpha-disk-tag]\n---\nZeta body',
      'utf8'
    )
    await writeFile(
      join(wsBeta, 'b.md'),
      '---\nstatus: in-progress\npriority: medium\nlabels: [beta-only-tag]\n---\nBeta body',
      'utf8'
    )
    await writeFile(
      join(wsAlpha, '.wiki-editor', 'leak.md'),
      '---\nstatus: in-progress\nlabels: [internal-leak]\n---\nLeak',
      'utf8'
    )

    // Detach a.md to aux1 under Session 1 and make unsaved edit changing status/priority/labels
    const bufA = (await ipc.invokeFrom(
      main1.webContents,
      BUFFER_IPC_CHANNELS.openWorkspaceFile,
      join(wsAlpha, 'a.md'),
      'a.md'
    )) as DocumentBuffer
    await ipc.invokeFrom(main1.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [bufA.key])
    await ipc.invokeFrom(main1.webContents, WINDOW_IPC_CHANNELS.detachTabToNewWindow, {
      bufferKey: bufA.key,
      mode: 'raw',
      cursor: { selectionStart: 0, selectionEnd: 0 },
      scrollTop: 0
    })
    const aux1 = factory.createdWindows[2]
    await ipc.invokeFrom(aux1.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [bufA.key], {
      releasePending: true
    })
    await ipc.invokeFrom(
      aux1.webContents,
      BUFFER_IPC_CHANNELS.updateContent,
      bufA.key,
      '---\nstatus: in-progress\npriority: highest\nlabels: [security, aux1-custom-tag]\n---\nAlpha body'
    )

    // Dirty config.json in Session 1 must NOT leak into frontmatter search or getFieldValues
    const configBuf1 = (await ipc.invokeFrom(
      main1.webContents,
      BUFFER_IPC_CHANNELS.openConfigDocument
    )) as DocumentBuffer
    await ipc.invokeFrom(main1.webContents, BUFFER_IPC_CHANNELS.syncWindowTabs, [configBuf1.key])
    await ipc.invokeFrom(
      main1.webContents,
      BUFFER_IPC_CHANNELS.updateContent,
      configBuf1.key,
      '---\nstatus: in-progress\nlabels: [config-leak-tag]\n---\n'
    )

    // Session 1 attribute-only search sorted by priority asc -> a.md (highest from aux1) before z.md (high)
    const session1Search = await ipc.invokeFrom<WorkspaceSearchResponse>(
      main1.webContents,
      WORKSPACE_IPC_CHANNELS.search,
      {
        query: '',
        options: DEFAULT_SEARCH_MATCH_OPTIONS,
        frontmatter: {
          conditions: [
            { fieldKey: 'status', operator: 'in', values: ['in-progress'] },
            { fieldKey: 'labels', operator: 'any-of', values: ['security'] }
          ],
          sort: { by: 'frontmatter', fieldKey: 'priority', direction: 'asc' }
        }
      }
    )
    expect(session1Search.files.map((f) => f.relativePath)).toEqual(['a.md', 'z.md'])
    expect(session1Search.files[0].frontmatterSummary).toEqual({
      status: 'in-progress',
      priority: 'highest',
      labels: ['security', 'aux1-custom-tag']
    })

    // Session 1 getFieldValues from aux1 sees aux1-custom-tag & alpha-disk-tag, NOT beta-only-tag/internal-leak/config-leak-tag
    const session1Values = await ipc.invokeFrom<WorkspaceFrontmatterFieldValuesResponse>(
      aux1.webContents,
      FRONTMATTER_IPC_CHANNELS.getFieldValues,
      ['labels']
    )
    expect(session1Values.valuesByField.labels).toEqual([
      'alpha-disk-tag',
      'aux1-custom-tag',
      'backend',
      'docs',
      'frontend',
      'security'
    ])

    // Session 2 is completely isolated from Session 1's aux1 edits and documents
    const session2Values = await ipc.invokeFrom<WorkspaceFrontmatterFieldValuesResponse>(
      main2.webContents,
      FRONTMATTER_IPC_CHANNELS.getFieldValues
    )
    expect(session2Values.valuesByField.labels).toEqual([
      'backend',
      'beta-only-tag',
      'docs',
      'frontend',
      'security'
    ])

    const session2Search = await ipc.invokeFrom<WorkspaceSearchResponse>(
      main2.webContents,
      WORKSPACE_IPC_CHANNELS.search,
      {
        query: '',
        options: DEFAULT_SEARCH_MATCH_OPTIONS,
        frontmatter: {
          conditions: [{ fieldKey: 'labels', operator: 'any-of', values: ['aux1-custom-tag'] }]
        }
      }
    )
    expect(session2Search.files).toEqual([])
  })
})
