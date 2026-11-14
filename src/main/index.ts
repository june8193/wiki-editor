import { join } from 'node:path'
import { app, type BaseWindow, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { ConfigService } from './config/ConfigService'
import { GitService } from './git/GitService'
import { registerConfigIpc } from './ipc/registerConfigIpc'
import { registerGitIpc } from './ipc/registerGitIpc'
import { registerWorkspaceIpc } from './ipc/registerWorkspaceIpc'
import { createApplicationMenuTemplate } from './menu'
import { WorkspaceFsService } from './workspace/WorkspaceFsService'
import { createMainWindowOptions } from './window'

function createMainWindow(): BrowserWindow {
  const preloadPath = join(__dirname, '../preload/index.js')
  const mainWindow = new BrowserWindow(createMainWindowOptions(preloadPath))

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

let disposeConfigIpc: (() => void) | undefined
let disposeWorkspaceIpc: (() => void) | undefined
let disposeGitIpc: (() => void) | undefined
let workspaceService: WorkspaceFsService | undefined

void app.whenReady().then(async () => {
  const configPath = join(app.getPath('userData'), 'config.json')
  const configService = new ConfigService(configPath)
  await configService.get()

  workspaceService = new WorkspaceFsService({
    trashItem: (targetPath) => shell.trashItem(targetPath)
  })
  const gitService = new GitService()

  const getTargets = () => BrowserWindow.getAllWindows().map((win) => win.webContents)
  const getActiveWindow = (): BrowserWindow | undefined => {
    const focused = BrowserWindow.getFocusedWindow()
    if (focused && !focused.isDestroyed()) {
      return focused
    }
    return BrowserWindow.getAllWindows().find((win) => !win.isDestroyed())
  }
  const getMenuTargetWebContents = (targetWindow?: BaseWindow) => {
    const win =
      targetWindow instanceof BrowserWindow && !targetWindow.isDestroyed()
        ? targetWindow
        : getActiveWindow()
    return win && !win.isDestroyed() ? win.webContents : undefined
  }

  disposeConfigIpc = registerConfigIpc(ipcMain, configService, getTargets)
  disposeGitIpc = registerGitIpc({
    ipcMain,
    gitService,
    workspaceService
  })
  disposeWorkspaceIpc = registerWorkspaceIpc({
    ipcMain,
    workspaceService,
    configService,
    getTargets,
    selectDirectory: async () => {
      const targetWindow = getActiveWindow()
      const options = { properties: ['openDirectory'] as Array<'openDirectory'> }
      const result = targetWindow
        ? await dialog.showOpenDialog(targetWindow, options)
        : await dialog.showOpenDialog(options)
      return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
    }
  })

  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      createApplicationMenuTemplate({
        getTargetWebContents: getMenuTargetWebContents
      })
    )
  )

  createMainWindow()
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('will-quit', () => {
  disposeGitIpc?.()
  disposeGitIpc = undefined
  disposeWorkspaceIpc?.()
  disposeWorkspaceIpc = undefined
  disposeConfigIpc?.()
  disposeConfigIpc = undefined
  workspaceService?.dispose()
  workspaceService = undefined
})
