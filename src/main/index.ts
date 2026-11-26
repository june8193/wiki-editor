import { writeFile } from 'node:fs/promises'
import { release as getOsRelease } from 'node:os'
import { join } from 'node:path'
import { WIKI_ASSET_SCHEME } from '@shared/assets'
import {
  handleWikiAssetRequest,
  WIKI_ASSET_PRIVILEGED_SCHEME
} from './protocol/wikiAssetProtocol'
import {
  app,
  BrowserWindow,
  ClipboardItem,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  type MessageBoxOptions,
  nativeImage,
  protocol,
  screen,
  shell
} from 'electron'
import { ConfigService } from './config/ConfigService'
import { GitService } from './git/GitService'
import { registerBufferIpc } from './ipc/registerBufferIpc'
import { registerClipboardIpc } from './ipc/registerClipboardIpc'
import { registerConfigIpc } from './ipc/registerConfigIpc'
import { registerDiagramIpc } from './ipc/registerDiagramIpc'
import { registerFrontmatterIpc } from './ipc/registerFrontmatterIpc'
import { registerGitIpc } from './ipc/registerGitIpc'
import { registerLogIpc } from './ipc/registerLogIpc'
import { registerMenuIpc } from './ipc/registerMenuIpc'
import { registerTerminalIpc } from './ipc/registerTerminalIpc'
import { registerWindowIpc } from './ipc/registerWindowIpc'
import { registerWorkspaceIpc } from './ipc/registerWorkspaceIpc'
import { registerWorkspaceStateIpc } from './ipc/registerWorkspaceStateIpc'
import type { AppEnvironmentInfo } from './logging/formatBugReport'
import { createHelpMenuActions } from './logging/helpMenuActions'
import { LogService } from './logging/LogService'
import { registerProcessLifecycleLogging } from './logging/processLifecycleLogging'
import { createVersionMessageBoxOptions } from './menu'
import { WindowManager } from './windowManager'
import { WorkspaceStateService } from './workspace/WorkspaceStateService'
import { registerWindowNavigationGuard } from './window'

function getActiveWindow(): BrowserWindow | undefined {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && !focused.isDestroyed()) {
    return focused
  }
  return BrowserWindow.getAllWindows().find((win) => !win.isDestroyed())
}

function showMessageBox(options: MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
  const targetWindow = getActiveWindow()
  return targetWindow ? dialog.showMessageBox(targetWindow, options) : dialog.showMessageBox(options)
}

const logService = new LogService(join(app.getPath('userData'), 'logs'))

protocol.registerSchemesAsPrivileged([WIKI_ASSET_PRIVILEGED_SCHEME])

let disposeBufferIpc: (() => void) | undefined
let disposeConfigIpc: (() => void) | undefined
let disposeDiagramIpc: (() => void) | undefined
let disposeWorkspaceIpc: (() => void) | undefined
let disposeFrontmatterIpc: (() => void) | undefined
let disposeWorkspaceStateIpc: (() => void) | undefined
let disposeGitIpc: (() => void) | undefined
let disposeTerminalIpc: (() => void) | undefined
let disposeWindowIpc: (() => void) | undefined
let disposeLogIpc: (() => void) | undefined
let disposeClipboardIpc: (() => void) | undefined
let disposeMenuIpc: (() => void) | undefined
let disposeWikiAssetProtocol: (() => void) | undefined
let windowManager: WindowManager | undefined
let workspaceStateService: WorkspaceStateService | undefined

function disposeMainResources(): Promise<void> | undefined {
  const flushWorkspaceState = workspaceStateService?.flush()
  workspaceStateService = undefined
  disposeWikiAssetProtocol?.()
  disposeWikiAssetProtocol = undefined
  disposeWindowIpc?.()
  disposeWindowIpc = undefined
  disposeMenuIpc?.()
  disposeMenuIpc = undefined
  disposeTerminalIpc?.()
  disposeTerminalIpc = undefined
  disposeClipboardIpc?.()
  disposeClipboardIpc = undefined
  disposeLogIpc?.()
  disposeLogIpc = undefined
  disposeDiagramIpc?.()
  disposeDiagramIpc = undefined
  disposeBufferIpc?.()
  disposeBufferIpc = undefined
  disposeGitIpc?.()
  disposeGitIpc = undefined
  disposeWorkspaceStateIpc?.()
  disposeWorkspaceStateIpc = undefined
  disposeFrontmatterIpc?.()
  disposeFrontmatterIpc = undefined
  disposeWorkspaceIpc?.()
  disposeWorkspaceIpc = undefined
  disposeConfigIpc?.()
  disposeConfigIpc = undefined
  windowManager?.dispose()
  windowManager = undefined
  return flushWorkspaceState
}

registerProcessLifecycleLogging({
  logService,
  processTarget: process,
  appTarget: app,
  getReadyData: () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch
  }),
  onWillQuit: disposeMainResources
})

void app.whenReady().then(async () => {
  const configPath = join(app.getPath('userData'), 'config.json')
  const configService = new ConfigService(configPath, { logService })
  const initialConfig = await configService.get()
  const workspaceStatePath = join(app.getPath('userData'), 'workspace-state.json')
  const activeWorkspaceStateService = new WorkspaceStateService(workspaceStatePath, { logService })
  workspaceStateService = activeWorkspaceStateService

  protocol.handle(WIKI_ASSET_SCHEME, (request) =>
    handleWikiAssetRequest(request, () => windowManager?.getWorkspaceServices() ?? [])
  )
  disposeWikiAssetProtocol = () => {
    protocol.unhandle(WIKI_ASSET_SCHEME)
  }
  const gitService = new GitService({
    logService,
    trashItem: (targetPath) => shell.trashItem(targetPath)
  })

  windowManager = new WindowManager({
    preloadPath: join(__dirname, '../preload/index.js'),
    rendererUrl: process.env.ELECTRON_RENDERER_URL,
    rendererFilePath: join(__dirname, '../renderer/index.html'),
    windowIconPath: join(__dirname, '../../build/icon.png'),
    configService,
    gitService,
    logService,
    trashItem: (targetPath) => shell.trashItem(targetPath),
    initialAutoSaveConfig: {
      autoSave: initialConfig.autoSave,
      autoSaveDelayMs: initialConfig.autoSaveDelayMs
    },
    initialTheme: initialConfig.theme,
    appVersion: app.getVersion(),
    createWindow: (options) => {
      const win = new BrowserWindow(options)
      registerWindowNavigationGuard(win.webContents)
      return win
    },
    screen,
    getFocusedWindow: () => BrowserWindow.getFocusedWindow() ?? undefined
  })

  const getTargets = () => windowManager?.getWebContentsTargets() ?? []

  disposeLogIpc = registerLogIpc(ipcMain, logService)
  disposeClipboardIpc = registerClipboardIpc({
    ipcMain,
    writeClipboardText: (text) => clipboard.writeText(text),
    logService
  })
  disposeConfigIpc = registerConfigIpc(ipcMain, configService, getTargets, logService)
  disposeDiagramIpc = registerDiagramIpc({
    ipcMain,
    writeClipboardText: (text) => clipboard.writeText(text),
    createImageFromBuffer: (buffer) => nativeImage.createFromBuffer(buffer),
    writeClipboardImage: (image) =>
      clipboard.write([
        new ClipboardItem({
          'image/png': new Blob([new Uint8Array(image.toPNG())], { type: 'image/png' })
        })
      ]),
    showSaveDialog: (options) => {
      const targetWindow = getActiveWindow()
      return targetWindow
        ? dialog.showSaveDialog(targetWindow, options)
        : dialog.showSaveDialog(options)
    },
    writeFile: (filePath, data) =>
      typeof data === 'string' ? writeFile(filePath, data, 'utf8') : writeFile(filePath, data),
    logService
  })
  disposeBufferIpc = registerBufferIpc({
    ipcMain,
    configService,
    sessionSource: windowManager,
    logService
  })
  disposeWindowIpc = registerWindowIpc({
    ipcMain,
    windowManager,
    logService
  })
  disposeGitIpc = registerGitIpc({
    ipcMain,
    gitService,
    resolveWorkspaceService: (sender) => windowManager?.getWorkspaceServiceForSender(sender),
    logService
  })
  disposeWorkspaceIpc = registerWorkspaceIpc({
    ipcMain,
    configService,
    coordinator: windowManager,
    logService,
    selectDirectory: async (sender) => {
      const senderWindow = windowManager?.getWindowForSender(sender)
      const targetWindow =
        (senderWindow && senderWindow instanceof BrowserWindow ? senderWindow : undefined) ??
        getActiveWindow()
      const options = { properties: ['openDirectory'] as Array<'openDirectory'> }
      const result = targetWindow
        ? await dialog.showOpenDialog(targetWindow, options)
        : await dialog.showOpenDialog(options)
      return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
    }
  })
  disposeWorkspaceStateIpc = registerWorkspaceStateIpc({
    ipcMain,
    workspaceStateService: activeWorkspaceStateService,
    isMainWindowSender: (sender) => windowManager?.isMainWebContents(sender) ?? false,
    logService
  })
  disposeFrontmatterIpc = registerFrontmatterIpc({
    ipcMain,
    sessionSource: windowManager,
    logService
  })
  disposeTerminalIpc = registerTerminalIpc({
    ipcMain,
    sessionSource: windowManager,
    openExternal: (url) => shell.openExternal(url),
    logService
  })

  const environment: AppEnvironmentInfo = {
    appVersion: app.getVersion(),
    versions: process.versions,
    os: {
      platform: process.platform,
      release: getOsRelease(),
      arch: process.arch
    }
  }

  const { onCopyBugReport, onOpenLogFolder } = createHelpMenuActions({
    logService,
    environment,
    writeClipboardText: (text) => clipboard.writeText(text),
    showMessageBox,
    openPath: (targetPath) => shell.openPath(targetPath)
  })

  disposeMenuIpc = registerMenuIpc({
    ipcMain,
    onQuit: () => {
      app.quit()
    },
    onCopyBugReport: () => {
      void onCopyBugReport()
    },
    onOpenLogFolder: () => {
      void onOpenLogFolder()
    },
    onShowVersion: () => {
      const options = createVersionMessageBoxOptions(environment)
      void showMessageBox(options)
    },
    logService
  })
  Menu.setApplicationMenu(null)

  windowManager.createMainWindow()
})

app.on('window-all-closed', () => {
  app.quit()
})
