import { release as getOsRelease } from 'node:os'
import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  type MessageBoxOptions,
  screen,
  shell
} from 'electron'
import { ConfigService } from './config/ConfigService'
import { GitService } from './git/GitService'
import { createSharedDocumentBufferHub, registerBufferIpc } from './ipc/registerBufferIpc'
import { registerConfigIpc } from './ipc/registerConfigIpc'
import { registerGitIpc } from './ipc/registerGitIpc'
import { registerLogIpc } from './ipc/registerLogIpc'
import { registerWindowIpc } from './ipc/registerWindowIpc'
import { registerWorkspaceIpc } from './ipc/registerWorkspaceIpc'
import type { AppEnvironmentInfo } from './logging/formatBugReport'
import { createHelpMenuActions } from './logging/helpMenuActions'
import { LogService } from './logging/LogService'
import { registerProcessLifecycleLogging } from './logging/processLifecycleLogging'
import { createApplicationMenuTemplate, createVersionMessageBoxOptions } from './menu'
import { WindowManager } from './windowManager'
import { WorkspaceFsService } from './workspace/WorkspaceFsService'

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

let disposeBufferIpc: (() => void) | undefined
let disposeConfigIpc: (() => void) | undefined
let disposeWorkspaceIpc: (() => void) | undefined
let disposeGitIpc: (() => void) | undefined
let disposeWindowIpc: (() => void) | undefined
let disposeLogIpc: (() => void) | undefined
let windowManager: WindowManager | undefined
let workspaceService: WorkspaceFsService | undefined

function disposeMainResources(): void {
  disposeLogIpc?.()
  disposeLogIpc = undefined
  disposeWindowIpc?.()
  disposeWindowIpc = undefined
  disposeBufferIpc?.()
  disposeBufferIpc = undefined
  disposeGitIpc?.()
  disposeGitIpc = undefined
  disposeWorkspaceIpc?.()
  disposeWorkspaceIpc = undefined
  disposeConfigIpc?.()
  disposeConfigIpc = undefined
  windowManager?.dispose()
  windowManager = undefined
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
  const initialConfig = await configService.get()

  workspaceService = new WorkspaceFsService({
    trashItem: (targetPath) => shell.trashItem(targetPath)
  })
  const gitService = new GitService({ logService })

  const bufferHub = createSharedDocumentBufferHub({
    workspaceService,
    configService,
    logService,
    initialAutoSaveConfig: {
      autoSave: initialConfig.autoSave,
      autoSaveDelayMs: initialConfig.autoSaveDelayMs
    }
  })

  windowManager = new WindowManager({
    preloadPath: join(__dirname, '../preload/index.js'),
    rendererUrl: process.env.ELECTRON_RENDERER_URL,
    rendererFilePath: join(__dirname, '../renderer/index.html'),
    bufferHub,
    createWindow: (options) => new BrowserWindow(options),
    screen
  })

  const getTargets = () => windowManager?.getWebContentsTargets() ?? []
  const getMenuTargetWebContents = () => windowManager?.getMenuTargetWebContents()

  disposeLogIpc = registerLogIpc(ipcMain, logService)
  disposeConfigIpc = registerConfigIpc(ipcMain, configService, getTargets, logService)
  disposeBufferIpc = registerBufferIpc({
    ipcMain,
    configService,
    hub: bufferHub,
    getTargets,
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
    workspaceService,
    logService
  })
  disposeWorkspaceIpc = registerWorkspaceIpc({
    ipcMain,
    workspaceService,
    configService,
    getTargets,
    isMainWindowSender: (sender) => windowManager?.isMainWebContents(sender) ?? false,
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

  windowManager.createMainWindow()
})

app.on('window-all-closed', () => {
  app.quit()
})
