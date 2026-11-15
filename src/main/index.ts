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
  protocol,
  type BaseWindow,
  BrowserWindow,
  ClipboardItem,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  type MessageBoxOptions,
  nativeImage,
  shell
} from 'electron'
import { ConfigService } from './config/ConfigService'
import { GitService } from './git/GitService'
import { registerClipboardIpc } from './ipc/registerClipboardIpc'
import { registerConfigIpc } from './ipc/registerConfigIpc'
import { registerDiagramIpc } from './ipc/registerDiagramIpc'
import { registerGitIpc } from './ipc/registerGitIpc'
import { registerLogIpc } from './ipc/registerLogIpc'
import { registerWindowIpc } from './ipc/registerWindowIpc'
import { registerWorkspaceIpc } from './ipc/registerWorkspaceIpc'
import type { AppEnvironmentInfo } from './logging/formatBugReport'
import { createHelpMenuActions } from './logging/helpMenuActions'
import { LogService } from './logging/LogService'
import { registerProcessLifecycleLogging } from './logging/processLifecycleLogging'
import { createApplicationMenuTemplate, createVersionMessageBoxOptions } from './menu'
import { WorkspaceFsService } from './workspace/WorkspaceFsService'
import {
  createMainWindowOptions,
  createWindowCloseCoordinator,
  hardenWindowNavigation,
  registerWindowNavigationGuard
} from './window'

const windowCloseCoordinator = createWindowCloseCoordinator()

function createMainWindow(): BrowserWindow {
  const preloadPath = join(__dirname, '../preload/index.js')
  const mainWindow = new BrowserWindow(createMainWindowOptions(preloadPath))
  registerWindowNavigationGuard(mainWindow.webContents)
  hardenWindowNavigation(mainWindow.webContents)
  windowCloseCoordinator.guardWindow(mainWindow)

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

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

let disposeConfigIpc: (() => void) | undefined
let disposeDiagramIpc: (() => void) | undefined
let disposeWorkspaceIpc: (() => void) | undefined
let disposeGitIpc: (() => void) | undefined
let disposeLogIpc: (() => void) | undefined
let disposeClipboardIpc: (() => void) | undefined
let disposeWindowIpc: (() => void) | undefined
let disposeWikiAssetProtocol: (() => void) | undefined
let workspaceService: WorkspaceFsService | undefined

function disposeMainResources(): void {
  windowCloseCoordinator.dispose()
  disposeWikiAssetProtocol?.()
  disposeWikiAssetProtocol = undefined
  disposeWindowIpc?.()
  disposeWindowIpc = undefined
  disposeClipboardIpc?.()
  disposeClipboardIpc = undefined
  disposeLogIpc?.()
  disposeLogIpc = undefined
  disposeDiagramIpc?.()
  disposeDiagramIpc = undefined
  disposeGitIpc?.()
  disposeGitIpc = undefined
  disposeWorkspaceIpc?.()
  disposeWorkspaceIpc = undefined
  disposeConfigIpc?.()
  disposeConfigIpc = undefined
  workspaceService?.dispose()
  workspaceService = undefined
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
  await configService.get()

  const activeWorkspaceService = new WorkspaceFsService({
    trashItem: (targetPath) => shell.trashItem(targetPath)
  })
  workspaceService = activeWorkspaceService
  protocol.handle(WIKI_ASSET_SCHEME, (request) =>
    handleWikiAssetRequest(request, activeWorkspaceService)
  )
  disposeWikiAssetProtocol = () => {
    protocol.unhandle(WIKI_ASSET_SCHEME)
  }
  const gitService = new GitService({ logService })

  const getTargets = () => BrowserWindow.getAllWindows().map((win) => win.webContents)
  const getMenuTargetWebContents = (targetWindow?: BaseWindow) => {
    const win =
      targetWindow instanceof BrowserWindow && !targetWindow.isDestroyed()
        ? targetWindow
        : getActiveWindow()
    return win && !win.isDestroyed() ? win.webContents : undefined
  }

  disposeLogIpc = registerLogIpc(ipcMain, logService)
  disposeClipboardIpc = registerClipboardIpc({
    ipcMain,
    writeClipboardText: (text) => clipboard.writeText(text),
    logService
  })
  disposeWindowIpc = registerWindowIpc({
    ipcMain,
    coordinator: windowCloseCoordinator,
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
  disposeGitIpc = registerGitIpc({
    ipcMain,
    gitService,
    workspaceService,
    logService
  })
  disposeWorkspaceIpc = registerWorkspaceIpc({
    ipcMain,
    workspaceService,
    configService,
    getTargets,
    logService,
    selectDirectory: async () => {
      const targetWindow = getActiveWindow()
      const options = { properties: ['openDirectory'] as Array<'openDirectory'> }
      const result = targetWindow
        ? await dialog.showOpenDialog(targetWindow, options)
        : await dialog.showOpenDialog(options)
      return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
    }
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

  const menuTemplate = createApplicationMenuTemplate({
    getTargetWebContents: getMenuTargetWebContents,
    onCopyBugReport: () => {
      void onCopyBugReport()
    },
    onOpenLogFolder: () => {
      void onOpenLogFolder()
    },
    onShowVersion: () => {
      const options = createVersionMessageBoxOptions(environment)
      void showMessageBox(options)
    }
  })
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate))

  createMainWindow()
})

app.on('window-all-closed', () => {
  app.quit()
})
